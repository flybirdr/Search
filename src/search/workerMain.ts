/**
 * 搜索 Worker 主脚本：每个线程一份 wasm 内核 + 一个编译好的查询，
 * 直接用 node:fs 读本地文件，磁盘 I/O 等待和内核匹配真正并行。
 *
 * 这个文件会单独打包成 dist/searchWorker.js（CJS、platform node），
 * **不能 import vscode**——worker 线程里没有扩展宿主的 vscode 模块。
 *
 * 协议（宿主 → worker）：
 * - { type: 'run', options, perFileLimit, maxBytes, streamAbove, check? }
 *   编译查询、进入会话，立即回 need 要活。worker 常驻（收工不退出）。
 *   check 是「结果缓存校验」文件的全局下标集合：这些文件只 statSync 回报
 *   { kind: 'stat', stat }（宿主比对 mtime/size 后直接回放缓存结果），
 *   stat 变了/没有缓存条目的文件照常读盘匹配——校验与扫描在同一场里，
 *   没有 0.1.67 的独立校验场（那要两轮池子启停，且 stat 结果按 24 个/批
 *   冲刷，80k 文件 3300+ 条消息的开销反超 stat 本身）。
 * - { type: 'assign', files: [{path, index}] }：派一批活（work-stealing：
 *   worker 干完一批再要，快的 worker 手里自然攒得多，消除静态分片尾延迟）。
 *   index 是全场搜索的全局文件下标，结果原样带回，宿主不再重映射。
 * - { type: 'drain' }：队列取空，冲掉残余结果回 done。
 * - { type: 'abort' }：尽快停下，冲掉已有结果回 done，然后继续待命。
 *
 * 协议（worker → 宿主）：
 * - { type: 'ready' }：wasm 加载完成，可以派活了。
 * - { type: 'need', want }：要活。want 按上一批耗时自适应（快则翻倍、
 *   慢则折半），兼顾取活往返次数与取消响应速度。
 * - { type: 'batch', results }：一批文件结果，index 是全局文件下标。
 * - { type: 'done' }：本轮收工（进程保留，等下一条 run）。
 * - { type: 'fatal', message }：内核抛错（表达式问题等），本轮作废；
 *   进程退出，由宿主池重建。
 *
 * 性能设计（扫描循环）：
 * - I/O 全同步（statSync/readFileSync）：每个 worker 线程自己发起系统调用，
 *   N 个 worker 就是 N 路真并行 I/O。不能用异步 fs——worker_threads 共享
 *   宿主进程唯一的 libuv 线程池（默认 4 线程），8 个 worker 的 stat/read
 *   全在 4 个线程上排队，I/O 并行度被砍半还要叠加调度开销，实测大工作区
 *   （8 万文件）比同步版慢 3 倍（0.1.50~0.1.54 的回归）。
 * - 取消响应：纯同步循环会饿死事件循环收不到 abort，每批 flush 后用
 *   setImmediate 让事件循环跑一圈。
 * - wasm 内存复用：每个文件的字节只拷贝一次进内核复用暂存区，
 *   匹配（findAllAt）与行起点（lineStartsAt）共用同一份，不再每步重拷。
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import iconv from 'iconv-lite';
import { SearchCore } from '../engine/wasm';
import {
  buildLineStartsAt,
  compileQuery,
  decodeSlice,
  findMatchesAt,
  positionAt,
} from '../engine/search';
import { makeItem } from './preview';
import { streamSearchFile } from './stream';
import { emptyRunStats, type SlowFile, type WorkerRunStats } from './runStats';
import {
  ChunkPolicy,
  ChunkRange,
  chooseChunkSize,
  planChunkRanges,
  shouldChunk,
  trimIncompleteUtf8Tail,
} from './chunkPlan';
import { countFile } from './exactCount';

/** 每个文件的结果。kind 与宿主 legacy 路径的分类一一对应。 */
/** 结果随带的文件元数据：宿主结果缓存用它做 mtime+size 新鲜度校验 */
export interface ResultStat {
  mtimeMs: number;
  size: number;
}

