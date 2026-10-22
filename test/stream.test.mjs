/**
 * 流式搜索的单元测试。
 *
 * 分块搜索最容易错的地方全在边界上：多字节字符被切两半、命中正好跨过块边界、
 * 行号在块之间没接上。这里都用真实临时文件 + 很小的块（8 KB）去撞这些边界，
 * 最后再用默认的 4 MB 块跑一遍接近真实体量的文件。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import iconv from 'iconv-lite';

const { SearchCore, modeToNumber, FLAG_MULTILINE } = await import('./.tmp/wasm.mjs');
const { streamSearchFile } = await import('./.tmp/stream.mjs');

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const core = await SearchCore.load(path.join(root, 'media', 'core.wasm'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-stream-'));

function write(name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

function compile(query, mode = 'normal', flags = FLAG_MULTILINE) {
  return core.compile(query, modeToNumber(mode), flags, 1000000);
}

const small = { chunkBytes: 8 * 1024, overlapChars: 2 * 1024 };

async function collect(file, query, options = {}) {
  const handle = compile(query);
  return streamSearchFile(file, core, handle, { limit: 10000, maxBytes: 1024 * 1024 * 1024, ...small, ...options });
}

test('跨块搜索：2 万行里 200 处命中，一个不多一个不少，行列号正确', async () => {
  const lines = [];
  for (let i = 0; i < 20000; i += 1) {
    lines.push(`line ${String(i).padStart(6, '0')} `.padEnd(60, '.') + (i % 100 === 7 ? 'needle' : 'straw'));
  }
  const file = write('many.txt', lines.join('\n') + '\n');

  const result = await collect(file, 'needle');
  assert.equal(result.kind, 'ok');
  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.bytesRead, fs.statSync(file).size);
  assert.equal(result.lines, 20000, '行数要在块之间连续累计');
  assert.equal(result.hits.length, 200, 'i % 100 === 7 正好 200 行');

  for (const hit of result.hits) {
    const expectedLine = hit.line;
    assert.equal(expectedLine % 100, 7, '命中的行号必须是 7 的尾数模式');
    assert.equal(hit.column, 60);
    assert.equal(hit.matchLen, 6);
    assert.equal(hit.preview, lines[expectedLine]);
    assert.equal(hit.preview.slice(hit.prefix, hit.prefix + hit.matchLen), 'needle');
  }

  const seen = new Set(result.hits.map((hit) => hit.line));
  assert.equal(seen.size, result.hits.length, '同一行不应重复上报');
});

test('多字节字符被切在块边界上也不会乱码，列号按 UTF-16 计', async () => {
  // 8191 个 a + 中文：UTF-8 的「中」正好横跨 8192 字节的块边界
  const head = 'a'.repeat(8191);
  const file = write('cjk.txt', `${head}中文内容 needle 尾巴\n第二行 needle\n`);

  const result = await collect(file, 'needle');
  assert.equal(result.kind, 'ok');
  assert.equal(result.hits.length, 2);
  assert.equal(result.hits[0].line, 0);
  assert.equal(result.hits[0].column, 8191 + 4 + 1, 'a × 8191 + 中文内容(4) + 空格');
  assert.equal(result.hits[0].preview.includes('\ufffd'), false, '不应出现替换字符');
  assert.match(result.hits[0].preview, /中文内容 needle/);
  assert.equal(result.hits[1].line, 1);
  assert.equal(result.hits[1].column, 4);
});

test('匹配的尾巴贴着块边界时不会被截断上报', async () => {
  // 每行 63 字节，让 needle 的位置随分块起点漂移
  const rows = [];
  for (let i = 0; i < 5000; i += 1) {
    rows.push(`${String(i).padStart(4, '0')}`.padEnd(57, '_') + 'needle');
  }
  const file = write('edge.txt', rows.join('\n') + '\n');

  const result = await collect(file, 'needle');
  assert.equal(result.hits.length, 5000);
  for (const hit of result.hits) {
    assert.equal(hit.matchLen, 6, '不允许把 6 字节的命中截成更短的一段');
    assert.equal(hit.preview.slice(hit.prefix, hit.prefix + 6), 'needle');
  }
});

test('超长单行（没有换行）也能搜，缓冲区不会无界增长', async () => {
  const body = 'x'.repeat(300 * 1024);
  const file = write('oneline.txt', `${body}needle${body}needle\n---\nneedle\n`);

  const result = await collect(file, 'needle');
  assert.equal(result.kind, 'ok');
  assert.equal(result.hits.length, 3);
  assert.equal(result.hits[0].line, 0);
  assert.equal(result.hits[0].column, 300 * 1024);
  assert.equal(result.hits[0].matchLen, 6);
  assert.ok(result.hits[0].preview.length <= 200, '超长行只截命中附近，不复制整行');
  assert.equal(result.hits[2].line, 2);
});

test('GBK 文件：块边界上的汉字也不出错', async () => {
  const rows = [];
  for (let i = 0; i < 3000; i += 1) {
    rows.push(`第 ${i} 行：这是一些中文内容，用来把多字节字符铺满分块边界 needle`);
  }
  const file = write('gbk.txt', iconv.encode(rows.join('\r\n') + '\r\n', 'gbk'));

  const handle = compile('needle');
  const result = await streamSearchFile(file, core, handle, {
    limit: 10000,
    maxBytes: 10 * 1024 * 1024,
    ...small,
  });

  assert.equal(result.encoding, 'gbk');
  assert.equal(result.hits.length, 3000);
  assert.equal(result.hits[0].line, 0);
  assert.match(result.hits[0].preview, /第 0 行：这是一些中文内容/);
  assert.equal(result.hits[0].preview.includes('\ufffd'), false);
  assert.equal(result.hits[2999].line, 2999);
});

test('UTF-16LE（带 BOM）按字符解码，行号正确', async () => {
  const rows = [];
  for (let i = 0; i < 2000; i += 1) {
    rows.push(`第 ${i} 行 needle 内容`);
  }
  const file = write('utf16.txt', Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(rows.join('\r\n'), 'utf16le'),
  ]));

  const handle = compile('needle');
  const result = await streamSearchFile(file, core, handle, {
    limit: 10000,
    maxBytes: 10 * 1024 * 1024,
    ...small,
  });

  assert.equal(result.encoding, 'utf-16le');
  assert.equal(result.hits.length, 2000);
  assert.equal(result.hits[5].line, 5);
  assert.match(result.hits[5].preview, /needle/);
});

test('出现 NUL 的文件判为二进制，直接跳过而不是当成文本搜', async () => {
  const file = write('binary.bin', Buffer.from([0x00, 0x01, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
  const result = await collect(file, 'needle');
  assert.equal(result.kind, 'binary');
  assert.equal(result.hits.length, 0);
});

test('达到上限就停止，并标记结果被截断', async () => {
  const rows = [];
  for (let i = 0; i < 5000; i += 1) {
    rows.push(`needle ${i}`);
  }
  const file = write('limit.txt', rows.join('\n') + '\n');

  const result = await collect(file, 'needle', { limit: 10 });
  assert.equal(result.hits.length, 10);
  assert.equal(result.truncated, true);
  assert.ok(result.bytesRead < fs.statSync(file).size, '够了就不该继续往后读');
});

test('文件超过 maxBytes 时返回 tooLarge，交给卡片点名', async () => {
  const file = write('big.txt', 'needle\n'.repeat(20000));
  const result = await collect(file, 'needle', { maxBytes: 4096 });
  assert.equal(result.kind, 'tooLarge');
});

test('取消令牌立刻生效，不会先把整个文件读完', async () => {
  const file = write('cancel.txt', 'needle\n'.repeat(20000));
  const result = await collect(file, 'needle', { token: { isCancellationRequested: true } });
  assert.equal(result.kind, 'cancelled');
  assert.equal(result.bytesRead, 0);
});

test('默认 4 MB 分块：跨块的行号与命中数仍然正确', async () => {
  // 每行 79 字节，约 9 MB；命中点分散在 4 MB / 8 MB 边界附近
  const rows = [];
  const marks = new Set([0, 53000, 53001, 106000, 106001, 159000, 200000]);
  for (let i = 0; i <= 200000; i += 1) {
    rows.push(`${String(i).padStart(6, '0')}`.padEnd(74, ' ') + (marks.has(i) ? 'NEEDLE' : 'filler'));
  }
  const file = write('default.txt', rows.join('\n') + '\n');
  assert.ok(fs.statSync(file).size > 9 * 1024 * 1024);

  const handle = compile('needle', 'normal', FLAG_MULTILINE | 1 /* 忽略大小写 */);
  const result = await streamSearchFile(file, core, handle, {
    limit: 10000,
    maxBytes: 100 * 1024 * 1024,
  });

  assert.equal(result.hits.length, marks.size);
  assert.deepEqual([...new Set(result.hits.map((hit) => hit.line))].sort((a, b) => a - b), [...marks].sort((a, b) => a - b));
  for (const hit of result.hits) {
    assert.equal(hit.preview.slice(hit.prefix, hit.prefix + 6), 'NEEDLE');
  }
});

