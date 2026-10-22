/**
 * 用真实磁盘目录跑一遍「在文件中搜索」的完整链路。
 * 前面的 files.test.mjs 用的是内存假树，这个用例换成真实 fs，
 * 能覆盖编码探测、文件读取、wasm 内核跨文件复用等真实细节。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

// ---------------------------------------------------------------- 真实临时工作区
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-ws-'));
const layout = {
  'README.md': '# token 说明\n这里提到 token 一次\n',
  'src/a.ts': 'const token = 1;\nconst again = token;\n',
  'src/b.ts': 'export function token() {}\n',
  'src/nested/c.ts': 'let token = 3;\n',
  'src/nested/deep/d.ts': 'token\n',
  'scripts/build.js': 'var token = 4;\n',
  'docs/guide.md': 'the token appears here\n',
  'empty.txt': '',
  // 无扩展名：扩展名黑名单不拦，专门覆盖 NUL 二进制探测这条路径
  'binaryblob': Buffer.from([0x00, 0x01, 0x02, 0x74, 0x6f, 0x6b, 0x65, 0x6e]),
  'crlf.txt': 'first token\r\nsecond token\r\n',
};
// 非 UTF-8 编码的文件（字节直传路径的转码分支）：
// GBK 需要 iconv 转码，UTF-16LE 走 BOM 分支，命中后列号按 UTF-16 码元换算
const iconvTest = require('iconv-lite');
layout['docs/gbk.txt'] = iconvTest.encode('这里有一处 token 藏在中文里\n', 'gbk');
const utf16Text = 'unicode token here\n';
const utf16Buf = Buffer.alloc(2 + utf16Text.length * 2);
utf16Buf.write('\xff\xfe', 0, 'binary');
utf16Buf.write(utf16Text, 2, 'utf16le');
layout['docs/utf16.txt'] = utf16Buf;
for (const [rel, content] of Object.entries(layout)) {
  const full = path.join(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
fs.mkdirSync(path.join(ws, 'node_modules/pkg'), { recursive: true });
fs.writeFileSync(path.join(ws, 'node_modules/pkg/index.js'), 'token\n');

// logcat 的轮转文件通常就在 10 MiB 上下（本机这几个是 10,485,9xx 字节）。
// 造一个刚好越过 10 MiB 的文件，锁住「上限贴着边界、整批文件被静默跳过」这个回归。
const filler = 'filler line without match\n';
const TARGET_BYTES = 10 * 1024 * 1024 + 180;
const repeats = Math.floor((TARGET_BYTES - 6) / Buffer.byteLength(filler));
fs.mkdirSync(path.join(ws, 'logs'), { recursive: true });
fs.writeFileSync(path.join(ws, 'logs/big.log'), filler.repeat(repeats) + 'token\n');

// ---------------------------------------------------------------- vscode stub
class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
  isAfterOrEqual(other) {
    return this.line > other.line || (this.line === other.line && this.character >= other.character);
  }
  isEqual(other) {
    return this.line === other.line && this.character === other.character;
  }
}
class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
  get isEmpty() {
    return this.start.isEqual(this.end);
  }
}
class Selection extends Range {}

/** 真实 file:// URI 的等价物：保留 Windows 盘符与反斜杠的映射 */
function uriFor(rel) {
  const clean = rel.replace(/^\/+/, '');
  const fsPath = clean ? path.join(ws, clean) : ws;
  const posix = '/' + clean.split(path.sep).join('/');
  return {
    scheme: 'file',
    path: posix,
    fsPath,
    toString: () => 'file://' + posix,
  };
}

function makeDocument(text, file) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  const uri = uriFor(file);
  return {
    uri,
    fileName: uri.fsPath,
    languageId: 'typescript',
    getText: () => text,
    offsetAt: (pos) => starts[pos.line] + pos.character,
    positionAt: (offset) => {
      let line = 0;
      while (line + 1 < starts.length && starts[line + 1] <= offset) line += 1;
      return new Position(line, offset - starts[line]);
    },
    lineAt: (line) => {
      const from = starts[line];
      const to = line + 1 < starts.length ? starts[line + 1] : text.length;
      const body = text.slice(from, to).replace(/\r?\n$/, '');
      return { text: body, range: new Range(new Position(line, 0), new Position(line, body.length)) };
    },
  };
}

