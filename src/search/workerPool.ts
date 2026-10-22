/**
 * Worker 线程池（宿主侧）——常驻版。
 *
 * N 个 worker 各自持有 wasm 实例并编译查询，文件按 work-stealing 动态派发
 * （worker 干完一批再要，快的自然多拿，消除静态分片的尾延迟），
 * 结果按批增量回调给调用方（进度条可以实时更新，命中边搜边入列）。
 *
 * 常驻语义（P2）：worker 跨搜索存活——wasm 实例化（每个 worker 数十 ms）
 * 只在池子冷启动时付一次；空闲 worker 不占事件循环（unref），进程可以正常
 * 退出。任何一轮里 worker 崩溃（error/exit/fatal）都判整轮 failed，并把整个
 * 池子推倒，下一轮自动冷启动重建。
 *
 * 结局：
 * - ok：所有 worker 正常收工（用户取消时 worker 提前收工也算 ok，截断由调用方判）。
 * - initFailed：worker 起不来（脚本缺失 / wasm 加载失败），调用方应回退到
 *   宿主内扫描——此时还没有任何结果被回调，回退不会重复。
 * - failed：中途崩溃或内核抛错，整场搜索作废。
 */
import { Worker } from 'node:worker_threads';
import type { SearchOptions } from '../engine/search';
import type { ChunkPolicy } from './chunkPlan';
import { decideStealCount } from './parallelism';
import { emptyRunStats, type SlowFile, type WorkerRunStats } from './runStats';
// workerMain 只能 type 引用：它顶部有 parentPort 探测，运行时引入会让
// 宿主进程 process.exit(0)（0.1.94 插件起不来的根因）
import type { PoolFileResult, PoolWorkItem, WorkerHit } from './workerMain';

export type { PoolFileResult, PoolWorkItem, WorkerHit };
export type { SlowFile, WorkerRunStats };

/**
 * 一场池子 run 的汇总（宿主侧）：各 worker 统计合并 + 派发计数，
 * controller 拿去打诊断日志（大工作区慢查定位）。
 */
export interface PoolRunSummary {
  workers: number;
  /** 这场 run 的墙钟时长 */
  wallMs: number;
  /** 各 worker 忙时之和（可超过 wallMs：N 线程并行） */
  busyMs: number;
  /** assign 派发次数 / 派发条目数 / 初始队列条目数 */
  assignCalls: number;
  dispatched: number;
  queued: number;
  scanned: number;
  kinds: Record<string, number>;
  readBytes: number;
  binaryBytes: number;
  largeBytes: number;
  slowest: SlowFile[];
}

function mergeStats(into: WorkerRunStats, from: WorkerRunStats): void {
  into.busyMs += from.busyMs;
  into.scanned += from.scanned;
  for (const key of Object.keys(from.kinds)) {
    into.kinds[key] = (into.kinds[key] ?? 0) + from.kinds[key];
  }
  into.readBytes += from.readBytes;
  into.binaryBytes += from.binaryBytes;
  into.largeBytes += from.largeBytes;
  if (from.slowest.length > 0) {
    into.slowest = [...into.slowest, ...from.slowest].sort((a, b) => b.ms - a.ms).slice(0, 5);
  }
}

export interface PoolRunOptions {
  /** wasm 内核路径（media/core.wasm 的绝对路径） */
  wasmPath: string;
  /** worker 脚本路径（dist/searchWorker.js 的绝对路径） */
  workerScript: string;
  workerCount: number;
  /** 待扫描文件（path=本地绝对路径，index=全场搜索的全局下标，结果原样带回）。
   *  调用方可先扣掉结果缓存命中的文件再传，只派发真正需要扫描的子集。
   *  超大文件的分块条目也走这条队列（带 start/end/readEnd/chunkIndex）。 */
  files: PoolWorkItem[];
  /**
   * 生产者模式（0.1.114）：与 files 二选一。枚举器逐个产出文件，池子拉一个
   * 派一个——枚举与扫描全程重叠，不存在「等全量清单」的环节。给 source 时
   * files 必须为空数组。取消 / 失败时池子会对生成器调 return() 让遍历收尾。
   */
  source?: AsyncIterable<PoolWorkItem>;
  options: SearchOptions;
  perFileLimit: number;
  maxBytes: number;
  streamAbove: number;
  /** 超大文件并行分块策略；不给就全走串行流式 */
  chunk?: ChunkPolicy & { above: number };
  /**
   * 计数模式（「统计完整数量」）：worker 只数命中不产结果行。与扫描共用
   * 同一条 work-stealing 流水线，只是结果从 hits 变成每文件的 count。
   */
  count?: {
    maxFileBytes: number;
    wholeLimit: number;
    chunkBytes: number;
    overlap: number;
    perChunkCap: number;
  };
  /** 结果缓存校验：这些全局下标的文件 worker 只 statSync 回报（stat 结果），
   *  其余文件正常扫描。与扫描同一场进行，宿主比对后回放缓存或安排重扫 */
  check?: number[];
  /** 取消令牌：为真时向所有 worker 广播 abort */
  shouldAbort: () => boolean;
  /** 每批结果回调；只在全部 worker 就绪后才开始调用 */
  onBatch: (results: PoolFileResult[]) => void;
}


