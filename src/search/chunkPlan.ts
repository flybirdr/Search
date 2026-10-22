/**
 * 超大文件并行分块搜索：纯计算部分（尺寸决策 / 边界规划 / 结果合并）。
 *
 * 为什么不复用 stream.ts 的串行分块：串行分块解决的是「内存不随文件变大」，
 * 吞吐仍然是一个核 + 一条顺序读流。几 GB 的日志里搜一个高频词，瓶颈在内核
 * 匹配（每字节一遍扫描），单核就那么多字节/秒。并行分块把同一份文件的字节
 * 区间摊给多个 worker（各自一份 wasm 实例），吞吐随可用核数上升；代价是
 * 边界处理的复杂度，以及 W × 块缓冲的内存。
 *
 * 这个文件里没有任何 I/O 与 worker 依赖：边界规划通过注入的 `readAt` 读字节，
 * 因此可以拿一个内存 Buffer 直接单测，不必落盘。
 */

/** 命中条目：与 workerMain.ts 的 WorkerHit 结构一致（此处不复用其类型，避免循环依赖）。 */
export interface ChunkHit {
  /** 0 基行号；分块内是「块内行号」，合并时再加基准 */
  line: number;
  /** 0 基列号（UTF-16 码元） */
  column: number;
  endLine: number;
  endColumn: number;
  preview: string;
  prefix: number;
  matchLen: number;
}

/** 一块的搜索结果 */
export interface ChunkPart {
  /** 分块序号（升序即文件中的先后） */
  index: number;
  hits: ChunkHit[];
  /** 这块覆盖的行数（末尾不足一块时按实际行数） */
  lines: number;
  /** 这一块命中了单文件上限，结果被截断 */
  capped: boolean;
}

export interface MergedChunks {
  hits: ChunkHit[];
  lines: number;
  truncated: boolean;
}

/**
 * 默认下限：再小的话每块的 open/read + putBytes 拷贝 + find_all 调用开销占比过高。
 *
 * 1MB 的下限让「每 worker 4 块」这条规则说了算：块大小由 `size / (4W)` 决定，
 * 只有它跌破 1MB 时才被这里顶住。16 worker 的机器上，文件要 ≥ 64MB 才会
 * 看到块正好是 1MB（再大块就开始变粗）。2MB 下限会让 32MB 以下的文件喂不满
 * 16 线程（10MB 只能切 5 块 → 只用到 5 个 worker），所以速度优先取 1MB。
 */
export const MIN_CHUNK_BYTES = 1 << 20;
/** 默认上限：再大只是「块更少」，均衡变差、单块重试代价变大 */
export const MAX_CHUNK_BYTES = 64 << 20;
/** 每个 worker 的缓冲预算（块 + 重叠都要装进这里） */
export const DEFAULT_MEMORY_PER_WORKER = 32 << 20;
/**
 * 每个 worker 至少分到这么多块。块数 = 4W 时，最坏情况（所有块等长、
 * 某个 worker 慢一倍）的尾延迟约为总时长的 25%，再少就明显不划算。
 */
export const LOAD_BALANCE_FACTOR = 4;

/** 对齐分块边界时单次向后读的窗口 */
export const ALIGN_WINDOW = 64 * 1024;
/** 单行超长（压缩成一行的 JSON / 单行二进制转文本）时最多向后找这么多字节换行 */
export const MAX_ALIGN_LOOKAHEAD = 8 << 20;

export interface ChunkPolicy {
  /** 可用 worker 数（并发度上限） */
  workers: number;
  /** 每个 worker 的缓冲预算 */
  memoryPerWorker: number;
  /** 跨块匹配需要的重叠字节（单行内模式可以为 0） */
  overlap: number;
  minChunk?: number;
  maxChunk?: number;
}

export interface ChunkSizing {
  chunkSize: number;
  chunkCount: number;
  concurrency: number;
  /** 最终是哪个约束说了话（写日志用） */
  bound: 'optimal' | 'balance' | 'memory' | 'min' | 'max' | 'count';
}

