import assert from 'node:assert/strict';
import test from 'node:test';
import { PREVIEW_FULL_LIMIT, makeItem } from './.tmp/preview.mjs';

test('预览：短行原样返回，prefix 指向命中的 UTF-16 列', () => {
  const text = 'const token = 1;';
  const item = makeItem(0, text, 9, 6, 5);
  assert.equal(item.preview, text);
  assert.equal(item.line, 10);
  assert.equal(item.column, 7);
  assert.equal(item.preview.slice(item.prefix, item.prefix + item.matchLen), 'token');
});

test('预览：接近上限的长行也完整保留，不再从行首省略', () => {
  // 旧实现 160 字符就开窗，行首会被换成「…」；内核源码里长表达式接近上千字符
  const text = 'if (' + 'a'.repeat(PREVIEW_FULL_LIMIT - 40) + ') { doThing(marker); }';
  const column = text.indexOf('marker');
  const item = makeItem(0, text, 0, column, 6);
  assert.equal(item.preview, text, '整行都要在，行首缩进/前导代码不能被裁');
  assert.equal(item.preview.startsWith('if ('), true);
  assert.equal(item.preview.slice(item.prefix, item.prefix + item.matchLen), 'marker');
});

test('预览：超出上限但命中在前段，保开头只截尾', () => {
  const text = 'x'.repeat(PREVIEW_FULL_LIMIT + 5000);
  const item = makeItem(0, text, 0, 100, 3);
  assert.equal(item.preview.length, PREVIEW_FULL_LIMIT + 1, '截到上限 + 一个省略号');
  assert.equal(item.preview.startsWith('xxx'), true, '行首必须保留');
  assert.equal(item.preview.endsWith('…'), true);
  assert.equal(item.prefix, 100, '列号不受截断影响');
});

test('预览：命中在超长行后段时开窗，窗口内含命中全文', () => {
  const text = 'y'.repeat(60000) + 'needle' + 'z'.repeat(1000);
  const column = text.indexOf('needle');
  const item = makeItem(0, text, 0, column, 6);
  assert.equal(item.preview.startsWith('…'), true);
  assert.equal(item.preview.slice(item.prefix, item.prefix + item.matchLen), 'needle');
  assert.ok(item.preview.length <= 402, '窗口宽度受控，不会把整行搬给面板');
});

test('预览：行尾 CR 被剥掉，matchLen 不越界', () => {
  const item = makeItem(0, 'abc token\r', 0, 4, 999);
  assert.equal(item.preview, 'abc token');
  assert.equal(item.prefix, 4);
  assert.equal(item.matchLen, 5, 'matchLen 截到行尾');
});
