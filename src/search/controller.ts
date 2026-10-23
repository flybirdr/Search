import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SearchCore } from '../engine/wasm';
import { t } from '../i18n';
import {
  SearchOptions,
  buildLineStartsBytes,
  compileQuery,
  decodeSlice,
  findMatches,
  findMatchesBytes,
  positionAt,
  utf16ToByteOffset,
} from '../engine/search';
import { Highlighter } from '../ui/decorations';
import {
  HistoryRecord,
  MAX_RECORDS,
  PanelState,
  PanelView,
  ResultGroup,
  ResultItem,
  SearchScope,
} from '../ui/panel';
import { createWalkStream, readFileBytes, type WalkStats, type WalkStreamOptions } from './files';
import { createDirPriorityStore, scoreOf, type DirPriorityStore } from './dirPriority';
import { countMatches } from './exactCount';
import { streamSearchFile } from './stream';
import { makeItem } from './preview';
import {
  PoolFileResult,
  PoolWorkItem,
  appendPoolWork,
  dropPoolChunks,
  poolAverageFileBytes,
  poolAverageAllBytes,
  poolPendingFileCount,
  lastPoolRunSummary,
  runWorkerSearch,
  type PoolRunSummary,
} from './workerPool';
import { currentDiskProbe, resolveChunking } from './diskType';
import {
  ChunkPart,
  ChunkPolicy,
  estimateChunkGain,
  isCrowdedForChunk,
  mergeChunkParts,
  overlapForQuery,
} from './chunkPlan';
import {
  DecodedRecord,
  EncodeInput,
  HISTORY_KEY,
  decodeHistoryLines,
  encodeHistory,
} from './history';

interface Hit {
  /** 文件本地路径（fsPath）：0.1.113 起清单与命中都不再持有 vscode.Uri */
  uri: string;
  range: vscode.Range;
}

/** 一次搜索产生的完整结果，面板里对应一张可折叠的卡片。 */
interface SearchRecord {
  id: number;
  query: string;
  scope: SearchScope;
  scopeLabel: string;
  optionsLabel: string;
  groups: ResultGroup[];
  hits: Hit[];
  current: number;
  elapsed: number;
  truncated: boolean;
  time: number;
  /** 实际扫描过的文件总字节数（流式 + 整块读都算），未知时不显示。 */
  totalBytes?: number;
  /** 这场搜索是否还在跑：进行中的卡片边扫边追加，结束时由宿主收尾。 */
  pending?: boolean;
  /** 发起搜索时的输入状态：「统计完整数量」要按同样的条件重新扫一遍 */
  input?: PanelState;
  /** 用户点过「统计完整数量」时的真实总数（未统计为 undefined） */
  exactTotal?: number;
}

type SearchDocumentMode = 'record' | 'refresh' | 'count';

/**
 * 一场文件名搜索的结果（0.1.124）：分组按**目录**聚合，条目 = 匹配的文件名。
 * 与 SearchRecord 的差别：没有 Range / 预览正文（不读文件内容），
 * 条目 id → 文件 fsPath 的映射由 `files` 承担；会话内有效，不持久化。
 */
interface FileNameRecord {
  id: number;
  query: string;
  scopeLabel: string;
  optionsLabel: string;
  groups: ResultGroup[];
  /** 条目 id → 匹配文件的 fsPath（id 即下标） */
  files: string[];
  current: number;
  elapsed: number;
  truncated: boolean;
  time: number;
  /** 这场搜索是否还在跑 */
  pending?: boolean;
  /** 遍历经过的文件总数（未过滤），状态行与日志用 */
  walked: number;
}

/** 文件名搜索的持久化结构（只存最新一场）：条目带完整路径，恢复后定位/打开都能用。 */
interface StoredFileGroup {
  l: string;
  d: string;
  /** 分组的绝对目录路径（「定位」按钮用） */
  p: string;
  /** [文件名, 前缀, 匹配长度, 相对目录, 完整路径] */
  it: [string, number, number, string, string][];
}

interface StoredFileRecord {
  v: number;
  id: number;
  q: string;
  sl: string;
  ol: string;
  e: number;
  tr: boolean;
  t: number;
  walked: number;
  g: StoredFileGroup[];
}

/** 流式通道不可用时（虚拟 / 远程文件系统）整块读入的内存上限 */
const MAX_WHOLE_READ = 64 * 1024 * 1024;
/**
 * 文件扫描的并发数。vscode.workspace.fs 的每次调用都是一次扩展宿主 IPC 往返，
 * 严格串行时磁盘等待和内核匹配完全不能重叠；6 路并发让 I/O 排队变流水线，
 * 是不改架构前提下收益最大的一步。内核匹配是同步调用，天然不会并行踩内存。
 */
const SCAN_CONCURRENCY = 6;

/**
 * 双击判定窗口：窗口内的重复触发视为误触/双击，只响应第一击；
 * 超出窗口的新触发则停止当前搜索任务、重新开一场。
 * 参考 Windows 默认双击间隔（500ms）略收紧。
 */
const SEARCH_DEBOUNCE_MS = 400;

/**
 * 流式结果推给面板的最小间隔。每个文件都 postMessage 会让几万文件的工作区
 * 产生几万次跨进程消息（webview 侧每次都要建 DOM），节流到一帧两次的量级，
 * 视觉上仍然是「边搜边出」，而消息数降到原来的百分之一。
 */
const STREAM_FLUSH_MS = 80;

export class SearchController implements vscode.Disposable {
  private readonly records = new Map<number, SearchRecord>();
  private activeRecordId = -1;
  private nextRecordId = 1;
  private markedByUri = new Map<string, vscode.Range[]>();
  private panel?: PanelView;
  /** 在文件中搜索的取消源：面板状态行上的「停止」按钮触发 */
  private searchCancellation?: vscode.CancellationTokenSource;
  /** 「统计完整数量」的取消源；存在即表示统计正在跑（防重入） */
  private countCancellation?: vscode.CancellationTokenSource;
  /** 当前进行中的在文件中搜索；新触发要抢占时靠它等待旧任务收场 */
  private searchInFlight?: Promise<void>;
  /** 上一次 findInFiles 触发时刻（双击判定用） */
  private lastFindAt = 0;
  /** 抢占代际：等待旧任务退场期间又来了新触发时，只让最新的一场上场 */
  private searchGeneration = 0;
  /** 「因旋转介质关掉分块」只提示一次，别每场搜索都刷一行 */
  private diskNoticeLogged = false;
  /** 文件名搜索面板（独立视图）；undefined = 未注册 */
  private filesPanel?: PanelView;
  /** 文件名搜索的取消源与在途任务：与内容搜索互相独立，可并行 */
  private filesCancellation?: vscode.CancellationTokenSource;
  private filesInFlight?: Promise<void>;
  /** 文件名搜索的抢占代际 */
  private filesGeneration = 0;
  /** 文件名搜索的记录：会话内有效，不持久化（轻量探查，重载不留卡片） */
  private readonly fileRecords = new Map<number, FileNameRecord>();

  constructor(
    private readonly corePromise: Promise<SearchCore>,
    private readonly highlighter: Highlighter,
    private readonly output?: vscode.OutputChannel,
    /** 工作区级存储：窗口重载 / 重启后结果还在，直到手动清空。 */
    private readonly store?: vscode.Memento,
    /** Worker 线程池路径：wasm 内核 + worker 脚本。缺省时只在宿主内扫描。 */
    private readonly paths?: {
      wasmPath?: string;
      workerPath?: string;
      walkWorkerPath?: string;
      storageDir?: string;
    },
  ) {
    // 搜索历史的大块头（大工作区可达数 MB）绝不能进 workspaceState——那个
    // 存储服务跑在渲染进程里，每次 persistHistory 都要在渲染进程做序列化，
    // 叠加结果渲染的内存峰值，实测能把 renderer 打崩（窗口自动重载）。
    // 与文件清单缓存同一策略：写 storageUri 文件，完全绕开渲染进程。
    if (paths?.storageDir) {
      this.historyFile = path.join(paths.storageDir, 'search-history.v1.json');
      this.fileHistoryFile = path.join(paths.storageDir, 'file-search-history.v1.json');
      this.dirPriority = createDirPriorityStore(paths.storageDir, (line) => this.log(line));
    }
  }

  /** 目录优先级（点击计数）：undefined = 无存储介质的测试环境（不记不排） */
  private dirPriority?: DirPriorityStore;
  /** 每场搜索开始时的优先级快照：场内点击不重排当前场，只影响下一场 */
  private searchPriorities: Record<string, number> = {};

