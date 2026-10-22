/**
 * 采集格式层（scripts/lib/catalog-format.mjs）。
 *
 * 这一层坏了的症状特别隐蔽：界面照常工作，只是索引每 6 小时产生一次全量 diff。
 * 所以下面的测试重点是**确定性**与**稳定投影**两个性质。
 */

import { test, eq, ok, deepEq } from './harness.mjs';
import {
  buildIndex, buildSnapshot, contentEquals, indexContent, mergeRecords,
  normalizeGraphqlRepo, normalizeRecord, recordContent, serializeIndex, sortRecords, toRepoId,
} from '../scripts/lib/catalog-format.mjs';

test('toRepoId：各种写法都能归一，不合法的一律返回 null', () => {
  eq(toRepoId('https://github.com/a/b'), 'a/b');
  eq(toRepoId('http://github.com/a/b.git'), 'a/b');
  eq(toRepoId('github:a/b'), 'a/b');
  eq(toRepoId('a/b'), 'a/b');
  eq(toRepoId('https://github.com/a/b/tree/main/packages/c'), 'a/b');
  eq(toRepoId('git@github.com:a/b.git'), null);      // 这个形状我们不猜
  eq(toRepoId('https://gitlab.com/a/b'), null);      // 只收 GitHub
  eq(toRepoId(''), null);
  eq(toRepoId(null), null);
  eq(toRepoId('just-a-name'), null);
});

test('normalizeRecord：字段归一 + 键顺序固定', () => {
  const rec = normalizeRecord({
    id: 'https://github.com/Owner/Repo',
    description: '  hello   world  ',
    stars: '42',
    forks: -3,
    topics: ['Zeta', 'alpha', 'alpha', ''],
    pushed_at: '2026-09-26T15:42:06Z',
    archived: 'yes',
  });
  eq(rec.id, 'Owner/Repo', '仓库名保持原大小写（GitHub 的 id 是大小写不敏感的，但展示要原样）');
  eq(rec.url, 'https://github.com/Owner/Repo');
  eq(rec.description, 'hello world', '空白折叠');
  eq(rec.stars, 42, '字符串数字要转成数字');
  eq(rec.forks, null, '负数不当成 fork 数');
  deepEq(rec.topics, ['alpha', 'zeta'], 'topic 去重 + 小写 + 排序');
  eq(rec.pushedAt, '2026-09-26T15:42:06.000Z', '时间统一成 ISO');
  eq(rec.archived, false, '只有真正的 true 才算归档');
  deepEq(Object.keys(rec), [
    'id', 'owner', 'name', 'url', 'description', 'descriptionZh', 'author',
    'stars', 'forks', 'language', 'topics', 'license', 'homepage',
    'pushedAt', 'archived', 'sources', 'firstSeenAt', 'lastSyncedAt',
  ], '键顺序是序列化确定性的一部分，改动等于让整份索引重排');
});

test('normalizeGraphqlRepo：GraphQL 节点 → 规范记录（含改名要用的 nameWithOwner）', () => {
  const rec = normalizeGraphqlRepo({
    nameWithOwner: 'NewOwner/Repo',
    stargazerCount: 7,
    forkCount: 2,
    description: '  hello   world  ',
    primaryLanguage: { name: 'TypeScript' },
    repositoryTopics: {
      nodes: [{ topic: { name: 'Dsh-Plugin' } }, { topic: null }, { topic: { name: '' } }],
    },
    licenseInfo: { spdxId: 'MIT' },
    homepageUrl: 'https://example.com',
    pushedAt: '2026-10-19T06:46:08Z',
    isArchived: true,
  });
  eq(rec.id, 'NewOwner/Repo', '★ 必须用 nameWithOwner：改名后只有它知道仓库现在叫什么');
  eq(rec.stars, 7);
  eq(rec.forks, 2);
  eq(rec.description, 'hello world');
  eq(rec.language, 'TypeScript');
  deepEq(rec.topics, ['dsh-plugin']);
  eq(rec.license, 'MIT');
  eq(rec.homepage, 'https://example.com');
  eq(rec.pushedAt, '2026-10-19T06:46:08.000Z');
  eq(rec.archived, true);
  deepEq(rec.sources, ['github-repo']);

  eq(normalizeGraphqlRepo({ nameWithOwner: 'a/b', licenseInfo: { spdxId: 'NOASSERTION' } }).license, null,
    'NOASSERTION 表示「有许可文件但认不出来」，不是 SPDX 标识');
  eq(normalizeGraphqlRepo({ stargazerCount: 1 }), null, '没有 nameWithOwner 就不是一个仓库');
  eq(normalizeGraphqlRepo(null), null);
});

test('mergeRecords：来源排名高的采信，sources 取并集', () => {
  const indexRec = normalizeRecord({
    id: 'a/b', description: '第三方转述', stars: 1, sources: ['public-index'], firstSeenAt: '2026-01-01T00:00:00Z',
  });
  const searchRec = normalizeRecord({
    id: 'a/b', description: '直读仓库', stars: 99, license: 'MIT', sources: ['github-search'], firstSeenAt: '2026-02-01T00:00:00Z',
  });
  const merged = mergeRecords(indexRec, searchRec);
  eq(merged.description, '直读仓库', 'GitHub 搜索的排名更高');
  eq(merged.stars, 99);
  eq(merged.license, 'MIT', '排名低的那一侧有值也要接住');
  deepEq(merged.sources, ['github-search', 'public-index']);
  eq(merged.firstSeenAt, '2026-01-01T00:00:00.000Z', '首次发现时间取最早的');
});