export type PoolFileResult =
  | { index: number; kind: 'hit'; hits: WorkerHit[]; truncated: boolean; bytesRead: number; stat: ResultStat }
  | { index: number; kind: 'miss'; bytesRead: number; stat: ResultStat }
  | { index: number; kind: 'binary'; stat: ResultStat }
  | { index: number; kind: 'tooLarge'; size: number; stat: ResultStat }
  | { index: number; kind: 'error' }
  /** validate 模式专属：只回报 stat，不读文件不扫描（宿主拿去校验结果缓存） */
  | { index: number; kind: 'stat'; stat: ResultStat }
  /**
   * 超大文件：本 worker 只 stat + 探测，不扫。宿主据此把文件切成多块派回同一条
   * 队列（分块条目标 chunkIndex，结果原样带回 index/chunkIndex）。
   */
  | { index: number; kind: 'plan'; size: number; ranges: ChunkRange[]; stat: ResultStat }
  | { index: number; kind: 'count'; count: number; approximate: boolean; size: number; skipped: boolean }
  /** 一块的扫描结果：hits 的行号是「块内行号」，合并时由宿主加基准 */
  | {
      index: number;
      kind: 'chunk';
      chunkIndex: number;
      hits: WorkerHit[];
      lines: number;
      capped: boolean;
      bytesRead: number;
      /** 本块的真实扫描耗时（读+匹配，不含排队）：宿主按文件累加成 file= */
      ms: number;
    }
  /** 分块途中发现不是 UTF-8（BOM / GBK / 二进制）：宿主改用串行路径重扫整个文件 */
  | { index: number; kind: 'chunkUnsupported'; chunkIndex: number };


/** 与 stream.ts 的 StreamHit 同形，宿主两侧用同一套组装代码。 */
export interface WorkerHit {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  preview: string;
  prefix: number;
  matchLen: number;
}

interface RunMessage {
  type: 'run';
  options: {
    query: string;
    mode: 'normal' | 'extended' | 'regex';
    caseSensitive: boolean;
    wholeWord: boolean;
    dotAll: boolean;
    backtrackLimit: number;
  };
  perFileLimit: number;
  maxBytes: number;
  streamAbove: number;
  /** 结果缓存校验：这些全局下标的文件只 statSync 回报，不读盘不匹配 */
  check?: number[];
  /**
   * 超大文件并行分块策略。给了才启用：本 worker 遇到体积超过 `above` 的文件
   * 不自己串行扫，而是回报 plan，由宿主把字节区间派回队列（见 chunkPlan.ts）。
   */
  chunk?: ChunkPolicy & { above: number };
  /**
   * 计数模式（「统计完整数量」）：给了就只数命中不产结果行——每个文件按
   * exactCount 同一套语义（整读 ≤64MB、大文件 4MB 块 + 64KB 重叠）计数，
   * 结果回报 { kind: 'count', count }。与扫描共用同一条 work-stealing 流水线。
   */
  count?: { maxFileBytes: number; wholeLimit: number; chunkBytes: number; overlap: number; perChunkCap: number };
}

/** 宿主派来的活：普通文件只带 path/index；超大文件的分块条目额外带字节区间。 */
export interface PoolWorkItem {
  path: string;
  index: number;
  /** 分块条目：这块在文件里的序号与字节区间（start/end 都是行首） */
  chunkIndex?: number;
  start?: number;
  end?: number;
  readEnd?: number;
  /** 分块不可用（非 UTF-8 / 单行过长）时的重派标记：这个文件只走串行路径 */
  skipChunk?: boolean;
}

type PoolFile = PoolWorkItem;

/** 会话：一条 run 到 done 之间 worker 持有的全部状态 */
interface Session {
  options: RunMessage['options'];
  handle: number;
  perFileLimit: number;
  maxBytes: number;
  streamAbove: number;
  /** 超大文件分块策略（宿主未启用时为 undefined） */
  chunk: RunMessage['chunk'];
  /** 计数模式配置（宿主未启用时为 undefined） */
  count: RunMessage['count'];
  /** 结果缓存校验集：命中的文件只 stat 回报 */
  checkSet: Set<number>;
  pending: PoolFileResult[];
  /** 自上次 flush 以来 pending 里的 stat / 扫描结果数（分别计冲刷阈值） */
  statCount: number;
  scanCount: number;
  /** 下一次 need 想要的文件数（按批处理耗时自适应） */
  want: number;
  busy: boolean;
  /** 本场 run 的聚合统计，收工时随 done 回报给宿主打诊断日志 */
  stats: WorkerRunStats;
}

// SlowFile / WorkerRunStats / emptyRunStats 定义在 runStats.ts（无副作用模块），
// worker 与宿主共用；类型在这里 re-export 供既有引用方使用。
export type { SlowFile, WorkerRunStats };

