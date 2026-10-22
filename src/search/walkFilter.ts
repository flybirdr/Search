/**
 * 遍历的纯过滤逻辑：目录黑名单、扩展名黑名单、glob 过滤器解释。
 *
 * 独立成无依赖模块的原因：walkWorker / walkSession 也要用同一套规则，
 * 而它们是（或被）worker 线程入口——绝不能经 ./files 间接引入 vscode。
 */
export interface WalkStats {
  /** 遍历到的文件总数（扩展名排除后、include/exclude 过滤前） */
  found: number;
  /** 被 include/exclude 过滤器排除的文件数 */
  filtered: number;
  /** 因为默认规则跳过的目录数 */
  skippedDirs: number;
  /** 读取失败的目录数 */
  failedDirs: number;
  /** 清单来源：Node fs 直读，或 vscode.workspace.fs（远程 / 虚拟文件系统） */
  via: 'fs' | 'vscode-fs';
}

export const DEFAULT_EXCLUDED_DIRS = new Set([
  'node_modules',
  'bower_components',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'out',
  'build',
  'target',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.gradle',
]);

export function explicitDirs(globs: string[]): Set<string> {
  const out = new Set<string>();
  for (const glob of globs) {
    const first = glob.replace(/^\.\//, '').split('/')[0];
    if (first && !/[*?{}]/.test(first)) {
      out.add(first);
    }
  }
  return out;
}

export function hasExcludedSegment(relPath: string, allowed: Set<string>): boolean {
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (DEFAULT_EXCLUDED_DIRS.has(parts[i]) && !allowed.has(parts[i])) {
      return true;
    }
  }
  return false;
}

export function isExcludedExt(relPath: string, namedExts: ReadonlySet<string>): boolean {
  const lower = relPath.toLowerCase();
  const last = lower.lastIndexOf('.');
  if (last < 0) {
    return false;
  }
  if (DEFAULT_EXCLUDED_EXTS.has(lower.slice(last)) && !namedExts.has(lower.slice(last))) {
    return true;
  }
  const prev = lower.lastIndexOf('.', last - 1);
  return (
    prev >= 0 &&
    DEFAULT_EXCLUDED_EXTS.has(lower.slice(prev)) &&
    !namedExts.has(lower.slice(prev))
  );
}

export function namedExcludedExts(include: string | undefined): Set<string> {
  const lower = (include || '').toLowerCase();
  const named = new Set<string>();
  for (const ext of DEFAULT_EXCLUDED_EXTS) {
    if (lower.includes(ext)) {
      named.add(ext);
    }
  }
  return named;
}

export const DEFAULT_EXCLUDED_EXTS = new Set([
  // 编译产物 / 二进制库
  '.o', '.obj', '.a', '.lib', '.so', '.dll', '.dylib', '.exe', '.ko', '.elf', '.bin',
  // ABI dump（AOSP）：.so.lsdump 被 .lsdump 命中，这里显式列出仅为可读性
  '.lsdump', '.so.lsdump',
  // 归档 / 压缩包
  '.zip', '.jar', '.apk', '.aab', '.war', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst', '.7z', '.rar',
  // 镜像 / 固件 / 设备树
  '.img', '.iso', '.dtb', '.dtbo', '.vbmeta', '.pak', '.rcc',
  // 图片
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.tiff',
  // 字体
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // 音视频
  '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.avi', '.mkv', '.mov', '.webm',
  // 文档 / 数据库 / 字节码
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.db', '.sqlite', '.pyc', '.class', '.wasm',
]);
