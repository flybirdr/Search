import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  walkSessionGen,
  planItems,
  WALK_BATCH_SIZE,
  WALK_CREDIT_WINDOW,
} from './.tmp/walkSession.mjs';

const workerScript = path.resolve('dist/walkWorker.js');
const EXTS = ['.ts', '.txt', '.md'];

function makeTree(root) {
  // 覆盖全部条目形态：根直属文件、L1 直属文件、L1 叶子、L2 子树（含深层）
  fs.mkdirSync(path.join(root, 'aaa/sub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bbb/deep/deeper'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ccc'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'root.txt'), 'x');
  fs.writeFileSync(path.join(root, 'aaa/top.txt'), 'x'); // L1 直属文件
  fs.writeFileSync(path.join(root, 'aaa/sub/a.txt'), 'x');
  fs.writeFileSync(path.join(root, 'bbb/b.md'), 'x'); // L1 直属文件
  fs.writeFileSync(path.join(root, 'bbb/deep/d.txt'), 'x');
  fs.writeFileSync(path.join(root, 'bbb/deep/deeper/e.ts'), 'x');
  fs.writeFileSync(path.join(root, 'ccc/c.txt'), 'x'); // L1 叶子
  fs.writeFileSync(path.join(root, 'node_modules/pkg/n.js'), 'x'); // 排除目录
  fs.writeFileSync(path.join(root, 'skip.so'), 'x'); // 非文本扩展名
}

async function collect(order, threads) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flywalk-'));
  makeTree(root);
  try {
    const paths = [];
    const gen = walkSessionGen({
      workerScript,
      rootFsPath: root,
      include: '**/*',
      exclude: '',
      threads,
      order,
    });
    let r = await gen.next();
    while (!r.done) {
      paths.push(r.value);
      r = await gen.next();
    }
    return { paths: paths.sort(), stats: r.value, root };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 全局字典序：'bbb/deep/d.txt' < 'bbb/deep/deeper/e.ts'（'.' < 'e'）
const expectedRelative = [
  'aaa/sub/a.txt',
  'aaa/top.txt',
  'bbb/b.md',
  'bbb/deep/d.txt',
  'bbb/deep/deeper/e.ts',
  'ccc/c.txt',
  'root.txt',
];

test('sorted 模式：输出严格全局字典序，覆盖全部条目形态且排除规则生效', async () => {
  const { paths, stats, root } = await collect('sorted', 3);
  const rel = paths.map((p) => path.relative(root, p).split(path.sep).join('/'));
  assert.deepEqual(rel, expectedRelative, '输出应为全局排序且不包含排除目录与非文本扩展名');
  assert.equal(stats.found, 7, 'found = 排除扩展名后、过滤器前的总数');
  assert.equal(stats.via, 'fs');
});

test('fast 模式：命中集合与 sorted 完全一致', async () => {
  const fast = await collect('fast', 3);
  const rel = fast.paths.map((p) => path.relative(fast.root, p).split(path.sep).join('/'));
  assert.deepEqual(rel.sort(), [...expectedRelative].sort());
});

test('提前 return：生成器收尾不悬挂', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flywalk-'));
  makeTree(root);
  try {
    const gen = walkSessionGen({
      workerScript,
      rootFsPath: root,
      include: '**/*',
      exclude: '',
      threads: 2,
      order: 'fast',
    });
    const r = await gen.next();
    assert.ok(!r.done);
    await gen.return(undefined);
    assert.ok(true, 'return 正常完成即通过（超时会挂死测试进程）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('优先级：热子树先产出（sorted 与 fast 都是），同分仍按路径序', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-prio-'));
  // aaa（冷）与 zzz（热，点过 5 次）两棵子树；root.txt 无优先级
  fs.mkdirSync(path.join(root, 'aaa'), { recursive: true });
  fs.mkdirSync(path.join(root, 'zzz'), { recursive: true });
  fs.writeFileSync(path.join(root, 'root.txt'), 'x');
  fs.writeFileSync(path.join(root, 'aaa/a1.txt'), 'x');
  fs.writeFileSync(path.join(root, 'aaa/a2.txt'), 'x');
  fs.writeFileSync(path.join(root, 'zzz/z1.txt'), 'x');
  fs.writeFileSync(path.join(root, 'zzz/z2.txt'), 'x');
  const priorities = {};
  priorities[path.join(root, 'zzz')] = 5;
  try {
    const collect = async (order) => {
      const rels = [];
      const gen = walkSessionGen({
        workerScript,
        rootFsPath: root,
        include: '**/*',
        exclude: '',
        threads: 2,
        order,
        priorities,
      });
      let r = await gen.next();
      while (!r.done) {
        rels.push(path.relative(root, r.value).split(path.sep).join('/'));
        r = await gen.next();
      }
      return rels;
    };

    // sorted：zzz（分 5）整棵先于所有 0 分条目；0 分内按条目路径升序——
    // root 直属文件条目的键是根路径（aaa 的前缀）→ root.txt 在 aaa 之前
    const sorted = await collect('sorted');
    assert.deepEqual(sorted, ['zzz/z1.txt', 'zzz/z2.txt', 'root.txt', 'aaa/a1.txt', 'aaa/a2.txt']);

    // fast：优先级通过派发顺序生效——热子树的文件也要先出现
    const fast = await collect('fast');
    assert.deepEqual([...fast].sort(), sorted.slice().sort(), '命中集合一致');
    assert.ok(
      fast.indexOf('zzz/z1.txt') < fast.indexOf('aaa/a1.txt'),
      `fast 也应先产出热子树: ${fast.join(', ')}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('信用流控：单条目超过信用窗口批数不卡死（0.1.118 AOSP 死锁回归）', async () => {
  // 死锁机制：worker 每发一批花 1 个 credit（初始 = 窗口 4），宿主旧版只在
  // 条目闭合后才退款——>4 批的条目 worker 等 credit、宿主等闭合，双向卡死。
  // AOSP 大子树随便超 4 批（8192 文件），实测每场卡死在固定文件数。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-credit-'));
  const big = path.join(root, 'big');
  fs.mkdirSync(big, { recursive: true });
  const total = WALK_CREDIT_WINDOW * WALK_BATCH_SIZE + 500; // 5 批
  for (let i = 0; i < total; i += 1) {
    fs.writeFileSync(path.join(big, 'f' + i + '.txt'), 'x');
  }
  try {
    const rels = [];
    const gen = walkSessionGen({
      workerScript,
      rootFsPath: root,
      include: '**/*',
      exclude: '',
      threads: 1,
      order: 'fast',
    });
    let r = await gen.next();
    while (!r.done) {
      rels.push(r.value);
      r = await gen.next();
    }
    assert.equal(rels.length, total, '超过信用窗口的条目必须完整产出');
    assert.equal(r.value.found, total);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('空条目占位批次的 credit 必须回账，否则 worker 陆续饿死（0.1.119 回归）', async () => {
  // 6 个只含 .so 的目录（过滤后为空 → 占位空批次花 1 credit）排在一个
  // 5 批的大目录前面。旧版空批次永不退款：4 个空条目后 credit 归零，
  // worker 永久饿死，生成器永远不结束（AOSP「彻底卡死」的根因）。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-empty-'));
  for (let i = 0; i < 6; i += 1) {
    const dir = path.join(root, 'e' + i);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib' + i + '.so'), 'x');
  }
  const big = path.join(root, 'big');
  fs.mkdirSync(big, { recursive: true });
  const total = WALK_CREDIT_WINDOW * WALK_BATCH_SIZE + 500;
  for (let i = 0; i < total; i += 1) {
    fs.writeFileSync(path.join(big, 'f' + i + '.txt'), 'x');
  }
  try {
    const rels = [];
    const gen = walkSessionGen({
      workerScript,
      rootFsPath: root,
      include: '**/*',
      exclude: '',
      threads: 2,
      order: 'fast',
    });
    let r = await gen.next();
    while (!r.done) {
      rels.push(r.value);
      r = await gen.next();
    }
    assert.equal(rels.length, total, '空条目不能拖垮 credit，大目录必须完整产出');
    assert.equal(r.value.found, total);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shouldAbort：挂起的遍历能被 Stop 打断（0.1.118 Stop 失效回归）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-abort-'));
  const big = path.join(root, 'big');
  fs.mkdirSync(big, { recursive: true });
  // 足够多文件：abort 前肯定产不完
  for (let i = 0; i < WALK_CREDIT_WINDOW * WALK_BATCH_SIZE * 4; i += 1) {
    fs.writeFileSync(path.join(big, 'f' + i + '.txt'), 'x');
  }
  try {
    let aborted = false;
    const gen = walkSessionGen({
      workerScript,
      rootFsPath: root,
      include: '**/*',
      exclude: '',
      threads: 2,
      order: 'fast',
      shouldAbort: () => aborted,
    });
    let r = await gen.next();
    assert.ok(!r.done, '前置条件：先产出数据');
    aborted = true; // 模拟 Stop：此后生成器应在数百 ms 内收尾
    r = await gen.next();
    assert.ok(r.done, '取消后生成器要结束（挂死会卡住本断言直到测试超时）');
    assert.ok(typeof r.value.found === 'number');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('planItems：排除目录不生成条目，L1 直属文件有 files 条目', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyplan-'));
  makeTree(root);
  try {
    const items = planItems(root);
    const kinds = items.map(
      (item) => `${item.kind}:${path.relative(root, item.path).split(path.sep).join('/')}`,
    );
    assert.ok(
      !kinds.some((k) => k.includes('node_modules')),
      `排除目录不应有条目: ${kinds.join(', ')}`,
    );
    assert.ok(kinds.some((k) => k.startsWith('files:aaa')), 'L1 直属文件需要 files 条目');
    assert.ok(kinds.some((k) => k.startsWith('tree:aaa/sub')), 'L2 子树要有 tree 条目');
    assert.ok(kinds.some((k) => k.startsWith('tree:ccc')), 'L1 叶子要有 tree 条目');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void EXTS;
void os;