/** 把一条结果记进统计：kind 计数 + 按类字节 + 最慢榜（保留 5 条）。 */
function trackStats(s: Session, file: PoolFile, r: PoolFileResult, ms: number): void {
  const st = s.stats;
  st.scanned += 1;
  st.kinds[r.kind] = (st.kinds[r.kind] ?? 0) + 1;
  let bytes = 0;
  switch (r.kind) {
    case 'hit':
    case 'miss':
    case 'binary':
      bytes = r.stat.size;
      break;
    case 'tooLarge':
    case 'plan':
      bytes = r.size;
      break;
    case 'chunk':
      bytes = r.bytesRead;
      break;
    case 'count':
      bytes = r.size;
      break;
    default:
      bytes = 0;
  }
  if (r.kind === 'hit' || r.kind === 'miss' || r.kind === 'chunk' || r.kind === 'count') {
    st.readBytes += bytes;
  } else if (r.kind === 'binary') {
    st.binaryBytes += bytes;
  } else if (r.kind === 'tooLarge') {
    st.largeBytes += bytes;
  }
  const entry: SlowFile = { path: file.path, ms, bytes, kind: r.kind };
  if (st.slowest.length < 5) {
    st.slowest.push(entry);
    st.slowest.sort((a, b) => b.ms - a.ms);
  } else if (ms > st.slowest[st.slowest.length - 1].ms) {
    st.slowest[st.slowest.length - 1] = entry;
    st.slowest.sort((a, b) => b.ms - a.ms);
  }
}

const BATCH_SIZE = 24;
/** stat 结果只有几十字节：冲刷阈值放大 ~170 倍，80k 文件的校验消息从
 *  3300+ 条降到 ~20 条（0.1.67 的消息洪水反超 stat 本身的教训） */
const STAT_FLUSH_SIZE = 4096;
const INITIAL_WANT = BATCH_SIZE;
const MIN_WANT = 8;
const MAX_WANT = 512;

const port = parentPort;
if (!port) {
  // 被当作普通模块加载（比如测试环境直接 import）时静默退出
  process.exit(0);
}

let abort = false;
let session: Session | null = null;

let core: SearchCore | undefined;
async function boot(): Promise<void> {
  core = await SearchCore.load((workerData as { wasmPath: string }).wasmPath);
  port!.postMessage({ type: 'ready' });
}
boot().catch((error: unknown) => {
  const text = error instanceof Error ? error.message : String(error);
  port!.postMessage({ type: 'fatal', message: `wasm load: ${text}` });
  process.exit(1);
});

type HostMessage =
  | RunMessage
  | { type: 'abort' }
  | { type: 'assign'; files: PoolFile[] }
  | { type: 'drain' };

port!.on('message', (message: HostMessage) => {
  if (message.type === 'abort') {
    abort = true;
    return;
  }
  if (message.type === 'run') {
    if (session) {
      // 宿主池不会对同一个 worker 并发派活；真发生说明有 bug，宁可响亮失败
      port!.postMessage({ type: 'fatal', message: 'overlapping run message' });
      process.exit(1);
    }
    const checkSet = new Set(message.check ?? []);
    let handle: number;
    try {
      handle = compileQuery(core!, message.options);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      port!.postMessage({ type: 'fatal', message: text });
      process.exit(1);
    }
    abort = false;
    session = {
      options: message.options,
      handle,
      perFileLimit: message.perFileLimit,
      maxBytes: message.maxBytes,
      streamAbove: message.streamAbove,
      chunk: message.chunk,
      count: message.count,
      checkSet,
      pending: [],
      statCount: 0,
      scanCount: 0,
      want: INITIAL_WANT,
      busy: false,
      stats: emptyRunStats(),
    };
    port!.postMessage({ type: 'need', want: session.want });
    return;
  }
  if (message.type === 'assign') {
    if (!session || session.busy) {
      // 迟到消息：忽略（worker 只在要活之后才会收到 assign）
      return;
    }
    handleAssign(message.files).catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      port!.postMessage({ type: 'fatal', message: text });
      process.exit(1);
    });
    return;
  }
  if (message.type === 'drain') {
    if (!session || session.busy) {
      return;
    }
    finishSession();
    return;
  }
});

/** 让事件循环跑一圈（宏任务），否则纯同步循环收不到宿主的 abort 消息 */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function flushPending(s: Session): void {
  if (s.pending.length > 0) {
    port!.postMessage({ type: 'batch', results: s.pending.splice(0, s.pending.length) });
  }
}

/** 收工：冲掉残余结果、回报 done、会话作废（worker 常驻等下一条 run）。 */
function finishSession(): void {
  const s = session;
  session = null;
  abort = false;
  if (s) {
    flushPending(s);
  }
  port!.postMessage(s ? { type: 'done', stats: s.stats } : { type: 'done' });
}

