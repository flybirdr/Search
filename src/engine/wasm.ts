import { readFileSync } from 'node:fs';
import { t } from '../i18n-core';

export const FLAG_IGNORE_CASE = 1 << 0;
export const FLAG_MULTILINE = 1 << 1;
export const FLAG_DOTALL = 1 << 2;
export const FLAG_WHOLE_WORD = 1 << 3;

export const MODE_NORMAL = 0;
export const MODE_EXTENDED = 1;
export const MODE_REGEX = 2;

export type SearchMode = 'normal' | 'extended' | 'regex';

export interface CoreMatch {
  /** Offset in UTF-8 bytes. */
  start: number;
  /** Length in UTF-8 bytes. */
  len: number;
}

interface CoreExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  compile(patPtr: number, patLen: number, mode: number, flags: number, backtrack: number): number;
  find_all(handle: number, ptr: number, len: number, limit: number): number;
  utf8_valid(ptr: number, len: number): number;
  line_starts(ptr: number, len: number): number;
  line_count(ptr: number, len: number, upto: number): number;
  replace_all(
    handle: number,
    ptr: number,
    len: number,
    replPtr: number,
    replLen: number,
    limit: number,
  ): number;
  expand_at(
    handle: number,
    ptr: number,
    len: number,
    start: number,
    end: number,
    replPtr: number,
    replLen: number,
  ): number;
  last_error_ptr(): number;
  last_error_len(): number;
}

export function modeToNumber(mode: SearchMode): number {
  switch (mode) {
    case 'extended':
      return MODE_EXTENDED;
    case 'regex':
      return MODE_REGEX;
    default:
      return MODE_NORMAL;
  }
}

/**
 * Thin, synchronous wrapper over the Rust core compiled to wasm.
 * All strings cross the boundary as UTF-8 and results come back as byte offsets.
 */
export class SearchCore {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder('utf-8');

  /** 可复用的暂存区：跨调用保活，避免每个文件 alloc/dealloc + 内存反复增长。 */
  private scratchPtr = 0;
  private scratchCap = 0;

  private constructor(private readonly ex: CoreExports) {}

  static async load(wasmPath: string): Promise<SearchCore> {
    const bytes = readFileSync(wasmPath);
    const module = await WebAssembly.compile(bytes);
    const instance = await WebAssembly.instantiate(module, {});
    return new SearchCore(instance.exports as unknown as CoreExports);
  }

  compile(
    pattern: string,
    mode: number,
    flags: number,
    backtrackLimit: number,
  ): number {
    const { ptr, len } = this.write(pattern);
    try {
      const handle = this.ex.compile(ptr, len, mode, flags, backtrackLimit);
      if (handle === 0) {
        throw new Error(this.readError() || t('表达式编译失败'));
      }
      return handle;
    } finally {
      this.dealloc(ptr, len);
    }
  }

  findAll(handle: number, text: string, limit: number): CoreMatch[] {
    const { ptr, len } = this.write(text);
    try {
      return this.runFindAll(handle, ptr, len, limit);
    } finally {
      this.dealloc(ptr, len);
    }
  }

  /**
   * 把字节放进内核线性内存的**复用暂存区**，返回 (ptr, len) 供 findAllAt /
   * lineStartsAt 使用。暂存区按需扩容（1.5 倍策略）并跨调用保活——扫描循环里
   * 每个文件都走一遍 alloc/copy/dealloc 会带来可观的分配器与 memory.grow 开销。
   *
   * 注意：返回的 ptr 只在下一次 putBytes 之前有效（同一段内存会被复写）。
   */
  putBytes(bytes: Uint8Array): { ptr: number; len: number } {
    const len = bytes.length;
    if (this.scratchCap < len) {
      if (this.scratchPtr !== 0) {
        this.ex.dealloc(this.scratchPtr, this.scratchCap);
        this.scratchPtr = 0;
        this.scratchCap = 0;
      }
      // 下限 64KB：常见源文件一整天都在这个量级，避免小文件反复 alloc
      const cap = Math.max(len, 1 << 16);
      this.scratchPtr = this.ex.alloc(cap) >>> 0;
      this.scratchCap = cap;
    }
    if (len > 0 && this.scratchPtr !== 0) {
      // memory 可能因内核侧的输出分配而 grow，视图必须现取
      new Uint8Array(this.ex.memory.buffer, this.scratchPtr, len).set(bytes);
    }
    return { ptr: this.scratchPtr, len };
  }