/** 块数上限：每条块都是一次读 + 一条消息 + 一格装配，太多就变成开销本身 */
export const CHUNK_COUNT_CAP = 4096;

/**
 * 块大小按这个粒度向下对齐（4KB = 内存页 / 传统扇区）。
 *
 * 不对齐时每次 `readSync` 的长度会落在扇区中间：内核要么读到下一块再回填、
 * 要么在 page cache 里多装一页，单块固定开销里最不该出现的一项。对齐之后
 * 块长永远是 4KB 的整数倍，读放大消失。
 *
 * 注意对齐的是**块长**，不是块起点——起点必须落在行首（语义要求），不能被
 * 4KB 拉走。所以真正读到的字节区间起点可能不是 4KB 边界，但长度是。
 */
export const CHUNK_ALIGN_BYTES = 4096;

/**
 * 成本最优的块大小：`C* = √(S · c · v / b)`。
 *
 * 单文件总耗时拆成三项（S 字节、c = 每块固定开销 ms、v = 单核吞吐 字节/ms、
 * b = 一批几块）：
 *
 *   T(C) = S/(W·η·v)  +  (S/C)·c  +  C·b/v
 *          理想并行          每块开销      尾延迟
 *
 * 第一项与 C 无关，所以最优在 `-S·c/C² + b/v = 0` 处：**块大小随文件大小按
 * 平方根增长**，文件大 4 倍块只该大 2 倍。旧规则 `S/(4W)` 是线性的，对超大
 * 文件切得过粗——1GB 时给 16MB（尾延迟 48ms），而最优是 6.3MB（19ms）；
 * 8GB 时顶到 64MB 上限（尾延迟 194ms），最优 17.8MB。
 *
 * 常数用的是文件里那两个实测值（330MB/s、0.12ms/块），改它们之前先复测。
 */
export function optimalChunkBytes(size: number, batch = 1): number {
  const s = Math.max(0, size);
  if (s === 0) {
    return 0;
  }
  const b = Math.max(1, batch);
  return Math.sqrt((s * CHUNK_FIXED_MS * SERIAL_BYTES_PER_MS) / b);
}

/**
 * 块大小与并发度。
 *
 * 两个方向的上界取小：
 *
 * 1. **成本最优**（`optimalChunkBytes`）：块越大尾延迟越长、块越小每块开销
 *    占得越多，最优点在 √S 上。这是大文件的**上界**。
 * 2. **负载均衡**（`size / (4W)`）：每 worker 至少 4 块，块数够多才能让慢
 *    worker 的尾延迟压到总时长的 25% 以内。这是小文件的**下界**——小于
 *    ~4W MB 的文件会被它顶住，块比较细，尾延迟自然短。
 *
 * 再夹三道硬约束：
 *
 * 3. **内存**：块 + 重叠是单 worker 的常驻缓冲，必须装进预算（默认 32MB）。
 * 4. **1MB 下限**：块 < 1MB 后 open/read 系统调用、`putBytes` 拷贝、
 *    `find_all` 调用摊到每字节上，固定开销比例超过 10%，吞吐反而下降。
 *    这个下限就是 `S/(4W)` 在小文件上"不起作用"的原因：4MB 文件 8 线程时
 *    均衡档只要求 128KB，被下限抬到 1MB，于是切 4 块。
 * 5. **64MB 上限 + 4096 块数上限**：纯粹是防御，正常文件不会碰到。
 *
 * 并发度 = min(可用 worker 数, 块数)。块数少于 worker 数时多派也没用。
 */
