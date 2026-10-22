/**
 * 插件项目索引的**采集器** —— 仓库里唯一会写 catalog/ 的脚本。
 *
 *   node scripts/collect.mjs                  # 联网采集（每 6 小时由 CI 跑的就是它）
 *   node scripts/collect.mjs --check          # ★ 只读校验：不联网、不写盘
 *   node scripts/collect.mjs --offline        # 不联网，用 .cache/ 里上一轮的原始数据重采
 *   node scripts/collect.mjs --only owner/repo# 只处理一个仓库（调试 / 手工补录）
 *   node scripts/collect.mjs --limit 200      # 只保留 star 最高的 N 条（试跑，不写盘）
 *   node scripts/collect.mjs --pages 5        # 每个查询最多翻几页（默认 3 页 = 300 条）
 *   node scripts/collect.mjs --refresh-all    # 本轮点名直读**全部**仓库（个人 token / 本地补全用）
 *   node scripts/collect.mjs --refresh-rotation 1
 *                                             # 排班切成几份（默认 4；1 等同 --refresh-all）
 *
 * ── 三条路径的能力边界（别混）─────────────────────────────────
 *
 *   --check    读磁盘 → 核对「索引是否自洽」「包内快照是不是索引的稳定投影」
 *              「记录是不是严格按 star 降序」。**没有任何写操作，没有任何网络调用。**
 *   --offline  同样不联网，但**会写** catalog/（用缓存里的原始数据重跑一遍归一化）。
 *   （无参数） 联网采集 —— 只有这条路径会发现新项目、更新 star 数与描述。
 *
 * ── 数据从哪来（四路合并）──────────────────────────────────────
 *
 *   1. GitHub 搜索            按 topic / 关键词检索 —— 负责**发现**新项目
 *   2. GitHub 直读            按 owner/repo 点名批量取（GraphQL）—— 负责**刷准**已知项目
 *   3. 公开索引 plugins.json   第三方维护的 DSH 插件索引（覆盖面最广，优先级最低）
 *   4. catalog/seed.json      手工收录 / 手工排除（人工写下的东西优先级高于第三方转述）
 *
 *   ★ 为什么「搜索」之外还要「直读」：搜索每个查询最多只翻到 1000 条结果，
 *     一万四千多个仓库里绝大多数落在任何一个切面的头部之外。只靠搜索，它们
 *     的 star 数与最近推送**永远停在第一次被采集的那天** —— 面板上表现为
 *     「更新于 23 天前」和明明已经涨了星却还显示旧数字。直读按名字点名，
 *     没有这个可见性上限；改名也在这里被纠正（GitHub 会返回规范名）。
 *
 * ── 三条硬规矩 ────────────────────────────────────────────────
 *
 *   · **内容没变就不动时间戳**（见 lib/catalog-format.mjs 的说明）。
 *   · **没看过就不删、也别改**。某个来源这一轮失败了（限流、网络）或按排班
 *     没轮到某个仓库，由它给出的值**原样保留** —— 把「没查到」当成「不存在」
 *     是这类采集器最容易犯、也最难发现的错误。只有 90 天没再被任何来源看到过的
 *     记录才会被清掉。
 *   · **绝不猜**。描述取不到就 null，star 数取不到就 null。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  INDEX_REL, SNAPSHOT_REL, SOURCE_LABELS,
  buildIndex, buildSnapshot, contentEquals, indexContent, mergeRecords,
  normalizeGraphqlRepo, normalizeRecord, readJsonSafe, sortRecords, serializeIndex,
  toRepoId, writeTextAtomic,
} from './lib/catalog-format.mjs';
import {
  REPO_BATCH_SIZE, describeToken, fetchRepositoryBatch, githubToken, searchRepositories,
} from './lib/github.mjs';
import { applyRepoRefresh, reconcile } from './lib/reconcile.mjs';
import {
  REFRESH_CONCURRENCY, REFRESH_MIN_POINTS, REFRESH_ROTATION, describeRefreshQueue, planRefreshQueue,
} from './lib/refresh.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CACHE_DIR = path.join(REPO, '.cache');
const INDEX_FILE = path.join(REPO, INDEX_REL);
const SNAPSHOT_FILE = path.join(REPO, SNAPSHOT_REL);
const SEED_FILE = path.join(REPO, 'catalog', 'seed.json');

/** 公开索引（第三方维护的 DSH 插件清单）—— 覆盖面最广的一路 */
export const PUBLIC_INDEX_URL = 'https://2bingling.github.io/dsh-market/plugins.json';

