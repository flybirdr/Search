export interface PanelHtmlOptions {
  /** 内联 CSS 文本：随 HTML 同步到达，杜绝「骨架先裸奔一帧」的 FOUC。
   *  panel.css 约 21KB，内联成本可忽略；比 <link> 异步加载快一整个来回。 */
  styleCss: string;
  scriptUri: string;
  cspSource: string;
  nonce: string;
  version: string;
  /** 翻译函数；默认原样返回，便于测试与中文环境。 */
  t?: (text: string, vars?: Record<string, string | number>) => string;
  /** webview 运行时文案表，前端据此翻译动态拼接的文本。 */
  i18n?: Record<string, string>;
  /** 上次留下的结果记录，直接铺进首屏，避免重载后先空一帧。 */
  bootstrap?: unknown;
  /** 上次的搜索条件，同样直接铺进首屏。 */
  bootstrapState?: unknown;
  /** `<html lang>` 的值。 */
  lang?: string;
}

/** 把 JSON 序列化进 DOM；转义 `<` 防止预览里的 `</div>` 提前闭合标签。 */
function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** 面板的静态骨架；抽成纯函数，方便测试直接喂进 DOM。 */
export function panelHtml(options: PanelHtmlOptions): string {
  const t = options.t ?? ((text: string) => text);
  const lang = options.lang ?? 'zh-CN';
  const dictionary = inlineJson(options.i18n ?? {});
  const bootstrap = inlineJson(options.bootstrap ?? []);
  const bootstrapState = inlineJson(options.bootstrapState ?? {});
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${options.nonce}' ${options.cspSource}`,
    `font-src ${options.cspSource}`,
    `script-src 'nonce-${options.nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${options.nonce}">${options.styleCss.replace(/<\/style/gi, '<\\/style')}</style>
<title>${t('搜索')}</title>
</head>
<body>
<div class="fsearch">
  <div class="search-row">
    <div class="field grow">
      <div class="input-wrap">
        <input id="query" type="text" spellcheck="false" autocomplete="off" aria-label="${t('查找目标')}" placeholder="${t('要查找的内容')}">
      </div>
    </div>
    <div class="row-actions">
      <button id="btnSearch" class="primary" title="${t('在当前文档中查找全部 (Enter)')}">${t('搜索')}</button>
      <button id="btnSearchAll" title="${t('在工作区的全部文件中搜索（过滤器取高级里的设置）')}">${t('全部')}</button>
    </div>
  </div>

  <div class="sub-row">
    <span class="hint">${t('Enter 搜索 · Esc 回到编辑区')}<span id="ver" class="ver">v${options.version}</span></span>
    <button id="btnAdvanced" class="link" aria-expanded="false" aria-controls="advanced">
      <span class="btn-text">${t('高级')}</span>
    </button>
  </div>

  <div id="advanced" class="advanced" hidden>
    <div class="field">
      <label class="lbl" for="filters">${t('过滤器')}</label>
      <input id="filters" type="text" spellcheck="false" value="**/*">
    </div>

    <div class="field">
      <label class="lbl" for="replace">${t('替换为')}</label>
      <div class="replace-row">
        <input id="replace" type="text" spellcheck="false" autocomplete="off" placeholder="${t('替换内容，可用 $1 或命名组')}">
        <div class="row-actions">
          <button data-act="replaceOne" class="primary">${t('替换')}</button>
          <button data-act="replaceAll" title="${t('替换当前搜索结果中的全部匹配：文档搜索在本文档内替换，工作区搜索跨文件替换')}">${t('全部')}</button>
        </div>
      </div>
    </div>

    <div class="groups">
      <fieldset>
        <legend>${t('搜索模式')}</legend>
        <label class="opt"><input type="radio" name="mode" value="normal"> ${t('普通')}</label>
        <label class="opt"><input type="radio" name="mode" value="extended"> ${t('扩展')} <span class="muted">\\n \\t \\xHH</span></label>
        <label class="opt"><input type="radio" name="mode" value="regex"> ${t('正则')}</label>
        <label class="opt"><input type="checkbox" id="dotAll"> ${t('. 匹配换行')}</label>
      </fieldset>
      <fieldset>
        <legend>${t('选项')}</legend>
        <label class="opt"><input type="checkbox" id="wholeWord"> ${t('全字匹配')}</label>
        <label class="opt"><input type="checkbox" id="caseSensitive"> ${t('区分大小写')}</label>
        <label class="opt"><input type="checkbox" id="wrapAround" checked> ${t('循环查找')}</label>
        <label class="opt"><input type="checkbox" id="inSelection"> ${t('在选区内查找')}</label>
      </fieldset>
    </div>

    <!-- 方向选项已删（导航永远向下，state.direction 仅供旧存档兼容）；
         「标记全部 / 清除标记」移到结果头，高级区只剩条件类设置 -->
  </div>

  <!-- 状态行：文字在左，「停止」按钮紧随其后；空态由 CSS 整行收起 -->
  <div class="status-row">
    <div id="status" class="status" role="status"></div>
    <button id="btnStop" class="link" type="button" hidden>${t('停止')}</button>
  </div>

  <!-- is-empty 由 panel.js 按有无记录切换，首屏默认按空态渲染，避免先撑出一片空白。
       高度全交给 flex：高级区自然高度，结果区吃满剩余空间，无上限变量。 -->
  <div class="results-pane is-empty">
    <div class="results-head">
      <div class="head-left">
        <span id="histSummary" class="hist-summary">${t('搜索结果')}</span>
        <button id="btnMark" class="link" data-act="markAll" type="button" title="${t('标记当前文档中的全部匹配')}">${t('标记全部')}</button>
        <button id="btnClearMarks" class="link" data-act="clearMarks" type="button" title="${t('清除标记')}">${t('清除标记')}</button>
      </div>
      <div class="head-right">
        <span id="hitPos" class="hit-pos" hidden title="${t('当前命中位置 / 总数')}"></span>
        <button id="btnPrev" class="link" data-act="prev" type="button" hidden title="${t('查找上一个')}">${t('上一个')}</button>
        <button id="btnNext" class="link" data-act="next" type="button" hidden title="${t('查找下一个')}">${t('下一个')}</button>
        <button id="btnCollapseAll" class="link" type="button" hidden title="${t('收起全部结果卡片与文件分组')}">${t('折叠全部')}</button>
        <button id="btnExpandAll" class="link" type="button" hidden title="${t('展开全部结果卡片与文件分组')}">${t('展开全部')}</button>
        <button id="btnClearAll" class="link" title="${t('清空')}">${t('清空')}</button>
      </div>
    </div>
    <div id="results" class="results">
      <div class="empty">${t('输入内容后按 Enter 开始搜索')}</div>
    </div>
  </div>
</div>
<div id="flyI18n" hidden>${dictionary}</div>
<div id="flyBootstrap" hidden>${bootstrap}</div>
<div id="flyState" hidden>${bootstrapState}</div>
<script nonce="${options.nonce}" src="${options.scriptUri}"></script>
</body>
</html>`;
}
