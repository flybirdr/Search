/**
 * 「统计完整数量」的计数正确性。
 *
 * 关键不是「能数对一份小文件」，而是**分块边界**：计数块尾多读 overlap、
 * 只认「起点落在本块」的命中——跨块的匹配既不能漏也不能重复。这里用极小的
 * chunkBytes（64 字节）把匹配密集地压在每一个边界上。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { SearchCore } from './.tmp/wasm.mjs';
import { countMatches } from './.tmp/exactCount.mjs';

const require = createRequire(import.meta.url);
const iconv = require('iconv-lite');

const wasmPath = fileURLToPath(new URL('../media/core.wasm', import.meta.url));
const core = await SearchCore.load(wasmPath);
/** 普通模式 + MULTILINE（与 buildFlags 一致：位 1 永远打开） */
const handle = core.compile('needle', 0, 2, 1000000);

const dir = mkdtempSync(path.join(tmpdir(), 'fly-count-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function write(name, content) {
  const full = path.join(dir, name);
  writeFileSync(full, content);
  return full;
}

test('计数：分块边界上的匹配不漏不重', async () => {
  // 每行 15 字节，needle 出现在偏移 15k+4；块 64 字节时命中会密集压在边界附近
  const lines = [];
  for (let i = 0; i < 400; i += 1) {
    lines.push(`abc needle ${String(i).padStart(3, '0')}\n`);
  }
  const text = lines.join('');
  const file = write('boundary.txt', text);
  const expected = 400;

  const chunked = await countMatches({
    core,
    handle,
    files: [file],
    maxFileBytes: 1 << 30,
    chunkBytes: 64,
    overlap: 16,
  });
  assert.equal(chunked.total, expected, `64 字节块：实际 ${chunked.total}`);
  assert.equal(chunked.approximate, false);

  const whole = await countMatches({
    core,
    handle,
    files: [file],
    maxFileBytes: 1 << 30,
    chunkBytes: 1 << 20,
  });
  assert.equal(whole.total, expected, '整份统计应当一致');
});

test('计数：长匹配跨越块边界也只算一次', async () => {
  // 匹配 12 字节，块 64 字节 + 重叠 32 —— 边界会切在匹配中间
  const pattern = 'abcdefghijkl';
  const longHandle = core.compile(pattern, 0, 2, 1000000);
  const parts = [];
  for (let i = 0; i < 200; i += 1) {
    parts.push(`${pattern}${'x'.repeat(i % 7)}\n`);
  }
  const file = write('long.txt', parts.join(''));
  const result = await countMatches({
    core,
    handle: longHandle,
    files: [file],
    maxFileBytes: 1 << 30,
    chunkBytes: 64,
    overlap: 32,
  });
  assert.equal(result.total, 200);
  assert.equal(result.approximate, false);
});

test('计数：GBK 文件按整份解码统计', async () => {
  const gbk = iconv.encode('这里有一处 needle 藏在中文里\n'.repeat(30), 'gbk');
  const file = write('gbk.txt', gbk);
  const result = await countMatches({ core, handle, files: [file], maxFileBytes: 1 << 30 });
  assert.equal(result.total, 30, 'GBK 走整份解码，计数必须精确');
  assert.equal(result.approximate, false);
});

test('计数：二进制文件不计入，超限文件跳过', async () => {
  const binary = write('bin.dat', Buffer.from([0x00, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
  const big = write('big.txt', 'needle\n'.repeat(100));
  const small = write('small.txt', 'needle needle\n');

  const result = await countMatches({
    core,
    handle,
    files: [binary, big, small],
    maxFileBytes: 100,
    chunkBytes: 64,
    overlap: 8,
  });
  assert.equal(result.total, 2, '二进制不计入、超限跳过，只剩 small 的两处');
  assert.equal(result.skipped, 1, '只有超出 maxFileBytes 的那份被跳过');
  assert.equal(result.files, 2, '二进制文件算「扫过但 0 命中」，与搜索的语义一致');
});

test('计数：路径不存在不报错，只计入 skipped', async () => {
  const result = await countMatches({
    core,
    handle,
    files: [path.join(dir, 'nope.txt')],
    maxFileBytes: 1 << 30,
  });
  assert.equal(result.total, 0);
  assert.equal(result.skipped, 1);
});