const activeDoc = makeDocument(layout['src/a.ts'], 'src/a.ts');
const editor = {
  document: activeDoc,
  selection: new Selection(new Position(0, 0), new Position(0, 0)),
  setDecorations: () => undefined,
  revealRange: () => undefined,
  edit: async () => true,
};

const settings = new Map([
  ['defaultMode', 'normal'],
  ['wrapAround', true],
  ['searchInSelection', false],
  ['highlightAllMatches', true],
  ['maxMatches', 20000],
  ['maxMatchesPerFile', 2000],
  ['maxFileSizeKB', 204800],
  ['streamThresholdKB', 2048],
  ['backtrackLimit', 1000000],
  ['includeGlob', '**/*'],
  ['excludeGlob', '**/{node_modules,.git,.svn,dist,out,build,target,.next,coverage}/**'],
  ['takeOverFindShortcut', false],
]);

const commands = new Map();
const posted = [];
const logLines = [];
let receive;
let provider;

/** 消息到达即唤醒的等待者：等的是事件，不是定时轮询。 */
const postWaiters = new Set();

function publish(message) {
  posted.push(message);
  for (const waiter of [...postWaiters]) {
    waiter(message);
  }
}

/** 等一条满足条件的消息；已到过的直接返回。 */
function waitForPost(predicate, timeout = 15000) {
  const seen = posted.find(predicate);
  if (seen) {
    return Promise.resolve(seen);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      postWaiters.delete(waiter);
      reject(new Error(`等待消息超时（${timeout}ms）`));
    }, timeout);
    const waiter = (message) => {
      if (!predicate(message)) {
        return;
      }
      clearTimeout(timer);
      postWaiters.delete(waiter);
      resolve(message);
    };
    postWaiters.add(waiter);
  });
}

