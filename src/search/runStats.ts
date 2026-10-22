/**
 * 池子诊断统计的共享类型与工厂。
 *
 * 单独成文件是因为 workerMain.ts 顶部有 `if (!parentPort) process.exit(0)`
 * （它是 worker 脚本，被当普通模块加载时静默退出）——宿主侧模块一旦运行时
 * 引它，扩展宿主进程会直接退出。宿主（workerPool）与 worker（workerMain）
 * 都只从这里拿类型和工厂，workerMain 保持仅 `import type` 引用。
 */

/** 单文件耗时采样：只保留最慢的几条，定位「时间花在哪些文件上」 */
export interface SlowFile {
  path: string;
  ms: number;
  bytes: number;
  kind: string;
}

/**
 * 单 worker 一场 run 的聚合统计。
 *
 * 宿主把各 worker 的合并后打一行诊断日志，用来回答「大工作区慢在哪」：
 * - busy 占场时长的比例低 → worker 在等派发，瓶颈在调度；
 * - 比例高但 readBytes 与场时不匹配 → IO 慢（冷缓存 / 介质）；
 * - slowest 里的文件就是长尾。
 */
export interface WorkerRunStats {
  /** handleAssign 忙时合计（含批间让出，量级可忽略） */
  busyMs: number;
  /** 实际处理的文件 / 分块条目数（不含 stat 校验） */
  scanned: number;
  /** 按结果 kind 计数 */
  kinds: Record<string, number>;
  /** 真正读盘扫描的字节（hit/miss 的文件大小 + chunk 的 bytesRead） */
  readBytes: number;
  /** 二进制跳过文件的字节（只付了 open+8KB 探测的钱） */
  binaryBytes: number;
  /** tooLarge 跳过文件的字节（只付了 stat 的钱） */
  largeBytes: number;
  /** 最慢的 5 个条目 */
  slowest: SlowFile[];
}

export function emptyRunStats(): WorkerRunStats {
  return {
    busyMs: 0,
    scanned: 0,
    kinds: {},
    readBytes: 0,
    binaryBytes: 0,
    largeBytes: 0,
    slowest: [],
  };
}
