/**
 * 临时基准：验证常驻池并发是否生效。
 * 语料：400 个 ~150KB 小文件 + 10 个 ~4MB 流式文件 ≈ 100MB。
 * 分别用 workerCount=1 与 8 各跑两轮（第一轮冷启动，第二轮热池）。
 * 若 8-worker 热轮耗时 ≈ 1-worker 热轮 / 6~8，则并发正常。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const { runWorkerSearch, disposeSharedWorkerPool } = await import(
  pathToFileURL(path.join(root, 'test', '.tmp', 'workerPool.mjs')).href
);

const WASM = path.join(root, 'media', 'core.wasm');
const WORKER = path.join(root, 'dist', 'searchWorker.js');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'flybench-'));
const files = [];
// 400 个小文件，每个 ~150KB，内嵌少量命中
const small = (Array.from({ length: 700 }, (_, i) =>
  i % 100 === 0 ? `token here ${i}` : `filler line ${i} of this small file`,
).join('\n') + '\n');
for (let i = 0; i < 400; i += 1) {
  const full = path.join(ws, `s${i}.txt`);
  fs.writeFileSync(full, small);
  files.push(full);
}
// 10 个 ~4MB 文件（超过默认 streamThresholdKB=2048，走流式）
const bigLines = Array.from({ length: 60000 }, (_, i) =>
  i % 5000 === 0 ? `token in big ${i}` : `filler ${i} padding padding padding padding padding`,
);
for (let i = 0; i < 10; i += 1) {
  const full = path.join(ws, `b${i}.txt`);
  fs.writeFileSync(full, bigLines.join('\n') + '\n');
  files.push(full);
}
const totalMB = files.reduce((sum, f) => sum + fs.statSync(f).size, 0) / 1024 / 1024;
console.log(`corpus: ${files.length} files, ${totalMB.toFixed(1)} MB at ${ws}`);

const OPTIONS = {
  query: 'token',
  mode: 'normal',
  caseSensitive: false,
  wholeWord: false,
  dotAll: false,
  backtrackLimit: 1000000,
};

async function run(workerCount) {
  const t0 = performance.now();
  let hits = 0;
  const outcome = await runWorkerSearch({
    wasmPath: WASM,
    workerScript: WORKER,
    workerCount,
    files: [...files],
    options: OPTIONS,
    perFileLimit: 2000,
    maxBytes: 512000 * 1024,
    streamAbove: 2048 * 1024,
    shouldAbort: () => false,
    onBatch: (results) => {
      for (const r of results) if (r.kind === 'hit') hits += r.hits.length;
    },
  });
  const ms = performance.now() - t0;
  const mbs = (totalMB / (ms / 1000)).toFixed(0);
  console.log(`workers=${workerCount}: ${ms.toFixed(0)} ms (${mbs} MB/s), outcome=${outcome.kind}, hits=${hits}`);
  return ms;
}

const c1a = await run(1);
const c1b = await run(1);
const c8a = await run(8);
const c8b = await run(8);
const c8c = await run(8);
console.log(`\n热轮对比: 1-worker ${c1b.toFixed(0)}ms vs 8-worker ${Math.min(c8b, c8c).toFixed(0)}ms, 加速比 ${(c1b / Math.min(c8b, c8c)).toFixed(1)}x`);

disposeSharedWorkerPool();
fs.rmSync(ws, { recursive: true, force: true });
process.exit(0);
