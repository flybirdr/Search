import * as vscode from 'vscode';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import iconv from 'iconv-lite';
import { globToRegExp, splitFilters } from './glob';
import { walkSessionGen } from './walkSession';
export {
  DEFAULT_EXCLUDED_DIRS,
  DEFAULT_EXCLUDED_EXTS,
  explicitDirs,
  hasExcludedSegment,
  isExcludedExt,
  namedExcludedExts,
} from './walkFilter';
export type { WalkStats } from './walkFilter';
import type { WalkStats } from './walkFilter';
import {
  DEFAULT_EXCLUDED_DIRS,
  explicitDirs,
  hasExcludedSegment,
  isExcludedExt,
  namedExcludedExts,
} from './walkFilter';


export { globToRegExp, matchesAny, pickPrimitive, splitFilters } from './glob';

/**
 * 默认跳过的目录名。这些目录体积大、几乎从不参与文本搜索，
 * 交给 VS Code 的 glob 排除容易受解析细节影响，所以自己按路径段判断。
 */


/**
 * 从过滤器里提取“用户显式点名的目录”。
 * 如果用户把 dist 写进了过滤器，说明他确实想搜这个目录，默认排除必须让路。
 */




/**
 * 默认按扩展名排除的非文本文件。这些文件几乎从不参与文本搜索，不少还是
 * 大文件（.so/.jar/.img），放进 worker 逐个 open+8KB 二进制探测纯属浪费
 * IO；另有 .so.lsdump 这类「其实是文本」的 ABI dump（AOSP），二进制探测
 * 拦不住，必须在扩展名层拦。键为小写后缀（含点），匹配走 O(1) Set 查询。
 */


/**
 * 扩展名排除：查最后一段后缀，未命中再查最后两段（覆盖 .so.lsdump /
 * .tar.gz 这类双扩展）。每个文件最多两次 O(1) Set 查询。
 * namedExts 是用户过滤器显式点名的黑名单扩展——点名必搜，让路。
 */


/** 用户过滤器显式点名了的黑名单扩展（子串匹配，够用）：点名必搜。 */


/** 遍历统计（生成器的返回值；文件本体是逐个 yield 出去的，不攒清单）。 */


/** vscode.FileType 的数值，避免在遍历里反复取枚举。 */
const FILE_TYPE_DIRECTORY = 2;
const FILE_TYPE_SYMLINK = 64;
// readdir 是廉价系统调用，深树并发越高越快；64 路对 ext host 的事件循环
// 也毫无压力（每批 64 个 await 一次）
const WALK_CONCURRENCY = 64;
const MAX_DEPTH = 32;

/** 目录项的归一形态：Node Dirent 与 vscode [name, FileType] 都折算成它。 */
interface DirEntry {
  name: string;
  isDir: boolean;
  isLink: boolean;
}

/**
 * 遍历队列任务。uri 字段有值表示这个子树走 vscode.workspace.fs
 * （远程 / 虚拟文件系统），否则走 Node fs 直读（本地盘）。
 */
interface WalkTask {
  fsPath: string;
  uri?: vscode.Uri;
  rel: string;
  depth: number;
}

/** 遍历产物：过滤器要的相对路径 + 派发要的本地路径。 */
interface WalkedFile {
  rel: string;
  fsPath: string;
}

async function readDir(task: WalkTask): Promise<DirEntry[]> {
  if (task.uri) {
    const listing = await vscode.workspace.fs.readDirectory(task.uri);
    return listing.map(([name, type]) => ({
      name,
      isDir: (type & FILE_TYPE_DIRECTORY) !== 0,
      isLink: (type & FILE_TYPE_SYMLINK) !== 0,
    }));
  }
  const dirents = await fsp.readdir(task.fsPath, { withFileTypes: true });
  return dirents.map((d) => ({
    name: d.name,
    isDir: d.isDirectory(),
    isLink: d.isSymbolicLink(),
  }));
}