export function chooseChunkSize(size: number, policy: ChunkPolicy): ChunkSizing {
  const workers = Math.max(1, Math.floor(policy.workers));
  const minChunk = Math.max(64 * 1024, Math.floor(policy.minChunk ?? MIN_CHUNK_BYTES));
  const maxChunk = Math.max(minChunk, Math.floor(policy.maxChunk ?? MAX_CHUNK_BYTES));
  const overlap = Math.max(0, Math.floor(policy.overlap));
  const memoryCap = Math.max(minChunk, Math.floor(policy.memoryPerWorker) - overlap);
  const balanceLimit = Math.ceil(Math.max(0, size) / (workers * LOAD_BALANCE_FACTOR));
  const optimal = optimalChunkBytes(size, 1);
  const desired = Math.floor(Math.max(1, Math.min(optimal, balanceLimit)));
  const capped = Math.min(maxChunk, memoryCap);

  // bound 在**对齐之前**判定：对齐会把块长压掉最多 4KB，拿对齐后的值去和
  // min/max/memory 做相等比较会全部失配（0.1.83 踩过这个坑）。
  let raw: number;
  let bound: ChunkSizing['bound'];
  if (desired < minChunk) {
    raw = minChunk;
    bound = 'min';
  } else if (maxChunk <= memoryCap && maxChunk < desired) {
    raw = maxChunk;
    bound = 'max';
  } else if (memoryCap < desired) {
    raw = memoryCap;
    bound = 'memory';
  } else {
    raw = desired;
    bound = balanceLimit < optimal ? 'balance' : 'optimal';
  }
  // 块数兜底：极端大的文件别规划出几万个块
  const countSafe = Math.ceil(Math.max(0, size) / CHUNK_COUNT_CAP);
  if (countSafe > raw) {
    raw = Math.min(countSafe, capped);
    bound = 'count';
  }

  // **向上**对齐：向下取整会把块长压到下限（1MB）以下，而上限那边多出最多
  // 4KB 相对 32MB 预算可以忽略。只有顶到 capped 时退回向下对齐，保证不超预算。
  const base = Math.min(raw, capped);
  let chunkSize = Math.max(CHUNK_ALIGN_BYTES, Math.ceil(base / CHUNK_ALIGN_BYTES) * CHUNK_ALIGN_BYTES);
  if (chunkSize > capped) {
    chunkSize = Math.max(
      CHUNK_ALIGN_BYTES,
      Math.floor(capped / CHUNK_ALIGN_BYTES) * CHUNK_ALIGN_BYTES,
    );
  }
  const chunkCount = Math.max(1, Math.ceil(Math.max(0, size) / chunkSize));
  return { chunkSize, chunkCount, concurrency: Math.min(workers, chunkCount), bound };
}

/**
 * 收益模型的标定常数。都是实测值，改之前先复测：
 *
 * - 串行吞吐 330MB/s：120MB 日志、页缓存热、单核字节路径匹配（361ms/份）。
 * - 并行效率 0.6：同一次实测 8 线程跑出 4.75x，4.75/8 ≈ 0.59。异构核（P+E）
 *   下 16 线程也上不到 12x——E-core 单线程吞吐只有 P-core 的 ~55%，所以
 *   16 线程的现实上限大约 8~9x，不是「线程数 × 0.8」。
 * - 每文件 1.5ms：探编码 + plan 往返 + 装配，与块数无关，是分块协议的门票。
 * - 每块 0.12ms：readSync + putBytes 拷贝 + find_all 调用 + 结果封送。
 */
export const SERIAL_BYTES_PER_MS = 330 * 1024;
export const PARALLEL_EFFICIENCY = 0.6;
export const PLAN_FIXED_MS = 1.5;
export const CHUNK_FIXED_MS = 0.12;
/** 净收益门槛：4ms（能感觉到）与 15%（随机器快慢自动缩放）取大 */
export const MIN_GAIN_MS = 4;
export const MIN_GAIN_RATIO = 0.15;

