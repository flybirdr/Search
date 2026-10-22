import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INPUT_HISTORY_LIMIT,
  emptyInputHistory,
  normalizeInputHistory,
  pushInput,
} from './.tmp/inputHistory.mjs';

test('输入历史：新值排最前，重复值提到最前而不重复', () => {
  const h = emptyInputHistory();
  assert.equal(pushInput(h, 'query', 'alpha'), true);
  assert.equal(pushInput(h, 'query', 'beta'), true);
  assert.deepEqual(h.query, ['beta', 'alpha'], '最近用过的在最前');

  assert.equal(pushInput(h, 'query', 'alpha'), true, '翻回旧词再搜一次要提到最前');
  assert.deepEqual(h.query, ['alpha', 'beta']);

  assert.equal(pushInput(h, 'query', 'alpha'), false, '已经在最前就不算改动');
  assert.deepEqual(h.query, ['alpha', 'beta']);
});

test('输入历史：空串不进历史，三条时间线互不干扰', () => {
  const h = emptyInputHistory();
  assert.equal(pushInput(h, 'query', ''), false);
  pushInput(h, 'filters', '**/*.ts');
  pushInput(h, 'replace', 'foo');
  assert.deepEqual(h.query, []);
  assert.deepEqual(h.filters, ['**/*.ts']);
  assert.deepEqual(h.replace, ['foo']);
  // 同一个词可以同时出现在不同时间线里
  pushInput(h, 'query', 'foo');
  assert.deepEqual(h.query, ['foo']);
  assert.deepEqual(h.replace, ['foo']);
});

test('输入历史：超过上限丢最旧的', () => {
  const h = emptyInputHistory();
  for (let i = 0; i < INPUT_HISTORY_LIMIT + 10; i += 1) {
    pushInput(h, 'query', `q${i}`);
  }
  assert.equal(h.query.length, INPUT_HISTORY_LIMIT);
  assert.equal(h.query[0], `q${INPUT_HISTORY_LIMIT + 9}`, '最新的在最前');
  assert.equal(h.query.at(-1), 'q10', '最旧的 10 条被挤掉');
});

test('输入历史：反序列化容错（旧存档 / 手改 / 类型错）', () => {
  assert.deepEqual(normalizeInputHistory(undefined), emptyInputHistory());
  assert.deepEqual(normalizeInputHistory(null), emptyInputHistory());
  assert.deepEqual(normalizeInputHistory('nope'), emptyInputHistory());
  assert.deepEqual(
    normalizeInputHistory({ query: ['a', 'a', '', 42, 'b'], filters: 'x', replace: ['r'] }),
    { query: ['a', 'b'], filters: [], replace: ['r'] },
    '去重、丢非字符串、空串，非法字段退回空数组',
  );
  assert.deepEqual(
    normalizeInputHistory({ query: new Array(100).fill('dup') }).query,
    ['dup'],
    '重复值只留一条',
  );
});
