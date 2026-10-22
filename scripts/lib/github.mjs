/**
 * GitHub 采集的**传输层** —— 只用 Node 内置的 fetch，不引第三方 SDK。
 *
 * 这里有两条路，职责不同，别混：
 *
 *   ① `searchRepositories`（REST 搜索）—— **发现新项目**。一次 100 个完整仓库对象，
 *      但每个查询最多只翻到 1000 条，所以它只能看到「每个切面 star 最高的那一批」。
 *   ② `fetchRepositoryBatch`（GraphQL 点名）—— **把已知项目刷准**。按 owner/repo
 *      一次问 100 个，14k 条也覆盖得到；star 数、最近推送、改名都在这里更新。
 *
 * ★ 只靠 ① 的后果是真实发生过的：落在 1000 条之外的项目（大量 star 个位数的插件）
 *   永远拿不到新数据，面板上就一直是「更新于 23 天前」和几个月前的 star 数。
 *   数据管道里「看得见的那部分很新、看不见的那部分永远停在第一次采集」，
 *   比整体慢一点更难发现。
 *
 * 认证：`GITHUB_TOKEN` / `GH_TOKEN`。REST 搜索没有 token 时只给 10 次/分钟，
 * GraphQL **完全没有匿名访问**（公开数据也要认证），所以没 token 时直读这条路
 * 直接如实报「跳过」，而不是空跑一轮。
 */

const API = 'https://api.github.com';
const GRAPHQL = `${API}/graphql`;

export const DEFAULT_PER_PAGE = 100;
/** 搜索接口每个查询最多能翻到 1000 条结果 —— 这是 GitHub 的硬限制，不是我们的选择 */
export const SEARCH_RESULT_CAP = 1000;

/**
 * 一次 GraphQL 调用带多少个仓库别名。
 *
 * 100 是实测稳定值：请求体约 30KB，单次 2~4 秒。试过 200 —— GitHub 直接回一段
 * HTML（不是 JSON），所以这里不「尽量压大」，只取一个确认能过的数。
 */
export const REPO_BATCH_SIZE = 100;

/** 仓库节点要的字段 —— 面板展示与排序用得到的全部，别的一个不取（点数是按节点算的） */
const REPO_NODE_FIELDS = [
  'nameWithOwner',
  'stargazerCount',
  'forkCount',
  'description',
  'primaryLanguage { name }',
  'repositoryTopics(first: 20) { nodes { topic { name } } }',
  'licenseInfo { spdxId }',
  'homepageUrl',
  'pushedAt',
  'isArchived',
].join(' ');

export function githubToken(env = process.env) {
  return env.GITHUB_TOKEN || env.GH_TOKEN || env.DSH_PLUGINS_GITHUB_TOKEN || null;
}

/** 日志里永远不出现 token 本身 */
export function describeToken(token) {
  return token ? `已提供（${String(token).slice(0, 4)}…，长度 ${String(token).length}）` : '未提供（限流更严）';
}


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rateLimitOf(headers) {
  const remaining = headers.get('x-ratelimit-remaining');
  const limit = headers.get('x-ratelimit-limit');
  const reset = headers.get('x-ratelimit-reset');
  const retryAfter = headers.get('retry-after');
  return {
    remaining: remaining === null ? null : Number(remaining),
    limit: limit === null ? null : Number(limit),
    resetAt: reset === null ? null : new Date(Number(reset) * 1000).toISOString(),
    resetInMs: reset === null ? null : Math.max(0, Number(reset) * 1000 - Date.now()),
    retryAfterMs: retryAfter === null ? null : Number(retryAfter) * 1000,
  };
}

/**
 * 搜索仓库。
 *
 * @param {string} query           GitHub 搜索语法
 * @param {object} options
 * @param {string|null} options.token
 * @param {number} [options.pages] 最多翻几页（每页 100 条）
 * @param {number} [options.perPage]
 * @param {number} [options.maxWaitMs] 单次等待限流恢复的上限
 * @param {(p:object)=>void} [options.onProgress]
 * @returns {Promise<{items:object[], pages:number, error:string|null, rateLimit:object|null}>}
 */
