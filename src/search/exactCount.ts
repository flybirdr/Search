/**
 * 「统计完整数量」：只数命中，不产出结果行。
 *
 * 为什么单独做一遍：正常搜索命中达到上限就停（全局 `maxMatches` 20000 条、
 * 单文件 `maxMatchesPerFile` 2000 条）——那是有意的，因为每一行都要建 Range、
 * 带预览、跨进程传给 webview 并渲染，几十万条会把面板压死。但「到底有多少处」
 * 只需要一个数字：不建预览、不算行号、不回传结果，所以可以完整扫一遍。
 *
 * 计数规则与搜索结果**同一套语义**：
 * - 一个文件的编码按 `detectEncoding` 判定，二进制直接跳过（与搜索一致）；
 * - UTF-8 大文件按块计数，块尾多读 `overlap` 字节，只数「起点落在本块」的
 *   命中——跨块的命中在前一块里被看到并计入，既不漏也不重复；
 * - 非 UTF-8 大文件用流式解码器顺序喂，无法保证跨块匹配，结果标记为
 *   `approximate`（只有 > 64MB 的 GBK/UTF-16 日志会走到这里）。
 */
import * as fsp from 'node:fs/promises';
import type { SearchCore } from '../engine/wasm';
import { trimIncompleteUtf8Tail } from './chunkPlan';
import { detectEncoding, makeDecoder, StreamEncoding } from './stream';

/** 不超过这个大小的文件整份解码后一次性数，边界问题不存在 */
export const COUNT_WHOLE_LIMIT = 64 << 20;
/** 大文件的计数块（不需要行首对齐，固定步长即可） */
export const COUNT_CHUNK_BYTES = 4 << 20;
/** 块尾多读的字节：覆盖跨块的匹配（与搜索的重叠上限一致） */
export const COUNT_OVERLAP_BYTES = 64 << 10;
/** 单块的匹配条数上限：防病态查询（搜 "e"）把内存打爆，触顶就记 approximate */
export const COUNT_PER_CHUNK_CAP = 200_000;

export interface ExactCountOptions {
  core: SearchCore;
  /** 已编译的表达式句柄 */
  handle: number;
  /** 要统计的文件（绝对路径） */
  files: string[];
  /** 超过这个大小的文件跳过（与搜索的 maxFileSizeKB 对齐） */
  maxFileBytes: number;
  wholeLimit?: number;
  chunkBytes?: number;
  overlap?: number;
  perChunkCap?: number;
  onProgress?: (done: number, total: number) => void;
  /** 每个文件处理前查一次：为真立即收工（「统计完整数量」可被 Stop 打断） */
  shouldAbort?: () => boolean;
}

export interface ExactCountResult {
  total: number;
  /** true = 触到了单块上限，或非 UTF-8 大文件的跨块匹配可能漏计，total 是下界 */
  approximate: boolean;
  files: number;
  skipped: number;
  bytes: number;
  ms: number;
  /** true = 用户中途取消，total 只是取消前已统计的部分，调用方不应采用 */
  cancelled: boolean;
}

export async function countMatches(options: ExactCountOptions): Promise<ExactCountResult> {
  const started = Date.now();
  const chunkBytes = Math.max(4096, Math.floor(options.chunkBytes ?? COUNT_CHUNK_BYTES));
  const overlap = Math.max(0, Math.floor(options.overlap ?? COUNT_OVERLAP_BYTES));
  const wholeLimit = Math.max(chunkBytes, options.wholeLimit ?? COUNT_WHOLE_LIMIT);
  const cap = Math.max(1, Math.floor(options.perChunkCap ?? COUNT_PER_CHUNK_CAP));
  const config = { chunkBytes, overlap, wholeLimit, cap };

  let total = 0;
  let files = 0;
  let skipped = 0;
  let bytes = 0;
  let approximate = false;
  let cancelled = false;

  for (const file of options.files) {
    if (options.shouldAbort?.()) {
      cancelled = true;
      break;
    }
    let size: number;
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) {
        skipped += 1;
        continue;
      }
      size = stat.size;
    } catch {
      skipped += 1;
      continue;
    }
    if (size > options.maxFileBytes) {
      skipped += 1;
      continue;
    }
    try {
      const counted = await countFile(options.core, options.handle, file, size, config);
      total += counted.count;
      approximate = approximate || counted.approximate;
      bytes += size;
      files += 1;
    } catch {
      // 读不到 / 解码失败：与搜索的「读失败」一样跳过，不污染总数
      skipped += 1;
    }
    options.onProgress?.(files + skipped, options.files.length);
  }

  return { total, approximate, files, skipped, bytes, ms: Date.now() - started, cancelled };
}

