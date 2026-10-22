/**
 * 自动档并发度决策（parallelWorkers=0）。
 *
 * 演进：0.1.63~0.1.69 按实时采样系统 CPU 空闲度放宽上限（每场 150ms
 * 采样）；0.1.70 改为上限 1/2 核数。用户实测后定稿：worker 数与文件
 * 数量同步，**上限固定 16**、下限 2——文件越多 worker 越多，封顶 16；
 * 文件少于 worker 数时由池子按 want=min(workerCount, files) 收缩
 * （0.1.62 的池收缩语义），不会空转。无采样、无 I/O、零每场开销。
 */

/** 自动档决策结果（诊断日志用） */
export interface WorkerCountDecision {
  count: number;
  files: number;
}

/** 自动档并发上限 */
export const AUTO_WORKER_CAP = 16;

/**
 * 纯决策：worker 数 = min(文件数, 16)，夹在 2 ~ 16。
 */
export function decideAutoWorkerCount(files: number): WorkerCountDecision {
  const count = Math.min(AUTO_WORKER_CAP, Math.max(2, files));
  return { count, files };
}

/** 文件数达到这个量就无条件进池子（80k 文件时不必先 stat 一遍） */
export const POOL_MIN_FILES = 100;
/**
 * 文件数不足时，总量达到这个值也进池子。
 *
 * 「10 个 20MB」这种工作区不该比 1.5GB 的源码树还慢：进程池的收益来自并行度，
 * 跟文件**个数**没有必然关系。16MB 是冷启动的盈亏点——池子首次拉起 N 个 worker
 * 各要加载一份 wasm（约 30ms，并行起来 40ms 量级），串行扫 16MB 也是这个量级。
 */
export const POOL_MIN_BYTES = 16 << 20;

/**
 * 要不要用 worker 池（纯决策）。
 *
 * `totalBytes` 只在文件数 < `POOL_MIN_FILES` 时才会被算出来——80k 文件的
 * stat pass 是 1.3s，绝不能为了「可能是几个大文件」而在大目录上付这个钱。
 */
export function shouldUsePool(fileCount: number, totalBytes: number): boolean {
  if (fileCount >= POOL_MIN_FILES) {
    return true;
  }
  return fileCount > 0 && totalBytes >= POOL_MIN_BYTES;
}

/**
 * 一批活该占「单个 worker 剩余工作量」的多大比例。
 *
 * 0.25 的意思是：每轮派出一个 worker 还该承担的工作量的四分之一，于是它
 * 每干完一批就回来再领一次，一场下来有 4 次被重新均衡的机会。取 1 会让
 * 分批失去意义（一次给完 = 静态分片），取太小则 need→assign 往返占比变高。
 */
export const STEAL_SHARE = 0.25;

/** 单批字节上限：防止一次把 GB 级的大文件整份压给一个 worker */
export const MAX_STEAL_BYTES = 8 << 20;

/** 块条目一批最多几块：再多就把 work-stealing 退化成静态分片 */
export const MAX_STEAL_CHUNKS = 4;

/** 普通文件一批最多几个（旧的硬上限，防止小文件刷屏） */
export const MAX_STEAL_FILES = 512;

export interface StealRequest {
  /** 池子待办项数（队列 + 已派未回） */
  pending: number;
  /** 已 stat 文件的平均大小，0 表示还没有样本（此时只能按个数派） */
  avgFileBytes: number;
  /** 池子线程数 */
  workers: number;
  /** worker 自适应的取活量上限（按个数，8~512） */
  want: number;
  /** 队首是分块条目时，这块的字节数（file / chunk 两类走不同的换算） */
  chunkBytes?: number;
}

export interface StealDecision {
  take: number;
  /** 这批允许的字节量（诊断日志用） */
  budgetBytes: number;
  /** 换算依据：'chunk' 按块数、'bytes' 按平均文件大小、'want' 无样本 */
  basis: 'chunk' | 'bytes' | 'want';
}

/**
 * 一批偷多少活——按**字节**而不是按**个数**。
 *
 * 旧实现是块恒 1 块、普通文件按 `want`（8~512 个）。按个数限流对字节量毫无
 * 感知：kernel 树里 `asic_reg` 那批 6.5MB 的自动生成头文件路径连续，会被
 * 同一个 worker 一次领走几百个（GB 级），它要单干好几秒，其它 15 个线程
 * 只能扫小文件——这正是「拥挤闸门按个数判断」失效的同一个根因。
 *
 * 现在每批的字节预算 = `待办字节量 × STEAL_SHARE / workers`，再夹一个
 * `MAX_STEAL_BYTES` 的绝对上限：
 *
 * - **密集期**（8 万文件、剩 1.3GB）：预算 20MB 但被 8MB 顶住 → 小文件一批
 *   几百个，往返开销摊薄；块一批 4 块（`MAX_STEAL_CHUNKS`），约 12ms 的活。
 * - **尾声**（队列只剩几十个）：预算掉到几十 KB → 一批 1 个，最细粒度收尾。
 * - **无样本**（每场搜索头几个文件）：退回按个数，跟旧行为一致。
 *
 * 这样批量大小自己随剩余工作量缩放，不需要另设一个「批量」配置。
 */
export function decideStealCount(req: StealRequest): StealDecision {
  const workers = Math.max(1, Math.floor(req.workers));
  const want = Math.min(MAX_STEAL_FILES, Math.max(1, Math.floor(req.want)));
  const avg = Math.max(0, req.avgFileBytes);
  const remaining = avg > 0 ? Math.max(0, req.pending) * avg : 0;
  // 待办为空时预算就该归零（派活那一刻队列已经空了，只是竞态），
  // 不要退回「无样本」分支——那会给一批 8MB 的假预算。
  const raw = remaining > 0 ? (remaining * STEAL_SHARE) / workers : 0;
  const floorBytes = avg > 0 ? avg : 1;
  const budgetBytes = Math.max(floorBytes, Math.min(raw, MAX_STEAL_BYTES));

  if (req.chunkBytes !== undefined && req.chunkBytes > 0) {
    const take = Math.min(
      want,
      MAX_STEAL_CHUNKS,
      Math.max(1, Math.round(budgetBytes / req.chunkBytes)),
    );
    return { take, budgetBytes, basis: 'chunk' };
  }
  if (avg <= 0) {
    return { take: want, budgetBytes, basis: 'want' };
  }
  return {
    take: Math.min(want, Math.max(1, Math.floor(budgetBytes / avg))),
    budgetBytes,
    basis: 'bytes',
  };
}