async function handleAssign(files: PoolFile[]): Promise<void> {
  const s = session!;
  s.busy = true;
  try {
    const started = performance.now();
    for (const file of files) {
      if (abort) {
        break;
      }
      const fileStart = performance.now();
      let pushed: PoolFileResult;
      if (s.checkSet.has(file.index)) {
        // 结果缓存校验：只 stat，不读盘不匹配。同步系统调用，N worker 真并行
        pushed = statOnly(file);
        s.pending.push(pushed);
        s.statCount += 1;
      } else if (file.start !== undefined) {
        // 超大文件的一块：开自己的 fd 读自己的区间，与其它 worker 的块互不依赖
        pushed = searchChunk(core!, s.handle, s, file);
        s.pending.push(pushed);
        s.scanCount += 1;
      } else if (s.count) {
        // 计数模式：只数不列，逻辑与 exactCount 同一套（复用 countFile）
        pushed = await countOne(core!, s.handle, s.count, file);
        s.pending.push(pushed);
        s.scanCount += 1;
      } else {
        // loadFile 内部除流式分支外全同步执行（async 包装只为统一类型与让出点），
        // stat/read 都是本线程直接系统调用，不经过 libuv 线程池
        const loaded = await loadFile(core!, s, file);
        if (loaded.kind === 'planned') {
          // 超大文件：不自己串行扫，回报区间让宿主把分块派回队列（全池并行）。
          //
          // 这是**控制消息**，必须立刻冲出去：宿主拿到区间才能把块派回来，
          // 而块越早进队列，其它 worker 越可能顺手领走。压到批末（等本批 24 个
          // 文件都处理完）意味着大文件白等一整个批次，长尾就是这么长出来的，
          // 而且宿主收到 plan 时队列往往已经见底，拥挤判据也就失真了。
          pushed = loaded.result;
          s.pending.push(pushed);
          flushPending(s);
          s.scanCount = 0;
          s.statCount = 0;
          await yieldToEventLoop();
        } else {
          pushed = consumeLoaded(core!, s.handle, s.perFileLimit, loaded);
          s.pending.push(pushed);
        }
        s.scanCount += 1;
      }
      // stat 校验条目不算扫描耗时（只付 stat 的钱），别污染最慢榜
      if (pushed.kind !== 'stat') {
        trackStats(s, file, pushed, performance.now() - fileStart);
      }
      // 冲刷阈值分类计数：扫描结果 24 个/批（取消延迟 ≤ 24 文件），
      // stat 结果 4096 个/批（80k 校验的消息数从 3300+ 降到 ~20）
      if (s.scanCount >= BATCH_SIZE || s.statCount >= STAT_FLUSH_SIZE) {
        flushPending(s);
        s.scanCount = 0;
        s.statCount = 0;
        // 每批让出一次事件循环：接收 abort 消息
        await yieldToEventLoop();
      }
    }
    flushPending(s);
    if (abort) {
      // 取消：不再要活，直接收工；截断语义由宿主统一判
      finishSession();
      return;
    }
    // 自适应取活量：批处理快就翻倍（减少取活往返），慢就折半（保住取消响应）
    const elapsed = performance.now() - started;
    s.stats.busyMs += elapsed;
    if (elapsed < 30) {
      s.want = Math.min(MAX_WANT, s.want * 2);
    } else if (elapsed > 300) {
      s.want = Math.max(MIN_WANT, Math.floor(s.want / 2));
    }
    s.busy = false;
    port!.postMessage({ type: 'need', want: s.want });
  } catch (error) {
    // 内核抛错（表达式问题等）：与宿主 legacy 整读路径一致，整场作废
    const text = error instanceof Error ? error.message : String(error);
    port!.postMessage({ type: 'fatal', message: text });
    process.exit(1);
  }
}

// -------------------------------------------------------------- 加载（I/O 侧）

/** validate 模式的单文件处理：同步 stat，失败按 error 回报（宿主会重新扫描该文件） */
function statOnly(file: PoolFile): PoolFileResult {
  try {
    const st = statSync(file.path);
    return { index: file.index, kind: 'stat', stat: { mtimeMs: st.mtimeMs, size: st.size } };
  } catch {
    return { index: file.index, kind: 'error' };
  }
}

type LoadedFile =
  | { kind: 'bytes'; index: number; bytes: Uint8Array; size: number; placed: { ptr: number; len: number }; stat: ResultStat }
  | { kind: 'streamed'; index: number; size: number; result: Awaited<ReturnType<typeof streamSearchFile>>; stat: ResultStat }
  | { kind: 'binary'; index: number; stat: ResultStat }
  | { kind: 'tooLarge'; index: number; size: number; stat: ResultStat }
  | { kind: 'error'; index: number }
  /** 超大文件：只规划了区间，扫描交给宿主派回的分块条目 */
  | { kind: 'planned'; index: number; result: PoolFileResult; stat: ResultStat };