const vscodeStub = {
  Position,
  Range,
  Selection,
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  OverviewRulerLane: { Center: 2 },
  ProgressLocation: { Notification: 15, Window: 10 },
  RelativePattern: class {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  WorkspaceEdit: class {
    replace() {}
  },
  Uri: {
    joinPath: (base, ...parts) => {
      // 以 fsPath 为准：扩展目录在临时工作区之外，不能按工作区相对路径换算
      const fsPath = path.join(base.fsPath, ...parts);
      const posix = '/' + path.relative(ws, fsPath).split(path.sep).join('/');
      return { scheme: 'file', path: posix, fsPath, toString: () => 'file://' + posix };
    },
    parse: (value) => uriFor(value.replace(/^file:\/\//, '')),
    file: (value) => uriFor(path.relative(ws, value)),
  },
  env: { clipboard: { writeText: async () => undefined } },
  window: {
    activeTextEditor: editor,
    visibleTextEditors: [editor],
    createTextEditorDecorationType: () => ({ dispose: () => undefined }),
    createOutputChannel: () => ({
      appendLine: (line) => logLines.push(line),
      show: () => undefined,
      dispose: () => undefined,
    }),
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showTextDocument: async () => editor,
    registerWebviewViewProvider: (_id, instance) => {
      provider = instance;
      return { dispose: () => undefined };
    },
    onDidChangeVisibleTextEditors: () => ({ dispose: () => undefined }),
    withProgress: async (_options, task) =>
      task({ report: () => undefined }, { isCancellationRequested: false }),
  },
  // 0.1.35 起在文件中搜索自带取消源（状态行「停止」按钮），不再依赖 withProgress
  CancellationTokenSource: class {
    constructor() {
      this.token = { isCancellationRequested: false };
    }
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {
      this.token.isCancellationRequested = true;
    }
  },
  commands: {
    registerCommand: (id, handler) => {
      commands.set(id, handler);
      return { dispose: () => undefined };
    },
    executeCommand: async () => undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: uriFor(''), name: 'ws', index: 0 }],
    getConfiguration: () => ({
      get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
    }),
    findFiles: async () => {
      // 0.1.35 起生产代码优先走 findFiles；这里刻意抛错，强制走自遍历兜底，
      // 让真实目录用例继续覆盖 readDirectory 树遍历路径。
      throw new Error('测试桩不提供 findFiles');
    },
    // 0.1.37 起文件清单走自建缓存，首次搜索时挂监视器做增量维护
    createFileSystemWatcher: () => ({
      onDidCreate: () => ({ dispose: () => undefined }),
      onDidDelete: () => ({ dispose: () => undefined }),
      dispose: () => undefined,
    }),
    onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined }),
    openTextDocument: async () => activeDoc,
    applyEdit: async () => true,
    asRelativePath: (uri) => path.relative(ws, uri.fsPath).split(path.sep).join('/'),
    fs: {
      readDirectory: async (uri) =>
        fs.readdirSync(uri.fsPath, { withFileTypes: true }).map((entry) => [
          entry.name,
          entry.isDirectory() ? 2 : 1,
        ]),
      stat: async (uri) => ({ size: fs.statSync(uri.fsPath).size }),
      readFile: async (uri) => new Uint8Array(fs.readFileSync(uri.fsPath)),
    },
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

const extension = require('../dist/extension.js');
const flush = () => new Promise((resolve) => setTimeout(resolve, 300));

/**
 * 等这一场搜索收尾，而不是拍脑袋 sleep 或定时轮询。
 * 注意等的是收尾消息（0.1.73 起结果是流式插入的）：第一帧只是「搜索中」的
 * 空卡片，最终统计（处数 / 文件数 / 用时 / 总大小）落在 recordDone 上。
 */
function waitForRecord(timeout = 15000) {
  return waitForPost((message) => message.type === 'recordDone', timeout);
}

const state = (over = {}) => ({
  query: 'token',
  replace: '',
  mode: 'normal',
  caseSensitive: true,
  wholeWord: false,
  dotAll: false,
  wrapAround: true,
  inSelection: false,
  direction: 'down',
  advanced: false,
  filters: '**/*',
  ...over,
});

let ready = false;
async function boot() {
  if (ready) return;
  const context = { extensionUri: { fsPath: root, path: root }, subscriptions: [] };
  await extension.activate(context);
  provider.resolveWebviewView({
    visible: true,
    show: () => undefined,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://test',
      asWebviewUri: (uri) => uri,
      postMessage: async (message) => publish(message),
      onDidReceiveMessage: (handler) => {
        receive = handler;
        return { dispose: () => undefined };
      },
    },
    onDidChangeVisibility: () => ({ dispose: () => undefined }),
  });
  receive({ type: 'ready' });
  ready = true;
}

test('真实目录：十个文本文件全部进入结果（含 10 MB 级日志）', async () => {
  await boot();
  posted.length = 0;
  logLines.length = 0;
  receive({ type: 'action', action: 'findInFiles', state: state() });

  const record = await waitForRecord();
  assert.ok(record, '应有结果记录');
  const files = record.record.groups.map((group) => group.detail).sort();
  assert.deepEqual(files, [
    'README.md',
    'crlf.txt',
    'docs/gbk.txt',
    'docs/guide.md',
    'docs/utf16.txt',
    'logs/big.log',
    'scripts/build.js',
    'src/a.ts',
    'src/b.ts',
    'src/nested/c.ts',
    'src/nested/deep/d.ts',
  ]);
  assert.equal(record.record.total, 14, '每处 token 都算一条');
  assert.equal(record.record.fileCount, 11);
  const gbk = record.record.groups.find((group) => group.detail === 'docs/gbk.txt');
  assert.ok(gbk, 'GBK 文件应被转码后搜到');
  assert.equal(gbk.items[0].line, 1);
  assert.equal(gbk.items[0].column, 7, 'GBK 转码后列号按 UTF-16 码元计算');
  const u16 = record.record.groups.find((group) => group.detail === 'docs/utf16.txt');
  assert.ok(u16, 'UTF-16LE 文件应走 BOM 分支被搜到');
  assert.equal(u16.items[0].column, 9, 'UTF-16LE 转码后列号按 UTF-16 码元计算');
  assert.ok(
    typeof record.record.totalBytes === 'number' && record.record.totalBytes >= 10 * 1024 * 1024,
    '总大小应包含 10 MB 的日志（无扩展名二进制文件被跳过不计入命中）',
  );
  assert.ok(
    // 10 MB > chunkAboveMB 默认 2 MB，这里会走并行分块；关闭分块时走串行流式。
    // 两者都算「没有整块读入」，通道由策略决定，正确性断言在下面。
    logLines.some(
      (line) => line.includes('stream logs/big.log') || line.includes('chunked logs/big.log'),
    ),
    '10 MB 的日志应走流式/分块通道而不是整块读入',
  );
  const status = posted.filter((message) => message.type === 'status').pop();
  assert.match(status?.text ?? '', /跳过 1 个文件/, '无扩展名二进制文件被 NUL 探测识别后跳过');
  assert.equal(
    record.record.groups.find((group) => group.detail === 'logs/big.log').items[0].line,
    repeats + 1,
    '流式读取的行号要与整块读入一致',
  );
});