test('sortRecords：star 降序 → id 升序，且不改动入参', () => {
  const rows = [
    normalizeRecord({ id: 'b/x', stars: 5 }),
    normalizeRecord({ id: 'a/y', stars: 5 }),
    normalizeRecord({ id: 'c/z', stars: null }),
    normalizeRecord({ id: 'd/w', stars: 50 }),
  ];
  const sorted = sortRecords(rows);
  deepEq(sorted.map((r) => r.id), ['d/w', 'a/y', 'b/x', 'c/z']);
  deepEq(rows.map((r) => r.id), ['b/x', 'a/y', 'c/z', 'd/w'], '原数组不能被排序');
});

test('recordContent：登记性时间戳不进内容比较', () => {
  const a = normalizeRecord({ id: 'a/b', stars: 1, firstSeenAt: '2026-01-01T00:00:00Z', lastSyncedAt: '2026-01-01T00:00:00Z' });
  const b = normalizeRecord({ id: 'a/b', stars: 1, firstSeenAt: '2026-01-01T00:00:00Z', lastSyncedAt: '2026-09-01T00:00:00Z' });
  ok(contentEquals(recordContent(a), recordContent(b)), '只是「什么时候看到的」变了，不算内容变化');
  const c = normalizeRecord({ id: 'a/b', stars: 2, lastSyncedAt: '2026-09-01T00:00:00Z' });
  ok(!contentEquals(recordContent(a), recordContent(c)), 'star 变了就是内容变了');
});

test('serializeIndex：一条记录一行，且能原样往返', () => {
  const index = buildIndex([
    normalizeRecord({ id: 'a/b', description: 'x', stars: 2 }),
    normalizeRecord({ id: 'c/d', stars: 1 }),
  ], { generatedAt: '2026-09-27T00:00:00.000Z', sources: [] });
  const text = serializeIndex(index);
  eq(text.split('\n').filter((l) => l.trim().startsWith('{"id"')).length, 2, '每条记录占一行');
  deepEq(JSON.parse(text), index, '反序列化必须得到同一份数据');
  eq(serializeIndex(JSON.parse(text)), text, '再序列化一次必须逐字节相同（确定性）');
});

test('buildSnapshot：是索引的稳定投影 —— 时间戳清空、star 头部、条数受限', () => {
  const records = [];
  for (let i = 0; i < 500; i += 1) {
    records.push(normalizeRecord({
      id: `o/r${String(i).padStart(3, '0')}`,
      stars: i,
      firstSeenAt: '2026-01-01T00:00:00Z',
      lastSyncedAt: '2026-09-01T00:00:00Z',
    }));
  }
  const index = buildIndex(records, { generatedAt: '2026-09-27T00:00:00Z', sources: [] });
  const snap = buildSnapshot(index, { size: 10 });
  eq(buildSnapshot(index).plugins.length, 500, '默认快照必须保留所有项目');
  eq(snap.plugins.length, 10);
  eq(snap.plugins[0].id, 'o/r499', '取 star 最高的');
  eq(snap.generatedAt, null, '登记性时间戳必须清空');
  ok(snap.plugins.every((p) => p.firstSeenAt === null && p.lastSyncedAt === null));

  // ★ 稳定投影的意义：索引里只有「什么时候查的」变了时，快照必须逐字节不变 ——
  //   否则每 6 小时一次的采集都会改到插件包，而包内容变了版本号没变，
  //   装过的人收不到更新，git 里却天天多一个 diff。
  const touched = buildIndex(
    index.plugins.map((p) => ({ ...p, lastSyncedAt: '2026-09-28T00:00:00Z' })),
    { generatedAt: '2026-09-28T00:00:00Z', sources: [] },
  );
  eq(serializeIndex(buildSnapshot(touched, { size: 10 })), serializeIndex(snap), '只有时间戳变化时快照必须不变');

  // 反过来：内容真的变了，快照必须跟着变
  const changed = buildIndex(
    index.plugins.map((p) => (p.id === 'o/r499' ? { ...p, stars: 100000 } : p)),
    { generatedAt: '2026-09-28T00:00:00Z', sources: [] },
  );
  ok(serializeIndex(buildSnapshot(changed, { size: 10 })) !== serializeIndex(snap), '内容变了快照要跟着变');
});

test('indexContent：忽略时间戳，只比较内容', () => {
  const a = buildIndex([normalizeRecord({ id: 'a/b', stars: 1, lastSyncedAt: '2026-01-01T00:00:00Z' })], { generatedAt: '2026-01-01T00:00:00Z' });
  const b = buildIndex([normalizeRecord({ id: 'a/b', stars: 1, lastSyncedAt: '2026-06-01T00:00:00Z' })], { generatedAt: '2026-06-01T00:00:00Z' });
  ok(contentEquals(indexContent(a), indexContent(b)), 'generatedAt 与 lastSyncedAt 都不算内容');
});