/**
 * 单文件加载：stat → 分类（tooLarge / 流式 / 整读）。
 * 整读路径用 statSync/readFileSync：本线程直接系统调用，N 个 worker 真并行，
 * 不经过宿主进程共享的 libuv 线程池（默认 4 线程，是 0.1.50~0.1.54 大工作区
 * 扫描慢 3 倍的根因）。分类语义与异步版一致；async 包装只为统一返回类型。
 */
/**
 * 计数模式单文件：stat → 超限跳过 → countFile（与「统计完整数量」同一套
 * 语义，见 exactCount.ts）。统计期间 UI 只等一个总数，结果不产结果行。
 */
async function countOne(
  core: SearchCore,
  handle: number,
  cfg: NonNullable<RunMessage['count']>,
  file: PoolFile,
): Promise<PoolFileResult> {
  const skipped: PoolFileResult = {
    index: file.index,
    kind: 'count',
    count: 0,
    approximate: false,
    size: 0,
    skipped: true,
  };
  let size: number;
  try {
    size = statSync(file.path).size;
  } catch {
    return skipped;
  }
  if (size > cfg.maxFileBytes) {
    return skipped;
  }
  try {
    const counted = await countFile(core, handle, file.path, size, {
      chunkBytes: cfg.chunkBytes,
      overlap: cfg.overlap,
      wholeLimit: cfg.wholeLimit,
      cap: cfg.perChunkCap,
    });
    return {
      index: file.index,
      kind: 'count',
      count: counted.count,
      approximate: counted.approximate,
      size,
      skipped: false,
    };
  } catch {
    return skipped;
  }
}

async function loadFile(
  core: SearchCore,
  s: Session,
  file: PoolFile,
): Promise<LoadedFile> {
  const fsPath = file.path;
  let stat: ResultStat;
  try {
    const st = statSync(fsPath);
    // 读前取 mtime：文件在读后改动 → 下次搜索 stat 对不上 → 缓存自动判过期
    stat = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { kind: 'error', index: file.index };
  }
  if (stat.size > s.maxBytes) {
    return { kind: 'tooLarge', index: file.index, size: stat.size, stat };
  }

  // 二进制预探测（0.1.115）：整读/规划之前先花一次 8KB 的读拦二进制——
  // NUL 探测语义与 decodeInto 完全一致（同样只看前 8192 字节、同样放行
  // UTF-16 BOM），却把「读 2MB 只为发现是二进制」的浪费砍掉。实测大工作区
  // 一场搜索 bin=2.6GB 的无效读全部来自这里。≤ 64KB 的文件整读本身也就是
  // 一两次系统调用，不值得多付一次 open。
  if (stat.size > 65536) {
    if (isBinaryHead(fsPath)) {
      return { kind: 'binary', index: file.index, stat };
    }
  }

  // 超大文件：先探测编码 + 规划分块，自己不扫——把区间交回宿主派给全池。
  // 规划/探测不通过（UTF-16、GBK、二进制、单行过长）就地退回串行流式，
  // 不再往返一趟宿主（那会让这个大文件多等一个来回）。
  //
  // shouldChunk 是纯计算的收益判据（worker 手上的 size 就够算）：拆了省不下
  // 4ms 就压根不回报 plan，省掉一次往返——2~4MB 这种档位不该付这笔门票。
  const chunk = s.chunk;
  if (chunk && !file.skipChunk && stat.size > chunk.above && shouldChunk(stat.size, chunk)) {
    const ranges = planHugeFile(fsPath, stat.size, chunk);
    if (ranges) {
      return {
        kind: 'planned',
        index: file.index,
        stat,
        result: { index: file.index, kind: 'plan', size: stat.size, ranges, stat },
      };
    }
    const streamed = await streamSearchFile(fsPath, core, s.handle, {
      limit: s.perFileLimit + 1,
      maxBytes: s.maxBytes,
    });
    return { kind: 'streamed', index: file.index, size: stat.size, result: streamed, stat };
  }

  // 大文件流式：内存与文件体积无关，worker 里同样适用（异步分块读，低频路径）
  // skipChunk 的条目是「分块时发现不是 UTF-8」的重派，同样必须走流式而不是整读
  const forceStream = file.skipChunk === true && chunk !== undefined && stat.size > chunk.above;
  if (stat.size > s.streamAbove || forceStream) {
    const streamed = await streamSearchFile(fsPath, core, s.handle, {
      limit: s.perFileLimit + 1,
      maxBytes: s.maxBytes,
    });
    return { kind: 'streamed', index: file.index, size: stat.size, result: streamed, stat };
  }

  // 小文件整读：同步读盘，读盘期间本线程不做别的——并行靠 worker 数量堆
  let buffer: Buffer;
  try {
    buffer = readFileSync(fsPath);
  } catch {
    return { kind: 'error', index: file.index };
  }
  // decodeInto 返回 null 即二进制（NUL 探测 / GBK 转码失败），不是错误
  const decoded = decodeInto(core, buffer);
  if (decoded === null) {
    return { kind: 'binary', index: file.index, stat };
  }
  return {
    kind: 'bytes',
    index: file.index,
    bytes: decoded.bytes,
    size: stat.size,
    placed: decoded.placed,
    stat,
  };
}

