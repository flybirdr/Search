/**
 * 生成面板的静态预览页：真实骨架（panelHtml）+ 内联 panel.css + 真实 panel.js
 * （mock 掉 VS Code API），用 Chrome 无头截图就能核对间距、滚动与各种空/满状态。
 *
 * 用法：
 *   node scripts/preview-panel.mjs            空面板
 *   node scripts/preview-panel.mjs --many     塞 20 条记录
 *   node scripts/preview-panel.mjs --many --diag
 *                                             另外打印高度、剩余空间等测量值
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const outDir = new URL('../.workbuddy/preview/', import.meta.url);
mkdirSync(outDir, { recursive: true });

const bundle = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/ui/html.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
  target: 'node18',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const css = readFileSync(new URL('../media/panel.css', import.meta.url), 'utf8');

const many = process.argv.includes('--many');
const diag = process.argv.includes('--diag');

/** 一条记录三个命中，行号错开，便于观察分组与折叠。 */
function record(id) {
  return {
    id,
    query: 'q' + id,
    scope: 'document',
    scopeLabel: '当前文档',
    optionsLabel: '普通',
    groups: [
      {
        label: 'a.ts',
        detail: 'src/a.ts',
        items: [1, 8, 15].map((line, index) => ({
          id: id * 10 + index,
          line,
          column: 3,
          preview: `const q${id} = value_${index} + other;`,
          prefix: 6,
          matchLen: 2,
        })),
      },
    ],
    total: 3,
    fileCount: 1,
    elapsed: 765,
    totalBytes: 44739092,
  };
}

let html = mod.panelHtml({
  styleUri: 'about:blank',
  scriptUri: 'about:blank',
  cspSource: "'unsafe-inline'",
  nonce: 'dev',
  version: '0.1.21',
  bootstrap: many ? Array.from({ length: 20 }, (_, index) => record(20 - index)) : [],
});

html = html.replace(/<link rel="stylesheet"[^>]*>/, `<style>\n${css}\n</style>`);
// 预览页去掉 CSP：注入的脚本没有 nonce，会被 script-src 'nonce-…' 拦掉
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n/, '');

const diagScript = diag
  ? `
<script>
  window.addEventListener('load', () => setTimeout(() => {
    const pane = document.querySelector('.results-pane');
    const results = document.getElementById('results');
    const h = () => Math.round(pane.getBoundingClientRect().height * 10) / 10;
    const rect = () => pane.getBoundingClientRect();
    const log = [];
    log.push('vh=' + window.innerHeight + ' body=' + Math.round(document.querySelector('.fsearch').clientHeight));
    log.push('start h=' + h() + ' content=' + results.scrollHeight);
    document.getElementById('btnAdvanced').click();
    log.push('open  h=' + h() + ' adv=' + Math.round(document.getElementById('advanced').clientHeight));
    document.getElementById('btnAdvanced').click();
    log.push('close h=' + h() + ' gapBelow=' + Math.round(window.innerHeight - rect().bottom));
    const out = document.createElement('pre');
    out.textContent = log.join('\\n');
    out.style.cssText = 'position:fixed;left:0;top:0;right:0;z-index:99;margin:0;padding:6px;background:#111;color:#0f0;font:11px/1.4 monospace;white-space:pre-wrap';
    document.body.appendChild(out);
  }, 300));
</script>`
  : '';

html = html.replace(
  '<script nonce="dev" src="about:blank"></script>',
  `<script>window.acquireVsCodeApi = () => ({ postMessage() {}, getState() { return undefined; }, setState() {} });</script>
<script src="../../media/panel.js"></script>${diagScript}`,
);

const name = many ? 'panel-preview-many.html' : 'panel-preview.html';
writeFileSync(new URL(name, outDir), html);
console.log(`${name} ok`);
