/**
 * 遍历会话（宿主侧）：把「遍历文件系统」外包给 K 个专职 worker 线程，
 * 宿主只做条目派发、批次接收与（sorted 模式的）K 路归并。
 *
 * 条目化分片：根目录 → L1 目录 → L2 子目录为粒度切成条目，宿主动态派发
 * （worker 空闲即领下一个），天然负载均衡。覆盖规则保证每个文件恰好属于
 * 一个条目：根直属文件 = root 的 files 条目；L1 直属文件 = L1 的 files 条目；
 * L1 无子目录 = 整个 L1 一个 tree 条目；L2 子目录各自一个 tree 条目。
 *
 * 两种顺序模式（可插拔）：
 * - 'fast'（默认）：批次到达即消费，吞吐最大，顺序不保证（截断场景的
 *   「保留哪些命中」依赖时序）。
 * - 'sorted'：worker 每个条目**收集后排序**再吐批次（条目流自身有序），
 *   宿主对「每个 worker 当前条目」做小顶堆归并 → 输出严格全局字典序，
 *   与「全量排序后逐个喂」逐字节一致，可复现。归并是在线算法：任意时刻
 *   只需 K 个流头即可确定全局下一个最小项，内存 O(K×批)。
 *
 * 信用流控：worker 手上未消费批次 ≤ window；宿主每消费一批回一个 credit。
 * 队列在宿主（workerPool 的 need/assign 照旧），worker 死亡按整场失败处理。
 */
import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WalkStats } from './walkFilter';
import { DEFAULT_EXCLUDED_DIRS } from './walkFilter';
import { scoreOf } from './dirPriority';

export const WALK_BATCH_SIZE = 2048;
export const WALK_CREDIT_WINDOW = 4;
const BATCH_SIZE = WALK_BATCH_SIZE;
const CREDIT_WINDOW = WALK_CREDIT_WINDOW;

export interface WalkSessionOptions {
  workerScript: string;
  rootFsPath: string;
  include: string | undefined;
  exclude: string | undefined;
  threads: number;
  order: 'fast' | 'sorted';
  /**
   * 目录优先级（0.1.118）：归一化目录路径 → 点击计数。条目按分数降序
   * 派发（热子树先遍历先扫描），sorted 模式的归并键也随之带上优先级
   * （分数优先、路径次之）。undefined / 空表 = 无优先级，行为同旧版。
   */
  priorities?: Record<string, number>;
  /**
   * 取消检查（0.1.119）：生成器可能挂在「等数据」上，仅靠消息唤醒永远
   * 不会醒——Stop 必须能打断。等待期间定期醒来检查，为真即收尾返回。
   */
  shouldAbort?: () => boolean;
  onProgress?: (found: number) => void;
}

interface WalkItem {
  path: string;
  kind: 'tree' | 'files';
}

/**
 * 条目化：根 → L1 → L2。每个 L1 目录展开一次：有 L2 子目录 → 「L1 直属
 * 文件」files 条目 + 各 L2 子目录 tree 条目；没有 → 整个 L1 一个 tree 条目。
 * 排除目录 / 符号链接不生成条目（tree 条目内部还会再兜一层）。
 */
export function planItems(rootFsPath: string): WalkItem[] {
  const items: WalkItem[] = [];
  let topFiles = 0;
  let top: Array<{ name: string; isDir: boolean; isLink: boolean }>;
  try {
    const dirents = readdirSync(rootFsPath, { withFileTypes: true });
    top = dirents.map((d) => ({
      name: d.name,
      isDir: d.isDirectory(),
      isLink: d.isSymbolicLink(),
    }));
  } catch {
    // 根都读不了：交一个空条目列表，宿主回落宿主内遍历
    return items;
  }
  top.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of top) {
    if (!entry.isDir || entry.isLink || DEFAULT_EXCLUDED_DIRS.has(entry.name)) {
      topFiles += 1;
      continue;
    }
    const dirFs = path.join(rootFsPath, entry.name);
    let sub: string[];
    try {
      sub = readdirSync(dirFs, { withFileTypes: true })
        .filter(
          (d) =>
            d.isDirectory() &&
            !d.isSymbolicLink() &&
            !DEFAULT_EXCLUDED_DIRS.has(d.name),
        )
        .map((d) => d.name)
        .sort();
    } catch {
      items.push({ path: dirFs, kind: 'tree' });
      continue;
    }
    if (sub.length === 0) {
      items.push({ path: dirFs, kind: 'tree' });
    } else {
      items.push({ path: dirFs, kind: 'files' });
      for (const name of sub) {
        items.push({ path: path.join(dirFs, name), kind: 'tree' });
      }
    }
  }
  if (topFiles > 0) {
    items.unshift({ path: rootFsPath, kind: 'files' });
  }
  return items;
}

