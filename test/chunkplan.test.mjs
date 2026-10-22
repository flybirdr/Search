import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ALIGN_LOOKAHEAD,
  chooseChunkSize,
  countStartsBefore,
  estimateChunkGain,
  isCrowdedForChunk,
  mergeChunkParts,
  optimalChunkBytes,
  overlapForQuery,
  planChunkRanges,
  shouldChunk,
  trimIncompleteUtf8Tail,
} from './.tmp/chunkPlan.mjs';

/** 内存里的假文件：readAt 从 Buffer 上切。 */
function fakeFile(text) {
  const bytes = Buffer.from(text, 'utf8');
  return {
    bytes,
    size: bytes.length,
    readAt: (from, to) => {
      const end = Math.min(to, bytes.length);
      return endpoints(from, end) <= 0 ? new Uint8Array(0) : new Uint8Array(bytes.subarray(from, end));
    },
  };
  function endpoints(a, b) {
    return b - a;
  }
}

const MB = 1024 * 1024;

test('块大小：大文件由成本最优值决定（√S），不再线性放大', () => {
  // C* = √(S · 0.12ms · 337920 B/ms) —— 200MB → 约 2.78MB，块数 72
  const plan = chooseChunkSize(200 * MB, { workers: 8, memoryPerWorker: 32 * MB, overlap: 0 });
  assert.equal(plan.bound, 'optimal');
  assert.ok(Math.abs(plan.chunkSize - 2.78 * MB) < 0.05 * MB, `实际 ${plan.chunkSize}`);
  assert.equal(plan.chunkCount, 72, '旧规则（S/4W）会给 6.25MB / 32 块');
  assert.equal(plan.chunkSize % 4096, 0, '块长必须是 4KB 的整数倍');
  assert.equal(plan.concurrency, 8);
});

test('块大小：1GB 与 8GB 分别落在 6.3MB / 17.8MB（尾延迟 19ms / 54ms）', () => {
  const policy = { workers: 16, memoryPerWorker: 32 * MB, overlap: 0 };
  const gb1 = chooseChunkSize(1024 * MB, policy);
  assert.ok(Math.abs(gb1.chunkSize - 6.3 * MB) < 0.15 * MB, `1GB 实际 ${gb1.chunkSize}`);
  assert.equal(gb1.chunkCount, 163, '旧规则是 16MB / 64 块（尾延迟 48ms）');
  const gb8 = chooseChunkSize(8192 * MB, policy);
  assert.ok(Math.abs(gb8.chunkSize - 17.8 * MB) < 0.4 * MB, `8GB 实际 ${gb8.chunkSize}`);
  assert.equal(gb8.chunkCount, 461, '旧规则顶到 64MB 上限 → 128 块（尾延迟 194ms）');
});

test('块大小：一律 4KB 向上对齐，且不低于 1MB 下限', () => {
  for (const mb of [2, 4, 7, 20, 64, 200, 1024, 8192]) {
    const plan = chooseChunkSize(mb * MB, { workers: 16, memoryPerWorker: 32 * MB, overlap: 0 });
    assert.equal(plan.chunkSize % 4096, 0, `${mb}MB 的块长 ${plan.chunkSize} 不是 4KB 倍数`);
    assert.ok(plan.chunkSize >= 1 * MB, `${mb}MB 的块长 ${plan.chunkSize} 小于 1MB`);
  }
});

test('块大小：内存预算顶住时对齐不越界', () => {
  const plan = chooseChunkSize(1024 * MB, { workers: 2, memoryPerWorker: 4 * MB, overlap: 64 * 1024 });
  assert.ok(plan.chunkSize + 64 * 1024 <= 4 * MB, '块 + 重叠不能超过预算');
  assert.equal(plan.chunkSize % 4096, 0);
});

test('最优块大小随 √S 增长：文件大 4 倍，块只大 2 倍', () => {
  const a = optimalChunkBytes(64 * MB);
  const b = optimalChunkBytes(256 * MB);
  assert.ok(Math.abs(b / a - 2) < 0.01, `比值 ${b / a}`);
});

test('最优块大小：一批多块时按 √b 折减', () => {
  const one = optimalChunkBytes(1024 * MB, 1);
  const four = optimalChunkBytes(1024 * MB, 4);
  assert.ok(Math.abs(one / four - 2) < 0.01, 'b 翻 4 倍，块减半');
});

test('块大小：小文件不切，退化为一块一块跑', () => {
  const plan = chooseChunkSize(512 * 1024, { workers: 16, memoryPerWorker: 32 * MB, overlap: 0 });
  assert.equal(plan.chunkSize, 1 * MB, '下限 1MB，不再往下切');
  assert.equal(plan.chunkCount, 1);
  assert.equal(plan.concurrency, 1, '只有一块，派再多 worker 也没用');
  assert.equal(plan.bound, 'min');
});