  /**
   * 字节直传版 findAll：调用方已有 UTF-8 字节（比如刚从磁盘读出的文件），
   * 直接拷进线性内存匹配，省掉「字节→字符串→字节」的两次全量转码。
   * 返回的 start/len 是 UTF-8 字节偏移，与 findAll 一致。
   */
  findAllBytes(handle: number, bytes: Uint8Array, limit: number): CoreMatch[] {
    const placed = this.putBytes(bytes);
    return this.findAllAt(handle, placed.ptr, placed.len, limit);
  }

  /** findAllBytes 的两段式版本：字节由 putBytes 预先放入（配合 lineStartsAt 免二次拷贝）。 */
  findAllAt(handle: number, ptr: number, len: number, limit: number): CoreMatch[] {
    return this.runFindAll(handle, ptr, len, limit);
  }

  /**
   * 行起点表：下沉在内核里按字节扫 0x0A / 0x0D（行分割语义与编辑器一致：
   * \n、\r\n、孤立 \r 都算换行），返回紧凑的 Uint32Array 而不是 JS 数字数组。
   */
  lineStartsBytes(bytes: Uint8Array): Uint32Array {
    const placed = this.putBytes(bytes);
    return this.lineStartsAt(placed.ptr, placed.len);
  }

  /**
   * 校验暂存区里的字节是否为合法 UTF-8（内核侧带 ASCII 快速路径）。
   * 取代 JS 侧 TextDecoder fatal 的全量解码扫描——那个不仅要扫一遍字节，
   * 还会为「只是为了分类」的结果分配一个完整字符串（纯 GC 浪费）。
   * NUL 二进制探测不在这里做：语义保持「只查前 8192 字节」，仍在 JS 侧。
   */
  utf8ValidAt(ptr: number, len: number): boolean {
    return this.ex.utf8_valid(ptr, len) === 1;
  }

  /** lineStartsBytes 的两段式版本：字节由 putBytes 预先放入。 */
  lineStartsAt(ptr: number, len: number): Uint32Array {
    const outPtr = this.ex.line_starts(ptr, len) >>> 0;
    if (outPtr === 0) {
      throw new Error(this.readError() || t('行起点计算失败'));
    }
    const view = new DataView(this.ex.memory.buffer);
    const count = view.getUint32(outPtr, true);
    try {
      const starts = new Uint32Array(count);
      for (let i = 0; i < count; i += 1) {
        starts[i] = view.getUint32(outPtr + 4 + i * 4, true);
      }
      return starts;
    } finally {
      this.ex.dealloc(outPtr, 4 + count * 4);
    }
  }

  /**
   * 只数行数，不产出行起点表。
   *
   * 分块搜索里每块都要知道「这块覆盖多少行」才能给后面的块算行号基准，
   * 但绝大多数块一条命中都没有——为它们建一整张行起点表（每行 4 字节，
   * 4MB 块 ≈ 800KB）再拷出 wasm 边界，实测只有 757 MB/s，比匹配本身慢 4 倍，
   * 直接把并行收益吃掉。这里只返回 [0, upto) 内的行首个数，
   * 语义与 lineStartsAt 完全一致（\n、\r\n、孤立 \r 都算换行）。
   */
  lineCountAt(ptr: number, len: number, upto: number): number {
    return this.ex.line_count(ptr, len, upto) >>> 0;
  }

