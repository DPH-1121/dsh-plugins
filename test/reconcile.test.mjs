/**
 * 对账层（scripts/lib/reconcile.mjs）。
 *
 * 这一层决定了「面板上的数字会不会自己变来变去」，所以断言围绕四个真实事故：
 *
 *   ① 某一路失败了 → 它给出的值不能因此消失（一次限流删掉几百条）
 *   ② 按排班没刷到某个仓库 → 第三方转述的旧 star 数不能把它顶掉（数字来回横跳）
 *   ③ 仓库改名 → 旧 id 的记录要并到新 id 上，而不是留下两条（一条新、一条停在旧名）
 *   ④ 内容没变 → 时间戳不能动（否则每 6 小时一次全量 diff）
 */

import { test, eq, ok, deepEq } from './harness.mjs';
import { normalizeRecord } from '../scripts/lib/catalog-format.mjs';
import { applyRepoRefresh, carryForward, reconcile } from '../scripts/lib/reconcile.mjs';

const day = 86_400_000;
const ago = (days) => new Date(Date.now() - days * day).toISOString();
const rec = (id, extra = {}) => normalizeRecord({ id, ...extra });

test('carryForward：不 force 时只补空，force 时字段级以上一轮为准', () => {
  const prev = rec('a/b', { stars: 42, language: 'TypeScript', description: '旧描述' });
  const next = rec('a/b', { stars: 0, language: null, description: null });

  const soft = carryForward(next, prev, { force: false });
  eq(soft.stars, 0, '看过的来源给出的 0 是有效信息，不该被旧值盖掉');
  eq(soft.language, 'TypeScript', '没说的字段要接住上一轮');

  const hard = carryForward(next, prev, { force: true });
  eq(hard.stars, 42, '高排名来源这一轮没看它 → 字段级以上一轮为准');
  eq(hard.description, '旧描述');
});

test('reconcile：内容没变就保持原时间戳（不产生空 diff）', () => {
  const firstSeenAt = ago(30);
  const lastSyncedAt = ago(3);
  const pushedAt = ago(2);
  const prev = rec('a/b', { stars: 5, pushedAt, sources: ['github-repo'], firstSeenAt, lastSyncedAt });
  const fresh = rec('a/b', { stars: 5, pushedAt, sources: ['github-repo'] });
  const out = reconcile(new Map([['a/b', fresh]]), new Map([['a/b', prev]]), {
    ranSources: new Set(['github-repo']),
  });
  eq(out.stats.kept, 1);
  eq(out.records[0].lastSyncedAt, lastSyncedAt, '内容没变时 lastSyncedAt 不该推进');
  eq(out.records[0].firstSeenAt, firstSeenAt);
});

test('reconcile：内容变了才推进 lastSyncedAt', () => {
  const prev = rec('a/b', { stars: 5, sources: ['github-repo'], firstSeenAt: ago(30), lastSyncedAt: ago(3) });
  const fresh = rec('a/b', { stars: 6, sources: ['github-repo'] });
  const out = reconcile(new Map([['a/b', fresh]]), new Map([['a/b', prev]]), {
    ranSources: new Set(['github-repo']),
  });
  eq(out.stats.updated, 1);
  eq(out.records[0].stars, 6);
  ok(Date.parse(out.records[0].lastSyncedAt) > Date.parse(prev.lastSyncedAt));
});

test('reconcile：来源整路失败时，它的记录原样保留', () => {
  const prev = rec('a/b', { stars: 5, sources: ['public-index'], lastSyncedAt: ago(1) });
  const out = reconcile(new Map(), new Map([['a/b', prev]]), {
    failedSources: new Set(['public-index']),
    ranSources: new Set(),
  });
  eq(out.stats.unseen, 1);
  eq(out.records.length, 1);
  eq(out.records[0].stars, 5);
});

test('reconcile：90 天没被任何来源看到才清理', () => {
  const old = rec('a/b', { sources: ['public-index'], lastSyncedAt: ago(200) });
  const recent = rec('c/d', { sources: ['public-index'], lastSyncedAt: ago(10) });
  const out = reconcile(new Map(), new Map([['a/b', old], ['c/d', recent]]), {});
  eq(out.stats.removed, 1);
  eq(out.stats.unseen, 1);
  deepEq(out.records.map((r) => r.id), ['c/d']);
});