test('全部文件都走流式时，结果与整块读入完全一致', async () => {
  settings.set('streamThresholdKB', 0);
  // 分块门槛抬到关闭：这条用例要的是「串行流式」这条通道本身，
  // 否则 10 MB 日志会被 2 MB 的默认门槛截去走并行分块。
  settings.set('chunkAboveMB', 0);
  // 0.1.114 起本地盘默认走 worker 池（worker 内部自流式，宿主不打 stream 行）：
  // 这条用例要看的正是宿主侧流式，关掉并行强制走 legacy。
  settings.set('parallelWorkers', -1);
  try {
    posted.length = 0;
    receive({ type: 'action', action: 'findInFiles', state: state() });

    const record = await waitForRecord();
    assert.ok(record, '应有结果记录');
    assert.equal(record.record.total, 14, '命中数不变');
    assert.equal(record.record.fileCount, 11, '命中文件数不变');
    assert.ok(
      logLines.filter((line) => line.includes('[search] stream ')).length >= 11,
      '连小文件也走流式通道',
    );
    const big = record.record.groups.find((group) => group.detail === 'logs/big.log');
    assert.equal(big.items[0].line, repeats + 1);
    assert.equal(big.items[0].column, 1);
  } finally {
    settings.delete('streamThresholdKB');
    settings.delete('chunkAboveMB');
    settings.delete('parallelWorkers');
  }
});

test('真实目录：过滤器只保留 src 下的文件', async () => {
  posted.length = 0;
  receive({ type: 'action', action: 'findInFiles', state: state({ filters: 'src/**/*.ts' }) });

  const record = await waitForRecord();
  assert.ok(record, '应有结果记录');
  assert.deepEqual(
    record.record.groups.map((group) => group.detail).sort(),
    ['src/a.ts', 'src/b.ts', 'src/nested/c.ts', 'src/nested/deep/d.ts'],
  );
});

test('超过体积上限的文件会在卡片上被点名，而不是静默消失', async () => {
  settings.set('maxFileSizeKB', 1);
  // 逐文件 skip 日志默认关闭（0.1.54 起走 verboseLog 开关），此处显式打开
  // 只为验证日志内容本身；卡片点名与状态行计数才是用户可见的主行为。
  settings.set('verboseLog', true);
  try {
    posted.length = 0;
    receive({ type: 'action', action: 'findInFiles', state: state() });

    const record = await waitForRecord();
    assert.ok(record, '应有结果记录');
    assert.ok(
      !record.record.groups.some((group) => group.detail === 'logs/big.log'),
      '超过上限的文件不进结果',
    );
    const status = posted.filter((message) => message.type === 'status').pop();
    assert.match(status?.text ?? '', /跳过 \d+ 个文件/, '要写清跳过了几个');
    assert.ok(
      logLines.some((line) => line.includes('skip logs/big.log')),
      '日志里要点名具体是哪个文件被跳过',
    );
    assert.ok(
      logLines.some((line) => line.includes('limit=')),
      '日志里要写明体积门槛',
    );
  } finally {
    settings.delete('maxFileSizeKB');
    settings.delete('verboseLog');
  }
});


