/** 新旧 worker 正面对比：0.1.45（同步 I/O + 旧 wasm）vs 当前（异步流水线 + SIMD wasm） */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const { runWorkerSearch, disposeSharedWorkerPool } = await import(
  pathToFileURL(path.join(root, 'test', '.tmp', 'workerPool.mjs')).href
);

const NEW_WASM = path.join(root, 'media', 'core.wasm');
const NEW_WORKER = path.join(root, 'dist', 'searchWorker.js');
const OLD_DIR = path.join(homedir(), '.vscode', 'extensions', 'flysearch.search-0.1.45');
const OLD_WASM = path.join(OLD_DIR, 'media', 'core.wasm');
const OLD_WORKER = path.join(OLD_DIR, 'dist', 'searchWorker.js');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'flybench7-'));
const OPTIONS = {
  query: 'token', mode: 'normal', caseSensitive: false, wholeWord: false, dotAll: false,
  backtrackLimit: 1000000,
};
const small = Array.from({ length: 700 }, (_, i) =>
  i % 100 === 0 ? `token here ${i}` : `filler line ${i} of this small file`).join('\n') + '\n';

// 场景一：3200 个 28KB 小文件（源码工作区形态）
// 场景二：1000 个 156KB 中等文件（约 150MB）
const corpusA = [];
for (let i = 0; i < 3200; i += 1) {
  const full = path.join(ws, `a${i}.txt`);
  fs.writeFileSync(full, small);
  corpusA.push(full);
}
const medium = Array.from({ length: 3000 }, (_, i) =>
  i % 1000 === 0 ? `const token${i} = 'needle';` : `export function helper${i}(a, b) { return a + b * 2; }`).join('\n') + '\n';
const corpusB = [];
for (let i = 0; i < 1000; i += 1) {
  const full = path.join(ws, `b${i}.ts`);
  fs.writeFileSync(full, medium);
  corpusB.push(full);
}

async function run(workerScript, wasmPath, files, workerCount, label) {
  const totalMB = files.reduce((s, f) => s + fs.statSync(f).size, 0) / 1048576;
  const t0 = performance.now();
  const outcome = await runWorkerSearch({
    wasmPath, workerScript, workerCount, files: [...files], options: OPTIONS,
    perFileLimit: 2000, maxBytes: 512000 * 1024, streamAbove: 2048 * 1024,
    shouldAbort: () => false, onBatch: () => undefined,
  });
  const ms = performance.now() - t0;
  console.log(`${label} ${workerCount}w: ${ms.toFixed(0)}ms (${(totalMB / (ms / 1000)).toFixed(0)} MB/s) ${outcome.kind}`);
  return ms;
}

console.log('== 场景一：3200 个 28KB 小文件 ==');
const o1 = await run(OLD_WORKER, OLD_WASM, corpusA, 8, '0.1.45');
const n1c = await run(NEW_WORKER, NEW_WASM, corpusA, 8, '当前-冷');
const n1h = await run(NEW_WORKER, NEW_WASM, corpusA, 8, '当前-热');
console.log(`   0.1.45 / 当前热 = ${(o1 / n1h).toFixed(2)}x`);

console.log('== 场景二：1000 个 156KB 中等文件 ==');
// 旧 worker 每次 run 后 process.exit，跑一次即换新进程；当前 worker 常驻
const o2 = await run(OLD_WORKER, OLD_WASM, corpusB, 8, '0.1.45');
const n2c = await run(NEW_WORKER, NEW_WASM, corpusB, 8, '当前-冷');
const n2h = await run(NEW_WORKER, NEW_WASM, corpusB, 8, '当前-热');
console.log(`   0.1.45 / 当前热 = ${(o2 / n2h).toFixed(2)}x`);

disposeSharedWorkerPool();
fs.rmSync(ws, { recursive: true, force: true });
process.exit(0);
