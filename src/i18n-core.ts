export const EN: Record<string, string> = {
  // ── 面板静态骨架（html.ts） ──
  搜索: 'Search',
  查找目标: 'Find',
  要查找的内容: 'Text to find',
  '在当前文档中查找全部 (Enter)': 'Find all in current document (Enter)',
  全部: 'All',
  '在工作区的全部文件中搜索（过滤器取高级里的设置）':
    'Search every file in the workspace (filters from Advanced)',
  高级: 'Advanced',
  收起: 'Less',
  'Enter 搜索 · Esc 回到编辑区': 'Enter to search · Esc to editor',
  替换为: 'Replace with',
  '替换内容，可用 $1 或命名组': 'Replacement; $1 and named groups are supported',
  搜索模式: 'Search mode',
  普通: 'Normal',
  扩展: 'Extended',
  正则: 'Regex',
  '. 匹配换行': '. matches newline',
  选项: 'Options',
  全字匹配: 'Whole word',
  区分大小写: 'Match case',
  循环查找: 'Wrap around',
  在选区内查找: 'In selection',
  查找上一个: 'Prev',
  查找下一个: 'Next',
  上一个: 'Prev',
  下一个: 'Next',
  '当前命中位置 / 总数': 'Current match position / total',
  标记全部: 'Mark all',
  标记当前文档中的全部匹配: 'Mark every match in the current document',
  替换: 'Replace',
  全部替换: 'Replace all',
  '替换当前搜索结果中的全部匹配：文档搜索在本文档内替换，工作区搜索跨文件替换':
    'Replace every match in the current search results: document searches replace in that document, workspace searches replace across files',
  清除标记: 'Clear marks',
  过滤器: 'Filters',
  搜索结果: 'Results',
  '搜索结果（{n}）': 'Results ({n})',
  '已达到匹配上限，只列出了前 {n} 条，未列出的部分没有统计':
    'Result limit reached: only the first {n} matches are listed; the rest were not counted',
  统计完整数量: 'Count all matches',
  '正在统计…': 'Counting…',
  '{listed} / {total} 处': '{listed} / {total} matches',
  '共 {n} 处；已列出前 {m} 条': '{n} matches in total; the first {m} are listed',
  '共 {n} 处以上（近似值，跨块匹配可能漏计）；已列出前 {m} 条':
    'More than {n} matches (approximate: matches spanning chunks may be missed); the first {m} are listed',
  清空: 'Clear',
  停止: 'Stop',
  折叠全部: 'Collapse all',
  展开全部: 'Expand all',
  '输入内容后按 Enter 开始搜索': 'Type something and press Enter to search',
  本次搜索用时: 'Search time',
  扫描文件总大小: 'Total size scanned',

  // ── 面板运行时（panel.js） ──
  '搜索中…': 'Searching…',
  '第 {line} 行，第 {col} 列': 'Line {line}, column {col}',
  '点击折叠 / 展开': 'Click to collapse / expand',
  '该文件命中数超过单文件上限，只保留了前 {n} 条':
    'This file exceeded the per-file limit; only the first {n} are shown',
  '当前位置：{d}，点击折叠': 'Now in {d}; click to collapse',
  '{n} 处': '{n} hits',
  '搜索中，结果会陆续出现…': 'Searching… results appear as each file finishes',
  没有匹配: 'No matches',
  '折叠 / 展开这条结果': 'Collapse / expand this result',
  '{n} 文件': '{n} files',
  这条结果覆盖的文件数: 'Number of files covered by this result',
  删除这条结果记录: 'Remove this result',

  // ── 控制器状态与卡片（controller.ts） ──
  已清除所有标记: 'All marks cleared',
  已清空结果记录: 'Result history cleared',
  已取消统计: 'Exact count cancelled',
  '统计中…': 'Counting…',
  '统计中 {s}/{f}': 'Counting {s}/{f}',
  收起全部结果卡片与文件分组: 'Collapse all result cards and file groups',
  展开全部结果卡片与文件分组: 'Expand all result cards and file groups',
  当前文档没有标记: 'No marks in the current document',
  '已复制 {n} 行标记文本': 'Copied {n} marked lines',
  没有打开的编辑器: 'No active editor',
  请输入查找内容: 'Enter something to find',
  '计数：{n} 处（当前文档）': 'Count: {n} in the current document',
  ' · 仅在选区内': ' · selection only',
  当前文档: 'Current document',
  '未找到匹配 · {ms} ms': 'No matches · {ms} ms',
  需要先打开一个工作区文件夹: 'Open a workspace folder first',
  '工作区里没有遍历到任何文件，请确认已打开文件夹':
    'No files found in the workspace; make sure a folder is open',
  '遍历到 {n} 个文件，但都被过滤器排除了（过滤器：{g}）':
    'Found {n} files, but the filter excluded all of them ({g})',
  '{s}/{f} · {n} 处': '{s}/{f} · {n} hits',
  '{file} · {size} · {n} 处': '{file} · {size} · {n} hits',
  在文件中: 'In files',
  '在 {n} 个文件中未找到匹配 · {ms} ms': 'No matches in {n} files · {ms} ms',
  ' · 跳过 {n} 个文件': ' · skipped {n} files',
  ' · 已达上限，未扫完 {n} 个文件': ' · limit reached; {n} files not scanned',
  '第 {i} / {n} 处': '{i} / {n}',
  当前文档没有匹配: 'No matches in the current document',
  '已替换 1 处': 'Replaced 1 match',
  没有可替换的匹配: 'Nothing to replace',
  '确定替换当前文档中的 {n} 处匹配？': 'Replace {n} matches in the current document?',
  替换失败: 'Replace failed',
  '已替换 {n} 处': 'Replaced {n} matches',
  '请先执行搜索，再全部替换': 'Run a search first, then replace all',
  '将在 {f} 个文件中替换 {n} 处匹配，是否继续？': 'Replace {n} matches across {f} files?',
  '已修改 {f} 个文件（尚未保存）': 'Modified {f} files (not saved yet)',
  '已标记 {n} 处': 'Marked {n} matches',
  '自检：当前窗口没有打开工作区文件夹': 'Self-check: no workspace folder is open',
  '自检：遍历 {found} 个，保留 {kept} 个（来源 {via}，详见输出面板）':
    'Self-check: walked {found}, kept {kept} (via {via}; see the Output panel)',
  '.匹配换行': '. matches newline',
  选区内: 'in selection',
  请先输入查找内容: 'Enter something to find first',

  // ── 内核与扩展宿主 ──
  表达式编译失败: 'Failed to compile the expression',
  搜索失败: 'Search failed',
  行起点计算失败: 'Failed to compute line starts',
  '（回溯步数超过上限，请简化表达式或调高 flySearch.backtrackLimit）':
    ' (backtrack limit exceeded; simplify the pattern or raise flySearch.backtrackLimit)',
  '搜索内核加载失败': 'Failed to load the search core',
};

import type { Lang } from './i18n-types';

/** 当前语言。宿主启动时用 setLang 写入；测试与中文环境默认 zh。 */
let active: Lang = 'zh';

export function setLang(lang: Lang): void {
  active = lang;
}

export function getLang(): Lang {
  return active;
}

/** 把 `{n}` 这类占位符替换成具体值。 */
export function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) {
    return text;
  }
  let out = text;
  for (const key of Object.keys(vars)) {
    out = out.split(`{${key}}`).join(String(vars[key]));
  }
  return out;
}

export function translate(
  lang: Lang,
  zh: string,
  vars?: Record<string, string | number>,
): string {
  const text = lang === 'en' ? EN[zh] ?? zh : zh;
  return fill(text, vars);
}

/** 按当前语言翻译一条文案；英文缺条目时回退中文。 */
export function t(zh: string, vars?: Record<string, string | number>): string {
  return translate(active, zh, vars);
}

/** 给前端的「中文原文 → 译文」表；中文环境为空表。 */
export function dictionary(lang: Lang = active): Record<string, string> {
  return lang === 'en' ? EN : {};
}