/** 收益估算结果：测试与日志共用，避免两处算法漂移。 */
export interface ChunkGain {
  /** 整份串行的预估耗时 */
  serialMs: number;
  /** 分块后的预估耗时（理想并行 + 固定开销） */
  parallelMs: number;
  /** 净省下的毫秒数，可能为负 */
  gainMs: number;
  /** 这次要超过的阈值 */
  needed: number;
  /** 分块是否划算 */
  worth: boolean;
  chunkSize: number;
  chunkCount: number;
  concurrency: number;
}

/**
 * 这个文件值不值得分块——用「时间预算」代替体积门槛。
 *
 * 分块的成本是实打实的：每个文件一次 plan 往返 + 装配（1.5ms），每块一次的
 * 读/拷贝/调用（0.12ms）。收益是 `串行耗时 × (1 − 1/有效并发)`。所以判据是
 * 净收益要同时超过 4ms 和串行耗时的 15%：
 *
 * - 4ms 是能被感知的下限，省 1ms 不值得让结果晚到、日志更乱；
 * - 15% 让门槛随机器快慢缩放：慢盘上串行耗时大，小文件也值得拆；快盘上
 *   同样的文件拆了没意思。
 *
 * 块数 < 2 或并发 < 2 一律不拆（那只是白付 1.5ms）。
 */
export function estimateChunkGain(size: number, policy: ChunkPolicy): ChunkGain {
  const sizing = chooseChunkSize(size, policy);
  const serialMs = Math.max(0, size) / SERIAL_BYTES_PER_MS;
  const effective = Math.max(1, sizing.concurrency * PARALLEL_EFFICIENCY);
  const parallelMs = serialMs / effective + PLAN_FIXED_MS + sizing.chunkCount * CHUNK_FIXED_MS;
  const gainMs = serialMs - parallelMs;
  const needed = Math.max(MIN_GAIN_MS, serialMs * MIN_GAIN_RATIO);
  return {
    serialMs,
    parallelMs,
    gainMs,
    needed,
    worth: sizing.chunkCount >= 2 && sizing.concurrency >= 2 && gainMs > needed,
    chunkSize: sizing.chunkSize,
    chunkCount: sizing.chunkCount,
    concurrency: sizing.concurrency,
  };
}

/** `estimateChunkGain` 的布尔版，调用点用这个。 */
export function shouldChunk(size: number, policy: ChunkPolicy): boolean {
  return estimateChunkGain(size, policy).worth;
}

/**
 * 拥挤闸门的分母：这个文件只占单 worker「剩余工作量」的这一小角时，池子还
 * 不缺活干，拆开它只是把别的活顺延，不值得付装配与消息往返。
 *
 * 判据必须按**字节**算，不能按文件个数：kernel 树 8 万个文件里混着 300 个
 * 6.5MB 的自动生成头文件，按个数算只占 0.4%（永远不值得拆），按字节算是
 * 一半以上——尤其是它们路径连续、被同一个 worker 一口气领走的时候，那个
 * worker 要单干好几秒，其它线程却在扫几毫秒的小文件。
 */
export const CROWD_SHARE = 0.25;

/**
 * 现在该不该把这个文件的区间合并成单块（不并行）。
 *
 * @param size      文件字节数
 * @param pending   池子待办项数（队列 + 已派未回）
 * @param avgBytes  已见文件的平均大小，0 表示还没有样本
 * @param workers   池子线程数
 * @param cap       拥挤期仍然分块的体积上限，0 = 关闭闸门（永远分块）
 */
export function isCrowdedForChunk(
  size: number,
  pending: number,
  avgBytes: number,
  workers: number,
  cap: number,
  share = CROWD_SHARE,
): boolean {
  if (cap <= 0) {
    return false;
  }
  if (size > cap) {
    // 比闸门上限还大：本身就是长尾，早摊开早结束
    return false;
  }
  if (avgBytes > 0) {
    const perWorker = (Math.max(0, pending) * avgBytes) / Math.max(1, workers);
    return size < perWorker * share;
  }
  // 还没有 stat 样本（每场搜索的头几个文件）：退回按个数判断
  return pending >= Math.max(1, workers) * 2;
}