export async function searchRepositories(query, {
  token = null,
  pages = 3,
  perPage = DEFAULT_PER_PAGE,
  maxWaitMs = 65_000,
  fetchImpl = fetch,
  onProgress = null,
} = {}) {
  const items = [];
  let lastRateLimit = null;
  let fetchedPages = 0;

  for (let page = 1; page <= pages; page += 1) {
    const url = `${API}/search/repositories?q=${encodeURIComponent(query)}`
      + `&sort=stars&order=desc&per_page=${perPage}&page=${page}`;

    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-plugins-collector',
      'x-github-api-version': '2022-11-28',
    };
    if (token) headers.authorization = `Bearer ${token}`;

    let res;
    let attempt = 0;
    // 限流与瞬时故障都重试，但有上限 —— 采集宁可少采一轮，也不能挂死在 CI 里
    for (;;) {
      attempt += 1;
      try {
        res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(45_000) });
      } catch (err) {
        if (attempt >= 3) return { items, pages: fetchedPages, error: `请求失败：${err?.message ?? err}`, rateLimit: lastRateLimit };
        await sleep(1500 * attempt);
        continue;
      }

      lastRateLimit = rateLimitOf(res.headers);
      if (res.ok) break;

      const exhausted = res.status === 403 || res.status === 429;
      const waitMs = Math.min(
        lastRateLimit.retryAfterMs ?? lastRateLimit.resetInMs ?? 5000,
        maxWaitMs,
      );
      if (exhausted && attempt < 4 && waitMs > 0) {
        onProgress?.({ query, page, waiting: waitMs, status: res.status });
        await sleep(waitMs + 500);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(1500 * attempt);
        continue;
      }
      const text = await res.text().catch(() => '');
      return {
        items,
        pages: fetchedPages,
        error: `HTTP ${res.status}${res.status === 403 || res.status === 429 ? '（限流）' : ''}：${text.slice(0, 200)}`,
        rateLimit: lastRateLimit,
      };
    }

    let payload;
    try {
      payload = await res.json();
    } catch (err) {
      return { items, pages: fetchedPages, error: `响应不是 JSON：${err?.message ?? err}`, rateLimit: lastRateLimit };
    }

    const batch = Array.isArray(payload?.items) ? payload.items : [];
    items.push(...batch);
    fetchedPages += 1;
    onProgress?.({ query, page, got: batch.length, total: payload?.total_count ?? null, rateLimit: lastRateLimit });

    if (batch.length < perPage) break;                        // 没有下一页了
    if (page * perPage >= Math.min(payload?.total_count ?? 0, SEARCH_RESULT_CAP)) break; // 碰到 1000 条硬顶
    // 认证后 30 次/分钟：礼貌一点，连续翻页之间留出间隔
    await sleep(token ? 2200 : 6500);
  }

  return { items, pages: fetchedPages, error: null, rateLimit: lastRateLimit };
}

// ─────────────────────────────────────────────────────────────
// GraphQL：按 owner/repo 点名批量直读
// ─────────────────────────────────────────────────────────────

/**
 * 一批仓库 → 一条 GraphQL 查询（每个仓库一个别名）。
 *
 * `r0: repository(owner:"a", name:"b") { … }` 这样拼起来，比「一个仓库一次 HTTP」
 * 少两个数量级的请求。别名用**下标**，响应解析时靠同一个下标对回去，
 * 所以调用方传进来的 id 顺序就是结果顺序，不要在这里排序。
 */
export function buildRepositoryBatchQuery(ids) {
  const parts = [];
  ids.forEach((id, i) => {
    const slash = String(id ?? '').indexOf('/');
    if (slash <= 0) return;
    const owner = String(id).slice(0, slash);
    const name = String(id).slice(slash + 1);
    if (owner === '' || name === '') return;
    // JSON.stringify 产出的双引号字符串就是合法的 GraphQL 字符串字面量
    parts.push(`  r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${REPO_NODE_FIELDS} }`);
  });
  return `query {\n${parts.join('\n')}\n}`;
}

/**
 * 一批 GraphQL 响应 → 逐仓库的结果。
 *
 * 三种情况必须分开，混起来会静默删掉记录：
 *
 *   · `nodes`   拿到了数据（`data.rN` 是对象）
 *   · `missing` GitHub 明确说**没有这个仓库**（`R_NOT_FOUND`）。这是信息，不是故障 ——
 *              仓库可能被删了、转私有、或者已经连改名都追踪不到
 *   · 两者都不是（别的错误、整份 data 为 null）→ 整批算失败，调用方保留上一轮的值
 *
 * ★ 别名对不上的错误（`errors[].path[0]`）要单独记下来：一个仓库因为
 *   「资源限制」被截断，不代表它不存在；把它算成 missing，下一轮就会从索引里消失。
 */
