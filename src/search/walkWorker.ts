/**
 * 遍历 Worker（宿主侧 walkSession 派生的普通 Node 线程，不装 wasm）。
 *
 * 职责单一：领一个子树条目，同步递归遍历，把通过过滤器的文件路径
 * **收集后排序**再分批流式吐出。排序发生在 worker 内、按条目为单位——
 * 宿主据此对「活跃条目流」做 K 路归并，得到全局字典序（sorted 模式）。
 *
 * 为什么同步系统调用：readdirSync 在本线程直接 syscall，K 个 worker 真并行；
 * 不经过 libuv 线程池（默认 4 线程，是异步版 fs 的并行天花板）。
 *
 * 协议（宿主 walkSession 对接）：
 *   host → worker: {type:'walk', include, exclude, batch, window} 启动参数
 *                  {type:'item', path, kind:'tree'|'files'} 派一个条目
 *                  {type:'credit', n} 消费方消化了 n 批，放行
 *                  {type:'finish'} 条目发完了，跑完手头的就收工
 *                  {type:'abort'} 中止
 *   worker → host: {type:'ready'} | {type:'batch', paths} | {type:'itemDone', stats}
 *                  {type:'idle'} | {type:'done'} | {type:'fatal', message}
 *
 * 信用流控：worker 手上未消费的批次 ≤ window，宿主每消费一批回一个 credit——
 * 百万文件的树不会被预先灌进宿主队列（那等于没流水线）。
 */
import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { globToRegExp, splitFilters } from './glob';
import {
  DEFAULT_EXCLUDED_DIRS,
  explicitDirs,
  hasExcludedSegment,
  isExcludedExt,
  namedExcludedExts,
} from './walkFilter';

const MAX_DEPTH = 32;

interface WalkStart {
  type: 'walk';
  rootFsPath: string;
  include: string | undefined;
  exclude: string | undefined;
  /** 一批多少条路径 */
  batch: number;
  /** 信用窗口：未消费的批次数达到它就停手等 credit */
  window: number;
}

type InMessage =
  | WalkStart
  | { type: 'item'; path: string; kind: 'tree' | 'files'; seq: number }
  | { type: 'credit'; n: number }
  | { type: 'finish' }
  | { type: 'abort' };

interface WalkStats {
  found: number;
  skippedDirs: number;
  failedDirs: number;
}

const port = parentPort;
if (!port) {
  // 被当作普通模块 import（测试环境）时静默退出——与 workerMain 同款防护
  process.exit(0);
}

let abort = false;
let credits = 0;
const creditWaiters: Array<() => void> = [];

function wakeCredits(): void {
  for (const wake of creditWaiters.splice(0)) {
    wake();
  }
}

async function waitCredit(): Promise<boolean> {
  while (credits <= 0) {
    if (abort) {
      return false;
    }
    await new Promise<void>((resolve) => creditWaiters.push(resolve));
  }
  credits -= 1;
  return true;
}

const rootFsPath = (workerData as { rootFsPath: string }).rootFsPath;
const normRoot = rootFsPath.replace(/\\/g, '/').replace(/\/+$/, '');

/** fsPath → 工作区相对路径（正斜杠），过滤器与扩展名判断都用它 */
function relOf(fsPath: string): string {
  const norm = fsPath.replace(/\\/g, '/');
  return norm.startsWith(`${normRoot}/`) ? norm.slice(normRoot.length + 1) : norm;
}

/** 递归遍历一个子树，把通过过滤器的文件 fsPath 全部收进 out（排序由调用方做） */
function walkTree(
  dirFsPath: string,
  rel: string,
  depth: number,
  out: string[],
  stats: WalkStats,
  accept: (rel: string) => boolean,
  namedExts: ReadonlySet<string>,
): void {
  let listing: Array<{ name: string; isDir: boolean; isLink: boolean }>;
  try {
    const dirents = readdirSync(dirFsPath, { withFileTypes: true });
    listing = dirents.map((d) => ({
      name: d.name,
      isDir: d.isDirectory(),
      isLink: d.isSymbolicLink(),
    }));
  } catch {
    stats.failedDirs += 1;
    return;
  }
  listing.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of listing) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDir) {
      if (entry.isLink || DEFAULT_EXCLUDED_DIRS.has(entry.name) || depth + 1 > MAX_DEPTH) {
        stats.skippedDirs += 1;
        continue;
      }
      walkTree(
        path.join(dirFsPath, entry.name),
        childRel,
        depth + 1,
        out,
        stats,
        accept,
        namedExts,
      );
      continue;
    }
    if (isExcludedExt(childRel, namedExts)) {
      continue;
    }
    stats.found += 1;
    if (accept(childRel)) {
      out.push(path.join(dirFsPath, entry.name));
    }
  }
}

