/**
 * dsh-plugins-market —— 服务器半：索引层
 *
 * ── 这一版的数据长什么样 ────────────────────────────────────────
 *
 * 仓库里只有**一个**数据文件：`catalog/index.json` —— 由 `scripts/collect.mjs`
 * 采集出来的 GitHub 插件项目清单。每条记录回答四个问题：
 * 项目描述、仓库地址、作者、收藏量（外加语言 / topic / 最近推送 / 许可这类
 * 一眼可辨的公开事实）。
 *
 * 目录里**没有**安装方法、没有版本号、没有信任分级、没有体检结论 —— 那些
 * 都属于「市场」的旧职责。装插件现在是官方桌面版自带的能力
 * （设置 → 插件 → 添加插件，填 `github:owner/repo`），本面板只负责让你**找到**
 * 那个仓库，并把它的安装地址放到剪贴板上。
 *
 * ── 数据怎么取：包内检出 → 缓存 → 远程 → 包内兜底 ────────────────
 *
 *   ① `<包根>/catalog/index.json` 存在 → 说明这是一份**仓库检出**（开发场景），
 *      直接读本地文件，一次网络调用都不发。
 *   ② 否则读磁盘缓存 `~/.dsh/storages/dsh-plugins-market/index-cache.json`：
 *      TTL 内直接用；超过 TTL 走**条件请求**（If-None-Match），304 时不读 body ——
 *      刷新因此几乎不要钱，这是「刷新时间」能压到很短的前提。
 *   ③ 缓存也没有（或拉取失败）→ 用包内 `catalog/snapshot.json`（完整离线目录），
 *      保证没网时面板不是一片空白。
 *
 * 每一层都如实标注 `source`，界面据此告诉用户「你看到的这份数据是哪来的、有多旧」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, pluginDir, readJsonSafe, resolveDataDir, writeJsonAtomic } from './util.js';

/** 本仓库的 raw 地址：索引从这里取 */
export const REPO_RAW_BASE = 'https://raw.githubusercontent.com/DPH-1121/dsh-plugins/main';
export const REPO_HOMEPAGE = 'https://github.com/DPH-1121/dsh-plugins';
export const REPO_INDEX_URL = `${REPO_RAW_BASE}/catalog/index.json`;

/**
 * 缓存 TTL。
 *
 * ★ 这个值只影响「面板会不会去问一次远程」，不影响正确性：
 *   远程那份由 GitHub Actions 每 6 小时重采一次，30 分钟远小于数据本身的更新频率，
 *   所以 TTL 内直接用缓存不会让你看到明显过期的数据，却能把打开面板的网络开销
 *   从「每次都拉」降到「半小时一次，且那次通常只拿到一个 304」。
 */
const INDEX_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60_000;

/** 单条记录进 payload 前的描述长度上限（列表页只需要一两行） */
const DESC_MAX = 300;
/** 每条记录最多带几个 topic 进 payload */
const TOPICS_MAX = 6;
/**
 * payload 的规模上限。
 *
 * 索引整份发给前端，前端才能做到「输入即搜」。8800 条约 1.6MB（gzip 后约 350KB），
 * 这个量级完全没问题；但采集面继续扩大时不能无上限地发 —— 超过这个数就只发
 * star 最高的那批，并在 meta 里如实写明 `truncated`，而不是让面板悄悄变慢。
 */
const PAYLOAD_MAX_ROWS = 20_000;

function indexFile() {
  return path.join(pluginDir(), 'catalog', 'index.json');
}

function snapshotFile() {
  return path.join(pluginDir(), 'catalog', 'snapshot.json');
}

function cacheFile() {
  return path.join(resolveDataDir(), 'index-cache.json');
}

// ─────────────────────────────────────────────────────────────
// 读取
// ─────────────────────────────────────────────────────────────

/**
 * 把任意来源的索引文档规范化成内部形状。
 * 形状不对返回 null —— 宁可退回上一层，也不要拿半个文档渲染出半个列表。
 */
