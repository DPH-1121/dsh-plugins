/**
 * 采集器的**对账层** —— 决定「这一轮的观测」怎样变成「下一版索引」。
 *
 * 这一层单独成文件，是因为它的三条规矩都必须能被测试直接打到（`test/reconcile.test.mjs`）：
 *
 *   ① **内容没变就不动时间戳。** 否则每 6 小时一次的空跑都会把几千条记录
 *      标成「已修改」，真正变化被噪音淹没。
 *   ② **没看过就不删、也别改。** 某个来源这一轮失败了（限流、断网）或按排班
 *      没轮到某个仓库，由它给出的值一律**接住上一轮**。把「没查到」当成
 *      「不存在」是这类采集器最容易犯、也最难发现的错误。
 *   ③ **旧 id 会被改名带走。** 仓库改名后，直读会带回新的 `nameWithOwner`，
 *      旧 id 的记录并到新 id 上，而不是留下两条（一条新、一条永远停在旧名字）。
 */

import { contentEquals, mergeRecords, recordContent, sourceRank } from './catalog-format.mjs';

/** 多久没被任何来源看到就从索引里清掉 */
export const STALE_MS = 90 * 24 * 60 * 60 * 1000;

/** 会被来源影响、因而需要「接住上一轮」的字段 */
const CARRY_FIELDS = [
  'description', 'descriptionZh', 'stars', 'forks',
  'language', 'topics', 'license', 'homepage', 'pushedAt',
];

/**
 * 某个来源这一轮没看这个仓库时，把上一轮的值接住。
 *
 * 两种情形，语义不同，所以分成两档：
 *
 *   · `force = false`（这一轮看过的来源排名**不低于**上一轮）：
 *     只补空 —— 看过的来源说「这里是 null」是有效信息，但没说到的字段别丢。
 *
 *   · `force = true`（有一个**排名更高**的来源这一轮没看它）：
 *     字段级以**上一轮**为准。理由：高排名来源（直读 GitHub）与低排名来源
 *     （第三方转述）本来就常常给出不同的值，让低排名的那份去覆盖高排名的那份，
 *     换来的不是「更新」而是「来回横跳」—— 每跑一次就翻一次，而且没有提示。
 *     面板上「star 数怎么一会儿 5 一会儿 1」就是这么来的。
 *
 * ★ 拿不到就是 null 这条规矩，针对的是「**去看过**但没看到」，不是「压根没去看」。
 */
export function carryForward(rec, prev, { force }) {
  const out = { ...rec };
  for (const key of CARRY_FIELDS) {
    const value = out[key];
    const empty = value === null || value === undefined || (Array.isArray(value) && value.length === 0);
    if (!empty && !force) continue;
    if (prev[key] !== null && prev[key] !== undefined) out[key] = prev[key];
  }
  if ((force || !out.archived) && prev.archived) out.archived = true;
  return out;
}

/**
 * 把「本轮点名直读」的结果并进候选集。
 *
 * 三件事，顺序不能反：
 *
 *   ① **改名迁移**：`refresh.renamed` 里的旧 id，它的记录并到规范 id 上，
 *      旧 id 从候选集与上一版索引里一起拿掉 —— 不拿掉就会变成两条重复记录。
 *   ② **直读结果覆盖字段**：直读那份排在最前面（同排名取第一个），
 *      所以 star 数、最近推送、许可、归档标记都取它；第三方的中文描述接住。
 *   ③ 首次发现时间跟着记录走（`mergeRecords` 取最早的那次）。
 *
 * 入参的 Map 不会被修改 —— 返回新的两份，方便测试与「失败了就当没发生过」。
 *
 * @param {Map<string,object>} fresh    本轮各路来源合并后的候选
 * @param {Map<string,object>} existing 上一版索引（id → 记录）
 * @param {{records:Map<string,object>, renamed:Map<string,string>}} refresh 直读结果
 */
export function applyRepoRefresh(fresh, existing, refresh) {
  const nextFresh = new Map(fresh);
  const nextExisting = new Map(existing);

  for (const [oldId, canonical] of refresh?.renamed ?? new Map()) {
    if (oldId === canonical) continue;
    const carried = nextFresh.get(oldId) ?? nextExisting.get(oldId);
    nextFresh.delete(oldId);
    nextExisting.delete(oldId);
    if (!carried) continue;
    const base = nextFresh.get(canonical);
    nextFresh.set(canonical, base ? mergeRecords(base, carried) : carried);
  }

  for (const [id, rec] of refresh?.records ?? new Map()) {
    const base = nextFresh.get(id);
    const prev = nextExisting.get(id);
    let out = rec;                                  // 直读那份永远排第一个（最新）
    if (base) out = mergeRecords(out, base);
    if (prev) out = mergeRecords(out, prev);        // 接住中文描述、首次发现时间
    nextFresh.set(id, out);
  }

  return { fresh: nextFresh, existing: nextExisting };
}

