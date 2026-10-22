/**
 * 自动并发度决策测试（0.1.71：随文件数伸缩，上限 16、下限 2）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideAutoWorkerCount,
  AUTO_WORKER_CAP,
  decideStealCount,
  MAX_STEAL_BYTES,
  shouldUsePool,
  POOL_MIN_BYTES,
} from './.tmp/parallelism.mjs';

test('自动档：worker 数与文件数量同步，上限 16', () => {
  assert.equal(AUTO_WORKER_CAP, 16);
  assert.equal(decideAutoWorkerCount(2).count, 2, '2 文件 2 worker');
  assert.equal(decideAutoWorkerCount(4).count, 4, '4 文件 4 worker');
  assert.equal(decideAutoWorkerCount(50).count, 16, '50 文件给满上限 16');
  assert.equal(decideAutoWorkerCount(80000).count, 16, '超大工作区也是 16');
});

test('自动档：下限 2（不足时由池子按文件数收缩）', () => {
  assert.equal(decideAutoWorkerCount(1).count, 2, '文件数 1 也保下限（池子按文件数收缩）');
  assert.equal(decideAutoWorkerCount(0).count, 2, '0 文件保下限（实际到不了这，防御）');
});

const KB20 = 20 * 1024;

test('批量：密集期按 8MB 字节预算封顶，凑出几百个小文件一批', () => {
  const d = decideStealCount({
    pending: 70000,
    avgFileBytes: KB20,
    workers: 16,
    want: 512,
  });
  assert.equal(d.basis, 'bytes');
  assert.equal(d.budgetBytes, MAX_STEAL_BYTES, '剩余 1.3GB 时预算顶到 8MB 上限');
  assert.equal(d.take, 409, '8MB / 20KB = 409 个');
});

test('批量：尾声自动收缩到一次一个（最细粒度收尾）', () => {
  const d = decideStealCount({ pending: 20, avgFileBytes: KB20, workers: 16, want: 512 });
  assert.equal(d.take, 1, '只剩 20 个文件时一个一批，避免最后几个被一个人包干');
});

test('批量：asic_reg 那种「大文件集中出现」不再被整批领走', () => {
  // 3000 个待办、平均 44KB、16 线程 → 预算约 2MB → 46 个一批
  const d = decideStealCount({ pending: 3000, avgFileBytes: 45 * 1024, workers: 16, want: 512 });
  assert.ok(d.take > 1 && d.take < 60, `实际 ${d.take}`);
});

test('批量：还没有 stat 样本时退回按个数', () => {
  const d = decideStealCount({ pending: 500, avgFileBytes: 0, workers: 16, want: 64 });
  assert.equal(d.basis, 'want');
  assert.equal(d.take, 64);
});

test('批量：块条目换算成「几块」，上限 4 块', () => {
  const base = { pending: 70000, avgFileBytes: KB20, workers: 16, want: 512 };
  const MB = 1024 * 1024;
  assert.equal(decideStealCount({ ...base, chunkBytes: MB }).take, 4, '8MB 预算 / 1MB 块 = 8，被 4 封顶');
  assert.equal(
    decideStealCount({ ...base, chunkBytes: MB, want: 2 }).take,
    2,
    'worker 自己只要 2 个时听它的',
  );
  assert.equal(
    decideStealCount({ ...base, chunkBytes: 18 * MB }).take,
    1,
    '18MB 的块一个都装不下两块的预算',
  );
});

test('批量：块条目在尾声也缩到一块一块派', () => {
  const MB = 1024 * 1024;
  const d = decideStealCount({ pending: 0, avgFileBytes: KB20, workers: 16, want: 8, chunkBytes: MB });
  assert.equal(d.take, 1);
  assert.equal(d.basis, 'chunk');
});

test('批量：want 的硬上限 512 仍然生效', () => {
  const d = decideStealCount({ pending: 10 ** 6, avgFileBytes: 512, workers: 16, want: 4096 });
  assert.equal(d.take, 512);
});


test('池子启用：10 个 20MB 也进池子（不该比 1.5GB 的源码树还慢）', () => {
  assert.equal(shouldUsePool(10, 10 * 20 * 1024 * 1024), true);
  assert.equal(shouldUsePool(99, 99 * 100 * 1024), false, '99 个 100KB ≈ 9.9MB，不到 16MB 线');
  assert.equal(shouldUsePool(6, 6 * 3 * 1024 * 1024), true, '18MB 总量过线');
  assert.equal(shouldUsePool(3, 1 * 1024 * 1024), false, '3MB 不值得拉池子');
  assert.equal(shouldUsePool(100, 0), true, '文件数够多时总量无所谓');
  assert.equal(shouldUsePool(0, 0), false);
  assert.equal(POOL_MIN_BYTES, 16 * 1024 * 1024);
});