/**
 * 造一份 8MB 的夹具：把命中精确放在每个 1MB 块边界的两侧——对齐之后，
 * 其中一条会成为某块的「最后一行」，另一条是下一块的「第一行」。末尾再放
 * 一行中文（列号按 UTF-16 码元算，验证块内列号没被块起点带偏）。
 * 返回期望的 1 基行号数组。
 */
function writeChunkFixture(name = 'logs/chunked.log') {
  const lines = [];
  const expectedLines = [];
  let bytes = 0;
  const bump = (text, hasNeedle) => {
    lines.push(text);
    bytes += Buffer.byteLength(text, 'utf8');
    if (hasNeedle) expectedLines.push(lines.length);
  };
  const fillerLine = 'chunk filler line without any hit here\n';
  // 1MB = MIN_CHUNK_BYTES：8MB 夹具在 2~4 线程下切成 8 块，边界正好在这几个点上
  const BOUNDARY = 1024 * 1024;
  let nextBoundary = BOUNDARY;
  while (bytes < 8 * 1024 * 1024) {
    if (bytes + Buffer.byteLength(fillerLine, 'utf8') >= nextBoundary) {
      bump('needle right before the chunk edge\n', true);
      bump('needle right after the chunk edge\n', true);
      nextBoundary += BOUNDARY;
      continue;
    }
    bump(fillerLine, false);
  }
  bump('中文中文 needle 中文\n', true);
  fs.writeFileSync(path.join(ws, name), lines.join(''), 'utf8');
  return expectedLines;
}

/** 分块结果的公共断言：命中集合与串行完全一致，且每条列号与预览自洽。 */
function assertChunkedItems(record, expectedLines, detail = 'logs/chunked.log') {
  assert.ok(record, '应有结果记录');
  const group = record.record.groups.find((item) => item.detail === detail);
  assert.ok(group, '大文件应产生一个结果分组');
  assert.deepEqual(
    group.items.map((item) => item.line),
    expectedLines,
    '行号必须与串行搜索完全一致（顺序、数量都不能错）',
  );
  for (const item of group.items) {
    assert.equal(
      item.preview.indexOf('needle'),
      item.column - 1,
      '第 ' + item.line + ' 行的列号与预览不一致',
    );
  }
}

