/**
 * 直读排班（scripts/lib/refresh.mjs）。
 *
 * 默认是「每轮全刷」（配额够），排班只在目录长大或配额紧张时才用。
 * 所以这里的断言分两组：
 *
 *   ① 默认行为：队列 = 整份目录（每条记录每轮都会被刷到）
 *   ② 分片行为：N 个时间窗合起来 = 整份目录，不重不漏；新增 / 手工收录当轮必刷
 */

import { test, eq, ok, deepEq, includes } from './harness.mjs';
import {
  REFRESH_MIN_POINTS, REFRESH_ROTATION, REFRESH_WINDOW_MS, describeRefreshQueue, planRefreshQueue,
} from '../scripts/lib/refresh.mjs';

const ids = Array.from({ length: 37 }, (_, i) => `owner${String(i).padStart(2, '0')}/repo`);
const ROTATION = 4;

test('默认不分片：每轮都刷整份目录（一条记录最多滞后一个采集周期）', () => {
  eq(REFRESH_ROTATION, 1);
  deepEq(planRefreshQueue(ids, { now: 123 }), ids);
});

test('planRefreshQueue：明确分片时，N 个窗口合起来正好覆盖整份目录', () => {
  const seen = new Map();
  for (let bucket = 0; bucket < ROTATION; bucket += 1) {
    const queue = planRefreshQueue(ids, { now: bucket * REFRESH_WINDOW_MS + 1, rotation: ROTATION });
    ok(queue.length < ids.length, '分片后每轮只该刷一部分');
    for (const id of queue) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  eq(seen.size, ids.length, '有记录没被任何窗口排到 —— 那些记录会一直停在旧数据');
  for (const [id, times] of seen) eq(times, 1, `${id} 被排了 ${times} 次 —— 切片重叠会浪费配额`);
});

test('planRefreshQueue：同一个窗口内多次运行结果相同（不需要落盘游标）', () => {
  const now = 3 * REFRESH_WINDOW_MS + 5;
  deepEq(
    planRefreshQueue(ids, { now, rotation: ROTATION }),
    planRefreshQueue([...ids].reverse(), { now, rotation: ROTATION }),
  );
});

test('planRefreshQueue：新增 / 手工收录的仓库当轮必刷，且排在最前', () => {
  const priority = ['owner05/repo', 'brand-new/repo'];
  const all = [...ids, 'brand-new/repo'];
  for (const rotation of [1, ROTATION]) {
    const queue = planRefreshQueue(all, { now: 0, rotation, priority });
    eq(queue[0], 'owner05/repo');
    eq(queue[1], 'brand-new/repo');
    ok(queue.includes('brand-new/repo'), '新仓库不能被分片排到下一轮');
    eq(new Set(queue).size, queue.length, '队列里不能有重复');
  }
});

test('planRefreshQueue：空目录不会崩', () => {
  deepEq(planRefreshQueue([], { now: 0 }), []);
});

test('describeRefreshQueue：说清楚「本轮刷多少、总共多少」', () => {
  includes(describeRefreshQueue(new Array(10).fill('x'), 40, { rotation: ROTATION }), '10/40');
  includes(describeRefreshQueue(new Array(3).fill('x'), 3, { rotation: 1 }), '全部 3 条');
  includes(describeRefreshQueue([], 0), '没有');
});

test('配额的保险线是一个正数（低于它就收手，留给重试与下一轮）', () => {
  ok(REFRESH_MIN_POINTS > 0 && REFRESH_MIN_POINTS < 1000);
});
