/**
 * GitHub 传输层（scripts/lib/github.mjs）的 GraphQL 部分。
 *
 * 这一层坏了的症状特别隐蔽：**索引照常生成**，只是 star 数与最近推送
 * 停在很久以前 —— 没有任何报错，面板也不会白屏，只有人眼对着 GitHub 页面
 * 才发现对不上。所以下面的断言集中在三件事上：
 *
 *   ① 查询拼得对（别名与负责的仓库一一对应，字符串转义正确）
 *   ② 响应解析得对（「没有这个仓库」与「这批查询坏了」必须分开）
 *   ③ 配额用尽时不假装成功（返回 failed，让调用方保留上一轮的值）
 */

import { test, eq, ok, includes, deepEq } from './harness.mjs';
import {
  buildRepositoryBatchQuery, fetchRepositoryBatch, parseRepositoryBatch,
} from '../scripts/lib/github.mjs';

/** 最小的假 Response：只实现传输层用到的那几个成员 */
function fakeResponse(payload, { status = 200, headers = {} } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    json: async () => payload,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

const ids = ['a/one', 'b/two'];

test('buildRepositoryBatchQuery：一个仓库一个别名，字符串正确转义', () => {
  const query = buildRepositoryBatchQuery(ids);
  includes(query, 'r0: repository(owner: "a", name: "one")');
  includes(query, 'r1: repository(owner: "b", name: "two")');
  includes(query, 'nameWithOwner');
  includes(query, 'stargazerCount');
  includes(query, 'repositoryTopics(first: 20)');
  ok(!query.includes('undefined'), '拼接出来的query里不该出现 undefined');
  // 别名用下标：解析时靠同一个下标对回去，所以顺序必须与入参一致
  ok(query.indexOf('r0:') < query.indexOf('r1:'));
});

test('buildRepositoryBatchQuery：不像 owner/repo 的输入会被跳过，不会拼出坏语句', () => {
  const query = buildRepositoryBatchQuery(['', 'no-slash', 'a/b']);
  includes(query, 'r2: repository(owner: "a", name: "b")');
  ok(!query.includes('r0:') && !query.includes('r1:'), '无效输入不该产生别名');
});

test('parseRepositoryBatch：有数据 / 明确不存在 / 其它错误，三种情况必须分开', () => {
  const payload = {
    data: {
      r0: { nameWithOwner: 'a/one', stargazerCount: 5 },
      r1: null,
      r2: null,
    },
    errors: [
      { type: 'NOT_FOUND', path: ['r1'], message: 'Could not resolve' },
      { type: 'RESOURCE_LIMITS', path: ['r2'], message: 'Resource limits exceeded' },
    ],
  };
  const parsed = parseRepositoryBatch(payload, ['a/one', 'b/two', 'c/three']);
  eq(parsed.nodes.get('a/one').stargazerCount, 5);
  ok(parsed.missing.has('b/two'), 'GitHub 明确说不存在的要记进 missing');
  ok(!parsed.missing.has('c/three'), '「资源限制」不是「不存在」—— 记成 missing 会让记录下一轮消失');
  eq(parsed.failed, true, '有非 NOT_FOUND 错误时整批标记为不完整');
  includes(parsed.error, 'RESOURCE_LIMITS');
});

test('parseRepositoryBatch：整份 data 缺失时不能把全部仓库判成「不存在」', () => {
  const parsed = parseRepositoryBatch({ data: null, errors: [{ type: 'FORBIDDEN', message: 'nope' }] }, ids);
  eq(parsed.nodes.size, 0);
  eq(parsed.missing.size, 0, '★ 一次接口故障不能等于「这些仓库都被删了」');
  eq(parsed.failed, true);
});

test('fetchRepositoryBatch：没有 token 时如实跳过（GraphQL 不支持匿名）', async () => {
  const res = await fetchRepositoryBatch(ids, { token: null });
  eq(res.failed, true);
  includes(res.error, 'token');
  eq(res.nodes.size, 0);
});

test('fetchRepositoryBatch：正常一批 → 逐仓库结果 + 配额信息', async () => {
  const seen = [];
  const res = await fetchRepositoryBatch(ids, {
    token: 'test-token',
    fetchImpl: async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
      return fakeResponse({
        data: {
          r0: { nameWithOwner: 'DPH-1121/renamed', stargazerCount: 5 },
          r1: { nameWithOwner: 'b/two', stargazerCount: 0 },
        },
      }, { headers: { 'x-ratelimit-limit': 5000, 'x-ratelimit-remaining': 4800 } });
    },
  });
  eq(seen.length, 1);
  includes(seen[0].url, '/graphql');
  eq(seen[0].auth, 'Bearer test-token');
  includes(seen[0].body.query, 'r0: repository');
  eq(res.failed, false);
  eq(res.nodes.get('a/one').nameWithOwner, 'DPH-1121/renamed', '★ 改名信息必须原样带回来');
  eq(res.rateLimit.remaining, 4800);
  eq(res.rateLimited, false);
});

test('fetchRepositoryBatch：主配额耗尽（403 + remaining=0）→ 立即失败，不空等', async () => {
  const started = Date.now();
  const res = await fetchRepositoryBatch(ids, {
    token: 'test-token',
    fetchImpl: async () => fakeResponse({ message: 'API rate limit exceeded' }, {
      status: 403,
      headers: { 'x-ratelimit-limit': 1000, 'x-ratelimit-remaining': 0, 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) },
    }),
  });
  eq(res.rateLimited, true);
  eq(res.failed, true);
  ok(Date.now() - started < 1000, '配额耗尽时不该等待 —— CI 一轮只有 45 分钟');
});

test('fetchRepositoryBatch：200 + errors[].type=RATE_LIMITED 也算配额用尽', async () => {
  const res = await fetchRepositoryBatch(ids, {
    token: 'test-token',
    fetchImpl: async () => fakeResponse({
      data: { r0: null, r1: null },
      errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
    }, { headers: { 'x-ratelimit-limit': 1000, 'x-ratelimit-remaining': 0 } }),
  });
  eq(res.rateLimited, true);
  eq(res.failed, true);
});

test('fetchRepositoryBatch：非 JSON 响应（例如 GitHub 回了 HTML）→ 失败而不是崩掉', async () => {
  const res = await fetchRepositoryBatch(ids, {
    token: 'test-token',
    maxAttempts: 1,
    fetchImpl: async () => {
      const r = fakeResponse('<html>502</html>', { status: 200 });
      r.json = async () => { throw new Error('Unexpected token <'); };
      return r;
    },
  });
  eq(res.failed, true);
  includes(res.error, 'JSON');
});

test('fetchRepositoryBatch：5xx 会重试，重试次数用尽才报错', async () => {
  let calls = 0;
  const res = await fetchRepositoryBatch(ids, {
    token: 'test-token',
    maxAttempts: 2,
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse('boom', { status: 503 });
    },
  });
  eq(calls, 2);
  eq(res.failed, true);
  includes(res.error, '503');
});
