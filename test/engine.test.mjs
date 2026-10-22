import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const wasmBytes = readFileSync(new URL('../media/core.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const ex = instance.exports;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const IGNORE_CASE = 1;
const MULTILINE = 2;
const DOTALL = 4;
const WHOLE_WORD = 8;

const MODE_NORMAL = 0;
const MODE_EXTENDED = 1;
const MODE_REGEX = 2;

function write(text) {
  const bytes = encoder.encode(text);
  const ptr = ex.alloc(bytes.length) >>> 0;
  if (bytes.length > 0) {
    new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
  }
  return { ptr, len: bytes.length };
}

function lastError() {
  const ptr = ex.last_error_ptr() >>> 0;
  const len = ex.last_error_len() >>> 0;
  if (!ptr || !len) return '';
  return decoder.decode(new Uint8Array(ex.memory.buffer, ptr, len));
}

function compile(pattern, mode, flags = MULTILINE, backtrack = 1000000) {
  const { ptr, len } = write(pattern);
  const handle = ex.compile(ptr, len, mode, flags, backtrack);
  ex.dealloc(ptr, len);
  if (!handle) throw new Error(lastError());
  return handle;
}

function findAll(handle, text, limit = 0) {
  const { ptr, len } = write(text);
  const out = ex.find_all(handle, ptr, len, limit) >>> 0;
  ex.dealloc(ptr, len);
  if (!out) throw new Error(lastError());
  const view = new DataView(ex.memory.buffer);
  const count = view.getUint32(out, true);
  const matches = [];
  for (let i = 0; i < count; i += 1) {
    matches.push({
      start: view.getUint32(out + 4 + i * 8, true),
      len: view.getUint32(out + 8 + i * 8, true),
    });
  }
  ex.dealloc(out, 4 + count * 8);
  return matches;
}

function replaceAll(handle, text, replacement, limit = 0) {
  const haystack = write(text);
  const repl = write(replacement);
  const out = ex.replace_all(handle, haystack.ptr, haystack.len, repl.ptr, repl.len, limit) >>> 0;
  ex.dealloc(repl.ptr, repl.len);
  ex.dealloc(haystack.ptr, haystack.len);
  if (!out) throw new Error(lastError());
  const view = new DataView(ex.memory.buffer);
  const byteLen = view.getUint32(out, true);
  const result = decoder.decode(new Uint8Array(ex.memory.buffer, out + 4, byteLen));
  ex.dealloc(out, 4 + byteLen);
  return result;
}

test('normal mode matches literals, ignoring regex metacharacters', () => {
  const handle = compile('a.b', MODE_NORMAL);
  const matches = findAll(handle, 'a.b axb a.b');
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((m) => m.start), [0, 8]);
});

test('case sensitivity flag', () => {
  const insensitive = compile('hello', MODE_NORMAL, MULTILINE | IGNORE_CASE);
  assert.equal(findAll(insensitive, 'Hello hello HELLO').length, 3);

  const sensitive = compile('hello', MODE_NORMAL, MULTILINE);
  assert.equal(findAll(sensitive, 'Hello hello HELLO').length, 1);
});

test('whole word uses ASCII boundaries', () => {
  const handle = compile('foo', MODE_NORMAL, MULTILINE | WHOLE_WORD);
  const matches = findAll(handle, 'foo foo_bar 中foo xfoo');
  assert.equal(matches.length, 2);
});

test('extended mode expands \\t \\n and \\xHH', () => {
  const handle = compile('a\\tb', MODE_EXTENDED);
  assert.equal(findAll(handle, 'a\tb a b').length, 1);

  const hex = compile('\\x41\\x42', MODE_EXTENDED);
  assert.equal(findAll(hex, 'AB ab').length, 1);

  const newline = compile('one\\ntwo', MODE_EXTENDED);
  assert.equal(findAll(newline, 'one\ntwo').length, 1);
});

test('regex mode supports lookbehind and backreferences', () => {
  const lookbehind = compile('(?<=foo)bar', MODE_REGEX);
  assert.equal(findAll(lookbehind, 'foobar bar').length, 1);

  const backreference = compile('(\\w+) \\1', MODE_REGEX);
  assert.equal(findAll(backreference, 'hey hey ho ho ho').length, 2);
});

test('regex mode rewrites \\Q..\\E and \\h', () => {
  const quoted = compile('\\Qa.b\\E', MODE_REGEX);
  assert.equal(findAll(quoted, 'a.b axb').length, 1);

  const horizontal = compile('a\\hb', MODE_REGEX);
  assert.equal(findAll(horizontal, 'a\tb a b').length, 2);
});

test('dot all flag spans newlines', () => {
  const without = compile('a.b', MODE_REGEX, MULTILINE);
  assert.equal(findAll(without, 'a\nb').length, 0);

  const withDotAll = compile('a.b', MODE_REGEX, MULTILINE | DOTALL);
  assert.equal(findAll(withDotAll, 'a\nb').length, 1);
});

test('multiline anchors match every line', () => {
  const handle = compile('^ab', MODE_REGEX);
  assert.equal(findAll(handle, 'ab\nxx\nab').length, 2);
});

test('replacement expands $1, ${name} and \\1', () => {
  const handle = compile('(\\w+)@(\\w+)', MODE_REGEX);
  assert.equal(replaceAll(handle, 'me@host', '$2#$1'), 'host#me');
  assert.equal(replaceAll(handle, 'me@host', '${2}'), 'host');

  const backslash = compile('(a)(b)', MODE_REGEX);
  assert.equal(replaceAll(backslash, 'ab', '\\2\\1'), 'ba');
});

test('match limit is honoured', () => {
  const handle = compile('a', MODE_NORMAL);
  assert.equal(findAll(handle, 'aaaaa', 3).length, 3);
});

test('unsupported PCRE constructs fail with a readable message', () => {
  assert.throws(() => compile('a\\Kb', MODE_REGEX), /\\K/);
  assert.throws(() => compile('(?R)', MODE_REGEX), /递归/);
  assert.throws(() => compile('a++', MODE_REGEX), /占有量词/);
  assert.throws(() => compile('(?>a)', MODE_REGEX), /原子组/);
});

test('UTF-8 byte offsets are correct around multi-byte characters', () => {
  const handle = compile('abc', MODE_NORMAL);
  const matches = findAll(handle, '中文abc中文');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].start, 6);
  assert.equal(matches[0].len, 3);
});

