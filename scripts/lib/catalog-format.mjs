/**
 * 插件项目索引的**格式层** —— 记录长什么样、怎么归一化、怎么序列化。
 *
 * ── 只有一份数据 ──────────────────────────────────────────────
 *
 *   catalog/index.json     全部采集结果（唯一事实来源）
 *   catalog/snapshot.json  上面那份的**稳定投影**：star 数最高的一批，
 *                          打进插件包当离线兜底（装到别的机器上没网时用）
 *
 * ★ 与上一版（插件市场）的关键区别：目录里**没有**安装方法、版本号、信任分级、
 *   体检结论。这一版只记录「这是一个什么项目」：
 *
 *     id / owner / name / url          项目地址与作者
 *     description / descriptionZh      项目描述
 *     stars / forks                    收藏量
 *     language / topics / license / homepage / pushedAt / archived   公开事实
 *
 * ★ 三条硬规矩（与旧版一致，因为它们解决的是同一类问题）：
 *
 *   ① **内容没变就不动时间戳。** 每 6 小时一次的定时采集如果无脑刷新
 *      lastSyncedAt，几千条记录会天天全部显示为「已修改」，真正的变更被噪音淹没。
 *   ② **拿不到就是 null。** 描述取不到就写 null，不用仓库名凑一句假的。
 *   ③ **输出必须逐字节确定。** 同输入必得同字节：排序规则固定、键顺序固定、
 *      时间戳只在内容真的变了时推进 —— 否则 CI 里「新采一轮」永远是一堆假 diff。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 2;
export const INDEX_REL = 'catalog/index.json';
export const SNAPSHOT_REL = 'catalog/snapshot.json';

/** 默认携带完整离线目录，新设备不依赖 GitHub Raw 的可达性。 */
export const SNAPSHOT_SIZE = Infinity;

/**
 * 来源标识 → 人话，用于界面与索引里的 sources 数组。
 *
 * ★ `github-repo` 与 `github-search` 是**两条不同的路**，虽然都直读 GitHub：
 *   搜索负责「发现新项目」（一次 100 个，但只能看到每个查询的前 1000 条），
 *   直读负责「把已知项目的 star 数与最近推送刷准」（按 owner/repo 点名，14k 条也能覆盖）。
 *   只靠搜索的话，落在 1000 条之外的项目永远拿不到新数据 —— 这正是面板上
 *   「更新于 23 天前」与星数对不上的根因。
 */
export const SOURCE_LABELS = {
  'github-search': 'GitHub 搜索',
  'github-repo': 'GitHub 直读',
  'public-index': '公开索引',
  seed: '手工收录',
};

export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// ─────────────────────────────────────────────────────────────
// 归一化
// ─────────────────────────────────────────────────────────────

