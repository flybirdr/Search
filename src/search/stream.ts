/**
 * 大文件流式搜索。
 *
 * 整块读入的代价是「文件多大就要多少内存」，而且一旦超过体积门槛就只能整份跳过。
 * 这里改成按固定大小的块读取：内存占用与文件大小无关，几百 MB 的日志也能搜。
 *
 * 分块边界处理（字符串路径：GBK / UTF-16 / 字节场兜底）：
 * - 解码用 `TextDecoder` 的流式模式（GBK 走 iconv 的 Decoder），多字节字符被切在
 *   两块之间也不会变成乱码。
 * - 每次只在**行边界**上切，切点之前的文本视为已确认，之后的部分留到下一块开头。
 *   因此 `^` / `$` 在块首块尾的语义与整文件搜索一致。
 * - 保留至少 `overlapChars`（默认 256 KB）的尾巴不确认，所以跨块的多行匹配只要
 *   长度不超过这个重叠区，仍会在下一块里被完整找到。超过重叠区的单个匹配
 *   （> 256 KB）跨块时可能漏报——这是流式搜索的固有限制。
 *
 * UTF-8 字节快速路径（默认启用）：
 * - 探测为 UTF-8 时不再解码成字符串：字节块直接 putBytes 进内核复用暂存区，
 *   utf8ValidAt 校验、findAllAt 匹配、lineStartsAt 行起点（\n/\r\n/孤立\r 语义
 *   与编辑器一致），命中行才局部解码换算 UTF-16 列号与预览。旧字符串路径里
 *   「解码 → 拼接 → 编码回字节 → 再编码一遍」的全量搬运全部消失。
 * - 只在 \n 字节处切块：0x0A 不可能出现在多字节 UTF-8 序列内部（续字节 ≥ 0x80），
 *   字节层切行与字符层切行同样安全。重叠区按字节给 4 倍（一个 UTF-16 单元最多
 *   4 字节），覆盖旧 overlapChars 的跨块匹配语义。
 * - 校验发现非法序列（前 8KB 探测漏网的 GBK 等）：整份文件退回字符串路径重扫，
 *   结果与旧版完全一致（TextDecoder fatal:false → U+FFFD），代价只是该文件多读一遍。
 * - 已知微差：字节长 2~8KB 的行（字符数 ≤ 2048 的多字节行）字符串路径整行出预览、
 *   字节路径走超长行窗口分支——行号/列号/匹配完全一致，仅预览窗口位置可能不同。
 */
import { createReadStream } from 'node:fs';
import iconv from 'iconv-lite';
import type { SearchCore } from '../engine/wasm';
import { buildLineStarts, findMatches, findMatchesAt, positionAt } from '../engine/search';

export const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
export const DEFAULT_OVERLAP_CHARS = 256 * 1024;

/** 单行超长（比如压缩成一行的 JSON）时，按固定长度硬切，不再等换行。 */
const MIN_CHUNK_BYTES = 4096;
const BINARY_PROBE_BYTES = 8192;
const PREVIEW_WINDOW = 160;
const PREVIEW_LEAD = 40;
/** 超过这个长度的行，只为命中位置截取一段，不复制整行。 */
const HUGE_LINE = 2048;

export type StreamEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk';

export interface StreamHit {
  /** 0 基行号 */
  line: number;
  /** 0 基列号（UTF-16 码元） */
  column: number;
  endLine: number;
  endColumn: number;
  /** 命中所在行的预览文本，可能带有首尾省略号 */
  preview: string;
  /** 命中在 preview 中的起始下标 */
  prefix: number;
  /** 匹配长度（已按预览窗口截断） */
  matchLen: number;
}

export interface StreamOptions {
  /** 最多收集多少条命中；到达后停止读取 */
  limit: number;
  /** 读到这里就不再继续（防止文件在搜索期间变大） */
  maxBytes: number;
  chunkBytes?: number;
  overlapChars?: number;
  /** 每读完一块回调一次，用于进度条 */
  onProgress?: (state: { bytesRead: number; lines: number; hits: number }) => void;
  token?: { readonly isCancellationRequested: boolean };
}

export interface StreamResult {
  kind: 'ok' | 'binary' | 'tooLarge' | 'cancelled' | 'unsupported' | 'error';
  hits: StreamHit[];
  bytesRead: number;
  /** 处理到的行数（0 基最后一行索引 + 1） */
  lines: number;
  /** 因为命中上限提前停止，结果可能不完整 */
  truncated: boolean;
  encoding: StreamEncoding;
  message?: string;
}