// ------------------------------------------------------------ 消费（CPU 侧）

/** 把加载结果转成扫描结果：只有整读路径在这里碰内核（流式在加载时已完成）。 */
function consumeLoaded(
  core: SearchCore,
  handle: number,
  perFileLimit: number,
  loaded: LoadedFile,
): PoolFileResult {
  const index = loaded.index;
  switch (loaded.kind) {
    case 'error':
      return { index, kind: 'error' };
    case 'planned':
      // 分块条目由 assign 循环提前拦下，不会走到这里
      return loaded.result;
    case 'binary':
      return { index, kind: 'binary', stat: loaded.stat };
    case 'tooLarge':
      return { index, kind: 'tooLarge', size: loaded.size, stat: loaded.stat };
    case 'streamed':
      return streamedResult(loaded.result, index, loaded.size, perFileLimit, loaded.stat);
    case 'bytes': {
      // 字节已在 loadFile 阶段放入内核暂存区并完成 UTF-8 校验（decodeInto），
      // 这里直接用 (ptr, len) 匹配，不再二次拷贝
      const placed = loaded.placed;
      const matches = findMatchesAt(core, handle, placed.ptr, placed.len, perFileLimit + 1);
      if (matches.length === 0) {
        return { index, kind: 'miss', bytesRead: placed.len, stat: loaded.stat };
      }
      const truncated = matches.length > perFileLimit;
      return {
        index,
        kind: 'hit',
        hits: byteHits(core, loaded.bytes, placed, matches, perFileLimit),
        truncated,
        bytesRead: placed.len,
        stat: loaded.stat,
      };
    }
  }
}

function streamedResult(
  streamed: Awaited<ReturnType<typeof streamSearchFile>>,
  index: number,
  size: number,
  perFileLimit: number,
  stat: ResultStat,
): PoolFileResult {
  if (streamed.kind === 'binary') {
    return { index, kind: 'binary', stat };
  }
  if (streamed.kind === 'tooLarge') {
    return { index, kind: 'tooLarge', size, stat };
  }
  if (streamed.kind === 'error') {
    return { index, kind: 'error' };
  }
  if (streamed.kind === 'unsupported') {
    // 本地路径打不开（权限等），与宿主整读失败同义
    return { index, kind: 'error' };
  }
  // ok / cancelled：cancelled 的部分命中照样上报，capped 由宿主统一判
  if (streamed.hits.length > 0) {
    return {
      index,
      kind: 'hit',
      hits: streamed.hits.slice(0, perFileLimit),
      truncated: streamed.truncated || streamed.hits.length > perFileLimit,
      bytesRead: streamed.bytesRead,
      stat,
    };
  }
  return { index, kind: 'miss', bytesRead: streamed.bytesRead, stat };
}

/**
 * 字节匹配结果 → 结果条目（行列按 UTF-16 码元换算，与宿主整读路径一致）。
 * 行起点走 lineStartsAt：字节已在暂存区，不再二次拷贝。
 */
function byteHits(
  core: SearchCore,
  bytes: Uint8Array,
  placed: { ptr: number; len: number },
  matches: { start: number; len: number }[],
  perFileLimit: number,
): WorkerHit[] {
  const lineStarts = buildLineStartsAt(core, placed.ptr, placed.len);
  return matches.slice(0, perFileLimit).map((match) => hitAt(lineStarts, bytes, match));
}