/**
 * 搜索查询表。
 *
 * ★ 为什么是「多个窄查询」而不是「一个宽查询翻到底」：
 *   GitHub 搜索接口每个查询最多返回 1000 条，且认证后只有 30 次/分钟。
 *   与其在一个查询里翻 10 页（1000 条封顶），不如用多个切面各取前几页 ——
 *   覆盖面更广，也天然按 star 数排序取到了每类的头部。
 */
const QUERIES = [
  'topic:dsh-plugin',
  'topic:deepseek-harness',
  'topic:dsh-plugins',
  'topic:dsh-bundle',
  'topic:deepseek-dsh',
  'dsh-plugin in:name',
  '"deepseek harness" in:name,description',
  '"dsh plugin" in:description',
];

/** 明确表示「这是 DSH 生态」的 topic */
const RELEVANT_TOPICS = new Set([
  'dsh', 'dsh-plugin', 'dsh-plugins', 'dsh-bundle', 'dsh-extension', 'dsh-theme',
  'deepseek-harness', 'deepseek-dsh', 'deepseekharness',
]);

/** 兜底相关性判断：名字 / 描述里出现 dsh 或 deepseek harness 这个词 */
const RELEVANT_TEXT = /(^|[^a-z0-9])dsh([^a-z0-9]|$)|deepseek[-_ ]?harness/i;

// ─────────────────────────────────────────────────────────────
// 参数
// ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, dflt = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};

const CHECK_ONLY = has('--check');
const OFFLINE = has('--offline') || CHECK_ONLY;
const ONLY = toRepoId(valueOf('--only'));
const LIMIT = Number(valueOf('--limit', '0')) || 0;
const PAGES = Number(valueOf('--pages', '3')) || 3;
const QUIET = has('--quiet');
/**
 * 本轮点名直读的排班。
 *
 * 默认切 4 份：CI 里的 `GITHUB_TOKEN` 只有 1,000 点/小时，而一万四千多条全刷一遍
 * 约 2,700 点 —— 不切份就会被限流打断，切份之后每条记录 24 小时内至少刷到一次。
 * 个人 token（5,000 点/小时）或本地补数据时用 `--refresh-all` 一次刷完。
 */
const REFRESH_ALL = has('--refresh-all');
const REFRESH_ROTATION_ARG = REFRESH_ALL
  ? 1
  : Math.max(1, Math.trunc(Number(valueOf('--refresh-rotation', String(REFRESH_ROTATION))) || REFRESH_ROTATION));

const log = (...a) => { if (!QUIET) console.log(...a); };
const warn = (...a) => console.warn(...a);
const problems = [];
const fail = (m) => { problems.push(m); console.error(`  ✗ ${m}`); };
const ok = (m) => log(`  ✓ ${m}`);
const now = () => new Date().toISOString();

// ─────────────────────────────────────────────────────────────
// 读写
// ─────────────────────────────────────────────────────────────

function loadExistingIndex() {
  const doc = readJsonSafe(INDEX_FILE);
  const map = new Map();
  for (const raw of doc?.plugins ?? []) {
    const rec = normalizeRecord(raw);
    if (rec) map.set(rec.id, rec);
  }
  return { doc, map };
}

function loadSeed() {
  const doc = readJsonSafe(SEED_FILE);
  return {
    include: (doc?.include ?? []).map(toRepoId).filter(Boolean),
    exclude: new Set((doc?.exclude ?? []).map(toRepoId).filter(Boolean)),
  };
}

function writeJsonCache(name, value) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  writeTextAtomic(path.join(CACHE_DIR, name), `${JSON.stringify(value)}\n`);
}

function readJsonCache(name) {
  return readJsonSafe(path.join(CACHE_DIR, name));
}

// ─────────────────────────────────────────────────────────────
// 来源 ①：GitHub 搜索
// ─────────────────────────────────────────────────────────────

function repoFromSearchItem(item) {
  return normalizeRecord({
    id: item.full_name,
    description: item.description,
    stars: item.stargazers_count,
    forks: item.forks_count,
    language: item.language,
    topics: item.topics,
    license: item.license?.spdx_id && item.license.spdx_id !== 'NOASSERTION' ? item.license.spdx_id : null,
    homepage: item.homepage,
    pushedAt: item.pushed_at,
    archived: item.archived,
    sources: ['github-search'],
  });
}

