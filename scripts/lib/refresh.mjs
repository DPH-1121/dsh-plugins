/**
 * 「这一轮该点名直读哪些仓库」—— 采集器的**排班表**。
 *
 * ── 为什么需要排班 ────────────────────────────────────────────
 *
 * 直读走 GraphQL：一次请求带 100 个仓库别名，实测约 6 秒、**1~3 点配额**
 * （100 个仓库的查询，GitHub 自己报的 `rateLimit.cost` 就是 1）。
 * 整份目录一万五千多条 = 约 152 次请求，≈ 150~450 点。
 *
 * 而 **GitHub Actions 里的 `GITHUB_TOKEN` 是 1,000 点/小时** —— 一轮刷完全部
 * 是放得下的，所以默认就是「每 6 小时把整份目录刷一遍」，一条记录的 star 数与
 * 最近推送最多滞后 6 小时。
 *
 * 排班仍保留（`--refresh-rotation N`），因为它是**目录继续长大之后的保险**：
 * 如果哪天一轮直读的预估点数逼近配额上限，把它切成 N 份、每轮刷一份，
 * 比「被限流打断、后半截记录永远不更新」要好。切份时按时间窗选片，不需要落盘游标。
 *
 * ── 为什么用「时间窗」而不是「上次刷到哪儿」的游标 ────────────
 *
 * 游标要落盘，而 `catalog/index.json` 里刻意不存「什么时候查的」（它一存，
 * 每轮都会产生一次全量 diff）。`.cache/` 又不进版本库、CI 每次都是全新的机器。
 * 用时间窗就简单得多：`floor(now / 6h) % N` —— 同一个窗口内跑几次都落在同一份，
 * 跨窗口自动前进一份，不需要任何状态。
 *
 * 切片顺序按 `id` 升序排，保证「同一份输入 ⇒ 同一份排班」；
 * 目录增减时切片边界会轻微漂移 —— 这是可接受的代价（最多晚一轮覆盖到）。
 */

/**
 * 默认把目录切成几份。
 *
 * 1 = 不分片（每轮刷全部）。按实测配额，1 是安全的；切成 4 之后每条记录
 * 最迟 24 小时才刷新一次，而那正是面板上「更新于 X 天前」看起来不对的原因之一。
 */
export const REFRESH_ROTATION = 1;

/** 与 CI 的采集周期一致（工作流是每 6 小时一次）；只在分片时才用得上 */
export const REFRESH_WINDOW_MS = 6 * 60 * 60 * 1000;

/** 剩余配额低于这个数就收手：留给搜索、重试与下一轮 */
export const REFRESH_MIN_POINTS = 150;

/**
 * 一次并发几个直读请求。
 *
 * 串行时一轮 152 个请求要 15 分钟（单请求 6 秒上下），并发 4 之后约 4 分钟；
 * GitHub 的并发上限是 100，4 是很保守的数。结果按 id 落进 Map，
 * 与完成顺序无关 —— 索引的确定性由最后的排序保证，不受并发影响。
 */
export const REFRESH_CONCURRENCY = 4;

/**
 * 本轮要直读的仓库队列。
 *
 * @param {Iterable<string>} ids      全部已知仓库
 * @param {object}  [options]
 * @param {number}  [options.now]     当前时间（测试里注入）
 * @param {number}  [options.rotation] 切成几份；1 = 不分片（默认）
 * @param {number}  [options.windowMs]
 * @param {string[]} [options.priority] 当轮必刷的仓库（新增 / 手工收录）
 * @returns {string[]} 有序队列；`priority` 在最前
 *
 * ★ 队列**只决定「问谁」**，不决定「谁被写进索引」：没排到的记录原样保留
 *   （见 reconcile 的 `unseenBy`），所以排班表短了、半路失败了，都不会丢数据。
 */
export function planRefreshQueue(ids, {
  now = Date.now(),
  rotation = REFRESH_ROTATION,
  windowMs = REFRESH_WINDOW_MS,
  priority = [],
} = {}) {
  const all = [...new Set(ids)].sort();
  const first = [...new Set(priority)].filter((id) => all.includes(id));
  const pinned = new Set(first);
  const rest = all.filter((id) => !pinned.has(id));

  const slices = Math.max(1, Math.trunc(rotation) || 1);
  if (slices === 1 || rest.length === 0) return [...first, ...rest];

  const per = Math.ceil(rest.length / slices);
  // ★ 0 号窗口从第 0 条开始，1 号从 per 开始 …… N 个窗口正好铺满整份目录
  const bucket = Math.floor(now / windowMs) % slices;
  const start = bucket * per;
  return [...first, ...rest.slice(start, start + per)];
}

/** 给人看的排班说明，用在采集日志里 */
export function describeRefreshQueue(queue, total, { rotation = REFRESH_ROTATION } = {}) {
  if (total <= 0) return '没有可直读的仓库';
  const slices = Math.max(1, Math.trunc(rotation) || 1);
  if (slices === 1) return `本轮直读全部 ${queue.length} 条`;
  return `本轮直读 ${queue.length}/${total} 条（分 ${slices} 轮覆盖，每 6 小时一轮）`;
}