/** 单条命中 → 结果条目（行/列按 UTF-16 码元，预览复用 makeItem）。 */
function hitAt(
  lineStarts: ArrayLike<number>,
  bytes: Uint8Array,
  match: { start: number; len: number },
): WorkerHit {
  const pos = positionAt(lineStarts, match.start);
  const end = positionAt(lineStarts, match.start + match.len);
  const lineFrom = lineStarts[pos.line];
  const lineTo = pos.line + 1 < lineStarts.length ? lineStarts[pos.line + 1] : bytes.length;
  const lineText = decodeSlice(bytes, lineFrom, lineTo).replace(/\r?\n$/, '');
  const column = decodeSlice(bytes, lineFrom, match.start).length;
  const matchLen = Math.max(1, decodeSlice(bytes, match.start, match.start + match.len).length);
  const endColumn =
    end.line === pos.line
      ? column + matchLen
      : decodeSlice(bytes, lineStarts[end.line], match.start + match.len).length;
  // 预览裁剪复用共享的 makeItem（id/行号列号由宿主按结果序号另填）
  const item = makeItem(0, lineText, pos.line, column, matchLen);
  return {
    line: pos.line,
    column,
    endLine: end.line,
    endColumn,
    preview: item.preview,
    prefix: item.prefix,
    matchLen: item.matchLen,
  };
}

// ------------------------------------------------------ 超大文件分块（I/O 侧）

/** 读文件的一个字节区间：本线程同步 read，多个 worker 各自读各自区间即真并行。 */
function readRange(fsPath: string, from: number, to: number): Buffer {
  const length = Math.max(0, to - from);
  const fd = openSync(fsPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, from + read);
      if (n <= 0) {
        break;
      }
      read += n;
    }
    return read === length ? buffer : buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * 这个文件能不能按字节区间分块：只认 UTF-8 / ASCII。
 * - UTF-16 的字节偏移与字符不是一一对应，切块后列号全错；
 * - 二进制（前 8KB 有 NUL）没必要当文本搜；
 * - GBK 等变长编码可能把字符切在块边界上。
 * 这三种一律交给串行流式路径（它自己会转码 / 判二进制）。
 */
