/**
 * 校验英文文案表与调用点是否一致。
 *
 * 规则：调用处 `t('中文')` / `T('中文')` 里的中文必须能在 EN 表里找到英文；
 * EN 表里也不应该留下没人用的条目（否则改了文案就会悄悄失效）。
 * 中文环境永远读原文，所以缺英文只会退化，不会空屏——但这里必须报错，避免漏译。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.tmp') {
        continue;
      }
      walk(full, out);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/** 解析 src/i18n-core.ts 里的 EN 表键名。 */
function readKeys() {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'i18n-core.ts'), 'utf8');
  const body = source.slice(source.indexOf('const EN: Record<string, string>'));
  const keys = new Set();
  for (const line of body.split('\n')) {
    const quoted = line.match(/^\s{2}'((?:[^'\\]|\\.)*)':/);
    if (quoted) {
      keys.add(quoted[1].replace(/\\(.)/g, '$1'));
      continue;
    }
    const bare = line.match(/^\s{2}([^\s'":][^:]*?):\s/);
    if (bare) {
      keys.add(bare[1]);
    }
    if (line.trim() === '};' && keys.size > 0) {
      break;
    }
  }
  return keys;
}

const CJK = /[\u3400-\u9fff]/;

function readCalls() {
  const files = [
    ...walk(path.join(ROOT, 'src')),
    path.join(ROOT, 'media', 'panel.js'),
  ];
  const used = new Map();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const pattern = /\b[tT]\(\s*'([^'\\]*)'/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const text = match[1];
      if (!CJK.test(text)) {
        continue;
      }
      if (!used.has(text)) {
        used.set(text, new Set());
      }
      used.get(text).add(path.relative(ROOT, file).replace(/\\/g, '/'));
    }
  }
  return used;
}

const keys = readKeys();
const used = readCalls();

/** package.json 里所有 %key% 引用，必须能在两个 nls 文件里找到。 */
function readManifestKeys(value, out = new Set()) {
  if (typeof value === 'string') {
    const match = value.match(/^%([^%\s]+)%$/);
    if (match) {
      out.add(match[1]);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      readManifestKeys(item, out);
    }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      readManifestKeys(item, out);
    }
  }
  return out;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const manifestKeys = readManifestKeys(manifest);
const nlsEn = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.json'), 'utf8'));
const nlsZh = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.zh-cn.json'), 'utf8'));

const nlsProblems = [];
for (const key of manifestKeys) {
  if (!(key in nlsEn)) {
    nlsProblems.push(`package.nls.json 缺少 ${key}`);
  }
  if (!(key in nlsZh)) {
    nlsProblems.push(`package.nls.zh-cn.json 缺少 ${key}`);
  }
}
for (const key of Object.keys(nlsEn)) {
  if (!manifestKeys.has(key)) {
    nlsProblems.push(`package.nls.json 里的 ${key} 没有被 package.json 使用`);
  }
}
for (const key of Object.keys(nlsZh)) {
  if (!(key in nlsEn)) {
    nlsProblems.push(`package.nls.zh-cn.json 里的 ${key} 在英文表里不存在`);
  }
}

const missing = [...used.keys()].filter((text) => !keys.has(text));
const unused = [...keys].filter((text) => !used.has(text));

if (nlsProblems.length > 0) {
  console.error('manifest 本地化不一致：');
  for (const problem of nlsProblems) {
    console.error(`  ${problem}`);
  }
}
if (missing.length > 0) {
  console.error('缺少英文的文案：');
  for (const text of missing) {
    console.error(`  "${text}"  ←  ${[...used.get(text)].join(', ')}`);
  }
}
if (unused.length > 0) {
  console.error('英文表里没有被使用的条目：');
  for (const text of unused) {
    console.error(`  "${text}"`);
  }
}
if (missing.length > 0 || unused.length > 0 || nlsProblems.length > 0) {
  process.exit(1);
}
console.log(
  `i18n ok: ${keys.size} runtime keys, ${manifestKeys.size} manifest keys, all used, all translated`,
);