export type PoolOutcome =
  | { kind: 'ok' }
  | { kind: 'initFailed'; error: string }
  | { kind: 'failed'; error: string };

interface PoolEntry {
  worker: Worker;
  ready: boolean;
  busy: boolean;
  /** error/exit/fatal 后置否，随后从池里移除 */
  healthy: boolean;
  dead: boolean;
}

/** 「典型文件大小」的采样上限：超过它的文件不参与平均（见 onMessage 里的注释）。 */
const AVG_SAMPLE_CAP = 1 << 20;

interface ActiveRun {
  options: PoolRunOptions;
  chosen: PoolEntry[];
  /** 尚未派发的文件队列（work-stealing：worker 按 need 自取，快的多拿） */
  queue: PoolWorkItem[];
  /**
   * 已经派发、worker 还没回报结果的条目数。
   *
   * 只看 `queue` 会严重低估工作量：work-stealing 一次能给单个 worker 派上百个
   * 文件，几百个文件的目录会在 1ms 内被队列清空，但活其实都还在 worker 手里。
   */
  inFlight: number;
  /**
   * 队列里 / 已派出去但没回来的**文件**条目数（不含分块）。
   *
   * 拥挤判据要乘的是「平均文件大小」，所以分母必须是文件个数。用条目总数
   * 会把 20 个块当成 20 个 20MB 的文件 → 剩余工作量被高估 20 倍 → 闸门把
   * 后面每一个大文件都误判成「不值得拆」（10×20MB 的工作区就这么被拖慢的）。
   */
  queueFiles: number;
  inFlightFiles: number;
  /** 已 stat 过的文件字节数 / 个数：用来估计「剩下的活还有多少字节」 */
  statBytes: number;
  statFiles: number;
  /**
   * 同样的统计，但**不排除**大文件。
   *
   * 两个平均值的用途相反：拥挤闸门要用「典型大小」（排除 > 1MB），否则被判断
   * 的那个大文件会自己抬高分母；批量换算要用「聚合大小」（含全部），因为
   * `待办项数 × 平均大小` 就该等于剩余总字节，把大文件排除掉会低估工作量。
   */
  allBytes: number;
  allFiles: number;
  doneCount: number;
  settled: boolean;
  abortTimer: ReturnType<typeof setInterval> | undefined;
  /** 场次开跑时刻（打 wall 时长用） */
  startedAt: number;
  /** 各 worker 统计的合并结果 */
  stats: WorkerRunStats;
  /** assign 派发计数 */
  assignCalls: number;
  dispatched: number;
  resolve: (outcome: PoolOutcome) => void;
  /** 生产者模式的迭代器（有值 = 本场是流式喂数） */
  sourceIterator: AsyncIterator<PoolWorkItem, any, undefined> | undefined;
  /** 生产者是否已经喂完：true 后队列空 → worker 正常 drain 收工 */
  producerDone: boolean;
  /** 队列空且生产者没喂到时饿等待的 worker：来活立即派发，不空转 */
  starved: Set<PoolEntry>;
  /** 生产者累计喂进的条目数（汇总日志用） */
  fed: number;
}

/**
 * 聚合平均大小（含全部文件，不排除大文件）。
 *
 * 与 `averageFileBytes()` 的区别：那个排除 > 1MB 的文件，用来判断「这个
 * 大文件相对剩余工作占多大比例」；这个含全部，因为 `待办项数 × 平均大小`
 * 要等于剩余总字节，排除大文件会低估工作量。
 */