test('块大小：4MB 文件切 4 块（1MB 下限喂满小并发）', () => {
  const plan = chooseChunkSize(4 * MB, { workers: 8, memoryPerWorker: 32 * MB, overlap: 0 });
  assert.equal(plan.chunkSize, 1 * MB, '块被 1MB 下限顶住：4/32 < 1MB');
  assert.equal(plan.chunkCount, 4);
  assert.equal(plan.concurrency, 4, '4 块 → 4 路并行');
  assert.equal(plan.bound, 'min');
});

test('块大小：16MB 文件在 16 线程下切 16 块，刚好喂满', () => {
  const plan = chooseChunkSize(16 * MB, { workers: 16, memoryPerWorker: 32 * MB, overlap: 0 });
  assert.equal(plan.chunkSize, 1 * MB);
  assert.equal(plan.chunkCount, 16);
  assert.equal(plan.concurrency, 16);
});

test('块大小：8MB 文件在 2 线程下切 8 块，每 worker 4 块的均衡档', () => {
  const plan = chooseChunkSize(8 * MB, { workers: 2, memoryPerWorker: 32 * MB, overlap: 0 });
  assert.equal(plan.chunkSize, 1 * MB);
  assert.equal(plan.chunkCount, 8);
  assert.equal(plan.concurrency, 2);
});

test('收益判据：2~3MB 分块不划算，4MB 起转正', () => {
  const policy = { workers: 16, memoryPerWorker: 32 * MB, overlap: 0 };
  const at = (mb) => estimateChunkGain(mb * MB, policy);
  assert.equal(at(2).worth, false, '2MB 切成 2 块，净收益为负');
  assert.ok(at(2).gainMs < 0, '分块反而更慢时 gain 必须是负数');
  assert.equal(at(3).worth, false, '3MB 净赚约 2ms，过不了 4ms 门槛');
  assert.equal(at(4).worth, true, '4MB 切 4 块，净赚 5ms 出头');
  assert.equal(at(10).worth, true);
  assert.equal(at(64).worth, true);
  assert.ok(at(64).gainMs > 100, '大文件净收益是数量级上的差别');
});

test('拥挤闸门：kernel 树里 6.5MB 密集期不拆、尾声拆', () => {
  // 8 万文件、平均 20KB、16 线程 → 单 worker 还剩 87MB，6.5MB 只占 7%
  assert.equal(isCrowdedForChunk(6.5 * MB, 70000, 20 * 1024, 16, 32 * MB), true);
  // 尾声：队列只剩 50 个文件 → 单 worker 剩 62KB，6.5MB 是它的 100 倍
  assert.equal(isCrowdedForChunk(6.5 * MB, 50, 20 * 1024, 16, 32 * MB), false);
  // asic_reg 那批大文件集中出现：平均被拉到 44KB、剩余 3000 项 → 单个 worker
  // 手上只有 8MB，6.5MB 就不再是「小角」了
  assert.equal(isCrowdedForChunk(6.5 * MB, 3000, 44 * 1024, 16, 32 * MB), false);
  // 超过闸门上限的超大文件永远拆
  assert.equal(isCrowdedForChunk(100 * MB, 70000, 20 * 1024, 16, 32 * MB), false);
  // 闸门关掉（chunkCrowdMB = 0）时永远拆
  assert.equal(isCrowdedForChunk(6.5 * MB, 70000, 20 * 1024, 16, 0), false);
  // 还没有 stat 样本时退回按个数判断
  assert.equal(isCrowdedForChunk(6.5 * MB, 400, 0, 16, 32 * MB), true);
  assert.equal(isCrowdedForChunk(6.5 * MB, 8, 0, 16, 32 * MB), false);
});

test('收益判据：块数或并发不足 2 时绝不拆', () => {
  const policy = { workers: 16, memoryPerWorker: 32 * MB, overlap: 0 };
  assert.equal(shouldChunk(512 * 1024, policy), false, '不足一块');
  assert.equal(
    shouldChunk(64 * MB, { workers: 1, memoryPerWorker: 32 * MB, overlap: 0 }),
    false,
    '只有一个 worker，拆了也没人并行',
  );
  assert.equal(shouldChunk(0, policy), false, '空文件');
});

test('块大小：内存预算收紧时以内存为准（块 + 重叠 ≤ 预算）', () => {
  const plan = chooseChunkSize(1024 * MB, { workers: 2, memoryPerWorker: 4 * MB, overlap: 64 * 1024 });
  assert.equal(plan.bound, 'memory');
  assert.ok(plan.chunkSize + 64 * 1024 <= 4 * MB, '块 + 重叠不能超过单 worker 预算');
  assert.ok(plan.chunkSize >= 1 * MB);
  assert.equal(plan.concurrency, 2);
});