test('empty pattern is rejected', () => {
  assert.throws(() => compile('', MODE_NORMAL), /为空/);
});

test('regex syntax error reports position', () => {
  assert.throws(() => compile('(abc', MODE_REGEX), /编译失败/);
});

test('backtrack limit aborts instead of hanging', () => {
  const handle = compile('(a+)+\\1b', MODE_REGEX, MULTILINE, 100);
  assert.throws(() => findAll(handle, `${'a'.repeat(200)}c`), /backtrack/i);
});
test('utf8_valid：ASCII 快速路径 + 多字节合法 + 跨 8 字节边界的非法序列', () => {
  // 直接写原始字节：TextEncoder 会把非法序列转码成合法 UTF-8，喂不进校验器
  const checkBytes = (bytes) => {
    const ptr = ex.alloc(bytes.length) >>> 0;
    try {
      if (bytes.length > 0) {
        new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
      }
      return ex.utf8_valid(ptr, bytes.length) === 1;
    } finally {
      if (bytes.length > 0) ex.dealloc(ptr, bytes.length);
    }
  };
  const check = (text) => checkBytes(encoder.encode(text));
  assert.equal(check('hello world'), true, '纯 ASCII（走 8 字节快速路径）');
  assert.equal(check('中文 mixed with ASCII text'), true, '合法多字节');
  assert.equal(check(''), true, '空输入恒合法');
  assert.equal(checkBytes([0x78, 0xe4, 0xb8]), false, '截断的 UTF-8 序列必须判非法');
  assert.equal(checkBytes([0x61, 0xff]), false, '0xFF 永不合法');
  // 快速路径边界：8/16 字节 ASCII 之后紧跟非法字节，剩余段仍要全查
  assert.equal(checkBytes(new Array(16).fill(0x78).concat([0xe4, 0xb8])), false, '16 ASCII + 截断序列');
  assert.equal(checkBytes(new Array(8).fill(0x78).concat([0xff])), false, '8 ASCII + 0xFF');
  assert.equal(check('中中中中中'), true, '整段多字节');
  assert.equal(checkBytes(encoder.encode('中中中中中').slice(0, -1)), false, '多字节尾部截断');
});

/** 行起点表（内核原始格式 → 数组），供 line_count 对账。 */
function lineStarts(text) {
  const { ptr, len } = write(text);
  const out = ex.line_starts(ptr, len) >>> 0;
  const view = new DataView(ex.memory.buffer);
  const count = view.getUint32(out, true);
  const starts = [];
  for (let i = 0; i < count; i += 1) starts.push(view.getUint32(out + 4 + i * 4, true));
  return starts;
}

/** line_count(ptr,len,upto)：与「行起点表里 < upto 的个数」必须逐字节一致。 */
function lineCount(text, upto = Infinity) {
  const { ptr, len } = write(text);
  return ex.line_count(ptr, len, Math.min(upto, len)) >>> 0;
}

test('line_count 与行起点表口径一致（\\n / \\r\\n / 孤立 \\r / 末尾无换行）', () => {
  const cases = [
    '',
    'a',
    '\n',
    'a\n',
    'a\nb',
    'a\nb\n',
    'a\r\nb\r\n',
    'a\rb\r',
    'one\r\ntwo\rthree\nfour\n',
    '中文中文\n换行\r\n混合\r',
  ];
  for (const text of cases) {
    const starts = lineStarts(text);
    for (let upto = 0; upto <= text.length; upto += 1) {
      const expected = starts.filter((start) => start < upto).length;
      assert.equal(
        lineCount(text, upto),
        expected,
        JSON.stringify(text) + ' @' + upto + ' 期望 ' + expected,
      );
    }
    // 全量调用等价于 upto=len：末尾换行产生的那个「幻影行首」不计入
    assert.equal(
      lineCount(text),
      starts.filter((start) => start < encoder.encode(text).length).length,
      JSON.stringify(text) + ' 全量',
    );
  }
});

test('line_count 在 8 字节寄存器边界上不出错（块边界正好压在 \\r / \\n 上）', () => {
  // 故意让 \r\n 跨 8 字节边界、让孤立 \r 落在 upto-1 上
  const text = '1234567\r\nabcdefg\rhij\n';
  const starts = lineStarts(text);
  for (let upto = 0; upto <= text.length; upto += 1) {
    assert.equal(
      lineCount(text, upto),
      starts.filter((start) => start < upto).length,
      'upto=' + upto,
    );
  }
});