export function normalizeIndex(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const plugins = Array.isArray(doc.plugins) ? doc.plugins.filter((p) => p && typeof p === 'object' && p.id) : null;
  if (!plugins) return null;
  return {
    schemaVersion: Number(doc.schemaVersion) || 1,
    generatedAt: typeof doc.generatedAt === 'string' ? doc.generatedAt : null,
    counts: doc.counts && typeof doc.counts === 'object' ? doc.counts : { total: plugins.length },
    sources: Array.isArray(doc.sources) ? doc.sources : [],
    note: typeof doc.note === 'string' ? doc.note : null,
    plugins,
  };
}

async function fetchConditional(url, { etag, timeout = FETCH_TIMEOUT_MS } = {}) {
  const headers = { accept: 'application/json', 'user-agent': 'dsh-plugins-market' };
  if (etag) headers['if-none-match'] = etag;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  // 304：索引没变。★ 不读 body —— 省下的正是这次刷新的全部带宽
  if (res.status === 304) return { notModified: true, etag: etag ?? null };
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return {
    notModified: false,
    data: await res.json(),
    etag: res.headers.get('etag') ?? null,
  };
}

/**
 * 载入索引。
 *
 * @param {object}  [options]
 * @param {boolean} [options.force] 忽略 TTL，去远程确认一次（仍是条件请求）
 * @returns {Promise<{index:object|null, source:string, error:string|null,
 *                    fetchedAt:number|null, ageMs:number|null, etag:string|null, url:string}>}
 */
export async function loadIndex({ force = false } = {}) {
  const url = process.env.DSH_PLUGINS_MARKET_INDEX_URL || REPO_INDEX_URL;

  const shape = (index, source, error = null, extra = {}) => ({
    index,
    source,
    error,
    fetchedAt: extra.fetchedAt ?? null,
    ageMs: extra.ageMs ?? null,
    etag: extra.etag ?? null,
    url,
  });

  // ① 仓库检出：本地就有完整索引，不走网络
  const local = normalizeIndex(readJsonSafe(indexFile()));
  if (local && !process.env.DSH_PLUGINS_MARKET_INDEX_URL) {
    return shape(local, 'checkout', null, { fetchedAt: Date.now(), ageMs: 0 });
  }

  const cache = readJsonSafe(cacheFile());
  const cached = normalizeIndex(cache?.data);
  const age = cache?.fetchedAt ? Date.now() - cache.fetchedAt : null;

  // ② 缓存还新鲜
  if (!force && cached && age !== null && age < INDEX_TTL_MS) {
    return shape(cached, 'cache', cache?.error ?? null, { fetchedAt: cache.fetchedAt, ageMs: age, etag: cache?.etag ?? null });
  }

  // ③ 条件请求
  let probe;
  try {
    probe = await fetchConditional(url, { etag: cache?.etag ?? null });
  } catch (err) {
    const fallback = cached ?? normalizeIndex(readJsonSafe(snapshotFile()));
    const source = cached ? 'cache' : 'bundled';
    return shape(
      fallback,
      source,
      `拉取索引失败（已用${cached ? '本地缓存' : '包内快照'}）：${err?.message ?? err}`,
      { fetchedAt: cache?.fetchedAt ?? null, ageMs: age, etag: cache?.etag ?? null },
    );
  }

  if (probe.notModified && cached) {
    const next = { data: cache.data, fetchedAt: Date.now(), etag: probe.etag, error: null };
    try { writeJsonAtomic(cacheFile(), next); } catch { /* 缓存写不进去不影响本次结果 */ }
    return shape(cached, 'remote-304', null, { fetchedAt: next.fetchedAt, ageMs: 0, etag: probe.etag });
  }

  const fresh = normalizeIndex(probe.data);
  if (!fresh) {
    const fallback = cached ?? normalizeIndex(readJsonSafe(snapshotFile()));
    return shape(
      fallback,
      cached ? 'cache' : 'bundled',
      '远程索引的形状不对（缺少 plugins 数组），已退回上一份可用数据。',
      { fetchedAt: cache?.fetchedAt ?? null, ageMs: age, etag: cache?.etag ?? null },
    );
  }

  try {
    ensureDir(resolveDataDir());
    writeJsonAtomic(cacheFile(), { data: probe.data, fetchedAt: Date.now(), etag: probe.etag, error: null });
  } catch { /* 同上 */ }
  return shape(fresh, 'remote', null, { fetchedAt: Date.now(), ageMs: 0, etag: probe.etag });
}

