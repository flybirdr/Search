/**
 * 结果条目构造：宿主（controller.ts）与 Worker（workerMain.ts）共用。
 * 纯字符串逻辑，不依赖 vscode——Worker 的打包产物里不能出现 vscode 导入。
 */

/**
 * 「完整展示」的上限：这个长度以内的行原样返回，**不省略行首**。
 *
 * 结果列表本来就是横向滚动的（`.rec-body { overflow-x: auto }`），所以没有理由
 * 为了塞进一屏而把行首吃掉——内核代码的缩进层级、`if (...)` 的条件前缀都在行首，
 * 裁掉之后反而要回编辑器里看。2000 字符足够容纳任何正常的源码行（实测内核里
 * 最长的一行也就一千出头），同时给压缩成一行的 minified 文件留一道安全阀。
 */
export const PREVIEW_FULL_LIMIT = 2000;
/** 超长行窗口化时的窗口宽度 */
export const PREVIEW_WINDOW = 400;
/** 超长行窗口化时、命中前保留的上下文字符数 */
export const PREVIEW_LEAD = 120;

export interface PreviewItem {
  /** 结果列表里的序号，由调用方填 */
  id: number;
  /** 1 基行号（展示用） */
  line: number;
  /** 1 基列号（展示用） */
  column: number;
  preview: string;
  prefix: number;
  matchLen: number;
}

/**
 * 把一行原文 + 命中位置裁成结果列表里的一条。
 *
 * - 行长度 ≤ `PREVIEW_FULL_LIMIT`：整行返回，一个字符都不省。
 * - 超长行、命中在前段：从行首截到上限，只省略结尾——开头必须留着。
 * - 超长行、命中在后段：只能开窗（否则命中的那个字节根本进不了视野），
 *   窗口宽度 `PREVIEW_WINDOW`，命中前留 `PREVIEW_LEAD` 字符的上下文。
 */
export function makeItem(
  id: number,
  lineText: string,
  line: number,
  column: number,
  matchLen: number,
): PreviewItem {
  const text = lineText.endsWith('\r') ? lineText.slice(0, -1) : lineText;
  if (text.length <= PREVIEW_FULL_LIMIT) {
    return {
      id,
      line: line + 1,
      column: column + 1,
      preview: text,
      prefix: column,
      matchLen: Math.min(matchLen, Math.max(0, text.length - column)),
    };
  }

  // 命中整体落在前段：保住行首，只截尾巴
  if (column + matchLen <= PREVIEW_FULL_LIMIT) {
    return {
      id,
      line: line + 1,
      column: column + 1,
      preview: text.slice(0, PREVIEW_FULL_LIMIT) + '…',
      prefix: column,
      matchLen: Math.max(1, Math.min(matchLen, PREVIEW_FULL_LIMIT - column)),
    };
  }

  let start = Math.max(0, column - PREVIEW_LEAD);
  start = Math.min(start, text.length - PREVIEW_WINDOW);
  const sliced = text.slice(start, start + PREVIEW_WINDOW);
  const leading = start > 0 ? '…' : '';
  const trailing = start + PREVIEW_WINDOW < text.length ? '…' : '';
  return {
    id,
    line: line + 1,
    column: column + 1,
    preview: leading + sliced + trailing,
    prefix: column - start + leading.length,
    matchLen: Math.max(1, Math.min(matchLen, PREVIEW_WINDOW)),
  };
}