export interface ChunkRange {
  index: number;
  /** 起点：一定是行首（除第 0 块 = 0） */
  start: number;
  /** 归属终点：这块负责的匹配「起点」必须 < end；end 也是行首（最后一块 = size） */
  end: number;
  /** 实际读取终点：覆盖跨块匹配所需的重叠，到文件末尾截断 */
  readEnd: number;
}

/** 注入式读取：`readAt(from, to)` 返回 [from, to) 的字节（可能被 EOF 截短）。 */
export type ReadAt = (from: number, to: number) => Uint8Array;

export type PlanResult = { ranges: ChunkRange[] } | { fallback: 'long-line' };

/**
 * 规划分块区间。
 *
 * 所有 `start` 都落在行首（`\n` 之后、`\r\n` 之后、孤立 `\r` 之后），这样每块
 * 单独搜索时：
 * - 行号可以从块内行号 + 基准行号得到（行号由每块自己数）；
 * - 列号 / 预览按「块内行首」算与整文件一致（起点是行首，第一行就是完整的）；
 * - 单行内的模式**完全不需要重叠**，边界天然安全。
 *
 * 唯一的例外是「整块没有换行」（压缩成一行的 JSON / 单行几百 MB 的转储）：
 * 向后找到 `MAX_ALIGN_LOOKAHEAD` 仍没有换行时返回 fallback，调用方退回串行
 * 流式搜索——硬切会切在多字节字符和匹配中间，列号也无从对齐。
 */
export function planChunkRanges(
  size: number,
  chunkSize: number,
  overlap: number,
  readAt: ReadAt,
): PlanResult {
  if (size <= 0) {
    return { ranges: [] };
  }
  const safeChunk = Math.max(1, Math.floor(chunkSize));
  const starts: number[] = [0];
  let nominal = safeChunk;
  // 块数上限兜底：块大小异常小（配置写成 0）时不至于规划出天文数字的块
  const maxChunks = Math.max(1, Math.ceil(size / 64) + 1);
  while (nominal < size && starts.length < maxChunks) {
    const aligned = alignForward(readAt, nominal, size);
    if (aligned === null) {
      return { fallback: 'long-line' };
    }
    if (aligned <= starts[starts.length - 1]) {
      break;
    }
    starts.push(aligned);
    nominal = aligned + safeChunk;
  }

  const ranges: ChunkRange[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1] : size;
    if (end <= start) {
      continue;
    }
    ranges.push({
      index,
      start,
      end,
      readEnd: Math.min(size, end + Math.max(0, overlap)),
    });
  }
  return { ranges };
}

/**
 * 从 from 起找第一个行首。找不到（超过单行容忍长度或到文件尾）返回 null。
 * `\r\n` 两字节都跳过；孤立 `\r` 也算行尾，与编辑器的行分割语义一致。
 */
function alignForward(readAt: ReadAt, from: number, size: number): number | null {
  let pos = from;
  let scanned = 0;
  while (pos < size && scanned < MAX_ALIGN_LOOKAHEAD) {
    const to = Math.min(size, pos + ALIGN_WINDOW);
    const buf = readAt(pos, to);
    if (buf.length === 0) {
      return null;
    }
    for (let i = 0; i < buf.length; i += 1) {
      const byte = buf[i];
      if (byte === 0x0a) {
        return pos + i + 1;
      }
      if (byte === 0x0d) {
        if (i + 1 < buf.length) {
          return buf[i + 1] === 0x0a ? pos + i + 2 : pos + i + 1;
        }
        // 窗口正好切在 \r 后面：再读一个字节确认是不是 \r\n
        const next = readAt(pos + i + 1, Math.min(size, pos + i + 2));
        return next.length > 0 && next[0] === 0x0a ? pos + i + 2 : pos + i + 1;
      }
    }
    scanned += buf.length;
    if (to >= size) {
      return null;
    }
    pos = to;
  }
  return null;
}

