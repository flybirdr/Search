import * as vscode from 'vscode';
import * as path from 'node:path';
import { SearchCore } from './engine/wasm';
import { initI18n, t } from './i18n';
import { SearchController } from './search/controller';
import { Highlighter } from './ui/decorations';
import { PanelView } from './ui/panel';
import { disposeSharedWorkerPool } from './search/workerPool';
import { warmDiskKind } from './search/diskType';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initI18n();
  const wasmUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'core.wasm');
  const corePromise = SearchCore.load(wasmUri.fsPath).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`${t('搜索内核加载失败')} — ${message}`);
    throw error;
  });

  // 磁盘介质探测：预热一次（异步、不阻塞激活）。结果决定超大文件要不要并行
  // 分块——机械盘上并发读是负优化。搜索路径只读缓存，绝不等它。
  warmDiskKind(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);

  const highlighter = new Highlighter();
  const output = vscode.window.createOutputChannel(t('搜索'));
  const controller = new SearchController(corePromise, highlighter, output, context.workspaceState, {
    wasmPath: wasmUri.fsPath,
    workerPath: path.join(context.extensionUri.fsPath, 'dist', 'searchWorker.js'),
    walkWorkerPath: path.join(context.extensionUri.fsPath, 'dist', 'walkWorker.js'),
    storageDir: context.storageUri?.fsPath,
  });

  const provider = new PanelView(
    context.extensionUri,
    {
      onAction: (action, state) => controller.handleAction(action, state),
      onReveal: (recordId, id) => void controller.reveal(recordId, id),
      // 分组标题上的「定位」按钮（悬浮条同款）：资源管理器显示 + 提升优先级
      onLocate: (recordId, label, detail) => void controller.locateGroup(recordId, label, detail),
      onRemoveRecord: (recordId) => controller.removeRecord(recordId),
      onExactCount: (recordId) => void controller.countExact(recordId),
      onReady: () => undefined,
    },
    controller.defaultState(),
    context.extension?.packageJSON?.version ?? '0.0.0',
    { state: context.workspaceState },
  );
  controller.attach(provider);
  // 结果跟着工作区走：重载窗口 / 重启后仍在，直到手动清空
  controller.restoreHistory();

  // 文件名搜索页：只匹配文件名的独立视图，展示 / 交互 / 优先级与内容搜索对齐
  const filesProvider = new PanelView(
    context.extensionUri,
    {
      onAction: (action, state) => controller.handleFilesAction(action, state),
      onRevealFile: (recordId, id) => void controller.revealFile(recordId, id),
      onLocate: (recordId, label, detail) => void controller.locateGroup(recordId, label, detail),
      onRemoveRecord: (recordId) => controller.removeFileRecord(recordId),
      onReady: () => undefined,
    },
    controller.defaultFilesState(),
    context.extension?.packageJSON?.version ?? '0.0.0',
    { state: context.workspaceState },
    { viewType: 'flySearch.files', stateKey: 'flySearch.filesState', page: 'names' },
  );
  controller.attachFiles(filesProvider);
  // 最近一场文件名搜索结果跟着工作区走（重载窗口后恢复）
  controller.restoreFileHistory();

  const register = (id: string, handler: () => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  context.subscriptions.push(
    highlighter,
    controller,
    output,
    vscode.window.registerWebviewViewProvider(provider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(filesProvider.viewType, filesProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => highlighter.applyMarksToVisibleEditors()),
  );

  register('flySearch.openPanel', () => controller.open('find'));
  register('flySearch.openReplace', () => controller.open('replace'));
  register('flySearch.findNext', () => controller.findNext());
  register('flySearch.findPrev', () => controller.findPrev());
  register('flySearch.count', () => controller.countFromCommand());
  register('flySearch.findAllInDocument', () => controller.findAllFromCommand());
  register('flySearch.findAllOpen', () => controller.findAllOpenFromCommand());
  register('flySearch.replaceOne', () => controller.replaceFromCommand());
  register('flySearch.replaceAllInDocument', () => controller.replaceAllFromCommand());
  register('flySearch.markAll', () => controller.markAllFromCommand());
  register('flySearch.clearMarks', () => controller.clearMarksCommand());
  register('flySearch.copyMarked', () => controller.copyMarked());
  register('flySearch.findInFiles', () => controller.findInFilesFromCommand());
  register('flySearch.openFiles', () => void vscode.commands.executeCommand('flySearch.files.focus'));
  register('flySearch.selfCheck', () => controller.selfCheck());
  register('flySearch.showLog', () => output.show());

  await corePromise.catch(() => undefined);
}

export function deactivate(): void {
  // Disposables registered on the extension context handle teardown.
  // 常驻 worker 池：扩展宿主卸载扩展时终止 worker，释放 wasm 实例
  disposeSharedWorkerPool();
}