function averageAllBytes(active: ActiveRun): number {
  return active.allFiles === 0 ? 0 : active.allBytes / active.allFiles;
}

export class WorkerPool {
  private entries = new Set<PoolEntry>();
  private wasmPath: string | undefined;
  private workerScript: string | undefined;
  private activeRun: ActiveRun | null = null;
  /** 最近一场 run 的汇总（finish 时落定，下一场开跑前一直可读） */
  private lastSummary: PoolRunSummary | undefined;
  /**
   * 正在启动（worker ready 还没回来）的场次。
   * `activeRun` 要等 worker 就绪后才置位，中间有一段窗口；两个调用方同时进来
   * 会各自给同一批 worker 发 run，worker 侧判「overlapping run」直接致命。
   * 用这个同步标记把窗口堵上。
   */
  private starting = false;

  /** 常驻池跑一轮搜索；结果与一次性池完全同构。 */
  run(options: PoolRunOptions): Promise<PoolOutcome> {
    if (this.activeRun || this.starting) {
      // 调用方（controller）有防抖与抢占，不该发生；响亮失败好过结果串场
      return Promise.resolve({ kind: 'failed', error: 'worker pool already running' });
    }
    // 内核或脚本路径变了（升级/测试切换）：旧实例全部作废，冷启动重建
    if (this.wasmPath !== undefined && (this.wasmPath !== options.wasmPath || this.workerScript !== options.workerScript)) {
      this.dispose();
    }
    this.wasmPath = options.wasmPath;
    this.workerScript = options.workerScript;

    const cap = options.source ? options.workerCount : options.files.length;
    const want = Math.max(1, Math.min(options.workerCount, cap));
    this.starting = true;
    return this.startRun(options, want).finally(() => {
      this.starting = false;
    });
  }

  /** 当前池内常驻 worker 数（收缩逻辑的测试观察口）。 */
  get size(): number {
    return this.entries.size;
  }

  /** 最近一场 run 的汇总（controller 打诊断日志用）。 */
  recentSummary(): PoolRunSummary | undefined {
    return this.lastSummary;
  }

