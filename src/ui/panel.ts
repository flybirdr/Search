import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { SearchMode } from '../engine/wasm';
import { htmlLang, t, webviewDictionary } from '../i18n';
import { panelHtml } from './html';
import {
  INPUT_HISTORY_KEY,
  InputHistory,
  normalizeInputHistory,
  pushInput,
} from '../search/inputHistory';

export interface PanelState {
  query: string;
  replace: string;
  mode: SearchMode;
  caseSensitive: boolean;
  wholeWord: boolean;
  dotAll: boolean;
  wrapAround: boolean;
  inSelection: boolean;
  direction: 'down' | 'up';
  advanced: boolean;
  filters: string;
}

export interface ResultItem {
  id: number;
  line: number;
  column: number;
  preview: string;
  prefix: number;
  matchLen: number;
}

export interface ResultGroup {
  label: string;
  detail: string;
  items: ResultItem[];
  /** 该文件的匹配数超过了单文件上限，只保留了前若干条。 */
  truncated?: boolean;
}

export type SearchScope = 'document' | 'open' | 'files';

/** 一条搜索结果记录：对应面板里一张可折叠的卡片。 */
export interface HistoryRecord {
  id: number;
  query: string;
  scope: SearchScope;
  scopeLabel: string;
  optionsLabel: string;
  groups: ResultGroup[];
  total: number;
  fileCount: number;
  elapsed: number;
  truncated: boolean;
  time: number;
  /** 实际扫描过的文件总字节数，折叠条上显示「总大小」；未知时不显示。 */
  totalBytes?: number;
  /** 该记录自身的搜索是否仍在进行中。 */
  pending?: boolean;
  /**
   * 这张卡片能不能「统计完整数量」：只有本会话内发起、还留着原始输入条件的
   * 记录才行。重载窗口后从历史恢复的卡片没有查询条件，按钮不显示。
   */
  exactAvailable?: boolean;
}

export interface PanelHandlers {
  onAction(action: string, state: PanelState): void | Promise<void>;
  onReveal(recordId: number, id: number): void;
  onRemoveRecord(recordId: number): void;
  /** 用户点了卡片上的「统计完整数量」 */
  onExactCount(recordId: number): void;
  onReady(): void;
}

/** 面板用到的存储：搜索条件跟工作区走。 */
export interface PanelStores {
  state?: vscode.Memento;
}

export const STATE_KEY = 'flySearch.panelState';

export const MAX_RECORDS = 12;

export class PanelView implements vscode.WebviewViewProvider {
  public static readonly viewType = 'flySearch.panel';

