/**
 * 目录优先级（0.1.118）：记录用户点击搜索结果条目的次数，按**目录**聚合。
 *
 * 语义（对应「优先搜索对应目录/父目录」）：点击 root/a/b/c/x.ts 一次，
 * `a/b/c`、`a/b`、`a` 各 +1（逐级向上传播到工作区根为止）——这样
 * - 显示侧：文件分组按「其父目录的计数」排序，点得多的目录结果靠前；
 * - 遍历侧：包含热目录的子树条目计数更高，先派发先扫描（祖先已传播，
 *   条目直接查自己的计数即可）。
 *
 * 存储：storageUri 下的 JSON 文件（ext host 直读写，不进渲染进程——
 * 0.1.97 的教训）。规模有硬上限（MAX_ENTRIES，超限淘汰计数最小的），
 * 几十 KB 量级，读写成本可忽略。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/** 条目（目录）数上限：超出后淘汰计数最小的，防止无限增长 */
export const MAX_ENTRIES = 1000;
const FILE_NAME = 'dir-priority.v1.json';
const MAX_STORE_BYTES = 256 * 1024;

export interface DirPriorityStore {
  /** 点击了一个结果文件：其父目录与各级祖先（到工作区根为止）各 +1 */
  bump(fileFsPath: string, roots: readonly string[]): void;
  /** 当前计数的副本（搜索开始时快照，场内不变） */
  snapshot(): Record<string, number>;
}

/**
 * 归一化路径用于做 key：Windows 盘符大小写 / 分隔符差异会让同一目录
 * 记成两份。统一小写 + 反斜杠转正斜杠（Linux 路径本来小写敏感的场景里，
 * 大小写不同的目录本来就是不同目录——这里取「宁可合并」的 pragmatic 解，
 * 因为优先级是模糊信号，不是精确身份）。
 */
function normDir(dir: string): string {
  return dir.replace(/\\/g, '/').toLowerCase();
}

/** 计数表 → 「条目路径 → 分数」。key 归一化在 bump 侧完成，查表同样归一化。 */
export function scoreOf(counts: Record<string, number>, dirFsPath: string): number {
  // 容忍未归一化的 key（调用方手工构造的表）：先原样查，再按归一化查
  return counts[dirFsPath] ?? counts[normDir(dirFsPath)] ?? 0;
}

/**
 * 点击计数的祖先传播链：从文件的父目录一路向上，**不含**工作区根本身
 * （root 不是一个遍历条目，计它没有意义且数字会失真）。
 */
export function ancestorDirs(fileFsPath: string, roots: readonly string[]): string[] {
  const dirs: string[] = [];
  let dir = path.dirname(fileFsPath);
  // 找到包含该文件的最长匹配根；找不到（文件不在工作区里）就不记。
  // Windows 不区分大小写（盘符 d:/D:、目录大小写因来源而异），匹配必须
  // 折叠大小写——否则点击静默不计（计数文件都不落盘，问题还很难发现）。
  const fold = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  const normFile = fold(fileFsPath.replace(/\\/g, '/'));
  let root: string | undefined;
  for (const candidate of roots) {
    const normCandidate = fold(candidate.replace(/[\\/]+$/, '').replace(/\\/g, '/'));
    if (normFile === normCandidate || normFile.startsWith(`${normCandidate}/`)) {
      if (root === undefined || normCandidate.length > root.length) {
        root = normCandidate;
      }
    }
  }
  if (root === undefined) {
    return dirs;
  }
  const normRoot = normDir(root);
  while (true) {
    const norm = normDir(dir);
    if (norm === normRoot || norm.length <= normRoot.length) {
      break;
    }
    dirs.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return dirs;
}

/** 文件是否落在任一工作区根内（大小写折叠与 ancestorDirs 一致）。 */
export function underAnyRoot(fileFsPath: string, roots: readonly string[]): boolean {
  const normFile = fileFsPath.replace(/\\/g, '/').toLowerCase();
  return roots.some((candidate) => {
    const norm = candidate.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
    return normFile === norm || normFile.startsWith(`${norm}/`);
  });
}

export function createDirPriorityStore(
  storageDir: string | undefined,
  log?: (line: string) => void,
): DirPriorityStore {
  let counts: Record<string, number> = {};
  const file = storageDir ? path.join(storageDir, FILE_NAME) : undefined;

  // 启动时读一次：坏文件 / 超大文件按无数据处理
  if (file) {
    try {
      if (existsSync(file)) {
        const text = readFileSync(file, 'utf8');
        if (text.length <= MAX_STORE_BYTES) {
          const parsed = JSON.parse(text) as { v?: number; counts?: Record<string, number> };
          if (parsed && parsed.v === 1 && parsed.counts && typeof parsed.counts === 'object') {
            counts = parsed.counts;
            log?.(`dir priority restored: ${Object.keys(counts).length} dirs`);
          }
        } else {
          log?.('dir priority file oversized, ignored');
        }
      }
    } catch (error) {
      log?.(
        `dir priority restore failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const save = (): void => {
    if (!file) {
      return;
    }
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      // 先写临时文件再改名：写一半崩溃不留半截 JSON（与历史文件同一策略）
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, counts }));
      renameSync(tmp, file);
    } catch (error) {
      log?.(
        `dir priority persist failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const enforceCap = (): void => {
    const keys = Object.keys(counts);
    if (keys.length <= MAX_ENTRIES) {
      return;
    }
    const sorted = keys.sort((a, b) => counts[a] - counts[b]);
    for (const key of sorted.slice(0, keys.length - MAX_ENTRIES)) {
      delete counts[key];
    }
  };

  return {
    bump(fileFsPath, roots) {
      // 目录链：父目录逐级向上（不含根）。链为空有两种情形：文件就在根下
      //（平铺工作区，如 Downloads/1022/log——目录粒度在这里没有任何区分度，
      // 0.1.120 之前点击因此**静默不计**），或文件不在工作区里。
      const dirs = ancestorDirs(fileFsPath, roots);
      const underRoot = underAnyRoot(fileFsPath, roots);
      if (dirs.length === 0 && !underRoot) {
        return;
      }
      // 被点文件本身也记 1 分：平铺根目录里只有它能把自己顶到前排；
      // 嵌套目录里重复点同一文件也会让它在其目录的兄弟中排前
      counts[normDir(fileFsPath)] = (counts[normDir(fileFsPath)] ?? 0) + 1;
      for (const dir of dirs) {
        const key = normDir(dir);
        counts[key] = (counts[key] ?? 0) + 1;
      }
      enforceCap();
      save();
      log?.(
        `dir priority: ${dirs[0] ?? fileFsPath} +${dirs.length + 1} ` +
          `(total ${Object.keys(counts).length} dirs)`,
      );
    },
    snapshot() {
      return { ...counts };
    },
  };
}