  /** 终止全部 worker。扩展停用或测试收尾时调用。 */
  dispose(): void {
    const entries = [...this.entries];
    this.entries.clear();
    for (const entry of entries) {
      entry.dead = true;
      entry.healthy = false;
      void entry.worker.terminate().catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ 内部

  private async startRun(options: PoolRunOptions, want: number): Promise<PoolOutcome> {
    // 先清掉不健康的残留，再从空闲池取，不够就补建
    for (const entry of [...this.entries]) {
      if (!entry.healthy) {
        this.remove(entry);
      }
    }
    const chosen: PoolEntry[] = [];
    for (const entry of this.entries) {
      if (!entry.busy && entry.healthy && chosen.length < want) {
        chosen.push(entry);
      }
    }
    while (chosen.length < want) {
      chosen.push(this.spawn(options));
    }
    // 池子必须跟着 want 收缩：worker 各自持有 wasm 线性内存，运行时把
    // parallelWorkers 从 8 调到 2，多出的 6 个若只是闲置不退役，内存就
    // 永远占着（基准里连续切换并发度时累积到 40+ 线程，吞吐掉一半以上）。
    // 走到这里不可能有 busy 残留（activeRun 未结束会提前返回），放心退役。
    if (this.entries.size > chosen.length) {
      const keep = new Set(chosen);
      for (const entry of [...this.entries]) {
        if (!keep.has(entry)) {
          this.remove(entry);
        }
      }
    }

    try {
      await Promise.all(chosen.map((entry) => this.waitReady(entry)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 起不来的池子整体作废：调用方回退宿主内扫描
      this.dispose();
      return { kind: 'initFailed', error: message };
    }

    return new Promise<PoolOutcome>((resolve) => {
      const active: ActiveRun = {
        options,
        chosen,
        queue: options.source ? [] : options.files.slice(),
        inFlight: 0,
        queueFiles: options.source ? 0 : options.files.length,
        inFlightFiles: 0,
        statBytes: 0,
        statFiles: 0,
        allBytes: 0,
        allFiles: 0,
        doneCount: 0,
        settled: false,
        abortTimer: undefined,
        startedAt: Date.now(),
        stats: emptyRunStats(),
        assignCalls: 0,
        dispatched: 0,
        resolve,
        sourceIterator: undefined,
        producerDone: !options.source,
        starved: new Set<PoolEntry>(),
        fed: 0,
      };
      this.activeRun = active;
      for (const entry of chosen) {
        entry.busy = true;
        entry.worker.postMessage({
          type: 'run',
          options: options.options,
          perFileLimit: options.perFileLimit,
          maxBytes: options.maxBytes,
          streamAbove: options.streamAbove,
          check: options.check,
          chunk: options.chunk,
          count: options.count,
        });
      }
      // 取消轮询：batch 间隔里也要能及时广播 abort（这个定时器同时保证
      // 全部 worker 都 unref 的情况下，等待期间主线程的事件循环仍存活）
      active.abortTimer = setInterval(() => {
        if (options.shouldAbort()) {
          for (const entry of chosen) {
            entry.worker.postMessage({ type: 'abort' });
          }
        }
      }, 200);
      if (options.source) {
        active.sourceIterator = options.source[Symbol.asyncIterator]();
        void this.feedLoop(active);
      }
    });
  }

  /**
   * 生产者喂数循环：拉一个文件塞进队列并唤醒饿等的 worker。
   *
   * 背压：队列堆到 HIGH_WATER 就歇 25ms 再看（消费者消化到半空即恢复）——
   * 百万文件的树不设背压会把整棵树在扫描开始前就灌进队列，那等于没流水线。
   * 遍历器抛错按整场失败处理；取消时循环退出，置 producerDone 让 worker 收工。
   */
  private async feedLoop(active: ActiveRun): Promise<void> {
    const HIGH_WATER = 4096;
    const it = active.sourceIterator!;
    try {
      while (!active.settled && !active.options.shouldAbort()) {
        if (active.queue.length >= HIGH_WATER) {
          await new Promise((r) => setTimeout(r, 25));
          continue;
        }
        // 批量拉取：一次生成器跳转喂 64 个，摊薄百万文件逐个循环的开销
        let fed = 0;
        while (fed < 64 && active.queue.length < HIGH_WATER) {
          const r = await it.next();
          if (process.env.WALK_DBG) {
            console.error(`[feed] ${r.done ? 'DONE' : '+'} fed=${active.fed} q=${active.queue.length}`);
          }
          if (r.done) {
            active.producerDone = true;
            this.wakeStarved(active);
            return;
          }
          active.queue.push(r.value);
          active.fed += 1;
          if (r.value.chunkIndex === undefined) {
            active.queueFiles += 1;
          }
          fed += 1;
        }
        this.wakeStarved(active);
      }
    } catch (error) {
      if (!active.settled) {
        this.finish(active, {
          kind: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    active.producerDone = true;
    this.wakeStarved(active);
  }

  /** 唤醒饿等待的 worker：立即按 work-stealing 正常派发。 */
  private wakeStarved(active: ActiveRun): void {
    if (active.starved.size === 0) {
      return;
    }
    const starved = [...active.starved];
    active.starved.clear();
    for (const entry of starved) {
      if (!entry.dead && entry.busy) {
        this.assign(entry, active, undefined);
      }
    }
  }

  private spawn(options: PoolRunOptions): PoolEntry {
    // wasm 路径走 workerData：worker 启动即加载内核，加载失败会在 ready 之前暴露
    const worker = new Worker(options.workerScript, {
      workerData: { wasmPath: options.wasmPath },
    });
    // 常驻但不拖住进程退出：空闲 worker 的事件循环句柄全部 unref，
    // 跑批期间由 abort 轮询定时器维持主循环存活
    worker.unref();
    const entry: PoolEntry = { worker, ready: false, busy: false, healthy: true, dead: false };
    worker.on('message', (message: { type: string; message?: string; results?: PoolFileResult[] }) => {
      this.onMessage(entry, message);
    });
    worker.on('error', (err: Error) => {
      this.onDeath(entry, err.message);
    });
    worker.on('exit', (code: number) => {
      this.onDeath(entry, code === 0 ? 'worker exited unexpectedly' : `worker exited with code ${code}`);
    });
    this.entries.add(entry);
    return entry;
  }

  private waitReady(entry: PoolEntry): Promise<void> {
    if (entry.ready) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker ready timeout')), 30000);
      const onMessage = (message: { type: string }) => {
        if (message.type === 'ready') {
          cleanup();
          resolve();
        }
      };
      const onDeath = (message: string) => {
        cleanup();
        reject(new Error(message));
      };
      const cleanup = () => {
        clearTimeout(timer);
        entry.worker.off('message', onMessage);
        entry.worker.off('error', deathOnError);
        entry.worker.off('exit', deathOnExit);
      };
      const deathOnError = (err: Error) => onDeath(err.message);
      const deathOnExit = (code: number) => onDeath(`worker exited with code ${code} before ready`);
      entry.worker.on('message', onMessage);
      entry.worker.on('error', deathOnError);
      entry.worker.on('exit', deathOnExit);
    });
  }

  private onMessage(
    entry: PoolEntry,
    message: { type: string; message?: string; results?: PoolFileResult[]; want?: number; stats?: WorkerRunStats },
  ): void {
    const active = this.activeRun;
    if (message.type === 'ready') {
      entry.ready = true;
      // 端口对象在首次通信后才建立，spawn 时的 worker.unref() 管不到它；
      // ready 之后补一刀，空闲 worker 才不会拖住进程退出
      entry.worker.unref();
      return;
    }
    if (!active || !entry.busy || active.settled || entry.dead) {
      // 上一轮的迟到消息：忽略（worker 只在 done 后才会接到新一轮 run）
      return;
    }
    if (message.type === 'need') {
      this.assign(entry, active, message.want);
      return;
    }
    if (message.type === 'batch') {
      // worker 报的是全局文件下标（assign 时随活下发），直接透传。
      // 先把这批从 in-flight 里扣掉：宿主在 onBatch 里判断拥挤度时，
      // 这批复已经完成，不该算进「还有多少活没干」。
      const results = message.results ?? [];
      active.inFlight = Math.max(0, active.inFlight - results.length);
      // 只有 chunk / chunkUnsupported 来自分块条目，其余（find / streamed /
      // plan / error）都是一整个文件的结果——正好用来精确扣文件条目数。
      let fileResults = 0;
      for (const r of results) {
        if (r.kind !== 'chunk' && r.kind !== 'chunkUnsupported') {
          fileResults += 1;
        }
      }
      active.inFlightFiles = Math.max(0, active.inFlightFiles - fileResults);
      // 顺手累计文件大小：拥挤判据要的是「还剩多少字节的活」，不是文件个数。
      // 只采样「典型大小」的文件（≤ 1MB）：平均值里混进一个 6.5MB 的大文件就会
      // 把估计拉爆——那正好是我们在判断的那类文件，不能让它自己抬高分母。
      for (const r of results) {
        if (!('stat' in r) || !r.stat) {
          continue;
        }
        active.allBytes += r.stat.size;
        active.allFiles += 1;
        if (r.stat.size > AVG_SAMPLE_CAP) {
          continue;
        }
        active.statBytes += r.stat.size;
        active.statFiles += 1;
      }
      active.options.onBatch(results);
      return;
    }
    if (message.type === 'done') {
      if (message.stats) {
        mergeStats(active.stats, message.stats);
      }
      entry.busy = false;
      active.doneCount += 1;
      if (active.doneCount === active.chosen.length) {
        this.finish(active, { kind: 'ok' });
      }
      return;
    }
    if (message.type === 'fatal') {
      this.finish(active, { kind: 'failed', error: String(message.message ?? 'worker fatal') });
      return;
    }
  }

  /**
   * work-stealing 派活：一批拿多少由 `decideStealCount` 按**字节预算**算
   * （待办字节量 × 0.25 / 线程数，夹 8MB 上限），队列取空就回 drain。
   *
   * 旧写法是「块恒 1 块、文件按 want 个数」——按个数限流对字节量毫无感知，
   * kernel 树里 `asic_reg` 那批 6.5MB 头文件路径连续，会被同一 worker 一次
   * 领走几百个（GB 级），它单干好几秒，其它线程只能扫小文件。
   *
   * 派活前查一次取消令牌：已取消就直接 drain，让 worker 立即收工。
   */
  private assign(entry: PoolEntry, active: ActiveRun, want: number | undefined): void {
    if (active.queue.length === 0 || active.options.shouldAbort()) {
      if (
        active.queue.length === 0 &&
        active.sourceIterator !== undefined &&
        !active.producerDone &&
        !active.options.shouldAbort()
      ) {
        // 生产者还没喂到这个 worker 要的活：饿等待，来活立即派发。
        // 此时 drain 会让 worker 提前收工，流水线就断了。
        active.starved.add(entry);
        return;
      }
      entry.worker.postMessage({ type: 'drain' });
      return;
    }
    const head = active.queue[0];
    const start = head.start ?? 0;
    const decision = decideStealCount({
      pending: active.queue.length + active.inFlight,
      avgFileBytes: averageAllBytes(active),
      workers: active.chosen.length,
      want: want ?? 24,
      chunkBytes:
        head.chunkIndex !== undefined ? Math.max(1, (head.end ?? start) - start) : undefined,
    });
    const files = active.queue.splice(0, Math.min(decision.take, active.queue.length));
    active.inFlight += files.length;
    active.assignCalls += 1;
    active.dispatched += files.length;
    let takenFiles = 0;
    for (const item of files) {
      if (item.chunkIndex === undefined) {
        takenFiles += 1;
      }
    }
    active.queueFiles = Math.max(0, active.queueFiles - takenFiles);
    active.inFlightFiles += takenFiles;
    entry.worker.postMessage({ type: 'assign', files });
  }

  /**
   * 跑批中追加活（超大文件被 worker 识别出来之后，宿主把它的分块插进队列）。
   * priority=true 插到队头：把长尾的大文件提前摊开，别等其它文件都扫完。
   */
  appendWork(items: PoolWorkItem[], priority = true): boolean {
    const active = this.activeRun;
    if (!active || active.settled) {
      return false;
    }
    if (priority) {
      active.queue.unshift(...items);
    } else {
      active.queue.push(...items);
    }
    let files = 0;
    for (const item of items) {
      if (item.chunkIndex === undefined) {
        files += 1;
      }
    }
    active.queueFiles += files;
    return true;
  }

  /** 丢弃某个文件还没被取走的分块（该文件改走串行路径时用）。 */
  dropChunksOf(index: number): void {
    const active = this.activeRun;
    if (!active) {
      return;
    }
    active.queue = active.queue.filter((item) => !(item.index === index && item.chunkIndex !== undefined));
  }

  /**
   * 还有多少活没干完：队列里没派出去的 + 已派出去但 worker 还没回报的。
   *
   * 宿主拿它判断「池子是不是还忙」：总量大说明还有别的文件能把这些 worker
   * 填满，此时把某个文件拆开只会把别的活顺延，总时长不变；总量见底才说明
   * 池子要饿死了，拆开才是真的压短关键路径。
   *
   * 必须把 in-flight 算进去：work-stealing 一次能派上百个文件，只看 queue
   * 会把「几百个文件全在 worker 手里」误判成「池子空了」。
   */
  pendingWork(): number {
    return this.activeRun ? this.activeRun.queue.length + this.activeRun.inFlight : 0;
  }

  /** 待办里的**文件**条目数（不含分块）：拥挤判据的分母。 */
  pendingFiles(): number {
    return this.activeRun ? this.activeRun.queueFiles + this.activeRun.inFlightFiles : 0;
  }

  /** 聚合平均大小（含大文件，不排除 > 1MB）。 */
  averageAllBytes(): number {
    return this.activeRun ? averageAllBytes(this.activeRun) : 0;
  }

  /**
   * 已 stat 文件的平均大小（0 表示还没有样本）。
   *
   * 和 `pendingWork()` 一起用就能估出「剩下的活还有多少字节」——文件个数在
   * kernel 这种目录里毫无意义：8 万个文件里混着 300 个 6.5MB 的头文件，
   * 按个数算是 0.4%，按字节算是 56%。分块值不值只看字节。
   */
  averageFileBytes(): number {
    const a = this.activeRun;
    if (!a || a.statFiles === 0) {
      return 0;
    }
    return a.statBytes / a.statFiles;
  }

  /** worker 死亡（error/exit）：跑批中判整轮失败，空闲中悄悄移出池子。 */
  private onDeath(entry: PoolEntry, message: string): void {
    if (entry.dead) {
      return;
    }
    entry.dead = true;
    entry.healthy = false;
    const active = this.activeRun;
    if (active && entry.busy && !active.settled) {
      this.finish(active, { kind: 'failed', error: message });
    } else {
      this.remove(entry);
      if (active && !active.settled && active.chosen.every((e) => e.dead || !e.busy)) {
        // 极端情况：剩余 worker 全部死亡又没有触发 fatal —— 兜底收场
        this.finish(active, { kind: 'failed', error: message });
      }
    }
  }

  private finish(active: ActiveRun, outcome: PoolOutcome): void {
    if (active.settled) {
      return;
    }
    active.settled = true;
    if (active.sourceIterator) {
      // 让遍历生成器收尾（内部 readdir 循环退出），别留着悬空的遍历
      void Promise.resolve(active.sourceIterator.return?.(undefined)).catch(() => undefined);
    }
    // 场次汇总（含失败场）：controller 在主扫描 outcome 回来后取走打日志
    this.lastSummary = {
      workers: active.chosen.length,
      wallMs: Date.now() - active.startedAt,
      busyMs: active.stats.busyMs,
      assignCalls: active.assignCalls,
      dispatched: active.dispatched,
      queued: active.fed,
      scanned: active.stats.scanned,
      kinds: active.stats.kinds,
      readBytes: active.stats.readBytes,
      binaryBytes: active.stats.binaryBytes,
      largeBytes: active.stats.largeBytes,
      slowest: active.stats.slowest,
    };
    if (active.abortTimer) {
      clearInterval(active.abortTimer);
      active.abortTimer = undefined;
    }
    this.activeRun = null;
    if (outcome.kind === 'ok') {
      for (const entry of active.chosen) {
        entry.busy = false;
        // 收工后再 unref 一遍：跑批期间的 postMessage 可能把端口重新 ref 上
        entry.worker.unref();
      }
    } else {
      // 失败的池子不可信（状态参差）：整体推倒，下一轮冷启动
      this.dispose();
    }
    active.resolve(outcome);
  }

  private remove(entry: PoolEntry): void {
    entry.dead = true;
    entry.healthy = false;
    this.entries.delete(entry);
    void entry.worker.terminate().catch(() => undefined);
  }
}

// ----------------------------------------------------------- 共享常驻实例

let shared: WorkerPool | undefined;

/**
 * 跨搜索复用的共享池：controller 每场搜索都走这里，worker 与 wasm 实例
 * 在多场搜索之间存活。initFailed / failed 会把池子推倒，下次调用自动重建。
 */
export function runWorkerSearch(options: PoolRunOptions): Promise<PoolOutcome> {
  if (!shared) {
    shared = new WorkerPool();
  }
  return shared.run(options);
}

/** 扩展停用 / 测试收尾时调用：终止全部常驻 worker。 */
export function disposeSharedWorkerPool(): void {
  shared?.dispose();
  shared = undefined;
}

/**
 * 跑批途中追加活（超大文件分块）。返回 false 表示当前没有在跑的场次
 * （调用方应改为直接派一份新的 run）。
 */
export function appendPoolWork(items: PoolWorkItem[], priority = true): boolean {
  return shared?.appendWork(items, priority) ?? false;
}

/** 丢弃某文件尚未取走的分块（该文件改走串行路径时用）。 */
export function dropPoolChunks(index: number): void {
  shared?.dropChunksOf(index);
}

/** 共享池当前还没派出去的活数量（拥挤度判据用）。 */
export function poolPendingWork(): number {
  return shared?.pendingWork() ?? 0;
}

/** 共享池已 stat 文件的平均大小（0 = 还没样本）。 */
export function poolAverageFileBytes(): number {
  return shared?.averageFileBytes() ?? 0;
}

/** 共享池待办的**文件**条目数（不含分块）。 */
export function poolPendingFileCount(): number {
  return shared?.pendingFiles() ?? 0;
}

/** 共享池已 stat 文件的聚合平均大小（含大文件）。 */
export function poolAverageAllBytes(): number {
  return shared?.averageAllBytes() ?? 0;
}

/** 共享池当前常驻的 worker 数（测试观察口）。 */
export function sharedPoolSize(): number {
  return shared?.size ?? 0;
}

/** 最近一场池子 run 的汇总（没有或从未跑过返回 undefined）。 */
export function lastPoolRunSummary(): PoolRunSummary | undefined {
  return shared?.recentSummary();
}