/**
 * 实时遍历一个工作区根目录，逐个产出文件（已按扩展名排除）。
 *
 * **每次搜索都全新遍历，没有任何缓存**：FileListCache / watcher / 持久化
 * 那一整套在 0.1.112 及之前被证明是大工作区内存问题的温床（ext host 常驻
 * 百万级清单），而它换来的只是「第二次搜索免枚举」——直读文件系统的遍历
 * 本身只要秒级，不值得为它养一套失效逻辑。Node fs 绕开 VS Code 的逐目录
 * RPC，是这里速度的来源。
 *
 * 生成器形态是生产者-消费者的关键：消费者（worker 池 / legacy 扫描）拉一个
 * 才往下走一层，枚举与扫描全程重叠，不存在「等全量清单」的环节。
 * 目录内条目按名字排序后处理：产出顺序因此确定（BFS + 目录内字典序）。
 */
async function* walkFolderGen(
  folder: vscode.WorkspaceFolder,
  useNodeFs: boolean,
  allowedDirs: Set<string>,
  namedExts: ReadonlySet<string>,
  stats: { found: number; skippedDirs: number; failedDirs: number },
  onProgress?: (found: number) => void,
): AsyncGenerator<WalkedFile, void, void> {
  let level: WalkTask[] = [
    useNodeFs
      ? { fsPath: folder.uri.fsPath, rel: '', depth: 0 }
      : { fsPath: folder.uri.fsPath, uri: folder.uri, rel: '', depth: 0 },
  ];

  while (level.length > 0) {
    const next: WalkTask[] = [];
    for (let offset = 0; offset < level.length; offset += WALK_CONCURRENCY) {
      const batch = level.slice(offset, offset + WALK_CONCURRENCY);
      const listings = await Promise.all(
        batch.map(async (task) => {
          try {
            return await readDir(task);
          } catch {
            stats.failedDirs += 1;
            return null;
          }
        }),
      );

      for (let i = 0; i < batch.length; i += 1) {
        const listing = listings[i];
        if (!listing) {
          continue;
        }
        const task = batch[i];
        // 目录内排序：并发 readdir 的返回顺序不稳定，产出顺序要确定
        listing.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of listing) {
          const rel = task.rel ? `${task.rel}/${entry.name}` : entry.name;
          if (entry.isDir) {
            // 符号链接目录不进入，避免环形链接把遍历卡死
            if (entry.isLink) {
              stats.skippedDirs += 1;
              continue;
            }
            if (DEFAULT_EXCLUDED_DIRS.has(entry.name) && !allowedDirs.has(entry.name)) {
              stats.skippedDirs += 1;
              continue;
            }
            if (task.depth + 1 > MAX_DEPTH) {
              stats.skippedDirs += 1;
              continue;
            }
            next.push(
              task.uri
                ? {
                    fsPath: '',
                    uri: vscode.Uri.joinPath(task.uri, entry.name),
                    rel,
                    depth: task.depth + 1,
                  }
                : { fsPath: path.join(task.fsPath, entry.name), rel, depth: task.depth + 1 },
            );
            continue;
          }
          // 非文本扩展名在遍历阶段就跳过：不计 found（用户点名了的扩展
          // 经 namedExts 让路，必搜）
          if (isExcludedExt(rel, namedExts)) {
            continue;
          }
          stats.found += 1;
          if (onProgress && stats.found % 500 === 0) {
            onProgress(stats.found);
          }
          yield {
            rel,
            fsPath: task.uri
              ? vscode.Uri.joinPath(task.uri, entry.name).fsPath
              : path.join(task.fsPath, entry.name),
          };
        }
      }
    }
    level = next;
  }
}

