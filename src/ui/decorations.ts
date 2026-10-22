import * as vscode from 'vscode';

/**
 * Editor decorations for search hits and for the mark-all feature.
 * Colors come from the active theme's find-match tokens so light and dark
 * themes both look native.
 */
export class Highlighter implements vscode.Disposable {
  private readonly allMatches = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    borderRadius: '2px',
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });

  private readonly currentMatch = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchBackground'),
    border: '1px solid',
    borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
    borderRadius: '2px',
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });

  private readonly markDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
    borderRadius: '2px',
  });

  private marked = new Map<string, vscode.Range[]>();

  show(editor: vscode.TextEditor, ranges: vscode.Range[], currentIndex: number): void {
    editor.setDecorations(this.allMatches, ranges);
    if (currentIndex >= 0 && currentIndex < ranges.length) {
      editor.setDecorations(this.currentMatch, [ranges[currentIndex]]);
    } else {
      editor.setDecorations(this.currentMatch, []);
    }
  }

  clearMatches(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.allMatches, []);
      editor.setDecorations(this.currentMatch, []);
    }
  }

  setMarks(uri: vscode.Uri, ranges: vscode.Range[]): void {
    this.marked.set(uri.toString(), ranges);
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === uri.toString(),
    );
    if (editor) {
      editor.setDecorations(this.markDeco, ranges);
    }
  }

  applyMarksToVisibleEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const ranges = this.marked.get(editor.document.uri.toString()) ?? [];
      editor.setDecorations(this.markDeco, ranges);
    }
  }

  clearMarks(uri?: vscode.Uri): void {
    if (uri) {
      this.marked.delete(uri.toString());
    } else {
      this.marked.clear();
    }
    this.applyMarksToVisibleEditors();
  }

  dispose(): void {
    this.allMatches.dispose();
    this.currentMatch.dispose();
    this.markDeco.dispose();
  }
}