/**
 * 每个查询一个缓存文件。
 *
 * ★ 文件名必须由**整个查询串**的散列得出，不能拿查询串开头几个字节去转十六进制：
 *   `topic:dsh-plugin` 与 `topic:dsh-plugins` 的前 12 个字符完全一样
 *   （`topic:dsh-pl`），截断之后两者会**共用同一个缓存文件** ——
 *   离线重跑时一个查询会读到另一个查询的结果，而且两边的写入还会互相覆盖。
 *   这个错误不会当场报错，只会让 --offline 的结果慢慢变得不可信。
 */
function searchCacheName(query) {
  return `search-${createHash('sha256').update(query).digest('hex').slice(0, 16)}.json`;
}

async function collectFromGithubSearch() {
  const token = githubToken();
  log(`→ GitHub 搜索（token ${describeToken(token)}，每个查询最多 ${PAGES} 页）`);

  const out = new Map();
  const queries = [];
  let hardError = null;
  let missingCache = 0;

  for (const query of QUERIES) {
    const cacheName = searchCacheName(query);
    let result;

    if (OFFLINE) {
      const cached = readJsonCache(cacheName);
      if (!cached) {
        missingCache += 1;
        queries.push({ query, found: 0, pages: 0, error: '离线模式：没有缓存' });
        continue;
      }
      result = { items: cached.items ?? [], pages: cached.pages ?? 0, error: cached.error ?? null };
    } else {
      result = await searchRepositories(query, {
        token,
        pages: PAGES,
        onProgress: (p) => {
          if (p.waiting) warn(`  ! ${query}：命中限流（HTTP ${p.status}），等待 ${Math.round(p.waiting / 1000)} 秒`);
        },
      });
      writeJsonCache(cacheName, { query, items: result.items, pages: result.pages, error: result.error, fetchedAt: now() });
    }

    let kept = 0;
    for (const item of result.items) {
      const rec = repoFromSearchItem(item);
      if (!rec) continue;
      if (!looksRelevant(item)) continue;
      out.set(rec.id, out.has(rec.id) ? mergeRecords(out.get(rec.id), rec) : rec);
      kept += 1;
    }

    if (result.error) {
      hardError = hardError ?? result.error;
      warn(`  ! 查询失败「${query}」：${result.error}`);
    }
    queries.push({ query, found: kept, pages: result.pages, error: result.error ?? null });
    log(`    ${query} → ${kept} 条（${result.pages} 页）`);
  }

  ok(`GitHub 搜索：${out.size} 个仓库（${queries.filter((q) => !q.error).length}/${queries.length} 个查询成功）`);

  return {
    kind: 'github-search',
    label: SOURCE_LABELS['github-search'],
    url: 'https://github.com/search',
    queries,
    records: out,
    /*
     * ★ `failed` 的含义是「**这一轮没有完整地看过**」，而不是「出错了」。
     *
     *   离线模式下一个查询没有缓存 = 我们压根没去看那一块，所以必须算作没看过：
     *   否则下一节的合并会把「这一路没跑」当成「这一路不再收录它」，
     *   于是把记录上的 github-search 来源抹掉 —— 那是**知识的倒退**，
     *   而它不会报错，只会让索引悄悄变得比上一轮更差。
     */
    failed: Boolean(hardError) || missingCache > 0,
  };
}

/**
 * 相关性过滤。
 *
 * ★ 只作用于**搜索结果**。公开索引与 seed 是别人/自己明确为 DSH 收的，
 *   不拿我们的启发式去二次判断 —— 那会把「我确定它是插件」变成「我觉得它是」。
 */
function looksRelevant(item) {
  const topics = (item.topics ?? []).map((t) => String(t).toLowerCase());
  if (topics.some((t) => RELEVANT_TOPICS.has(t))) return true;
  const haystack = `${item.full_name ?? ''} ${item.name ?? ''} ${item.description ?? ''}`;
  return RELEVANT_TEXT.test(haystack);
}

// ─────────────────────────────────────────────────────────────
// 来源 ②：公开索引
// ─────────────────────────────────────────────────────────────