test('块大小：超大文件靠块数扩并发，不再顶到 64MB 上限', () => {
  // 8GB / 16 线程：旧规则算 128MB（被 64MB 上限截断），成本最优值只要 17.8MB
  const plan = chooseChunkSize(8 * 1024 * MB, { workers: 16, memoryPerWorker: 256 * MB, overlap: 0 });
  assert.equal(plan.bound, 'optimal');
  assert.ok(plan.chunkCount >= 16 * 4, '块数仍然远超 worker 数，负载均衡有保证');
  assert.ok(plan.chunkCount <= 512, `块数不该爆掉：${plan.chunkCount}`);
  assert.equal(plan.concurrency, 16);
});

test('块大小：显式把 maxChunk 调小时上限说了算', () => {
  const plan = chooseChunkSize(8 * 1024 * MB, {
    workers: 16,
    memoryPerWorker: 256 * MB,
    overlap: 0,
    maxChunk: 4 * MB,
  });
  assert.equal(plan.chunkSize, 4 * MB, '上限 4MB');
  assert.equal(plan.bound, 'max');
});

test('块边界：所有起点都落在行首，块区间首尾相接覆盖整个文件', () => {
  const text = 'aaa\nbbb\nccc\nddd\neee\nfff\n';
  const file = fakeFile(text);
  const planned = planChunkRanges(file.size, 8, 0, file.readAt);
  assert.ok(!('fallback' in planned));
  const ranges = planned.ranges;
  assert.equal(ranges.length >= 2, true, '8 字节一块、24 字节文件至少切成两块');
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges[ranges.length - 1].end, file.size, '最后一块的 end 就是文件末尾');
  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i];
    assert.equal(
      range.start === 0 || text[range.start - 1] === '\n',
      true,
      `第 ${i} 块起点 ${range.start} 必须是行首`,
    );
    if (i + 1 < ranges.length) {
      assert.equal(ranges[i + 1].start, range.end, '块之间不能有空洞或重叠');
    }
  }
});

test('块边界：CRLF 不会切在 \\r 与 \\n 之间', () => {
  const text = 'alpha\r\nbravo\r\ncharlie\r\ndelta\r\n';
  const file = fakeFile(text);
  const planned = planChunkRanges(file.size, 7, 0, file.readAt);
  assert.ok(!('fallback' in planned));
  for (const range of planned.ranges) {
    if (range.start === 0) continue;
    assert.notEqual(text[range.start], '\n', `起点 ${range.start} 不能是 \\n（说明切在 CRLF 中间了）`);
    assert.equal(text[range.start - 1] === '\n' || text[range.start - 1] === '\r', true);
  }
});

test('块边界：孤立 \\r 也算行首（与编辑器的行分割语义一致）', () => {
  const text = 'one\rtwo\rthree\rfour\r';
  const file = fakeFile(text);
  const planned = planChunkRanges(file.size, 6, 0, file.readAt);
  assert.ok(!('fallback' in planned));
  for (const range of planned.ranges) {
    if (range.start === 0) continue;
    assert.equal(text[range.start - 1], '\r');
  }
});

test('块边界：多字节字符不会被切开（起点必是字符边界）', () => {
  // 每行都是中文：任意「按行对齐」的起点天然是字符边界
  const text = '零一二三\n四五六七\n八九十一\n十二三四\n';
  const file = fakeFile(text);
  const planned = planChunkRanges(file.size, 9, 0, file.readAt);
  assert.ok(!('fallback' in planned));
  for (const range of planned.ranges) {
    // 起点处的字节不能是 UTF-8 续字节（0b10xxxxxx）
    const byte = file.bytes[range.start];
    if (byte !== undefined) {
      assert.equal((byte & 0xc0) !== 0x80, true, `起点 ${range.start} 落在多字节字符中间`);
    }
  }
});

test('块边界：末尾不足一块时最后一块 end = size，readEnd 不越界', () => {
  const text = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\n';
  const file = fakeFile(text);
  const planned = planChunkRanges(file.size, 12, 1024, file.readAt);
  assert.ok(!('fallback' in planned));
  const last = planned.ranges[planned.ranges.length - 1];
  assert.equal(last.end, file.size);
  assert.equal(last.readEnd, file.size, '重叠按文件末尾截断');
});

