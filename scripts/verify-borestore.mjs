import fs from 'node:fs';
import { SearchCore } from '../test/.tmp/wasm.mjs';
import { compileQuery } from '../test/.tmp/search.mjs';
import { streamSearchFile } from '../test/.tmp/stream.mjs';

const core = await SearchCore.load('media/core.wasm');
const handle = compileQuery(core, { query: 'BoRestore', mode: 'normal', caseSensitive: true, wholeWord: false, dotAll: false, backtrackLimit: 1000000 });
const file = process.argv[2] || 'C:/Users/lenovo/Downloads/20个云机的logcat日志(1)/2110199958213029890/local/logs/log.03';
const result = await streamSearchFile(file, core, handle, { limit: 5000, maxBytes: 512000 * 1024 });
const text = fs.readFileSync(file, 'utf8');
// 真值按 VS Code 行分割口径：\n、\r\n、孤立 \r 都算换行
const truth = [];
let at = text.indexOf('BoRestore');
while (at !== -1) {
  let line = 0;
  for (let i = 0; i < at; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 10 || (code === 13 && text.charCodeAt(i + 1) !== 10)) line += 1;
  }
  truth.push(line);
  at = text.indexOf('BoRestore', at + 1);
}
const got = result.hits.map((h) => h.line).sort((a, b) => a - b);
const same = got.length === truth.length && got.every((v, i) => v === truth[i]);
console.log(`${file.split('/').pop()}: got=${got.length} truth=${truth.length} ${same ? '全部一致(含孤立\\r口径)' : '不一致!'}`);
if (!same) { console.log('got:', got); console.log('truth:', truth); }
