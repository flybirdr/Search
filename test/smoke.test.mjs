import assert from 'node:assert/strict';
import fs from 'node:fs';
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

function makeDocument(text, file = 'sample.ts') {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  const uri = {
    scheme: 'file',
    path: '/' + file,
    fsPath: path.join(root, file),
    toString: () => 'file:///' + file,
  };
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

const settings = new Map([
  // 0.1.114 起本地盘默认走 worker 池：本套件没有真实文件系统，真 worker 读不到
  // mock 文件——关掉并行强制走宿主内扫描（池子链路由 pool/realfs 套件覆盖）
  ['parallelWorkers', -1],
  // 遍历同样外包给真 worker 线程：mock 文件系统读不到，强制宿主内遍历
  ['walkThreads', -1],
  ['defaultMode', 'normal'],
  ['wrapAround', true],
  ['searchInSelection', false],
  ['highlightAllMatches', true],
  ['maxMatches', 20000],
  ['maxFileSizeKB', 51200],
  ['backtrackLimit', 1000000],
  ['includeGlob', '**/*'],
  ['excludeGlob', '**/node_modules/**'],
  ['takeOverFindShortcut', false],
]);

const text = 'const a = 1;\nconsole.log(a);\nconst b = a + 1;\n';
const editor = makeEditor(makeDocument(text));
const commands = new Map();
const posted = [];
/** 消息到达即唤醒的等待者：等的是事件，不是定时轮询。 */
const postWaiters = new Set();

/**
 * 宿主发消息的统一入口。与真实 webview 一致，消息在发出那一刻就冻结，
 * 后续宿主再改对象也影响不到它；同时叫醒正在等这条消息的用例。
 */
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
let receive;
let provider;
/** 模拟 VS Code 的显示语言；activate 时会读一次。 */
let language = 'zh-cn';

/**
 * 模拟工作区：null 时等同于「没有打开文件夹」（绝大多数用例的默认场景）。
 * 非空时 workspaceFolders / workspace.fs 都按这张表工作，用来覆盖真正的
 * 「在文件中搜索」全链路（枚举 → 读文件 → wasm 匹配 → 结果流式插入面板）。
 */
let virtualWorkspace = null;

function makeUri(pathname) {
  return {
    scheme: 'file',
    path: pathname,
    fsPath: pathname,
    toString: () => 'file://' + pathname,
  };
}

/** files: { 'a.ts': '内容' }，全部平铺在 /ws 下。 */
function openWorkspace(files) {
  const rootPath = '/ws';
  const contents = new Map();
  for (const [name, text] of Object.entries(files)) {
    contents.set(`${rootPath}/${name}`, text);
  }
  virtualWorkspace = { rootPath, contents, folder: { uri: makeUri(rootPath), name: 'ws', index: 0 } };
}

const vscodeStub = {
  Position,
  Range,
  Selection,
  RelativePattern: class {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  CancellationTokenSource: class {
    constructor() {
      this.token = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined }),
      };
    }
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {
      // 与真实实现一致：dispose 不撤销已发出的取消
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  OverviewRulerLane: { Center: 2 },
  ProgressLocation: { Notification: 15, Window: 10 },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  WorkspaceEdit: class {
    replace() {}
  },
  Uri: {
    joinPath: (base, ...parts) => {
      // 必须带上 scheme 与 toString：文件枚举用 uri.toString() 去重、用 uri.path
      // 读内容，返回裸对象会让整条「在文件中搜索」链路拿不到文件
      const joined = [base.path ?? '', ...parts].join('/').replace(/\/{2,}/g, '/');
      const scheme = base.scheme ?? 'file';
      return {
        scheme,
        path: joined,
        fsPath: joined,
        toString: () => `${scheme}://${joined}`,
      };
    },
    parse: (value) => ({ toString: () => value, path: value, fsPath: value }),
    file: (value) => ({ fsPath: value, path: value, toString: () => 'file://' + value }),
  },
  env: {
    get language() {
      return language;
    },
    clipboard: { writeText: async () => undefined },
  },
  window: {
    activeTextEditor: editor,
    visibleTextEditors: [editor],
    createTextEditorDecorationType: () => ({ dispose: () => undefined }),
    createOutputChannel: () => ({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined }),
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showTextDocument: async () => editor,
    registerWebviewViewProvider: (_id, instance) => {
      // 只捕获内容搜索面板（扩展还注册了文件名搜索页，见 files.test.mjs）
      if (_id === 'flySearch.panel') {
        provider = instance;
      }
      return { dispose: () => undefined };
    },
    onDidChangeVisibleTextEditors: () => ({ dispose: () => undefined }),
    withProgress: async (_options, task) => task({ report: () => undefined }, { isCancellationRequested: false }),
  },
  commands: {
    registerCommand: (id, handler) => {
      commands.set(id, handler);
      return { dispose: () => undefined };
    },
    executeCommand: async () => undefined,
  },
  workspace: {
    get workspaceFolders() {
      return virtualWorkspace ? [virtualWorkspace.folder] : undefined;
    },
    getConfiguration: () => ({
      get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
    }),
    findFiles: async () => [],
    createFileSystemWatcher: () => ({
      onDidCreate: () => ({ dispose: () => undefined }),
      onDidDelete: () => ({ dispose: () => undefined }),
      dispose: () => undefined,
    }),
    onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined }),
    openTextDocument: async () => editor.document,
    applyEdit: async () => true,
    asRelativePath: (uri) => uri.path.replace(/^\//, ''),
    fs: {
      stat: async (uri) => {
        const text = virtualWorkspace?.contents.get(uri.path);
        return text === undefined
          ? { size: 0, type: 1 }
          : { size: Buffer.byteLength(text, 'utf8'), type: 1 };
      },
      readFile: async (uri) => {
        const text = virtualWorkspace?.contents.get(uri.path);
        return text === undefined
          ? new Uint8Array()
          : new Uint8Array(Buffer.from(text, 'utf8'));
      },
      readDirectory: async (uri) => {
        const ws = virtualWorkspace;
        if (!ws || uri.path !== ws.rootPath) {
          return [];
        }
        return [...ws.contents.keys()].map((full) => [full.slice(ws.rootPath.length + 1), 1]);
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 120));

test('extension activates, registers commands and renders the panel', async () => {
  const context = {
    extensionUri: { fsPath: root, path: root },
    subscriptions: [],
  };
  await extension.activate(context);

  assert.ok(commands.has('flySearch.openPanel'));
  assert.ok(commands.has('flySearch.findNext'));
  assert.ok(context.subscriptions.length >= 3);

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

  provider.resolveWebviewView(view);

  assert.match(view.webview.html, /查找目标/);
  assert.match(view.webview.html, /Content-Security-Policy/);
  assert.match(view.webview.html, /nonce-/);

  receive({ type: 'ready' });
  assert.ok(posted.some((message) => message.type === 'state'));
});

test('search action returns grouped results and a status line', async () => {
  posted.length = 0;

  receive({
    type: 'action',
    action: 'search',
    state: {
      query: 'a',
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
    },
  });

  await flush();
  const results = posted.find((message) => message.type === 'record');
  assert.ok(results, 'expected a record message');
  assert.equal(results.record.total, 3);
  assert.equal(results.record.groups.length, 1);
  assert.equal(results.record.scope, 'document');
  assert.equal(results.record.groups[0].items[0].line, 1);
  assert.equal(results.record.groups[0].items[0].preview, text.split('\n')[0]);

  const status = posted.filter((message) => message.type === 'status').pop();
  assert.equal(status.text, '', '命中摘要已并入记录折叠条，成功时不再显示状态行');
});

test('count action reports the number without rendering results', async () => {
  posted.length = 0;

  receive({
    type: 'action',
    action: 'count',
    state: {
      query: 'const',
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
    },
  });

  await flush();
  const status = posted.filter((message) => message.type === 'status').pop();
  assert.match(status.text, /计数：2 处/);
  assert.equal(posted.some((message) => message.type === 'record'), false);
});

test('invalid regex surfaces a readable error instead of throwing', async () => {
  posted.length = 0;

  receive({
    type: 'action',
    action: 'search',
    state: {
      query: '(abc',
      replace: '',
      mode: 'regex',
      caseSensitive: false,
      wholeWord: false,
      dotAll: false,
      wrapAround: true,
      inSelection: false,
      direction: 'down',
      advanced: false,
      filters: '**/*',
    },
  });

  await flush();
  const status = posted.filter((message) => message.type === 'status').pop();
  assert.equal(status.tone, 'error');
  assert.match(status.text, /编译失败/);
});

function makeView() {
  return {
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
}

test('VS Code 语言为英文时，面板与状态行一起切到英文', async () => {
  language = 'en';
  delete require.cache[require.resolve('../dist/extension.js')];
  const fresh = require('../dist/extension.js');

  posted.length = 0;
  await fresh.activate({ extensionUri: { fsPath: root, path: root }, subscriptions: [] });

  const view = makeView();
  provider.resolveWebviewView(view);

  assert.match(view.webview.html, /<html lang="en">/);
  assert.match(view.webview.html, /Text to find/);
  assert.match(view.webview.html, /Search mode/);
  assert.match(view.webview.html, /"搜索":"Search"/, '应把英文文案表注入 webview');

  receive({ type: 'ready' });
  assert.ok(posted.some((message) => message.type === 'state'));

  posted.length = 0;
  receive({
    type: 'action',
    action: 'search',
    state: {
      query: 'a',
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
    },
  });

  await flush();
  const record = posted.find((message) => message.type === 'record');
  assert.ok(record, 'expected a record message');
  assert.equal(record.record.scopeLabel, 'Current document');
  assert.equal(record.record.optionsLabel, 'Normal · Match case');

  const status = posted.filter((message) => message.type === 'status').pop();
  assert.equal(status.text, '', '命中摘要已并入记录折叠条，成功时不再显示状态行');
});

/** 工作区级存储的最小实现：Map 背后一套 get/update。 */
function makeStore() {
  const mem = new Map();
  return {
    mem,
    get: (key, fallback) => (mem.has(key) ? mem.get(key) : fallback),
    update: async (key, value) => {
      mem.set(key, value);
    },
  };
}

const STATE = {
  query: 'a',
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
};

async function bootWith(store, layout) {
  delete require.cache[require.resolve('../dist/extension.js')];
  const fresh = require('../dist/extension.js');
  posted.length = 0;
  await fresh.activate({
    extensionUri: { fsPath: root, path: root },
    subscriptions: [],
    workspaceState: store,
    globalState: layout,
  });
  const view = makeView();
  provider.resolveWebviewView(view);
  receive({ type: 'ready' });
  await flush();
  return view;
}

test('搜索结果跟着工作区存下来：重启后仍在，清空后不再回来', async () => {
  language = 'zh-cn';
  const store = makeStore();

  await bootWith(store);
  receive({ type: 'action', action: 'search', state: STATE });
  await flush();

  const live = posted.filter((message) => message.type === 'record').pop();
  assert.equal(live.record.total, 3);
  // 行式存储：值是行文本，每行一条记录 JSON（最新在前）
  const saved = store.mem.get('flySearch.history.v1');
  assert.ok(typeof saved === 'string' && saved.length > 0, '搜索结果应写入 workspaceState');
  const savedLines = saved.split('\n').filter((line) => line.trim());
  assert.equal(savedLines.length, 1);
  assert.equal(JSON.parse(savedLines[0]).q, 'a');

  // 模拟重启：新的模块实例，同一份工作区存储
  posted.length = 0;
  const view = await bootWith(store);

  // 记录直接嵌进首屏 HTML，不用等 ready 的往返
  const bootstrap = /<div id="flyBootstrap" hidden>([\s\S]*?)<\/div>/.exec(view.webview.html);
  assert.ok(bootstrap, '首屏应带上次的结果记录');
  const restored = JSON.parse(bootstrap[1]);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].query, 'a');
  assert.equal(restored[0].total, 3);
  assert.equal(restored[0].groups[0].items[0].line, 1);
  assert.equal(restored[0].groups[0].items[0].preview, text.split('\n')[0]);

  // 恢复出来的行仍能跳转
  posted.length = 0;
  receive({ type: 'reveal', recordId: restored[0].id, id: 1 });
  await flush();
  assert.ok(posted.some((message) => message.type === 'current'), '点击结果应回跳到编辑器');

  // 手动清空后，重启不再出现
  receive({ type: 'action', action: 'clearResults', state: STATE });
  await flush();
  const cleared = store.mem.get('flySearch.history.v1');
  assert.equal(
    typeof cleared === 'string' ? cleared.split('\n').filter((line) => line.trim()).length : 0,
    0,
  );

  posted.length = 0;
  const blank = await bootWith(store);
  const emptyBoot = /<div id="flyBootstrap" hidden>([\s\S]*?)<\/div>/.exec(blank.webview.html);
  assert.ok(emptyBoot);
  assert.deepEqual(JSON.parse(emptyBoot[1]), []);
});

test('搜索条件会记住；高度调节已删，布局消息被忽略（0.1.56）', async () => {
  language = 'zh-cn';
  const store = makeStore();
  const layout = makeStore();

  await bootWith(store, layout);
  receive({ type: 'state', state: { ...STATE, query: 'needle', mode: 'regex', advanced: true } });
  // 布局消息已无消费者：宿主不再持久化，前端也不再发送
  receive({ type: 'layout', resultsRatio: 0.6, advMax: 280 });
  await new Promise((resolve) => setTimeout(resolve, 400)); // 等防抖落盘

  assert.equal(store.mem.get('flySearch.panelState').query, 'needle');
  assert.equal(store.mem.get('flySearch.panelState').advanced, true);
  assert.equal(layout.mem.get('flySearch.layout'), undefined, '布局不再持久化');

  posted.length = 0;
  const view = await bootWith(store, layout);

  const seeded = /<div id="flyState" hidden>([\s\S]*?)<\/div>/.exec(view.webview.html);
  assert.ok(seeded, '首屏应带上次的搜索条件');
  const boot = JSON.parse(seeded[1]);
  assert.equal(boot.query, 'needle');
  assert.equal(boot.mode, 'regex');
  assert.equal(boot.advanced, true);
  assert.doesNotMatch(view.webview.html, /--fsearch-max|--fsearch-adv/, '高度上限变量已整体删除');
  assert.doesNotMatch(view.webview.html, /id="splitter"/, '分隔条已删');
});

test('存下来的条件不合法时回退默认值，不会把面板弄坏', async () => {
  language = 'zh-cn';
  const store = makeStore();
  store.mem.set('flySearch.panelState', {
    query: 42,
    mode: 'bogus',
    direction: 'sideways',
    advanced: 'yes',
    filters: null,
  });

  const view = await bootWith(store, makeStore());
  const seeded = /<div id="flyState" hidden>([\s\S]*?)<\/div>/.exec(view.webview.html);
  const boot = JSON.parse(seeded[1]);
  assert.equal(boot.query, '');
  assert.equal(boot.mode, 'normal');
  assert.equal(boot.direction, 'down');
  assert.equal(boot.advanced, false);
  assert.equal(boot.filters, '**/*');
  // 高度上限变量已随分隔条一起删除（0.1.56）：结果区纯 flex 吃满剩余空间
  assert.doesNotMatch(view.webview.html, /--fsearch-max|--fsearch-adv/, '不写任何高度上限变量');
  assert.doesNotMatch(view.webview.html, /id="splitter"/, '分隔条已删');
});

test('逐文件诊断日志必须被 verboseLog 门控（默认关），汇总日志不受影响（0.1.54）', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'search', 'controller.ts'), 'utf8');
  // 默认必须关：几万文件每个一行同步 appendLine 会吃掉扫描时间片（8 万文件
  // 的工作区仅日志就能吃掉数秒），详见 controller.ts 里 verbose 的注释。
  const config = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(config.contributes.configuration.properties['flySearch.verboseLog'].default, false);
  assert.match(
    src,
    /const verbose = config\.get<boolean>\('verboseLog', false\)/,
    'verbose 默认值必须为 false',
  );
  // 每一处逐文件日志（file / hit / skip）都必须包在 if (verbose) 块内，
  // 唯一例外是自检命令（用户手动触发、专门展开输出面板看清单，50 行封顶）。
  const perFileCalls = [...src.matchAll(/this\.log\(\s*\n?\s*`(hit |skip |  file )/g)];
  assert.ok(perFileCalls.length >= 5, `至少 5 处逐文件日志（实测 ${perFileCalls.length} 处）`);
  let ungated = 0;
  for (const call of perFileCalls) {
    const before = src.slice(Math.max(0, call.index - 200), call.index);
    if (!/if \(verbose\) \{[^}]*$/.test(before)) {
      ungated += 1;
      assert.equal(
        call[1],
        '  file ',
        '除自检的 file 清单外，其余逐文件日志都必须被 verbose 门控',
      );
    }
  }
  assert.ok(ungated <= 1, `不被门控的逐文件日志最多 1 处（自检），实测 ${ungated} 处`);
  // 汇总日志不受开关影响
  assert.match(src, /this\.log\(\s*\n?\s*`file list in/);
  assert.match(src, /this\.log\(\s*\n?\s*`scan in/);
});

test('在文件中搜索：先插入「搜索中」记录，再逐个文件追加结果（流式插入）', async () => {
  language = 'zh-cn';
  // 故意让枚举顺序与路径顺序相反（zzz 在前、a 在后）：结果列表必须按路径排，
  // 不能按「谁先扫完」排——这正是刚修掉的乱序问题
  openWorkspace({
    'zzz.ts': 'const needle = 1;\n',
    'b.ts': 'nothing to see here\n',
    'a.ts': 'needle again\nneedle twice\n',
  });
  try {
    await bootWith(makeStore());
    posted.length = 0;
    receive({ type: 'action', action: 'findInFiles', state: { ...STATE, query: 'needle' } });
    // 等收尾消息到达（事件驱动），不在固定时长里撞运气
    const done = await waitForPost((message) => message.type === 'recordDone');

    // 1) 搜索一开始先落一张「进行中」的空卡片
    const opened = posted.filter((message) => message.type === 'record');
    assert.equal(opened.length, 1, '一场搜索只开一张卡片，不额外插占位记录');
    assert.equal(opened[0].record.pending, true, '卡片以「进行中」插入');
    assert.deepEqual(opened[0].record.groups, [], '插入时还没有任何分组');
    assert.equal(opened[0].record.scope, 'files');
    assert.equal(opened[0].record.total, 0);

    // 2) 每扫完一个命中文件就往同一张卡片追加分组
    const chunks = posted.filter((message) => message.type === 'recordGroups');
    assert.ok(chunks.length >= 1, '应当有增量分组消息');
    assert.ok(
      chunks.every((message) => message.recordId === opened[0].record.id),
      '增量必须落在同一张卡片上',
    );
    assert.ok(
      chunks.every(
        (message) =>
          Array.isArray(message.inserts) && message.inserts.length === message.groups.length,
      ),
      '每条增量都要带「插到第几个」的下标，长度与分组一一对应',
    );
    const delivered = chunks.flatMap((message) => message.groups.map((g) => g.label)).sort();
    assert.deepEqual(delivered, ['a.ts', 'zzz.ts'], '只有命中的文件产生分组');

    // 3) 收尾：最终统计落在 recordDone 上，顺序按路径而不是完成顺序
    assert.equal(done.record.pending, false, '收尾后不再是进行中');
    assert.equal(done.record.total, 3, 'a.ts 2 处 + zzz.ts 1 处');
    assert.equal(done.record.fileCount, 2);
    assert.deepEqual(
      done.record.groups.map((group) => group.detail),
      ['a.ts', 'zzz.ts'],
      '结果列表按路径排，与文件扫完的先后无关',
    );

    // 顺序必须是 开卡 → 增量 → 收尾
    const firstChunk = posted.findIndex((message) => message.type === 'recordGroups');
    const openAt = posted.findIndex((message) => message.type === 'record');
    const doneAt = posted.findIndex((message) => message.type === 'recordDone');
    assert.ok(openAt < firstChunk && firstChunk < doneAt, '时序应为 开卡 → 增量 → 收尾');
  } finally {
    virtualWorkspace = null;
  }
});
