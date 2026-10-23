import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

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

function uriFor(rel) {
  const clean = rel.replace(/^\/+/, '');
  // scheme 不用 'file'：假工作区根就在真实仓库里，直读文件系统会扫到真文件。
  // 非 file scheme 走 vscode.workspace.fs（本文件的 mock），与被测逻辑无关。
  return {
    scheme: 'mock',
    path: '/' + clean,
    fsPath: path.join(root, clean),
    toString: () => 'file:///' + clean,
  };
}

function makeDocument(text, file = 'sample.ts') {
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

function makeEditor(document) {
  return {
    document,
    selection: new Selection(new Position(0, 0), new Position(0, 0)),
    setDecorations: () => undefined,
    revealRange: () => undefined,
    edit: async () => true,
  };
}

/** 工作区里的假文件：路径 -> 内容 */
const files = new Map([
  ['src/a.ts', 'const token = 1;\nconst other = token;\n'],
  ['src/b.ts', 'let token = 2;\n'],
  ['src/nested/c.ts', 'token\n'],
  ['src/d.ts', 'no match here\n'],
  ['dist/bundle.js', 'var token = 9;\n'],
  ['node_modules/pkg/index.js', 'token\n'],
  // 非文本扩展名：默认排除（.so.lsdump 是文本格式的 ABI dump，二进制探测拦不住）
  ['libs/libfoo.so.lsdump', 'token\n'],
  ['assets/logo.png', 'token\n'],
  ['assets/notes.txt', 'nothing here\n'],
]);

/** 假目录树：[名字, FileType] */
const DIRECTORY = 2;
const FILE = 1;
const tree = new Map([
  ['/', [['src', DIRECTORY], ['dist', DIRECTORY], ['node_modules', DIRECTORY], ['libs', DIRECTORY], ['assets', DIRECTORY]]],
  ['/src', [['a.ts', FILE], ['b.ts', FILE], ['d.ts', FILE], ['nested', DIRECTORY]]],
  ['/src/nested', [['c.ts', FILE]]],
  ['/dist', [['bundle.js', FILE]]],
  ['/node_modules', [['pkg', DIRECTORY]]],
  ['/node_modules/pkg', [['index.js', FILE]]],
  ['/libs', [['libfoo.so.lsdump', FILE]]],
  ['/assets', [['logo.png', FILE], ['notes.txt', FILE]]],
]);

const settings = new Map([
  ['defaultMode', 'normal'],
  ['wrapAround', true],
  ['searchInSelection', false],
  ['highlightAllMatches', true],
  ['maxMatches', 20000],
  ['maxMatchesPerFile', 2000],
  ['maxFileSizeKB', 51200],
  ['backtrackLimit', 1000000],
  ['includeGlob', '**/*'],
  // 注意不含 dist：内置默认排除会让路给显式点名（见「显式点名」用例），
  // 而 excludeGlob 是用户自己的权威排除，含 dist 会把点名旁路挡死
  ['excludeGlob', '**/{node_modules,.git}/**'],
  ['takeOverFindShortcut', false],
]);

const encoder = new TextEncoder();
const readDirCalls = [];
/** findFiles 桩行为：null = 抛错（强制自遍历兜底），数组 = 直接作为全量清单返回 */
let findFilesResult = null;
/** findFiles 桩的调用记录：断言恢复路径没有重新枚举 */
const findFilesCalls = [];
/** readFile 桩的额外延迟（ms）：让搜索变慢，供防抖/抢占用例控制时序 */
let readFileDelay = 0;
/** 捕获 createFileSystemWatcher 的增删事件处理器，供增量维护用例触发 */
const watcherHandlers = [];

const editor = makeEditor(makeDocument(files.get('src/a.ts'), 'src/a.ts'));
const commands = new Map();
const posted = [];
/** 输出面板的行（含 [cache] 诊断行），供缓存命中断言用 */
const outputLines = [];
let receive;
let webviewProvider;

/**
 * 消息到达即唤醒的等待者。测试等的是「收尾消息到了」这个事件，
 * 不用 while + sleep 轮询——轮询既慢又会在慢机器上飘。
 */
const postWaiters = new Set();

/** 宿主发消息的统一入口：冻结快照 + 叫醒等待者。 */
function publish(message) {
  const snapshot = structuredClone(message);
  posted.push(snapshot);
  for (const waiter of [...postWaiters]) {
    waiter(snapshot);
  }
}

/** 等一条满足条件的消息；已到过的直接返回。 */
function waitForPost(predicate, timeout = 8000) {
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
  FileType: { File: FILE, Directory: DIRECTORY, SymbolicLink: 64 },
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
      const joined = path.posix.join(base.path || '/', ...parts);
      return {
        scheme: 'file',
        path: joined,
        fsPath: path.join(base.fsPath, ...parts),
        toString: () => 'file://' + joined,
      };
    },
    parse: (value) => uriFor(value.replace(/^file:\/\//, '')),
    file: (value) => {
      const norm = path.resolve(value);
      const rel = path.relative(root, norm).split(path.sep).join('/');
      return uriFor('/' + rel);
    },
  },
  env: { clipboard: { writeText: async () => undefined } },
  window: {
    activeTextEditor: editor,
    visibleTextEditors: [editor],
    createTextEditorDecorationType: () => ({ dispose: () => undefined }),
    createOutputChannel: () => ({
      appendLine: (line) => outputLines.push(line),
      show: () => undefined,
      dispose: () => undefined,
    }),
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showTextDocument: async () => editor,
    registerWebviewViewProvider: (_id, instance) => {
      // 扩展现在注册两个视图（内容搜索 + 文件名搜索页）；这些用例只驱动
      // 内容搜索面板，按 id 捕获，避免被后注册的视图覆盖
      if (_id === 'flySearch.panel') {
        webviewProvider = instance;
      }
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
    workspaceFolders: [{ uri: uriFor(''), name: 'fake', index: 0 }],
    getConfiguration: () => ({
      get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
    }),
    findFiles: async (pattern, exclude, maxResults) => {
      findFilesCalls.push({ pattern, exclude });
      if (findFilesResult === null) {
        // 默认抛错：强制走自遍历兜底，让多数用例覆盖 readDirectory 树遍历逻辑
        throw new Error('测试桩不提供 findFiles');
      }
      return findFilesResult.map((p) => uriFor(`/${p}`));
    },
    // 0.1.37 起文件清单走自建缓存，首次搜索时挂监视器做增量维护
    createFileSystemWatcher: () => {
      const handlers = {};
      watcherHandlers.push(handlers);
      return {
        onDidCreate: (h) => {
          handlers.create = h;
          return { dispose: () => undefined };
        },
        onDidDelete: (h) => {
          handlers.delete = h;
          return { dispose: () => undefined };
        },
        dispose: () => undefined,
      };
    },
    onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined }),
    openTextDocument: async () => editor.document,
    applyEdit: async () => true,
    asRelativePath: (uri) => uri.path.replace(/^\//, ''),
    fs: {
      readDirectory: async (uri) => {
        readDirCalls.push(uri.path);
        return tree.get(uri.path) ?? [];
      },
      stat: async (uri) => ({
        size: encoder.encode(files.get(uri.path.replace(/^\//, '')) ?? '').length,
      }),
      readFile: async (uri) => {
        if (readFileDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, readFileDelay));
        }
        return encoder.encode(files.get(uri.path.replace(/^\//, '')) ?? '');
      },
    },
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const extension = require('../dist/extension.js');
const flush = () => new Promise((resolve) => setTimeout(resolve, 200));

/**
 * 等这一场搜索收尾。0.1.73 起结果是流式插入的：`record` 只是「搜索中」的
 * 空卡片，最终统计（处数 / 文件数 / 用时）落在 `recordDone` 上。
 */
function waitDone(timeout = 8000) {
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

test('结果记录按触发顺序（id 降序）排列，晚完成的先触发搜索不反超', async () => {
  // 触发顺序：慢搜索(10) → 快搜索(11)。完成顺序相反：11 先 upsert，10 后 upsert。
  // 宿主 records 数组必须保持 id 降序（最新触发在最上），历史恢复/首屏引导都靠它。
  const context = { extensionUri: { fsPath: root, path: root }, subscriptions: [] };
  await extension.activate(context);

  const view = {
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
  };
  webviewProvider.resolveWebviewView(view);

  const historyRecord = (id, query) => ({
    id,
    query,
    scope: 'files',
    scopeLabel: '在文件中',
    optionsLabel: '普通',
    groups: [],
    total: 0,
    fileCount: 0,
    elapsed: 1,
    truncated: false,
    time: Date.now(),
  });
  webviewProvider.upsertRecord(historyRecord(11, 'fast'), false);
  webviewProvider.upsertRecord(historyRecord(10, 'slow'), false);
  webviewProvider.upsertRecord(historyRecord(12, 'later'), false);

  posted.length = 0;
  receive({ type: 'ready' }); // ready 会重发 history，数组顺序可观测
  const history = posted.filter((message) => message.type === 'history').pop();
  assert.ok(history, 'ready 后应重发历史');
  assert.deepEqual(history.records.map((item) => item.id), [12, 11, 10]);
});

test('跨文件搜索收集所有命中文件，而不是只返回第一个', async () => {
  const context = { extensionUri: { fsPath: root, path: root }, subscriptions: [] };
  await extension.activate(context);

  const view = {
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
  };
  webviewProvider.resolveWebviewView(view);
  receive({ type: 'ready' });

  readDirCalls.length = 0;
  posted.length = 0;
  receive({ type: 'action', action: 'findInFiles', state: state() });
  await flush();

  const record = await waitDone();
  assert.ok(record, '应有结果记录');
  assert.equal(record.record.total, 4, '三个文件共 4 处命中');
  assert.equal(record.record.groups.length, 3, '三个文件应各占一个分组');
  assert.deepEqual(
    record.record.groups.map((group) => group.detail).sort(),
    ['src/a.ts', 'src/b.ts', 'src/nested/c.ts'],
  );
  assert.ok(typeof record.record.detail === 'undefined', '摘要行已移除，统计只在折叠条上');
});

test('默认跳过构建目录，不进入递归', () => {
  assert.deepEqual(readDirCalls.sort(), ['/', '/assets', '/libs', '/src', '/src/nested']);
});

test('显式点名被默认排除的目录时仍然搜索', async () => {
  posted.length = 0;
  receive({ type: 'action', action: 'findInFiles', state: state({ filters: 'dist/**/*.js' }) });
  await flush();

  const record = await waitDone();
  assert.ok(record, '应有结果记录');
  assert.equal(record.record.groups.length, 1, '只有 dist 下的那个文件');
  assert.equal(record.record.groups[0].detail, 'dist/bundle.js');
  assert.equal(record.record.total, 1);
});

test('非文本扩展名默认排除：.so.lsdump/.png 不进清单，文本文件不受影响', async () => {
  findFilesResult = [...files.keys()];
  try {
    posted.length = 0;
    receive({ type: 'action', action: 'findInFiles', state: state() });
    await flush();

    const record = await waitDone();
    const details = record.record.groups.map((group) => group.detail);
    assert.ok(
      !details.some(
        (d) => d.endsWith('.so.lsdump') || d.endsWith('.png') || d.endsWith('.jar'),
      ),
      `非文本扩展名不应出现在结果里: ${details.join(', ')}`,
    );
    assert.ok(details.includes('src/a.ts'), '文本文件正常搜索');
  } finally {
    findFilesResult = null;
  }
});

test('过滤器点名黑名单扩展时必搜（0.1.113，无缓存实时遍历）', async () => {
  findFilesResult = null; // 走自遍历：验证 walk 分支的 namedExts 让路
  try {
    posted.length = 0;
    receive({
      type: 'action',
      action: 'findInFiles',
      state: state({ filters: '**/*.so.lsdump' }),
    });
    await flush();

    const record = await waitDone();
    const details = record.record.groups.map((group) => group.detail);
    assert.ok(
      details.includes('libs/libfoo.so.lsdump'),
      `点名 .lsdump 必搜: ${details.join(', ')}`,
    );
  } finally {
    findFilesResult = null;
  }
});

test('「已打开全部」与「全部文件」结果一致，不再只搜可见的那个编辑器', async () => {
  posted.length = 0;
  receive({ type: 'action', action: 'findAllOpen', state: state() });
  await flush();

  const record = await waitDone();
  assert.ok(record, '应有结果记录');
  // 旧实现遍历 window.visibleTextEditors（这里只有一个编辑器），只会出一个分组
  assert.equal(record.record.scope, 'files', '应走工作区扫描，而不是「已打开文档」作用域');
  assert.equal(record.record.groups.length, 3, '三个文件应各占一个分组');
  assert.equal(record.record.total, 4, '与「全部文件」的命中数一致');
});

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * 所有结果记录（按开卡顺序）：已收尾的取 recordDone 上的最终版本，
 * 还在跑的（被抢占 / 未结束）用开卡那一帧。
 */
const records = () => {
  const done = new Map(
    posted.filter((message) => message.type === 'recordDone').map((m) => [m.record.id, m.record]),
  );
  return posted
    .filter((message) => message.type === 'record')
    .map((message) => done.get(message.record.id) || message.record);
};

test('双击窗口内的重复搜索只响应一次', async () => {
  // 第一场搜索读文件耗时 300ms；第二击在 50ms 时到达（窗口 400ms 内），
  // 此时应被忽略而不是并发开第二场。
  readFileDelay = 300;
  try {
    posted.length = 0;
    receive({ type: 'action', action: 'findInFiles', state: state() });
    await sleepMs(50);
    receive({ type: 'action', action: 'findInFiles', state: state() });
    await sleepMs(1200);

    const all = records();
    assert.equal(all.length, 1, `双击只应提交一条记录，实际 ${all.length}`);
    assert.equal(all[0].query, 'token');
  } finally {
    readFileDelay = 0;
  }
});

test('超出窗口的新搜索会停止当前任务并重新开一场', async () => {
  // 第一场读文件 600ms；第二击在 500ms 时到达（已超 400ms 窗口），
  // 应取消第一场（读文件收尾后收场）并开第二场，最终以第二场的结果落地。
  readFileDelay = 600;
  try {
    posted.length = 0;
    receive({ type: 'action', action: 'findInFiles', state: state({ query: 'token' }) });
    await sleepMs(500);
    receive({ type: 'action', action: 'findInFiles', state: state({ query: 'other' }) });
    await sleepMs(2500);

    const all = records();
    assert.ok(all.length >= 1, '至少应有新搜索的结果记录');
    const last = all[all.length - 1];
    assert.equal(last.query, 'other', '最后落地的应是新搜索');
    assert.equal(last.total, 1, 'other 只在 src/a.ts 出现一次');
    assert.ok(
      all.some((record) => record.query === 'token'),
      '被抢占的旧任务应留下部分结果记录（与「停止」按钮同语义）',
    );
  } finally {
    readFileDelay = 0;
  }
});

