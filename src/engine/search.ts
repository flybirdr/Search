import { CoreMatch, SearchCore, SearchMode, modeToNumber } from './wasm';

export interface SearchOptions {
  query: string;
  mode: SearchMode;
  caseSensitive: boolean;
  wholeWord: boolean;
  dotAll: boolean;
  backtrackLimit: number;
}

export interface TextMatch {
  /** UTF-16 offset, directly usable with vscode.Range / positionAt. */
  start: number;
  len: number;
}

/** ^ and $ match per line, so multiline is always on. */
export function buildFlags(options: SearchOptions): number {
  let flags = 0;
  if (!options.caseSensitive) flags |= 1 << 0;
  flags |= 1 << 1;
  if (options.dotAll) flags |= 1 << 2;
  if (options.wholeWord) flags |= 1 << 3;
  return flags;
}

export function compileQuery(core: SearchCore, options: SearchOptions): number {
  return core.compile(
    options.query,
    modeToNumber(options.mode),
    buildFlags(options),
    options.backtrackLimit,
  );
}

/**
 * Converts UTF-8 byte offsets from the core into UTF-16 offsets and walks the
 * byte string once, in ascending order, so cost stays linear in text length.
 */
export function mapToUtf16(bytes: Uint8Array, matches: CoreMatch[]): TextMatch[] {
  const out: TextMatch[] = [];
  let bytePos = 0;
  let unitPos = 0;

  for (const match of matches) {
    while (bytePos < match.start) {
      const [step, units] = advance(bytes, bytePos);
      bytePos += step;
      unitPos += units;
    }
    const start = unitPos;
    let cursor = bytePos;
    let units = 0;
    const end = match.start + match.len;
    while (cursor < end) {
      const [step, count] = advance(bytes, cursor);
      cursor += step;
      units += count;
    }
    out.push({ start, len: units });
  }

  return out;
}

function advance(bytes: Uint8Array, index: number): [number, number] {
  const byte = bytes[index];
  if (byte < 0x80) return [1, 1];
  if (byte < 0xc0) return [1, 0];
  if (byte < 0xe0) return [2, 1];
  if (byte < 0xf0) return [3, 1];
  return [4, 2];
}

export function findMatches(
  core: SearchCore,
  handle: number,
  text: string,
  limit: number,
): TextMatch[] {
  const raw = core.findAll(handle, text, limit);
  if (raw.length === 0) {
    return [];
  }
  const bytes = new TextEncoder().encode(text);
  return mapToUtf16(bytes, raw);
}

/**
 * 字节直传版：文本已是 UTF-8 字节时跳过编码，直接返回核心的字节偏移结果。
 * 行号/列/预览由调用方按命中惰性解码（绝大多数文件没有命中，不用碰）。
 */
export function findMatchesBytes(
  core: SearchCore,
  handle: number,
  bytes: Uint8Array,
  limit: number,
): CoreMatch[] {
  return core.findAllBytes(handle, bytes, limit);
}

/**
 * 两段式字节直传：putBytes 把字节放进内核复用暂存区（一次拷贝），随后
 * findMatchesAt / buildLineStartsAt 在同一段内存上分别做匹配和行起点扫描。
 * 扫描循环里同一文件的这两次消费因此只付一次拷贝。
 * 注意：ptr 在下一次 putBytes 前有效。
 */
export function putCoreBytes(core: SearchCore, bytes: Uint8Array): { ptr: number; len: number } {
  return core.putBytes(bytes);
}

export function findMatchesAt(
  core: SearchCore,
  handle: number,
  ptr: number,
  len: number,
  limit: number,
): CoreMatch[] {
  return core.findAllAt(handle, ptr, len, limit);
}

/** 字节已在暂存区时的行起点表（见 putCoreBytes）。 */
export function buildLineStartsAt(core: SearchCore, ptr: number, len: number): Uint32Array {
  return core.lineStartsAt(ptr, len);
}

/**
 * 字节版行起点表：下沉在 Rust 内核里按字节扫 0x0A / 0x0D。
 * 行分割语义与编辑器一致：\n、\r\n、孤立 \r 都算换行（logcat 之类文件里
 * 会混有孤立 \r，只数 \n 会让行号比编辑器小，点击跳转落在错误的行上）。
 * 返回内核打包好的 Uint32Array（紧凑、免 JS 逐元素装箱）。
 */
export function buildLineStartsBytes(core: SearchCore, bytes: Uint8Array): Uint32Array {
  return core.lineStartsBytes(bytes);
}

/** 命中行的字节片段解码。行/片段都很小（通常 < 2KB），逐条解码代价可忽略。 */
export function decodeSlice(bytes: Uint8Array, from: number, to: number): string {
  return utf8Slice.decode(bytes.subarray(from, to));
}

const utf8Slice = new TextDecoder('utf-8');

/** Converts a UTF-16 offset (what vscode.Range uses) to a UTF-8 byte offset. */
export function utf16ToByteOffset(text: string, offset: number): number {
  let bytes = 0;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** 字符串版行起点表：与 buildLineStartsBytes 同语义（\n、\r\n、孤立 \r 都算换行）。 */
export function buildLineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 10) {
      starts.push(i + 1);
    } else if (code === 13 && text.charCodeAt(i + 1) !== 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

export function positionAt(
  lineStarts: ArrayLike<number>,
  offset: number,
): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low, column: offset - lineStarts[low] };
}