/**
 * 观测 → 索引。
 *
 * @param {Map<string,object>} fresh
 * @param {Map<string,object>} existing
 * @param {object} options
 * @param {Set<string>}  [options.failedSources] 这一轮**整路失败**的来源
 * @param {Set<string>}  [options.ranSources]    这一轮真的跑完的来源
 * @param {Map<string,Set<string>>} [options.unseenBy]
 *   来源 → 本轮「跑了，但按排班没轮到 / 中途停下」的仓库集合。
 *   对这些仓库，该来源仍按「没跑」处理 —— 否则一次排班就会把上一轮的直读值
 *   换成第三方转述的旧值。
 * @param {boolean} [options.keepAll] `--only` 专用：其余记录根本没被看过，一律原样保留
 * @returns {{records:object[], stats:object, unseen:string[]}}
 */
export function reconcile(fresh, existing, {
  failedSources = new Set(),
  ranSources = new Set(),
  unseenBy = new Map(),
  keepAll = false,
} = {}) {
  const stamp = new Date().toISOString();
  const records = [];
  const stats = { added: 0, updated: 0, kept: 0, removed: 0, unseen: 0 };

  for (const [id, rec] of fresh) {
    const prev = existing.get(id);
    if (!prev) {
      records.push({ ...rec, firstSeenAt: rec.firstSeenAt ?? stamp, lastSyncedAt: rec.lastSyncedAt ?? stamp });
      stats.added += 1;
      continue;
    }

    /*
     * ★ 来源只会累积，不会因为「这一路这轮没跑」而被抹掉。
     *
     *   一个来源这一轮**跑过**却没产出这个仓库，说明它确实不再知道它了，
     *   去掉是对的；但这一轮**没跑**（离线、失败、没缓存、排班没轮到）时去掉，
     *   就是把「没去看」当成了「不在了」—— 索引会一轮比一轮差，且毫无提示。
     */
    const stillClaimed = (prev.sources ?? []).filter((s) => {
      if (!ranSources.has(s)) return true;
      const skipped = unseenBy.get(s);
      return Boolean(skipped && skipped.has(id));
    });
    const force = stillClaimed.length > 0 && sourceRank(prev) > sourceRank(rec);
    const merged = stillClaimed.length === 0
      ? rec
      : carryForward(
        { ...rec, sources: [...new Set([...(rec.sources ?? []), ...stillClaimed])].sort() },
        prev,
        { force },
      );

    if (contentEquals(recordContent(prev), recordContent(merged))) {
      records.push({ ...merged, firstSeenAt: prev.firstSeenAt, lastSyncedAt: prev.lastSyncedAt });
      stats.kept += 1;
    } else {
      records.push({ ...merged, firstSeenAt: prev.firstSeenAt ?? stamp, lastSyncedAt: stamp });
      stats.updated += 1;
    }
  }

  // 这一轮没被任何来源看到、但上一轮在索引里的记录
  const unseen = [];
  for (const [id, prev] of existing) {
    if (fresh.has(id)) continue;
    // ★ 产生过它的来源这一轮失败了 → 我们**没有看过**，不能当成不存在
    const sourcesFailed = (prev.sources ?? []).some((s) => failedSources.has(s));
    /*
     * ★ 「按排班没轮到」也不能算陈旧。
     *
     *   直读每轮只覆盖 1/4 的目录，而 `lastSyncedAt` 只在**内容真的变了**时才推进。
     *   如果一个项目三个月没改过任何东西，它的 lastSyncedAt 就是三个月前的 ——
     *   只看这个字段的话，它会在「这一轮没轮到」的那 3/4 轮里被判成陈旧删掉，
     *   而它六小时前才刚被直读刷过一次。所以这里还要看 unseenBy：
     *   这一轮「跑了但没轮到它」的来源，说明它仍在采集范围内，只是排班没排到。
     */
    const skippedByRotation = (prev.sources ?? []).some((s) => {
      const skipped = unseenBy.get(s);
      return Boolean(skipped && skipped.has(id));
    });
    const age = prev.lastSyncedAt ? Date.now() - Date.parse(prev.lastSyncedAt) : Infinity;
    if (keepAll || sourcesFailed || skippedByRotation || age < STALE_MS) {
      records.push(prev);
      stats.unseen += 1;
      unseen.push(id);
    } else {
      stats.removed += 1;
    }
  }

  return { records, stats, unseen };
}