/**
 * 枚举工作区文件清单：**每次调用都实时遍历文件系统**。
 *
 * 本地盘（file scheme）用 Node fs 直读，绕开 VS Code 的逐目录 RPC 与
 * findFiles 的进程开销；远程 / 虚拟文件系统自动退回 vscode.workspace.fs。
 * 不设文件数上限（0.1.113 起 maxFiles 已删）：清单是每次搜索的临时对象，
 * 搜索结束即可回收，常驻内存为零，没有截断也就没有「结果随上限漂移」。
 *
 * 确定性：遍历顺序不稳定（并发），但结果**按路径排序**后交给过滤器，
 * 同样的工作区内容每次搜索拿到完全一致的清单。
 *
 * 注意口径差异：直读文件系统不认识 files.exclude / .gitignore（与
 * findFiles 不同），排除全靠本文件的目录 / 扩展名黑名单与用户过滤器。
 */
export async function* iterateWorkspaceFiles(
  include: string | undefined,
  exclude: string | undefined,
  onProgress?: (found: number) => void,
): AsyncGenerator<string, WalkStats, void> {
  const includeGlobs = splitFilters(include);
  const excludeGlobs = splitFilters(exclude);
  const allowedDirs = explicitDirs(includeGlobs);
  const includeMatchers = includeGlobs.map(globToRegExp);
  const excludeMatchers = excludeGlobs.map(globToRegExp);
  // 用户过滤器点名了的黑名单扩展：点名必搜，遍历阶段就让路
  const namedExts = namedExcludedExts(include);

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

  const folders = vscode.workspace.workspaceFolders ?? [];
  const stats = { found: 0, skippedDirs: 0, failedDirs: 0 };
  if (folders.length === 0) {
    return { found: 0, filtered: 0, skippedDirs: 0, failedDirs: 0, via: 'fs' };
  }

  let filtered = 0;
  let via: WalkStats['via'] = 'fs';

  for (const folder of folders) {
    const consume = async function* (gen: AsyncGenerator<WalkedFile, void, void>) {
      for await (const file of gen) {
        if (accept(file.rel)) {
          yield file.fsPath;
        } else {
          filtered += 1;
        }
      }
    };
    if (folder.uri.scheme !== 'file') {
      via = 'vscode-fs';
      yield* consume(
        walkFolderGen(folder, false, allowedDirs, namedExts, stats, onProgress),
      );
      continue;
    }
    // 本地盘直读。颗粒无收且有目录读失败（盘符缺失 / 权限 / 受限环境里
    // Node fs 不可用）时，退回 vscode.workspace.fs 再试一遍——VS Code 的
    // 文件系统提供者在这些场景下仍可用。
    const beforeFailed = stats.failedDirs;
    let produced = 0;
    for await (const file of consume(
      walkFolderGen(folder, true, allowedDirs, namedExts, stats, onProgress),
    )) {
      produced += 1;
      yield file;
    }
    if (produced === 0 && stats.failedDirs > beforeFailed) {
      const beforeRetry = stats.failedDirs;
      let retried = 0;
      for await (const file of consume(
        walkFolderGen(folder, false, allowedDirs, namedExts, stats, onProgress),
      )) {
        retried += 1;
        yield file;
      }
      if (retried > 0 && stats.failedDirs === beforeRetry) {
        via = 'vscode-fs';
      }
    }
  }

  return {
    found: stats.found,
    filtered,
    skippedDirs: stats.skippedDirs,
    failedDirs: stats.failedDirs,
    via,
  };
}

/**
 * 统一的清单流入口：可插拔地在「worker 并行遍历」与「宿主内遍历」之间选择。
 *
 * worker 模式（0.1.117）：单根 + 本地盘 + walkWorker 脚本可用时，遍历外包给
 * K 个专职线程（ readdir 真并行，ext host 彻底解放）；其余情况（多根、远程、
 * 关闭开关、脚本缺失）回落宿主内遍历。两者产出同一接口：逐个 yield fsPath，
 * 返回 WalkStats——调用方无感。
 */