  /** 工作区根列表（bump 的祖先传播边界用） */
  private workspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => folder.uri.fsPath);
  }

  /** 历史持久化文件（storageDir 介质）；undefined = 走 workspaceState（测试）。 */
  private historyFile?: string;
  /**
   * 文件名搜索结果的持久化文件：只存**最新一场**（0.1.125 起不按搜索词留
   * 记录，但重载窗口后像内容搜索一样恢复最近一次结果）。undefined = 测试环境。
   */
  private fileHistoryFile?: string;
  /** 文件名搜索持久化副本大小上限（超出从尾部丢分组，尾部优先级最低） */
  private static readonly MAX_FILE_HISTORY_BYTES = 1024 * 1024;
  /** 持久化副本大小上限：超过按损坏处理 */
  private static readonly MAX_HISTORY_BYTES = 64 * 1024 * 1024;

  private log(line: string): void {
    this.output?.appendLine(`[search] ${line}`);
  }

  attach(panel: PanelView): void {
    this.panel = panel;
  }

  defaultState(): PanelState {
    const config = vscode.workspace.getConfiguration('flySearch');
    return {
      query: '',
      replace: '',
      mode: config.get<'normal' | 'extended' | 'regex'>('defaultMode', 'normal'),
      caseSensitive: false,
      wholeWord: false,
      dotAll: false,
      wrapAround: config.get<boolean>('wrapAround', true),
      inSelection: config.get<boolean>('searchInSelection', false),
      direction: 'down',
      advanced: false,
      filters: config.get<string>('includeGlob', '**/*'),
    };
  }

  async open(mode: 'find' | 'replace'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const state = this.panel?.currentState ?? this.defaultState();
    const patch: Partial<PanelState> = {
      advanced: mode === 'replace' ? true : state.advanced,
    };
    if (editor && !editor.selection.isEmpty) {
      const selected = editor.document.getText(editor.selection);
      if (selected && selected.length <= 300 && !selected.includes('\n')) {
        patch.query = selected;
      }
    }
    this.panel?.patchState(patch);
    await this.panel?.reveal(mode);
  }

  async handleAction(action: string, state: PanelState): Promise<void> {
    try {
      switch (action) {
        case 'search':
        case 'findAllDoc':
          await this.searchDocument(state);
          return;
        case 'count':
          await this.searchDocument(state, 'count');
          return;
        case 'next':
          await this.step(state, 1);
          return;
        case 'prev':
          await this.step(state, -1);
          return;
        case 'findAllOpen':
          // 「已打开全部」与「全部」同义：统一走工作区扫描。
          // 旧实现遍历 visibleTextEditors，只有当前可见的标签页算数，
          // 单组布局下永远只有一个文件，看起来像「只搜了一个文件」。
        case 'findInFiles':
          await this.runSearch(state);
          return;
        case 'replaceOne':
          await this.replaceOne(state);
          return;
        case 'replaceAll':
          await this.replaceAll(state);
          return;
        case 'markAll':
          await this.markAll(state);
          return;
        case 'clearMarks':
          this.clearMarks();
          this.panel?.setStatus(t('已清除所有标记'));
          return;
        case 'clearResults':
          this.clearRecords();
          return;
        case 'cancelSearch':
          // 状态行「停止」按钮：让进行中的在文件中搜索尽快收工
          this.searchCancellation?.cancel();
          // 「统计完整数量」是独立的扫描循环，同样要能被打断
          this.countCancellation?.cancel();
          return;
        case 'focusEditor':
          await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
          return;
        default:
          return;
      }
    } catch (error) {
      this.fail(error);
    }
  }

  async findNext(): Promise<void> {
    const state = this.panel?.currentState ?? this.defaultState();
    await this.step(state, 1);
  }

  async findPrev(): Promise<void> {
    const state = this.panel?.currentState ?? this.defaultState();
    await this.step(state, -1);
  }

  async countFromCommand(): Promise<void> {
    const state = this.panel?.currentState ?? this.defaultState();
    if (!state.query) {
      await this.open('find');
      return;
    }
    await this.searchDocument(state, 'count');
  }

  async reveal(recordId: number, id: number): Promise<void> {
    const record = this.records.get(recordId);
    if (!record) {
      return;
    }
    const hit = record.hits[id];
    if (!hit) {
      return;
    }
    this.activeRecordId = record.id;
    // 点击计数：命中文件的父目录及祖先 +1（0.1.118 目录优先级）。
    // 快照在搜索开始时取好，场内点击不重排本场，只影响下一场。
    this.dirPriority?.bump(hit.uri, this.workspaceRoots());
    // current 记的是「展示顺序里的位置」，而 id 是命中下标：分组按路径插入了，
    // 两者不再相等，得先换算再落（换算不到就退回用 id，保持旧行为）
    const pos = this.orderedHitIds(record).indexOf(id);
    const index = pos >= 0 ? pos : id;
    record.current = index;

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(hit.uri));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(hit.range.start, hit.range.end);
    editor.revealRange(hit.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.panel?.postCurrent(record.id, id, index);
  }

  /** 启动时调用一次：把上次留在工作区里的结果卡片恢复出来。 */
  restoreHistory(): void {
    if (!this.store) {
      return;
    }
    // 文件介质优先（storageDir），读不到回落 workspaceState（旧版本迁移源）
    // 行式历史文本：文件是主介质（无 storageDir 的测试环境退化到 workspaceState
    // 存同一份行文本）。逐行解码，坏行跳过不牵连全场。
    let text = '';
    try {
      if (this.historyFile) {
        if (existsSync(this.historyFile)) {
          const raw = readFileSync(this.historyFile, 'utf8');
          text = raw.length > SearchController.MAX_HISTORY_BYTES ? '' : raw;
          if (!text && raw.length > SearchController.MAX_HISTORY_BYTES) {
            this.log('history file oversized, ignored');
          }
        }
      } else {
        const saved = this.store?.get<string>(HISTORY_KEY);
        text = typeof saved === 'string' ? saved : '';
      }
    } catch (error) {
      this.log(
        `history restore failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const decoded = decodeHistoryLines(text, MAX_RECORDS);
    if (decoded.length === 0) {
      return;
    }

    this.records.clear();
    let maxId = 0;
    // 存的是「最新在前」，Map 里按「最旧在前」放，和运行期的插入顺序一致
    for (const item of [...decoded].reverse()) {
      const record = this.fromDecoded(item);
      this.records.set(record.id, record);
      maxId = Math.max(maxId, record.id);
    }
    this.nextRecordId = maxId + 1;
    this.activeRecordId = -1;

    const history = [...this.records.values()].reverse().map((record) => this.toHistory(record));
    this.panel?.restoreRecords(history);
    this.log(
      `history restored records=${history.length} hits=${history.reduce((sum, item) => sum + item.total, 0)}`,
    );
  }

  /** 把当前记录整体写回工作区存储；失败不影响搜索。 */
  private persistHistory(): void {
    if (!this.store) {
      return;
    }
    // 进行中的记录不落盘：半场结果被当成完整结果恢复出来，比没有记录更糟
    const newest = [...this.records.values()]
      .filter((record) => !record.pending)
      .slice(-MAX_RECORDS)
      .reverse();
    // 行式存储：每行一条 encodeHistory 的记录（最新在前）。坏行可跳过、
    // 可整段截断，是「整份 JSON 一处损坏全丢」之后换来的健壮性。
    const lines = encodeHistory(newest.map((record) => this.toEncodeInput(record))).map((record) =>
      JSON.stringify(record),
    );
    const text = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    if (this.historyFile) {
      try {
        mkdirSync(path.dirname(this.historyFile), { recursive: true });
        // 先写临时文件再改名：写一半崩溃不会把历史文件弄成半截
        const tmp = `${this.historyFile}.tmp`;
        writeFileSync(tmp, text);
        renameSync(tmp, this.historyFile);
        this.log(`history persisted to file (${newest.length} records)`);
      } catch (error) {
        this.log(
          `history file persist failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    try {
      void Promise.resolve(this.store.update(HISTORY_KEY, text)).catch(() => undefined);
    } catch {
      // 存储不可用时静默降级为「不持久化」
    }
  }

  private toEncodeInput(record: SearchRecord): EncodeInput {
    const files: string[] = [];
    const ends: [number, number][] = [];
    for (const group of record.groups) {
      const first = group.items[0];
      files.push(first ? record.hits[first.id]?.uri ?? '' : '');
      for (const item of group.items) {
        const hit = record.hits[item.id];
        ends[item.id] = hit
          ? [hit.range.end.line + 1, hit.range.end.character + 1]
          : [item.line, item.column + item.matchLen];
      }
    }
    return { record: this.toHistory(record), files, ends };
  }

  private fromDecoded(item: DecodedRecord): SearchRecord {
    const hits: Hit[] = [];
    item.record.groups.forEach((group, index) => {
      const file = item.files[index];
      if (!file) {
        return;
      }
      // 回填分组路径：历史编码不存 path，「定位」按钮在恢复的记录上也要能用
      group.path = file;
      for (const entry of group.items) {
        const [endLine, endColumn] = item.ends[entry.id] ?? [
          entry.line,
          entry.column + entry.matchLen,
        ];
        hits[entry.id] = {
          uri: file,
          range: new vscode.Range(
            new vscode.Position(entry.line - 1, entry.column - 1),
            new vscode.Position(Math.max(0, endLine - 1), Math.max(0, endColumn - 1)),
          ),
        };
      }
    });

    return {
      id: item.record.id,
      query: item.record.query,
      scope: item.record.scope,
      scopeLabel: item.record.scopeLabel,
      optionsLabel: item.record.optionsLabel,
      groups: item.record.groups,
      hits,
      current: -1,
      elapsed: item.record.elapsed,
      truncated: item.record.truncated,
      time: item.record.time,
      totalBytes: item.record.totalBytes,
    };
  }

  /**
   * 统计某场搜索的**真实命中总数**（只数，不列）。
   *
   * 正常搜索到上限就停：`maxMatches`（默认 20000 条）和 `maxMatchesPerFile`
   * （2000 条）限制的是「列出来的行」——每一行都要建 Range、带预览、传给
   * webview 渲染，几十万条会把面板压死。但用户常常只想知道「到底多少处」
   * （在一堆日志里数关键词），这时不建预览、不算行号、不回传结果，可以完整
   * 扫一遍，代价只是一次顺序读 + 匹配。
   *
   * 只在用户点按钮时触发，所以默认路径的速度完全不受影响。
   */
  /** 遍历流的模式选项：worker 线程数与顺序模式都来自 flySearch 设置。 */
  private walkOpts(): WalkStreamOptions {
    const config = vscode.workspace.getConfiguration('flySearch');
    const raw = config.get<number>('walkThreads', 0);
    const threads =
      raw === 0
        ? Math.min(8, Math.max(2, Math.floor(os.cpus().length / 4)))
        : Math.max(-1, Math.min(16, raw));
    return {
      workerScript: this.paths?.walkWorkerPath,
      threads,
      order: config.get<'fast' | 'sorted'>('walkOrder', 'fast'),
      priorities: this.searchPriorities,
    };
  }

  async countExact(recordId: number): Promise<void> {
    const record = this.records.get(recordId);
    if (!record || !record.input || record.exactTotal !== undefined) {
      return;
    }
    // 防重入：统计跑着的时候再点按钮直接忽略（否则会并发两轮全库扫描）
    if (this.countCancellation) {
      return;
    }
    const cancellation = new vscode.CancellationTokenSource();
    this.countCancellation = cancellation;
    const input = record.input;
    const config = vscode.workspace.getConfiguration('flySearch');
    this.panel?.setBusy(true, t('统计中…'));
    try {
      const include = input.filters || config.get<string>('includeGlob', '**/*');
      const exclude = config.get<string>('excludeGlob', '');
      const maxFileBytes = config.get<number>('maxFileSizeKB', 512000) * 1024;
      const countConfig = {
        maxFileBytes,
        wholeLimit: 64 << 20,
        chunkBytes: 4 << 20,
        overlap: 64 << 10,
        perChunkCap: 200_000,
      };

      // 池子可用：与搜索同一条流水线并行计数（worker 各持 wasm，只回数字）
      const folders = vscode.workspace.workspaceFolders ?? [];
      const poolEligible =
        folders.length > 0 &&
        folders.every((folder) => folder.uri.scheme === 'file') &&
        config.get<number>('parallelWorkers', 0) >= 0 &&
        typeof this.paths?.wasmPath === 'string' &&
        typeof this.paths?.workerPath === 'string' &&
        existsSync(this.paths.workerPath);

      let result: Awaited<ReturnType<typeof countMatches>>;
      const walkOptsRef = {
        ...this.walkOpts(),
        shouldAbort: () => cancellation.token.isCancellationRequested,
      };
      if (poolEligible) {
        const files: string[] = [];
        let total = 0;
        let counted = 0;
        let skipped = 0;
        let bytes = 0;
        let approximate = false;
        const source = (async function* () {
          const it = createWalkStream(include, exclude, undefined, walkOptsRef);
          try {
            let r = await it.next();
            while (!r.done) {
              const p = r.value;
              const index = files.push(p) - 1;
              yield { path: p, index };
              r = await it.next();
            }
          } finally {
            await it.return?.(undefined as unknown as WalkStats);
          }
        })();
        const startedAt = Date.now();
        const outcome = await runWorkerSearch({
          wasmPath: this.paths!.wasmPath!,
          workerScript: this.paths!.workerPath!,
          workerCount: autoWorkerCount(),
          files: [],
          source,
          options: this.options(input),
          perFileLimit: 0,
          maxBytes: maxFileBytes,
          streamAbove: 0,
          count: countConfig,
          shouldAbort: () => cancellation.token.isCancellationRequested,
          onBatch: (results) => {
            for (const r of results) {
              if (r.kind !== 'count') {
                continue;
              }
              counted += 1;
              if (r.skipped) {
                skipped += 1;
              } else {
                total += r.count;
                approximate = approximate || r.approximate;
                bytes += r.size;
              }
              if (counted % 500 === 0) {
                this.panel?.setBusy(true, t('统计中 {s}/{f}', { s: counted, f: files.length }));
              }
            }
          },
        });
        if (outcome.kind === 'failed') {
          throw new Error(outcome.error);
        }
        if (outcome.kind === 'initFailed') {
          // worker 起不来：没有任何结果被回报，直接回落宿主串行路径
          result = await this.countExactSerial(input, include, exclude, maxFileBytes, cancellation.token);
        } else {
          result = {
            total,
            approximate,
            files: counted - skipped,
            skipped,
            bytes,
            ms: Date.now() - startedAt,
            cancelled: cancellation.token.isCancellationRequested,
          };
        }
      } else {
        result = await this.countExactSerial(input, include, exclude, maxFileBytes, cancellation.token);
      }
      if (result.cancelled) {
        // 用户中途 Stop：不采用部分计数，恢复「统计完整数量」按钮等下次再点
        this.panel?.setBusy(false);
        this.panel?.setStatus(t('已取消统计'), 'warn');
        this.panel?.postExactCount(recordId, { cancelled: true });
        this.log(`exact count "${record.query}": cancelled by user`);
        return;
      }
      record.exactTotal = result.total;
      this.panel?.setBusy(false);
      this.panel?.postExactCount(recordId, {
        total: result.total,
        approximate: result.approximate,
        files: result.files,
        skipped: result.skipped,
        ms: result.ms,
      });
      this.log(
        `exact count "${record.query}": ${result.total} 处 in ${result.ms}ms ` +
          `files=${result.files} skipped=${result.skipped} bytes=${result.bytes}` +
          (result.approximate ? ' (approximate)' : ''),
      );
    } catch (error) {
      this.fail(error);
    } finally {
      cancellation.dispose();
      if (this.countCancellation === cancellation) {
        this.countCancellation = undefined;
      }
    }
  }

  /**
   * 宿主串行计数：远程/虚拟文件系统或 worker 起不来时的回落路径。
   * 单线程整读 + wasm 计数，语义与池子路径完全一致。
   */
  private async countExactSerial(
    input: PanelState,
    include: string,
    exclude: string,
    maxFileBytes: number,
    token: vscode.CancellationToken,
  ): Promise<Awaited<ReturnType<typeof countMatches>>> {
    const core = await this.corePromise;
    const handle = compileQuery(core, this.options(input));
    const files: string[] = [];
    const it = createWalkStream(include, exclude, undefined, {
      ...this.walkOpts(),
      shouldAbort: () => token.isCancellationRequested,
    });
    let r = await it.next();
    while (!r.done) {
      files.push(r.value);
      r = await it.next();
    }
    return countMatches({
      core,
      handle,
      files,
      maxFileBytes,
      onProgress: (done, all) => this.panel?.setBusy(true, t('统计中 {s}/{f}', { s: done, f: all })),
      shouldAbort: () => token.isCancellationRequested,
    });
  }

  removeRecord(recordId: number): void {
    if (!this.records.delete(recordId)) {
      return;
    }
    this.panel?.removeRecord(recordId);
    if (this.activeRecordId === recordId) {
      const newest = [...this.records.keys()].pop();
      this.activeRecordId = newest ?? -1;
    }
    this.persistHistory();
  }

  private clearRecords(): void {
    this.records.clear();
    this.activeRecordId = -1;
    this.highlighter.clearMatches();
    this.panel?.clearRecords();
    this.persistHistory();
    this.panel?.setStatus(t('已清空结果记录'));
  }

  // ---- 文件名搜索（独立页面，0.1.124）----
  // 只匹配文件名、不读文件内容；展示 / 折叠 / 清空 / 优先级逻辑与内容搜索
  // 共用同一套面板代码与 dirPriority 存储，仅在匹配与交互入口上不同。

  attachFiles(panel: PanelView): void {
    this.filesPanel = panel;
  }

  /** 文件名搜索页的初始条件（只有关键字一个输入） */
  defaultFilesState(): PanelState {
    return { ...this.defaultState(), query: '', replace: '' };
  }

  async handleFilesAction(action: string, state: PanelState): Promise<void> {
    try {
      switch (action) {
        case 'findFileNames':
          await this.runFilesSearch(state);
          return;
        case 'cancelSearch':
          // 提高抢占代际：还在等待退场的实时搜索触发全部作废——否则 Stop 之后
          // 排队的触发会自动开新场，表现为「停不掉」
          this.filesGeneration += 1;
          this.filesCancellation?.cancel();
          return;
        case 'clearResults':
          this.clearFileRecords();
          return;
        case 'focusEditor':
          await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
          return;
        default:
          return;
      }
    } catch (error) {
      this.fail(error);
    }
  }

  removeFileRecord(recordId: number): void {
    if (!this.fileRecords.delete(recordId)) {
      return;
    }
    this.filesPanel?.removeRecord(recordId);
  }

  private clearFileRecords(): void {
    this.fileRecords.clear();
    this.filesPanel?.clearRecords();
    this.filesPanel?.setStatus(t('已清空结果记录'));
    // 清空也落盘：重载窗口后不再恢复出已被用户清掉的结果
    this.persistFileHistory();
  }

  /** 最新一场文件名搜索 → 持久化结构（条目带完整路径）。 */
  private toStoredFileRecord(record: FileNameRecord): StoredFileRecord {
    return {
      v: 1,
      id: record.id,
      q: record.query,
      sl: record.scopeLabel,
      ol: record.optionsLabel,
      e: record.elapsed,
      tr: record.truncated,
      t: record.time,
      walked: record.walked,
      g: record.groups.map((group) => ({
        l: group.label,
        d: group.detail,
        p: group.path ?? '',
        it: group.items.map(
          (item) =>
            [item.preview, item.prefix, item.matchLen, item.dir ?? '', record.files[item.id] ?? ''] as [
              string,
              number,
              number,
              string,
              string,
            ],
        ),
      })),
    };
  }

  /**
   * 把最新一场文件名搜索写进 storageDir 文件（单条 JSON，tmp+rename 原子写，
   * 与内容搜索历史同一策略）。清空后写空表；超预算从尾部丢分组——分组按
   * 优先级降序排，尾部最不重要。
   */
  private persistFileHistory(): void {
    if (!this.fileHistoryFile) {
      return;
    }
    try {
      mkdirSync(path.dirname(this.fileHistoryFile), { recursive: true });
      const tmp = `${this.fileHistoryFile}.tmp`;
      const record = [...this.fileRecords.values()].filter((entry) => !entry.pending).pop();
      let text: string;
      if (!record) {
        text = JSON.stringify({ v: 1, r: [] });
      } else {
        const payload: { v: 1; r: StoredFileRecord[] } = {
          v: 1,
          r: [this.toStoredFileRecord(record)],
        };
        text = JSON.stringify(payload);
        while (
          text.length > SearchController.MAX_FILE_HISTORY_BYTES &&
          payload.r[0].g.length > 1
        ) {
          payload.r[0].g.pop();
          text = JSON.stringify(payload);
        }
        if (text.length > SearchController.MAX_FILE_HISTORY_BYTES) {
          this.log('file search history oversized, skipped');
          return;
        }
      }
      writeFileSync(tmp, text);
      renameSync(tmp, this.fileHistoryFile);
    } catch (error) {
      this.log(
        `file search history persist failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 启动时恢复最近一场文件名搜索结果（restoreHistory 的文件页对应物）。 */
  restoreFileHistory(): void {
    if (!this.fileHistoryFile) {
      return;
    }
    let text = '';
    try {
      if (existsSync(this.fileHistoryFile)) {
        const raw = readFileSync(this.fileHistoryFile, 'utf8');
        text = raw.length <= SearchController.MAX_FILE_HISTORY_BYTES ? raw : '';
        if (!text && raw.length > SearchController.MAX_FILE_HISTORY_BYTES) {
          this.log('file search history oversized, ignored');
        }
      }
    } catch (error) {
      this.log(
        `file search history restore failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (!text.trim()) {
      return;
    }
    try {
      const payload = JSON.parse(text) as { v?: number; r?: StoredFileRecord[] };
      const stored = payload?.r?.[0];
      if (!payload || payload.v !== 1 || !stored || !Array.isArray(stored.g)) {
        return;
      }
      const files: string[] = [];
      const groups: ResultGroup[] = [];
      for (const group of stored.g) {
        if (!group || !Array.isArray(group.it) || group.it.length === 0) {
          continue;
        }
        const items: ResultItem[] = [];
        for (const entry of group.it) {
          if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[4] !== 'string' || !entry[4]) {
            continue;
          }
          const [preview, prefix, matchLen, dir, fsPath] = entry;
          // id 按「分组顺序 + 组内顺序」连续编号，与 files 下标一一对应
          const id = files.length;
          files.push(fsPath);
          items.push({
            id,
            line: 0,
            column: 0,
            preview,
            prefix: Number(prefix) || 0,
            matchLen: Number(matchLen) || 1,
            dir: typeof dir === 'string' ? dir : '',
          });
        }
        if (items.length === 0) {
          continue;
        }
        groups.push({
          label: typeof group.l === 'string' ? group.l : '',
          detail: typeof group.d === 'string' ? group.d : '',
          path: typeof group.p === 'string' && group.p ? group.p : undefined,
          items,
        });
      }
      if (groups.length === 0 || files.length === 0) {
        return;
      }
      const record: FileNameRecord = {
        id: Number.isFinite(stored.id) ? stored.id : this.nextRecordId,
        query: typeof stored.q === 'string' ? stored.q : '',
        scopeLabel: typeof stored.sl === 'string' ? stored.sl : t('按文件名'),
        optionsLabel: typeof stored.ol === 'string' ? stored.ol : '',
        groups,
        files,
        current: -1,
        elapsed: Number(stored.e) || 0,
        truncated: Boolean(stored.tr),
        time: Number(stored.t) || Date.now(),
        pending: false,
        walked: Number(stored.walked) || 0,
      };
      this.fileRecords.set(record.id, record);
      this.nextRecordId = Math.max(this.nextRecordId, record.id + 1);
      this.filesPanel?.restoreRecords([this.toFilesHistory(record)]);
      this.log(`file search history restored: ${files.length} files in ${groups.length} dirs`);
    } catch (error) {
      this.log(
        `file search history restore failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 文件名搜索页：点击条目直接打开文件，并按同一套规则提升优先级。 */
  async revealFile(recordId: number, id: number): Promise<void> {
    const record = this.fileRecords.get(recordId);
    const fsPath = record?.files[id];
    if (!record || !fsPath) {
      return;
    }
    this.dirPriority?.bump(fsPath, this.workspaceRoots());
    record.current = id;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch {
      this.filesPanel?.setStatus(t('无法打开文件：{f}', { f: relativePath(fsPath) }), 'warn');
      return;
    }
    this.filesPanel?.postCurrent(recordId, id, id);
  }

  /**
   * 分组标题上的「定位」按钮（内容搜索与文件名搜索共用）：
   * revealInExplorer 显示对应文件 / 目录，并按点击规则提升其优先级
   * （文件 → 目录链递减；目录 → 自身最高 + 祖先递减）。
   */
  async locateGroup(recordId: number, label: string, detail: string): Promise<void> {
    const match = (group: ResultGroup): boolean =>
      group.label === label && group.detail === detail;
    const contentGroup = this.records.get(recordId)?.groups.find(match);
    const filesGroup = this.fileRecords.get(recordId)?.groups.find(match);
    const target = contentGroup?.path ?? filesGroup?.path;
    if (!target) {
      return;
    }
    this.dirPriority?.bump(target, this.workspaceRoots());
    try {
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(target));
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * 文件名搜索的统一入口：实时搜索（输入即触发）不做双击判定——每次触发
   * 都是有意的新查询，直接取消在途任务并接管，保证「最后一次输入」胜出。
   */
  private async runFilesSearch(state: PanelState): Promise<void> {
    if (this.filesInFlight) {
      const gen = ++this.filesGeneration;
      this.filesCancellation?.cancel();
      await this.filesInFlight.catch(() => undefined);
      if (gen !== this.filesGeneration) {
        // 等待退场期间又有新触发接管，让最新的一场上场
        return;
      }
    }

    const task = this.searchFileNames(state);
    this.filesInFlight = task;
    try {
      await task;
    } finally {
      if (this.filesInFlight === task) {
        this.filesInFlight = undefined;
      }
    }
  }

  private toFilesHistory(record: FileNameRecord): HistoryRecord {
    return {
      id: record.id,
      query: record.query,
      scope: 'files',
      scopeLabel: record.scopeLabel,
      optionsLabel: record.optionsLabel,
      groups: record.groups.slice(),
      total: record.files.length,
      fileCount: record.groups.length,
      elapsed: record.elapsed,
      truncated: record.truncated,
      time: record.time,
      pending: record.pending,
      // 文件名搜索没有「统计完整数量」的概念（只数文件名，不扫内容）
      exactAvailable: false,
    };
  }

  /**
   * 文件名搜索：只匹配文件名，不读文件内容。
   * - 普通子串匹配、区分大小写（basename.includes(query)），没有其它选项；
   * - 结果按目录分组，边遍历边出（同一套流式 record/recordGroups 协议）；
   * - 优先级与内容搜索共用：快照决定遍历派发顺序（热目录先扫）与分组排序，
   *   点击条目 / 定位按钮照常计数，影响下一场。
   */
  private async searchFileNames(state: PanelState): Promise<void> {
    const panel = this.filesPanel;
    const query = state.query ?? '';
    if (!query) {
      // 实时搜索里输入被清空：安静地收掉结果列表，不弹警告
      this.fileRecords.clear();
      panel?.clearRecords();
      return;
    }
    const searchFolders = vscode.workspace.workspaceFolders ?? [];
    if (searchFolders.length === 0) {
      panel?.setStatus(t('需要先打开一个工作区文件夹'), 'warn');
      return;
    }
    const config = vscode.workspace.getConfiguration('flySearch');
    const started = Date.now();
    // 目录优先级快照：本场内点击不重排本场，只影响下一场（与内容搜索一致）
    this.searchPriorities = this.dirPriority?.snapshot() ?? {};
    if (Object.keys(this.searchPriorities).length > 0) {
      this.log(
        `dir priority snapshot: ${Object.keys(this.searchPriorities).length} dirs ` +
          `(max ${Math.max(...Object.values(this.searchPriorities))})`,
      );
    }
    const recordId = this.nextRecordId++;
    const limit = Math.max(1, config.get<number>('maxMatches', 20000));
    const include = state.filters || config.get<string>('includeGlob', '**/*');
    const exclude = config.get<string>('excludeGlob', '');

    const groups: ResultGroup[] = [];
    const files: string[] = [];
    let walked = 0;
    let capped = false;
    // 文件名搜索不按搜索词留记录（0.1.125）：永远只有最新一场，
    // 新搜索开始前静默清掉上一场（手动「清空」按钮才给提示文案）
    this.fileRecords.clear();
    panel?.clearRecords();
    const record: FileNameRecord = {
      id: recordId,
      query,
      scopeLabel: t('按文件名'),
      optionsLabel: t('普通匹配 · 区分大小写'),
      groups,
      files,
      current: -1,
      elapsed: 0,
      truncated: false,
      time: started,
      pending: true,
      walked: 0,
    };
    this.fileRecords.set(record.id, record);
    // 卡片立刻进面板：与内容搜索同一套「先开卡、边扫边长」的体验
    panel?.upsertRecord(this.toFilesHistory(record));

    const groupPrio = new Map<ResultGroup, number>();
    const groupComparator = (a: ResultGroup, b: ResultGroup): number => {
      const diff = (groupPrio.get(b) ?? 0) - (groupPrio.get(a) ?? 0);
      return diff !== 0 ? diff : a.detail.localeCompare(b.detail);
    };
    /** 目录 fsPath → 分组：同目录的文件聚进一个分组 */
    const dirGroups = new Map<string, ResultGroup>();
    /** 目录本身就是工作区根时（根直属文件那一组）相对路径显示成空串 */
    const dirDetail = (dir: string): string => {
      const rel = relativePath(dir);
      return rel === dir.replace(/\\/g, '/') ? '' : rel;
    };
    const addFile = (fsPath: string): void => {
      const id = files.length;
      files.push(fsPath);
      const base = basename(fsPath);
      const at = base.indexOf(query);
      const dir = path.dirname(fsPath);
      const item: ResultItem = {
        id,
        line: 0,
        column: 0,
        preview: base,
        prefix: Math.max(0, at),
        matchLen: query.length,
        // 条目第二行：所在目录的项目根相对路径（面板两行条目用）
        dir: dirDetail(dir),
      };
      let group = dirGroups.get(dir);
      if (!group) {
        group = { label: basename(dir) || dir, detail: dirDetail(dir), items: [], path: dir };
        dirGroups.set(dir, group);
        // 展示分 = 目录自身的点击分数（与内容搜索的 max(目录分, 文件分) 同源：
        // 这里的「文件分」就体现在其所在目录的分数里）
        groupPrio.set(group, scoreOf(this.searchPriorities, dir));
        let lo = 0;
        let hi = groups.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (groupComparator(groups[mid], group) <= 0) {
            lo = mid + 1;
          } else {
            hi = mid;
          }
        }
        groups.splice(lo, 0, group);
        sendQueue.push(group);
      }
      group.items.push(item);
    };

    /** 待推送的分组（与内容搜索同一套节流下发协议） */
    const sendQueue: ResultGroup[] = [];
    let lastFlushAt = 0;
    const flush = (force: boolean): void => {
      if (!force && sendQueue.length === 0) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastFlushAt < STREAM_FLUSH_MS) {
        return;
      }
      lastFlushAt = now;
      const fresh = sendQueue.splice(0, sendQueue.length);
      // 每个分组在列表里的最终下标：面板据此把它插到正确位置，而不是一律尾插。
      // 用一次遍历 + 引用集合取下标——绝不能用 indexOf（O(n)/分组）：宽泛关键词
      // 在大工作区会产生数万个分组，O(n²) 会把宿主事件循环打满，Stop 都点不动
      //（0.1.126 文件搜索卡死的根因）。
      const queued = new Set(fresh);
      const pairs: { group: ResultGroup; at: number }[] = [];
      for (let i = 0; i < groups.length; i += 1) {
        if (queued.has(groups[i])) {
          pairs.push({ group: groups[i], at: i });
        }
      }
      pairs.sort((a, b) => a.at - b.at);
      record.elapsed = now - started;
      panel?.appendRecord(
        record.id,
        pairs.map((pair) => pair.group),
        {
          total: files.length,
          fileCount: groups.length,
          elapsed: record.elapsed,
          truncated: capped,
          pending: Boolean(record.pending),
        },
        pairs.map((pair) => pair.at),
      );
    };

    const cancellation = new vscode.CancellationTokenSource();
    this.filesCancellation = cancellation;
    panel?.setBusy(true);
    try {
      const it = createWalkStream(include, exclude, undefined, {
        ...this.walkOpts(),
        shouldAbort: () => cancellation.token.isCancellationRequested,
      });
      try {
        let r = await it.next();
        while (!r.done) {
          if (cancellation.token.isCancellationRequested) {
            capped = true;
            break;
          }
          walked += 1;
          const p = r.value;
          // 只匹配文件名：普通子串、区分大小写，不读文件内容
          if (basename(p).includes(query)) {
            if (files.length >= limit) {
              capped = true;
              break;
            }
            addFile(p);
          }
          flush(false);
          // 周期性让出事件循环：缓冲数据充足时生成器会连续以微任务返回，
          // 不让出的话 Stop 点击等宏任务消息会被饿死——「Stop 点不动」的一半根因
          if (walked % 256 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (cancellation.token.isCancellationRequested) {
              capped = true;
              break;
            }
          }
          r = await it.next();
        }
      } finally {
        // 取消 / 出错时让遍历同步收尾（worker 会话随之终止）
        await it.return?.(undefined as unknown as WalkStats);
      }
      const found = walked;
      this.log(
        `file name search "${query}" done: matched=${files.length} dirs=${groups.length} ` +
          `walked=${found} capped=${capped} ${Date.now() - started}ms ` +
          `include=${include} exclude=${exclude}`,
      );
      record.truncated = capped;
      record.walked = walked;
      flush(true);
      record.pending = false;
      record.elapsed = Date.now() - started;
      panel?.finishRecord(this.toFilesHistory(record));
      this.persistFileHistory();
      const skippedNote = capped
        ? t(' · 已达上限，未扫完 {n} 个文件', { n: Math.max(0, walked - files.length) })
        : '';
      panel?.setStatus(
        files.length === 0
          ? t('在 {n} 个文件中未找到匹配的文件名 · {ms} ms', { n: walked, ms: record.elapsed }) +
              skippedNote
          : skippedNote.replace(/^ · /, ''),
        files.length === 0 ? 'warn' : 'info',
      );
    } catch (error) {
      record.pending = false;
      record.elapsed = Date.now() - started;
      flush(true);
      panel?.finishRecord(this.toFilesHistory(record));
      this.persistFileHistory();
      this.fail(error);
    } finally {
      if (this.filesCancellation === cancellation) {
        this.filesCancellation = undefined;
      }
      cancellation.dispose();
      panel?.setBusy(false);
    }
  }

  async findAllFromCommand(): Promise<void> {
    const state = await this.requireState();
    if (state) {
      await this.searchDocument(state);
    }
  }

  async findAllOpenFromCommand(): Promise<void> {
    const state = await this.requireState();
    if (state) {
      // 与「全部」同一个入口，避免命令面板里两条命令给出不同结果
      await this.runSearch(state);
    }
  }

  async replaceFromCommand(): Promise<void> {
    const state = await this.requireState();
    if (state) {
      await this.replaceOne(state);
    }
  }

  async replaceAllFromCommand(): Promise<void> {
    const state = await this.requireState();
    if (state) {
      await this.replaceAll(state);
    }
  }

  async markAllFromCommand(): Promise<void> {
    const state = await this.requireState();
    if (state) {
      await this.markAll(state);
    }
  }

  clearMarksCommand(): void {
    this.clearMarks();
    this.panel?.setStatus(t('已清除所有标记'));
  }

  async findInFilesFromCommand(): Promise<void> {
    const state = await this.requireState();
    if (state) {
      await this.runSearch(state);
    }
  }

  async copyMarked(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const ranges = this.markedByUri.get(editor.document.uri.toString());
    if (!ranges || ranges.length === 0) {
      this.panel?.setStatus(t('当前文档没有标记'), 'warn');
      return;
    }
    const lines = [...new Set(ranges.map((r) => r.start.line))].sort((a, b) => a - b);
    const text = lines.map((line) => editor.document.lineAt(line).text).join('\n');
    await vscode.env.clipboard.writeText(text);
    this.panel?.setStatus(t('已复制 {n} 行标记文本', { n: lines.length }));
  }

  private async searchDocument(
    state: PanelState,
    mode: SearchDocumentMode = 'record',
  ): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.panel?.setStatus(t('没有打开的编辑器'), 'warn');
      return;
    }
    if (!state.query) {
      this.panel?.setStatus(t('请输入查找内容'), 'warn');
      return;
    }

    const started = Date.now();
    // 记录 id 在触发时分配（单调递增）：结果卡片的排序依据是「点搜索的时间」，
    // 不是「搜完的时间」——先触发的慢搜索不能因为晚完成就插到快搜索上面。
    const recordId = this.nextRecordId++;
    const core = await this.corePromise;
    let handle: number;
    try {
      handle = compileQuery(core, this.options(state));
    } catch (error) {
      this.fail(error);
      return;
    }

    const config = vscode.workspace.getConfiguration('flySearch');
    const limit = config.get<number>('maxMatches', 20000);
    const doc = editor.document;
    const text = doc.getText();
    const raw = findMatches(core, handle, text, limit);

    const inSelection = state.inSelection && !editor.selection.isEmpty;
    const selStart = inSelection ? doc.offsetAt(editor.selection.start) : 0;
    const selEnd = inSelection ? doc.offsetAt(editor.selection.end) : Number.MAX_SAFE_INTEGER;

    const hits: Hit[] = [];
    const items: ResultItem[] = [];
    const ranges: vscode.Range[] = [];

    for (const match of raw) {
      if (match.start < selStart || match.start + match.len > selEnd) {
        continue;
      }
      const start = doc.positionAt(match.start);
      const end = doc.positionAt(match.start + match.len);
      const range = new vscode.Range(start, end);
      const id = hits.length;
      hits.push({ uri: doc.uri.fsPath, range });
      ranges.push(range);
      const lineText = doc.lineAt(start.line).text;
      items.push(makeItem(id, lineText, start.line, start.character, Math.max(1, match.len)));
    }

    // 计数只报数字，不做任何高亮：此前 count 也走 highlighter.show，所有命中
    // 被涂上 find-match 高亮且没有清除入口，看起来像「被标记了取消不掉」。
    if (mode !== 'count' && config.get<boolean>('highlightAllMatches', true)) {
      this.highlighter.show(editor, ranges, -1);
    }

    const elapsed = Date.now() - started;
    const group: ResultGroup = {
      label: basename(doc.uri.fsPath),
      detail: relativePath(doc.uri.fsPath),
      path: doc.uri.fsPath,
      items,
    };

    if (mode === 'count') {
      this.panel?.setStatus(
        t('计数：{n} 处（当前文档）', { n: items.length }) + (inSelection ? t(' · 仅在选区内') : ''),
      );
      return;
    }

    const previous = mode === 'refresh' ? this.activeRecord() : undefined;
    const reuse = previous && previous.scope === 'document' ? previous : undefined;

    const record: SearchRecord = {
      id: reuse ? reuse.id : recordId,
      query: state.query,
      scope: 'document',
      scopeLabel: t('当前文档'),
      optionsLabel: this.optionsLabel(state),
      groups: items.length > 0 ? [group] : [],
      hits,
      current: -1,
      elapsed,
      truncated: raw.length >= limit,
      time: started,
      totalBytes: Buffer.byteLength(text, 'utf8'),
    };
    this.commit(record, Boolean(reuse));

    // 命中数和用时已在记录折叠条上，成功时不再重复；选区限定只在没结果时提示
    this.panel?.setStatus(
      items.length === 0
        ? t('未找到匹配 · {ms} ms', { ms: elapsed }) + (inSelection ? t(' · 仅在选区内') : '')
        : '',
      items.length === 0 ? 'warn' : 'info',
    );
  }

  /**
   * 在文件中搜索的统一入口，带双击防抖与抢占语义：
   * - 双击窗口（SEARCH_DEBOUNCE_MS）内的重复触发：当前搜索就是「那一次」，直接忽略；
   * - 超出窗口的新触发：停止当前搜索任务（cancel），等它收场后开一场新的。
   * 面板消息是 `void onAction(...)` 不排队，没有这层守护时连点会并发跑两场搜索，
   * 旧任务的结果会和新任务的混在一起。
   */
  private async runSearch(state: PanelState): Promise<void> {
    const now = Date.now();
    const sinceLast = now - this.lastFindAt;
    this.lastFindAt = now;

    if (this.searchInFlight) {
      if (sinceLast < SEARCH_DEBOUNCE_MS) {
        return;
      }
      const gen = ++this.searchGeneration;
      this.searchCancellation?.cancel();
      await this.searchInFlight.catch(() => undefined);
      if (gen !== this.searchGeneration) {
        // 等待退场期间又有新触发接管，让最新的一场上场
        return;
      }
    }

    const task = this.searchInFiles(state);
    this.searchInFlight = task;
    try {
      await task;
    } finally {
      if (this.searchInFlight === task) {
        this.searchInFlight = undefined;
      }
    }
  }

  private async searchInFiles(state: PanelState): Promise<void> {
    if (!state.query) {
      this.panel?.setStatus(t('请输入查找内容'), 'warn');
      return;
    }
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      this.panel?.setStatus(t('需要先打开一个工作区文件夹'), 'warn');
      return;
    }
    const config = vscode.workspace.getConfiguration('flySearch');
    const started = Date.now();
    // 目录优先级快照（0.1.118 设计、0.1.121 补上——当时的替换静默 no-op，
    // 快照恒为空导致打分全 0，点击计数只攒不用）：本场内点击不重排本场，
    // 只影响下一场的扫描与展示顺序
    this.searchPriorities = this.dirPriority?.snapshot() ?? {};
    if (Object.keys(this.searchPriorities).length > 0) {
      this.log(
        `dir priority snapshot: ${Object.keys(this.searchPriorities).length} dirs ` +
          `(max ${Math.max(...Object.values(this.searchPriorities))})`,
      );
    }
    // 记录 id 在触发时分配（单调递增）：结果卡片按「点搜索的时间」排序，
    // 而不是「搜完的时间」——否则先触发的慢搜索完成得晚，会反超快搜索。
    const recordId = this.nextRecordId++;
    const core = await this.corePromise;
    let handle: number;
    try {
      handle = compileQuery(core, this.options(state));
    } catch (error) {
      this.fail(error);
      return;
    }

    const globalLimit = config.get<number>('maxMatches', 20000);
    const perFileLimit = Math.max(1, config.get<number>('maxMatchesPerFile', 2000));
    const maxBytes = config.get<number>('maxFileSizeKB', 512000) * 1024;
    /** 超过这个大小就分块流式读取，内存不再随文件体积增长 */
    const streamAbove = Math.max(0, config.get<number>('streamThresholdKB', 2048)) * 1024;
    const include = state.filters || config.get<string>('includeGlob', '**/*');
    const exclude = config.get<string>('excludeGlob', '');
    /**
     * 逐文件诊断日志（file / hit / skip）默认关闭：output.appendLine 是同步
     * 追加，几万文件每个一行会吞掉扫描线程的时间片（实测 8 万文件的工作区
     * 仅日志就能吃掉数秒），且大部分场景根本不看。汇总行（file list in /
     * scan in）不受此开关控制，始终输出。
     */
    const verbose = config.get<boolean>('verboseLog', false);

    // ---- 结果容器与「进行中」卡片 ----
    // groups / hits 从头到尾是同一份数组：卡片一开就持有引用，每扫完一个文件
    // 往尾巴上追加，收尾时直接把这两份数组落成最终记录，不再维护第二份中间态。
    const hits: Hit[] = [];
    const groups: ResultGroup[] = [];
    let scanned = 0;
    let skippedBinary = 0;
    let skippedLarge = 0;
    let failed = 0;
    let capped = false;
    /** 实际扫描过的文件总字节数（流式 + 整块读都算），折叠条上显示「总大小」 */
    let scannedBytes = 0;
    /** 流式读取时更新进度条的最小间隔 */
    let lastProgressAt = 0;
    /** 内核抛错（表达式问题等）：终止整场搜索并报告，与旧串行行为一致 */
    let aborted = false;
    /** 被体积门槛挡掉的文件，记下来在结果卡片里点名，绝不静默丢弃 */
    const skippedLargeFiles: { name: string; size: number }[] = [];

    /** 待推送的分组：已经插进 groups、还没发给面板的那一批 */
    const sendQueue: ResultGroup[] = [];
    /**
     * 分组按路径插入排序，而不是尾插。
     * worker 池是并行批次，文件完成顺序与文件顺序毫无关系——尾插会让列表在
     * 搜索过程中乱序跳动（同一目录的文件忽前忽后）。二分定位 + splice，
     * 5000 个文件也只有几万次比较，不拖慢扫描。
     */
    /**
     * 有文件撞到单文件上限（perFileLimit）时也要把整场标成 truncated：
     * 否则卡片上一声不吭，只有分组标题带个 `+`，用户看到的「N 处」同样不是
     * 真值，却连「统计完整数量」的入口都没有。
     */
    let anyGroupTruncated = false;
    /** 分组 → 目录优先级分数：显示排序 = 热目录靠前、路径次之（0.1.118） */
    const groupPrio = new Map<ResultGroup, number>();
    const groupComparator = (a: ResultGroup, b: ResultGroup): number => {
      const diff = (groupPrio.get(b) ?? 0) - (groupPrio.get(a) ?? 0);
      return diff !== 0 ? diff : a.detail.localeCompare(b.detail);
    };
    const addGroup = (group: ResultGroup, fileFsPath: string): void => {
      if (group.truncated) {
        anyGroupTruncated = true;
      }
      // 展示分 = max(父目录分, 文件分)：目录分来自点击的祖先传播（热子树
      // 整体靠前），文件分来自对具体条目的点击（平铺根目录里只有它能区分）。
      // 平铺工作区（文件全在根下）目录链为空、目录分恒 0——0.1.120 之前
      // 点击因此完全不生效，就是这个 max 的另一半在兜底。
      groupPrio.set(
        group,
        Math.max(
          scoreOf(this.searchPriorities, path.dirname(fileFsPath)),
          scoreOf(this.searchPriorities, fileFsPath),
        ),
      );
      let lo = 0;
      let hi = groups.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (groupComparator(groups[mid], group) <= 0) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      groups.splice(lo, 0, group);
      sendQueue.push(group);
    };

    const record: SearchRecord = {
      id: recordId,
      query: state.query,
      scope: 'files',
      scopeLabel: t('在文件中'),
      optionsLabel: this.optionsLabel(state),
      groups,
      hits,
      current: -1,
      elapsed: 0,
      truncated: false,
      time: started,
      totalBytes: 0,
      pending: true,
      input: { ...state },
    };
    // 搜索一开始就把卡片插进面板：用户立刻看到「搜索中」，不用等整场扫完
    this.beginRecord(record);

    let lastFlushAt = 0;
    /**
     * 把新分组推给面板。节流窗口内的分组先攒着，等下一个文件或收尾时一起发；
     * force 用于收尾，保证尾巴上的分组不会漏在节流窗口里。
     */
    const flush = (force: boolean): void => {
      if (!force && sendQueue.length === 0) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastFlushAt < STREAM_FLUSH_MS) {
        return;
      }
      lastFlushAt = now;
      // 每个分组在列表里的最终下标：面板据此把它插到正确位置，而不是一律尾插。
      // 按升序下发，面板顺序执行「插到第 i 个之前」即可还原同一个顺序。
      // 一次遍历 + 引用集合取下标（indexOf 是 O(n)/分组，命中数逼近上限时
      // 总量 O(n²)，会把宿主事件循环打满——文件搜索 0.1.126 卡死的同款根因）。
      const fresh = sendQueue.splice(0, sendQueue.length);
      const queued = new Set(fresh);
      const pairs: { group: ResultGroup; at: number }[] = [];
      for (let i = 0; i < groups.length; i += 1) {
        if (queued.has(groups[i])) {
          pairs.push({ group: groups[i], at: i });
        }
      }
      pairs.sort((a, b) => a.at - b.at);
      record.elapsed = now - started;
      record.totalBytes = scannedBytes;
      record.truncated = capped || anyGroupTruncated;
      this.panel?.appendRecord(
        record.id,
        pairs.map((pair) => pair.group),
        {
          total: hits.length,
          fileCount: groups.length,
          elapsed: record.elapsed,
          totalBytes: scannedBytes,
          truncated: capped,
          pending: Boolean(record.pending),
        },
        pairs.map((pair) => pair.at),
      );
    };

    /**
     * 收尾：补齐还没推出去的分组，落最终统计，摘掉「搜索中」。
     * 正常结束、被抢占、出错三条路都必须走这里——否则卡片会一直转圈。
     */
    const settle = (): void => {
      record.elapsed = Date.now() - started;
      record.truncated = capped || anyGroupTruncated;
      record.totalBytes = scannedBytes;
      flush(true);
      record.pending = false;
      this.panel?.finishRecord(this.toHistory(record));
      this.persistHistory();
    };

    // ---- 生产者-消费者（0.1.114）：遍历即扫描的输入流 ----
    // 遍历器是 async 生成器；池子的喂数循环拉一个派一个，枚举与扫描全程
    // 重叠，不存在「等全量清单」的环节。files 注册表随产出同步生长，
    // applyBatch / legacy 路径按全局下标反查路径。
    const files: string[] = [];
    let walkStats: WalkStats | undefined;
    const listedAt = Date.now();
    const streamOpts = { ...this.walkOpts(), shouldAbort: () => token.isCancellationRequested };
    const walkSource = (): AsyncGenerator<PoolWorkItem, void, void> =>
      (async function* () {
        const it = createWalkStream(include, exclude, undefined, streamOpts);
        try {
          let r = await it.next();
          while (!r.done) {
            const p = r.value;
            const index = files.push(p) - 1;
            yield { path: p, index };
            r = await it.next();
          }
          walkStats = r.value;
        } finally {
          // 池子取消 / 失败会对生成器调 return()：内部遍历同步收尾
          await it.return?.(undefined as unknown as WalkStats);
        }
      })();

    // ---- Worker 线程池：本地文件并行扫描（每线程一份 wasm 实例 + node:fs 直读）----
    // parallelWorkers：0=自动（CPU 核数-2，夹 2~16），1~16=固定线程数，-1=关闭。
    // 流式模式下清单大小要等遍历完才知道，auto 不再按文件数伸缩，改为按 CPU
    // 定档。本地盘 + worker 脚本可用即走池子——池子常驻，冷启动一次 ~40ms。
    const parallelSetting = Math.max(-1, Math.min(16, config.get<number>('parallelWorkers', 0)));
    const searchFolders = vscode.workspace.workspaceFolders ?? [];
    const filesPoolEligible =
      searchFolders.length > 0 &&
      searchFolders.every((folder) => folder.uri.scheme === 'file') &&
      typeof this.paths?.wasmPath === 'string' &&
      typeof this.paths?.workerPath === 'string' &&
      existsSync(this.paths.workerPath);
    let workerCount: number;
    if (parallelSetting < 0) {
      workerCount = 0;
    } else if (parallelSetting === 0) {
      workerCount = filesPoolEligible ? autoWorkerCount() : 0;
    } else {
      workerCount = parallelSetting;
    }
    const poolReady = workerCount >= 1 && filesPoolEligible;
    if (poolReady) {
      this.log(`worker pool: ${workerCount} threads (streaming pipeline)`);
    }

    /**
     * 超大文件并行分块策略（细节见 chunkPlan.ts）：超过 `chunkAbove` 的文件
     * 由 worker 回报字节区间，宿主把区间当活派回同一条队列——同一份文件因此
     * 能被多个 worker 同时扫。0 表示关闭，仍走串行流式。
     *
     * 门槛默认 2MB（与单块下限一致）：4MB 的文件切 2 块、8MB 切 4 块，中等体积
     * 的文件也能吃到并行。代价是 `size < 8W MB` 时块数不足以喂满 worker，此时
     * 分块只赚「两份文件级并行」的钱。
     *
     * 并发度取池子线程数；legacy 路径（没开池子）单独给一个 2~8 的折中值：
     * 只有一两个文件时没必要按 16 线起 worker（每个 worker 一份 wasm + 块缓冲）。
     */
    const configuredAbove = Math.max(0, config.get<number>('chunkAboveMB', 2)) * 1024 * 1024;
    /**
     * 机械硬盘闸门：分块 = W 路并发读不同偏移，旋转介质上每路都是一次寻道，
     * 顺序读退化成随机读（实测能反过来慢好几倍）。探测到旋转盘时把门槛抬到
     * 无穷大，等于关掉分块，退回串行流式。`diskType` 手动设成 ssd 可强制开启
     * （探测在容器 / 权限受限时可能误判）。
     */
    const disk = currentDiskProbe();
    const allowChunk = resolveChunking(disk.kind, config.get<string>('diskType', 'auto'));
    const chunkAboveBytes = allowChunk ? configuredAbove : 0;
    if (!allowChunk && configuredAbove > 0 && !this.diskNoticeLogged) {
      this.diskNoticeLogged = true;
      this.log(
        `disk: rotational media (${disk.kind}, ${disk.source}${disk.detail ? ' ' + disk.detail : ''}) ` +
          '— chunked parallel search disabled; set flySearch.diskType=ssd to override',
      );
    }
    const chunkMemory = Math.max(4, config.get<number>('chunkMemoryMB', 32)) * 1024 * 1024;
    /**
     * 拥挤期仍然允许分块的最大体积（0 = 关闭拥挤闸门，永远分块）。
     *
     * 池子还剩大量字节要扫时，把占比很小的文件拆开只是让别的活顺延，还多付
     * 装配与消息往返。默认 2MB 与分块门槛持平 —— 相当于「进了这条路就分块」，
     * 只有真正不到门槛的文件才会被合单块。想看过去的保守行为（只给 32MB 以上
     * 的文件并行）把它调成 32。
     */
    const chunkCrowdBytes = Math.max(0, config.get<number>('chunkCrowdMB', 2)) * 1024 * 1024;
    const chunkOverlap = overlapForQuery(state.mode, state.query, state.dotAll);
    const chunkWorkers = poolReady ? workerCount : 8;
    const chunkPolicy: (ChunkPolicy & { above: number }) | undefined =
      chunkAboveBytes > 0
        ? {
            above: chunkAboveBytes,
            workers: chunkWorkers,
            memoryPerWorker: chunkMemory,
            overlap: chunkOverlap,
          }
        : undefined;

    /**
     * 超大文件的分块装配表：fileIndex → { 已到的块、总块数、stat }。
     * 分块由 worker 先回报 plan、宿主再把区间派回同一条队列，所以同一份文件的
     * 块可能散落在不同批、不同 worker 里，这里按块号攒齐再落成一条结果。
     */
    const chunkFiles = new Map<
      number,
      {
        path: string;
        size: number;
        stat: { mtimeMs: number; size: number };
        total: number;
        ranges: { index: number; start: number; end: number; readEnd: number }[];
        parts: ChunkPart[];
        /** 收到 plan 的时刻：用来区分「文件自己算得慢」和「块在队列里排队」 */
        plannedAt: number;
        /** 各块真实扫描耗时累加（不含排队）：日志 file= 的来源 */
        scanMs: number;
        abandoned: boolean;
      }
    >();

    /**
     * 把一批 worker 结果落进与 legacy 路径相同的计数器和结果集。
     * 返回这批里「真正扫完的文件数」（分块结果是碎片，不能按条数计）。
     */
    const applyBatch = (results: PoolFileResult[]): number => {
      let completed = 0;
      for (const result of results) {
        // 0.1.113 起清单直接是 fsPath 字符串，不再有 vscode.Uri 中转
        const uri = files[result.index];

        // ---- 超大文件：worker 只回报区间，宿主把分块插回队列 ----
        if (result.kind === 'plan') {
          const fsPath = uri;
          /**
           * 拥挤闸门：还有大量待办时，把这个文件拆开只是把别的活顺延，总时长
           * 不变却多付一份装配成本。但「大量」必须按字节算，不能按文件个数算。
           *
           * 估算方式：队列项数 × 已见文件的平均大小 / 线程数 = 单个 worker 手上
           * 还剩多少字节要扫。这个文件只占其中一小角（< CROWD_SHARE）时就不拆。
           *
           * 反例说明为什么不能只看队列长度：kernel 树里 asic_reg 那批几 MB 的
           * 自动生成头文件路径连续，会被同一个 worker 一口气领走 —— 队列长度仍是
           * 几万，但队列里全是几毫秒的小文件，那个 worker 却要单干好几秒。
           */
          /**
           * 分母必须是**文件**条目数：队列里还有一堆 1MB 的块时，用条目总数
           * 乘「平均文件大小」会把剩余工作量高估几十倍（10 个 20MB 文件 =
           * 200 个块 × 20MB = 4GB），闸门于是把后面每个大文件都判成「不值得
           * 拆」——这正是 10×20MB 比内核树还慢的原因之一。
           */
          const pending = poolPendingFileCount();
          // 平均大小优先用「典型大小」（排除 > 1MB）；全是巨型文件时那个
          // 均值恒为 0，退回含大文件的聚合均值，否则拥挤判据会失去意义。
          const avgBytes = poolAverageFileBytes() || poolAverageAllBytes();
          const crowded = isCrowdedForChunk(
            result.size,
            pending,
            avgBytes,
            workerCount,
            chunkCrowdBytes,
          );
          const perWorkerBytes =
            avgBytes > 0 ? (pending * avgBytes) / Math.max(1, workerCount) : 0;
          const leftMb = Math.max(0, Math.round(perWorkerBytes / (1024 * 1024)));
          const ranges = crowded
            ? [{ index: 0, start: 0, end: result.size, readEnd: result.size }]
            : result.ranges;
          chunkFiles.set(result.index, {
            path: fsPath,
            size: result.size,
            stat: result.stat,
            total: ranges.length,
            ranges,
            parts: [],
            plannedAt: Date.now(),
            scanMs: 0,
            abandoned: false,
          });
          const items: PoolWorkItem[] = ranges.map((range) => ({
            path: fsPath,
            index: result.index,
            chunkIndex: range.index,
            start: range.start,
            end: range.end,
            readEnd: range.readEnd,
          }));
          const queued = appendPoolWork(items);
          const perChunk = ranges.length > 0 ? formatSize(ranges[0].end - ranges[0].start) : '';
          this.log(
            `chunked ${relativePath(uri)} size=${formatSize(result.size)} chunks=${ranges.length}` +
              (perChunk ? ` x${perChunk}` : '') +
              (crowded ? ` (crowded, single chunk, ~${leftMb}MB/w left)` : '') +
              (queued ? '' : ' (queue gone, falling back)'),
          );
          if (!queued) {
            // 池子已经收工（理论不可达）：退化成失败，别让这个文件悄无声息
            chunkFiles.delete(result.index);
            failed += 1;
            completed += 1;
          }
          continue;
        }
        if (result.kind === 'chunk') {
          const acc = chunkFiles.get(result.index);
          if (!acc || acc.abandoned) {
            continue;
          }
          acc.parts.push({
            index: result.chunkIndex,
            hits: result.hits,
            lines: result.lines,
            capped: result.capped,
          });
          acc.scanMs += result.ms;
          if (acc.parts.length < acc.total) {
            continue;
          }
          chunkFiles.delete(result.index);
          completed += 1;
          scanned += 1;
          scannedBytes += acc.size;
          const merged = mergeChunkParts(acc.parts, perFileLimit);
          const items: ResultItem[] = [];
          for (const hit of merged.hits) {
            if (hits.length >= globalLimit) {
              capped = true;
              break;
            }
            const id = hits.length;
            hits.push({
              uri,
              range: new vscode.Range(hit.line, hit.column, hit.endLine, hit.endColumn),
            });
            items.push({
              id,
              line: hit.line + 1,
              column: hit.column + 1,
              preview: hit.preview,
              prefix: hit.prefix,
              matchLen: hit.matchLen,
            });
          }
          if (items.length > 0) {
            addGroup(
              {
                label: basename(uri),
                detail: relativePath(uri),
                path: uri,
                items,
                truncated: merged.truncated,
              },
              uri,
            );
          }
          // 两个耗时分别表示：file = 从 plan 到全部块装配完（含块在队列里的排队），
          // total = 整场搜索到这一刻。只看后者会误以为单文件要几百毫秒。
          // file= 是**真实扫描耗时**（各块读+匹配之和，不含排队）——流式管线里
          // 大文件的 plan 到得很早、块排在后面几十万个文件之后，旧的「plan 到
          // 装配」口径会让 file= ≈ 整场耗时（用户实测的退化）。排队时间单独
          // 用 wait= 表达，两条信息都要能看。
          const waitMs = Date.now() - acc.plannedAt;
          this.log(
            `${items.length > 0 ? 'hit' : 'miss'} ${relativePath(uri)} chunks=${acc.parts.length} ` +
              `items=${items.length}${merged.truncated ? ' (capped)' : ''} ` +
              `file=${acc.scanMs}ms wait=${waitMs}ms total=${Date.now() - started}ms`,
          );
          continue;
        }
        if (result.kind === 'chunkUnsupported') {
          // 块里出现非法 UTF-8（前 8KB 探测没发现的混合编码）：整份文件改串行
          const acc = chunkFiles.get(result.index);
          if (!acc || acc.abandoned) {
            continue;
          }
          acc.abandoned = true;
          chunkFiles.delete(result.index);
          dropPoolChunks(result.index);
          const requeued = appendPoolWork([{ path: acc.path, index: result.index, skipChunk: true }]);
          this.log(
            `chunk utf8 fallback ${relativePath(uri)}` + (requeued ? '' : ' (queue gone)'),
          );
          if (!requeued) {
            failed += 1;
            completed += 1;
          }
          continue;
        }

        scanned += 1;
        completed += 1;
        if (result.kind === 'hit') {
          scannedBytes += result.bytesRead;
          const items: ResultItem[] = [];
          for (const hit of result.hits) {
            if (hits.length >= globalLimit) {
              capped = true;
              break;
            }
            const id = hits.length;
            hits.push({
              uri,
              range: new vscode.Range(hit.line, hit.column, hit.endLine, hit.endColumn),
            });
            items.push({
              id,
              line: hit.line + 1,
              column: hit.column + 1,
              preview: hit.preview,
              prefix: hit.prefix,
              matchLen: hit.matchLen,
            });
          }
          if (items.length > 0) {
            addGroup(
              {
                label: basename(uri),
                detail: relativePath(uri),
                path: uri,
                items,
                truncated: result.truncated,
              },
              uri,
            );
          }
          if (verbose) {
            this.log(
              `hit ${relativePath(uri)} items=${items.length}${result.truncated ? ' (capped)' : ''}`,
            );
          }
        } else if (result.kind === 'miss') {
          scannedBytes += result.bytesRead;
        } else if (result.kind === 'binary') {
          skippedBinary += 1;
        } else if (result.kind === 'tooLarge') {
          skippedLarge += 1;
          if (skippedLargeFiles.length < 20) {
            skippedLargeFiles.push({ name: relativePath(uri), size: result.size });
          }
          if (verbose) {
            this.log(
              `skip ${relativePath(uri)} size=${formatSize(result.size)} > limit=${formatSize(maxBytes)}`,
            );
          }
        } else if (result.kind === 'stat') {
          // validate 结果只进校验回调，不应出现在扫描路径；防御性忽略
        } else {
          failed += 1;
          // 分块途中的读失败（文件被删/权限变动）：放弃这份文件的装配，
          // 否则补块场会一直重试同一块
          chunkFiles.delete(result.index);
        }
      }
      // 一批结果落定就推一帧：面板上这张卡片是边扫边长的
      flush(false);
      return completed;
    };

    /**
     * 结果缓存分流：同指纹的文件进 check 集合（worker 只 statSync 回报），
     * 其余正常扫描——校验与扫描在**同一场**池子里，没有 0.1.67 的独立
     * 校验场（两轮池子启停 + stat 按 24 个/批冲刷，80k 文件 3300+ 条
     * postMessage 的开销反超 stat 本身）。这里只做纯内存 Map 查询（零
     * 系统调用）；stat 比对在 onBatch 里做，命中回放缓存结果，变了/没了
     * 的进补扫队列场后补一轮。缓存 put 仍在 onBatch 里做（stat 用 worker
     * 读文件时的读前值，读后改动会被下次校验逮住）。
     */
    /**
     * 单个文件的完整处理。之前是严格串行的 for-await：每个文件 stat + read
     * 两次 IPC 往返排成一队，7.7 万文件就是十几万次串行等待，磁盘 I/O 和
     * CPU 匹配完全不能重叠。现在由下面的并发池同时处理多个文件，完成顺序
     * 不再保证——groups 最终按路径排序，hits 的 id 与下标始终一致，语义不变。
     */
    /** 跑一场池子搜索；`chunk` 给了才会启用「worker 规划 + 回报区间」。 */
    const runChunkPass = (
      items: PoolWorkItem[],
      token: vscode.CancellationToken,
      chunk?: ChunkPolicy & { above: number },
    ): Promise<{ kind: string; error?: string }> =>
      runWorkerSearch({
        wasmPath: this.paths!.wasmPath!,
        workerScript: this.paths!.workerPath!,
        workerCount: chunkWorkers,
        files: items,
        options: this.options(state),
        perFileLimit,
        maxBytes,
        streamAbove,
        chunk,
        shouldAbort: () => token.isCancellationRequested,
        onBatch: (results) => {
          applyBatch(results);
        },
      });

    /**
     * 补块场：worker 是「自己的活干完、队列已空」之后才腾出手回报 plan 的，
     * 那一刻其它 worker 大多已经收工——剩下的块会被最后一个 worker 串行啃完
     * （实测 32 块只用到 1 个核）。所以主场结束后把「还没跑到的块」收起来，
     * 再开一场专门的场次交给全部 worker。此时池子是热的，启动成本毫秒级。
     */
    const drainPendingChunks = async (token: vscode.CancellationToken): Promise<void> => {
      for (let pass = 0; pass < 4 && chunkFiles.size > 0; pass += 1) {
        if (token.isCancellationRequested) {
          break;
        }
        const items: PoolWorkItem[] = [];
        for (const [index, acc] of chunkFiles) {
          const arrived = new Set(acc.parts.map((part) => part.index));
          for (const range of acc.ranges) {
            if (arrived.has(range.index)) {
              continue;
            }
            items.push({
              path: acc.path,
              index,
              chunkIndex: range.index,
              start: range.start,
              end: range.end,
              readEnd: range.readEnd,
            });
          }
        }
        if (items.length === 0) {
          break;
        }
        this.log(`chunk catch-up: ${chunkFiles.size} file(s), ${items.length} chunk(s)`);
        const outcome = await runChunkPass(items, token);
        if (outcome.kind !== 'ok') {
          this.log(`chunk catch-up failed (${outcome.error ?? outcome.kind})`);
          break;
        }
      }
      if (chunkFiles.size > 0) {
        // 还有残块（文件被删 / 读失败）：放弃这几份文件，别让装配表悬着。
        // 宁可这份文件不出结果，也不出一个偷偷少了几个文件的结果。
        this.log(`chunk assembly abandoned: ${chunkFiles.size} file(s)`);
        chunkFiles.clear();
      }
    };

    /**
     * 单份超大文件的分块场（legacy 兜底）：没有常驻池子时临时开一场，
     * 复用的仍是「worker 回报 plan → 宿主把区间派回队列 → applyBatch 装配」
     * 那套流程，只是场里只有这一个文件。返回 false 表示没接手（调用方退回
     * 串行流式）。
     *
     * 同一时刻只能有一场（池子就这么大），所以多份大文件按到达顺序排队：
     * 每份都独占整个池子并行扫，比两个文件各分一半线程更快。
     */
    let chunkSessionChain: Promise<void> = Promise.resolve();
    const searchFileChunked = (
      uri: string,
      fileIndex: number,
      token: vscode.CancellationToken,
    ): Promise<boolean> => {
      const task = chunkSessionChain.then(() => runChunkSession(uri, fileIndex, token));
      chunkSessionChain = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    };

    const runChunkSession = async (
      uri: string,
      fileIndex: number,
      token: vscode.CancellationToken,
    ): Promise<boolean> => {
      const wasmPath = this.paths?.wasmPath;
      const workerScript = this.paths?.workerPath;
      if (
        typeof wasmPath !== 'string' ||
        typeof workerScript !== 'string' ||
        !existsSync(workerScript)
      ) {
        return false;
      }
      const outcome = await runChunkPass([{ path: uri, index: fileIndex }], token, chunkPolicy);
      if (outcome.kind === 'ok') {
        // 单文件同样会踩「队列提前排空」：补一场把剩下的块真正并发跑掉
        await drainPendingChunks(token);
        return true;
      }
      // 起不来 / 半路崩：清掉可能残留的半份装配，改走串行
      chunkFiles.delete(fileIndex);
      this.log(
        `chunk session unavailable for ${relativePath(uri)} (${outcome.kind} ${outcome.error}), streaming instead`,
      );
      return false;
    };

    const processFile = async (
      uri: string,
      fileIndex: number,
      progress: vscode.Progress<{ message?: string; increment?: number }>,
      token: vscode.CancellationToken,
    ): Promise<void> => {
      let size: number;
      try {
        size = (await vscode.workspace.fs.stat(vscode.Uri.file(uri))).size;
      } catch {
        failed += 1;
        return;
      }
      if (size > maxBytes) {
        skippedLarge += 1;
        if (skippedLargeFiles.length < 20) {
          skippedLargeFiles.push({ name: relativePath(uri), size });
        }
        if (verbose) {
          this.log(
            `skip ${relativePath(uri)} size=${formatSize(size)} > limit=${formatSize(maxBytes)}`,
          );
        }
        return;
      }

      /*
       * 超大文件：没有常驻池子时（文件数少 / 用户关了并行），临时为它开一场
       * 分块搜索——否则一份 2GB 的日志会把「单核 + 一条顺序读流」吃满，
       * 其它文件全等着。开不起来（池子已被占用 / worker 脚本缺失）就往下
       * 走串行流式，行为与 0.1.74 一致。
       */
      if (chunkPolicy && size > chunkPolicy.above && !token.isCancellationRequested) {
        // 收益判据：拆了省不下 4ms（且不到 15%）就老实串行，别付 plan 的门票
        const gain = estimateChunkGain(size, chunkPolicy);
        if (gain.worth) {
          const handled = await searchFileChunked(uri, fileIndex, token);
          if (handled) {
            return;
          }
        } else if (verbose) {
          this.log(
            `chunk skip ${relativePath(uri)} est ${Math.round(gain.serialMs)}ms → ` +
              `${Math.round(gain.parallelMs)}ms chunks=${gain.chunkCount} (not worth it)`,
          );
        }
      }

      scanned += 1;
      scannedBytes += size;

      // 大文件走流式：整块读入会让内存直接顶到文件大小
      if (size > streamAbove) {
        const budget = Math.max(1, Math.min(perFileLimit + 1, globalLimit - hits.length + 1));
        const streamed = await streamSearchFile(uri, core, handle, {
          limit: budget,
          maxBytes,
          token,
          onProgress: (state) => {
            const now = Date.now();
            if (now - lastProgressAt < 250) {
              return;
            }
            lastProgressAt = now;
            progress.report({
              message: t('{file} · {size} · {n} 处', {
                file: basename(uri),
                size: formatSize(state.bytesRead),
                n: state.hits,
              }),
            });
          },
        });

        // 虚拟 / 远程文件系统打不开本地路径：退回整块读，见下面的 wholeCap
        if (streamed.kind !== 'unsupported') {
          if (streamed.kind === 'binary') {
            skippedBinary += 1;
            return;
          }
          if (streamed.kind === 'tooLarge') {
            skippedLarge += 1;
            if (skippedLargeFiles.length < 20) {
              skippedLargeFiles.push({ name: relativePath(uri), size });
            }
            return;
          }
          if (streamed.kind === 'error') {
            failed += 1;
            this.log(`stream failed ${relativePath(uri)}: ${streamed.message ?? ''}`);
            return;
          }

          this.log(
            `stream ${relativePath(uri)} ${formatSize(streamed.bytesRead)} lines=${streamed.lines} ` +
              `hits=${streamed.hits.length} enc=${streamed.encoding}${streamed.truncated ? ' (capped)' : ''}`,
          );

          if (streamed.hits.length > 0) {
            const fileTruncated = streamed.truncated || streamed.hits.length > perFileLimit;
            const items: ResultItem[] = [];
            for (const hit of streamed.hits.slice(0, perFileLimit)) {
              if (hits.length >= globalLimit) {
                capped = true;
                break;
              }
              const id = hits.length;
              hits.push({
                uri,
                range: new vscode.Range(hit.line, hit.column, hit.endLine, hit.endColumn),
              });
              items.push({
                id,
                line: hit.line + 1,
                column: hit.column + 1,
                preview: hit.preview,
                prefix: hit.prefix,
                matchLen: hit.matchLen,
              });
            }
            if (items.length > 0) {
              addGroup(
                {
                  label: basename(uri),
                  detail: relativePath(uri),
                  path: uri,
                  items,
                  truncated: fileTruncated,
                },
                uri,
              );
            }
          }
          if (streamed.kind === 'cancelled') {
            capped = true;
          }
          return;
        }
      }

      // 整块读（字节直传）：文件本来就是 UTF-8 字节，过去要「字节→字符串→
      // 内核里再编码回字节」绕一圈，还额外做一次偏移映射用的全量编码。
      // 现在字节直接进内核，行号/列/预览只对有命中的文件按行惰性解码。
      const wholeCap = Math.min(maxBytes, MAX_WHOLE_READ);
      let read;
      try {
        read = await readFileBytes(uri, wholeCap, size);
      } catch {
        failed += 1;
        return;
      }
      if (read.kind === 'binary') {
        skippedBinary += 1;
        return;
      }
      if (read.kind === 'tooLarge') {
        skippedLarge += 1;
        if (skippedLargeFiles.length < 20) {
          skippedLargeFiles.push({ name: relativePath(uri), size: read.size });
        }
        if (verbose) {
          this.log(
            `skip ${relativePath(uri)} size=${formatSize(read.size)} > limit=${formatSize(wholeCap)}`,
          );
        }
        return;
      }

      let matches;
      try {
        const budget = Math.min(perFileLimit + 1, globalLimit - hits.length + 1);
        matches = findMatchesBytes(core, handle, read.bytes, Math.max(1, budget));
      } catch (error) {
        aborted = true;
        throw error;
      }
      if (matches.length === 0) {
        return;
      }

      // 单文件上限：保证一个超大文件不会把全局额度吃光，后续文件仍能出现
      const fileTruncated = matches.length > perFileLimit;
      const kept = fileTruncated ? matches.slice(0, perFileLimit) : matches;

      // 命中文件才建字节行起点表（内核按字节扫 0x0A/0x0D）；无命中的文件（绝大多数）不碰解码
      const lineStarts = buildLineStartsBytes(core, read.bytes);
      const items: ResultItem[] = [];
      for (const match of kept) {
        if (hits.length >= globalLimit) {
          capped = true;
          break;
        }
        const pos = positionAt(lineStarts, match.start);
        const end = positionAt(lineStarts, match.start + match.len);
        const lineFrom = lineStarts[pos.line];
        const lineTo =
          pos.line + 1 < lineStarts.length ? lineStarts[pos.line + 1] : read.bytes.length;
        const lineText = decodeSlice(read.bytes, lineFrom, lineTo).replace(/\r?\n$/, '');
        // match.start 是 UTF-8 字节偏移；列与长度按 UTF-16 码元换算，
        // 与 vscode.Range / 旧字符串路径的语义一致
        const column = decodeSlice(read.bytes, lineFrom, match.start).length;
        const matchLen = Math.max(
          1,
          decodeSlice(read.bytes, match.start, match.start + match.len).length,
        );
        const endColumn =
          end.line === pos.line
            ? column + matchLen
            : decodeSlice(read.bytes, lineStarts[end.line], match.start + match.len).length;
        const range = new vscode.Range(pos.line, column, end.line, endColumn);
        const id = hits.length;
        hits.push({ uri, range });
        items.push(makeItem(id, lineText, pos.line, column, matchLen));
      }
      if (items.length === 0) {
        return;
      }
      addGroup(
        {
          label: basename(uri),
          detail: relativePath(uri),
          path: uri,
          items,
          truncated: fileTruncated,
        },
        uri,
      );
      if (verbose) {
        this.log(`hit ${relativePath(uri)} items=${items.length}${fileTruncated ? ' (capped)' : ''}`);
      }
    };

    // 取消与进度都收进面板自身：进度写状态行（「正在列出文件…」同一行），
    // 取消走状态行上的「停止」按钮，不再弹右下角系统通知。
    const cancellation = new vscode.CancellationTokenSource();
    this.searchCancellation = cancellation;
    const token = cancellation.token;
    /** processFile / 流式 onProgress 里的 progress.report 直接落到状态行 */
    const progress: vscode.Progress<{ message?: string; increment?: number }> = {
      report: (value) => {
        if (value.message) {
          this.panel?.setBusy(true, value.message);
        }
      },
    };

    try {
      let done = 0;
      let useLegacy = true;

      // ---- 单场池子：全部文件直接扫描（0.1.111 起移除每文件结果缓存：
      // stat 校验/回放/补扫三段流程的复杂度与 ext host 堆占用不再值得，
      // 大工作区重扫一次的代价由 worker 池摊薄） ----
      if (poolReady) {
        const outcome = await runWorkerSearch({
          wasmPath: this.paths!.wasmPath!,
          workerScript: this.paths!.workerPath!,
          workerCount,
          files: [],
          source: walkSource(),
          options: this.options(state),
          perFileLimit,
          maxBytes,
          streamAbove,
          chunk: chunkPolicy,
          shouldAbort: () => token.isCancellationRequested,
          onBatch: (results) => {
            if (results.length > 0) {
              const completed = applyBatch(results);
              done += completed;
              progress.report({
                message: t('{s}/{f} · {n} 处', { s: done, f: files.length, n: hits.length }),
              });
            }
          },
        });
        if (outcome.kind === 'ok') {
          useLegacy = false;
          const summary = lastPoolRunSummary();
          if (summary) {
            this.log(poolSummaryLine(summary));
          }
          if (token.isCancellationRequested || hits.length >= globalLimit) {
            capped = true;
          }
        } else if (outcome.kind === 'failed') {
          aborted = true;
          throw new Error(outcome.error);
        } else {
          this.log(`worker pool unavailable (${outcome.error}), falling back to in-host scan`);
        }
      }

      // 主场收工时还没跑到的块（worker 直到队列排空才回报 plan）：补一场并发跑掉
      if (!useLegacy && chunkFiles.size > 0) {
        await drainPendingChunks(token);
      }

      if (useLegacy) {
        /**
         * 受限并发：多个文件的 stat/read 互相重叠；内核匹配是同步的，天然串行。
         * 流式版：N 个消费协程共享同一个遍历生成器（async generator 的 next()
         * 自动排队取号），枚举与扫描全程重叠，不攒清单。
         */
        const iterator = createWalkStream(include, exclude, undefined, this.walkOpts());
        let exhausted = false;
        const worker = async (): Promise<void> => {
          while (
            !aborted &&
            !token.isCancellationRequested &&
            hits.length < globalLimit &&
            !exhausted
          ) {
            const r = await iterator.next();
            if (r.done) {
              exhausted = true;
              walkStats = r.value;
              return;
            }
            const index = files.push(r.value) - 1;
            try {
              await processFile(r.value, index, progress, token);
            } catch (error) {
              aborted = true;
              exhausted = true;
              throw error;
            }
            done += 1;
            // 每个文件扫完就推一帧（节流由 flush 自己控制）
            flush(false);
            if (done % 20 === 0) {
              progress.report({
                message: t('{s}/{f} · {n} 处', { s: done, f: files.length, n: hits.length }),
              });
            }
          }
        };
        try {
          await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, () => worker()));
        } finally {
          if (!exhausted) {
            // 提前收场（取消 / 达上限 / 出错）：让遍历器同步收尾
            void iterator.return?.(undefined as unknown as WalkStats);
          }
        }
        if (token.isCancellationRequested || hits.length >= globalLimit) {
          capped = true;
        }
      }

      // 清单与扫描已合并为一条流水线：清单统计在跑完后落账（found/kept 是
      // 整场累计）。via 区分走的路径，慢的时候一眼定位。
      const found = walkStats?.found ?? files.length;
      this.log(
        `file list in ${Date.now() - listedAt}ms (streamed) ` +
          `include=${include} exclude=${exclude} roots=${searchFolders.length} ` +
          `via=${walkStats?.via ?? '?'} found=${found} kept=${files.length} filtered=${walkStats?.filtered ?? 0} ` +
          `skippedDirs=${walkStats?.skippedDirs ?? 0} failedDirs=${walkStats?.failedDirs ?? 0}`,
      );
      if (verbose) {
        for (const p of files.slice(0, 200)) {
          this.log(`  file ${relativePath(p)}`);
        }
      }
      this.log(
        `scan in ${Date.now() - started}ms ` +
          `via ${useLegacy ? `legacy in-host (${SCAN_CONCURRENCY} concurrency)` : `pool(${workerCount}w)`}: ` +
          `${scanned}/${files.length} files, ${hits.length} hits, skipped=${skippedBinary + skippedLarge + failed}`,
      );
      if (files.length === 0) {
        // 空树 / 全被过滤：正常收尾流程照走，状态行给出针对性的提示
        this.panel?.setStatus(
          found === 0
            ? t('工作区里没有遍历到任何文件，请确认已打开文件夹')
            : t('遍历到 {n} 个文件，但都被过滤器排除了（过滤器：{g}）', { n: found, g: include }),
          'warn',
        );
      }
    } catch (error) {
      aborted = true;
      this.fail(error);
    } finally {
      this.searchCancellation = undefined;
      cancellation.dispose();
      this.panel?.setBusy(false);
    }
    if (aborted) {
      // 出错也要把卡片收尾：留着「搜索中」的转圈最容易让人以为任务还活着。
      // 已经扫到的结果照常留在卡片上，错误由状态行说明。
      settle();
      return;
    }

    // 分组按「扫完的先后」排列，不再收尾时按路径重排：
    // 结果已经边搜边插进面板了，重排会让列表在最后一刻整体跳一下，
    // 还会打乱用户此刻正在看的文件位置。hits 的下标也是在追加时按同样
    // 顺序分配的，所以展示顺序 / 导航顺序天然一致，不需要再重编 id。
    const elapsed = Date.now() - started;
    settle();

    const skippedNote =
      skippedBinary + skippedLarge + failed > 0
        ? t(' · 跳过 {n} 个文件', { n: skippedBinary + skippedLarge + failed })
        : '';
    const cappedNote = capped ? t(' · 已达上限，未扫完 {n} 个文件', { n: files.length - scanned }) : '';
    this.log(
      `done hits=${hits.length} files=${groups.length} scanned=${scanned}/${files.length} ` +
        `binary=${skippedBinary} large=${skippedLarge} failed=${failed} capped=${capped} ${elapsed}ms`,
    );
    // 命中摘要（处数 / 文件数 / 用时）已在记录折叠条上，成功时不重复显示；
    // 但「跳过了文件」「达到上限」仍要提示——折叠条上看不出这些
    if (files.length > 0) {
      this.panel?.setStatus(
        hits.length === 0
          ? t('在 {n} 个文件中未找到匹配 · {ms} ms', { n: scanned, ms: elapsed }) + skippedNote
          : (skippedNote + cappedNote).replace(/^ · /, ''),
        hits.length === 0 ? 'warn' : 'info',
      );
    }
  }

  /**
   * 展示顺序（也就是「上一个/下一个」的走查顺序）下的命中下标序列。
   * hits 是「追加即定 id」的存储（id 稳定，不随插入位置变化），分组则按路径
   * 插入了；两者顺序不一致，所以导航必须按分组顺序铺开，否则会按文件乱跳。
   * O(命中数)，只在导航时算一次。
   */
  private orderedHitIds(record: SearchRecord): number[] {
    const order: number[] = [];
    for (const group of record.groups) {
      for (const item of group.items) {
        // 恢复出来的记录里，文件 uri 缺失的分组可能没有对应 hit——跳过，
        // 否则导航会拿到 undefined 的 uri
        if (record.hits[item.id]) {
          order.push(item.id);
        }
      }
    }
    return order;
  }

  private async step(state: PanelState, direction: 1 | -1): Promise<void> {
    let record = this.activeRecord();
    if (!record) {
      // 还没有选中的结果：按导航规则默认取最新的记录（id 最大 = 触发最晚），
      // 而不是再发起一场文档搜索——用户按 上一个/下一个 是想走查已有结果。
      record = this.newestRecord();
      if (record) {
        this.activeRecordId = record.id;
      }
    }
    if (!record || record.hits.length === 0) {
      // 只有在一条结果记录都没有时，才回退到「对当前文档搜一次」的老路；
      // 已有记录只是没命中（或选中的记录为空）时无从导航，直接结束。
      if (this.records.size > 0 || !state.query) {
        return;
      }
      await this.searchDocument(state);
      record = this.activeRecord();
      if (!record || record.hits.length === 0) {
        return;
      }
    }

    const order = this.orderedHitIds(record);
    const count = order.length;
    if (count === 0) {
      return;
    }
    let next: number;
    if (record.current < 0) {
      // 尚未选中过任何条目：下一个从第一条按顺序开始，上一个从最后一条往回
      next = direction === 1 ? 0 : count - 1;
    } else {
      next = record.current + direction;
      if (next < 0) {
        next = state.wrapAround ? count - 1 : 0;
      }
      if (next >= count) {
        next = state.wrapAround ? 0 : count - 1;
      }
    }
    record.current = next;

    const id = order[next];
    const hit = record.hits[id];
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(hit.uri));
    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: true,
    });
    editor.selection = new vscode.Selection(hit.range.start, hit.range.end);
    editor.revealRange(hit.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    const ordered = order.map((index) => record.hits[index]);
    const sameDoc = ordered
      .filter((item) => item.uri.toString() === hit.uri.toString())
      .map((item) => item.range);
    const indexInDoc =
      ordered.slice(0, next + 1).filter((item) => item.uri.toString() === hit.uri.toString()).length - 1;
    this.highlighter.show(editor, sameDoc, indexInDoc);
    // 面板按 id 找行、按位置显示「第 i / n 处」：两者都要给
    this.panel?.postCurrent(record.id, id, next);
    // 位置指示「第 i / n 处」由 webview 显示在结果头（上一个/下一个按钮左边），
    // 不再占用状态行
  }

  private async replaceOne(state: PanelState): Promise<void> {
    let record = this.activeRecord();
    if (!record || record.hits.length === 0) {
      await this.searchDocument(state);
      record = this.activeRecord();
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || !record || record.hits.length === 0) {
      return;
    }

    const cursor = editor.selection.active;
    const doc = editor.document;
    // 按展示顺序挑「光标之后的第一处」，与用户看到的顺序一致
    const idsInFile = this.orderedHitIds(record).filter(
      (id) => record.hits[id]?.uri.toString() === doc.uri.toString(),
    );
    const target =
      idsInFile.find((id) => record.hits[id].range.start.isAfterOrEqual(cursor)) ?? idsInFile[0];
    if (target === undefined) {
      this.panel?.setStatus(t('当前文档没有匹配'), 'warn');
      return;
    }

    const hit = record.hits[target];
    const core = await this.corePromise;
    let handle: number;
    try {
      handle = compileQuery(core, this.options(state));
    } catch (error) {
      this.fail(error);
      return;
    }

    const text = doc.getText();
    const startByte = utf16ToByteOffset(text, doc.offsetAt(hit.range.start));
    const endByte = utf16ToByteOffset(text, doc.offsetAt(hit.range.end));
    const replacement = core.expandAt(handle, text, startByte, endByte, state.replace);

    const ok = await editor.edit((builder) => builder.replace(hit.range, replacement));
    if (ok) {
      // 未保存的编辑不落盘、mtime 不变：结果缓存必须主动失效
      if (doc.uri.scheme === 'file') {
      }
      this.panel?.setStatus(t('已替换 1 处'));
      await this.searchDocument(state, 'refresh');
    }
  }

  /**
   * 「全部替换」：替换当前搜索结果里的全部匹配。
   * 「全部」指激活的那张结果卡片，不区分来源——本文档/工作区的区分
   * 只发生在搜索时（「本文档全部」/「全部」两个搜索入口）：
   * 文档搜索的卡片在本文档内替换，工作区搜索的卡片跨文件替换。
   */
  private async replaceAll(state: PanelState): Promise<void> {
    if (!state.query) {
      this.panel?.setStatus(t('请输入查找内容'), 'warn');
      return;
    }
    const record = this.activeRecord();
    if (!record || record.hits.length === 0) {
      this.panel?.setStatus(t('请先执行搜索，再全部替换'), 'warn');
      return;
    }
    if (record.scope === 'document') {
      await this.replaceInDocument(state);
    } else {
      // 'files' 与历史遗留的 'open' 都是工作区级结果
      await this.replaceAcrossFiles(state, record);
    }
  }

  /** 文档级结果：替换当前活动编辑器里的全部匹配。 */
  private async replaceInDocument(state: PanelState): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const core = await this.corePromise;
    let handle: number;
    try {
      handle = compileQuery(core, this.options(state));
    } catch (error) {
      this.fail(error);
      return;
    }

    const config = vscode.workspace.getConfiguration('flySearch');
    const limit = config.get<number>('maxMatches', 20000);
    const doc = editor.document;
    const text = doc.getText();
    const matches = findMatches(core, handle, text, limit);
    if (matches.length === 0) {
      this.panel?.setStatus(t('没有可替换的匹配'), 'warn');
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      t('确定替换当前文档中的 {n} 处匹配？', { n: matches.length }),
      { modal: true },
      t('全部替换'),
    );
    if (answer !== t('全部替换')) {
      return;
    }

    const next = core.replaceAll(handle, text, state.replace, limit);
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
    const ok = await editor.edit((builder) => builder.replace(full, next));
    if (!ok) {
      this.panel?.setStatus(t('替换失败'), 'error');
      return;
    }
    // 未保存的编辑不落盘、mtime 不变：结果缓存必须主动失效
    if (doc.uri.scheme === 'file') {
    }
    this.panel?.setStatus(t('已替换 {n} 处', { n: matches.length }));
    await this.searchDocument(state, 'refresh');
  }

  /** 工作区级结果：按结果卡片里的文件清单跨文件替换。 */
  private async replaceAcrossFiles(state: PanelState, record: SearchRecord): Promise<void> {
    const uris = [...new Set(record.hits.map((hit) => hit.uri))].map((p) => vscode.Uri.file(p));

    const answer = await vscode.window.showWarningMessage(
      t('将在 {f} 个文件中替换 {n} 处匹配，是否继续？', {
        f: uris.length,
        n: record.hits.length,
      }),
      { modal: true },
      t('全部替换'),
    );
    if (answer !== t('全部替换')) {
      return;
    }

    const core = await this.corePromise;
    let handle: number;
    try {
      handle = compileQuery(core, this.options(state));
    } catch (error) {
      this.fail(error);
      return;
    }

    const config = vscode.workspace.getConfiguration('flySearch');
    const limit = config.get<number>('maxMatches', 20000);
    const edit = new vscode.WorkspaceEdit();
    let changed = 0;

    for (const uri of uris) {
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        continue;
      }
      const text = doc.getText();
      const next = core.replaceAll(handle, text, state.replace, limit);
      if (next === text) {
        continue;
      }
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), next);
      changed += 1;
    }

    const applied = await vscode.workspace.applyEdit(edit);
    this.panel?.setStatus(
      applied ? t('已修改 {f} 个文件（尚未保存）', { f: changed }) : t('替换失败'),
      applied ? 'info' : 'error',
    );
  }

  private async markAll(state: PanelState): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    if (!state.query) {
      this.panel?.setStatus(t('请输入查找内容'), 'warn');
      return;
    }

    const core = await this.corePromise;
    let handle: number;
    try {
      handle = compileQuery(core, this.options(state));
    } catch (error) {
      this.fail(error);
      return;
    }

    const limit = vscode.workspace.getConfiguration('flySearch').get<number>('maxMatches', 20000);
    const doc = editor.document;
    const text = doc.getText();
    const matches = findMatches(core, handle, text, limit);
    const ranges = matches.map(
      (match) =>
        new vscode.Range(doc.positionAt(match.start), doc.positionAt(match.start + match.len)),
    );

    this.markedByUri.set(doc.uri.toString(), ranges);
    this.highlighter.setMarks(doc.uri, ranges);
    this.panel?.setStatus(t('已标记 {n} 处', { n: ranges.length }));
  }

  private clearMarks(): void {
    this.markedByUri.clear();
    this.highlighter.clearMarks();
  }

  /**
   * 排障用：把「工作区根目录 / 过滤器 / 枚举到的文件」原样写进输出面板。
   * 跨文件搜索出问题时，这一段能立刻区分是“没枚举到文件”还是“枚举到了但没命中”。
   */
  async selfCheck(): Promise<void> {
    const config = vscode.workspace.getConfiguration('flySearch');
    const include = config.get<string>('includeGlob', '**/*');
    const exclude = config.get<string>('excludeGlob', '');
    const folders = vscode.workspace.workspaceFolders ?? [];

    this.log('===== 自检 =====');
    this.log(`roots=${folders.length} ${folders.map((folder) => folder.uri.fsPath).join(' | ')}`);
    this.log(`include=${include} exclude=${exclude}`);

    if (folders.length === 0) {
      this.panel?.setStatus(t('自检：当前窗口没有打开工作区文件夹'), 'warn');
      this.output?.show(true);
      return;
    }

    try {
      const paths: string[] = [];
      const it = createWalkStream(include, exclude, undefined, this.walkOpts());
      let r = await it.next();
      while (!r.done) {
        paths.push(r.value);
        if (paths.length <= 50) {
          this.log(`  file ${relativePath(r.value)}`);
        }
        r = await it.next();
      }
      this.log(
        `via=${r.value.via} found=${r.value.found} kept=${paths.length} filtered=${r.value.filtered} ` +
          `skippedDirs=${r.value.skippedDirs} failedDirs=${r.value.failedDirs}`,
      );
      this.panel?.setStatus(
        t('自检：遍历 {found} 个，保留 {kept} 个（来源 {via}，详见输出面板）', {
          found: r.value.found,
          kept: paths.length,
          via: r.value.via,
        }),
        paths.length > 1 ? 'info' : 'warn',
      );
    } catch (error) {
      this.fail(error);
    }
    this.output?.show(true);
  }

  private activeRecord(): SearchRecord | undefined {
    return this.records.get(this.activeRecordId);
  }

  /** 最新的结果记录：id 在搜索触发时分配（单调递增），取 id 最大者。 */
  private newestRecord(): SearchRecord | undefined {
    let newest: SearchRecord | undefined;
    for (const record of this.records.values()) {
      if (!newest || record.id > newest.id) {
        newest = record;
      }
    }
    return newest;
  }

  private commit(record: SearchRecord, replaceExisting = false): void {
    this.records.set(record.id, record);
    this.activeRecordId = record.id;
    this.panel?.upsertRecord(this.toHistory(record), replaceExisting);
    this.persistHistory();
  }

  /**
   * 流式搜索的起点：卡片立刻进面板（正文为空、带「搜索中」），
   * 后面每个文件扫完由 appendRecord 往这张卡片里追加分组。
   * 这里不持久化——进行中的结果不该被当成完整结果写进工作区存储。
   */
  private beginRecord(record: SearchRecord): void {
    this.records.set(record.id, record);
    this.activeRecordId = record.id;
    this.panel?.upsertRecord(this.toHistory(record));
    this.log(`record #${record.id} opened (pending) query=${record.query}`);
  }

  private toHistory(record: SearchRecord): HistoryRecord {
    return {
      id: record.id,
      query: record.query,
      scope: record.scope,
      scopeLabel: record.scopeLabel,
      optionsLabel: record.optionsLabel,
      // 数组在这里复制一份：面板那份要独立追加分组，不能和搜索里的 groups 共用
      // 同一个数组（否则 appendRecord 会把同一批分组重复塞进去）
      groups: record.groups.slice(),
      total: record.hits.length,
      fileCount: record.groups.length,
      elapsed: record.elapsed,
      truncated: record.truncated,
      time: record.time,
      totalBytes: record.totalBytes,
      pending: record.pending,
      exactAvailable: Boolean(record.input),
    };
  }

  private optionsLabel(state: PanelState): string {
    const parts = [
      t(state.mode === 'regex' ? '正则' : state.mode === 'extended' ? '扩展' : '普通'),
    ];
    if (state.caseSensitive) {
      parts.push(t('区分大小写'));
    }
    if (state.wholeWord) {
      parts.push(t('全字匹配'));
    }
    if (state.dotAll) {
      parts.push(t('.匹配换行'));
    }
    if (state.inSelection) {
      parts.push(t('选区内'));
    }
    return parts.join(' · ');
  }

  private async requireState(): Promise<PanelState | undefined> {
    const state = this.panel?.currentState ?? this.defaultState();
    if (!state.query) {
      await this.open('find');
      this.panel?.setStatus(t('请先输入查找内容'), 'warn');
      return undefined;
    }
    return state;
  }

  private options(state: PanelState): SearchOptions {
    const config = vscode.workspace.getConfiguration('flySearch');
    return {
      query: state.query,
      mode: state.mode,
      caseSensitive: state.caseSensitive,
      wholeWord: state.wholeWord,
      dotAll: state.dotAll,
      backtrackLimit: Math.max(1000, config.get<number>('backtrackLimit', 1000000)),
    };
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.panel?.setBusy(false);
    this.panel?.setStatus(message, 'error');
  }

  dispose(): void {
    this.clearMarks();
  }
}

/** 路径的最后一段（兼容 \ 与 / 分隔）。 */
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 把 fsPath 换算成工作区相对路径（多根时取最长匹配前缀），仅用于日志。 */
function relativePath(fsPath: string): string {
  const norm = fsPath.replace(/\\/g, '/');
  let best = '';
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const base = folder.uri.fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (norm.startsWith(`${base}/`) && base.length > best.length) {
      best = base;
    }
  }
  return best ? norm.slice(best.length + 1) : norm;
}

/** 把字节数写成人类可读的形式，卡片与日志都用它，避免出现 52428800 这种数字。 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

/** 缓存形态 → 池子结果形态（回放时补上 index 与读前 stat） */

/**
 * 池子场次汇总 → 诊断日志行。
 *
 * 回答「大工作区慢在哪」：
 * - `util`（平均每 worker 忙时 ÷ 墙钟）低 → worker 在等派发，瓶颈在调度侧；
 * - `util` 高 → worker 满负荷，看 read 与墙钟的比例判断是不是 IO 慢；
 * - `slow:` 是最慢的 5 个条目（worker 侧逐文件计时），长尾一眼可见；
 * - kind 计数能看出大文件走了流式还是分块、二进制/超大文件跳过了多少。
 */
/** 自动档 worker 数：CPU 核数 - 2（给宿主/系统留余量），夹 2~16。 */
function autoWorkerCount(): number {
  const cpus = os.cpus().length;
  return Math.min(16, Math.max(2, cpus - 2));
}

function poolSummaryLine(summary: PoolRunSummary): string {
  const util =
    summary.wallMs > 0 ? Math.round(((summary.busyMs / summary.workers) / summary.wallMs) * 100) : 0;
  const kindOrder = ['hit', 'miss', 'binary', 'tooLarge', 'plan', 'chunk', 'chunkUnsupported', 'error', 'count'];
  const kinds = kindOrder
    .filter((k) => summary.kinds[k])
    .map((k) => `${k}=${summary.kinds[k]}`)
    .join(' ');
  const slow = summary.slowest
    .map((s) => {
      const short = s.path.split(/[\\/]/).slice(-2).join('/');
      return `${short} ${Math.round(s.ms)}ms/${formatSize(s.bytes)}(${s.kind})`;
    })
    .join(', ');
  return (
    `pool stats: wall=${summary.wallMs}ms avgBusy=${Math.round(summary.busyMs / Math.max(1, summary.workers))}ms ` +
    `util=${util}% (${summary.workers}w) assign=${summary.assignCalls} dispatched=${summary.dispatched}/${summary.queued} | ` +
    `${kinds} | read=${formatSize(summary.readBytes)} bin=${formatSize(summary.binaryBytes)} large=${formatSize(summary.largeBytes)}` +
    (slow ? ` | slow: ${slow}` : '')
  );
}

