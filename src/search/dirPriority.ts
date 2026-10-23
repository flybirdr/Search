/**
 * 目录优先级：记录用户点击搜索结果条目（或分组定位按钮）的次数，按
 * 「目标 + 沿途目录」聚合，**逐级递减**提升。
 *
 * 语义（0.1.124 起的明确规则）：点击 root/a/b/c/x.ts 一次——
 * - 文件自身 +（N+1）：被点中的文件下次搜索既优先扫描（其直属目录拿到
 *   目录链最高分）也在结果里按自身分数排到同类前面；
 * - `a/b/c`（所在目录）+N、`a/b` +(N-1)、`a` +1 —— 离文件越近的目录
 *   提升越多，沿途每个目录都依次递减（N = 目录链长度）。
 * 这样：
 * - 显示侧：文件分组按 max(目录分, 文件分) 排序，点得多的目录靠前；
 * - 遍历侧：条目（目录）按自身分数降序派发，热子树先遍历先扫描。
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
  /**
   * 点击了一个结果条目：目标自身最高分、沿途目录逐级递减提升。
   * target 通常是文件路径；传目录路径时目录自身拿最高分（分组「定位」按钮用）。
   */
  bump(targetFsPath: string, roots: readonly string[]): void;
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
    bump(targetFsPath, roots) {
      // 归一化后等于某个工作区根：根不是遍历条目，计它只会失真，直接忽略。
      // （目录「定位」按钮可能拿到根目录本身的分组——根直属文件的那一组。）
      const normTarget = normDir(targetFsPath);
      const isRoot = roots.some(
        (candidate) =>
          normDir(candidate.replace(/[\\/]+$/, '')) === normTarget,
      );
      if (isRoot) {
        return;
      }
      // 目录链：从目标的父目录逐级向上（不含根）。链为空有两种情形：目标
      // 就在根下（平铺工作区——目录链为空时目标自身的分数是唯一的区分度），
      // 或目标不在工作区里（不记）。
      const dirs = ancestorDirs(targetFsPath, roots);
      const underRoot = underAnyRoot(targetFsPath, roots);
      if (dirs.length === 0 && !underRoot) {
        return;
      }
      // 递减提升：目标自身最高（链长 + 1），所在目录次之（链长），
      // 越往上越少，最外层 +1。被点中的文件/目录由此在其兄弟中排最前。
      const top = dirs.length + 1;
      counts[normTarget] = (counts[normTarget] ?? 0) + top;
      for (let i = 0; i < dirs.length; i += 1) {
        const key = normDir(dirs[i]);
        counts[key] = (counts[key] ?? 0) + (dirs.length - i);
      }
      enforceCap();
      save();
      log?.(
        `dir priority: ${targetFsPath} +${top} chain=${dirs.length} ` +
          `(total ${Object.keys(counts).length} dirs)`,
      );
    },
    snapshot() {
      return { ...counts };
    },
  };
}