test('正则模式下跨块也能找到长一点的匹配', async () => {
  const rows = [];
  for (let i = 0; i < 8000; i += 1) {
    rows.push(`id=${String(i).padStart(6, '0')} status=ERROR code=42`);
  }
  const file = write('regex.txt', rows.join('\n') + '\n');

  const handle = compile('id=(\\d+) status=(ERROR|WARN)', 'regex');
  const result = await streamSearchFile(file, core, handle, {
    limit: 10000,
    maxBytes: 100 * 1024 * 1024,
    ...small,
  });

  assert.equal(result.hits.length, 8000);
  assert.equal(result.hits[0].line, 0);
  assert.equal(result.hits[7999].line, 7999);
  assert.equal(result.hits[0].preview.slice(result.hits[0].prefix, result.hits[0].prefix + result.hits[0].matchLen), 'id=000000 status=ERROR');
});

test('孤立 \\r 按 VS Code 语义算换行，跨块行号不漂移（logcat 回归）', async () => {
  // 每 500 行塞一批带孤立 \r 的 Shell 行，让块边界（8KB）反复落在 \r 之后
  const rows = [];
  for (let i = 0; i < 20000; i += 1) {
    if (i % 500 === 3) {
      rows.push(`row ${i} D Shell   : onOutput\rstatus=NEEDLE\rmore`); // 两个孤立 \r
    } else if (i % 500 === 4) {
      rows.push(`row ${i} CRLF\r\nEND`);
    } else {
      rows.push(`row ${String(i).padStart(6, '0')} filler`.padEnd(60, '.'));
    }
  }
  const file = write('lone-cr.log', rows.join('\n') + '\n');

  const result = await collect(file, 'NEEDLE');
  assert.equal(result.kind, 'ok');
  // 真值按 VS Code 口径手工累计：\n、\r\n、孤立 \r 都算一行
  const text = fs.readFileSync(file, 'utf8');
  const needle = 'NEEDLE';
  const truth = [];
  let at = text.indexOf(needle);
  while (at !== -1) {
    let line = 0;
    for (let i = 0; i < at; i += 1) {
      const code = text.charCodeAt(i);
      if (code === 10 || (code === 13 && text.charCodeAt(i + 1) !== 10)) {
        line += 1;
      }
    }
    truth.push(line);
    at = text.indexOf(needle, at + 1);
  }
  assert.equal(result.hits.length, truth.length);
  const got = result.hits.map((hit) => hit.line).sort((a, b) => a - b);
  assert.deepEqual(got, truth, '流式行号必须与 VS Code 行分割一致');
});

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('UTF-8 字节路径：CJK 与 emoji（代理对）列号按 UTF-16 码元计', async () => {
  const emoji = String.fromCodePoint(0x1f600);
  const line = 'ab' + emoji + '中 needle';
  const result = await collect(write('byte-emoji.txt', line + '\n'), 'needle');
  assert.equal(result.kind, 'ok');
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].line, 0);
  // a b emoji(2 单元) 中 空格 → needle 起始列 6，长度 6
  assert.equal(result.hits[0].column, 6);
  assert.equal(result.hits[0].endColumn, 12);
  assert.equal(result.hits[0].preview, line);
});

test('UTF-8 字节路径：中途非法序列整份回退，结果与字符串路径一致', async () => {
  const content = Buffer.concat([
    Buffer.from('x'.repeat(20000), 'ascii'),
    Buffer.from([0xff]),
    Buffer.from('\nneedle after junk\n', 'utf8'),
  ]);
  const result = await collect(write('byte-invalid-mid.txt', content), 'needle');
  assert.equal(result.kind, 'ok');
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].line, 1);
  assert.match(result.hits[0].preview, /needle after junk/);
});

test('UTF-8 字节路径：无换行的超长 CJK 行硬切后列号仍精确', async () => {
  const line = '中'.repeat(5000) + 'needle' + '中'.repeat(5000);
  const result = await collect(write('byte-cjk-huge-line.txt', line), 'needle');
  assert.equal(result.kind, 'ok');
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].line, 0);
  assert.equal(result.hits[0].column, 5000);
  assert.equal(result.hits[0].endColumn, 5006);
  assert.ok(result.hits[0].preview.includes('needle'), '预览包含命中词');
  assert.equal(result.hits[0].preview.slice(result.hits[0].prefix, result.hits[0].prefix + 6), 'needle');
});