const GITHUB_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** `https://github.com/a/b`、`github:a/b`、`a/b.git` → `a/b`；不像仓库返回 null */
export function toRepoId(input) {
  const raw = String(input ?? '').trim();
  if (raw === '') return null;
  let value = raw;
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(value);
  if (url) value = url[1];
  value = value.replace(/^github:/i, '');
  value = value.split(/[?#]/)[0].replace(/\/+$/, '');
  value = value.replace(/\.git$/i, '');
  // 允许 `owner/repo/tree/main/sub` 这种地址：只取前两段
  const parts = value.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const id = `${parts[0]}/${parts[1]}`;
  return GITHUB_ID_RE.test(id) ? id : null;
}

function str(value, max = 600) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function int(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function isoDate(value) {
  if (typeof value !== 'string' || value === '') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function topicList(value) {
  if (!Array.isArray(value)) return [];
  const out = new Set();
  for (const t of value) {
    const s = String(t ?? '').trim().toLowerCase();
    if (s !== '' && s.length <= 50) out.add(s);
  }
  return [...out].sort();
}

/**
 * 任意来源的一条候选 → 规范记录。
 *
 * 键顺序**刻意固定**：JSON.stringify 按插入顺序输出，键顺序一致是
 * 「同输入必得同字节」的一部分（见文件末尾 serializeIndex 的说明）。
 */
export function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = toRepoId(raw.id ?? raw.fullName ?? raw.full_name ?? raw.repo ?? raw.url);
  if (!id) return null;
  const slash = id.indexOf('/');
  const owner = id.slice(0, slash);
  const name = id.slice(slash + 1);

  const sources = Array.isArray(raw.sources)
    ? [...new Set(raw.sources.filter((s) => typeof s === 'string' && s !== ''))].sort()
    : [];

  return {
    id,
    owner,
    name,
    url: `https://github.com/${id}`,
    description: str(raw.description ?? raw.summary ?? raw.desc),
    descriptionZh: str(raw.descriptionZh ?? raw.summaryZh),
    author: owner,
    stars: int(raw.stars ?? raw.stargazers_count ?? raw.stargazerCount),
    forks: int(raw.forks ?? raw.forks_count ?? raw.forkCount),
    language: str(raw.language, 40),
    topics: topicList(raw.topics ?? raw.tags),
    license: str(raw.license, 40),
    homepage: str(raw.homepage, 300),
    pushedAt: isoDate(raw.pushedAt ?? raw.pushed_at),
    archived: raw.archived === true,
    sources,
    firstSeenAt: isoDate(raw.firstSeenAt),
    lastSyncedAt: isoDate(raw.lastSyncedAt),
  };
}

/**
 * GitHub GraphQL 的 `repository` 节点 → 规范记录。
 *
 * ★ 为什么不能复用 REST 搜索那条路：两个接口的字段形状**完全不同**
 *   （`stargazerCount` vs `stargazers_count`、`primaryLanguage.name` vs `language`、
 *   `repositoryTopics.nodes[].topic.name` vs `topics`），
 *   而 `normalizeRecord` 只认识 REST 的形状。
 *
 * ★ 最要紧的是 `nameWithOwner`：仓库或账号**改名之后**，只有它会告诉我们
 *   「这个仓库现在叫什么」。旧 id 在 GitHub 上会被重定向，GraphQL 也会照着重定向
 *   返回规范名 —— 采集器据此把索引里的 id 一起迁过去。没有这一步，面板会一直
 *   显示改名前的老地址，而 star 数看起来和真人对不上（其实是另一个仓库视图）。
 *
 * 拿不到就是 null：GraphQL 没给描述，就写 null，不拿仓库名凑一句。
 */
export function normalizeGraphqlRepo(node, { sources = ['github-repo'] } = {}) {
  if (!node || typeof node !== 'object') return null;
  const topics = (Array.isArray(node.repositoryTopics?.nodes) ? node.repositoryTopics.nodes : [])
    .map((n) => n?.topic?.name)
    .filter((t) => typeof t === 'string' && t !== '');
  const spdx = node.licenseInfo?.spdxId;
  return normalizeRecord({
    id: node.nameWithOwner,
    description: node.description,
    stars: node.stargazerCount,
    forks: node.forkCount,
    language: node.primaryLanguage?.name ?? null,
    topics,
    // GitHub 用一个占位 SPDX 表示「有 LICENSE 文件但没有可识别的许可」
    license: spdx && spdx !== 'NOASSERTION' ? spdx : null,
    homepage: node.homepageUrl,
    pushedAt: node.pushedAt,
    archived: node.isArchived,
    sources,
  });
}

/**
 * 采信顺序：直读 GitHub（搜索 / 点名）> 手工收录 > 公开索引（第三方转述）。
 *
 * ★ `github-repo` 与 `github-search` 并列最高：两者都是 GitHub 自己给的字段，
 *   没有「谁更可信」的问题。真要分先后，`mergeRecords` 按传入顺序取第一个
 *   （见它的说明）—— 采集器刻意把「本轮点名直读」放在前面，因为那份最新。
 */
const SOURCE_RANK = { 'github-search': 3, 'github-repo': 3, seed: 2, 'public-index': 1 };

/** 一条记录里**最高**的那个来源排名 —— 0 表示来源未知 */
export function sourceRank(rec) {
  return (rec?.sources ?? []).reduce((acc, s) => Math.max(acc, SOURCE_RANK[s] ?? 0), 0);
}

function bestRank(rec) {
  return sourceRank(rec);
}

/**
 * 合并同一个仓库的多次采集结果。
 *
 * 字段级取舍：谁的来源排名高就采信谁的非空值；**排名相同时采信第一个参数**
 * （`github-search` 与 `github-repo` 并列最高，采集器会把「本轮刚刚点名直读」
 * 的那份放在第一个，因为那份最新）。`sources` 取并集 ——
 * 「这条是从哪儿知道的」本身就是要展示的事实。
 *
 * ★ `firstSeenAt` 取最早、`lastSyncedAt` 取最新：改名迁移时这条规矩让
 *   「这个项目第一次被看到」的时间跟着记录一起搬家，而不是从今天重新算。
 */
export function mergeRecords(a, b) {
  if (!a) return b;
  if (!b) return a;
  const [primary, secondary] = bestRank(a) >= bestRank(b) ? [a, b] : [b, a];
  const pick = (key) => primary[key] ?? secondary[key] ?? null;
  return {
    ...primary,
    description: pick('description'),
    descriptionZh: pick('descriptionZh'),
    stars: primary.stars ?? secondary.stars ?? null,
    forks: primary.forks ?? secondary.forks ?? null,
    language: pick('language'),
    topics: [...new Set([...(primary.topics ?? []), ...(secondary.topics ?? [])])].sort(),
    license: pick('license'),
    homepage: pick('homepage'),
    pushedAt: pick('pushedAt'),
    archived: Boolean(primary.archived || secondary.archived),
    sources: [...new Set([...(a.sources ?? []), ...(b.sources ?? [])])].sort(),
    firstSeenAt: [a.firstSeenAt, b.firstSeenAt].filter(Boolean).sort()[0] ?? null,
    lastSyncedAt: [a.lastSyncedAt, b.lastSyncedAt].filter(Boolean).sort().slice(-1)[0] ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
// 排序与内容投影
// ─────────────────────────────────────────────────────────────

/** 排序规则只有这一处：star 降序 → id 升序。前端不再排第二次。 */
export function sortRecords(records) {
  return [...records].sort((a, b) => {
    const sa = Number.isFinite(a.stars) ? a.stars : -1;
    const sb = Number.isFinite(b.stars) ? b.stars : -1;
    if (sa !== sb) return sb - sa;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * 记录的**内容投影** —— 去掉登记性时间戳。
 *
 * 变更判定只看它：一条记录「什么时候被看到的」变了不算内容变了，
 * 否则每轮采集都会把全部记录判成「已修改」。
 */
export function recordContent(rec) {
  const { firstSeenAt, lastSyncedAt, ...content } = rec;
  return content;
}

export function contentEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─────────────────────────────────────────────────────────────
// 组装
// ─────────────────────────────────────────────────────────────

export function computeCounts(records) {
  const bySource = {};
  let archived = 0;
  let withDescription = 0;
  for (const r of records) {
    for (const s of r.sources ?? []) bySource[s] = (bySource[s] ?? 0) + 1;
    if (r.archived) archived += 1;
    if (r.description) withDescription += 1;
  }
  return {
    total: records.length,
    bySource: Object.fromEntries(Object.entries(bySource).sort()),
    archived,
    withDescription,
  };
}

/**
 * 组装索引文档。
 *
 * @param {object[]} records 已归一化的记录
 * @param {object}   meta    { generatedAt, sources }
 */
export function buildIndex(records, { generatedAt, sources = [] } = {}) {
  const sorted = sortRecords(records);
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: generatedAt ?? null,
    counts: computeCounts(sorted),
    sources,
    note: '由 scripts/collect.mjs 采集生成，请勿手工编辑。每条记录只描述「这是一个什么 GitHub 项目」'
      + '（描述 / 地址 / 作者 / star 数 / 语言 / topic / 最近推送 / 许可）；'
      + '安装请用官方桌面版自带的「设置 → 插件 → 添加插件」，填 github:owner/repo。',
    plugins: sorted,
  };
}

/**
 * 索引的内容投影：与时间戳无关。
 * 「这一轮到底有没有采到不一样的东西」由它回答。
 *
 * ★ 刻意**不包含 `sources`**。
 *
 *   `sources` 记的是「这一轮每一路采到了多少、哪些查询失败了」—— 它是**这一次
 *   运行**的体检报告，不是数据内容。把它算进变更判定会有一个很隐蔽的后果：
 *   一次离线重跑（或某一路被限流）虽然一条记录都没改，却因为「这一轮的统计数字
 *   不一样」而重写整个文件 —— 于是文件里那一段就变成了「上一次尝试」的记录，
 *   而不是「上一次真正采到新东西」的记录。
 *
 *   排除它之后，行为是：**只有在记录真的变了时才写盘**，而写下去的那份 `sources`
 *   自然就是这次有效采集的统计。没变时文件原样不动，里面留着的仍是上一次
 *   有效采集的统计。
 */
export function indexContent(index) {
  return {
    counts: index.counts,
    plugins: (index.plugins ?? []).map(recordContent),
  };
}

export function indexFingerprint(index) {
  return createHash('sha256').update(JSON.stringify(indexContent(index))).digest('hex').slice(0, 16);
}

// ─────────────────────────────────────────────────────────────
// 序列化
// ─────────────────────────────────────────────────────────────

/**
 * 索引 → 文本。
 *
 * ★ `plugins` 数组**一条记录一行**，而不是整体 pretty-print。
 *
 *   这份文件是天天在变的运行时数据：几千条记录如果按两空格缩进展开就是几十万行，
 *   改一个 star 数会在 diff 里显示成整段重排。一条一行之后，diff 里出现的恰好是
 *   「哪几个仓库变了」—— 与上一版「一个插件一个配置文件」想解决的问题是同一个，
 *   只是这次不用付几千个文件的代价。
 */
export function serializeIndex(index) {
  const lines = [];
  lines.push('{');
  lines.push(`  "schemaVersion": ${index.schemaVersion},`);
  lines.push(`  "generatedAt": ${JSON.stringify(index.generatedAt)},`);
  lines.push(`  "counts": ${JSON.stringify(index.counts)},`);
  lines.push(`  "sources": ${JSON.stringify(index.sources)},`);
  lines.push(`  "note": ${JSON.stringify(index.note)},`);
  lines.push('  "plugins": [');
  const n = index.plugins.length;
  index.plugins.forEach((rec, i) => {
    lines.push(`    ${JSON.stringify(rec)}${i === n - 1 ? '' : ','}`);
  });
  lines.push('  ]');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/**
 * 包内离线兜底快照 —— 索引的**稳定投影**。
 *
 * ★ 只保留「项目是什么」这几个字段，登记性时间戳一律清空。
 *   快照是打进插件包的：如果它随目录的日常刷洗而变，那么每 6 小时一次的采集
 *   都会改到包，而包的字节变了、版本号没变 —— 装过的人不会收到任何更新，
 *   git 里却天天多一个二进制 diff。清空之后，只有**实质内容**（新项目出现、
 *   star 数变化、描述改写）才会动到包。
 */
export function buildSnapshot(index, { size = SNAPSHOT_SIZE } = {}) {
  const plugins = sortRecords(index.plugins ?? []).slice(0, size).map((rec) => ({
    id: rec.id,
    owner: rec.owner,
    name: rec.name,
    url: rec.url,
    description: rec.description,
    descriptionZh: rec.descriptionZh,
    author: rec.author,
    stars: rec.stars,
    forks: rec.forks,
    language: rec.language,
    topics: rec.topics,
    license: rec.license,
    homepage: rec.homepage,
    pushedAt: rec.pushedAt,
    archived: rec.archived,
    sources: rec.sources,
    firstSeenAt: null,
    lastSyncedAt: null,
  }));
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: null,
    counts: { total: plugins.length },
    sources: index.sources,
    note: `包内离线兜底快照：包含 ${plugins.length} 条项目。在线时面板读取仓库里的最新索引`
      + '（catalog/index.json）；登记性字段一律为 null —— 它们是「什么时候查的」，不是「内容」，'
      + '进了包就会让每次采集都改到插件包。',
    plugins,
  };
}

/** 仓库里所有产物的相对路径（CI / --check 用） */
export function artifactPaths(repoRoot) {
  return [path.join(repoRoot, INDEX_REL), path.join(repoRoot, SNAPSHOT_REL)];
}
