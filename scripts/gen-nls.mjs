/**
 * 生成 VS Code 的 manifest 本地化文件。
 *
 * package.json 里面向用户的文案统一写成 `%key%`，
 * package.nls.json 是默认语言（英文），package.nls.zh-cn.json 是简体中文。
 * 运行 `node scripts/gen-nls.mjs` 重新生成两个 nls 文件。
 */
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const zh = {};
const en = {};

function put(key, zhText, enText) {
  zh[key] = zhText;
  en[key] = enText;
  return `%${key}%`;
}

pkg.displayName = put('displayName', '搜索', 'Search');
pkg.description = put(
  'description',
  '常驻查找替换面板：完整结果列表、匹配计数、全部标记、跨文件搜索。搜索内核由 Rust 实现。',
  'Persistent find & replace panel: full result list, match counting, mark all, and cross-file search. The search core is written in Rust.',
);

pkg.contributes.viewsContainers.activitybar[0].title = put('viewContainer.title', '搜索', 'Search');
pkg.contributes.views.flySearch[0].name = put('view.name', '搜索', 'Search');

const commandTitles = {
  openPanel: ['打开查找面板', 'Open Find Panel'],
  openReplace: ['打开查找面板（替换）', 'Open Find Panel (Replace)'],
  findNext: ['查找下一个', 'Find Next'],
  findPrev: ['查找上一个', 'Find Previous'],
  count: ['计数', 'Count Matches'],
  findAllInDocument: ['当前文档全部查找', 'Find All in Current Document'],
  findAllOpen: ['在工作区全部文件中查找', 'Find in All Workspace Files'],
  replaceOne: ['替换', 'Replace'],
  replaceAllInDocument: ['全部替换', 'Replace All'],
  markAll: ['标记全部', 'Mark All'],
  clearMarks: ['清除标记', 'Clear Marks'],
  copyMarked: ['复制标记文本', 'Copy Marked Text'],
  findInFiles: ['在文件中查找', 'Find in Files'],
  replaceInFiles: ['在文件中替换', 'Replace in Files'],
  showLog: ['查看搜索日志（诊断用）', 'Show Search Log (diagnostics)'],
  selfCheck: ['自检：检查跨文件搜索的枚举情况', 'Self-check: Cross-file Search Enumeration'],
};

for (const command of pkg.contributes.commands) {
  const name = command.command.split('.').pop();
  const titles = commandTitles[name];
  if (!titles) {
    throw new Error(`missing english title for command ${command.command}`);
  }
  command.title = put(`command.${name}`, titles[0], titles[1]);
  command.category = put('command.category', '搜索', 'Search');
}

const config = pkg.contributes.configuration;
config.title = put('config.title', '搜索', 'Search');

const configTexts = {
  defaultMode: ['默认搜索模式', 'Default search mode'],
  wrapAround: ['查找到达文档末尾后循环回开头', 'Wrap to the beginning after reaching the end of the document'],
  searchInSelection: ['默认只搜索选区（选中文本时）', 'Search the selection only (when text is selected)'],
  highlightAllMatches: ['搜索后在编辑器中高亮全部匹配', 'Highlight all matches in the editor after searching'],
  maxMatches: ['单次搜索返回的匹配数量上限', 'Upper limit of matches returned by a single search'],
  maxMatchesPerFile: [
    '跨文件搜索时单个文件最多保留的匹配数（默认 2000），避免一个巨型日志吃光全局额度。',
    'Maximum matches kept per file during a cross-file search (default 2000), so one huge log cannot exhaust the global budget.',
  ],
  maxFileSizeKB: [
    '单个文件参与搜索的体积上限（KB）。超过上限的文件会在结果卡片里被点名，不会静默跳过。默认 512000（500 MB）；超过 2 MB 的文件按块流式读取，内存占用与文件大小无关。',
    'Maximum file size (KB) included in a search. Files over the limit are named in the result card instead of being skipped silently. Default 512000 (500 MB). Files above 2 MB are streamed in chunks, so memory does not grow with file size.',
  ],
  streamThresholdKB: [
    '超过这个大小（KB）的文件改用分块流式搜索，内存占用恒定。默认 2048（2 MB）；设为 0 表示所有文件都流式读取。',
    'Files larger than this (KB) are searched in streaming chunks with constant memory. Default 2048 (2 MB); set to 0 to stream every file.',
  ],
  backtrackLimit: ['正则回溯步数上限，防止灾难性回溯卡死', 'Regex backtracking step limit, to stop catastrophic backtracking'],
  includeGlob: [
    '在文件中查找的文件过滤器（逗号分隔，支持 glob）',
    'File filter for Find in Files (comma-separated, glob supported)',
  ],
  excludeGlob: [
    '在文件中查找时排除的 glob（逗号分隔）',
    'Glob patterns excluded from Find in Files (comma-separated)',
  ],
  takeOverFindShortcut: [
    '用 Ctrl+F / Ctrl+H 直接打开本面板（覆盖 VS Code 原生查找）',
    "Open this panel with Ctrl+F / Ctrl+H (overrides VS Code's built-in find)",
  ],
};

for (const [name, [zhText, enText]] of Object.entries(configTexts)) {
  const property = config.properties[`flySearch.${name}`];
  if (!property) {
    throw new Error(`missing config property flySearch.${name}`);
  }
  property.description = put(`config.${name}`, zhText, enText);
}

const modeTexts = [
  ['普通：全部按字面量匹配', 'Normal: everything matched literally'],
  ['扩展：支持 \\n \\t \\r \\xHH \\uHHHH', 'Extended: supports \\n \\t \\r \\xHH \\uHHHH'],
  ['正则：fancy-regex 语法', 'Regex: fancy-regex syntax'],
];
config.properties['flySearch.defaultMode'].enumDescriptions = modeTexts.map(([zhText, enText], index) =>
  put(`config.defaultMode.enum.${index}`, zhText, enText),
);

fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
fs.writeFileSync('package.nls.json', JSON.stringify(en, null, 2) + '\n');
fs.writeFileSync('package.nls.zh-cn.json', JSON.stringify(zh, null, 2) + '\n');

console.log(`keys=${Object.keys(en).length}`);