  private view?: vscode.WebviewView;
  private state: PanelState;
  private records: HistoryRecord[] = [];
  private pendingFocus?: 'query' | 'replace';
  /** 记录版本号；前端手里的版本落后时才需要整表重推。 */
  private recordsVersion = 0;
  /** 首屏 HTML 里嵌入的那份记录对应的版本。 */
  private bootstrapVersion = -1;
  /** 前端当前已持有的版本：首屏渲染或后续推送后同步。 */
  private deliveredVersion = -1;
  private saveTimer?: ReturnType<typeof setTimeout>;
  /** 三个输入框的关键词时间线（搜索词 / 过滤器 / 替换词） */
  private inputHistory: InputHistory;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: PanelHandlers,
    defaults: PanelState,
    private readonly version = '0.0.0',
    private readonly stores: PanelStores = {},
  ) {
    this.state = mergeState(defaults, stores.state?.get<Partial<PanelState>>(STATE_KEY));
    this.inputHistory = normalizeInputHistory(stores.state?.get(INPUT_HISTORY_KEY));
  }

  get currentState(): PanelState {
    return this.state;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.render(view.webview);

    view.webview.onDidReceiveMessage(
      (message: {
        type: string;
        action?: string;
        state?: PanelState;
        id?: number;
        recordId?: number;
      }) => {
        switch (message.type) {
          case 'ready':
            this.post({ type: 'state', state: this.state });
            // 前端刚重载，手里只剩首屏 HTML 里那份记录
            this.deliveredVersion = this.bootstrapVersion;
            this.postHistory();
            this.postInputHistory();
            if (this.pendingFocus) {
              this.post({ type: 'focus', target: this.pendingFocus });
              this.pendingFocus = undefined;
            }
            this.handlers.onReady();
            break;
          case 'action':
            if (message.state) {
              this.state = message.state;
              this.scheduleSaveState();
              this.rememberInputs(message.action ?? '');
            }
            void this.handlers.onAction(message.action ?? '', this.state);
            break;
          case 'reveal':
            if (typeof message.recordId === 'number' && typeof message.id === 'number') {
              this.handlers.onReveal(message.recordId, message.id);
            }
            break;
          case 'removeRecord':
            if (typeof message.recordId === 'number') {
              this.handlers.onRemoveRecord(message.recordId);
            }
            break;
          case 'requestExactCount':
            if (typeof message.recordId === 'number') {
              this.handlers.onExactCount(message.recordId);
            }
            break;
          case 'state':
            if (message.state) {
              this.state = message.state;
              this.scheduleSaveState();
            }
            break;
          default:
            break;
        }
      },
    );

    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.post({ type: 'state', state: this.state });
        this.postHistory();
      }
    });
  }

  async reveal(mode: 'find' | 'replace'): Promise<void> {
    this.state = { ...this.state, advanced: mode === 'replace' ? true : this.state.advanced };
    await vscode.commands.executeCommand('flySearch.panel.focus');
    if (this.view) {
      this.view.show?.(true);
    }
    this.post({ type: 'state', state: this.state });
    this.post({ type: 'focus', target: mode === 'replace' ? 'replace' : 'query' });
    this.pendingFocus = mode === 'replace' ? 'replace' : 'query';
  }

  patchState(patch: Partial<PanelState>): void {
    this.state = { ...this.state, ...patch };
    this.scheduleSaveState();
  }

  /** 输入过程中会频繁触发，压一下再写，别每次都动 workspaceState。 */
  private scheduleSaveState(): void {
    if (!this.stores.state) {
      return;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      try {
        void Promise.resolve(this.stores.state?.update(STATE_KEY, this.state)).catch(() => undefined);
      } catch {
        // 存储不可用时静默降级
      }
    }, 300);
  }

  postState(): void {
    this.post({ type: 'state', state: this.state });
  }

  /**
   * 记录输入框历史。只在**真正发起搜索/替换**时记，不在打字时记——
   * 否则敲到一半的「conso」也会进历史，方向键翻起来全是残词。
   *
   * 搜索类动作记 query + filters（filters 参与搜索，同样值得回翻）；
   * 替换类动作额外记 replace。
   */
  private rememberInputs(action: string): void {
    const isSearch = action === 'search' || action === 'findAllDoc' || action === 'findInFiles';
    const isReplace = action === 'replaceOne' || action === 'replaceAll';
    if (!isSearch && !isReplace) {
      return;
    }
    let changed = pushInput(this.inputHistory, 'query', this.state.query);
    changed = pushInput(this.inputHistory, 'filters', this.state.filters) || changed;
    if (isReplace) {
      changed = pushInput(this.inputHistory, 'replace', this.state.replace) || changed;
    }
    if (!changed) {
      return;
    }
    try {
      void Promise.resolve(this.stores.state?.update(INPUT_HISTORY_KEY, this.inputHistory)).catch(
        () => undefined,
      );
    } catch {
      // 存储不可用：历史只在本次会话内有效
    }
    this.postInputHistory();
  }

  /** 把三个输入框的历史推给前端（方向键用它翻词）。 */
  private postInputHistory(): void {
    this.post({ type: 'inputHistory', history: this.inputHistory });
  }

  /** 新增或覆盖一条结果记录；新记录排在最前并自动展开。 */
  upsertRecord(record: HistoryRecord, replaceExisting = false): void {
    /** 按「触发时间」排序插入：id 在搜索触发时分配（单调递增），
     *  插到第一个更小 id 之前，保持数组严格按 id 降序（最新触发的在最上）。
     *  不能无条件 unshift——先触发的慢搜索完成得晚，会把后触发的快搜索压下去。 */
    const insertSorted = (item: HistoryRecord): void => {
      const at = this.records.findIndex((existing) => existing.id < item.id);
      if (at < 0) {
        this.records.push(item);
      } else {
        this.records.splice(at, 0, item);
      }
    };
    if (replaceExisting) {
      const index = this.records.findIndex((item) => item.id === record.id);
      if (index >= 0) {
        this.records[index] = record;
      } else {
        insertSorted(record);
      }
    } else {
      this.records = this.records.filter((item) => item.id !== record.id);
      insertSorted(record);
      if (this.records.length > MAX_RECORDS) {
        this.records.length = MAX_RECORDS;
      }
    }
    this.post({ type: 'record', record, replace: replaceExisting });
    this.recordsVersion += 1;
    this.deliveredVersion = this.recordsVersion;
  }

  /**
   * 流式追加：搜索每扫完一个文件就把它的分组推到面板，只发新增的那几条。
   * `inserts[k]` 是 `groups[k]` 在整条记录里的最终下标（升序），面板按它
   * 把分组插到正确位置——结果按路径排，后到的文件可能排在前面。
   */
  appendRecord(
    recordId: number,
    groups: ResultGroup[],
    stats: {
      total: number;
      fileCount: number;
      elapsed: number;
      totalBytes?: number;
      truncated: boolean;
      pending: boolean;
    },
    inserts: number[] = [],
  ): void {
    const item = this.records.find((entry) => entry.id === recordId);
    if (!item) {
      // 记录已被用户删掉（或早被 MAX_RECORDS 挤掉）：静默丢弃增量
      return;
    }
    if (groups.length > 0) {
      // 用下标插进面板这份数组，保持与搜索侧同一顺序（不能 push：排在前面
      // 的文件可能后到）；concat/push 之外的写法都要防越界。
      for (let index = 0; index < groups.length; index += 1) {
        const at = Math.min(Math.max(inserts[index] ?? item.groups.length, 0), item.groups.length);
        item.groups.splice(at, 0, groups[index]);
      }
    }
    item.total = stats.total;
    item.fileCount = stats.fileCount;
    item.elapsed = stats.elapsed;
    item.truncated = stats.truncated;
    item.pending = stats.pending;
    if (typeof stats.totalBytes === 'number') {
      item.totalBytes = stats.totalBytes;
    }
    this.recordsVersion += 1;
    this.deliveredVersion = this.recordsVersion;
    this.post({ type: 'recordGroups', recordId, groups, inserts, ...stats });
  }

  /** 搜索结束：落最终统计并摘掉「搜索中」；正文不重建，避免打断用户翻看。 */
  finishRecord(record: HistoryRecord): void {
    const index = this.records.findIndex((item) => item.id === record.id);
    if (index < 0) {
      return;
    }
    this.records[index] = record;
    this.recordsVersion += 1;
    this.deliveredVersion = this.recordsVersion;
    this.post({ type: 'recordDone', record });
  }

  /** 用工作区里存下来的记录铺满面板；视图还没加载时先记着，等 ready 一起发。 */
  restoreRecords(records: HistoryRecord[]): void {
    this.records = records.slice(0, MAX_RECORDS);
    this.recordsVersion += 1;
    if (this.view) {
      this.post({ type: 'history', records: this.records });
      this.deliveredVersion = this.recordsVersion;
    }
  }

  /** 把「真实命中总数」回传给面板（只更新那一行提示，不重绘结果）。
   *  cancelled = 用户中途 Stop：面板只恢复「统计完整数量」按钮，不改总数。 */
  postExactCount(
    recordId: number,
    payload: {
      total?: number;
      approximate?: boolean;
      files?: number;
      skipped?: number;
      ms?: number;
      cancelled?: boolean;
    },
  ): void {
    this.post({ type: 'exactCount', recordId, ...payload });
  }

  removeRecord(recordId: number): void {
    const index = this.records.findIndex((item) => item.id === recordId);
    if (index < 0) {
      return;
    }
    this.records.splice(index, 1);
    this.recordsVersion += 1;
    this.post({ type: 'removeRecord', recordId });
    this.deliveredVersion = this.recordsVersion;
  }

  clearRecords(): void {
    this.records = [];
    this.recordsVersion += 1;
    this.post({ type: 'clearRecords' });
    this.deliveredVersion = this.recordsVersion;
  }

  /** 前端手里的版本已经是最新的就不重复推，省一次全量重绘。 */
  private postHistory(): void {
    if (this.deliveredVersion === this.recordsVersion) {
      return;
    }
    this.post({ type: 'history', records: this.records });
    this.deliveredVersion = this.recordsVersion;
  }

  setStatus(text: string, tone: 'info' | 'warn' | 'error' = 'info'): void {
    this.post({ type: 'status', text, tone });
  }

  setBusy(busy: boolean, text = t('搜索中…')): void {
    this.post({ type: 'busy', busy, text });
  }

  /**
   * 告诉面板「当前走查到第几条」：`id` 用来定位行（命中 id，稳定），
   * `index` 用来显示「第 i / n 处」（展示顺序里的位置）。
   */
  postCurrent(recordId: number, id: number, index: number): void {
    this.post({ type: 'current', recordId, id, index });
  }

  private post(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }

  private render(webview: vscode.Webview): string {
    const nonce = makeNonce();
    this.bootstrapVersion = this.recordsVersion;
    this.deliveredVersion = this.recordsVersion;
    return panelHtml({
      styleCss: readFileSync(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css').fsPath, 'utf8'),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js')).toString(),
      cspSource: webview.cspSource,
      nonce,
      version: this.version,
      t,
      i18n: webviewDictionary(),
      bootstrap: this.records,
      bootstrapState: this.state,
      lang: htmlLang(),
    });
  }
}

/**
 * 用存下来的条件覆盖默认值，只认已知字段与合法取值。
 * 存的东西可能是旧版本写的、也可能被手改过，不能直接 Object.assign 进 state。
 */
export function mergeState(defaults: PanelState, saved: Partial<PanelState> | undefined): PanelState {
  if (!saved || typeof saved !== 'object') {
    return defaults;
  }
  const text = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback;
  const flag = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;
  return {
    query: text(saved.query, defaults.query),
    replace: text(saved.replace, defaults.replace),
    mode: saved.mode === 'regex' || saved.mode === 'extended' ? saved.mode : 'normal',
    caseSensitive: flag(saved.caseSensitive, defaults.caseSensitive),
    wholeWord: flag(saved.wholeWord, defaults.wholeWord),
    dotAll: flag(saved.dotAll, defaults.dotAll),
    wrapAround: flag(saved.wrapAround, defaults.wrapAround),
    inSelection: flag(saved.inSelection, defaults.inSelection),
    direction: saved.direction === 'up' ? 'up' : 'down',
    advanced: flag(saved.advanced, defaults.advanced),
    filters: text(saved.filters, defaults.filters),
  };
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