  private runFindAll(handle: number, ptr: number, len: number, limit: number): CoreMatch[] {
    let outPtr = 0;
    try {
      outPtr = this.ex.find_all(handle, ptr, len, limit) >>> 0;
      if (outPtr === 0) {
        throw new Error(this.readError() || t('搜索失败'));
      }
      const view = new DataView(this.ex.memory.buffer);
      const count = view.getUint32(outPtr, true);
      const matches: CoreMatch[] = new Array(count);
      for (let i = 0; i < count; i += 1) {
        matches[i] = {
          start: view.getUint32(outPtr + 4 + i * 8, true),
          len: view.getUint32(outPtr + 8 + i * 8, true),
        };
      }
      this.ex.dealloc(outPtr, 4 + count * 8);
      outPtr = 0;
      return matches;
    } finally {
      if (outPtr !== 0) {
        this.ex.dealloc(outPtr, 4 + countOf(this.ex, outPtr) * 8);
      }
    }
  }

  replaceAll(handle: number, text: string, replacement: string, limit: number): string {
    const haystack = this.write(text);
    const repl = this.write(replacement);
    let outPtr = 0;
    try {
      outPtr = this.ex.replace_all(handle, haystack.ptr, haystack.len, repl.ptr, repl.len, limit) >>> 0;
      if (outPtr === 0) {
        throw new Error(this.readError() || t('替换失败'));
      }
      const view = new DataView(this.ex.memory.buffer);
      const byteLen = view.getUint32(outPtr, true);
      const bytes = new Uint8Array(this.ex.memory.buffer, outPtr + 4, byteLen);
      const result = this.decoder.decode(bytes);
      this.ex.dealloc(outPtr, 4 + byteLen);
      outPtr = 0;
      return result;
    } finally {
      if (outPtr !== 0) {
        this.ex.dealloc(outPtr, 4 + countOf(this.ex, outPtr));
      }
      this.dealloc(repl.ptr, repl.len);
      this.dealloc(haystack.ptr, haystack.len);
    }
  }

  /** Expands the replacement for one match. Offsets are UTF-8 byte offsets. */
  expandAt(handle: number, text: string, start: number, end: number, replacement: string): string {
    const haystack = this.write(text);
    const repl = this.write(replacement);
    let outPtr = 0;
    try {
      outPtr =
        this.ex.expand_at(handle, haystack.ptr, haystack.len, start, end, repl.ptr, repl.len) >>> 0;
      if (outPtr === 0) {
        throw new Error(this.readError() || t('替换失败'));
      }
      const view = new DataView(this.ex.memory.buffer);
      const byteLen = view.getUint32(outPtr, true);
      const bytes = new Uint8Array(this.ex.memory.buffer, outPtr + 4, byteLen);
      const result = this.decoder.decode(bytes);
      this.ex.dealloc(outPtr, 4 + byteLen);
      outPtr = 0;
      return result;
    } finally {
      if (outPtr !== 0) {
        this.ex.dealloc(outPtr, 4 + countOf(this.ex, outPtr));
      }
      this.dealloc(repl.ptr, repl.len);
      this.dealloc(haystack.ptr, haystack.len);
    }
  }

  errorText(): string {
    return this.readError();
  }  private write(text: string): { ptr: number; len: number } {
    const bytes = this.encoder.encode(text);
    const ptr = this.ex.alloc(bytes.length) >>> 0;
    if (bytes.length > 0 && ptr !== 0) {
      new Uint8Array(this.ex.memory.buffer, ptr, bytes.length).set(bytes);
    }
    return { ptr, len: bytes.length };
  }

  private dealloc(ptr: number, len: number): void {
    if (ptr !== 0 && len > 0) {
      this.ex.dealloc(ptr, len);
    }
  }

  private readError(): string {
    const ptr = this.ex.last_error_ptr() >>> 0;
    const len = this.ex.last_error_len() >>> 0;
    if (!ptr || !len) {
      return '';
    }
    const raw = this.decoder.decode(new Uint8Array(this.ex.memory.buffer, ptr, len));
    if (/backtrack/i.test(raw)) {
      return raw + t('（回溯步数超过上限，请简化表达式或调高 flySearch.backtrackLimit）');
    }
    return raw;
  }
}

function countOf(ex: CoreExports, outPtr: number): number {
  return new DataView(ex.memory.buffer).getUint32(outPtr, true);
}