export interface CountConfig {
  chunkBytes: number;
  overlap: number;
  wholeLimit: number;
  cap: number;
}

export async function countFile(
  core: SearchCore,
  handle: number,
  file: string,
  size: number,
  config: CountConfig,
): Promise<{ count: number; approximate: boolean }> {
  const head = await readHead(file, Math.min(size, 8192));
  const probe = detectEncoding(head);
  if (probe.kind === 'binary') {
    return { count: 0, approximate: false };
  }

  if (size <= config.wholeLimit) {
    const buffer = await fsp.readFile(file);
    const body = buffer.subarray(probe.skip);
    let text: string;
    if (probe.kind === 'utf-8') {
      text = new TextDecoder('utf-8').decode(body);
    } else {
      const decoder = makeDecoder(probe.kind);
      text = decoder.decode(body) + decoder.flush();
    }
    const matches = core.findAll(handle, text, config.cap);
    return { count: matches.length, approximate: matches.length >= config.cap };
  }

  if (probe.kind !== 'utf-8') {
    return countNonUtf8Chunks(core, handle, file, size, probe.kind, probe.skip, config);
  }
  return countUtf8Chunks(core, handle, file, size, config);
}

/** 逐块数 UTF-8 大文件：块尾多读 overlap，只认「起点在本块」的命中。 */
async function countUtf8Chunks(
  core: SearchCore,
  handle: number,
  file: string,
  size: number,
  config: CountConfig,
): Promise<{ count: number; approximate: boolean }> {
  const fh = await fsp.open(file, 'r');
  let count = 0;
  let approximate = false;
  try {
    for (let start = 0; start < size; start += config.chunkBytes) {
      const end = Math.min(start + config.chunkBytes, size);
      const readEnd = Math.min(end + config.overlap, size);
      const buffer = Buffer.allocUnsafe(readEnd - start);
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, start);
      if (bytesRead <= 0) {
        break;
      }
      const bytes = trimIncompleteUtf8Tail(buffer.subarray(0, bytesRead));
      const placed = core.putBytes(bytes);
      const matches = core.findAllAt(handle, placed.ptr, placed.len, config.cap);
      const localEnd = Math.min(bytes.length, end - start);
      for (const match of matches) {
        if (match.start < localEnd) {
          count += 1;
        }
      }
      if (matches.length >= config.cap) {
        approximate = true;
      }
    }
  } finally {
    await fh.close();
  }
  return { count, approximate };
}

/**
 * 非 UTF-8 大文件：用一个流式解码器顺序喂，块与块之间不留重叠。
 *
 * 不留重叠是因为解码后的字符偏移换算不回字节偏移，重叠区会被数两次。代价是
 * 跨块的匹配会漏——只有 > 64MB 的 GBK / UTF-16 文件会走到这里，且每 4MB 边界
 * 最多漏一条，所以结果标记为 approximate。
 */
async function countNonUtf8Chunks(
  core: SearchCore,
  handle: number,
  file: string,
  size: number,
  kind: StreamEncoding,
  skip: number,
  config: CountConfig,
): Promise<{ count: number; approximate: boolean }> {
  const fh = await fsp.open(file, 'r');
  const decoder = makeDecoder(kind);
  let count = 0;
  let approximate = true;
  let first = true;
  try {
    for (let start = 0; start < size; start += config.chunkBytes) {
      const end = Math.min(start + config.chunkBytes, size);
      const buffer = Buffer.allocUnsafe(end - start);
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, start);
      if (bytesRead <= 0) {
        break;
      }
      const bytes = buffer.subarray(0, bytesRead);
      const text = decoder.decode(first ? bytes.subarray(Math.min(skip, bytes.length)) : bytes);
      first = false;
      if (text.length === 0) {
        continue;
      }
      const matches = core.findAll(handle, text, config.cap);
      count += matches.length;
      if (matches.length >= config.cap) {
        approximate = true;
      }
    }
    const tail = decoder.flush();
    if (tail.length > 0) {
      count += core.findAll(handle, tail, config.cap).length;
    }
  } finally {
    await fh.close();
  }
  return { count, approximate };
}

async function readHead(file: string, length: number): Promise<Uint8Array> {
  const fh = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(Math.max(1, length));
    const { bytesRead } = await fh.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