function probeChunkable(fsPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(fsPath, 'r');
  } catch {
    return false;
  }
  try {
    const head = Buffer.allocUnsafe(8192);
    const read = readSync(fd, head, 0, head.length, 0);
    const bytes = head.subarray(0, read);
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return false;
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return false;
    }
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] === 0) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** 规划分块区间；探测或规划不通过返回 null（调用方就地退回串行流式）。 */
function planHugeFile(
  fsPath: string,
  size: number,
  policy: RunMessage['chunk'],
): ChunkRange[] | null {
  if (!policy || !probeChunkable(fsPath)) {
    return null;
  }
  const sizing = chooseChunkSize(size, policy);
  let fd: number;
  try {
    fd = openSync(fsPath, 'r');
  } catch {
    return null;
  }
  try {
    const planned = planChunkRanges(size, sizing.chunkSize, policy.overlap, (from, to) => {
      const length = Math.max(0, Math.min(to, size) - from);
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, from);
      return buffer.subarray(0, Math.max(0, read));
    });
    return 'fallback' in planned ? null : planned.ranges;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * 搜一块。hits 里是「块内行号」（合并时宿主加基准行号），列号与预览按块内
 * 行首计算——与整文件搜索完全一致，因为块的起点就是行首。
 */
function searchChunk(core: SearchCore, handle: number, s: Session, file: PoolFile): PoolFileResult {
  const scanStarted = Date.now();
  const index = file.index;
  const chunkIndex = file.chunkIndex ?? 0;
  const start = file.start ?? 0;
  const end = Math.max(start, file.end ?? start);
  const readEnd = Math.max(end, file.readEnd ?? end);
  let buffer: Buffer;
  try {
    buffer = readRange(file.path, start, readEnd);
  } catch {
    return { index, kind: 'error' };
  }
  // 块尾是硬截的，很可能切在多字节字符中间：截掉不完整序列，否则 utf8_valid
  // 会误判整块非法。截掉的几个字节本来就在重叠区里，由下一块完整覆盖。
  const bytes = trimIncompleteUtf8Tail(buffer);
  const placed = core.putBytes(bytes);
  if (!core.utf8ValidAt(placed.ptr, placed.len)) {
    // 前 8KB 探测没发现的非 UTF-8（混合编码）：整份文件改走串行路径重扫
    return { index, kind: 'chunkUnsupported', chunkIndex };
  }
  const matches = findMatchesAt(core, handle, placed.ptr, placed.len, s.perFileLimit + 1);
  const endLocal = Math.min(bytes.length, end - start);
  // 行数只为给后面的块算基准行号，不需要整张行起点表——而对没有命中的块
  // （绝大多数）建那张表是纯浪费：4MB 块 ≈ 800KB 的 u32 拷贝，实测比匹配
  // 本身慢 4 倍（757 MB/s vs 2965 MB/s），会把并行收益全部吃掉。
  const lines = core.lineCountAt(placed.ptr, placed.len, endLocal);
  const capped = matches.length > s.perFileLimit;
  if (matches.length === 0) {
    return { index, kind: 'chunk', chunkIndex, hits: [], lines, capped, bytesRead: buffer.length, ms: Date.now() - scanStarted };
  }
  const starts = core.lineStartsAt(placed.ptr, placed.len);
  const hits: WorkerHit[] = [];
  for (const match of matches) {
    if (hits.length >= s.perFileLimit) {
      break;
    }
    // 起点落在归属终点之后：属于下一块（重叠区会重复找到，这里去重）
    if (match.start >= endLocal) {
      continue;
    }
    // 命中尾巴超出本块读取范围 = 被打断了。单行内的模式不可能出现（块边界
    // 是行首且重叠足够），只有「匹配长度 > 重叠区」的多行模式会这样，与串行
    // 流式路径的固有限制一致
    if (match.start + match.len > bytes.length) {
      continue;
    }
    hits.push(hitAt(starts, bytes, match));
  }
  return { index, kind: 'chunk', chunkIndex, hits, lines, capped, bytesRead: buffer.length, ms: Date.now() - scanStarted };
}


/**
 * 整读解码（校验下沉 wasm 版）：语义与 files.ts 的 readFileBytes 一致——
 * UTF-8 严格校验通过则原样直传；UTF-16 BOM / GBK 才转码成 UTF-8 字节。
 *
 * 与旧版 decodeBuffer 的差别：字节先 putBytes 进内核暂存区，再用内核的
 * utf8_valid（ASCII 快速路径）做全量校验，省掉 TextDecoder fatal 的整趟
 * JS 扫描和它为「只为分类」的产物分配的整份字符串。NUL 二进制探测语义
 * 不变：仍只查缓冲区前 8192 字节（VS Code 口径），在 JS 侧做。
 *
 * 返回 null 表示二进制文件；bytes 是 JS 侧引用（decodeSlice 取行文本用），
 * placed 是内核暂存区位置（匹配/行起点用，下一次 putBytes 前有效）。
 */
const bytesEncoder = new TextEncoder();

/**
 * 读文件头 8KB 判二进制：与 decodeInto 的 NUL 探测同一套语义——UTF-16 文本
 * 的字节里天然有 NUL（ASCII 码后跟 0x00），必须凭 BOM 放行交给整读转码；
 * UTF-8 BOM 跳过 3 字节再查。读失败按「不是二进制」处理，走原路径兜底。
 */
function isBinaryHead(fsPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(fsPath, 'r');
  } catch {
    return false;
  }
  try {
    const head = Buffer.allocUnsafe(8192);
    const read = readSync(fd, head, 0, head.length, 0);
    if (read < 4) {
      return false;
    }
    if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) {
      return false;
    }
    const from = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
    for (let i = from; i < read; i += 1) {
      if (head[i] === 0) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

function decodeInto(
  core: SearchCore,
  buffer: Buffer,
): { bytes: Uint8Array; placed: { ptr: number; len: number } } | null {
  if (buffer.length === 0) {
    return { bytes: new Uint8Array(0), placed: core.putBytes(new Uint8Array(0)) };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    const bytes = bytesEncoder.encode(new TextDecoder('utf-16le').decode(buffer.subarray(2)));
    return { bytes, placed: core.putBytes(bytes) };
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const bytes = bytesEncoder.encode(new TextDecoder('utf-16be').decode(buffer.subarray(2)));
    return { bytes, placed: core.putBytes(bytes) };
  }
  let head = 0;
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    head = 3;
  }

  const probe = Math.min(buffer.length, 8192);
  for (let i = head; i < probe; i += 1) {
    if (buffer[i] === 0) {
      return null;
    }
  }

  const body = head > 0 ? buffer.subarray(head) : buffer;
  const placed = core.putBytes(body);
  if (core.utf8ValidAt(placed.ptr, placed.len)) {
    return { bytes: body, placed };
  }
  // 非 UTF-8：按 GBK 转码（与旧路径一致）；转不了的判二进制
  try {
    const bytes = bytesEncoder.encode(iconv.decode(body, 'gbk'));
    return { bytes, placed: core.putBytes(bytes) };
  } catch {
    return null;
  }
}
