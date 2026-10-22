/**
 * 对着**仓库里真实的数据**跑一遍自洽校验。
 *
 * 这一组测试的价值在于：它是唯一会碰到「实际采集出来的那份索引」的测试。
 * 别的测试都在构造样例数据，而真实数据里才会出现重复 id、顺序错乱、
 * 快照与索引不同步这类问题。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test, eq, ok } from './harness.mjs';
import { SOURCE_LABELS } from '../scripts/lib/catalog-format.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'catalog', 'index.json');
const SNAPSHOT = path.join(ROOT, 'catalog', 'snapshot.json');

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function runCheck() {
  return execFileSync(process.execPath, [path.join('scripts', 'collect.mjs'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('索引与包内快照都存在', () => {
  ok(fs.existsSync(INDEX), 'catalog/index.json 必须存在（面板的数据源）');
  ok(fs.existsSync(SNAPSHOT), 'catalog/snapshot.json 必须存在（没网时的兜底）');
});

test('collect --check 通过（索引自洽 + 快照是稳定投影）', () => {
  const out = runCheck();
  ok(out.includes('完成'), `--check 的输出看起来不对：\n${out}`);
});

test('★ --check 必须是只读的（它曾经删掉过 7482 个文件）', () => {
  // 这个断言来自一次真实事故：--check 的早退分支曾经被写进一个不再被调用的函数里，
  // 入口直接走到了联网采集那条路，把当时的目录文件删了一大片，然后 exit 0。
  // 断言比注释可靠：跑完校验，工作区必须一个字节都没变。
  const before = [INDEX, SNAPSHOT].map(sha);
  runCheck();
  const after = [INDEX, SNAPSHOT].map(sha);
  eq(after.join(), before.join(), '--check 改动了工作区');
});

test('索引里的每一条都能通过归一化（id 是 owner/repo 形状）', async () => {
  const { normalizeRecord } = await import('../scripts/lib/catalog-format.mjs');
  const doc = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const bad = [];
  for (const rec of doc.plugins) {
    const norm = normalizeRecord(rec);
    if (!norm || norm.id !== rec.id) bad.push(rec.id);
  }
  eq(bad.length, 0, `这些记录的 id 不合法：${bad.slice(0, 5).join('、')}`);
});

test('索引不是空的，且大部分记录有描述与 star 数', () => {
  const doc = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  ok(doc.plugins.length > 500, `索引只有 ${doc.plugins.length} 条，采集面看起来不对`);
  const withDesc = doc.plugins.filter((p) => p.description || p.descriptionZh).length;
  const withStars = doc.plugins.filter((p) => typeof p.stars === 'number').length;
  ok(withDesc / doc.plugins.length > 0.8, `只有 ${withDesc}/${doc.plugins.length} 条有描述`);
  ok(withStars / doc.plugins.length > 0.8, `只有 ${withStars}/${doc.plugins.length} 条有 star 数`);
});

test('索引里没有重复仓库，且每条都有可用的仓库地址', () => {
  const doc = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const seen = new Set();
  const dup = [];
  for (const p of doc.plugins) {
    if (seen.has(p.id)) dup.push(p.id);
    seen.add(p.id);
  }
  eq(dup.length, 0, `重复：${dup.slice(0, 5).join('、')}`);
  ok(doc.plugins.every((p) => p.url === `https://github.com/${p.id}`), 'url 必须能由 id 直接推出');
});

test('来源标记只能是已知的四个值（写错一个字母，排班就把这条记录当成没看过）', () => {
  const doc = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const known = new Set(Object.keys(SOURCE_LABELS));
  const bad = [];
  for (const p of doc.plugins) {
    for (const s of p.sources ?? []) if (!known.has(s)) bad.push(`${p.id} → ${s}`);
  }
  eq(bad.length, 0, `未知来源：${bad.slice(0, 5).join('、')}`);

  // 直读是 star 数与最近推送的唯一权威来源：它一旦整路失灵，索引里应该看得出来
  const covered = doc.plugins.filter((p) => (p.sources ?? []).includes('github-repo')).length;
  ok(covered > 0, '没有任何记录带 github-repo —— 直读这一路根本没跑');
});

test('每条记录的时间戳都是 ISO，star 是非负整数', () => {
  const doc = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const bad = [];
  for (const p of doc.plugins) {
    if (p.stars !== null && (!Number.isInteger(p.stars) || p.stars < 0)) bad.push(`${p.id} stars=${p.stars}`);
    if (p.pushedAt !== null && Number.isNaN(Date.parse(p.pushedAt))) bad.push(`${p.id} pushedAt=${p.pushedAt}`);
  }
  eq(bad.length, 0, `字段类型不对：${bad.slice(0, 5).join('、')}`);
});

test('包内快照的体积受控（它是随包安装的，不能无限长）', () => {
  const size = fs.statSync(SNAPSHOT).size;
  // 上限与 .github/workflows/verify.yml 一致（16MB）：这是数据文件的上限，
  // 不是发给浏览器的 payload —— 面板拿到的是服务器半裁过的列式投影。
  ok(size < 16_000_000, `快照 ${size} 字节，太大了 —— 它会被打进插件包`);
  const doc = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  eq(doc.plugins.length, index.plugins.length, '快照必须包含完整目录');
  ok(doc.plugins.every((p) => p.firstSeenAt === null && p.lastSyncedAt === null), '快照里的登记性字段必须为空');
});