export function parseRepositoryBatch(payload, ids) {
  const empty = { nodes: new Map(), missing: new Set(), error: null, failed: true };
  const data = payload?.data;
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];

  const problems = [];
  const broken = new Set();
  for (const err of errors) {
    const alias = Array.isArray(err?.path) && err.path.length > 0 ? String(err.path[0]) : null;
    if (err?.type === 'NOT_FOUND') continue;     // 「这个仓库不在了」是结果，不是错误
    if (alias) broken.add(alias);
    problems.push(`${err?.type ?? 'ERROR'}：${err?.message ?? '未知错误'}`);
  }

  if (!data || typeof data !== 'object') {
    return { ...empty, error: problems.join('；') || '响应里没有 data' };
  }

  const nodes = new Map();
  const missing = new Set();
  ids.forEach((id, i) => {
    const alias = `r${i}`;
    const node = data[alias];
    if (node && typeof node === 'object' && typeof node.nameWithOwner === 'string') {
      nodes.set(id, node);
    } else if (!broken.has(alias)) {
      missing.add(id);
    }
  });

  return {
    nodes,
    missing,
    error: problems.length > 0 ? problems.slice(0, 3).join('；') : null,
    failed: problems.length > 0,
  };
}

/**
 * 点名直读一批仓库（GraphQL）。
 *
 * @param {string[]} ids
 * @param {object} options
 * @param {string|null} options.token      必需 —— GraphQL 没有匿名访问
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.maxAttempts]   网络 / 5xx / 二级限流的最多尝试次数
 * @param {(p:object)=>void} [options.onProgress]
 * @returns {Promise<{nodes:Map<string,object>, missing:Set<string>,
 *                    error:string|null, failed:boolean, rateLimited:boolean,
 *                    rateLimit:object|null}>}
 *
 * ★ 主配额耗尽时**不等待**，直接如实返回。CI 一轮只有 45 分钟，而窗口重置
 *   可能要半小时以上 —— 等下去只会把整轮采集拖死；少刷一批，下一轮接着刷。
 */
export async function fetchRepositoryBatch(ids, {
  token = null,
  fetchImpl = fetch,
  maxAttempts = 3,
  onProgress = null,
} = {}) {
  const queue = (ids ?? []).filter((id) => typeof id === 'string' && id.includes('/'));
  const empty = { nodes: new Map(), missing: new Set(), error: null, failed: false, rateLimited: false, rateLimit: null };
  if (queue.length === 0) return empty;

  if (!token) {
    return { ...empty, failed: true, error: '没有 GitHub token：GraphQL 直读必须认证（公开数据也要）' };
  }

  const query = buildRepositoryBatchQuery(queue);
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'dsh-plugins-collector',
    'x-github-api-version': '2022-11-28',
    authorization: `Bearer ${token}`,
  };

  let rateLimit = null;
  for (let attempt = 1; ; attempt += 1) {
    let res;
    try {
      res = await fetchImpl(GRAPHQL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      if (attempt >= maxAttempts) return { ...empty, failed: true, error: `请求失败：${err?.message ?? err}`, rateLimit };
      await sleep(1500 * attempt);
      continue;
    }

    rateLimit = rateLimitOf(res.headers);

    if (res.status === 401 || res.status === 403 || res.status === 429) {
      // x-ratelimit-remaining = 0 ⇒ 主配额耗尽。等到重置不值当（见函数说明）
      if (rateLimit.remaining === 0) {
        return {
          ...empty,
          failed: true,
          rateLimited: true,
          error: `GraphQL 配额用尽（限额 ${rateLimit.limit ?? '?'}，${rateLimit.resetAt ?? '稍后'} 重置）`,
          rateLimit,
        };
      }
      // 否则按二级限流处理：等 retry-after（没有就等 30 秒）再试，最多 maxAttempts 次
      const waitMs = Math.min(rateLimit.retryAfterMs ?? 30_000, 60_000);
      if (attempt < maxAttempts) {
        onProgress?.({ waiting: waitMs, status: res.status });
        await sleep(waitMs);
        continue;
      }
      return { ...empty, failed: true, error: `HTTP ${res.status}（限流）`, rateLimit };
    }

    if (!res.ok) {
      if (res.status >= 500 && attempt < maxAttempts) {
        await sleep(1500 * attempt);
        continue;
      }
      const text = await res.text().catch(() => '');
      return { ...empty, failed: true, error: `HTTP ${res.status}：${text.slice(0, 200)}`, rateLimit };
    }

    let payload;
    try {
      payload = await res.json();
    } catch (err) {
      return { ...empty, failed: true, error: `响应不是 JSON：${err?.message ?? err}`, rateLimit };
    }

    const parsed = parseRepositoryBatch(payload, queue);
    // 主配额耗尽也可能以 200 + errors 的形式出现（GitHub 的老行为）
    const exhausted = (payload?.errors ?? []).some((e) => e?.type === 'RATE_LIMITED');
    if (exhausted) {
      return {
        nodes: parsed.nodes,
        missing: parsed.missing,
        failed: true,
        rateLimited: true,
        error: 'GraphQL 配额用尽（响应里报告 RATE_LIMITED）',
        rateLimit,
      };
    }

    onProgress?.({ got: parsed.nodes.size, missing: parsed.missing.size, rateLimit });
    return { ...parsed, rateLimited: false, rateLimit };
  }
}