export interface ChunkDecoder {
  decode(chunk: Uint8Array): string;
  flush(): string;
}

export type Detection = { kind: 'binary' } | { kind: StreamEncoding; skip: number };

export async function streamSearchFile(
  fsPath: string,
  core: SearchCore,
  handle: number,
  options: StreamOptions,
): Promise<StreamResult> {
  const first = await runStreamSearch(fsPath, core, handle, options, true);
  if (first.fallback) {
    // UTF-8 字节场发现非法序列：整份文件退回字符串路径重扫，结果与旧版一致
    return (await runStreamSearch(fsPath, core, handle, options, false)).result;
  }
  return first.result;
}

async function runStreamSearch(
  fsPath: string,
  core: SearchCore,
  handle: number,
  options: StreamOptions,
  allowBytePath: boolean,
): Promise<{ result: StreamResult; fallback: boolean }> {
  const chunkBytes = Math.max(MIN_CHUNK_BYTES, Math.floor(options.chunkBytes ?? DEFAULT_CHUNK_BYTES));
  const overlap = Math.max(1024, Math.floor(options.overlapChars ?? DEFAULT_OVERLAP_CHARS));
  const limit = Math.max(1, options.limit);

  const hits: StreamHit[] = [];
  let bytesRead = 0;
  let lineBase = 0;
  let columnBase = 0;
  let pending = '';
  let pendingBytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let utf8ByteMode = false;
  let byteFallback = false;
  let encoding: StreamEncoding = 'utf-8';
  let decoder: ChunkDecoder | undefined;
  let truncated = false;
  let cancelled = false;
  let binary = false;
  let tooLarge = false;
  let failure = '';
  /** process 主动叫停（命中上限 / 出错），尾部不再解析 */
  let stopped = false;
  /** 本地 fs 打不开（虚拟文件系统 / 远程 URI）：交给调用方退回整块读 */
  let unsupported = false;

  const stream = createReadStream(fsPath, { highWaterMark: chunkBytes });

  /**
   * 处理当前缓冲区（字符串路径）。返回 false 表示「到此为止」（命中上限 / 出错）。
   * `isLast` 为真时说明后面没有数据了，缓冲区全部确认。
   */
  const process = (isLast: boolean): boolean => {
    if (pending.length === 0) {
      return true;
    }

    let cut = pending.length;
    if (!isLast) {
      // 至少攒到两倍重叠区才切，否则缓冲区永远只有一条尾巴
      if (pending.length <= overlap * 2) {
        return true;
      }
      const target = pending.length - overlap;
      const floor = Math.max(0, target - overlap);
      const newline = pending.lastIndexOf('\n', target - 1);
      if (newline >= floor) {
        cut = newline + 1;
      } else {
        // 整块没有换行（压缩成一行的文件）：只能按长度硬切，保留最小重叠区。
        // 缓冲区不会因此无界增长——每块最多再多攒一个重叠区就会被切掉。
        cut = Math.max(1, target);
      }
    }

    const starts = buildLineStarts(pending);
    // 留一点余量：块尾的命中会留给下一块，不算进额度
    const budget = Math.max(1, limit - hits.length + 32);
    let matches;
    try {
      matches = findMatches(core, handle, pending, budget);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      return false;
    }
    if (matches.length >= budget) {
      // 这一块里的命中比我们能拿的还多，结果必然不完整
      truncated = true;
    }

    for (const match of matches) {
      // 切点之后的命中留给下一块判断，避免重复上报
      if (!isLast && match.start >= cut) {
        continue;
      }
      // 贴着块尾的匹配可能还没结束，等下一块拿到完整文本再说
      if (!isLast && match.start + match.len >= pending.length) {
        continue;
      }
      const pos = positionAt(starts, match.start);
      const end = positionAt(starts, match.start + match.len);
      const parts = previewAt(pending, starts, pos.line, pos.column, match.len);
      hits.push({
        line: lineBase + pos.line,
        column: pos.line === 0 ? columnBase + pos.column : pos.column,
        endLine: lineBase + end.line,
        endColumn: end.line === 0 ? columnBase + end.column : end.column,
        preview: parts.preview,
        prefix: parts.prefix,
        matchLen: parts.matchLen,
      });
      if (hits.length >= limit) {
        truncated = true;
        return false;
      }
    }

    const lineIndex = lineIndexOf(starts, cut);
    lineBase += lineIndex;
    // 硬切（整块没有换行）时 lineIndex 为 0，此时列偏移要在原有的基础上累加
    columnBase = (lineIndex === 0 ? columnBase : 0) + (cut - starts[lineIndex]);
    pending = pending.slice(cut);
    return true;
  };

  /**
   * 处理当前缓冲区（UTF-8 字节快速路径）。语义与 process 一一对应，
   * 只是文本以原始字节存在：切行按 \n 字节、行列按局部解码换算 UTF-16。
   */
  const processBytes = (isLast: boolean): boolean => {
    if (pendingBytes.length === 0) {
      return true;
    }

    // 字节重叠区：一个 UTF-16 单元最多 4 字节，4 倍覆盖 overlapChars 的语义
    const overlapBytes = overlap * 4;
    let cut = pendingBytes.length;
    if (!isLast) {
      if (pendingBytes.length <= overlapBytes * 2) {
        return true;
      }
      const target = pendingBytes.length - overlapBytes;
      const floor = Math.max(0, target - overlapBytes);
      const newline = pendingBytes.lastIndexOf(0x0a, target - 1);
      if (newline >= floor && newline >= 0) {
        cut = newline + 1;
      } else {
        // 整块没有换行：按长度硬切，退到 UTF-8 字符边界（不能落在续字节上）
        cut = byteCharFloor(pendingBytes, Math.max(1, target));
      }
    }

    const budget = Math.max(1, limit - hits.length + 32);
    const placed = core.putBytes(pendingBytes);
    if (!core.utf8ValidAt(placed.ptr, placed.len)) {
      // 探测漏网的非法序列：整份退回字符串路径重扫，结果与旧版一致
      byteFallback = true;
      return false;
    }
    let matches;
    try {
      matches = findMatchesAt(core, handle, placed.ptr, placed.len, budget);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      return false;
    }
    if (matches.length >= budget) {
      truncated = true;
    }
    const starts = core.lineStartsAt(placed.ptr, placed.len);

    for (const match of matches) {
      if (!isLast && match.start >= cut) {
        continue;
      }
      if (!isLast && match.start + match.len >= pendingBytes.length) {
        continue;
      }
      const line = byteLineIndexOf(starts, match.start);
      const end = byteLineIndexOf(starts, match.start + match.len);
      const lineFrom = starts[line];
      const lineTo = line + 1 < starts.length ? starts[line + 1] : pendingBytes.length;
      const column = utf16Length(pendingBytes.subarray(lineFrom, match.start));
      const endFrom = starts[end];
      const endColumn = utf16Length(pendingBytes.subarray(endFrom, match.start + match.len));
      const parts = previewFromBytes(pendingBytes, lineFrom, lineTo, column, match.start, match.start + match.len);
      hits.push({
        line: lineBase + line,
        column: line === 0 ? columnBase + column : column,
        endLine: lineBase + end,
        endColumn: end === 0 ? columnBase + endColumn : endColumn,
        preview: parts.preview,
        prefix: parts.prefix,
        matchLen: parts.matchLen,
      });
      if (hits.length >= limit) {
        truncated = true;
        return false;
      }
    }

    const lineIndex = byteLineIndexOf(starts, cut);
    lineBase += lineIndex;
    // 硬切（整块没有换行）时 lineIndex 为 0，此时列偏移在原有的基础上累加
    columnBase =
      (lineIndex === 0 ? columnBase : 0) + utf16Length(pendingBytes.subarray(starts[lineIndex], cut));
    pendingBytes = pendingBytes.slice(cut);
    return true;
  };

  try {
    for await (const raw of stream) {
      if (options.token?.isCancellationRequested) {
        cancelled = true;
        break;
      }
      const chunk = raw as Uint8Array;
      if (bytesRead + chunk.length > options.maxBytes) {
        tooLarge = true;
        break;
      }
      bytesRead += chunk.length;

      if (!decoder && !utf8ByteMode) {
        const probe = detectEncoding(chunk);
        if (probe.kind === 'binary') {
          binary = true;
          break;
        }
        encoding = probe.kind;
        if (probe.kind === 'utf-8' && allowBytePath) {
          utf8ByteMode = true;
          pendingBytes = concatBytes(pendingBytes, chunk.subarray(probe.skip));
        } else {
          decoder = makeDecoder(probe.kind);
          pending += decoder.decode(chunk.subarray(probe.skip));
        }
      } else if (utf8ByteMode) {
        pendingBytes = concatBytes(pendingBytes, chunk);
      } else {
        pending += decoder!.decode(chunk);
      }

      let cont: boolean;
      if (utf8ByteMode) {
        cont = processBytes(false);
        if (byteFallback) {
          break;
        }
      } else {
        cont = process(false);
      }
      if (!cont) {
        stopped = true;
        break;
      }
      options.onProgress?.({ bytesRead, lines: lineBase, hits: hits.length });
    }

    if (!binary && !tooLarge && !cancelled && !stopped && !failure && !byteFallback) {
      if (utf8ByteMode) {
        processBytes(true);
      } else {
        if (decoder) {
          pending += decoder.flush();
        }
        process(true);
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const notLocal =
      bytesRead === 0 && (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR');
    if (notLocal) {
      unsupported = true;
    } else {
      failure = error instanceof Error ? error.message : String(error);
    }
  } finally {
    stream.destroy();
  }

  if (byteFallback) {
    return { result: { kind: 'ok', hits: [], bytesRead, lines: 0, truncated: false, encoding }, fallback: true };
  }

  const kind: StreamResult['kind'] = unsupported
    ? 'unsupported'
    : failure
      ? 'error'
      : binary
        ? 'binary'
        : tooLarge
          ? 'tooLarge'
          : cancelled
            ? 'cancelled'
            : 'ok';

  return {
    result: {
      kind,
      hits,
      bytesRead,
      lines: lineBase,
      truncated,
      encoding,
      message: failure || undefined,
    },
    fallback: false,
  };
}

// ------------------------------------------------------------------ 编码探测

export function detectEncoding(chunk: Uint8Array): Detection {
  if (chunk.length >= 2 && chunk[0] === 0xff && chunk[1] === 0xfe) {
    return { kind: 'utf-16le', skip: 2 };
  }
  if (chunk.length >= 2 && chunk[0] === 0xfe && chunk[1] === 0xff) {
    return { kind: 'utf-16be', skip: 2 };
  }
  let skip = 0;
  if (chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) {
    skip = 3;
  }

  const probeEnd = Math.min(chunk.length, BINARY_PROBE_BYTES);
  for (let i = skip; i < probeEnd; i += 1) {
    if (chunk[i] === 0) {
      return { kind: 'binary' };
    }
  }

  return { kind: looksUtf8(chunk, skip, probeEnd) ? 'utf-8' : 'gbk', skip };
}

/**
 * 用前 8 KB 判断是不是 UTF-8。块尾可能切在多字节字符中间，
 * 所以最多丢掉末尾 3 个字节再试，避免把 UTF-8 误判成 GBK。
 */
function looksUtf8(bytes: Uint8Array, from: number, to: number): boolean {
  const probe = bytes.subarray(from, to);
  for (let drop = 0; drop <= 3; drop += 1) {
    const end = probe.length - drop;
    if (end <= 0) {
      return false;
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(probe.subarray(0, end));
      return true;
    } catch {
      // 继续尝试更短的尾巴
    }
  }
  return false;
}

export function makeDecoder(kind: StreamEncoding): ChunkDecoder {
  if (kind === 'gbk') {
    const decoder = iconv.getDecoder('gbk');
    return {
      decode: (chunk) =>
        decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
      flush: () => decoder.end() ?? '',
    };
  }
  const decoder = new TextDecoder(kind, { fatal: false });
  return {
    decode: (chunk) => decoder.decode(chunk, { stream: true }),
    flush: () => decoder.decode(),
  };
}

// ------------------------------------------------------ UTF-8 字节路径小工具

/**
 * 局部解码用。ignoreBOM：行内偶发的 EF BB BF 按 U+FEFF 保留——与流式主解码
 * 一致（文件头 BOM 已在探测时跳过，主解码流里 BOM 只会以普通字符出现）。
 */
const sliceDecoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

function decodeUtf8(bytes: Uint8Array): string {
  return sliceDecoder.decode(bytes);
}

/** 字节段对应的 UTF-16 码元数：每字符 1 单元，4 字节序列（astral）占 2 单元 */
function utf16Length(bytes: Uint8Array): number {
  let units = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (b < 0x80 || b >= 0xc0) {
      units += 1;
      if (b >= 0xf0) {
        units += 1;
      }
    }
  }
  return units;
}

/** 最后一个 `starts[i] <= offset` 的下标（字节版，starts 为 Uint32Array） */
function byteLineIndexOf(starts: Uint32Array, offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/** 硬切点退到 UTF-8 字符边界：不能落在续字节（10xxxxxx）上 */
function byteCharFloor(bytes: Uint8Array, target: number): number {
  let cut = target;
  while (cut > 1 && (bytes[cut] & 0xc0) === 0x80) {
    cut -= 1;
  }
  return cut;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) {
    return b;
  }
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** 字节版 previewAt：命中行局部解码后复用 previewOf；超长行只解码命中附近窗口 */
function previewFromBytes(
  bytes: Uint8Array,
  lineFrom: number,
  lineTo: number,
  column: number,
  matchStart: number,
  matchEnd: number,
): { preview: string; prefix: number; matchLen: number } {
  // 匹配长度按行尾截断（跨行匹配的预览长度与字符串路径的 previewOf 截断一致）
  const matchLen = utf16Length(bytes.subarray(matchStart, Math.min(matchEnd, lineTo)));
  if (lineTo - lineFrom <= HUGE_LINE) {
    return previewOf(decodeUtf8(bytes.subarray(lineFrom, lineTo)), column, matchLen);
  }

  // 超长行：只解码命中附近。余量按最坏 4 字节/字符放宽，窗口内容与
  // 字符串路径可能相差几个字符（多字节行），行列与匹配不受影响
  const lead = (PREVIEW_LEAD + 64) * 4;
  const span = (PREVIEW_WINDOW + PREVIEW_LEAD) * 4;
  let left = Math.max(lineFrom, matchStart - lead);
  // 退到字符边界：窗口起点落在续字节上会产生 U+FFFD 垃圾前缀，把 prefix 推偏
  while (left > lineFrom && (bytes[left] & 0xc0) === 0x80) {
    left -= 1;
  }
  const right = Math.min(lineTo, left + span);
  const colInWindow = utf16Length(bytes.subarray(left, matchStart));
  const parts = previewOf(decodeUtf8(bytes.subarray(left, right)), colInWindow, matchLen);
  if (left > lineFrom) {
    parts.preview = `…${parts.preview}`;
    parts.prefix += 1;
  }
  return parts;
}

// -------------------------------------------------------------------- 小工具

/** 最后一个 `starts[i] <= offset` 的下标，也就是 offset 所在的行号。 */
function lineIndexOf(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

function previewAt(
  buffer: string,
  starts: number[],
  line: number,
  column: number,
  matchLen: number,
): { preview: string; prefix: number; matchLen: number } {
  const from = starts[line];
  const to = line + 1 < starts.length ? starts[line + 1] : buffer.length;
  if (to - from <= HUGE_LINE) {
    return previewOf(buffer.slice(from, to), column, matchLen);
  }

  // 超长行：只截命中附近，避免为每一处命中复制整行
  const left = Math.max(from, from + column - PREVIEW_LEAD - 1);
  const right = Math.min(to, left + PREVIEW_WINDOW + PREVIEW_LEAD);
  const parts = previewOf(buffer.slice(left, right), column - (left - from), matchLen);
  if (left > from) {
    parts.preview = `…${parts.preview}`;
    parts.prefix += 1;
  }
  return parts;
}

function previewOf(
  line: string,
  column: number,
  matchLen: number,
): { preview: string; prefix: number; matchLen: number } {
  const text = line.replace(/\r?\n$/, '');
  if (text.length <= PREVIEW_WINDOW) {
    return {
      preview: text,
      prefix: column,
      matchLen: Math.min(matchLen, Math.max(0, text.length - column)),
    };
  }

  let start = Math.max(0, column - PREVIEW_LEAD);
  start = Math.min(start, text.length - PREVIEW_WINDOW);
  const sliced = text.slice(start, start + PREVIEW_WINDOW);
  const leading = start > 0 ? '…' : '';
  const trailing = start + PREVIEW_WINDOW < text.length ? '…' : '';
  return {
    preview: leading + sliced + trailing,
    prefix: column - start + leading.length,
    matchLen: Math.max(1, Math.min(matchLen, PREVIEW_WINDOW)),
  };
}