test('★ reconcile：排班没刷到的仓库，不能被第三方旧值顶掉（数字来回横跳的回归测试）', () => {
  const prev = rec('a/b', {
    stars: 5,
    pushedAt: ago(2),                       // 直读得到的真实值
    sources: ['github-repo', 'public-index'],
    firstSeenAt: ago(30),
    lastSyncedAt: ago(1),
  });
  const stale = rec('a/b', { stars: 1, pushedAt: ago(20), sources: ['public-index'] });

  const out = reconcile(new Map([['a/b', stale]]), new Map([['a/b', prev]]), {
    ranSources: new Set(['github-repo', 'public-index']),
    // 直读这一轮「跑了，但没轮到 a/b」
    unseenBy: new Map([['github-repo', new Set(['a/b'])]]),
  });

  eq(out.records[0].stars, 5, '上一轮的直读值必须保住');
  eq(out.records[0].pushedAt, prev.pushedAt);
  ok(out.records[0].sources.includes('github-repo'), '来源标注不能被抹掉');
  eq(out.stats.kept, 1, '什么都没变，不该产生 diff');
});

test('reconcile：直读这一轮确实看过它时，以本轮结果为准', () => {
  const prev = rec('a/b', { stars: 5, sources: ['github-repo', 'public-index'], lastSyncedAt: ago(1) });
  const fresh = rec('a/b', { stars: 9, sources: ['github-repo'] });
  const out = reconcile(new Map([['a/b', fresh]]), new Map([['a/b', prev]]), {
    ranSources: new Set(['github-repo', 'public-index']),
    unseenBy: new Map([['github-repo', new Set()]]),
  });
  eq(out.records[0].stars, 9);
});

test('★ reconcile：排班没轮到的记录，不会因为「半年没改过内容」被当成陈旧删掉', () => {
  // lastSyncedAt 只在内容真的变了时推进：一个稳定项目可以几个月都是同一个值。
  // 如果只看它，这条记录会在没轮到直读的那几轮里被删掉 —— 而它六小时前刚被看过。
  const prev = rec('a/b', { stars: 5, pushedAt: ago(180), sources: ['github-repo'], lastSyncedAt: ago(180) });
  const out = reconcile(new Map(), new Map([['a/b', prev]]), {
    ranSources: new Set(['github-repo']),
    unseenBy: new Map([['github-repo', new Set(['a/b'])]]),
  });
  eq(out.stats.removed, 0);
  eq(out.stats.unseen, 1);
  eq(out.records[0].id, 'a/b');
});

test('applyRepoRefresh：改名后旧 id 并到新 id 上，不留下重复记录', () => {
  const firstSeenAt = ago(40);
  const existing = new Map([
    ['Old/Repo', rec('Old/Repo', {
      stars: 1, pushedAt: ago(20), sources: ['public-index'], descriptionZh: '中文描述',
      firstSeenAt, lastSyncedAt: ago(1),
    })],
    ['New/Repo', rec('New/Repo', {
      stars: 2, sources: ['public-index'], firstSeenAt: ago(10), lastSyncedAt: ago(1),
    })],
  ]);
  const fresh = new Map([['Old/Repo', existing.get('Old/Repo')]]);
  const refresh = {
    records: new Map([
      ['New/Repo', rec('New/Repo', { stars: 5, pushedAt: ago(0), sources: ['github-repo'], topics: ['dsh-plugin'] })],
    ]),
    renamed: new Map([['Old/Repo', 'New/Repo']]),
  };

  const out = applyRepoRefresh(fresh, existing, refresh);
  ok(!out.fresh.has('Old/Repo'), '旧 id 不能留在候选集里');
  ok(!out.existing.has('Old/Repo'), '★ 旧 id 必须从上一版索引里拿掉，否则会生成两条记录');
  eq(out.fresh.size, 1);

  const merged = out.fresh.get('New/Repo');
  eq(merged.id, 'New/Repo');
  eq(merged.stars, 5, '直读值优先于第三方转述');
  eq(merged.descriptionZh, '中文描述', '第三方的中文描述要接住');
  eq(merged.firstSeenAt, firstSeenAt, '首次发现时间跟着记录一起搬家');
  ok(merged.sources.includes('github-repo') && merged.sources.includes('public-index'));
});

test('applyRepoRefresh：没有改名时直接覆盖字段，入参不被修改', () => {
  const existing = new Map([
    ['a/b', rec('a/b', { stars: 1, pushedAt: ago(20), sources: ['public-index'], descriptionZh: '中文' })],
  ]);
  const fresh = new Map([['a/b', existing.get('a/b')]]);
  const refresh = {
    records: new Map([['a/b', rec('a/b', { stars: 7, pushedAt: ago(1), sources: ['github-repo'] })]]),
    renamed: new Map(),
  };

  const out = applyRepoRefresh(fresh, existing, refresh);
  eq(out.fresh.get('a/b').stars, 7);
  eq(out.fresh.get('a/b').descriptionZh, '中文');
  eq(fresh.get('a/b').stars, 1, '原 Map 不能被就地改写');
  eq(existing.get('a/b').stars, 1);
});
