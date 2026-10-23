(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  /**
   * 宿主按当前 VS Code 语言注入的「中文原文 → 译文」表。
   * 中文环境是空表，T() 直接回退原文；英文缺条目时同样回退，不会显示空串。
   */
  const DICT = (() => {
    const holder = $('flyI18n');
    if (!holder) {
      return {};
    }
    try {
      return JSON.parse(holder.textContent || '{}') || {};
    } catch {
      return {};
    }
  })();

  function T(text, vars) {
    let out = Object.prototype.hasOwnProperty.call(DICT, text) ? DICT[text] : text;
    if (vars) {
      for (const key of Object.keys(vars)) {
        out = out.split('{' + key + '}').join(String(vars[key]));
      }
    }
    return out;
  }

  const els = {
    query: $('query'),
    replace: $('replace'),
    filters: $('filters'),
    status: $('status'),
    btnStop: $('btnStop'),
    results: $('results'),
    advanced: $('advanced'),
    btnAdvanced: $('btnAdvanced'),
    btnSearch: $('btnSearch'),
    btnSearchAll: $('btnSearchAll'),
    histSummary: $('histSummary'),
    hitPos: $('hitPos'),
    btnPrev: $('btnPrev'),
    btnNext: $('btnNext'),
    btnClearAll: $('btnClearAll'),
    btnCollapseAll: $('btnCollapseAll'),
    btnExpandAll: $('btnExpandAll'),
    sbV: $('sbV'),
    sbH: $('sbH'),
    pane: document.querySelector('.results-pane'),
  };

  /**
   * 页面种类（宿主模板注入 data-page）：content = 内容搜索，names = 文件名
   * 搜索。两个页面共用这套前端代码，只在搜索入口动作、条目点击行为与
   * 个别文案上有分支。
   */
  const PAGE = document.body.dataset.page === 'names' ? 'names' : 'content';

  /**
   * 文件名搜索页没有替换框 / 过滤器 / 「全部」按钮（没有高级区）：
   * 垫上惰性占位输入框与按钮，collect / apply / 键盘绑定不用到处判空。
   * 高级区的两个元素保持 undefined，setAdvanced 直接早退。
   */
  for (const key of ['replace', 'filters', 'btnSearchAll']) {
    if (!els[key]) {
      els[key] = document.createElement(key === 'btnSearchAll' ? 'button' : 'input');
    }
  }

  /**
   * 分组标题的「定位」按钮：revealInExplorer 显示对应文件 / 目录，
   * 同时让宿主按点击规则提升优先级。getTarget 返回
   * { recordId, label, detail }（悬浮条的目标随滚动变化，动态取）。
   */
  function makeLocateButton(getTarget) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'g-locate';
    button.title = T('在资源管理器中定位');
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('width', '11');
    svg.setAttribute('height', '11');
    svg.setAttribute('aria-hidden', 'true');
    for (const pair of [
      [6, 0.5, 6, 2.5],
      [6, 9.5, 6, 11.5],
      [0.5, 6, 2.5, 6],
      [9.5, 6, 11.5, 6],
    ]) {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', String(pair[0]));
      line.setAttribute('y1', String(pair[1]));
      line.setAttribute('x2', String(pair[2]));
      line.setAttribute('y2', String(pair[3]));
      line.setAttribute('stroke', 'currentColor');
      line.setAttribute('stroke-width', '1.2');
      svg.appendChild(line);
    }
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', '6');
    circle.setAttribute('cy', '6');
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '1.2');
    svg.appendChild(circle);
    button.appendChild(svg);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const target = getTarget();
      if (!target) {
        return;
      }
      vscode.postMessage({
        type: 'locateGroup',
        recordId: target.recordId,
        label: target.label,
        detail: target.detail || '',
      });
    });
    // 焦点在按钮上按 Enter/Space 会冒泡进标题行的折叠热键，必须拦下
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.stopPropagation();
      }
    });
    return button;
  }

  /**
   * 三个输入框的关键词时间线（宿主推来）：最近用过的在前。
   * cursor = -1 表示「没在翻历史」，此时输入框里是用户自己敲的内容；
   * draft 保存开始翻之前的那份内容，往下翻到底时还原它。
   */
  let inputHistory = { query: [], filters: [], replace: [] };
  const historyCursor = { query: -1, filters: -1, replace: -1 };
  const historyDraft = { query: '', filters: '', replace: '' };

  const state = {
    query: '',
    replace: '',
    mode: 'normal',
    caseSensitive: false,
    wholeWord: false,
    dotAll: false,
    wrapAround: true,
    inSelection: false,
    direction: 'down',
    advanced: false,
    filters: '**/*',
  };

  /**
   * 虚拟滚动：行高锁死常量（.r-item 的 height 与 JS 必须一致），只把
   * 视口 ±VIRTUAL_PAD 范围内的行挂进 DOM。几千条命中时 DOM 常驻量从
   * 「全部」降到 ~100 行，滚动、折叠、键盘导航都不再随结果规模退化。
   * 行高按页面区分：内容搜索单行 21px；文件名搜索的条目是两行
   * （文件名 + 所在目录），整页统一 34px（分组标题行同步抬高），
   * 保证 flatRows 的「下标 × 行高」算术在整页内成立。
   */
  const ROW_H = PAGE === 'names' ? 34 : 21;
  const VIRTUAL_PAD = 20;

  /** 文件分组的折叠键：label+detail 稳定标识一个分组，跨整卡重建保留。 */
  const groupKey = (group) => `${group.label}\u0000${group.detail ?? ''}`;

  /** recordId -> { section, body, chevron, rows: Map<itemId, row>, activeId, activePos } */
  const records = new Map();
  /** 渲染顺序，新的在前 */
  let order = [];

  /*
   * 复用骨架里那条空提示：它是首屏 HTML 的一部分，这里再 createElement 一条
   * 就会在空面板里出现两行一样的「输入内容后按 Enter 开始搜索」，
   * 而且渲染结果时只摘掉新建的那条，静态那条会一直挂在结果列表最上面。
   */
  const emptyEl = (() => {
    const existing = document.querySelector('#results > .empty');
    if (existing) {
      return existing;
    }
    const el = document.createElement('div');
    el.className = 'empty';
    el.textContent = T(
      PAGE === 'names' ? '输入文件名后按 Enter 开始搜索' : '输入内容后按 Enter 开始搜索',
    );
    return el;
  })();

  function collect() {
    const mode = document.querySelector('input[name="mode"]:checked');
    const flag = (id) => {
      const box = document.getElementById(id);
      return box ? box.checked : false;
    };
    state.query = els.query.value;
    state.replace = els.replace.value;
    state.filters = els.filters.value;
    state.mode = mode ? mode.value : 'normal';
    // 方向选项已删：导航固定向下；state.direction 字段保留只为旧存档兼容
    state.direction = 'down';
    state.caseSensitive = flag('caseSensitive');
    state.wholeWord = flag('wholeWord');
    state.dotAll = flag('dotAll');
    state.wrapAround = flag('wrapAround');
    state.inSelection = flag('inSelection');
    return state;
  }

  function apply(incoming) {
    Object.assign(state, incoming);
    els.query.value = state.query || '';
    els.replace.value = state.replace || '';
    els.filters.value = state.filters || '**/*';
    document.querySelectorAll('input[name="mode"]').forEach((radio) => {
      radio.checked = radio.value === state.mode;
    });
    const check = (id, value) => {
      const box = document.getElementById(id);
      if (box) {
        box.checked = Boolean(value);
      }
    };
    check('caseSensitive', state.caseSensitive);
    check('wholeWord', state.wholeWord);
    check('dotAll', state.dotAll);
    check('wrapAround', state.wrapAround);
    check('inSelection', state.inSelection);
    setAdvanced(Boolean(state.advanced));
  }

  function setAdvanced(on) {
    state.advanced = on;
    // 文件名搜索页没有高级区：只记状态，不碰不存在的 DOM
    if (!els.advanced || !els.btnAdvanced) {
      return;
    }
    els.advanced.hidden = !on;
    els.btnAdvanced.setAttribute('aria-expanded', String(on));
    const text = els.btnAdvanced.querySelector('.btn-text');
    if (text) {
      text.textContent = on ? T('收起') : T('高级');
    }
    // 高度全交给 flex：高级区自然高度，结果区吃满剩余空间，无需 JS 重算
  }

  function send(action) {
    vscode.postMessage({ type: 'action', action, state: collect() });
    vscode.setState(state);
  }

  /**
   * 输入过程中把条件同步给宿主（防抖），这样查询词、模式这些也会被记住，
   * 命令面板里的「查找下一个」也能用上刚敲进去的内容。
   */
  let publishTimer = null;
  function publishState() {
    if (publishTimer) {
      clearTimeout(publishTimer);
    }
    publishTimer = setTimeout(() => {
      publishTimer = null;
      vscode.postMessage({ type: 'state', state: collect() });
    }, 250);
  }


  function setStatus(text, tone) {
    els.status.textContent = text || '';
    els.status.dataset.tone = tone || 'info';
  }

  function setBusy(busy, text) {
    els.status.dataset.busy = busy ? 'true' : 'false';
    els.btnStop.hidden = !busy;
    if (busy) {
      els.status.textContent = text || T('搜索中…');
      els.status.dataset.tone = 'info';
    }
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function clock(ts) {
    const date = new Date(ts || Date.now());
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  /** 字节数 → 人类可读（B/KB/MB/GB），与宿主端 formatSize 保持一致。 */
  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return (unit === 0 ? Math.round(value) : value.toFixed(1)) + ' ' + units[unit];
  }

  function updateSummary() {
    // 文件搜索页没有结果头（0.1.127）
    if (!els.histSummary) {
      return;
    }
    els.histSummary.textContent =
      order.length === 0 ? T('搜索结果') : T('搜索结果（{n}）', { n: order.length });
    updateToggleAll();
  }

  /** 折叠/展开全部：两个独立按钮，各自动作所有卡片与文件分组，
   *  互不依赖「当前状态」——不会出现文案与实际状态不同步的问题。 */
  function setAllExpanded(expand) {
    for (const entry of records.values()) {
      setGroupsExpanded(entry, expand);
      setExpanded(entry, expand);
    }
  }

  /** 把一张卡片的全部文件分组设为展开 / 折叠（无变化时跳过重建）。 */
  function setGroupsExpanded(entry, expand) {
    if (expand) {
      if (entry.collapsed.size === 0) {
        return;
      }
      entry.collapsed.clear();
    } else {
      const groups = entry.record.groups || [];
      if (groups.length > 0 && entry.collapsed.size === groups.length) {
        return;
      }
      for (const group of groups) {
        entry.collapsed.add(groupKey(group));
      }
    }
    rebuildFlatRows(entry);
  }

  /** 有结果记录时显示折叠/展开全部与上/下一个，无记录时隐藏。 */
  function updateToggleButtons() {
    const show = order.length > 0;
    if (els.btnCollapseAll) {
      els.btnCollapseAll.hidden = !show;
    }
    if (els.btnExpandAll) {
      els.btnExpandAll.hidden = !show;
    }
    if (els.btnPrev) {
      els.btnPrev.hidden = !show;
    }
    if (els.btnNext) {
      els.btnNext.hidden = !show;
    }
    if (els.hitPos) {
      els.hitPos.hidden = true;
    }
  }

  /** 兼容旧调用点：按钮显隐统一走这里。 */
  function updateToggleAll() {
    updateToggleButtons();
  }

  function updateEmpty() {
    // 空态不预留结果区的最小高度，让「搜索结果」下面的留白跟着内容走
    const isEmpty = order.length === 0;
    els.pane.classList.toggle('is-empty', isEmpty);
    if (isEmpty) {
      if (!emptyEl.isConnected) {
        els.results.appendChild(emptyEl);
      }
    } else if (emptyEl.isConnected) {
      emptyEl.remove();
    }
  }

  function buildRow(record, item) {
    const row = document.createElement('div');
    row.className = 'r-item';
    row.tabIndex = 0;
    row.dataset.id = String(item.id);
    row.title = T('第 {line} 行，第 {col} 列', { line: item.line, col: item.column });

    const line = document.createElement('span');
    line.className = 'r-line';
    line.textContent = String(item.line);

    const code = document.createElement('span');
    code.className = 'r-code';
    const prefix = Math.max(0, Math.min(item.prefix, item.preview.length));
    const hitEnd = Math.max(prefix, Math.min(prefix + item.matchLen, item.preview.length));
    code.appendChild(document.createTextNode(item.preview.slice(0, prefix)));
    if (hitEnd > prefix) {
      const mark = document.createElement('mark');
      mark.textContent = item.preview.slice(prefix, hitEnd);
      code.appendChild(mark);
    }
    code.appendChild(document.createTextNode(item.preview.slice(hitEnd)));

    row.appendChild(line);
    row.appendChild(code);

    const reveal = () => vscode.postMessage({ type: 'reveal', recordId: record.id, id: item.id });
    row.addEventListener('click', reveal);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        reveal();
      }
    });
    return row;
  }

  /** rows 由调用方传入：懒渲染后续分块也要写进同一张表，否则导航选中
   * 懒渲染区间的行时查不到（0.1.60 之前行只在挂载时拷贝一次）。 */
  /**
   * 结果条目行（绝对定位，行高 = ROW_H）。与文件标题行（buildHeadRow）唯一
   * 区别是内容缩进一档；行里的 id 是导航和卸载的钥匙，dataset.id 必须是数字
   * 字符串。
   * - 内容搜索：单行「行号 + 代码预览」，点击跳转到命中行；
   * - 文件名搜索：两行「完整文件名（带命中高亮）/ 所在目录（项目根相对
   *   路径）」，点击打开文件。
   */
  function buildRow(record, item) {
    const row = document.createElement('div');
    row.className = 'r-item';
    row.tabIndex = 0;
    row.dataset.id = String(item.id);

    const prefix = Math.max(0, Math.min(item.prefix, item.preview.length));
    const hitEnd = Math.max(prefix, Math.min(prefix + item.matchLen, item.preview.length));
    const highlight = (el) => {
      el.appendChild(document.createTextNode(item.preview.slice(0, prefix)));
      if (hitEnd > prefix) {
        const mark = document.createElement('mark');
        mark.textContent = item.preview.slice(prefix, hitEnd);
        el.appendChild(mark);
      }
      el.appendChild(document.createTextNode(item.preview.slice(hitEnd)));
    };

    if (PAGE === 'names') {
      row.title = (item.dir ? item.dir + '/' : '') + item.preview;
      const name = document.createElement('div');
      name.className = 'r-name';
      highlight(name);
      const dir = document.createElement('div');
      dir.className = 'r-dir';
      dir.textContent = item.dir || '.';
      row.appendChild(name);
      row.appendChild(dir);
    } else {
      row.title = T('第 {line} 行，第 {col} 列', { line: item.line, col: item.column });

      const line = document.createElement('span');
      line.className = 'r-line';
      line.textContent = String(item.line);

      const code = document.createElement('span');
      code.className = 'r-code';
      highlight(code);

      row.appendChild(line);
      row.appendChild(code);
    }

    const reveal = () =>
      vscode.postMessage(
        PAGE === 'names'
          ? { type: 'revealFile', recordId: record.id, id: item.id }
          : { type: 'reveal', recordId: record.id, id: item.id },
      );
    row.addEventListener('click', reveal);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        reveal();
      }
    });
    return row;
  }

  /**
   * 文件标题行：与条目行同高 21px、同一绝对定位坐标系，观感沿用原分组头
   * （chev / 文件名 / 处数 / 路径），点击折叠该文件的全部条目。
   */
  /** 标题行折叠状态同步：元素复用（mounted 以 group 对象为键）后，
   *  折叠动作可能不经过本行的 toggle（如「折叠全部」），状态必须就地刷新。 */
  function syncHeadRow(entry, group, head) {
    const open = !entry.collapsed.has(groupKey(group));
    head.setAttribute('aria-expanded', String(open));
    head.querySelector('.chev').classList.toggle('open', open);
  }

  function buildHeadRow(entry, group) {
    const head = document.createElement('div');
    head.className = 'v-head';
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.title =
      (group.detail ? group.detail + ' · ' : '') +
      (group.truncated
        ? T('该文件命中数超过单文件上限，只保留了前 {n} 条', { n: group.items.length })
        : T('点击折叠 / 展开'));

    const open = !entry.collapsed.has(groupKey(group));
    const chev = document.createElement('span');
    chev.className = 'chev' + (open ? ' open' : '');

    const label = document.createElement('span');
    label.className = 'g-label';
    label.textContent = group.label;

    const count = document.createElement('span');
    count.className = 'g-count';
    count.textContent = groupCountLabel(group);

    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = group.detail;
    detail.title = group.detail;

    head.appendChild(chev);
    head.appendChild(label);
    head.appendChild(count);
    head.appendChild(detail);
    head.appendChild(makeLocateButton(() => ({
      recordId: entry.record.id,
      label: group.label,
      detail: group.detail,
    })));
    syncHeadRow(entry, group, head);

    const toggle = () => {
      // 只动本组：折叠状态按 label+detail 键存，收尾重建/其它组互不影响
      const key = groupKey(group);
      if (entry.collapsed.has(key)) {
        entry.collapsed.delete(key);
      } else {
        entry.collapsed.add(key);
      }
      // 折叠/展开改变行数组构成与卡片总高度：重建后全卡片重算窗口
      rebuildFlatRows(entry);
      renderAllVirtual();
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
    return head;
  }

  /**
   * 扁平行数组：卡片内所有行（文件标题行 + 结果条目行）统一 21px，按文档序
   * 排进同一个数组。行位置 = 下标 × 21，虚拟窗口就是数组切片——不再需要
   * 分组包装层（.group/.group-items）、前缀和几何缓存、失效通知与自愈。
   * 折叠的分组只保留标题行。headRows 单独存标题行下标（升序），悬浮标题
   * 二分用。
   */
  function rebuildFlatRows(entry) {
    const rows = [];
    const headRows = [];
    // 文件名搜索页（0.1.126）：条目平铺，不渲染目录分组标题行——分组只承担
    // 「按目录优先级排序」的数据职责，展示上就是一份文件列表（headRows 为空，
    // 悬浮标题条自然不会出现）。
    const flat = PAGE === 'names';
    for (const group of entry.record.groups) {
      if (flat) {
        for (const item of group.items) {
          rows.push({ item, group });
        }
        continue;
      }
      rows.push({ head: true, group });
      headRows.push(rows.length - 1);
      if (entry.collapsed.has(groupKey(group))) {
        continue;
      }
      for (const item of group.items) {
        rows.push({ item, group });
      }
    }
    entry.flatRows = rows;
    entry.headRows = headRows;
    if (entry.rowsEl) {
      entry.rowsEl.style.height = rows.length * ROW_H + 'px';
    }
    // 这里**不能**清 mounted：折叠/展开后行的元素身份不变（键是 group/item 对象），
    // renderVirtual 的 diff 会复用命中的行、只更新 top，卸载窗口外的行——标题行
    // 连续留在 DOM，chevron 的旋转过渡才能播放；清表会让一切重建、动画消失。
    // unmountAll 只该在行容器换新（finishRecord 重建）或卡片隐藏时调用。
    entry.idIndex.clear();
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      if (!r.head) {
        // 值存 { item, idx }：mounted 挂载表以 item 对象为键（元素复用，高亮
        // 反查 O(1)），idx 供导航滚动定位（rebuild 时本就全量重算，无漂移）
        entry.idIndex.set(r.item.id, { item: r.item, idx: i });
      }
    }
  }

  /** 卸掉本卡片全部已挂行（卡片折叠 / 行数组重建 / 记录重建时用）。 */
  function unmountAll(entry) {
    for (const el of entry.mounted.values()) {
      el.remove();
    }
    entry.mounted.clear();
  }

  // ---- 悬浮文件标题：滚过某个文件分组的组头后，视口顶部悬浮显示当前文件，----
  // ---- 点击整条 = 折叠该分组。位置绝对定位在 .results-pane 上，不占内容流。----

  const sticky = { bar: null, current: null };

  function buildStickyBar() {
    const bar = document.createElement('div');
    bar.className = 'sticky-head';
    bar.hidden = true;

    // 子结构与 .group-head 完全同名同序（chev/g-label/g-count/detail），
    // 样式才能整套复用分组头的规则
    const chev = document.createElement('span');
    chev.className = 'chev open';

    const label = document.createElement('span');
    label.className = 'g-label';

    const count = document.createElement('span');
    count.className = 'g-count';

    const detail = document.createElement('span');
    detail.className = 'detail';

    bar.appendChild(chev);
    bar.appendChild(label);
    bar.appendChild(count);
    bar.appendChild(detail);
    // 悬浮条上的定位按钮：目标随滚动变化，点击时读 sticky.current
    bar.appendChild(
      makeLocateButton(() =>
        sticky.current
          ? {
              recordId: sticky.current.entry.record.id,
              label: sticky.current.group.label,
              detail: sticky.current.group.detail,
            }
          : null,
      ),
    );
    bar.addEventListener('click', () => {
      const current = sticky.current;
      if (!current) {
        return;
      }
      const entry = current.entry;
      // 折叠后把视口顶对齐到该标题行的文档位置：看到的是
      // 「上一个文件的结尾 + 本文件折叠成的一行 + 下一个文件的开头」。
      // 行位置 = 行容器基准 + 下标 × 21，纯算术，不用碰 rect。
      const foldTop = current.baseTop + current.headIdx * ROW_H;
      entry.collapsed.add(groupKey(current.group));
      rebuildFlatRows(entry);
      els.results.scrollTop = Math.max(0, foldTop);
      renderVirtual(entry);
    });
    return bar;
  }

  /**
   * 悬浮条的位置：top 浮在结果区视口顶；**左右对齐到分组头所在的盒子**——
   * 即展开卡片的 .rec-body 内容区（剥掉卡片边框和 rec-body 的 4px 内边距），
   * 否则悬浮条比列表里的文件标题宽出一圈、文字起点也错开几个像素。
   * 没有展开卡片时退化为对齐 .results 整体（那时悬浮条也不该出现）。
   */
  function syncStickyPos(entry) {
    if (!sticky.bar) {
      return;
    }
    sticky.bar.style.top = els.results.offsetTop + 'px';
    const body = entry ? entry.body : null;
    if (!body || !body.isConnected) {
      sticky.bar.style.left = els.results.offsetLeft + 'px';
      sticky.bar.style.width = els.results.offsetWidth + 'px';
      return;
    }
    const paneRect = els.pane.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const cs = getComputedStyle(body);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    sticky.bar.style.left = bodyRect.left - paneRect.left + padL + 'px';
    sticky.bar.style.width = bodyRect.width - padL - padR + 'px';
  }

  /**
   * 算出「视口顶部此刻落在哪个文件标题行里」：
   * 每张展开卡片读**一次**行容器 rect（常量成本），行下标 = (视口顶 − 容器基准) / 21，
   * 再对 headRows 二分找 <=该下标的最近标题行。组头自己还没滚出视口顶时不显示。
   */
  function updateStickyHead() {
    if (!sticky.bar) {
      sticky.bar = buildStickyBar();
    }
    if (!sticky.bar.isConnected) {
      els.pane.appendChild(sticky.bar);
    }
    const noLayout =
      els.results.clientHeight === 0 && els.results.getBoundingClientRect().height === 0;
    const scrollTop = els.results.scrollTop;
    let current = null;
    if (!noLayout) {
      const view = els.results.getBoundingClientRect();
      for (const entry of records.values()) {
        if (entry.body.hidden || entry.flatRows.length === 0) {
          continue;
        }
        const rect = entry.rowsEl.getBoundingClientRect();
        // 行容器在滚动内容坐标系里的 top
        const baseTop = scrollTop + rect.top - view.top;
        const total = entry.flatRows.length * ROW_H;
        if (baseTop > scrollTop || baseTop + total <= scrollTop) {
          continue;
        }
        const rowIdx = Math.floor((scrollTop - baseTop) / ROW_H);
        // 二分 headRows：<= rowIdx 的最大标题行
        const heads = entry.headRows;
        let lo = 0;
        let hi = heads.length - 1;
        let found = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (heads[mid] <= rowIdx) {
            found = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        if (found >= 0) {
          current = {
            entry,
            headIdx: heads[found],
            group: entry.flatRows[heads[found]].group,
            baseTop,
          };
        }
      }
    }
    sticky.current = current;
    if (!current) {
      sticky.bar.hidden = true;
      return;
    }
    if (current.baseTop + current.headIdx * ROW_H + ROW_H > scrollTop + 0.5) {
      // 标题行还有像素留在视口顶，悬浮条会让它闪两份
      sticky.bar.hidden = true;
      return;
    }
    const group = current.group;
    sticky.bar.hidden = false;
    syncStickyPos(current.entry);
    sticky.bar.querySelector('.g-label').textContent = group.label;
    sticky.bar.querySelector('.detail').textContent = group.detail || '';
    sticky.bar.querySelector('.detail').title = group.detail || '';
    sticky.bar.querySelector('.g-count').textContent = groupCountLabel(group);
    sticky.bar.title = T('当前位置：{d}，点击折叠', { d: group.detail || group.label });
  }

  // ---- 浮层滚动条（0.1.126）：原生滚动条隐藏，滑条浮在 .results 上 ----
  // 不占布局空间（竖向不再吃掉一列内容宽度）；默认 opacity 0.35 淡显，
  // 滚动 / 悬停 / 拖动时加到 1，停止操作 700ms 后淡回。轨道不接鼠标事件，
  // 拖动只发生在滑块上。几何只在变化时重写，滚动帧只改 transform。

  const scrollbar = { drag: null, fadeTimer: null, geo: { top: -1, h: -1, left: -1, w: -1 } };
  const MIN_THUMB = 24;

  function updateScrollbars() {
    const vBar = els.sbV;
    const hBar = els.sbH;
    if (!vBar || !hBar) {
      return;
    }
    const el = els.results;
    // 轨道几何对齐 .results 盒：状态行出现/消失、面板拖宽时跟随
    const top = el.offsetTop;
    const height = el.offsetHeight;
    const left = el.offsetLeft;
    const width = el.offsetWidth;
    const geo = scrollbar.geo;
    if (geo.top !== top) {
      geo.top = top;
      vBar.style.top = top + 'px';
      hBar.style.top = top + height - 9 + 'px';
    }
    if (geo.h !== height) {
      geo.h = height;
      vBar.style.height = height + 'px';
      hBar.style.top = top + height - 9 + 'px';
    }
    if (geo.left !== left) {
      geo.left = left;
      hBar.style.left = left + 'px';
      vBar.style.left = left + width - 9 + 'px';
    }
    if (geo.w !== width) {
      geo.w = width;
      hBar.style.width = width + 'px';
      vBar.style.left = left + width - 9 + 'px';
    }

    // 纵向滑条：长度按可视比例（最小 24px 可抓），位置按滚动比例
    const vThumb = vBar.firstElementChild;
    if (el.scrollHeight <= el.clientHeight + 1) {
      vBar.hidden = true;
    } else {
      vBar.hidden = false;
      const thumbH = Math.max(MIN_THUMB, Math.floor((el.clientHeight * el.clientHeight) / el.scrollHeight));
      const maxThumbTop = el.clientHeight - thumbH;
      const thumbTop = Math.round((el.scrollTop / (el.scrollHeight - el.clientHeight)) * maxThumbTop);
      vThumb.style.height = thumbH + 'px';
      vThumb.style.transform = 'translateY(' + thumbTop + 'px)';
    }
    // 横向滑条：同款算术
    const hThumb = hBar.firstElementChild;
    if (el.scrollWidth <= el.clientWidth + 1) {
      hBar.hidden = true;
    } else {
      hBar.hidden = false;
      const thumbW = Math.max(MIN_THUMB, Math.floor((el.clientWidth * el.clientWidth) / el.scrollWidth));
      const maxThumbLeft = el.clientWidth - thumbW;
      const thumbLeft = Math.round((el.scrollLeft / (el.scrollWidth - el.clientWidth)) * maxThumbLeft);
      hThumb.style.width = thumbW + 'px';
      hThumb.style.transform = 'translateX(' + thumbLeft + 'px)';
    }
  }

  /** 淡回半透明：滚动停止 700ms 后（拖动中由 'scrolling' 类保持高亮）。 */
  function scheduleScrollbarFade() {
    if (scrollbar.fadeTimer) {
      clearTimeout(scrollbar.fadeTimer);
    }
    scrollbar.fadeTimer = setTimeout(() => {
      scrollbar.fadeTimer = null;
      els.pane.classList.remove('scrolling');
    }, 700);
  }

  function startScrollbarDrag(bar, thumb, axis, event) {
    const el = els.results;
    const trackLen = axis === 'y' ? el.clientHeight : el.clientWidth;
    const scrollLen =
      axis === 'y'
        ? el.scrollHeight - el.clientHeight
        : el.scrollWidth - el.clientWidth;
    if (scrollLen <= 0) {
      return;
    }
    const thumbLen = axis === 'y' ? thumb.offsetHeight : thumb.offsetWidth;
    scrollbar.drag = {
      bar,
      axis,
      start: axis === 'y' ? event.clientY : event.clientX,
      startScroll: axis === 'y' ? el.scrollTop : el.scrollLeft,
      maxScroll: scrollLen,
      maxThumb: Math.max(1, trackLen - Math.min(thumbLen, trackLen)),
    };
    bar.classList.add('dragging');
    els.pane.classList.add('scrolling');
    event.preventDefault();
    event.stopPropagation();
  }

  function bindScrollbarDrag(bar, axis) {
    if (!bar) {
      return;
    }
    bar.firstElementChild.addEventListener('mousedown', (event) => {
      startScrollbarDrag(bar, bar.firstElementChild, axis, event);
    });
  }

  bindScrollbarDrag(els.sbV, 'y');
  bindScrollbarDrag(els.sbH, 'x');

  window.addEventListener('mousemove', (event) => {
    const drag = scrollbar.drag;
    if (!drag) {
      return;
    }
    const pos = drag.axis === 'y' ? event.clientY : event.clientX;
    const delta = ((pos - drag.start) / drag.maxThumb) * drag.maxScroll;
    if (drag.axis === 'y') {
      els.results.scrollTop = drag.startScroll + delta;
    } else {
      els.results.scrollLeft = drag.startScroll + delta;
    }
    scheduleScrollbarFade();
  });

  window.addEventListener('mouseup', () => {
    if (!scrollbar.drag) {
      return;
    }
    scrollbar.drag.bar.classList.remove('dragging');
    scrollbar.drag = null;
    scheduleScrollbarFade();
  });

  if (els.results) {
    els.results.addEventListener('mouseenter', () => {
      els.pane.classList.add('sb-hover');
    });
    els.results.addEventListener('mouseleave', () => {
      els.pane.classList.remove('sb-hover');
    });
  }

  /**
   * 重渲染全部展开卡片。任何改变滚动内容总高度的操作（折叠/展开卡片、
   * 折叠/展开文件分组、增量插入行）都会让其它卡片在视口里上下平移——
   * 只重渲染当事卡片时，平移进视口的卡片不会触发 scroll 事件、窗口还是
   * 旧的，表现为「状态是展开的但一行都没渲染」。统一走这里。
   */
  function renderAllVirtual() {
    for (const entry of records.values()) {
      renderVirtual(entry);
    }
    // 内容总高/总宽变了（折叠、增量插入、收尾），滑条几何跟着刷新
    updateScrollbars();
  }

  /**
   * 虚拟渲染（扁平结构版）：卡片内所有行统一 21px 排进 flatRows，行位置 =
   * 下标 × 21。窗口 = 视口 ± VIRTUAL_PAD 换算成的数组切片，只把切片内的行
   * 挂进 DOM，窗口外的卸掉。每张展开卡片每帧只读一次行容器 rect（常量
   * 成本）；行下标是纯整数算术，不存在漂移。
   *
   * 触发点：滚动、卡片/分组折叠展开、增量插入、收尾、状态行增删——凡是
   * 会改变「哪些行落在视口里」的事件都要调一次。布局为 0 的环境（jsdom）
   * 会稳定挂载前 VIRTUAL_PAD 行，测试靠这一点断言。
   */
  function renderVirtual(entry) {
    if (!entry || !entry.body) {
      return;
    }
    if (entry.body.hidden) {
      unmountAll(entry);
      updateStickyHead();
      return;
    }
    const noLayout =
      els.results.clientHeight === 0 && els.results.getBoundingClientRect().height === 0;
    const rowsEl = entry.rowsEl;
    const total = entry.flatRows.length;
    let start = 0;
    let end = total;
    let baseTop = 0;
    if (!noLayout && total > 0) {
      const view = els.results.getBoundingClientRect();
      const viewTop = els.results.scrollTop;
      const viewBottom = viewTop + els.results.clientHeight;
      const rect = rowsEl.getBoundingClientRect();
      // 行容器在滚动内容坐标系里的 top；窗口切片与离屏判断全在内容坐标系做
      baseTop = viewTop + rect.top - view.top;
      const bottomContent = baseTop + total * ROW_H;
      if (bottomContent <= viewTop || baseTop >= viewBottom) {
        // 整张卡片滚出视口
        unmountAll(entry);
        updateStickyHead();
        return;
      }
      start = Math.max(0, Math.floor((viewTop - baseTop) / ROW_H) - VIRTUAL_PAD);
      end = Math.min(total, Math.ceil((viewBottom - baseTop) / ROW_H) + VIRTUAL_PAD);
    }
    // 卸掉窗口外的行。挂载表以**行内容**为键（标题行=group 对象、条目行=item
    // 对象），不是下标——折叠/展开后行下标整体平移，但同一行的元素身份不变，
    // 命中的只更新 top：标题行连续留在 DOM，chevron 的旋转过渡才能播放
    //（全新插入的元素直接以终态出现，没有动画可言）；流式追加时已挂行同理免重建。
    const inWindow = new Set();
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i += 1) {
      const r = entry.flatRows[i];
      const key = r.head ? r.group : r.item;
      inWindow.add(key);
      let el = entry.mounted.get(key);
      if (!el) {
        el = r.head ? buildHeadRow(entry, r.group) : buildRow(entry.record, r.item);
        entry.mounted.set(key, el);
        frag.appendChild(el);
      } else if (r.head) {
        // 复用的标题行：折叠状态可能被「折叠全部」等旁路改过，就地刷新
        syncHeadRow(entry, r.group, el);
      }
      el.style.top = i * ROW_H + 'px';
      if (!r.head && entry.activeId === r.item.id) {
        el.classList.add('active');
      }
    }
    for (const [key, el] of Array.from(entry.mounted)) {
      if (!inWindow.has(key)) {
        el.remove();
        entry.mounted.delete(key);
      }
    }
    if (frag.childNodes.length > 0) {
      rowsEl.appendChild(frag);
      // 绝对定位的行不参与宽度计算，横向滚动条长度要自己撑：记录见过的最宽
      // 行（只增不减，避免滚动时宽度来回跳）。宽度读**容器一次**，不能逐行
      // 读——DOM 刚插入就读行宽是强制同步布局，每帧几十次 reflow。
      const widest = rowsEl.scrollWidth;
      if (widest > entry.seen) {
        entry.seen = widest;
        rowsEl.style.minWidth = widest + 'px';
      }
    }
    updateStickyHead();
  }

  /** 搜索进行中，卡片末尾那行活提示；新分组直接插在它前面。 */
  function buildPendingLine() {
    const el = document.createElement('div');
    el.className = 'notice rec-pending';
    el.textContent = T('搜索中，结果会陆续出现…');
    return el;
  }

  /** 正文里的「没有匹配」：只在搜索结束且一条都没命中时出现。 */
  function buildEmptyLine() {
    const el = document.createElement('div');
    el.className = 'empty';
    el.textContent = T('没有匹配');
    return el;
  }

  /**
   * 上限提示：说清楚「只列出了前 N 条」，并给一个按需统计真实总数的按钮。
   *
   * 默认搜索到上限就停（那些行要进 webview、要能点击），所以面板上的 N 不是
   * 真实总数。只数命中不列结果可以完整扫一遍，代价是一次顺序读——放在按钮里，
   * 不点就不花这个时间。
   */
  function buildTruncatedNotice(record) {
    const notice = document.createElement('div');
    notice.className = 'notice';
    const text = document.createElement('span');
    text.className = 'notice-text';
    text.textContent = PAGE === 'names'
      ? T('已达到上限，只列出了前 {n} 个文件', {
          n: formatCount(record.total || 0),
        })
      : T('已达到匹配上限，只列出了前 {n} 条，未列出的部分没有统计', {
          n: formatCount(record.total || 0),
        });
    notice.appendChild(text);
    // 重载窗口后从历史恢复的卡片没有原始查询条件，点了也统计不了，干脆不给按钮
    if (record.exactAvailable !== false) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'notice-btn';
      button.textContent = T('统计完整数量');
      button.addEventListener('click', () => {
        button.disabled = true;
        button.textContent = T('正在统计…');
        vscode.postMessage({ type: 'requestExactCount', recordId: record.id });
      });
      notice.appendChild(button);
    }
    return notice;
  }

  /** 千分位：347029 → 347,029。 */
  function formatCount(value) {
    return Number(value || 0).toLocaleString();
  }

  /**
   * 分组计数文案：内容搜索是「N 处+」（截断加号在文案之后），
   * 文件名搜索的分组就是 N 个文件名，只显示数字（加号贴数字）。
   */
  function groupCountLabel(group) {
    return PAGE === 'names'
      ? formatCount(group.items.length) + (group.truncated ? '+' : '')
      : T('{n} 处', { n: group.items.length }) + (group.truncated ? '+' : '');
  }

  /** 卡片头 / 底部状态行共用的「处数」文案。 */
  function totalLabel(record) {
    const listed = formatCount(record.total || 0) + (record.truncated ? '+' : '');
    if (typeof record.exactTotal === 'number') {
      return T('{listed} / {total} 处', {
        listed: formatCount(record.total || 0),
        total: formatCount(record.exactTotal),
      });
    }
    // 文件名搜索没有「处」的概念：直接显示匹配文件数（加号贴数字）
    return PAGE === 'names' ? listed : T('{n} 处', { n: listed });
  }

  function buildSizeBadge(bytes) {
    const size = document.createElement('span');
    size.className = 'rec-size';
    size.textContent = formatSize(bytes);
    size.title = T('扫描文件总大小');
    return size;
  }

  /**
   * 正文骨架：截断提示 → 扁平行容器 → 「搜索中」/「没有匹配」。
   * 行容器（.rows）是本卡片所有 21px 行的定位上下文，高度按行数一次撑出；
   * 行由 renderVirtual 按视口切片挂载。提示行在容器之外，不参与虚拟化。
   */
  function buildBody(record, entry) {
    const section = document.createElement('div');
    section.className = 'rec-body';

    const notice = record.truncated ? buildTruncatedNotice(record) : null;
    if (notice) {
      section.appendChild(notice);
    }

    const rowsEl = document.createElement('div');
    rowsEl.className = 'rows';
    entry.rowsEl = rowsEl;
    section.appendChild(rowsEl);

    const pending = record.pending ? buildPendingLine() : null;
    if (pending) {
      section.appendChild(pending);
    }
    const empty = !record.pending && (record.groups || []).length === 0 ? buildEmptyLine() : null;
    if (empty) {
      section.appendChild(empty);
    }

    rebuildFlatRows(entry);

    return {
      section,
      notice,
      pending,
      empty,
      groupCount: (record.groups || []).length,
    };
  }

  /**
   * 正文状态对齐：进行中挂着「搜索中」，结束后摘掉，一条都没有才显示「没有匹配」。
   * 增量追加和收尾都走这里，避免两处各写一套判断。
   */
  function syncBodyState(entry) {
    const pending = Boolean(entry.record.pending);
    if (entry.pendingEl) {
      if (pending) {
        // 钉在末尾：分组不断插在它前面
        entry.body.appendChild(entry.pendingEl);
      } else {
        entry.pendingEl.remove();
        entry.pendingEl = null;
      }
    }
    if (!pending && entry.groupCount === 0) {
      if (!entry.emptyEl) {
        entry.emptyEl = buildEmptyLine();
      }
      entry.body.appendChild(entry.emptyEl);
    } else if (entry.emptyEl) {
      entry.emptyEl.remove();
      entry.emptyEl = null;
    }
    if (entry.record.truncated && !entry.notice) {
      entry.notice = buildTruncatedNotice(entry.record);
      entry.body.insertBefore(entry.notice, entry.body.firstChild);
    }
    // 提示行在行容器之外不受影响；行数变化会平移其它卡片，全部重算
    renderAllVirtual();
  }

  /** 折叠条上的统计（处数 / 文件数 / 用时 / 总大小）随增量刷新。 */
  function updateRecordHead(entry) {
    const record = entry.record;
    entry.elTotal.textContent = totalLabel(record);
    entry.elFiles.textContent = T('{n} 文件', { n: record.fileCount || 0 });
    entry.elMs.textContent = (record.elapsed || 0) + ' ms';
    if (Number.isFinite(record.totalBytes) && record.totalBytes > 0) {
      if (!entry.elSize) {
        entry.elSize = buildSizeBadge(record.totalBytes);
        entry.elMs.insertAdjacentElement('afterend', entry.elSize);
      }
      entry.elSize.textContent = formatSize(record.totalBytes);
    } else if (entry.elSize) {
      entry.elSize.remove();
      entry.elSize = null;
    }
  }

  function setExpanded(entry, on) {
    entry.section.classList.toggle('collapsed', !on);
    entry.body.hidden = !on;
    entry.head.setAttribute('aria-expanded', String(on));
    entry.chev.classList.toggle('open', on);
    // 折叠/展开改变滚动内容总高度：其它卡片在视口里平移，全部重算窗口
    renderAllVirtual();
  }

  function createRecordEl(record, expanded) {
    const section = document.createElement('section');
    section.className = 'record';
    section.dataset.id = String(record.id);

    const head = document.createElement('div');
    head.className = 'rec-head';
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', String(expanded));
    head.title = T('折叠 / 展开这条结果');

    const chev = document.createElement('span');
    chev.className = 'chev';

    const query = document.createElement('span');
    query.className = 'rec-q';
    query.textContent = '\u201c' + record.query + '\u201d';
    query.title = record.query;

    const total = document.createElement('span');
    total.className = 'rec-total';
    total.textContent = totalLabel(record);

    const fileCount = document.createElement('span');
    fileCount.className = 'rec-files';
    fileCount.textContent = T('{n} 文件', { n: record.fileCount || 0 });
    fileCount.title = T('这条结果覆盖的文件数');

    const ms = document.createElement('span');
    ms.className = 'rec-ms';
    ms.textContent = record.elapsed + ' ms';
    ms.title = T('本次搜索用时');

    let size = null;
    if (Number.isFinite(record.totalBytes) && record.totalBytes > 0) {
      size = buildSizeBadge(record.totalBytes);
    }

    const time = document.createElement('span');
    time.className = 'rec-time';
    time.textContent = clock(record.time);

    const close = document.createElement('button');
    close.className = 'rec-close';
    close.type = 'button';
    close.textContent = '\u2715';
    close.title = T('删除这条结果记录');
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: 'removeRecord', recordId: record.id });
    });

    head.appendChild(chev);
    head.appendChild(query);
    head.appendChild(total);
    head.appendChild(fileCount);
    head.appendChild(ms);
    if (size) {
      head.appendChild(size);
    }
    head.appendChild(time);
    head.appendChild(close);

    const entry = {
      section,
      head,
      body: null,
      chev,
      // 已挂载的行（虚拟窗口内的那部分）：flatRows 下标 -> row 元素
      mounted: new Map(),
      // 命中 id -> flatRows 下标：导航 O(1) 定位
      idIndex: new Map(),
      // 扁平行数组：{ head: true, group } | { item, group }，文档序
      flatRows: [],
      // 文件标题行的下标（升序），悬浮标题二分用
      headRows: [],
      // 折叠的文件分组（group 对象引用）
      collapsed: new Set(),
      // 行容器（.rows）：卡片内全部行的定位上下文
      rowsEl: null,
      // 撑横向滚动条用：见过的最宽行
      seen: 0,
      record,
      activeId: null,
      activePos: null,
      // 折叠条上的可变统计：流式搜索每来一帧都要就地刷新
      elTotal: total,
      elFiles: fileCount,
      elMs: ms,
      elSize: size,
      // 正文里的可变行：截断提示 / 「搜索中」/「没有匹配」
      notice: null,
      pendingEl: null,
      emptyEl: null,
      groupCount: 0,
    };
    const built = buildBody(record, entry);
    entry.body = built.section;
    entry.notice = built.notice;
    entry.pendingEl = built.pending;
    entry.emptyEl = built.empty;
    entry.groupCount = built.groupCount;
    section.appendChild(head);
    section.appendChild(built.section);
    // 方向必须读**当前** body（entry.body）：搜索收尾会整卡重建并替换 body，
    // 闭包里的 built.section 是被丢弃的旧引用，hidden 值冻结——用它算方向
    // 会出现「点一下没反应/反向，再点一下才对」的错乱。
    const toggle = () => setExpanded(entry, entry.body.hidden);
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });

    setExpanded(entry, expanded);
    return entry;
  }

  function mountRecord(record, expanded) {
    const entry = createRecordEl(record, expanded);
    records.set(record.id, entry);
    return entry;
  }

  /**
   * 宿主每扫完一个文件就推一帧新分组。结果按路径排，后扫完的文件可能排在
   * 前面，所以用宿主给的下标插到对应位置（而不是一律尾插），视觉上就像
   * 列表在按文件顺序「长出来」。分组对象插入 record.groups 后全量重建
   * 扁平行数组（O(行数) 纯算术，每 80ms 节流批次一次）；折叠状态保留。
   */
  function appendGroups(recordId, groups, stats, inserts) {
    const entry = records.get(recordId);
    if (!entry) {
      return;
    }
    const list = Array.isArray(groups) ? groups : [];
    for (let k = 0; k < list.length; k += 1) {
      const group = list[k];
      const raw = Array.isArray(inserts) ? inserts[k] : undefined;
      const at = Number.isInteger(raw)
        ? Math.min(Math.max(raw, 0), entry.record.groups.length)
        : entry.record.groups.length;
      entry.record.groups.splice(at, 0, group);
      entry.groupCount += 1;
    }
    if (stats) {
      Object.assign(entry.record, stats);
    }
    rebuildFlatRows(entry);
    updateRecordHead(entry);
    syncBodyState(entry);
    // 组从 0 到有（或数量变化）会翻转「折叠全部/展开全部」的文案
    updateToggleAll();
  }

  /**
   * 搜索结束：落最终统计、摘掉「搜索中」。
   * 分组数对不上（面板在搜索中途重载过、或增量消息丢了）时按整条记录重建
   * 正文，保证卡片上的文件清单和记录本身一致。
   */
  function finishRecord(record) {
    const entry = records.get(record.id);
    if (!entry) {
      return;
    }
    // record 先落位再重建：rebuildFlatRows 读的是 entry.record.groups
    entry.record = record;
    if (entry.groupCount !== (record.groups || []).length) {
      unmountAll(entry);
      entry.idIndex.clear();
      // collapsed 按 label+detail 键存储，跨重建保留用户的手动折叠状态
      const built = buildBody(record, entry);
      entry.body.replaceWith(built.section);
      entry.body = built.section;
      entry.notice = built.notice;
      entry.pendingEl = built.pending;
      entry.emptyEl = built.empty;
      entry.groupCount = built.groupCount;
      entry.activeId = null;
      entry.activePos = null;
    }
    syncBodyState(entry);
    updateRecordHead(entry);
    // 收尾可能按记录补回丢失的分组（整卡重建），按钮文案要跟着刷新
    updateToggleAll();
    if (Number.isInteger(entry.activePos)) {
      // 总数在搜索过程中长过，位置指示要按最终总数重算
      updateHitPos(record.id, entry.activePos);
    }
  }

  function collapseAll(exceptId) {
    for (const [id, entry] of records) {
      if (id !== exceptId) {
        setExpanded(entry, false);
      }
    }
  }

  function clearRecords() {
    records.clear();
    order = [];
    els.results.textContent = '';
    updateSummary();
    updateEmpty();
  }

  function pushRecord(record) {
    const existing = records.get(record.id);
    if (existing) {
      existing.section.remove();
      records.delete(record.id);
      order = order.filter((id) => id !== record.id);
    }

    const entry = mountRecord(record, true);
    // 按触发时间排序：记录 id 在搜索触发时分配（单调递增），插到第一个更小
    // id 之前。不能无条件 unshift——先触发的慢搜索完成得晚，反超后触发的
    // 快搜索时会抢错位置。宿主 records 数组同样按 id 降序维护。
    let at = order.findIndex((id) => id < record.id);
    if (at < 0) {
      at = order.length;
    }
    order.splice(at, 0, record.id);
    if (emptyEl.isConnected) {
      emptyEl.remove();
    }
    if (at < order.length - 1) {
      const nextEntry = records.get(order[at + 1]);
      els.results.insertBefore(entry.section, nextEntry ? nextEntry.section : null);
    } else {
      els.results.appendChild(entry.section);
    }
    // 不折叠已有卡片：新搜索只新增结果，各卡片的展开状态原样保留。
    // 新卡片插进滚动内容会让后续卡片平移，全部重算窗口（rect 全 0 的
    // 无布局环境下 renderAllVirtual 会把展开卡片的前 VIRTUAL_PAD 行挂出来）
    renderAllVirtual();

    while (records.size > 12) {
      const oldest = records.keys().next().value;
      const stale = records.get(oldest);
      if (stale) {
        stale.section.remove();
        records.delete(oldest);
        order = order.filter((id) => id !== oldest);
      } else {
        break;
      }
    }
    updateSummary();
    // 工作区搜索的第一条记录走这里（replace=false），必须补上 updateEmpty：
    // 空面板（is-empty）下结果区 flex 不拉伸、贴着内容高——第一条结果到达后
    // 要摘掉 is-empty 恢复拉伸，否则 Linux 上偶现「结果区不占满剩余空间」。
    updateEmpty();
  }

  function replaceRecord(record) {
    const existing = records.get(record.id);
    const position = existing ? existing.section : null;
    if (existing) {
      existing.section.remove();
      records.delete(record.id);
    }
    const entry = mountRecord(record, true);
    if (position && position.parentNode) {
      position.parentNode.replaceChild(entry.section, position);
    } else {
      els.results.insertBefore(entry.section, els.results.firstChild);
      order.unshift(record.id);
    }
    renderAllVirtual();
    updateSummary();
    updateEmpty();
  }

  function renderHistory(list) {
    clearRecords();
    const items = Array.isArray(list) ? list : [];
    items.forEach((record, index) => {
      const entry = mountRecord(record, index === 0);
      order.push(record.id);
      els.results.appendChild(entry.section);
    });
    renderAllVirtual();
    updateSummary();
    updateEmpty();
  }

  /**
   * 高亮当前走查到的那一行。`id` 是命中 id（稳定，用来定位行），
   * `pos` 是它在展示顺序里的位置（用来显示「第 i / n 处」）——
   * 结果按文件路径排、命中 id 按追加顺序分配，两者不能混用。
   */
  function setActive(recordId, id, pos) {
    for (const entry of records.values()) {
      if (entry.activeId !== null) {
        const loc = entry.idIndex.get(entry.activeId);
        const previous = loc ? entry.mounted.get(loc.item) : null;
        if (previous) {
          previous.classList.remove('active');
        }
        entry.activeId = null;
        entry.activePos = null;
      }
    }
    const entry = records.get(recordId);
    if (!entry) {
      return;
    }
    const row = ensureRowVisible(entry, id);
    if (!row) {
      return;
    }
    entry.activeId = id;
    entry.activePos = pos;
    row.classList.add('active');
  }

  /**
   * 把目标行滚进视口并渲染出来，返回该行（找不到 id 时 null）。
   *
   * 虚拟滚动下行可能还没挂进 DOM：按 idIndex 算出扁平行下标，行文档位置 =
   * 行容器基准 + 下标 × 21，把 results.scrollTop 设过去（block:'nearest' 语义），
   * 再 renderVirtual 对齐窗口——这时行一定挂好了。
   */
  function ensureRowVisible(entry, id) {
    // 结果卡片折叠时先展开，否则里面什么也看不见
    if (entry.body.hidden) {
      setExpanded(entry, true);
    }
    const loc = entry.idIndex.get(id);
    if (!loc) {
      // 所在文件分组处于折叠态：展开后 idIndex 重建，再定位一次
      const group = (entry.record.groups || []).find((g) => g.items.some((it) => it.id === id));
      if (group && entry.collapsed.has(groupKey(group))) {
        entry.collapsed.delete(groupKey(group));
        rebuildFlatRows(entry);
        return ensureRowVisible(entry, id);
      }
      return null;
    }
    const rowIdx = loc.idx;
    const item = loc.item;
    const results = els.results;
    const resultsRect = results.getBoundingClientRect();
    const rect = entry.rowsEl.getBoundingClientRect();
    const docTop = rect.top - resultsRect.top + results.scrollTop + rowIdx * ROW_H;
    const viewH = results.clientHeight;
    const st = results.scrollTop;
    if (docTop < st + 1) {
      results.scrollTop = Math.max(0, docTop);
    } else if (docTop + ROW_H > st + viewH - 1) {
      results.scrollTop = docTop + ROW_H - viewH;
    }
    renderAllVirtual();
    return entry.mounted.get(item) || null;
  }

  /** 「第 i / n 处」显示在结果头（上一个/下一个按钮左边），随导航实时更新。 */
  function updateHitPos(recordId, index) {
    if (!els.hitPos) {
      return;
    }
    const entry = records.get(recordId);
    if (!entry || !entry.record || index < 0) {
      els.hitPos.hidden = true;
      return;
    }
    els.hitPos.textContent = T('第 {i} / {n} 处', { i: index + 1, n: entry.record.total });
    els.hitPos.hidden = false;
  }

  // 文件名搜索页：输入即搜（防抖 300ms，停顿即触发），没有搜索按钮；
  // 空关键字也照发——宿主会清掉上一场结果，列表跟着输入走。
  // Enter 立即触发（取消挂着的防抖），↑/↓ 翻历史同样触发。
  let liveTimer = null;
  function triggerLiveSearch() {
    if (PAGE !== 'names') {
      return;
    }
    if (liveTimer) {
      clearTimeout(liveTimer);
    }
    liveTimer = setTimeout(() => {
      liveTimer = null;
      send('findFileNames');
    }, 300);
  }
  if (PAGE === 'names') {
    els.query.addEventListener('input', triggerLiveSearch);
  } else {
    els.btnSearch.addEventListener('click', () => send('search'));
    els.btnSearchAll.addEventListener('click', () => send('findInFiles'));
  }

  /**
   * 给一个输入框接上 ↑/↓ 翻历史。单行输入框里上下键本来没有默认行为，
   * 所以直接接管，不用判断光标位置。
   */
  function bindHistory(input, target) {
    input.addEventListener('keydown', (event) => {
      const list = inputHistory[target] || [];
      if (list.length === 0 || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
        return;
      }
      event.preventDefault();
      if (event.key === 'ArrowUp') {
        if (historyCursor[target] === -1) {
          historyDraft[target] = input.value;
        }
        const next = historyCursor[target] + 1;
        if (next >= list.length) {
          return;
        }
        historyCursor[target] = next;
        input.value = list[next];
      } else {
        if (historyCursor[target] === -1) {
          return;
        }
        const next = historyCursor[target] - 1;
        historyCursor[target] = next;
        input.value = next < 0 ? historyDraft[target] : list[next];
      }
      // 光标放到末尾；程序赋值不触发 input 事件，得手动同步给宿主
      try {
        input.setSelectionRange(input.value.length, input.value.length);
      } catch {
        // 个别环境不支持，忽略
      }
      collect();
      vscode.setState(state);
      publishState();
      // 文件名搜索页：翻历史选中的词也直接开搜
      triggerLiveSearch();
    });
  }

  bindHistory(els.query, 'query');
  if (PAGE !== 'names') {
    bindHistory(els.filters, 'filters');
    bindHistory(els.replace, 'replace');
  }

  els.query.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      // Enter 立即搜：挂着的实时防抖一并取消，避免紧接着又发一场
      if (liveTimer) {
        clearTimeout(liveTimer);
        liveTimer = null;
      }
      send(PAGE === 'names' ? 'findFileNames' : 'search');
    } else if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      send('prev');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      send('focusEditor');
    }
  });

  if (PAGE !== 'names') {
    els.replace.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        send('replaceOne');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        send('focusEditor');
      }
    });

    els.filters.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        send('findInFiles');
      }
    });

    els.btnAdvanced.addEventListener('click', () => {
      setAdvanced(els.advanced.hidden);
      vscode.setState(state);
      publishState();
    });
  }

  // 文件名搜索页没有「清空」（清掉输入即清空结果）与折叠/展开全部按钮
  if (els.btnClearAll) {
    els.btnClearAll.addEventListener('click', () => send('clearResults'));
  }

  // 搜索中的「停止」：状态行右侧的小链接，替代旧版右下角通知上的取消按钮
  els.btnStop.addEventListener('click', () => {
    // 文件名搜索：挂着的实时触发一并取消——否则停止后 300ms 内又会开新场，
    // 表现为「停不掉」
    if (liveTimer) {
      clearTimeout(liveTimer);
      liveTimer = null;
    }
    send('cancelSearch');
  });

  if (els.btnCollapseAll) {
    els.btnCollapseAll.addEventListener('click', () => {
      setAllExpanded(false);
    });
  }

  if (els.btnExpandAll) {
    els.btnExpandAll.addEventListener('click', () => {
      setAllExpanded(true);
    });
  }

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest('button[data-act]');
    if (button) {
      send(button.getAttribute('data-act'));
    }
  });

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      // 手动改过内容就退出历史模式，否则游标和框里的字对不上
      for (const key of ['query', 'filters', 'replace']) {
        if (els[key] === target) {
          historyCursor[key] = -1;
        }
      }
      collect();
      vscode.setState(state);
      publishState();
    }
  });

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      collect();
      vscode.setState(state);
      publishState();
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'state':
        apply(message.state);
        break;
      case 'record':
        if (message.replace) {
          replaceRecord(message.record);
        } else {
          pushRecord(message.record);
        }
        break;
      case 'history':
        renderHistory(message.records);
        break;
      case 'inputHistory':
        inputHistory = message.history || { query: [], filters: [], replace: [] };
        // 历史表换了（刚搜过一次），游标归位，下次 ↑ 从最新的一条开始
        for (const key of ['query', 'filters', 'replace']) {
          historyCursor[key] = -1;
        }
        break;
      case 'recordGroups':
        appendGroups(
          message.recordId,
          message.groups,
          {
            total: message.total,
            fileCount: message.fileCount,
            elapsed: message.elapsed,
            totalBytes: message.totalBytes,
            truncated: message.truncated,
            pending: message.pending,
          },
          message.inserts,
        );
        break;
      case 'recordDone':
        finishRecord(message.record);
        break;
      case 'removeRecord': {
        const entry = records.get(message.recordId);
        if (entry) {
          entry.section.remove();
          records.delete(message.recordId);
          order = order.filter((id) => id !== message.recordId);
          updateSummary();
          updateEmpty();
        }
        break;
      }
      case 'exactCount': {
        const entry = records.get(message.recordId);
        if (!entry) {
          break;
        }
        const button = entry.notice && entry.notice.querySelector('.notice-btn');
        if (message.cancelled) {
          // 用户中途 Stop：恢复按钮（点击时被置灰改文案），不改总数
          if (button) {
            button.disabled = false;
            button.textContent = T('统计完整数量');
          }
          break;
        }
        entry.record.exactTotal = message.total;
        const text = entry.notice && entry.notice.querySelector('.notice-text');
        if (text) {
          text.textContent = message.approximate
            ? T('共 {n} 处以上（近似值，跨块匹配可能漏计）；已列出前 {m} 条', {
                n: formatCount(message.total),
                m: formatCount(entry.record.total || 0),
              })
            : T('共 {n} 处；已列出前 {m} 条', {
                n: formatCount(message.total),
                m: formatCount(entry.record.total || 0),
              });
        }
        if (button) {
          button.remove();
        }
        updateRecordHead(entry);
        break;
      }
      case 'clearRecords':
        clearRecords();
        break;
      case 'status':
        setStatus(message.text, message.tone);
        break;
      case 'busy':
        setBusy(message.busy, message.text);
        break;
      case 'current': {
        // 老宿主只发 index，那时 id 与位置一致；新宿主分开给 id / index
        const pos = Number.isInteger(message.index) ? message.index : 0;
        const id = Number.isInteger(message.id) ? message.id : pos;
        setActive(message.recordId, id, pos);
        updateHitPos(message.recordId, pos);
        break;
      }
      case 'focus':
        (message.target === 'replace' ? els.replace : els.query).focus();
        break;
      default:
        break;
    }
  });

  const saved = vscode.getState();
  if (saved) {
    apply(saved);
  }

  // 宿主把上次的搜索条件也嵌进了首屏 HTML：先填好，免得输入框先空一下
  const stateEl = $('flyState');
  if (stateEl) {
    try {
      const boot = JSON.parse(stateEl.textContent || '{}');
      if (boot && typeof boot === 'object' && Object.keys(boot).length > 0) {
        apply(boot);
      }
    } catch {
      // 首屏条件坏了就当没有，等宿主 ready 后再推
    }
  }

  // 宿主把上次留下的记录塞进了首屏 HTML：直接画出来，避免重载窗口后先空一帧
  const bootstrapEl = $('flyBootstrap');
  if (bootstrapEl) {
    try {
      const list = JSON.parse(bootstrapEl.textContent || '[]');
      if (Array.isArray(list) && list.length > 0) {
        renderHistory(list);
      }
    } catch {
      // 首屏数据坏了就当没有，等宿主 ready 后再推
    }
  }

  // ---- 虚拟滚动的全局触发 ----
  // 纵向滚动容器是 .results（所有卡片共用），滚一下所有展开卡片都重算窗口。
  els.results.addEventListener(
    'scroll',
    () => {
      for (const entry of records.values()) {
        renderVirtual(entry);
      }
      // 滚动时滑条加深，停止 700ms 后淡回半透明
      els.pane.classList.add('scrolling');
      scheduleScrollbarFade();
      updateScrollbars();
    },
    { passive: true },
  );
  // 结果区高度被拖动分隔条改掉时视口变大/变小，同样要重算
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      for (const entry of records.values()) {
        renderVirtual(entry);
      }
      syncStickyPos();
      updateScrollbars();
    }).observe(els.results);
  }
  /* ResizeObserver 回调里的 syncStickyPos() 不带 entry：此时悬浮条多半是
   * 隐藏的；显示中的位置由下一次 renderVirtual → updateStickyHead 精确对齐。*/

  updateSummary();
  updateEmpty();
  updateScrollbars();

  vscode.postMessage({ type: 'ready' });
})();
