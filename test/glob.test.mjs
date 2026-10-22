import assert from 'node:assert/strict';
import test from 'node:test';
import { globToRegExp, matchesAny, pickPrimitive, splitFilters } from './.tmp/glob.mjs';

const hit = (pattern, relPath) => globToRegExp(pattern).test(relPath);

test('**/* 匹配任意层级', () => {
  assert.equal(hit('**/*', 'a.ts'), true);
  assert.equal(hit('**/*', 'src/a.ts'), true);
  assert.equal(hit('**/*', 'src/deep/nested/a.ts'), true);
});

test('不含斜杠的模式按“任意目录下”处理', () => {
  assert.equal(hit('*.ts', 'src/deep/a.ts'), true, '*.ts 应递归匹配');
  assert.equal(hit('*.ts', 'a.ts'), true);
  assert.equal(hit('*.ts', 'src/a.js'), false);
});

test('* 不跨目录，** 跨目录', () => {
  assert.equal(hit('src/*.ts', 'src/a.ts'), true);
  assert.equal(hit('src/*.ts', 'src/nested/a.ts'), false, '单星号不应跨目录');
  assert.equal(hit('src/**/*.ts', 'src/nested/a.ts'), true);
});

test('大括号多分支', () => {
  assert.equal(hit('**/*.{ts,js}', 'src/a.ts'), true);
  assert.equal(hit('**/*.{ts,js}', 'src/a.js'), true);
  assert.equal(hit('**/*.{ts,js}', 'src/a.md'), false);
  assert.equal(hit('**/{node_modules,dist}/**', 'node_modules/pkg/a.js'), true);
  assert.equal(hit('**/{node_modules,dist}/**', 'src/node_modules/a.js'), true);
  assert.equal(hit('**/{node_modules,dist}/**', 'src/a.js'), false);
});

test('**/ 开头的模式线性化为无锚定的段边界起点（深路径过滤的性能回归）', () => {
  // 锚定写法（行首 + 「零或多层目录」片段）会让路径的每个斜杠位置都有
  // 两种「归属方式」，8 万条深路径的过滤退化为平方级回溯（实测 1s+，且
  // 依赖 V8 对调用点的特化，数组/闭包调用形态下慢 70 倍）。现在译成
  // 「行首或斜杠」开头的无锚定形式，候选起点集合相同、语义等价。
  // 注：.source 会转义斜杠，前缀比对要用 RegExp 同源形式。
  const linear = (pattern) => globToRegExp(pattern).source;
  const linePrefix = new RegExp('(?:^|/)').source;
  const recursiveGroup = new RegExp('(?:[^/]*/)*').source;
  assert.equal(linear('**/{a,b}/**').startsWith(linePrefix), true, '排除式应线性化');
  assert.equal(linear('**/*').startsWith(linePrefix), true, '全量式应线性化');
  assert.equal(
    linear('**/*.ts').includes(recursiveGroup),
    false,
    '线性化后不得残留「零或多层目录」片段',
  );
  // 前缀仍需保留的形态：正文开头的片段吞不掉前导目录
  assert.equal(globToRegExp('src/*.ts').source.startsWith('^'), false, '带目录前缀的模式仍需前缀');
  assert.equal(globToRegExp('*.ts').source.startsWith('^'), false, '无斜杠模式仍需前缀');
  assert.equal(globToRegExp('/src/*.ts').source.startsWith('^'), true, '根锚定模式保持行首锚定');
});

test('线性化与锚定实现语义逐条一致（目录段边界）', () => {
  // 这些用例确认：段边界枚举不会让「段内包含」误伤
  const cases = [
    ['**/out/**', 'out/x.c', true],
    ['**/out/**', 'a/out/x.c', true],
    ['**/out/**', 'a/outb/x.c', false],
    ['**/out/**', 'a/outs/x.c', false],
    ['**/out/**', 'a/b/out', false, '尾段不是目录时不应命中'],
    ['**/out/**', 'source/out/x.c', true, '前缀段不是目录边界也不误伤'],
    ['**/out/**', 'source/build/x.c', false, '没有 out 段不应命中'],
    ['**/out/**', 'abuild/x.c', false],
    ['**/out/**', 'OUT/x.c', true, '默认大小写不敏感'],
    ['**/out/**', 'src/.github/x.c', false],
    ['**/{node_modules,dist}/**', 'node_modules/pkg/a.js', true],
    ['**/{node_modules,dist}/**', 'src/node_modules/a.js', true],
    ['**/{node_modules,dist}/**', 'dist/lib.js', true],
    ['**/{node_modules,dist}/**', 'src/a.js', false],
    ['**/{a,b}/**', 'a/b/x.c', true],
    ['**/{a,b}/**', 'src/a/deep/b/y.c', true],
    ['**/{a,b}/**', 'src/c/x.c', false],
  ];
  for (const [pattern, rel, want, note] of cases) {
    assert.equal(hit(pattern, rel), want, note ?? `${pattern} vs ${rel}`);
  }
  // 目录树越深匹配越不变
  const deep = Array.from({ length: 10 }, (_, i) => `d${i}`).join('/');
  assert.equal(hit('**/{a,b}/**', `${deep}/a/x.c`), true);
  assert.equal(hit('**/{a,b}/**', `${deep}/b/y.c`), true);
  assert.equal(hit('**/{a,b}/**', `${deep}/c/x.c`), false);
});

test('问号与特殊字符按字面量处理', () => {
  assert.equal(hit('a?.ts', 'ab.ts'), true);
  assert.equal(hit('a?.ts', 'a.ts'), false);
  assert.equal(hit('a+b.ts', 'a+b.ts'), true, '加号应转义为字面量');
  assert.equal(hit('a+b.ts', 'aab.ts'), false);
});

test('splitFilters 拆分逗号并忽略空白', () => {
  assert.deepEqual(splitFilters('**/*.ts, **/*.js'), ['**/*.ts', '**/*.js']);
  assert.deepEqual(splitFilters('  '), []);
  assert.deepEqual(splitFilters(undefined), []);
});

test('splitFilters 不切大括号里的逗号（0.1.44 及之前按裸逗号碎成多条）', () => {
  assert.deepEqual(splitFilters('**/{node_modules,dist}/**'), ['**/{node_modules,dist}/**']);
  assert.deepEqual(splitFilters('**/*.{ts,js}, **/*.md'), ['**/*.{ts,js}', '**/*.md']);
  assert.deepEqual(splitFilters('src/{a,b},dist/**'), ['src/{a,b}', 'dist/**']);
  // 未配对的右括号不能让 depth 变负、导致后续逗号切不开
  assert.deepEqual(splitFilters('a}b,c'), ['a}b', 'c']);
});

test('matchesAny 空列表视为全部通过', () => {
  assert.equal(matchesAny([], 'src/a.ts'), true);
  assert.equal(matchesAny(['**/*.ts'], 'src/a.ts'), true);
  assert.equal(matchesAny(['**/*.js'], 'src/a.ts'), false);
});

test('pickPrimitive 只把简单模式交给 findFiles', () => {
  assert.equal(pickPrimitive([]), '**/*');
  assert.equal(pickPrimitive(['**/*']), '**/*');
  assert.equal(pickPrimitive(['*.ts']), '**/*.ts', '应补递归前缀');
  assert.equal(pickPrimitive(['src/*.ts']), 'src/*.ts');
  assert.equal(pickPrimitive(['**/*.ts', '**/*.js']), '**/*', '多模式退回全量');
  assert.equal(pickPrimitive(['**/{a,b}/**']), '**/*', '含大括号退回全量');
});
