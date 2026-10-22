import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ancestorDirs,
  createDirPriorityStore,
  MAX_ENTRIES,
  scoreOf,
} from './.tmp/dirPriority.mjs';

test('ancestorDirs：父目录逐级向上传播，止于工作区根（不含根）', () => {
  const root = path.join(os.tmpdir(), 'prio-root');
  const dirs = ancestorDirs(path.join(root, 'a', 'b', 'c', 'x.ts'), [root]);
  const rels = dirs.map((d) => path.relative(root, d).split(path.sep).join('/'));
  assert.deepEqual(rels, ['a/b/c', 'a/b', 'a'], '父目录链逐级向上，不含根');
});

test('ancestorDirs：取最长匹配根；大小写差异不丢计数（Windows）；不在工作区不记', () => {
  const outer = path.join(os.tmpdir(), 'prio-outer');
  const inner = path.join(outer, 'ws');
  const dirs = ancestorDirs(path.join(inner, 'a', 'x.ts'), [outer, inner]);
  const rels = dirs.map((d) => path.relative(inner, d).split(path.sep).join('/'));
  assert.deepEqual(rels, ['a'], '应按最长匹配根（inner）截断');

  if (process.platform === 'win32') {
    // 盘符/目录大小写因来源而异（workspace.json 重开、doc.uri 等）：
    // 折叠大小写匹配，否则点击静默不计（0.1.118 隐患）
    const mixed = ancestorDirs(
      path.join(inner.toUpperCase(), 'a', 'x.ts'),
      [inner],
    );
    assert.equal(mixed.length, 1, '大小写不同的根也要匹配上');
  }

  const elsewhere = ancestorDirs(path.join(os.tmpdir(), 'other', 'y.ts'), [inner]);
  assert.deepEqual(elsewhere, [], '不在工作区内的文件不产生计数');
});

test('store：bump 传播 + 持久化往返 + 快照独立', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prio-store-'));
  try {
    const store = createDirPriorityStore(dir);
    const root = path.join(dir, 'ws');
    store.bump(path.join(root, 'a', 'b', 'x.ts'), [root]);
    store.bump(path.join(root, 'a', 'b', 'x.ts'), [root]);
    store.bump(path.join(root, 'a', 'c', 'y.ts'), [root]);

    const snap = store.snapshot();
    const key = (p) => p.replace(/\\/g, '/').toLowerCase();
    assert.equal(snap[key(path.join(root, 'a', 'b'))], 2, '直接父目录计 2 次');
    assert.equal(snap[key(path.join(root, 'a'))], 3, '祖先收到全部点击的传播');
    assert.equal(snap[key(path.join(root, 'a', 'c'))], 1);
    assert.equal(scoreOf(snap, path.join(root, 'a', 'b')), 2, 'scoreOf 查表（大小写/分隔符归一）');

    // 新实例从同一文件恢复
    const store2 = createDirPriorityStore(dir);
    assert.deepEqual(store2.snapshot(), snap, '重启后从文件恢复');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store：超过上限淘汰计数最小的条目', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prio-cap-'));
  try {
    const store = createDirPriorityStore(dir);
    const root = path.join(dir, 'ws');
    // 造 MAX_ENTRIES + 10 个不同的直接父目录（每个只点 1 次），
    // 再把其中一个点热（3 次）——淘汰应保住热的
    const hot = path.join(root, 'hot');
    store.bump(path.join(hot, 'a.ts'), [root]);
    store.bump(path.join(hot, 'a.ts'), [root]);
    store.bump(path.join(hot, 'a.ts'), [root]);
    for (let i = 0; i < MAX_ENTRIES + 10; i += 1) {
      store.bump(path.join(root, 'cold' + i, 'f.ts'), [root]);
    }
    const snap = store.snapshot();
    assert.ok(Object.keys(snap).length <= MAX_ENTRIES, '不超过上限');
    assert.equal(snap[key(hot)], 3, '热目录在淘汰中幸存（传播的 hot 键 + hot/a 键，两者计数最高）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store：平铺根目录的文件（目录链为空）也记文件自计数，不再静默丢弃（0.1.121）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prio-flat-'));
  try {
    const store = createDirPriorityStore(dir);
    const root = path.join(dir, 'ws');
    const file = path.join(root, 'log'); // 文件直接在根下：父目录 = 根
    store.bump(file, [root]);
    const snap = store.snapshot();
    assert.equal(snap[key(file)], 1, '文件自身记 1 分');
    assert.equal(snap[key(root)], undefined, '根本身不计数（根不是排序粒度）');

    // 展示分语义（controller 侧 max(dir, file) 的数据面）：点过的文件 > 未点的兄弟
    assert.equal(scoreOf(snap, file), 1);
    assert.equal(scoreOf(snap, path.join(root, 'sibling.ts')), 0);

    // 持久化往返
    assert.deepEqual(createDirPriorityStore(dir).snapshot(), snap);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store：坏文件 / 无介质不炸', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prio-bad-'));
  try {
    fs.writeFileSync(path.join(dir, 'dir-priority.v1.json'), '{broken');
    const store = createDirPriorityStore(dir);
    assert.deepEqual(store.snapshot(), {}, '坏文件按空表处理');
    const noDir = createDirPriorityStore(undefined);
    // 无介质：内存计数照常（文件自计），只是不落盘、重启即失
    noDir.bump(path.join(os.tmpdir(), 'x.ts'), [os.tmpdir()]);
    assert.deepEqual(
      noDir.snapshot(),
      { [key(path.join(os.tmpdir(), 'x.ts'))]: 1 },
      '无介质时 bump 不炸，内存计数生效',
    );
    // 不在任何一个工作区根内的文件：完全不记
    const noRoot = createDirPriorityStore(undefined);
    noRoot.bump('z:/elsewhere/y.ts', [os.tmpdir()]);
    assert.deepEqual(noRoot.snapshot(), {}, '不在工作区内的文件不产生计数');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function key(p) {
  return p.replace(/\\/g, '/').toLowerCase();
}
