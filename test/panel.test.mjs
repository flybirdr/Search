import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { panelHtml } from './.tmp/html.mjs';
import { dictionary, translate } from './.tmp/i18n-core.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const scriptSource = fs.readFileSync(path.join(root, '..', 'media', 'panel.js'), 'utf8');
const html = panelHtml({
  styleCss: '.fsearch{color:red}',
  scriptUri: 'panel.js',
  cspSource: 'vscode-webview://test',
  nonce: 'testnonce',
  version: '0.0.0-test',
});

function boot(htmlSource = html) {
  const dom = new JSDOM(htmlSource, { runScripts: 'outside-only' });
  const posted = [];
  let saved;
  dom.window.acquireVsCodeApi = () => ({
    postMessage: (message) => posted.push(message),
    setState: (value) => {
      saved = value;
    },
    getState: () => saved,
  });
  dom.window.eval(scriptSource);
  return { dom, posted, doc: dom.window.document };
}

function click(dom, element) {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function deliver(dom, data) {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
}

function record(id, query, line = 1, extra = {}) {
  return {
    id,
    query,
    scope: 'document',
    scopeLabel: '当前文档',
    optionsLabel: '普通',
    groups: [
      {
        label: 'a.ts',
        detail: 'src/a.ts',
        items: [{ id: 0, line, column: 3, preview: `xx ${query} yy`, prefix: 3, matchLen: query.length }],
      },
    ],
    total: 1,
    fileCount: 1,
    elapsed: 4,
    truncated: false,
    time: Date.now(),
    ...extra,
  };
}

test('面板初始只显示基础搜索，高级区隐藏', () => {
  const { doc } = boot();
  assert.equal(doc.getElementById('advanced').hidden, true);
  assert.equal(doc.querySelector('.btn-text').textContent, '高级');
  assert.equal(doc.getElementById('results').textContent.includes('输入内容后按 Enter 开始搜索'), true);
});

test('高级按钮真正切换高级区显隐', () => {
  const { dom, doc } = boot();
  const advanced = doc.getElementById('advanced');
  const button = doc.getElementById('btnAdvanced');

  click(dom, button);
  assert.equal(advanced.hidden, false, '第一下点击应展开高级区');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(doc.querySelector('.btn-text').textContent, '收起');
  assert.equal(doc.querySelector('#btnAdvanced .chev'), null, '高级按钮不再带箭头（0.1.52）');

  click(dom, button);
  assert.equal(advanced.hidden, true, '第二下点击应收起高级区');
  assert.equal(doc.querySelector('.btn-text').textContent, '高级');
});

test('替换按钮内嵌替换框右侧；冗余搜索按钮已删；上/下一个在结果头', () => {
  const { dom, doc } = boot();
  // 替换 / 全部 紧贴替换输入框（replace-row 内），按钮文字是新标签
  const row = doc.querySelector('.replace-row');
  assert.ok(row, '替换框应有 .replace-row 包装');
  const acts = [...row.querySelectorAll('button[data-act]')].map((b) => b.dataset.act);
  assert.deepEqual(acts, ['replaceOne', 'replaceAll'], '替换框右侧应为 替换/全部 两颗按钮');
  assert.equal(row.querySelector('input#replace') !== null, true, '替换输入框应在同一行内');

  // 标记全部 / 清除标记 移到结果头（0.1.52）：高级区不再有任何按钮组
  assert.equal(doc.querySelector('.btn-grid'), null, '高级区按钮组已删');
  const headActs = [...doc.querySelector('.results-head').querySelectorAll('button')].map((b) => b.id);
  assert.deepEqual(
    headActs,
    ['btnMark', 'btnClearMarks', 'btnPrev', 'btnNext', 'btnCollapseAll', 'btnExpandAll', 'btnClearAll'],
    '结果头按钮顺序：上/下一个、折叠全部、展开全部、标记全部、清除标记、清空',
  );

  // 替换 / 全部 按钮复用搜索行的 .row-actions 样式（primary + 等宽 grid）
  assert.equal(row.querySelector('button[data-act="replaceOne"]').className, 'primary', '替换应为 primary 样式');
  assert.ok(row.querySelector('.row-actions'), '替换按钮应包在 .row-actions 内与搜索行同款');

  // 查找上一个/下一个移到结果头，前面带「第 i / n 处」位置指示；空面板隐藏，有结果显示
  const head = doc.querySelector('.results-head');
  assert.equal(doc.getElementById('hitPos') !== null, true, '结果头应有位置指示');
  assert.equal(doc.getElementById('hitPos').hidden, true, '空面板时位置指示应隐藏');
  assert.equal(doc.getElementById('btnPrev').hidden, true, '空面板时上一个应隐藏');
  deliver(dom, { type: 'record', record: record(1, 'foo'), replace: false });
  assert.equal(doc.getElementById('btnPrev').hidden, false, '有结果后上一个应显示');
  assert.equal(doc.getElementById('btnNext').hidden, false, '有结果后下一个应显示');
  assert.equal(doc.getElementById('btnCollapseAll').hidden, false);
  assert.equal(doc.getElementById('btnExpandAll').hidden, false);
});

test('导航时「第 i / n 处」位置指示显示在结果头并实时更新', () => {
  const { dom, doc } = boot();
  deliver(dom, { type: 'record', record: record(1, 'foo', 1, { total: 8 }), replace: false });
  const pos = doc.getElementById('hitPos');
  assert.equal(pos.hidden, true, '未导航前位置指示不显示');

  deliver(dom, { type: 'current', recordId: 1, index: 0 });
  assert.equal(pos.hidden, false, '导航后位置指示应显示');
  assert.match(pos.textContent, /1\s*\/\s*8/, '应显示 1 / 8');

  deliver(dom, { type: 'current', recordId: 1, index: 7 });
  assert.match(pos.textContent, /8\s*\/\s*8/, '应实时更新为 8 / 8');

  deliver(dom, { type: 'clearRecords' });
  assert.equal(pos.hidden, true, '清空结果后位置指示应隐藏');
});

test('搜索结果渲染为可折叠记录卡片', () => {
  const { dom, doc } = boot();
  deliver(dom, { type: 'record', record: record(1, 'foo') });

  const cards = doc.querySelectorAll('.record');
  assert.equal(cards.length, 1);
  assert.match(cards[0].querySelector('.rec-q').textContent, /foo/);
  assert.equal(cards[0].querySelector('.rec-total').textContent, '1 处');
  assert.equal(cards[0].querySelectorAll('.r-item').length, 1);
  assert.equal(cards[0].querySelector('mark').textContent, 'foo');
  assert.equal(cards[0].querySelector('.rec-body').hidden, false, '最新一条默认展开');
  assert.match(doc.getElementById('histSummary').textContent, /（1）/);
});

test('新搜索保留旧记录且不打扰其展开状态（0.1.107 起不再自动收起）', () => {
  const { dom, doc } = boot();
  deliver(dom, { type: 'record', record: record(1, 'foo') });
  deliver(dom, { type: 'record', record: record(2, 'bar', 7) });

  const cards = doc.querySelectorAll('.record');
  assert.equal(cards.length, 2, '两次搜索应保留两条记录');
  assert.match(cards[0].querySelector('.rec-q').textContent, /bar/, '新记录排在最前');
  assert.equal(cards[0].querySelector('.rec-body').hidden, false, '新记录展开');
  // 旧记录的展开状态原样保留：新搜索只新增结果，不折叠已有内容
  assert.equal(cards[1].querySelector('.rec-body').hidden, false, '旧记录保持原状态');
  assert.match(doc.getElementById('histSummary').textContent, /（2）/);

  click(dom, cards[1].querySelector('.rec-head'));
  assert.equal(cards[1].querySelector('.rec-body').hidden, true, '点击标题栏仍可手动折叠');
  click(dom, cards[1].querySelector('.rec-head'));
  assert.equal(cards[1].querySelector('.rec-body').hidden, false);
});

test('折叠全部 / 展开全部 是两个独立按钮，各自作用于所有卡片与文件分组', () => {
  const { dom, doc } = boot();
  // 空态没有可折叠的内容，按钮连同「清空」一样不该出现
  assert.equal(doc.getElementById('btnCollapseAll').hidden, true);
  assert.equal(doc.getElementById('btnExpandAll').hidden, true);

  deliver(dom, { type: 'record', record: record(1, 'foo') });
  deliver(dom, { type: 'record', record: record(2, 'bar', 7) });
  const collapse = doc.getElementById('btnCollapseAll');
  const expand = doc.getElementById('btnExpandAll');
  assert.equal(collapse.hidden, false, '有记录后按钮出现');
  assert.equal(expand.hidden, false);

  click(dom, collapse);
  const bodies = [...doc.querySelectorAll('.rec-body')];
  assert.ok(bodies.every((body) => body.hidden), '折叠全部：所有卡片收起');
  assert.ok(
    [...doc.querySelectorAll('.v-head')].every(
      (h) => h.getAttribute('aria-expanded') === 'false',
    ),
    '连文件分组一起折叠',
  );

  click(dom, expand);
  assert.ok(bodies.every((body) => !body.hidden), '展开全部：所有卡片展开');
  assert.ok(
    [...doc.querySelectorAll('.v-head')].every(
      (h) => h.getAttribute('aria-expanded') === 'true',
    ),
    '连文件分组一起展开',
  );

  // 清空后按钮跟着隐藏
  deliver(dom, { type: 'clearRecords' });
  assert.equal(collapse.hidden, true);
  assert.equal(expand.hidden, true);
});

test('单独折叠一个文件分组不影响其它分组与收尾重建（0.1.111）', () => {
  const { dom, doc } = boot();
  // pending 卡片 → 流式两组 → 收尾重建（body 替换）
  deliver(dom, { type: 'record', record: pendingRecord(1, 'foo') });
  deliver(dom, {
    type: 'recordGroups',
    recordId: 1,
    groups: [groupOf('a.ts', 'src/a.ts', [hit(0, 1)])],
    ...stats({ total: 1, fileCount: 1 }),
  });
  deliver(dom, {
    type: 'recordGroups',
    recordId: 1,
    groups: [groupOf('b.ts', 'src/b.ts', [hit(1, 2)])],
    ...stats({ total: 2, fileCount: 2 }),
  });

  // 手动折叠 a.ts
  const heads = () => [...doc.querySelectorAll('.v-head')];
  const aHead = heads().find((h) => h.querySelector('.g-label').textContent === 'a.ts');
  click(dom, aHead);
  assert.equal(
    heads().find((h) => h.querySelector('.g-label').textContent === 'a.ts').getAttribute('aria-expanded'),
    'false',
    'a.ts 已折叠',
  );

  // 收尾重建（分组数不变不重建，这里直接再发一次 recordDone 触发 syncBodyState）
  deliver(dom, {
    type: 'recordDone',
    record: {
      ...pendingRecord(1, 'foo'),
      groups: [
        groupOf('a.ts', 'src/a.ts', [hit(0, 1)]),
        groupOf('b.ts', 'src/b.ts', [hit(1, 2)]),
      ],
      total: 2,
      fileCount: 2,
      elapsed: 5,
      pending: false,
    },
  });
  assert.equal(
    heads().find((h) => h.querySelector('.g-label').textContent === 'a.ts').getAttribute('aria-expanded'),
    'false',
    '收尾后 a.ts 的折叠状态保留',
  );
  assert.equal(
    heads().find((h) => h.querySelector('.g-label').textContent === 'b.ts').getAttribute('aria-expanded'),
    'true',
    'b.ts 不被牵连',
  );
});

test('折叠全部后发起新搜索：两按钮常驻且旧记录状态保留', () => {
  const { dom, doc } = boot();
  deliver(dom, { type: 'record', record: record(1, 'foo') });
  const collapse = doc.getElementById('btnCollapseAll');
  const expand = doc.getElementById('btnExpandAll');
  click(dom, collapse);
  assert.equal(
    doc.querySelector('.record .rec-body').hidden,
    true,
    '前置条件：已全部折叠',
  );

  // 新搜索：pending 卡片阶段无分组，两按钮保持可见
  deliver(dom, { type: 'record', record: pendingRecord(2, 'bar') });
  assert.equal(collapse.hidden, false);
  assert.equal(expand.hidden, false);
  const cardOf = (id) => doc.querySelector(`.record[data-id="${id}"]`);
  assert.equal(
    cardOf(2).querySelector('.rec-body').hidden,
    false,
    '新卡片默认展开',
  );
  assert.equal(
    cardOf(1).querySelector('.rec-body').hidden,
    true,
    '旧卡片折叠状态保留（新搜索不打扰）',
  );

  // 流式结果到达
  deliver(dom, {
    type: 'recordGroups',
    recordId: 2,
    groups: [groupOf('a.ts', 'src/a.ts', [hit(0, 1)])],
    ...stats({ total: 1, fileCount: 1 }),
  });
  assert.equal(
    cardOf(1).querySelector('.rec-body').hidden,
    true,
    '旧卡片折叠状态保留',
  );
});

test('展开全部后折叠第一张卡片：其余卡片不受影响、行不丢（0.1.107 回归）', () => {
  const { dom, doc } = boot();
  for (const [id, label] of [[1, 'a.ts'], [2, 'b.ts'], [3, 'c.ts']]) {
    deliver(dom, {
      type: 'record',
      record: {
        ...record(id, 'foo'),
        groups: [{ label, detail: `src/${label}`, items: [
          { id: id * 10, line: 1, column: 1, preview: 'x', prefix: 0, matchLen: 1 },
          { id: id * 10 + 1, line: 2, column: 1, preview: 'y', prefix: 0, matchLen: 1 },
        ] }],
        total: 2,
        fileCount: 1,
      },
    });
  }
  const cards = [...doc.querySelectorAll('.record')];
  // 点「折叠全部」再点「展开全部」，模拟用户的操作序列
  click(dom, doc.getElementById('btnCollapseAll'));
  click(dom, doc.getElementById('btnExpandAll'));
  assert.ok(
    cards.every((card) => !card.querySelector('.rec-body').hidden),
    '前置条件：三张卡片全部展开',
  );

  // 手动折叠第一张卡片
  click(dom, cards[0].querySelector('.rec-head'));
  assert.equal(cards[0].querySelector('.rec-body').hidden, true, '第一张卡片折叠');
  assert.equal(
    cards[1].querySelector('.rec-body').hidden,
    false,
    '第二张卡片不受影响',
  );
  assert.equal(
    cards[2].querySelector('.rec-body').hidden,
    false,
    '第三张卡片不受影响',
  );
  // 行不丢：折叠卡的行卸掉，其余两卡各 2 条目 + 1 标题行仍在
  assert.equal(cards[1].querySelectorAll('.r-item').length, 2, '第二卡 2 条目');
  assert.equal(cards[2].querySelectorAll('.r-item').length, 2, '第三卡 2 条目');
  assert.equal(cards[1].querySelectorAll('.v-head').length, 1, '第二卡标题行在');
  assert.equal(cards[2].querySelectorAll('.v-head').length, 1, '第三卡标题行在');
});

/** 多卡片几何桩：三张卡片竖排，rect 随折叠状态动态变化（模拟真实布局）。 */
function stubMultiCardGeometry(doc, results, cards, rowsPerCard) {
  const CHROME = 30; // 卡片头等非行内容高度
  const rowH = 21;
  Object.defineProperty(results, 'scrollTop', {
    value: 0,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(results, 'clientHeight', {
    get: () => 420,
    configurable: true,
  });
  results.getBoundingClientRect = () => ({ top: 0, bottom: 420, height: 420 });
  // 视口内的行容器 rect 按当前折叠状态实时计算——折叠某卡片后，下方卡片上移
  const tops = () => {
    const out = [];
    let y = 0;
    for (const card of cards) {
      const collapsed = card.querySelector('.rec-body').hidden;
      out.push(collapsed ? null : y + CHROME);
      y += CHROME + (collapsed ? 0 : rowsPerCard * rowH);
    }
    return out;
  };
  cards.forEach((card, i) => {
    const rowsEl = card.querySelector('.rows');
    rowsEl.getBoundingClientRect = () => {
      const t = tops()[i];
      if (t === null) {
        return { top: 0, bottom: 0, height: 0 };
      }
      return {
        top: t - results.scrollTop,
        bottom: t + rowsPerCard * rowH - results.scrollTop,
        height: rowsPerCard * rowH,
      };
    };
  });
}

test('展开全部后折叠第一张卡片：下方卡片平移进视口后行要渲染出来（0.1.112）', () => {
  const { dom, doc } = boot();
  const ROWS = 10;
  const mk = (base) =>
    Array.from({ length: ROWS }, (_, i) => ({
      id: base + i,
      line: i + 1,
      column: 1,
      preview: 'foo',
      prefix: 0,
      matchLen: 3,
    }));
  for (const [id, label] of [
    [1, 'a.ts'],
    [2, 'b.ts'],
    [3, 'c.ts'],
  ]) {
    deliver(dom, {
      type: 'record',
      record: {
        ...record(id, 'foo'),
        groups: [
          { label, detail: `src/${label}`, items: mk(id * 100), truncated: false },
        ],
        total: ROWS,
        fileCount: 1,
      },
    });
  }
  const cards = [...doc.querySelectorAll('.record')];
  const results = doc.getElementById('results');
  stubMultiCardGeometry(doc, results, cards, ROWS);
  // 桩好几何后滚一次，让三张卡片按真实路径挂行
  results.dispatchEvent(new dom.window.Event('scroll'));
  const rowsOf = (card) => card.querySelectorAll('.r-item').length;
  assert.ok(rowsOf(cards[0]) > 0, '前置条件：视口内的第一张卡有行');

  // 折叠第一张卡片（DOM 最上面的那张）：下方卡片整体上移进视口
  const firstHead = cards[0].querySelector('.rec-head');
  click(dom, firstHead);
  assert.equal(cards[0].querySelector('.rec-body').hidden, true, '第一张卡片已折叠');
  assert.ok(
    rowsOf(cards[1]) > 0,
    '第二张卡片上移后行要渲染出来（此前只重渲染当事卡片，下方卡片窗口是旧的）',
  );
  assert.ok(
    rowsOf(cards[2]) > 0,
    '第三张卡片平移进视口后行也要渲染出来（回归：此前一行不挂，显示为空）',
  );
});

test('搜索收尾重建 body 后，卡片头点击方向依然正确（0.1.107 回归）', () => {
  const { dom, doc } = boot();
  // pending 卡片 → 收尾时 groups 数变化 → 整卡重建（body 被替换）
  deliver(dom, { type: 'record', record: pendingRecord(1, 'foo') });
  deliver(dom, {
    type: 'recordDone',
    record: {
      ...pendingRecord(1, 'foo'),
      groups: [groupOf('a.ts', 'src/a.ts', [hit(0, 1), hit(1, 2)])],
      total: 2,
      fileCount: 1,
      elapsed: 5,
      pending: false,
    },
  });
  const card = doc.querySelector('.record');
  const head = card.querySelector('.rec-head');
  const body = card.querySelector('.rec-body');

  // 重建后 toggle 若还读被丢弃的旧 body 引用，方向会冻结：第一次点击折叠后
  // 后续点击全部停在折叠态，展不开
  click(dom, head);
  assert.equal(body.hidden, true, '第一次点击：折叠');
  click(dom, head);
  assert.equal(body.hidden, false, '第二次点击：展开（方向不能冻结）');
  click(dom, head);
  assert.equal(body.hidden, true, '第三次点击：再折叠');
});

test('点击结果行发出带 recordId 的跳转消息', () => {
  const { dom, posted, doc } = boot();
  deliver(dom, { type: 'record', record: record(9, 'foo') });
  posted.length = 0;

  const row = doc.querySelector('.r-item');
  click(dom, row);
  const reveal = posted.find((message) => message.type === 'reveal');
  assert.ok(reveal, '应发出 reveal 消息');
  assert.equal(reveal.recordId, 9);
  assert.equal(reveal.id, 0);
});

test('删除按钮只移除一条记录，清空按钮移除全部', () => {
  const { dom, posted, doc } = boot();
  deliver(dom, { type: 'record', record: record(1, 'foo') });
  deliver(dom, { type: 'record', record: record(2, 'bar') });
  posted.length = 0;

  click(dom, doc.querySelector('.record .rec-close'));
  assert.equal(posted.filter((message) => message.type === 'removeRecord').length, 1);
  assert.equal(posted.find((message) => message.type === 'removeRecord').recordId, 2);

  deliver(dom, { type: 'removeRecord', recordId: 2 });
  assert.equal(doc.querySelectorAll('.record').length, 1);
  assert.match(doc.getElementById('histSummary').textContent, /（1）/);

  click(dom, doc.getElementById('btnClearAll'));
  assert.equal(posted.some((message) => message.type === 'action' && message.action === 'clearResults'), true);

  deliver(dom, { type: 'clearRecords' });
  assert.equal(doc.querySelectorAll('.record').length, 0);
  assert.equal(doc.getElementById('histSummary').textContent, '搜索结果');
});

test('重开面板时按历史列表整体还原', () => {
  const { dom, doc } = boot();
  deliver(dom, {
    type: 'history',
    records: [record(3, 'gamma'), record(2, 'beta'), record(1, 'alpha')],
  });
  const cards = doc.querySelectorAll('.record');
  assert.equal(cards.length, 3);
  assert.equal(cards[0].querySelector('.rec-body').hidden, false);
  assert.equal(cards[1].querySelector('.rec-body').hidden, true);
  assert.equal(cards[2].querySelector('.rec-body').hidden, true);
});

test('替换结果原地刷新同一张卡片，不新增记录', () => {
  const { dom, doc } = boot();
  deliver(dom, { type: 'record', record: record(1, 'foo') });
  deliver(dom, { type: 'record', record: record(1, 'foo', 5), replace: true });

  const cards = doc.querySelectorAll('.record');
  assert.equal(cards.length, 1, '刷新不应产生第二条记录');
  assert.equal(cards[0].querySelector('.r-line').textContent, '5');
});

test('「全部」按钮触发工作区搜索', () => {
  const { dom, posted, doc } = boot();
  posted.length = 0;

  click(dom, doc.getElementById('btnSearchAll'));
  const action = posted.find((message) => message.type === 'action');
  assert.ok(action, '应发出 action 消息');
  assert.equal(action.action, 'findInFiles');
  assert.equal(action.state.query, doc.getElementById('query').value);
});

test('每个文件的搜索结果可单独折叠', () => {
  const { dom, doc } = boot();
  const payload = record(1, 'foo');
  payload.groups.push({
    label: 'b.ts',
    detail: 'src/b.ts',
    items: [{ id: 1, line: 3, column: 1, preview: 'foo', prefix: 0, matchLen: 3 }],
    truncated: true,
  });
  payload.fileCount = 2;
  deliver(dom, { type: 'record', record: payload });

  const heads = doc.querySelectorAll('.v-head');
  assert.equal(heads.length, 2, '两个文件应生成两个标题行');
  assert.equal(heads[0].querySelector('.g-count').textContent, '1 处');
  assert.equal(heads[1].querySelector('.g-count').textContent, '1 处+', '截断的文件带 + 标记');

  let head = heads[0];
  assert.equal(head.getAttribute('aria-expanded'), 'true', '分组默认展开');

  click(dom, head);
  // 重建后标题行是新建 DOM，引用要重新取
  head = doc.querySelectorAll('.v-head')[0];
  assert.equal(head.getAttribute('aria-expanded'), 'false', '点击文件头应折叠该文件');
  assert.equal(
    doc.querySelectorAll('.r-item').length,
    1,
    '折叠后窗口里只剩另一个文件的条目',
  );

  click(dom, head);
  head = doc.querySelectorAll('.v-head')[0];
  assert.equal(head.getAttribute('aria-expanded'), 'true', '再次点击应展开');
});

test('折叠条显示用时与总大小，正文不再有摘要行', () => {
  const { dom, doc } = boot();
  deliver(dom, {
    type: 'record',
    record: record(1, 'foo', 1, { elapsed: 765, totalBytes: 44739092 }),
  });
  const head = doc.querySelector('.rec-head');
  assert.match(head.querySelector('.rec-ms').textContent, /765 ms/);
  assert.match(head.querySelector('.rec-size').textContent, /42\.7 MB/);
  assert.equal(doc.querySelector('.rec-sub'), null, '正文里的扫描统计行已移除');
  // 没有大小时不显示大小徽标
  deliver(dom, { type: 'record', record: record(2, 'bar', 2, { elapsed: 3 }) });
  assert.equal(doc.querySelector('.record[data-id="2"] .rec-size'), null);
});

test('「上一个 / 下一个」选中列表对应项：展开折叠的卡片与分组并滚动到可见（0.1.60）', () => {
  const { dom, doc } = boot();
  deliver(dom, { type: 'record', record: record(1, 'foo') });

  // 先折叠文件分组和卡片，模拟用户在翻看别的内容
  click(dom, doc.querySelector('.v-head'));
  const head = doc.querySelector('.v-head');
  assert.equal(head.getAttribute('aria-expanded'), 'false', '前置条件：文件分组已折叠');
  click(dom, doc.querySelector('.rec-head'));
  const body = doc.querySelector('.rec-body');
  assert.equal(body.hidden, true, '前置条件：卡片已折叠');
  assert.equal(doc.querySelectorAll('.r-item').length, 0, '折叠状态下虚拟窗口为空');

  // 虚拟滚动不用 scrollIntoView：导航直接写 results.scrollTop
  const results = doc.getElementById('results');
  let scrolledTo = null;
  Object.defineProperty(results, 'scrollTop', {
    get: () => 0,
    set: (value) => {
      scrolledTo = value;
    },
    configurable: true,
  });

  deliver(dom, { type: 'current', recordId: 1, index: 0 });

  assert.equal(body.hidden, false, '折叠的卡片要展开，否则看不到选中项');
  // 导航触发了折叠分组自动展开，标题行是重建后的新 DOM
  assert.equal(
    doc.querySelector('.v-head').getAttribute('aria-expanded'),
    'true',
    '折叠的文件分组要展开',
  );
  assert.ok(scrolledTo !== null, '选中项要把 results.scrollTop 设到目标位置');
  assert.ok(doc.querySelector('.r-item').classList.contains('active'), '高亮仍要同步');
});

/**
 * jsdom 没有布局：getBoundingClientRect 全 0。虚拟渲染读两个 rect——
 * 滚动视口（#results，固定不随滚动移动）和扁平行容器（top 随 scrollTop
 * 上移）。这里桩出真实浏览器里的几何关系，窗口换算才能走通。
 */
function stubVirtualGeometry(doc, results, rowsEl, totalRows) {
  Object.defineProperty(results, 'scrollTop', {
    value: 0,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(results, 'clientHeight', {
    get: () => 420,
    configurable: true,
  });
  results.getBoundingClientRect = () => ({ top: 0, bottom: 420, height: 420 });
  rowsEl.getBoundingClientRect = () => {
    const st = results.scrollTop;
    return { top: -st, bottom: totalRows * 21 - st, height: totalRows * 21 };
  };
}

test('虚拟滚动：只挂视口 ±20 行，滚动后窗口跟着走，「显示更多」按钮已删', () => {
  const { dom, doc } = boot();
  const items = Array.from({ length: 450 }, (_, i) => ({
    id: i,
    line: i + 1,
    column: 1,
    preview: 'foo',
    prefix: 0,
    matchLen: 3,
  }));
  deliver(dom, {
    type: 'record',
    record: { ...record(1, 'foo'), groups: [{ label: 'a.ts', detail: 'src/a.ts', items }], total: 450 },
  });
  const card = doc.querySelector('.record');
  const results = doc.getElementById('results');
  // 扁平结构：标题行 + 450 条目行 = 451 行
  const rowsEl = card.querySelector('.rows');
  const totalRows = 451;
  assert.equal(rowsEl.style.height, 451 * 21 + 'px', '行容器高度按行数撑出真实滚动条');
  stubVirtualGeometry(doc, results, rowsEl, totalRows);
  // 桩之前挂载发生在无布局环境（rect 全 0 → 前 20 行）；桩好几何后滚动
  // 一次，让 scroll 事件按真实路径重算窗口。
  results.dispatchEvent(new dom.window.Event('scroll'));

  // 视口 420px ÷ 21 = 20 行，±20 缓冲 → 行窗口 [0, 40)：1 标题行 + 39 条目
  let rows = [...card.querySelectorAll('.r-item')];
  assert.equal(rows.length, 39, '首屏只挂视口加缓冲的行，不挂全量（标题行另占 1）');
  assert.equal(rows[0].dataset.id, '0');
  assert.equal(rows[38].dataset.id, '38');
  assert.equal(card.querySelector('.more-btn'), null, '「显示更多」按钮被虚拟滚动取代');

  // 滚到中部：scrollTop = 5000 → 行窗口 [218, 279)，全落在条目区 → id 217..278
  results.scrollTop = 5000;
  results.dispatchEvent(new dom.window.Event('scroll'));
  rows = [...card.querySelectorAll('.r-item')];
  assert.equal(rows.length, 61, `窗口 218..279 共 61 行，实际 ${rows.length}`);
  assert.equal(rows[0].dataset.id, '217', '窗口起点跟随滚动位置');
  assert.ok(
    rows.every((row) => row.style.top === `${(Number(row.dataset.id) + 1) * 21}px`),
    '行按扁平下标绝对定位（条目行 = id + 1，标题行占 0 号）',
  );

  // 滚到末尾（内容高 451*21，最大 scrollTop = 9471 - 视口 420 = 9051）：行窗口 [411, 451)
  results.scrollTop = 9051;
  results.dispatchEvent(new dom.window.Event('scroll'));
  rows = [...card.querySelectorAll('.r-item')];
  assert.equal(rows.length, 40, `末尾窗口 411..451 共 40 行，实际 ${rows.length}`);
  assert.equal(rows[39].dataset.id, '449', '最后一行是 id 449');
});

test('导航跳到未挂载区间：scrollTop 定位后窗口重算，目标行成为 active', () => {
  const { dom, doc } = boot();
  const items = Array.from({ length: 450 }, (_, i) => ({
    id: i,
    line: i + 1,
    column: 1,
    preview: 'foo',
    prefix: 0,
    matchLen: 3,
  }));
  deliver(dom, {
    type: 'record',
    record: { ...record(1, 'foo'), groups: [{ label: 'a.ts', detail: 'src/a.ts', items }], total: 450 },
  });
  const results = doc.getElementById('results');
  const rowsEl = doc.querySelector('.rows');
  stubVirtualGeometry(doc, results, rowsEl, 451);
  results.dispatchEvent(new dom.window.Event('scroll'));
  assert.equal(doc.querySelectorAll('.r-item').length, 39, '前置条件：id 440 还不在窗口里');

  deliver(dom, { type: 'current', recordId: 1, index: 440 });

  const rows = [...doc.querySelectorAll('.r-item')];
  assert.ok(rows.length < 450, '导航只重排窗口，不会把 450 行全挂上');
  const active = doc.querySelector('.r-item.active');
  assert.ok(active, '目标行要被选中');
  assert.equal(active.dataset.id, '440', '选中的正是 id 440 那行');
});

test('样式表不常驻预留滚动条槽位，滚动条用细样式（0.1.51）', () => {
  const raw = fs.readFileSync(new URL('../media/panel.css', import.meta.url), 'utf8');
  // 剥掉块注释再断言：注释里会引用旧写法做说明，不能算数
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  // 常驻槽位（scrollbar-gutter: stable）会把高级区右对齐的按钮与搜索行错开
  // 一个滚动条宽度，还会在结果区旁边留一条空白竖带——改为按需出现。
  assert.doesNotMatch(css, /scrollbar-gutter:\s*stable/, '不允许再常驻预留滚动条槽位');
  assert.doesNotMatch(css, /overflow-y:\s*scroll/, '不允许任何区域常驻显示滚动条');
  assert.match(css, /overflow-anchor:\s*none/, '内容高度突变时不要触发滚动锚定');
  assert.match(
    raw,
    /\.advanced::-webkit-scrollbar[\s\S]*?\.results::-webkit-scrollbar/,
    '高级区与结果区滚动条要有细样式'
  );
});

test('高级按钮只显示文字，箭头样式只留给结果分组（0.1.52）', () => {
  const { doc } = boot();
  const button = doc.getElementById('btnAdvanced');
  assert.equal(button.querySelector('.chev'), null, '高级按钮不应再有箭头');
  assert.equal(button.textContent.trim(), '高级', '只显示文字');

  // .chev 样式保留给结果分组头的小箭头
  const css = fs.readFileSync(new URL('../media/panel.css', import.meta.url), 'utf8');
  const chevRule = css.match(/\n\.chev \{([\s\S]*?)\n\}/);
  assert.ok(chevRule, '结果分组的箭头样式应保留');
  assert.match(chevRule[1], /flex:\s*none/, '箭头不能被 flex 压缩');
  assert.match(chevRule[1], /width:/, '箭头要有确定的盒尺寸，旋转后不越界');
});

const enHtml = panelHtml({
  styleCss: '.fsearch{color:red}',
  scriptUri: 'panel.js',
  cspSource: 'vscode-webview://test',
  nonce: 'testnonce',
  version: '0.0.0-test',
  t: (text, vars) => translate('en', text, vars),
  i18n: dictionary('en'),
  lang: 'en',
});

test('英文面板：静态文案与 lang 属性都是英文', () => {
  const { doc } = boot(enHtml);
  assert.equal(doc.documentElement.getAttribute('lang'), 'en');
  assert.equal(doc.title, 'Search');
  assert.equal(doc.getElementById('btnSearch').textContent, 'Search');
  assert.equal(doc.getElementById('btnSearchAll').textContent, 'All');
  assert.equal(doc.getElementById('query').placeholder, 'Text to find');
  assert.equal(doc.querySelector('.btn-text').textContent, 'Advanced');
  assert.equal(doc.querySelector('#advanced legend').textContent, 'Search mode');
  assert.equal(doc.getElementById('results').textContent.includes('Type something and press Enter'), true);
});

test('英文面板：动态文案经注入的字典翻译出来', () => {
  const { dom, doc } = boot(enHtml);
  deliver(dom, {
    type: 'record',
    record: record(1, 'foo', 1, { scopeLabel: 'Current document', optionsLabel: 'Normal' }),
  });

  const card = doc.querySelector('.record');
  assert.equal(card.querySelector('.rec-total').textContent, '1 hits');
  assert.equal(card.querySelector('.rec-files').textContent, '1 files');
  assert.equal(card.querySelector('.rec-ms').textContent, '4 ms');
  assert.equal(card.querySelector('.g-count').textContent, '1 hits');
  assert.equal(card.querySelector('.r-item').title, 'Line 1, column 3');
  assert.match(doc.getElementById('histSummary').textContent, /Results \(1\)/);
});

test('英文面板：高级按钮切换后显示 Less', () => {
  const { dom, doc } = boot(enHtml);
  const button = doc.getElementById('btnAdvanced');
  click(dom, button);
  assert.equal(doc.querySelector('.btn-text').textContent, 'Less');
  click(dom, button);
  assert.equal(doc.querySelector('.btn-text').textContent, 'Advanced');
});

test('中文面板不注入字典，前端回退中文原文', () => {
  const { doc } = boot();
  const holder = doc.getElementById('flyI18n');
  assert.equal(JSON.parse(holder.textContent || '{}').constructor, Object);
  assert.deepEqual(JSON.parse(holder.textContent || '{}'), {});
});

test('首屏记录直接渲染：重载窗口后不再先空一帧', () => {
  const seeded = panelHtml({
    styleCss: '.fsearch{color:red}',
    scriptUri: 'panel.js',
    cspSource: 'vscode-webview://test',
    nonce: 'testnonce',
    version: '0.0.0-test',
    // 数组本身就是展示顺序：最新的在前
    bootstrap: [record(2, 'bar'), record(1, 'foo')],
  });

  const { doc } = boot(seeded);
  const cards = doc.querySelectorAll('.record');
  assert.equal(cards.length, 2);
  assert.match(cards[0].querySelector('.rec-q').textContent, /bar/, '最新的排最前');
  assert.match(cards[1].querySelector('.rec-q').textContent, /foo/);
  assert.match(doc.getElementById('histSummary').textContent, /搜索结果（2）/);
  assert.equal(doc.getElementById('results').textContent.includes('输入内容后按 Enter 开始搜索'), false);
});

test('首屏记录里的 </div> 不会提前闭合容器', () => {
  const nasty = record(3, 'div');
  nasty.groups[0].items[0].preview = '  </div><script>alert(1)</script>  ';
  const seeded = panelHtml({
    styleCss: '.fsearch{color:red}',
    scriptUri: 'panel.js',
    cspSource: 'vscode-webview://test',
    nonce: 'testnonce',
    version: '0.0.0-test',
    bootstrap: [nasty],
  });

  const { doc } = boot(seeded);
  assert.equal(doc.querySelectorAll('.record').length, 1);
  assert.equal(doc.querySelectorAll('script').length, 1, '只应有宿主注入的那个脚本标签');
  assert.equal(doc.querySelector('.r-code').textContent.includes('</div>'), true);
});

test('高度调节已整体移除：无分隔条、无上限变量，布局纯 flex（0.1.56）', () => {
  const { doc, posted } = boot();
  assert.equal(doc.getElementById('splitter'), null, '分隔条元素已删');
  const pane = doc.querySelector('.results-pane');
  assert.ok(pane, '结果区容器还在');
  assert.equal(pane.getAttribute('style'), null, '结果区不再内联任何上限变量');
  assert.equal(posted.filter((message) => message.type === 'layout').length, 0, '启动时不上报布局');

  const css = fs.readFileSync(path.join(root, '..', 'media', 'panel.css'), 'utf8');
  assert.doesNotMatch(css, /\.splitter/, '分隔条样式已删');
  assert.doesNotMatch(css, /--fsearch-adv/, '高级区记忆高度变量已删');
  assert.doesNotMatch(css, /max-height:\s*var\(/, '结果区不再有 JS 写入的上限');
  // 高级区不可压缩（0.1.57）：shrink 1 会在结果条目展开时的收缩阶段
  // 被按比例分走高度，表现为「展开结果把高级区顶起来」。收缩量必须
  // 全部由结果区内部滚动吸收。
  assert.match(css, /\.advanced\s*\{[^}]*flex:\s*0 0 auto/s, '高级区不允许被结果区挤压');

  const js = fs.readFileSync(path.join(root, '..', 'media', 'panel.js'), 'utf8');
  assert.doesNotMatch(js, /type:\s*'layout'/, '前端不再上报布局消息');
  assert.doesNotMatch(js, /requestAnimationFrame/, '不再需要 rAF 重算布局');
  // 0.1.87 起 ResizeObserver 回来了，但用途变了：监视结果区尺寸（拖分隔条、
  // 折叠卡片）来重算虚拟窗口，与当年的「观察器重算 flex 布局」无关。
  assert.match(js, /ResizeObserver/);
});

test('空面板开合高级后首条搜索结果到达：is-empty 摘除（Linux 偶现不撑满的回归）', () => {
  const { dom, doc } = boot();
  const pane = doc.querySelector('.results-pane');
  assert.ok(pane.classList.contains('is-empty'), '空面板起始为空态');
  // 0.1.46 的洞是 pushRecord 漏调 updateEmpty；开合高级本身已不再触碰布局
  click(dom, doc.getElementById('btnAdvanced'));
  click(dom, doc.getElementById('btnAdvanced'));
  deliver(dom, { type: 'record', record: record(1, 'needle'), replace: false });
  assert.ok(!pane.classList.contains('is-empty'), '首条结果到达后摘掉空态，flex 恢复拉伸');
  assert.equal(pane.getAttribute('style'), null, '没有上限变量需要抬升');
});


test('首屏条件直接填进输入框，不用等宿主推送', () => {
  const seeded = panelHtml({
    styleCss: '.fsearch{color:red}',
    scriptUri: 'panel.js',
    cspSource: 'vscode-webview://test',
    nonce: 'testnonce',
    version: '0.0.0-test',
    bootstrapState: {
      query: 'needle',
      replace: 'thread',
      mode: 'regex',
      caseSensitive: true,
      wholeWord: false,
      dotAll: true,
      wrapAround: false,
      inSelection: false,
      direction: 'up',
      advanced: true,
      filters: 'src/**/*.ts',
    },
  });

  const { doc } = boot(seeded);
  assert.equal(doc.getElementById('query').value, 'needle');
  assert.equal(doc.getElementById('replace').value, 'thread');
  assert.equal(doc.getElementById('filters').value, 'src/**/*.ts');
  assert.equal(doc.getElementById('advanced').hidden, false, '上次展开过就保持展开');
  assert.equal(doc.querySelector('input[name="mode"]:checked').value, 'regex');
  // 方向选项已删（0.1.52）：旧存档里的 direction 字段被忽略，界面不再有 dir 单选
  assert.equal(doc.querySelector('input[name="dir"]'), null, '方向选项已删');
  assert.equal(doc.getElementById('caseSensitive').checked, true);
  assert.equal(doc.getElementById('wrapAround').checked, false);
});

test('输入查询词会防抖上报给宿主，便于记住条件', async () => {
  const { dom, doc, posted } = boot();
  const input = doc.getElementById('query');
  input.value = 'abc';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  assert.equal(posted.some((message) => message.type === 'state'), false, '同一帧内先不发');
  await new Promise((resolve) => setTimeout(resolve, 350));
  const message = posted.filter((item) => item.type === 'state').pop();
  assert.ok(message, '防抖后应发出 state');
  assert.equal(message.state.query, 'abc');
});

test('CSS 布局约定：定高不滚动，结果区吃满剩余高度（纯 flex，无上限）', () => {
  const css = fs.readFileSync(path.join(root, '..', 'media', 'panel.css'), 'utf8');

  // html 定高不滚动：否则 body 的 overflow 会被传播到视口，宽度会随内容高度变化
  assert.match(css, /html\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/s);
  // 面板整体不再滚动（滚动交给结果区与高级区），高度由 flex 分配
  assert.match(css, /body\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.fsearch\s*\{[^}]*height:\s*100%/s);
  // 结果区与高级区是独立滚动容器，滚动条按需出现（0.1.51 起不常驻槽位）
  assert.match(css, /\.results\s*\{[^}]*overflow-y:\s*auto/s);
  // 高级区展开后要能自己让位，否则面板固定高度时会被裁掉
  assert.match(css, /\.advanced\s*\{[^}]*overflow-y:\s*auto/s);
  // 结果区必须可拉伸：写死高度（如 42vh）会让面板再高也留一大片空白
  assert.match(css, /\.results-pane\s*\{[^}]*flex:\s*1 1 auto/s);
  assert.doesNotMatch(css, /max-height:\s*var\(--fsearch-max/, '上限变量已随分隔条一起删除');
  // 空态不参与拉伸，否则空面板里结果区会白占大半屏
  assert.match(css, /\.results-pane\.is-empty\s*\{[^}]*flex:\s*0 1 auto/s);
  // 内边距必须留在 .fsearch 上
  assert.doesNotMatch(css, /body\s*\{[^}]*padding:\s*8px 10px/s);
  assert.match(css, /\.fsearch\s*\{[^}]*padding:\s*8px 10px 10px/s);
});

test('空面板只显示一条空提示', () => {
  const { doc } = boot();
  const empties = doc.querySelectorAll('#results > .empty');
  assert.equal(empties.length, 1, '骨架里那条要复用，不能再 createElement 一条');
});

/* ---------- 流式插入：先落「搜索中」卡片，再逐文件追加 ---------- */

/** 宿主在搜索一开始推进来的空卡片。 */
function pendingRecord(id, query) {
  return {
    id,
    query,
    scope: 'files',
    scopeLabel: '在文件中',
    optionsLabel: '普通',
    groups: [],
    total: 0,
    fileCount: 0,
    elapsed: 0,
    truncated: false,
    time: Date.now(),
    totalBytes: 0,
    pending: true,
  };
}

function hit(id, line, text = 'needle') {
  return { id, line, column: 1, preview: text, prefix: 0, matchLen: 6 };
}

function groupOf(label, detail, items) {
  return { label, detail, items };
}

function stats(extra = {}) {
  return {
    total: 0,
    fileCount: 0,
    elapsed: 0,
    totalBytes: 0,
    truncated: false,
    pending: true,
    ...extra,
  };
}

test('搜索一开始就插入一条「搜索中」记录，正文不显示「没有匹配」', () => {
  const { dom, doc } = boot();
  deliver(dom, { type: 'record', record: pendingRecord(7, 'needle') });

  const card = doc.querySelector('.record');
  assert.ok(card, '搜索一开始卡片就该在列表里');
  assert.match(card.querySelector('.rec-q').textContent, /needle/);
  assert.equal(card.querySelector('.rec-total').textContent, '0 处');
  assert.equal(card.querySelector('.rec-files').textContent, '0 文件');
  assert.ok(card.querySelector('.rec-pending'), '正文末尾应有「搜索中」提示');
  assert.equal(card.querySelector('.rec-body > .empty'), null, '进行中不该显示「没有匹配」');
  assert.equal(card.querySelector('.rec-body').hidden, false, '进行中的卡片默认展开');
});

test('每搜完一个文件就把结果追加进同一张卡片，折叠条统计实时刷新', () => {
  const { dom, doc } = boot();
  deliver(dom, { type: 'record', record: pendingRecord(8, 'needle') });
  const card = doc.querySelector('.record');
  const body = card.querySelector('.rec-body');

  deliver(dom, {
    type: 'recordGroups',
    recordId: 8,
    groups: [groupOf('a.ts', 'src/a.ts', [hit(0, 3)])],
    ...stats({ total: 1, fileCount: 1, elapsed: 12, totalBytes: 2048 }),
  });

  assert.equal(card.querySelectorAll('.v-head').length, 1, '第一个文件的分组要立刻出现');
  assert.equal(card.querySelector('.rec-total').textContent, '1 处');
  assert.equal(card.querySelector('.rec-files').textContent, '1 文件');
  assert.equal(card.querySelector('.rec-ms').textContent, '12 ms');
  assert.match(card.querySelector('.rec-size').textContent, /2\.0 KB/);
  assert.ok(card.querySelector('.rec-pending'), '还有文件没搜完，「搜索中」要继续显示');
  assert.equal(
    body.lastElementChild.className.includes('rec-pending'),
    true,
    '「搜索中」那行始终钉在末尾，新分组插在它前面',
  );
  assert.equal(doc.querySelectorAll('.record').length, 1, '追加不能新开卡片');

  // 用户折叠了第一个文件，后续追加不能把它顶回展开
  click(dom, card.querySelector('.v-head'));
  assert.equal(
    card.querySelector('.v-head').getAttribute('aria-expanded'),
    'false',
  );

  deliver(dom, {
    type: 'recordGroups',
    recordId: 8,
    groups: [groupOf('b.ts', 'src/b.ts', [hit(1, 9)])],
    ...stats({ total: 2, fileCount: 2, elapsed: 20, totalBytes: 4096 }),
  });

  assert.equal(card.querySelectorAll('.v-head').length, 2);
  assert.equal(
    card.querySelector('.v-head').getAttribute('aria-expanded'),
    'false',
    '已折叠的分组保持折叠',
  );
  assert.equal(card.querySelector('.rec-total').textContent, '2 处');
  assert.equal(card.querySelector('.rec-files').textContent, '2 文件');
  assert.equal(body.lastElementChild.className.includes('rec-pending'), true);
});

test('后到的文件按路径插到对应位置，而不是一律追加到末尾', () => {
  const { dom, doc } = boot();
  deliver(dom, { type: 'record', record: pendingRecord(12, 'needle') });
  const card = doc.querySelector('.record');
  // 元素复用后行的显示顺序由绝对定位 top 表达（DOM 追加顺序不再有意义）：
  // 按 top 排序后取标题文字才是屏幕上的顺序
  const labels = () =>
    [...card.querySelectorAll('.v-head')]
      .sort((x, y) => parseInt(x.style.top, 10) - parseInt(y.style.top, 10))
      .map((el) => el.querySelector('.g-label').textContent);

  // 并行批次里 zzz.ts 先扫完：列表里它暂时排第一
  deliver(dom, {
    type: 'recordGroups',
    recordId: 12,
    groups: [groupOf('zzz.ts', 'src/zzz.ts', [hit(0, 1)])],
    inserts: [0],
    ...stats({ total: 1, fileCount: 1 }),
  });
  assert.deepEqual(labels(), ['zzz.ts']);

  // a.ts 后到，但路径更靠前：插到 0，而不是追加到尾巴
  deliver(dom, {
    type: 'recordGroups',
    recordId: 12,
    groups: [groupOf('a.ts', 'src/a.ts', [hit(1, 2)])],
    inserts: [0],
    ...stats({ total: 2, fileCount: 2 }),
  });
  assert.deepEqual(labels(), ['a.ts', 'zzz.ts'], '后到的文件要插到它该在的位置');

  // m.ts 落在中间
  deliver(dom, {
    type: 'recordGroups',
    recordId: 12,
    groups: [groupOf('m.ts', 'src/m.ts', [hit(2, 3)])],
    inserts: [1],
    ...stats({ total: 3, fileCount: 3 }),
  });
  assert.deepEqual(labels(), ['a.ts', 'm.ts', 'zzz.ts']);

  // 「搜索中」那行仍然钉在最后，插在多前面都一样
  assert.equal(
    card.querySelector('.rec-body').lastElementChild.className.includes('rec-pending'),
    true,
  );
  // 没有下标信息（老宿主）时退化为尾插，不丢结果
  deliver(dom, {
    type: 'recordGroups',
    recordId: 12,
    groups: [groupOf('zz2.ts', 'src/zz2.ts', [hit(3, 4)])],
    ...stats({ total: 4, fileCount: 4 }),
  });
  assert.deepEqual(labels(), ['a.ts', 'm.ts', 'zzz.ts', 'zz2.ts']);
});

test('搜索结束：摘掉「搜索中」并落最终统计；一条没命中时显示「没有匹配」', () => {
  const { dom, doc } = boot();
  deliver(dom, { type: 'record', record: pendingRecord(9, 'needle') });
  const card = doc.querySelector('.record');

  deliver(dom, {
    type: 'recordGroups',
    recordId: 9,
    groups: [groupOf('a.ts', 'src/a.ts', [hit(0, 3)])],
    ...stats({ total: 1, fileCount: 1, elapsed: 15, totalBytes: 1024 }),
  });
  deliver(dom, {
    type: 'recordDone',
    record: {
      ...pendingRecord(9, 'needle'),
      groups: [groupOf('a.ts', 'src/a.ts', [hit(0, 3)])],
      total: 1,
      fileCount: 1,
      elapsed: 42,
      totalBytes: 1024,
      pending: false,
    },
  });

  assert.equal(card.querySelector('.rec-pending'), null, '结束后不能还挂着转圈');
  assert.equal(card.querySelector('.rec-ms').textContent, '42 ms');
  assert.equal(card.querySelector('.rec-body > .empty'), null, '有命中就不显示「没有匹配」');

  // 一条都没命中的搜索：收尾后正文给出「没有匹配」
  deliver(dom, { type: 'record', record: pendingRecord(10, 'nothing') });
  const empty = doc.querySelector('.record[data-id="10"]');
  deliver(dom, {
    type: 'recordDone',
    record: { ...pendingRecord(10, 'nothing'), elapsed: 7, pending: false },
  });
  assert.equal(empty.querySelector('.rec-pending'), null);
  assert.equal(empty.querySelector('.rec-body > .empty').textContent, '没有匹配');
});

test('收尾时分组数与增量对不上（面板中途重载）按整条记录重建正文', () => {
  const { dom, doc } = boot();
  deliver(dom, { type: 'record', record: pendingRecord(11, 'needle') });
  const card = doc.querySelector('.record');
  assert.equal(card.querySelectorAll('.v-head').length, 0);

  // 模拟增量消息全丢：只收到最终的 recordDone
  deliver(dom, {
    type: 'recordDone',
    record: {
      ...pendingRecord(11, 'needle'),
      groups: [
        groupOf('a.ts', 'src/a.ts', [hit(0, 1), hit(1, 5)]),
        groupOf('b.ts', 'src/b.ts', [hit(2, 7)]),
      ],
      total: 3,
      fileCount: 2,
      elapsed: 33,
      pending: false,
    },
  });

  assert.equal(card.querySelectorAll('.v-head').length, 2, '缺的分组要按记录补回来');
  assert.equal(card.querySelectorAll('.r-item').length, 3);
  assert.equal(card.querySelector('.rec-total').textContent, '3 处');
  assert.equal(card.querySelector('.rec-pending'), null);
});

test('截断的记录给出「统计完整数量」入口，回传总数后换成真值', () => {
  const { dom, posted, doc } = boot();
  deliver(dom, {
    type: 'history',
    records: [record(1, 'qqmusic', 1, { truncated: true, total: 20000, exactAvailable: true })],
  });

  const card = doc.querySelector('.record');
  // 截断时总数必须带 +，不能伪装成精确值
  assert.equal(card.querySelector('.rec-total').textContent, '20,000+ 处');
  const notice = card.querySelector('.notice');
  assert.ok(notice, '截断要给出提示');
  assert.ok(notice.textContent.includes('只列出了前'), notice.textContent);

  const button = notice.querySelector('.notice-btn');
  assert.ok(button, '提示里要有「统计完整数量」按钮');
  click(dom, button);
  assert.equal(posted.at(-1).type, 'requestExactCount');
  assert.equal(posted.at(-1).recordId, 1);

  deliver(dom, {
    type: 'exactCount',
    recordId: 1,
    total: 347656,
    approximate: false,
    files: 21,
    skipped: 0,
    ms: 753,
  });
  assert.equal(doc.querySelector('.notice-btn'), null, '统计完按钮要收掉');
  assert.ok(doc.querySelector('.notice').textContent.includes('347,656'));
  assert.ok(doc.querySelector('.rec-total').textContent.includes('347,656'), '卡片头也要变成真值');
});

test('重载后从历史恢复的截断记录不给按钮（没有查询条件可重跑）', () => {
  const { dom, doc } = boot();
  deliver(dom, {
    type: 'history',
    records: [record(2, 'qqmusic', 1, { truncated: true, total: 20000, exactAvailable: false })],
  });
  assert.ok(doc.querySelector('.notice'), '提示还在');
  assert.equal(doc.querySelector('.notice-btn'), null, '但不该给一个点了没反应的按钮');
});

test('上限提示与结果行左对齐：padding-left 必须和 .r-item 相同', () => {
  const raw = fs.readFileSync(new URL('../media/panel.css', import.meta.url), 'utf8');
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const body = (name) => {
    const m = css.match(new RegExp(`\\n\\${name} \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(m, `${name} 规则应存在`);
    return m[1];
  };
  /** 从 padding 简写里取左右值（1/2/3/4 值语法）。 */
  const padLeft = (sel) => {
    const decl = body(sel).split('padding:')[1];
    assert.ok(decl, `${sel} 应有 padding`);
    const parts = decl.split(';')[0].trim().split(' ').filter(Boolean);
    if (parts.length === 1) return parts[0];
    if (parts.length === 4) return parts[3];
    return parts[1];
  };
  // 虚拟滚动后行是绝对定位，宽度必须显式撑满：窄行 hover/active 高亮才是一整条
  assert.ok(body('.r-item').includes('min-width: 100%'), '行宽要占满容器');
  assert.ok(body('.r-item').includes('width: max-content'), '宽行时盒子要跟着内容走');

  const item = padLeft('.r-item');
  assert.equal(
    padLeft('.notice'),
    item,
    '「共 N 处；已列出前 M 条」要压在结果条目的左边线上，不能比它更靠左',
  );
  assert.equal(padLeft('.rec-pending'), item, '进行中的提示行同理');
});

/** 多组几何桩：悬浮标题条按「视口顶落在哪一行」判断，rect 必须可控。
 * 扁平结构下只有一张卡片一个行容器：top = -scrollTop，总高 = 行数 × 21。 */
function stubStickyGeometry(doc, results, rowsEl, totalRows) {
  Object.defineProperty(results, 'scrollTop', {
    value: 0,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(results, 'clientHeight', {
    get: () => 420,
    configurable: true,
  });
  results.getBoundingClientRect = () => ({ top: 0, bottom: 420, height: 420 });
  rowsEl.getBoundingClientRect = () => {
    const st = results.scrollTop;
    return { top: -st, bottom: totalRows * 21 - st, height: totalRows * 21 };
  };
}

test('悬浮文件标题：滚过组头后显示当前文件，点击折叠，换组跟着换', () => {
  const { dom, doc } = boot();
  const mk = (id0, n) =>
    Array.from({ length: n }, (_, i) => ({
      id: id0 + i,
      line: i + 1,
      column: 1,
      preview: 'foo',
      prefix: 0,
      matchLen: 3,
    }));
  const groups = [
    { label: 'a.log', detail: 'logs/a.log', items: mk(0, 50) },
    { label: 'b.log', detail: 'logs/b.log', items: mk(1000, 50) },
  ];
  deliver(dom, {
    type: 'record',
    record: { ...record(1, 'foo'), groups, total: 100 },
  });
  const results = doc.getElementById('results');
  // 扁平行数组：2 个标题行 + 100 条目行 = 102 行；标题行下标 0 和 51
  const rowsEl = doc.querySelector('.rows');
  stubStickyGeometry(doc, results, rowsEl, 102);
  results.dispatchEvent(new dom.window.Event('scroll'));

  // 初始：a.log 的标题行就在视口顶（占 0..21，bottom 21 > 0.5），悬浮条不显示
  let bar = doc.querySelector('.sticky-head');
  assert.ok(bar, '悬浮条元素应已创建');
  assert.equal(bar.hidden, true, '组头自己可见时不显示悬浮条');

  // 滚过 a.log 的标题行（21px）：悬浮条出现，指示 a.log（结构与标题行同款）
  results.scrollTop = 500;
  results.dispatchEvent(new dom.window.Event('scroll'));
  bar = doc.querySelector('.sticky-head');
  assert.equal(bar.hidden, false, '组头滚出视口顶后要显示悬浮条');
  assert.equal(bar.querySelector('.g-label').textContent, 'a.log');
  assert.equal(bar.querySelector('.detail').textContent, 'logs/a.log');
  assert.equal(bar.querySelector('.g-count').textContent, '50 处');
  assert.ok(bar.querySelector('.chev'), '折叠指示与分组头同款');

  // 点击悬浮条 = 折叠当前分组，并把视口定位到该标题行的文档位置
  // （b.log 标题行的扁平行下标是 51 → 文档 top = 51*21 = 1071）
  results.scrollTop = 1200;
  results.dispatchEvent(new dom.window.Event('scroll'));
  bar = doc.querySelector('.sticky-head');
  assert.equal(bar.querySelector('.g-label').textContent, 'b.log', '此时悬浮的是 b.log');
  click(dom, bar);
  assert.ok(
    [...doc.querySelectorAll('.v-head')].some(
      (h) => h.getAttribute('aria-expanded') === 'false',
    ),
    '点击悬浮条要折叠 b.log 分组',
  );
  assert.equal(results.scrollTop, 1071, '折叠后视口顶对齐到该标题行的文档位置');
  assert.equal(doc.querySelector('.sticky-head').hidden, true, '折叠后悬浮条收起');

  // 继续滚进未折叠的 a.log：悬浮条换成 a.log
  results.scrollTop = 300;
  results.dispatchEvent(new dom.window.Event('scroll'));
  bar = doc.querySelector('.sticky-head');
  assert.equal(bar.hidden, false, '滚进第一个文件要显示悬浮条');
  assert.equal(bar.querySelector('.g-label').textContent, 'a.log', '指示的文件要跟着换');
});