async function collectFromPublicIndex() {
  let doc = null;
  let error = null;

  if (OFFLINE) {
    doc = readJsonCache('public-index.json');
    if (!doc) {
      warn('  ! 离线模式：没有公开索引缓存，这一路跳过');
      return { kind: 'public-index', label: SOURCE_LABELS['public-index'], url: PUBLIC_INDEX_URL, records: new Map(), failed: true };
    }
  } else {
    log(`→ 公开索引 ${PUBLIC_INDEX_URL}`);
    try {
      const res = await fetch(PUBLIC_INDEX_URL, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-plugins-collector' },
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      doc = await res.json();
      // 原始索引 ~22MB；只留采集要用的字段再落盘，免得缓存比仓库还大
      writeJsonCache('public-index.json', {
        generatedAt: doc?.generatedAt ?? null,
        fetchedAt: now(),
        plugins: (doc?.plugins ?? []).map(slimIndexEntry),
      });
    } catch (err) {
      error = err?.message ?? String(err);
      warn(`  ! 拉取公开索引失败（改用缓存）：${error}`);
      doc = readJsonCache('public-index.json');
    }
  }

  const plugins = Array.isArray(doc?.plugins) ? doc.plugins : [];
  const out = new Map();
  for (const entry of plugins) {
    const rec = normalizeRecord({
      id: entry.fullName ?? entry.full_name ?? entry.id ?? entry.repo,
      description: entry.description,
      descriptionZh: entry.descriptionZh,
      stars: entry.stars,
      forks: entry.forks,
      language: entry.language,
      topics: entry.tags,
      license: entry.license,
      homepage: entry.homepage,
      pushedAt: entry.pushedAt,
      sources: ['public-index'],
    });
    if (!rec) continue;
    out.set(rec.id, out.has(rec.id) ? mergeRecords(out.get(rec.id), rec) : rec);
  }

  if (error) warn(`  ! 公开索引这一路本轮不完整：${error}`);
  ok(`公开索引：${out.size} 个仓库`);
  return {
    kind: 'public-index',
    label: SOURCE_LABELS['public-index'],
    url: PUBLIC_INDEX_URL,
    records: out,
    failed: Boolean(error) && out.size === 0,
    error: error ?? undefined,
  };
}

/** 公开索引的一条 → 只留采集要用的字段 */
function slimIndexEntry(p) {
  return {
    id: p.id,
    fullName: p.fullName ?? p.full_name,
    repo: p.repo,
    description: p.description,
    descriptionZh: p.descriptionZh,
    stars: p.stars,
    forks: p.forks,
    pushedAt: p.pushedAt,
    tags: p.tags,
    license: p.license,
    homepage: p.homepage,
    language: p.language,
  };
}

// ─────────────────────────────────────────────────────────────
// 来源 ③：seed（手工收录）
// ─────────────────────────────────────────────────────────────

/**
 * 手工收录的仓库。
 *
 * ★ 刻意**不**在这里手写 star 数 / 描述：联网时它们会被 GitHub 搜索那一路覆盖，
 *   离线时就用公开索引或上一轮的值。人工只回答「这个仓库要收 / 不要收」。
 */
async function collectFromSeed(include) {
  const records = new Map();
  if (include.length === 0) {
    return { kind: 'seed', label: SOURCE_LABELS.seed, url: 'catalog/seed.json', records, failed: false };
  }

  const token = githubToken();
  log(`→ 手工收录 ${include.length} 个仓库`);

  for (const id of include) {
    const existing = records.get(id);
    const placeholder = normalizeRecord({ id, sources: ['seed'] });
    if (existing) continue;

    let rec = placeholder;
    if (!OFFLINE) {
      try {
        const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugins-collector' };
        if (token) headers.authorization = `Bearer ${token}`;
        const res = await fetch(`https://api.github.com/repos/${id}`, { headers, signal: AbortSignal.timeout(30_000) });
        if (res.ok) {
          const item = await res.json();
          rec = mergeRecords(placeholder, repoFromSearchItem({ ...item, full_name: id }));
        } else {
          warn(`  ! ${id}：HTTP ${res.status}（仍然收录，元数据留空）`);
        }
      } catch (err) {
        warn(`  ! ${id}：${err?.message ?? err}（仍然收录，元数据留空）`);
      }
    }
    records.set(id, rec);
  }

  ok(`手工收录：${records.size} 个仓库`);
  return { kind: 'seed', label: SOURCE_LABELS.seed, url: 'catalog/seed.json', records, failed: false };
}

// ─────────────────────────────────────────────────────────────
// 来源 ④：GitHub 直读（点名批量刷新）
// ─────────────────────────────────────────────────────────────

/**
 * 按 owner/repo 点名，把**已知项目**的公开事实刷一遍。
 *
 * 与「GitHub 搜索」的分工：搜索负责**发现**（每个查询只有前 1000 条可见），
 * 这里负责**刷准**（点名就没有可见性上限）。面板上 star 数对不上、更新日期
 * 停在很久以前，根因就是这部分记录从来没人再看它们一眼。
 *
 * 配额账（实测）：一次请求 100 个仓库，GitHub 报的 `rateLimit.cost` 是 1 点，
 * 一万五千多条 = 约 152 次请求。CI 的 `GITHUB_TOKEN` 是 1,000 点/小时，
 * 所以默认每轮全刷；并发 4 把耗时压到几分钟。以下三条是保险：
 *
 *   · **配额见底就收手**：剩余点数低于 `REFRESH_MIN_POINTS` 就停下，
 *     这一轮没刷到的记录按「没看过」处理 —— 保持上一轮的值，不删。
 *   · **目录继续长大时可以分片**（`--refresh-rotation N`）：每轮刷 1/N，
 *     按时间窗轮转，不需要落盘游标。
 *   · **改名迁移**：GitHub 会为重定向后的旧 id 返回规范名；旧 id 的记录并到新 id 上，
 *     而不是留下一条永远停在旧名字的记录。
 *
 * @returns {{kind:string,label:string,url:string,records:Map,renamed:Map,
 *            missing:Set,covered:Set,skipped:Set,planned:number,
 *            failed:boolean,partial:boolean,error:string|null}}
 */
async function collectFromGithubRepos(ids, { token, priority = [], rotation = REFRESH_ROTATION_ARG } = {}) {
  const kind = 'github-repo';
  const label = SOURCE_LABELS[kind];
  const url = 'https://github.com';

  const all = new Set(ids);
  const queue = planRefreshQueue(all, { rotation, priority });
  const base = {
    kind, label, url,
    records: new Map(), renamed: new Map(), missing: new Set(),
    covered: new Set(), checked: new Set(), skipped: new Set(all), planned: queue.length,
    failed: false, partial: false, error: null,
  };

  if (queue.length === 0) {
    return { ...base, skipped: new Set(), partial: false };
  }
  if (!token) {
    warn('  ! 没有 GitHub token：跳过点名直读（GraphQL 不支持匿名），旧值原样保留');
    return { ...base, skipped: new Set(), failed: true, error: '没有 GitHub token，本轮没有直读任何仓库' };
  }

  log(`→ GitHub 直读 ${describeRefreshQueue(queue, all.size, { rotation })}`);

  const batches = [];
  for (let i = 0; i < queue.length; i += REPO_BATCH_SIZE) batches.push(queue.slice(i, i + REPO_BATCH_SIZE));

  const startedAt = Date.now();
  let cursor = 0;
  let completed = 0;
  let stopReason = null;      // 'limit' | 'error' | 'budget'
  let hardError = null;

  /** 把一批结果并进候选集（顺序无关：按 id 落 Map，最终排序在写盘前统一做） */
  const absorb = (res) => {
    for (const [requestedId, node] of res.nodes) {
      const rec = normalizeGraphqlRepo(node);
      if (!rec) continue;
      if (rec.id !== requestedId) base.renamed.set(requestedId, rec.id);
      const prev = base.records.get(rec.id);
      base.records.set(rec.id, prev ? mergeRecords(prev, rec) : rec);
      base.covered.add(requestedId);
      base.checked.add(requestedId);
      base.skipped.delete(requestedId);
      // 规范名也算「看过」：改名后旧 id 与规范 id 都不该再被当成没看过
      base.covered.add(rec.id);
      base.skipped.delete(rec.id);
    }
    for (const id of res.missing) {
      // 看过它了，只是它不在了 —— 不算「没刷到」，但也不产出新记录
      base.covered.add(id);
      base.checked.add(id);
      base.skipped.delete(id);
      base.missing.add(id);
    }
  };

  async function worker() {
    for (;;) {
      if (stopReason) return;
      const index = cursor;
      cursor += 1;
      if (index >= batches.length) return;

      const res = await fetchRepositoryBatch(batches[index], { token });

      /*
       * ★ 「配额用尽 / 网络挂了」与「这一批里有仓库被删了」必须分开：
       *   前者要停下来保命，后者是正常信息。`fetchRepositoryBatch` 已经把
       *   NOT_FOUND 与其它错误分开返回了。
       */
      if (res.rateLimited) {
        stopReason = 'limit';
        hardError = res.error;
        continue;
      }
      if (res.error && res.nodes.size === 0 && res.missing.size === 0) {
        stopReason = 'error';
        hardError = res.error;
        continue;
      }

      absorb(res);
      completed += 1;
      if (res.error) warn(`  ! 直读有错误（继续）：${res.error}`);
      if (completed % 20 === 0 || completed === batches.length) {
        log(`   直读 ${completed}/${batches.length} 批 · ${base.records.size} 个仓库 · ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
      }

      if (res.rateLimit && typeof res.rateLimit.remaining === 'number' && res.rateLimit.remaining < REFRESH_MIN_POINTS) {
        stopReason = 'budget';
        continue;
      }
    }
  }

  const workers = Math.min(REFRESH_CONCURRENCY, batches.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  if (stopReason === 'limit' || stopReason === 'budget') {
    warn(`  ! ${stopReason === 'limit' ? hardError : '配额见底'} —— 本轮直读提前收手，没刷到的记录保留上一轮的值`);
  }

  const took = ((Date.now() - startedAt) / 1000).toFixed(0);
  const missingNote = base.missing.size > 0 ? `，另有 ${base.missing.size} 个仓库在 GitHub 上已不存在` : '';
  const renameNote = base.renamed.size > 0 ? `，${base.renamed.size} 个仓库已改名（索引 id 已跟着改）` : '';
  ok(`GitHub 直读：${base.records.size} 个仓库（${took}s${missingNote}${renameNote}）`);

  // 一批都没成功 = 这一路整轮失败；部分成功只是「不完整」，由 skipped 兜住
  if (hardError && base.records.size === 0) {
    warn(`  ! 直读中断：${hardError} —— 没刷到的记录保留上一轮的值`);
    return { ...base, failed: true, partial: true, error: hardError };
  }

  if (stopReason === 'limit' || stopReason === 'budget' || stopReason === 'error' || base.skipped.size > 0) {
    base.partial = true;
    if (!base.error) base.error = hardError ?? null;
  }
  return base;
}

// ─────────────────────────────────────────────────────────────
// 合并
// ─────────────────────────────────────────────────────────────

function mergeAll(sources) {
  const merged = new Map();
  // 顺序即优先级：GitHub 搜索 → seed → 公开索引（mergeRecords 内部还会按来源排名校正）
  for (const source of sources) {
    for (const [id, rec] of source.records) {
      merged.set(id, merged.has(id) ? mergeRecords(merged.get(id), rec) : rec);
    }
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

/**
 * `--only`：直读一个仓库（REST，单次请求，没有 token 也能跑）。
 *
 * ★ 键用 GitHub 返回的**规范名**，不用入参：仓库或账号改名后，入参是个会
 *   重定向的旧名字，硬写回去会让索引继续停在旧 id 上。
 */
async function readOneRepo(id) {
  const token = githubToken();
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugins-collector' };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${id}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rec = repoFromSearchItem(await res.json());
    return rec ? new Map([[rec.id, rec]]) : new Map();
  } catch (err) {
    fail(`读取 ${id} 失败：${err?.message ?? err}`);
    return new Map();
  }
}

async function collect() {
  const { map: loadedExisting } = loadExistingIndex();
  let existing = loadedExisting;
  const seed = loadSeed();

  log(`  已有索引 ${existing.size} 条${CHECK_ONLY ? '（校验模式）' : ''}`);
  log('');

  const sources = [];
  if (ONLY) {
    // --only：只处理一个仓库，其余记录原样继承（手工补录用）
    log(`→ 只处理 ${ONLY}`);
    const single = OFFLINE ? new Map() : await readOneRepo(ONLY);
    sources.push({ kind: 'github-search', label: SOURCE_LABELS['github-search'], url: `https://github.com/${ONLY}`, records: single, failed: single.size === 0 });
  } else {
    sources.push(await collectFromGithubSearch());
    sources.push(await collectFromSeed(seed.include));
    sources.push(await collectFromPublicIndex());
  }

  let fresh = mergeAll(sources);

  // 手工排除：无论哪一路发现它，都不进索引
  for (const id of seed.exclude) fresh.delete(id);

  /*
   * ④ 点名直读 —— 放在最后，因为它是对「已经知道的项目」的最终确认：
   *    搜索/公开索引只回答「有哪些项目」，只有这里回答「它们现在多少星、最近哪天推的」。
   *
   * ★ 排班（默认只刷 1/4）：CI 的 GITHUB_TOKEN 只有 1,000 点/小时，整份目录
   *   一轮刷不完；没排到的记录由 reconcile 原样保留，不会丢、也不会被旧值覆盖。
   */
  if (!OFFLINE) {
    const refreshIds = ONLY
      ? [ONLY]
      : [...new Set([...existing.keys(), ...fresh.keys()])].filter((id) => !seed.exclude.has(id));
    const refresh = await collectFromGithubRepos(refreshIds, {
      token: githubToken(),
      rotation: ONLY ? 1 : REFRESH_ROTATION_ARG,
      priority: ONLY ? [ONLY] : [...new Set([...fresh.keys()].filter((id) => !existing.has(id)), ...seed.include)],
    });
    sources.push(refresh);
    ({ fresh, existing } = applyRepoRefresh(fresh, existing, refresh));
  }

  const failedSources = new Set(sources.filter((s) => s.failed).map((s) => s.kind));
  /** 这一轮**真的跑完**的来源 —— 只有它们才有资格「撤销」一条记录的来源标注 */
  const ranSources = new Set(sources.filter((s) => !s.failed).map((s) => s.kind));
  /**
   * 来源 → 本轮「跑了，但没轮到这个仓库」的集合。
   * 对这些仓库，该来源仍按「没跑」处理 —— 否则排班就会让上一轮的直读值
   * 被第三方转述的旧值顶掉，面板上的 star 数开始来回横跳。
   */
  const unseenBy = new Map();
  for (const s of sources) {
    if (s.partial && s.skipped && s.skipped.size > 0) unseenBy.set(s.kind, s.skipped);
  }

  const { records, stats } = reconcile(fresh, existing, {
    failedSources,
    ranSources,
    unseenBy,
    keepAll: Boolean(ONLY),
  });

  const sourceMeta = sources.map((s) => ({
    kind: s.kind,
    label: s.label,
    url: s.url,
    found: s.records.size,
    failed: s.failed,
    ...(s.partial ? { partial: true } : {}),
    ...(s.planned ? { planned: s.planned, covered: s.checked ? s.checked.size : 0, skipped: s.skipped ? s.skipped.size : 0 } : {}),
    ...(s.queries ? { queries: s.queries } : {}),
    ...(s.error ? { error: s.error } : {}),
  }));

  const sorted = sortRecords(records);
  const limited = LIMIT > 0 ? sorted.slice(0, LIMIT) : sorted;
  const previousDoc = readJsonSafe(INDEX_FILE);
  const previous = previousDoc ? buildIndex(previousDoc.plugins ?? [], { generatedAt: previousDoc.generatedAt, sources: previousDoc.sources ?? [] }) : null;

  // ★ generatedAt 只在内容真的变了时推进（否则每 6 小时一次的空跑都会留一条 diff）
  const next = buildIndex(limited, { generatedAt: now(), sources: sourceMeta });
  const changed = !previous || !contentEquals(indexContent(previous), indexContent(next));
  if (!changed && previous?.generatedAt) next.generatedAt = previous.generatedAt;

  log('');
  log(`  采集结果：新增 ${stats.added} · 更新 ${stats.updated} · 未变 ${stats.kept} · 留观 ${stats.unseen} · 清理 ${stats.removed}`);
  log(`  索引共 ${next.plugins.length} 条（star 最高 ${next.plugins[0]?.id ?? '—'} / ${next.plugins[0]?.stars ?? '—'}）`);
  if (failedSources.size > 0) {
    warn(`  ! 本轮有来源不完整（${[...failedSources].join('、')}）—— 由它们发现的记录一律保留，不做删除。`);
  }
  const partial = sources.filter((s) => s.partial && !s.failed && s.skipped);
  if (partial.length > 0) {
    log(`  这一轮只覆盖了一部分：${partial.map((s) => `${s.label} ${s.checked.size}/${s.checked.size + s.skipped.size}`).join('、')}（没刷到的记录保留上一轮的值）`);
  }

  if (LIMIT > 0) {
    warn(`  ! --limit ${LIMIT}：试跑模式，**没有写盘**。`);
    return next;
  }
  if (!changed && !CHECK_ONLY) {
    ok('内容没有实质变化，索引与快照保持原样（不产生空提交）。');
    return next;
  }

  writeTextAtomic(INDEX_FILE, serializeIndex(next));
  ok(`已写入 ${INDEX_REL}（${next.plugins.length} 条）`);

  const snapshot = buildSnapshot(next);
  writeTextAtomic(SNAPSHOT_FILE, serializeIndex(snapshot));
  ok(`已写入 ${SNAPSHOT_REL}（包内离线兜底，${snapshot.plugins.length} 条）`);

  return next;
}

// ─────────────────────────────────────────────────────────────
// --check：只读校验
// ─────────────────────────────────────────────────────────────

function check() {
  log('  --check：只读校验（不联网、不写盘）');
  log('');

  const raw = readJsonSafe(INDEX_FILE);
  if (!raw) {
    fail(`读不到 ${INDEX_REL} —— 请先跑一次 node scripts/collect.mjs`);
    return;
  }

  const records = (raw.plugins ?? []).map(normalizeRecord);
  if (records.some((r) => r === null)) fail('索引里有无法归一化的记录（id 不是 owner/repo 形状）');
  const valid = records.filter(Boolean);

  // ① 不允许重复 id
  const seen = new Set();
  for (const r of valid) {
    if (seen.has(r.id)) fail(`重复记录：${r.id}`);
    seen.add(r.id);
  }

  // ② 记录必须严格按 star 降序（排序规则只实现一次，索引落盘时必须已经是最终顺序）
  const sorted = sortRecords(valid);
  if (JSON.stringify(sorted.map((r) => r.id)) !== JSON.stringify(valid.map((r) => r.id))) {
    fail('索引的记录顺序不是「star 降序 → id 升序」—— 请重跑 collect.mjs');
  }

  // ③ 计数要对得上
  const expected = buildIndex(valid, { generatedAt: raw.generatedAt, sources: raw.sources ?? [] });
  if (!contentEquals(expected.counts, raw.counts)) {
    fail(`counts 与实际记录不一致：索引里写的是 ${JSON.stringify(raw.counts)}，实际算出来是 ${JSON.stringify(expected.counts)}`);
  }

  // ④ 序列化必须能原样往返（否则每轮采集都会产生假 diff）
  const roundTrip = serializeIndex(expected);
  if (roundTrip !== fs.readFileSync(INDEX_FILE, 'utf8')) {
    fail(`${INDEX_REL} 的文本与「重新序列化同一份数据」的结果不同 —— 说明它被手工改过，或序列化规则变了。`);
  }

  // ⑤ 包内快照必须是索引的稳定投影
  const snapshotText = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
  const expectedSnapshot = serializeIndex(buildSnapshot(expected));
  if (snapshotText !== expectedSnapshot) {
    fail(`${SNAPSHOT_REL} 不是当前索引的稳定投影 —— 请重跑 collect.mjs（它是打进插件包的离线兜底，必须与索引同一次提交）。`);
  }

  // ⑥ 每条记录都要有最基本的展示字段
  const noDesc = valid.filter((r) => !r.description && !r.descriptionZh).length;
  const noStars = valid.filter((r) => r.stars === null).length;

  log(`  记录 ${valid.length} 条 · 有描述 ${valid.length - noDesc} · 有 star ${valid.length - noStars}`);
  log(`  来源 ${JSON.stringify(raw.counts?.bySource ?? {})}`);
}

// ─────────────────────────────────────────────────────────────

async function main() {
  const started = Date.now();
  log('');
  log(`  插件项目采集${CHECK_ONLY ? '（--check）' : OFFLINE ? '（--offline）' : ''}`);
  log(`  ${'-'.repeat(66)}`);
  log(`  仓库  ${REPO}`);
  log('');

  if (CHECK_ONLY) check();
  else await collect();

  log('');
  if (problems.length > 0) {
    console.error(`  ✗ 有 ${problems.length} 个问题：`);
    for (const p of problems) console.error(`    · ${p}`);
    console.error('');
    process.exit(1);
  }
  log(`  ✓ 完成（${((Date.now() - started) / 1000).toFixed(1)}s）`);
  log('');
}

main().catch((err) => {
  console.error(`\n  ✗ 采集失败：${err?.stack ?? err}\n`);
  process.exit(1);
});
