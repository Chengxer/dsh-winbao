'use strict';
// Inspect a dsh session file using node:zlib (the same codec dsh itself uses).
// The log is a concatenation of multiple zstd frames; each frame is decompressed
// separately so multi-frame logs are fully inspected (not just the first frame).
const fs = require('node:fs');
const zlib = require('node:zlib');
const { scanZstdFrames } = require('../session-watcher'); // 帧扫描器唯一实现

const f = process.argv[2];
const tailN = parseInt(process.argv[3] || '8', 10);
const buf = fs.readFileSync(f);
const { frames, tornStart } = scanZstdFrames(buf);
const lines = [];
for (const { start, end } of frames) {
  let text;
  try { text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'); }
  catch (err) { console.error('frame ' + start + '..' + end + ' 解压失败: ' + err.message); continue; }
  for (const line of text.split('\n')) if (line) lines.push(line);
}
console.log('FRAMES=' + frames.length + ' tornStart=' + (tornStart === undefined ? 'none' : tornStart));
console.log('LINES=' + lines.length);

// First line must be the session header.
console.log('HEADER=' + (lines[0] || '(empty)').slice(0, 200));

// Event type vocabulary.
const typeCounts = {};
let jsonOk = 0;
for (const line of lines) {
  try {
    const obj = JSON.parse(line);
    jsonOk++;
    const t = obj.type || '(no type)';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  } catch { /* skip */ }
}
console.log('jsonOk=' + jsonOk);
console.log('=== event types ===');
for (const [t, n] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
  console.log(String(n).padStart(6), t);
}
console.log('=== last ' + tailN + ' lines ===');
for (const line of lines.slice(-tailN)) {
  console.log('----');
  console.log(line.slice(0, 350));
}