interface WorkerState {
  worker: Worker;
  /** error/exit 后置否 */
  alive: boolean;
  /** 手上有没走完的条目（item 已派、itemDone 未到） */
  busy: boolean;
  /** seq → 条目的批次缓冲（批次按序到达，条目内有序） */
  buffers: Map<number, {
    paths: string[];
    consumed: number;
    closed: boolean;
    /** 每批到达时记录的「累计消费阈值」：consumed 越过一条就回 1 个 credit */
    batchMarks: number[];
  }>;
  /** 下一个待消费的条目 seq */
  nextSeq: number;
  /** 下一个派发的条目 seq */
  nextSend: number;
  /** seq → 条目的归并键 (−分数, 路径)（条目消费完随缓冲一起清） */
  seqKey: Map<number, { s: number; p: string }>;
  finishSent: boolean;
  idle: boolean;
}

/**
 * 遍历会话生成器：产出通过过滤器的文件 fsPath（顺序取决于 order 模式），
 * 返回 WalkStats。worker 崩溃 / 异常退出按错误抛出，调用方回落宿主内遍历。
 */
export async function* walkSessionGen(
  options: WalkSessionOptions,
): AsyncGenerator<string, WalkStats, void> {
  const items = planItems(options.rootFsPath);
  const priorities = options.priorities ?? {};
  const hasPriority = Object.keys(priorities).length > 0;
  /** 条目分数：自身目录的点击计数（bump 已向祖先传播，直接查即可；
   *  files 条目跟随其 L1 目录——直属文件与子树同热） */
  const itemScore = (item: WalkItem): number => scoreOf(priorities, item.path);
  if (hasPriority) {
    // 优先级降序、路径升序：每个 worker 的派发序列都是这张全局有序表的
    // 子序列 → 各流内部天然按 (−分, 路径) 有序，sorted 归并的正确性成立
    items.sort((a, b) => {
      const diff = itemScore(b) - itemScore(a);
      if (diff !== 0) {
        return diff;
      }
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
  }
  const threads = Math.max(1, Math.min(options.threads, Math.max(1, items.length)));
  const stats = { found: 0, skippedDirs: 0, failedDirs: 0 };
  let yielded = 0;
  let nextItem = 0;
  let finishedSent = false;
  let fatal: string | undefined;
  let dead = false;
  const workers: WorkerState[] = [];
  // 等数据 / 等完成的唤醒队列（生成器是单消费者）
  let notify: (() => void) | undefined;
  const waitForData = (): Promise<void> =>
    new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const wrapped = (): void => {
        if (timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
        notify = undefined;
        resolve();
      };
      notify = wrapped;
      if (options.shouldAbort) {
        // 生成器可能挂在「等数据」上而消息永远不来（任何一端卡住都如此）：
        // 定期醒来让主循环有机会检查取消令牌，否则 Stop 排在 await 后面的
        // return() 永远执行不到（0.1.118 及之前 Stop 打不断挂死的遍历）
        timer = setInterval(wrapped, 250);
      }
    });
  const wake = (): void => {
    const n = notify;
    notify = undefined;
    n?.();
  };

  function dispatch(worker: WorkerState): void {
    if (worker.finishSent || fatal) {
      return;
    }
    if (worker.busy) {
      return;
    }
    if (nextItem < items.length) {
      const item = items[nextItem++];
      const seq = worker.nextSend++;
      worker.busy = true;
      worker.idle = false;
      worker.seqKey.set(seq, { s: hasPriority ? itemScore(item) : 0, p: item.path });
      worker.worker.postMessage({
        type: 'item',
        path: item.path,
        kind: item.kind,
        seq,
      });
    } else if (!worker.finishSent) {
      worker.finishSent = true;
      worker.worker.postMessage({ type: 'finish' });
    }
  }

  function spawnWorkers(): void {
    for (let i = 0; i < threads; i += 1) {
      const worker = new Worker(options.workerScript, {
        workerData: { rootFsPath: options.rootFsPath },
      });
      const state: WorkerState = {
        worker,
        alive: true,
        busy: false,
        buffers: new Map(),
        nextSeq: 0,
        nextSend: 0,
        seqKey: new Map(),
        finishSent: false,
        idle: true,
      };
      workers.push(state);
      // 启动参数先行，worker 回 ready 后才开始领条目
      worker.postMessage({
        type: 'walk',
        rootFsPath: options.rootFsPath,
        include: options.include,
        exclude: options.exclude,
        batch: BATCH_SIZE,
        window: CREDIT_WINDOW,
      });
      worker.on('message', (message: { type: string; [k: string]: unknown }) => {
        onMessage(state, message as never);
      });
      worker.on('error', (error: Error) => {
        if (!fatal && !dead) {
          fatal = `walk worker error: ${error.message}`;
        }
        state.alive = false;
        wake();
      });
      worker.on('exit', (code: number) => {
        state.alive = false;
        if (code !== 0 && !fatal && !dead) {
          fatal = `walk worker exited with code ${code}`;
        }
        // 正常 terminate（收尾）也会 exit(0)：静默
        wake();
      });
    }
  }

  function onMessage(
    state: WorkerState,
    message: { type: string; paths?: string[]; seq?: number; stats?: WalkStats; message?: string },
  ): void {
    switch (message.type) {
      case 'ready': {
        // 初始信用 = 窗口大小
        state.worker.postMessage({ type: 'credit', n: CREDIT_WINDOW });
        dispatch(state);
        break;
      }
      case 'batch': {
        const seq = message.seq as number;
        let buffer = state.buffers.get(seq);
        if (!buffer) {
          buffer = { paths: [], consumed: 0, closed: false, batchMarks: [] };
          state.buffers.set(seq, buffer);
        }
        buffer.paths.push(...(message.paths as string[]));
        // credit 必须按「批」记、按「批」退——按条目闭合才退时，超过信用
        // 窗口批数的条目（>8192 文件）双向死锁（0.1.118 AOSP 卡死根因）。
        // 空批次（占位）到账即退：它永远不会被消费，不退就是永久泄漏——
        // 每个 worker 泄满窗口（4 个空条目）就饿死，全饿死 = 整场挂死
        //（0.1.119 回归，AOSP 满地都是过滤后为空的目录）。
        if ((message.paths as string[]).length === 0) {
          state.worker.postMessage({ type: 'credit', n: 1 });
        } else {
          buffer.batchMarks.push(buffer.paths.length);
        }
        break;
      }
      case 'itemDone': {
        const delta = message.stats as WalkStats;
        stats.found += delta.found;
        stats.skippedDirs += delta.skippedDirs;
        stats.failedDirs += delta.failedDirs;
        options.onProgress?.(stats.found);
        break;
      }
      case 'idle': {
        state.busy = false;
        state.idle = true;
        // 当前条目闭合（批次到齐）
        const buffer = state.buffers.get(state.nextSend - 1);
        if (buffer) {
          buffer.closed = true;
        }
        dispatch(state);
        break;
      }
      case 'fatal': {
        if (!fatal && !dead) {
          fatal = `walk worker fatal: ${String(message.message)}`;
        }
        wake();
        break;
      }
    }
    wake();
  }

  /** worker 当前条目（nextSeq）的流头；缓冲未到 / 已耗尽未闭合返回 undefined */
  function headOf(state: WorkerState): string | undefined {
    const buffer = state.buffers.get(state.nextSeq);
    if (!buffer) {
      return undefined;
    }
    return buffer.consumed < buffer.paths.length ? buffer.paths[buffer.consumed] : undefined;
  }

  function workerDone(state: WorkerState): boolean {
    return (
      state.finishSent &&
      !state.busy &&
      state.idle &&
      [...state.buffers.values()].every((b) => b.closed && b.consumed >= b.paths.length)
    );
  }

  /** 消费越过批次阈值就回 credit：worker 靠它继续发后续批次（防死锁）。 */
  function refundDue(state: WorkerState, buffer: { consumed: number; batchMarks: number[] }): void {
    while (buffer.batchMarks.length > 0 && buffer.consumed >= buffer.batchMarks[0]) {
      buffer.batchMarks.shift();
      state.worker.postMessage({ type: 'credit', n: 1 });
    }
  }

  /** 条目消费完毕：清掉残账、记账清位、派下一个条目。 */
  function advanceBuffer(state: WorkerState): void {
    const buffer = state.buffers.get(state.nextSeq)!;
    if (buffer.consumed >= buffer.paths.length && buffer.closed) {
      refundDue(state, buffer);
      state.buffers.delete(state.nextSeq);
      state.seqKey.delete(state.nextSeq);
      state.nextSeq += 1;
      dispatch(state);
    }
  }

  /** 条目键比较：(−分数, 路径) 字典序。 */
  const keyLess = (
    a: { s: number; p: string },
    b: { s: number; p: string },
  ): boolean => (a.s !== b.s ? a.s > b.s : a.p < b.p);

  /**
   * 消费一个路径，返回 undefined 表示暂无数据。
   * - sorted：**严格归并**——先算出「全局最小键的在途/未派发条目」，只有
   *   持有该条目数据的 worker 才允许输出。仅看「各流头谁小」是不够的：
   *   高优先级条目还在遍历（无数据）时，低优先级流的头部会抢先输出，
   *   破坏 (−分, 路径) 全局序。等待是安全的：最小键条目必然最终产出
   *   （空条目也发占位批次）或闭合，不会死锁。
   * - fast：按 worker 扫描序取第一个可用的（顺序不保证，吞吐优先）。
   * 两种模式都按批次记账：批次消费完才回 credit，信用窗口约束 worker
   * 手上的未消费批次量（背压的最后一环）。
   */
  function takeNext(): string | undefined {
    // 先推进：已耗尽且已闭合的条目缓冲（closed 可能晚于最后一批的消费到达）
    for (const state of workers) {
      const buffer = state.buffers.get(state.nextSeq);
      if (buffer && buffer.consumed >= buffer.paths.length && buffer.closed) {
        advanceBuffer(state);
      }
    }
    if (options.order !== 'sorted') {
      for (const state of workers) {
        const head = headOf(state);
        if (head !== undefined) {
          const buffer = state.buffers.get(state.nextSeq)!;
          buffer.consumed += 1;
          refundDue(state, buffer);
          if (buffer.consumed >= buffer.paths.length && buffer.closed) {
            advanceBuffer(state);
          }
          return head;
        }
      }
      return undefined;
    }
    // ---- sorted：全局最小键条目 ----
    let minKey: { s: number; p: string } | undefined;
    for (const state of workers) {
      if (state.nextSeq < state.nextSend) {
        const key = state.seqKey.get(state.nextSeq);
        if (key && (minKey === undefined || keyLess(key, minKey))) {
          minKey = key;
        }
      }
    }
    // 未派发的条目也参与竞争（派发顺序 = 键序，nextItem 即剩余里最小的）
    if (nextItem < items.length) {
      const key = { s: hasPriority ? itemScore(items[nextItem]) : 0, p: items[nextItem].path };
      if (minKey === undefined || keyLess(key, minKey)) {
        minKey = key;
      }
    }
    if (minKey === undefined) {
      return undefined;
    }
    for (const state of workers) {
      if (state.nextSeq >= state.nextSend) {
        continue;
      }
      const key = state.seqKey.get(state.nextSeq);
      if (!key || key.s !== minKey.s || key.p !== minKey.p) {
        continue;
      }
      const head = headOf(state);
      if (head === undefined) {
        // 最小条目归这个 worker，但数据还没到：等它
        return undefined;
      }
      const buffer = state.buffers.get(state.nextSeq)!;
      buffer.consumed += 1;
      refundDue(state, buffer);
      if (buffer.consumed >= buffer.paths.length && buffer.closed) {
        advanceBuffer(state);
      }
      return head;
    }
    // 最小条目还没有任何 worker 拿到数据：等
    return undefined;
  }

  function allDone(): boolean {
    return (
      finishedSent &&
      workers.length > 0 &&
      workers.every((state) => workerDone(state))
    );
  }

  spawnWorkers();

  try {
    while (true) {
      if (fatal) {
        throw new Error(fatal);
      }
      if (options.shouldAbort?.()) {
        // Stop：立刻收尾（finally 会 terminate 全部 worker），把已产出的
        // 统计还给消费方——池子的喂数循环拿到 done 后走自己的取消流程
        break;
      }
      const path = takeNext();
      if (path !== undefined) {
        yielded += 1;
        yield path;
        continue;
      }
      if (fatal) {
        throw new Error(fatal);
      }
      // 没有可消费的数据：把条目派下去（worker idle 可能还没触发 dispatch）
      for (const state of workers) {
        dispatch(state);
      }
      if (!finishedSent && nextItem >= items.length) {
        finishedSent = true;
        for (const state of workers) {
          state.finishSent = true;
          if (state.alive) {
            state.worker.postMessage({ type: 'finish' });
          }
        }
      }
      if (allDone() || (dead && !workers.some((state) => state.alive))) {
        break;
      }
      await waitForData();
    }
    if (fatal) {
      throw new Error(fatal);
    }
  } finally {
    dead = true;
    for (const state of workers) {
      if (state.alive) {
        void state.worker.terminate().catch(() => undefined);
      }
    }
  }
  return {
    found: stats.found,
    filtered: stats.found - yielded,
    skippedDirs: stats.skippedDirs,
    failedDirs: stats.failedDirs,
    via: 'fs',
  };
}