test('少量巨型文件也进池子：10 个 20MB 不该比 1.5GB 的源码树还慢', async () => {
  /**
   * 回归用例：池子原来只按「文件数 >= 100」启用，于是 10 个 20MB 的工作区
   * 永远走宿主单线程，200MB 反而比 1.5GB 的内核树还慢。现在补一条总量
   * 判据（>= 16MB 也进池子），这里用「1 个 20MB + 4 个小文件」验证：
   * 文件数远不到 100，但必须打出 worker pool 日志、并且那份 20MB 要真的分块。
   */
  const dir = path.join(ws, 'bigfew');
  fs.mkdirSync(dir, { recursive: true });
  const filler = 'big few filler line without any hit here\n';
  const chunk = filler.repeat(Math.floor((20 * 1024 * 1024) / filler.length));
  fs.writeFileSync(path.join(dir, 'huge.log'), `${chunk}needle at the end\n`);
  for (let i = 0; i < 4; i += 1) {
    fs.writeFileSync(path.join(dir, `s${i}.txt`), `small needle ${i}\n`);
  }
  try {
    posted.length = 0;
    receive({ type: 'action', action: 'findInFiles', state: state({ query: 'needle' }) });
    const record = await waitForRecord();
    const files = record.record.groups.reduce((sum, group) => sum + group.items.length, 0);
    assert.ok(files >= 5, '五份夹具都要命中');
    assert.ok(
      logLines.some((line) => line.includes('worker pool:')),
      '文件数不到 100 但总量过 16MB，必须走线程池：' +
        JSON.stringify(logLines.filter((line) => /pool|chunk/.test(line))),
    );
    assert.ok(
      logLines.some((line) => line.includes('chunked bigfew/huge.log') && line.includes('chunks=')),
      '20MB 的单文件要分块，不能整份塞给一个 worker',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('超大文件按块并行搜索（legacy 路径）：边界命中不丢不重', async () => {
  const expectedLines = writeChunkFixture();
  settings.set('chunkAboveMB', 1);
  try {
    posted.length = 0;
    receive({ type: 'action', action: 'findInFiles', state: state({ query: 'needle' }) });

    const record = await waitForRecord();
    assertChunkedItems(record, expectedLines);
    assert.equal(record.record.groups.length, 1, '只有这份大文件命中');
    assert.ok(
      logLines.some(
        (line) => line.includes('chunked logs/chunked.log') && line.includes('chunks='),
      ),
      '日志要写明这份文件被切成了几块',
    );
  } finally {
    settings.delete('chunkAboveMB');
  }
});

test('超大文件按块并行搜索（worker 池路径）：分块走同一条队列', async () => {
  // 补 100 个无命中文件，让文件数越过池子门槛（>=100），强制走池子路径：
  // 分块条目和普通文件在同一条 work-stealing 队列里被不同 worker 领走。
  // 目录名取 z 开头：文件按路径排序，要保证这份 8MB 夹具在队列还满着的时候
  // 就被 worker stat 到，拥挤闸门才有机会触发（用 bulk 的话它排在最后，
  // 轮到它时队列早空了，测到的是稀疏期分支）。
  // 数量要够 400：work-stealing 一次派 24 个，4 个 worker 首批就吃掉 96 个，
  // 100 个的话队列在 8MB 文件被 stat 之前就见底了，同样测不到拥挤分支。
  fs.mkdirSync(path.join(ws, 'zbulk'), { recursive: true });
  for (let i = 0; i < 400; i += 1) {
    fs.writeFileSync(path.join(ws, 'zbulk', `f${String(i).padStart(3, '0')}.ts`), 'bulk filler\n');
  }
  // 用新文件名：上面那条用例已经把这个路径搜过一遍并写进了结果缓存，
  // 复用同名文件会让它走「缓存校验失败 → 单文件补扫场」，而那一场里队列
  // 本来就空，拥挤闸门永远不会触发。换个没见过的路径才会进主场队列。
  const detail = 'logs/chunked2.log';
  // 上面那条用例的同名夹具要删掉，否则这一轮会多出一个命中分组
  fs.rmSync(path.join(ws, 'logs/chunked.log'), { force: true });
  settings.set('chunkAboveMB', 1);
  settings.set('parallelWorkers', 4);
  const expectedLines = writeChunkFixture(detail);
  try {
    logLines.length = 0;
    posted.length = 0;
    receive({ type: 'action', action: 'findInFiles', state: state({ query: 'needle' }) });

    const record = await waitForRecord();
    assertChunkedItems(record, expectedLines, detail);
    assert.equal(record.record.groups.length, 1, '一百多个无命中文件不应产生分组');
    assert.ok(
      logLines.some((line) => line.includes('worker pool: 4 threads')),
      '这条用例必须真的走池子路径',
    );
    assert.ok(
      logLines.some((line) => line.includes('chunked ' + detail) && line.includes('chunks=')),
      '池子路径同样要切块',
    );
    // 拥挤闸门按「剩余字节量」判：这里 400 个 bulk 文件各 12 字节，加起来才
    // 几 KB，8MB 夹具在字节上是绝对大头，所以应该真分块。闸门自身（包括
    // kernel 树那种几万文件的密集场景）由 chunkplan 的单测覆盖。
    const chunkLines = logLines.filter((line) => line.includes('chunked ' + detail));
    const chunked = chunkLines.find((line) => line.includes('chunks='));
    assert.ok(chunked, '池子路径应打出分块日志：' + JSON.stringify(chunkLines));
    const chunks = Number(/chunks=(\d+)/.exec(chunked)[1]);
    assert.ok(chunks >= 2, '队列里没有真正的字节压力时应真分块，实际 chunks=' + chunks);
  } finally {
    settings.delete('chunkAboveMB');
    settings.delete('parallelWorkers');
  }
});

test.after(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});
