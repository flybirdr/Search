import assert from 'node:assert/strict';
import test from 'node:test';
import { dictionary, fill, setLang, t, translate } from './.tmp/i18n-core.mjs';

test('英文翻译会替换占位符', () => {
  assert.equal(translate('en', '未找到匹配 · {ms} ms', { ms: 12 }), 'No matches · 12 ms');
  assert.equal(translate('en', '第 {i} / {n} 处', { i: 2, n: 9 }), '2 / 9');
});

test('中文环境永远返回原文', () => {
  assert.equal(translate('zh', '找到 {n} 处', { n: 3 }), '找到 3 处');
  assert.equal(translate('zh', '没有英文的条目'), '没有英文的条目');
});

test('英文缺条目时回退中文，不返回空串', () => {
  assert.equal(translate('en', '这条文案还没翻译'), '这条文案还没翻译');
});

test('字典只在英文环境有内容', () => {
  assert.deepEqual(dictionary('zh'), {});
  assert.ok(Object.keys(dictionary('en')).length > 50);
});

test('setLang 改变 t() 的默认语言', () => {
  setLang('en');
  assert.equal(t('搜索'), 'Search');
  setLang('zh');
  assert.equal(t('搜索'), '搜索');
});

test('占位符缺失时保留原样，不产生 undefined', () => {
  assert.equal(fill('a {x} b'), 'a {x} b');
  assert.equal(fill('a {x} b', { x: 1 }), 'a 1 b');
});

test('英文表里没有残留中文', () => {
  for (const [key, value] of Object.entries(dictionary('en'))) {
    assert.ok(!/[\u3400-\u9fff]/.test(value), `未翻译：${key} → ${value}`);
  }
});
