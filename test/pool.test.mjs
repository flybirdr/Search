/**
 * Worker 线程池端到端测试：起真实 worker_threads（dist/searchWorker.js），
 * 在临时目录上跑完整扫描，覆盖字节直传、GBK/UTF-16 转码、流式大文件、
 * 二进制与超大文件分类、以及取消广播。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const { runWorkerSearch } = await import(
  pathToFileURL(path.join(root, 'test', '.tmp', 'workerPool.mjs')).href
);

const WASM = path.join(root, 'media', 'core.wasm');
const WORKER = path.join(root, 'dist', 'searchWorker.js');
const iconv = require('iconv-lite');

// ---------------------------------------------------------------- 临时工作区
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-pool-'));
const files = {};
files['a.txt'] = 'const token = 1;\nconst again = token;\nno hit here\n';
files['b.txt'] = 'nothing relevant\n';
files['gb.txt'] = iconv.encode('这里有一处 token 藏在中文里\n', 'gbk');
// UTF-16LE + BOM：命中列按 UTF-16 码元换算
const u16Text = 'unicode token here\n';
const u16Buf = Buffer.alloc(2 + u16Text.length * 2);
u16Buf.write('\xff\xfe', 0, 'binary');
u16Buf.write(u16Text, 2, 'utf16le');
files['u16.txt'] = u16Buf;
files['bin.bin'] = Buffer.from([0x00, 0x01, 0x74, 0x6f, 0x6b, 0x65, 0x6e]);
// 孤立 \r：VS Code 当作换行，行号必须按它的口径（logcat 回归）
files['cr.txt'] = 'head\rtoken after CR\r\ntail\n';
// 越过 streamAbove（下面设 2KB）→ 走流式分支
const streamLines = Array.from({ length: 400 }, (_, i) => (i % 50 === 0 ? `token line ${i}` : `filler ${i}`));
files['big.txt'] = streamLines.join('\n') + '\n';
// 越过 maxBytes（下面设 100KB）→ tooLarge
files['huge.txt'] = 'token\n'.repeat(30000);

const fileList = [];
for (const [name, content] of Object.entries(files)) {
  const full = path.join(ws, name);
  fs.writeFileSync(full, content);
  fileList.push(full);
}

const OPTIONS = {
  query: 'token',
  mode: 'normal',
  caseSensitive: false,
  wholeWord: false,
  dotAll: false,
  backtrackLimit: 1000000,
};
const LIMITS = { perFileLimit: 2000, maxBytes: 100 * 1024, streamAbove: 2 * 1024 };

async function scan(fileListOverride, overrides = {}) {
  const batches = [];
  const chosen = fileListOverride ?? fileList;
  const outcome = await runWorkerSearch({
    wasmPath: WASM,
    workerScript: WORKER,
    workerCount: 2,
    // 0.1.65 起派发文件带全局下标（宿主可扣掉缓存命中的子集）
    files: chosen.map((p, index) => ({ path: p, index })),
    options: OPTIONS,
    ...LIMITS,
    shouldAbort: () => false,
    onBatch: (results) => batches.push(...results),
    ...overrides,
  });
  return { outcome, results: batches };
}

const byName = (results, name) => {
  const index = fileList.indexOf(path.join(ws, name));
  return results.find((result) => result.index === index);
};

test('线程池整读路径：命中行/列/预览与宿主路径一致', async () => {
  const { outcome, results } = await scan();
  assert.equal(outcome.kind, 'ok');

  const a = byName(results, 'a.txt');
  assert.equal(a.kind, 'hit');
  assert.equal(a.hits.length, 2, 'a.txt 两处 token');
  assert.deepEqual([a.hits[0].line, a.hits[0].column], [0, 6], '第 1 行第 6 列（0 基）');
  assert.deepEqual([a.hits[1].line, a.hits[1].column], [1, 14], '第 2 行第 14 列');
  assert.equal(a.hits[0].preview, 'const token = 1;');
  assert.equal(a.hits[0].prefix, 6, '命中在预览里的起始下标');
  assert.equal(a.hits[0].matchLen, 5);

  assert.equal(byName(results, 'b.txt').kind, 'miss');
  assert.equal(byName(results, 'bin.bin').kind, 'binary');
  assert.equal(byName(results, 'huge.txt').kind, 'tooLarge', '超过 maxBytes 的文件被跳过并带尺寸');
  assert.ok(byName(results, 'huge.txt').size > 100 * 1024);
});

test('GBK / UTF-16LE 转码后命中，列号按 UTF-16 码元', async () => {
  const { outcome, results } = await scan();
  assert.equal(outcome.kind, 'ok');

  const gb = byName(results, 'gb.txt');
  assert.equal(gb.kind, 'hit', 'GBK 文件转码后应命中');
  assert.deepEqual([gb.hits[0].line, gb.hits[0].column], [0, 6]);
  assert.ok(gb.hits[0].preview.includes('token'), '预览解码自转码后的字节');

  const u16 = byName(results, 'u16.txt');
  assert.equal(u16.kind, 'hit', 'UTF-16LE BOM 文件应命中');
  assert.deepEqual([u16.hits[0].line, u16.hits[0].column], [0, 8]);
});

test('大文件走流式分支，命中行号跨块正确', async () => {
  const { outcome, results } = await scan();
  assert.equal(outcome.kind, 'ok');

  const big = byName(results, 'big.txt');
  assert.equal(big.kind, 'hit');
  assert.equal(big.hits.length, 8, '400 行里 i%50===0 共 8 处');
  // 第一个命中在第 0 行；最后一个在第 350 行
  assert.deepEqual([big.hits[0].line, big.hits[0].column], [0, 0]);
  assert.equal(big.hits[big.hits.length - 1].line, 350);
  assert.equal(big.hits[7].preview, 'token line 350');
});

test('孤立 \\r 的文件：行号按 VS Code 语义（\\r 也算换行）', async () => {
  const { outcome, results } = await scan();
  assert.equal(outcome.kind, 'ok');

  const cr = byName(results, 'cr.txt');
  assert.equal(cr.kind, 'hit');
  assert.deepEqual([cr.hits[0].line, cr.hits[0].column], [1, 0], 'token 在 VS Code 的第 2 行行首，不是第 1 行');
  assert.equal(cr.hits[0].preview, 'token after CR');
});

test('取消广播：worker 提前收工，结局仍是 ok', async () => {
  const { outcome } = await scan(undefined, {
    shouldAbort: () => true,
    onBatch: () => undefined,
  });
  assert.equal(outcome.kind, 'ok', '取消不算失败，截断由调用方判断');
});

test('worker 脚本缺失时报 initFailed（调用方据此回退宿主内扫描）', async () => {
  const { outcome } = await scan(undefined, {
    workerScript: path.join(ws, 'no-such-worker.js'),
  });
  assert.equal(outcome.kind, 'initFailed');
  assert.ok(outcome.error.length > 0);
});

test('常驻池跨轮复用：连续两轮结果一致，换 workerCount 也能跑', async () => {
  // 共享池让 worker 跨搜索存活；这里验证复用后扫描状态干净
  // （abort 标志复位、wasm 暂存区跨轮复用不串数据）。
  const first = await scan();
  assert.equal(first.outcome.kind, 'ok');
  const second = await scan();
  assert.equal(second.outcome.kind, 'ok');
  assert.equal(
    JSON.stringify(collectKinds(first.results)),
    JSON.stringify(collectKinds(second.results)),
    '两轮逐文件分类必须一致',
  );

  // 换 workerCount：池子按需补建/闲置，语义不变
  const one = await scan(undefined, { workerCount: 1 });
  assert.equal(one.outcome.kind, 'ok');
  assert.equal(
    JSON.stringify(collectKinds(one.results)),
    JSON.stringify(collectKinds(first.results)),
    '单 worker 结果一致',
  );
});

function collectKinds(results) {
  return results
    .map((r) => `${r.index}:${r.kind}`)
    .sort()
    .join(',');
}

test('池子随 workerCount 收缩：调小并发后多余 worker 退役（0.1.62）', async () => {
  const { sharedPoolSize } = await import(
    pathToFileURL(path.join(root, 'test', '.tmp', 'workerPool.mjs')).href
  );
  // 7 个文件足够按 4 个并发分片；先扩张再收缩
  const four = await scan(undefined, { workerCount: 4 });
  assert.equal(four.outcome.kind, 'ok');
  assert.equal(sharedPoolSize(), 4, '按 4 并发建 4 个常驻 worker');
  const two = await scan(undefined, { workerCount: 2 });
  assert.equal(two.outcome.kind, 'ok');
  assert.equal(sharedPoolSize(), 2, '并发调小后池子必须收缩，旧 worker 不能滞留占内存');
  const one = await scan(undefined, { workerCount: 1 });
  assert.equal(one.outcome.kind, 'ok');
  assert.equal(sharedPoolSize(), 1, '收缩到 1');
});

test('work-stealing：50 文件 × 3 worker，结果不重不漏覆盖全部下标（0.1.64）', async () => {
  // 50 个文件 > 初始 want(24)，必然触发多轮取活；校验 stealing 不丢不重
  const manyWs = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-steal-'));
  const manyFiles = [];
  for (let i = 0; i < 50; i += 1) {
    const full = path.join(manyWs, `f${i}.txt`);
    fs.writeFileSync(full, `file ${i} has token here\n`);
    manyFiles.push(full);
  }
  const seen = new Map();
  const { outcome } = await scan(manyFiles, {
    workerCount: 3,
    onBatch: (results) => {
      for (const r of results) {
        assert.ok(!seen.has(r.index), `下标 ${r.index} 出现两次：stealing 派重了`);
        seen.set(r.index, r);
      }
    },
  });
  assert.equal(outcome.kind, 'ok');
  assert.equal(seen.size, 50, '50 个文件必须全部扫描');
  for (let i = 0; i < 50; i += 1) {
    const r = seen.get(i);
    assert.equal(r.kind, 'hit');
    assert.match(r.hits[0].preview, new RegExp(`file ${i} `), '结果内容与下标对应');
  }
});

test('work-stealing：文件数少于 worker 数，多余 worker 走 drain 收工（0.1.64）', async () => {
  const two = fileList.slice(0, 2);
  const got = [];
  const { outcome } = await scan(two, {
    workerCount: 4,
    onBatch: (results) => got.push(...results),
  });
  assert.equal(outcome.kind, 'ok');
  assert.equal(got.length, 2, '只有 2 个文件、各 1 个结果');
  const idxs = new Set(got.map((r) => r.index));
  assert.ok(idxs.has(0) && idxs.has(1), '全局下标 0/1 都在');
});

test('check 校验：命中下标只回报 stat，数值与 fs.statSync 一致（0.1.69）', async () => {
  const chosen = fileList.slice(0, 3);
  const { outcome, results } = await scan(chosen, { check: [0, 1, 2] });
  assert.equal(outcome.kind, 'ok');
  assert.equal(results.length, 3, '每个文件一条 stat 结果');
  for (const r of results) {
    assert.equal(r.kind, 'stat');
    const st = fs.statSync(chosen[r.index]);
    assert.equal(r.stat.size, st.size);
    assert.equal(r.stat.mtimeMs, st.mtimeMs);
    assert.ok(!('hits' in r) && !('bytesRead' in r), 'stat 结果不带扫描数据');
  }
});

test('check 校验：混合场次——校验文件回报 stat，其余文件正常扫描（0.1.69）', async () => {
  const chosen = fileList.slice(0, 4);
  const { outcome, results } = await scan(chosen, { check: [1] });
  assert.equal(outcome.kind, 'ok');
  const statRes = results.filter((r) => r.kind === 'stat');
  const scanRes = results.filter((r) => r.kind !== 'stat');
  assert.equal(statRes.length, 1, '只有 check 集合里的文件回报 stat');
  assert.equal(statRes[0].index, 1);
  assert.equal(scanRes.length, 3, '其余 3 个文件正常扫描');
  for (const r of scanRes) {
    assert.ok(r.kind === 'hit' || r.kind === 'miss', `扫描结果分类正常：${r.kind}`);
  }
});

test('check 校验：文件不存在按 error 回报，宿主据此重扫（0.1.69）', async () => {
  const ghost = path.join(ws, 'ghost-does-not-exist.txt');
  const { outcome, results } = await scan([ghost], { check: [0] });
  assert.equal(outcome.kind, 'ok');
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, 'error');
});