/**
 * 合并各块结果：按块序铺开，块内行号加上基准行号。
 * 命中数到 `limit` 就停（与串行的单文件上限语义一致），并把 truncated 置真。
 */
export function mergeChunkParts(parts: ChunkPart[], limit: number): MergedChunks {  const ordered = parts.slice().sort((a, b) => a.index - b.index);
  const max = Math.max(1, Math.floor(limit));
  let base = 0;
  let truncated = false;
  const hits: ChunkHit[] = [];
  for (const part of ordered) {
    if (part.capped) {
      truncated = true;
    }
    for (const hit of part.hits) {
      if (hits.length >= max) {
        truncated = true;
        break;
      }
      // 块内行号 → 全文行号：加上这块之前所有块的行数
      hits.push({ ...hit, line: base + hit.line, endLine: base + hit.endLine });
    }
    base += Math.max(0, part.lines);
  }
  return { hits, lines: base, truncated };
}

/**
 * 去掉末尾被切断的不完整 UTF-8 序列（最多 3 字节）。
 *
 * 块尾是按 `end + overlap` 硬截的，很可能切在一个多字节字符中间。
 * 字节级匹配不关心这个（0x0A 不会出现在续字节里），但 `utf8_valid` 会因此
 * 判整块非法，导致整份文件白退回流式路径。截掉这几个字节即可；截掉的字节
 * 本来也在重叠区里，会由下一块完整覆盖。
 */
export function trimIncompleteUtf8Tail(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) {
    return bytes;
  }
  let i = bytes.length - 1;
  let back = 0;
  while (i >= 0 && back < 4) {
    if ((bytes[i] & 0xc0) !== 0x80) {
      break;
    }
    i -= 1;
    back += 1;
  }
  if (i < 0) {
    return bytes;
  }
  const lead = bytes[i];
  const need = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  return bytes.length - i >= need ? bytes : bytes.subarray(0, i);
}

/**
 * 行起点表里「小于 limit 的行首个数」——即一块覆盖的行数。
 * start 本身是行首会算作这块的第一行；正好落在 limit 上的下一个行首属于下一块。
 */
export function countStartsBefore(starts: ArrayLike<number>, limit: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (starts[mid] < limit) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/** 猜测的重叠上限：多行模式下跨块匹配最多容忍这么长 */
export const DEFAULT_MATCH_OVERLAP = 64 * 1024;

/**
 * 这次搜索到底需不需要重叠区。
 *
 * 分块边界一律落在行首，所以**单行内的模式完全不需要重叠**：任何匹配都
 * 完整落在某一块里，边界天然安全。只有「可能跨越换行」的模式才需要重叠：
 * - 普通模式：`\n` 是两个字符，永远匹配不到真的换行 → 0；
 * - 扩展模式：`\n` / `\r` / `\t` 会被展开成真实字符 → 含 `\n` `\r` 才要；
 * - 正则：开了 `. 匹配换行` 时 `.` 就能跨行；否则看有没有显式的换行转义、
 *   `\s`（含换行）、`[\s\S]`、`\x0a` 这类能命中换行的构造。
 *
 * 判定保守（宁可多给重叠）：多给 64KB 只是每块多读 64KB，而漏判会造成
 * 跨行匹配丢失。
 */
export function overlapForQuery(
  mode: 'normal' | 'extended' | 'regex',
  query: string,
  dotAll: boolean,
  cap = DEFAULT_MATCH_OVERLAP,
): number {
  if (mode === 'normal') {
    return 0;
  }
  if (mode === 'extended') {
    return /\\[nr]/.test(query) ? cap : 0;
  }
  if (dotAll) {
    return cap;
  }
  const crosses =
    /\\[nr]/.test(query) || // \n \r
    /\\s/.test(query) || // \s 含换行
    /\\x0[ad]|\\u000[ad]/i.test(query); // 显式写出换行的字节/码点
  return crosses ? cap : 0;
}