/** 清掉磁盘缓存（面板上的「强制重取」用） */
export function clearCache() {
  try {
    fs.rmSync(cacheFile(), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function cacheInfo() {
  const file = cacheFile();
  const cache = readJsonSafe(file);
  let bytes = null;
  try {
    bytes = fs.statSync(file).size;
  } catch { /* 没有就没有 */ }
  return {
    file,
    present: Boolean(cache),
    bytes,
    fetchedAt: cache?.fetchedAt ?? null,
    etag: cache?.etag ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
// 出参：列式压缩
// ─────────────────────────────────────────────────────────────

/**
 * 列名表 —— 前后端共用的唯一契约。
 *
 * 为什么不发对象数组：8800 条记录里每个字段名都要重复 8800 遍。改成
 * 「一次列名 + 每行一个数组」之后，同一份数据的 JSON 体积大约降到 55%，
 * gzip 之后差距更小但解析更快（不用给每一行建一个对象）。
 * 前端按这张表还原成对象，且刻意**懒还原**：只还原进视口的那几十行。
 */
export const COLUMNS = [
  'id',        // 0  owner/repo
  'desc',      // 1  项目描述（英文原文优先）
  'descZh',    // 2  中文描述（采集源提供时才有）
  'stars',     // 3  收藏量
  'forks',     // 4
  'lang',      // 5  主语言
  'topics',    // 6  topic 数组（截断到 TOPICS_MAX 个）
  'pushedAt',  // 7  最近推送（ISO 字符串，只到日期即可）
  'license',   // 8  SPDX 标识
  'archived',  // 9  0 / 1
  'homepage',  // 10 项目主页
];

function rowOf(rec) {
  const id = String(rec.id ?? '');
  const desc = rec.description ?? rec.desc ?? null;
  const descZh = rec.descriptionZh ?? null;
  return [
    id,
    desc ? String(desc).slice(0, DESC_MAX) : null,
    descZh ? String(descZh).slice(0, DESC_MAX) : null,
    Number.isFinite(rec.stars) ? rec.stars : null,
    Number.isFinite(rec.forks) ? rec.forks : null,
    rec.language ?? rec.lang ?? null,
    Array.isArray(rec.topics) ? rec.topics.filter((t) => typeof t === 'string').slice(0, TOPICS_MAX) : [],
    typeof rec.pushedAt === 'string' ? rec.pushedAt.slice(0, 10) : null,
    rec.license ?? null,
    rec.archived === true ? 1 : 0,
    rec.homepage ?? null,
  ];
}

/**
 * 索引 → 前端 payload。
 *
 * 行序在采集端已经定好（star 降序），这里原样保留 —— 排序规则只在一个地方实现，
 * 前端不必也不该再排一次。
 */
export function buildPayload(index, { loaded, extraMeta = {} } = {}) {
  const all = index?.plugins ?? [];
  const truncated = all.length > PAYLOAD_MAX_ROWS;
  const slice = truncated ? all.slice(0, PAYLOAD_MAX_ROWS) : all;
  return {
    meta: {
      generatedAt: index?.generatedAt ?? null,
      counts: index?.counts ?? { total: all.length },
      sources: index?.sources ?? [],
      note: index?.note ?? null,
      source: loaded?.source ?? null,
      error: loaded?.error ?? null,
      fetchedAt: loaded?.fetchedAt ?? null,
      ageMs: loaded?.ageMs ?? null,
      url: loaded?.url ?? REPO_INDEX_URL,
      repoHomepage: REPO_HOMEPAGE,
      ttlMs: INDEX_TTL_MS,
      truncated,
      ...extraMeta,
    },
    total: slice.length,
    cols: COLUMNS,
    rows: slice.map(rowOf),
  };
}