test('块边界：重叠区扩展到 end + overlap，但不超过文件末尾', () => {
  const text = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n') + '\n';
  const file = fakeFile(text);
  const planned = planChunkRanges(file.size, 50, 20, file.readAt);
  assert.ok(!('fallback' in planned));
  for (const range of planned.ranges) {
    assert.equal(range.readEnd, Math.min(file.size, range.end + 20));
    assert.ok(range.readEnd >= range.end, '读区间必须覆盖归属区间');
  }
});

test('块边界：整块没有换行（超长单行）时返回 fallback，不硬切', () => {
  const file = fakeFile('x'.repeat(MAX_ALIGN_LOOKAHEAD + 10));
  const planned = planChunkRanges(file.size, 1024, 0, file.readAt);
  assert.deepEqual(planned, { fallback: 'long-line' });
});

test('合并：块内行号加基准，按块序拼接', () => {
  const hit = (line, column) => ({
    line,
    column,
    endLine: line,
    endColumn: column + 3,
    preview: 'foo',
    prefix: column,
    matchLen: 3,
  });
  const merged = mergeChunkParts(
    [
      { index: 1, hits: [hit(0, 0), hit(2, 5)], lines: 5, capped: false },
      { index: 0, hits: [hit(1, 0)], lines: 10, capped: false },
    ],
    100,
  );
  assert.deepEqual(
    merged.hits.map((item) => [item.line, item.column]),
    [
      [1, 0], // 第 0 块（10 行）内第 1 行
      [10, 0], // 第 1 块从第 10 行开始
      [12, 5],
    ],
    '合并必须按块序，且行号加前面所有块的行数',
  );
  assert.equal(merged.lines, 15);
  assert.equal(merged.truncated, false);
});

test('合并：命中到上限即停，并标记截断；单块 capped 也传播', () => {
  const hits = Array.from({ length: 5 }, (_, i) => ({
    line: i,
    column: 0,
    endLine: i,
    endColumn: 1,
    preview: 'x',
    prefix: 0,
    matchLen: 1,
  }));
  const merged = mergeChunkParts(
    [
      { index: 0, hits, lines: 5, capped: false },
      { index: 1, hits, lines: 5, capped: true },
    ],
    3,
  );
  assert.equal(merged.hits.length, 3);
  assert.equal(merged.truncated, true);

  const cappedOnly = mergeChunkParts([{ index: 0, hits: [], lines: 5, capped: true }], 100);
  assert.equal(cappedOnly.truncated, true, '某块命中单文件上限时整份文件算截断');
});

test('UTF-8 尾巴：切在多字节字符中间时截掉不完整序列', () => {
  const bytes = Buffer.from('中文abc', 'utf8');
  // 「中」= 3 字节：切掉最后 1 字节 → 只剩两字节
  const half = new Uint8Array(bytes.subarray(0, 2));
  assert.equal(trimIncompleteUtf8Tail(half).length, 0, '整个字符不完整就整段丢掉');
  // 完整的两字节 + 半个字符
  const mixed = new Uint8Array(Buffer.from('中'.repeat(2) + '文', 'utf8').subarray(0, 8));
  assert.equal(trimIncompleteUtf8Tail(mixed).length, 6, '只截掉末尾半个字符');
  // 纯 ASCII 不动
  const ascii = new Uint8Array(Buffer.from('hello', 'utf8'));
  assert.equal(trimIncompleteUtf8Tail(ascii).length, 5);
});

test('行数统计：小于 limit 的行首个数（边界行首归下一块）', () => {
  const starts = [0, 4, 8, 12];
  assert.equal(countStartsBefore(starts, 0), 0);
  assert.equal(countStartsBefore(starts, 1), 1);
  assert.equal(countStartsBefore(starts, 4), 1, '正好落在行首上的那个行首属于下一块');
  assert.equal(countStartsBefore(starts, 7), 2);
  assert.equal(countStartsBefore(starts, 100), 4);
});

test('重叠判定：单行内的模式不需要重叠，可能跨行的才给', () => {
  assert.equal(overlapForQuery('normal', 'foo', false), 0, '普通模式下 \\n 只是两个字符');
  assert.equal(overlapForQuery('extended', 'foo\\nbar', false), 64 * 1024);
  assert.equal(overlapForQuery('extended', 'foo\\tbar', false), 0);
  assert.equal(overlapForQuery('regex', 'foo.*bar', false), 0, '没开 dotAll 时 . 不跨行');
  assert.equal(overlapForQuery('regex', 'foo.*bar', true), 64 * 1024, 'dotAll 下 . 能跨行');
  assert.equal(overlapForQuery('regex', 'foo\\sbar', false), 64 * 1024, '\\s 含换行');
  assert.equal(overlapForQuery('regex', 'a\\nb', false), 64 * 1024);
});