/** 只收某目录的直属文件（直属子目录由它们自己的 tree 条目覆盖） */
function collectDirectFiles(
  dirFsPath: string,
  rel: string,
  out: string[],
  stats: WalkStats,
  accept: (rel: string) => boolean,
  namedExts: ReadonlySet<string>,
): void {
  let listing: Array<{ name: string; isDir: boolean }>;
  try {
    const dirents = readdirSync(dirFsPath, { withFileTypes: true });
    listing = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
  } catch {
    stats.failedDirs += 1;
    return;
  }
  for (const entry of listing) {
    if (entry.isDir) {
      continue;
    }
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (isExcludedExt(childRel, namedExts)) {
      continue;
    }
    stats.found += 1;
    if (accept(childRel)) {
      out.push(path.join(dirFsPath, entry.name));
    }
  }
}

let session:
  | {
      start: WalkStart;
      accept: (rel: string) => boolean;
      namedExts: ReadonlySet<string>;
      stats: WalkStats;
    }
  | undefined;

async function processItem(
  item: { path: string; kind: 'tree' | 'files'; seq: number },
): Promise<void> {
  const s = session!;
  const out: string[] = [];
  const rel = relOf(item.path);
  if (item.kind === 'files') {
    collectDirectFiles(item.path, rel, out, s.stats, s.accept, s.namedExts);
  } else {
    walkTree(item.path, rel, 0, out, s.stats, s.accept, s.namedExts);
  }
  // 条目内排序：宿主按「活跃条目流」做 K 路归并，流必须有序
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // 空条目也要发一个空批次占位：宿主按 seq 记账，缺位的 seq 会让
  // nextSeq 永久卡住，该 worker 之后所有条目的数据全部饿死
  if (out.length === 0) {
    if (!(await waitCredit())) {
      return;
    }
    port!.postMessage({ type: 'batch', seq: item.seq, paths: [] });
    return;
  }
  for (let offset = 0; offset < out.length; offset += s.start.batch) {
    // finished 只表示「不再有条目」：手头条目的批次必须完整吐完，
    // 否则宿主收到的清单会缺尾巴（0.1.117 首版踩过：finish 广播丢整场批次）
    if (abort) {
      return;
    }
    if (!(await waitCredit())) {
      return;
    }
    port!.postMessage({
      type: 'batch',
      seq: item.seq,
      paths: out.slice(offset, offset + s.start.batch),
    });
  }
}

port!.on('message', (message: InMessage) => {
  if (message.type === 'abort') {
    abort = true;
    wakeCredits();
    return;
  }
  if (message.type === 'credit') {
    credits += message.n;
    wakeCredits();
    return;
  }
  if (message.type === 'walk') {
    if (session) {
      port!.postMessage({ type: 'fatal', message: 'overlapping walk message' });
      process.exit(1);
    }
    const namedExts = namedExcludedExts(message.include);
    const includeMatchers = splitFilters(message.include).map(globToRegExp);
    const excludeMatchers = splitFilters(message.exclude).map(globToRegExp);
    const allowedDirs = explicitDirs(splitFilters(message.include));
    const accept = (rel: string): boolean => {
      if (hasExcludedSegment(rel, allowedDirs)) {
        return false;
      }
      if (excludeMatchers.some((re) => re.test(rel))) {
        return false;
      }
      if (includeMatchers.length > 0 && !includeMatchers.some((re) => re.test(rel))) {
        return false;
      }
      return true;
    };
    session = {
      start: message,
      accept,
      namedExts,
      stats: { found: 0, skippedDirs: 0, failedDirs: 0 },
    };
    port!.postMessage({ type: 'ready' });
    return;
  }
  if (message.type === 'item') {
    if (!session) {
      return;
    }
    // itemDone 回报**增量**（宿主自己累加），避免累计值被重复计入
    const before = { ...session.stats };
    void processItem(message)
      .then(() => {
        port!.postMessage({
          type: 'itemDone',
          seq: message.seq,
          stats: {
            found: session!.stats.found - before.found,
            skippedDirs: session!.stats.skippedDirs - before.skippedDirs,
            failedDirs: session!.stats.failedDirs - before.failedDirs,
          },
        });
        port!.postMessage({ type: 'idle' });
      })
      .catch((error: unknown) => {
        port!.postMessage({
          type: 'fatal',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return;
  }
  // finish 无需回执：宿主看到「已发 finish + 所有 worker idle」即收工
});