export interface WalkStreamOptions {
  /** walkWorker.js 的绝对路径；缺省走宿主内遍历 */
  workerScript?: string;
  /** 遍历线程数：-1=强制宿主内，0=自动，1~16=固定 */
  threads: number;
  /** 顺序模式：fast=到达序（吞吐），sorted=全局字典序（可复现） */
  order: 'fast' | 'sorted';
  /**
   * 目录优先级（0.1.118）：热子树的遍历条目先派发先扫描。宿主内回退路径
   * （多根 / 远程 / 关闭 worker）不支持重排——流式生成器没有全量清单，
   * 优先级只作用于显示排序。
   */
  priorities?: Record<string, number>;
  /** 取消检查：worker 遍历模式必须能被 Stop 打断（0.1.119 死锁/打断修复） */
  shouldAbort?: () => boolean;
}

export async function* createWalkStream(
  include: string | undefined,
  exclude: string | undefined,
  onProgress: ((found: number) => void) | undefined,
  options: WalkStreamOptions,
): AsyncGenerator<string, WalkStats, void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const canWorker =
    options.threads >= 1 &&
    typeof options.workerScript === 'string' &&
    folders.length === 1 &&
    folders[0].uri.scheme === 'file';
  if (canWorker) {
    return yield* walkSessionGen({
      workerScript: options.workerScript as string,
      rootFsPath: folders[0].uri.fsPath,
      include,
      exclude,
      threads: options.threads,
      order: options.order,
      priorities: options.priorities,
      shouldAbort: options.shouldAbort,
      onProgress,
    });
  }
  return yield* iterateWorkspaceFiles(include, exclude, onProgress);
}

// ---------------------------------------------------------------- 读取与解码

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** 字节路径的读取结果：bytes 已经是 UTF-8（必要时转码过），直接可进内核。 */
export type BytesReadResult =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'binary' }
  | { kind: 'tooLarge'; size: number };

const bytesEncoder = new TextEncoder();

/**
 * 整文件读入 + 编码判定（legacy 单线程路径用；worker 路径自己流式读）。
 * 编码判定与旧字符串路径完全一致：UTF-8 直传，UTF-16 BOM / GBK 才转码。
 * @param fsPath 文件本地路径；经由 vscode.workspace.fs 读取，测试环境
 *   的 mock 文件系统也能覆盖。
 * @param knownSize 调用方已经 stat 过时传进来，省掉一次往返。
 */
export async function readFileBytes(
  fsPath: string,
  maxBytes: number,
  knownSize?: number,
): Promise<BytesReadResult> {
  const uri = vscode.Uri.file(fsPath);
  const size = knownSize ?? (await vscode.workspace.fs.stat(uri)).size;
  if (size > maxBytes) {
    return { kind: 'tooLarge', size };
  }
  const buffer = await vscode.workspace.fs.readFile(uri);
  if (buffer.length === 0) {
    return { kind: 'bytes', bytes: buffer };
  }

  let head = 0;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    // UTF-16LE：先解码再统一成 UTF-8 字节（这类文件很少，逐个转码可接受）
    return {
      kind: 'bytes',
      bytes: bytesEncoder.encode(new TextDecoder('utf-16le').decode(buffer.subarray(2))),
    };
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return {
      kind: 'bytes',
      bytes: bytesEncoder.encode(new TextDecoder('utf-16be').decode(buffer.subarray(2))),
    };
  }
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    head = 3;
  }

  const probe = Math.min(buffer.length, 8192);
  for (let i = head; i < probe; i += 1) {
    if (buffer[i] === 0) {
      return { kind: 'binary' };
    }
  }

  const body = head > 0 ? buffer.subarray(head) : buffer;
  try {
    // 严格解码只做 UTF-8 校验，结果字符串随即丢弃——匹配走原始字节
    utf8Strict.decode(body);
    return { kind: 'bytes', bytes: body };
  } catch {
    try {
      return { kind: 'bytes', bytes: bytesEncoder.encode(iconv.decode(Buffer.from(body), 'gbk')) };
    } catch {
      return { kind: 'binary' };
    }
  }
}
