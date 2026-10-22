import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeHistory, encodeHistory } from './.tmp/history.mjs';

function item(id, line, column, preview, matchLen = 3) {
  return { id, line, column, preview, prefix: Math.max(0, column - 1), matchLen };
}

function record(overrides = {}) {
  return {
    id: 7,
    query: 'foo',
    scope: 'files',
    scopeLabel: '全部文件',
    optionsLabel: '普通',
    groups: [
      {
        label: 'a.ts',
        detail: 'src/a.ts',
        items: [item(0, 3, 7, 'const foo = 1;'), item(1, 9, 2, 'foo()')],
      },
      {
        label: 'b.ts',
        detail: 'src/b.ts',
        items: [item(2, 4, 1, 'foo bar')],
        truncated: true,
      },
    ],
    total: 3,
    fileCount: 2,
    elapsed: 12,
    truncated: false,
    time: 1700000000000,
    totalBytes: 42577,
    ...overrides,
  };
}

function encodeOne(rec, files = ['file:///a.ts', 'file:///b.ts'], ends = [[3, 10], [9, 5], [4, 4]]) {
  return encodeHistory([{ record: rec, files, ends }]);
}

test('encode → decode 保留查询、分组、条目与文件', () => {
  const stored = encodeOne(record());
  const decoded = decodeHistory({ v: 1, r: stored });

  assert.equal(decoded.length, 1);
  const { record: restored, files, ends } = decoded[0];
  assert.equal(restored.id, 7);
  assert.equal(restored.query, 'foo');
  assert.equal(restored.scope, 'files');
  assert.equal(restored.scopeLabel, '全部文件');
  assert.equal(restored.total, 3);
  assert.equal(restored.fileCount, 2);
  assert.equal(restored.totalBytes, 42577);
  assert.deepEqual(files, ['file:///a.ts', 'file:///b.ts']);
  assert.deepEqual(
    restored.groups.map((group) => group.label),
    ['a.ts', 'b.ts'],
  );
  assert.deepEqual(
    restored.groups[0].items.map((entry) => [entry.line, entry.column, entry.preview]),
    [
      [3, 7, 'const foo = 1;'],
      [9, 2, 'foo()'],
    ],
  );
  assert.equal(restored.groups[1].truncated, true);
  assert.deepEqual(ends[0], [3, 10]);
  assert.deepEqual(ends[2], [4, 4]);
});

test('解码后 id 按顺序连续编号，作为 hits 下标用', () => {
  const decoded = decodeHistory({ v: 1, r: encodeOne(record()) });
  const ids = decoded[0].record.groups.flatMap((group) => group.items.map((entry) => entry.id));
  assert.deepEqual(ids, [0, 1, 2]);
});

test('超出预算时先丢最旧的记录，保留最新的', () => {
  const newest = record({ id: 9, query: 'newest' });
  const oldest = record({ id: 8, query: 'oldest' });
  const inputs = [
    { record: newest, files: ['file:///a.ts', 'file:///b.ts'], ends: [[3, 10], [9, 5], [4, 4]] },
    { record: oldest, files: ['file:///a.ts', 'file:///b.ts'], ends: [[3, 10], [9, 5], [4, 4]] },
  ];
  const one = JSON.stringify({ v: 1, r: encodeHistory(inputs, 1e9) }).length;
  const stored = encodeHistory(inputs, Math.floor(one * 0.6));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].q, 'newest');
});

test('单条记录超预算时砍分组条目并标成 truncated，仍可解码', () => {
  const big = record({
    groups: [
      {
        label: 'big.ts',
        detail: 'src/big.ts',
        items: Array.from({ length: 400 }, (_, index) =>
          item(index, index + 1, 1, 'x'.repeat(200)),
        ),
      },
    ],
    total: 400,
    fileCount: 1,
  });
  const ends = Array.from({ length: 400 }, (_, index) => [index + 1, 2]);
  const stored = encodeHistory([{ record: big, files: ['file:///big.ts'], ends }], 20000);
  assert.equal(stored.length, 1);
  assert.ok(stored[0].g[0].it.length < 400, '应砍掉一部分条目');
  assert.equal(stored[0].g[0].tr, true);
  assert.equal(stored[0].tr, true);

  const decoded = decodeHistory({ v: 1, r: stored });
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].record.truncated, true);
  assert.ok(decoded[0].record.total > 0);
});

test('数据损坏 / 版本不符时返回空数组，不抛异常', () => {
  assert.deepEqual(decodeHistory(undefined), []);
  assert.deepEqual(decodeHistory(null), []);
  assert.deepEqual(decodeHistory('nope'), []);
  assert.deepEqual(decodeHistory({}), []);
  assert.deepEqual(decodeHistory({ v: 2, r: [] }), []);
  assert.deepEqual(decodeHistory({ v: 1, r: 'x' }), []);
  assert.deepEqual(decodeHistory({ v: 1, r: [{ id: 1 }] }), []);
  assert.deepEqual(
    decodeHistory({ v: 1, r: [{ v: 1, id: 1, q: 'x', g: [{ l: 'a', d: 'a', it: [['bad']] }] }] }),
    [],
  );
});

test('空记录列表编码后是空数组', () => {
  assert.deepEqual(encodeHistory([]), []);
  assert.deepEqual(decodeHistory({ v: 1, r: [] }), []);
});
