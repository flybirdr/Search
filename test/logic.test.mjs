import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildLineStarts,
  buildLineStartsBytes,
  compileQuery,
  decodeSlice,
  findMatches,
  findMatchesBytes,
  positionAt,
  utf16ToByteOffset,
} from './.tmp/search.mjs';
import { SearchCore } from './.tmp/wasm.mjs';

const core = await SearchCore.load(new URL('../media/core.wasm', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const options = {
  query: 'abc',
  mode: 'normal',
  caseSensitive: false,
  wholeWord: false,
  dotAll: false,
  backtrackLimit: 1000000,
};

test('UTF-8 byte offsets map back to UTF-16 positions', () => {
  const text = '中文abc中文abc';
  const handle = compileQuery(core, options);
  const matches = findMatches(core, handle, text, 0);

  assert.equal(matches.length, 2);
  assert.equal(matches[0].start, 2);
  assert.equal(matches[1].start, 7);
  assert.equal(text.slice(matches[0].start, matches[0].start + matches[0].len), 'abc');
  assert.equal(text.slice(matches[1].start, matches[1].start + matches[1].len), 'abc');
});

test('surrogate pairs count as two UTF-16 units', () => {
  const text = '😀abc😀';
  const handle = compileQuery(core, options);
  const matches = findMatches(core, handle, text, 0);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].start, 2);
  assert.equal(text.slice(2, 5), 'abc');
});

test('字节直传路径与字符串路径给出一致的命中与行/列换算', () => {
  const text = '第一行 xabc\nsecond line: abc!\n中文 abc 尾行\n';
  const bytes = new TextEncoder().encode(text);
  const handle = compileQuery(core, options);

  const viaString = findMatches(core, handle, text, 0);
  const viaBytes = findMatchesBytes(core, handle, bytes, 0);
  assert.equal(viaBytes.length, viaString.length, '两条路径命中数一致');

  const byteStarts = buildLineStartsBytes(core, bytes);
  assert.deepEqual([...byteStarts], [0, 15, 33, 51], '字节行起点表按 0x0A 切分');

  for (let i = 0; i < viaBytes.length; i += 1) {
    const b = viaBytes[i];
    // 字节偏移换算成 UTF-16 行/列，与字符串路径的结果对齐
    const pos = positionAt(byteStarts, b.start);
    const lineFrom = byteStarts[pos.line];
    const lineTo =
      pos.line + 1 < byteStarts.length ? byteStarts[pos.line + 1] : bytes.length;
    const column = decodeSlice(bytes, lineFrom, b.start).length;
    const s = viaString[i];
    const sPos = positionAt(buildLineStarts(text), s.start);
    assert.equal(pos.line, sPos.line, `第 ${i} 处命中行号一致`);
    assert.equal(column, sPos.column, `第 ${i} 处命中列号一致`);
    const lineText = decodeSlice(bytes, lineFrom, lineTo).replace(/\r?\n$/, '');
    assert.ok(lineText.includes('abc'), '按命中行解码出文本');
  }
});

test('decodeSlice 处理跨行与中文字节边界', () => {
  const text = '中文行\nabc';
  const bytes = new TextEncoder().encode(text);
  const handle = compileQuery(core, options);
  const matches = findMatchesBytes(core, handle, bytes, 0);
  assert.equal(matches.length, 1);
  // '中文行' 各 3 字节，\n 在字节偏移 9，abc 从 10 开始
  assert.equal(matches[0].start, 10);
  assert.equal(decodeSlice(bytes, 0, 10), '中文行\n');
  assert.equal(decodeSlice(bytes, 10, 13), 'abc');
});

test('utf16ToByteOffset handles ASCII, CJK and emoji', () => {
  const text = 'a中😀b';
  assert.equal(utf16ToByteOffset(text, 0), 0);
  assert.equal(utf16ToByteOffset(text, 1), 1);
  assert.equal(utf16ToByteOffset(text, 2), 4);
  assert.equal(utf16ToByteOffset(text, 4), 8);
  assert.equal(utf16ToByteOffset(text, 5), 9);
});

test('replacement runs inside the Rust core', () => {
  const handle = compileQuery(core, { ...options, query: '(\\d+)件', mode: 'regex' });
  const result = core.replaceAll(handle, '共12件，又3件', '[$1]', 0);
  assert.equal(result, '共[12]，又[3]');
});

test('extended mode finds escaped newline inside CRLF text', () => {
  const handle = compileQuery(core, { ...options, query: 'a\\r\\nb', mode: 'extended' });
  const matches = findMatches(core, handle, 'a\r\nb', 0);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].len, 4);
});

test('line starts and positions are correct for mixed newlines', () => {
  const text = 'one\ntwo\r\nthree';
  const starts = buildLineStarts(text);
  assert.deepEqual(starts, [0, 4, 9]);
  assert.deepEqual(positionAt(starts, 9), { line: 2, column: 0 });
  assert.deepEqual(positionAt(starts, 11), { line: 2, column: 2 });
});

test('孤立 \\r 与 VS Code 一致地当作换行（logcat 行号漂移回归）', () => {
  // 行结构（VS Code 语义）：a | b | c | d —— 孤立 \r 算一行
  const text = 'a\rb\nc\r\nd';
  const starts = buildLineStarts(text);
  assert.deepEqual(starts, [0, 2, 4, 7], '孤立 \\r 自成一行，\\r\\n 只算一处');

  const bytes = new TextEncoder().encode(text);
  assert.deepEqual([...buildLineStartsBytes(core, bytes)], starts, '字节版与字符串版一致');

  // 命中落在孤立 \r 之后：行号必须按 VS Code 口径（而不是只数 \n）
  const handle = compileQuery(core, { ...options, query: 'd' });
  const byteMatches = findMatchesBytes(core, handle, bytes, 0);
  assert.equal(byteMatches.length, 1);
  const pos = positionAt(buildLineStartsBytes(core, bytes), byteMatches[0].start);
  assert.equal(pos.line, 3, 'd 应在 VS Code 的第 4 行（0 基 3），不是第 2 行');

  // 文件末尾的孤立 \r 同样补一个空行起点，与编辑器一致
  const tail = buildLineStarts('x\r');
  assert.deepEqual(tail, [0, 2], '结尾孤立 \\r 后有一个空行起点');
  const tailBytes = buildLineStartsBytes(core, new TextEncoder().encode('x\r'));
  assert.deepEqual([...tailBytes], [0, 2], '字节版同样处理结尾孤立 \\r');
});

test('whole word keeps ASCII semantics next to CJK text', () => {
  const handle = compileQuery(core, { ...options, query: 'foo', wholeWord: true });
  const matches = findMatches(core, handle, 'foo foo_bar 中foo xfoo', 0);
  assert.equal(matches.length, 2);
});

test('count respects the match limit', () => {
  const handle = compileQuery(core, { ...options, query: 'a' });
  assert.equal(findMatches(core, handle, 'aaaaaaaaaa', 4).length, 4);
});

test('expandAt expands one match using byte offsets from CJK text', () => {
  const text = '前缀 [12] 后缀';
  const handle = compileQuery(core, { ...options, query: '\\[(\\d+)\\]', mode: 'regex' });
  const start = text.indexOf('[');
  const end = text.indexOf(']') + 1;
  const out = core.expandAt(
    handle,
    text,
    utf16ToByteOffset(text, start),
    utf16ToByteOffset(text, end),
    '<$1>',
  );
  assert.equal(out, '<12>');
});
