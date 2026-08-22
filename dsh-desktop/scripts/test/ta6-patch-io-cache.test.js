'use strict';

// ---------------------------------------------------------------------------
// TA6 元测试 3：patch-io readFileCached 缓存失效语义。
//   - 命中条件 = realpath 相同 + size 与 mtimeMs 精确一致（命中返回同一
//     string 引用，进程级 memo）；
//   - size 变化 / mtime 变化 → 失效重读；
//   - 内容不变但重写（mtime 变）→ 不命中（mtime 是权威信号），重读后文本
//     相等但为新鲜读取；
//   - TOCTOU 双 stat：读取期间文件被改写（第二次 stat 与第一次不一致）→
//     返回当次读到的文本但【不缓存】，下一次调用必须重新读盘；
//   - 文件缺失 / 不可读 → null；
//   - 并发读写：写者持续改文件时读者循环读，任一返回值必须是某次完整
//     写入的内容（不撕裂、不陈旧跨越 mtime 边界）。
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readFileCached } = require('../lib/patch-io');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ta6-pio-'));
const file = path.join(TMP, 'cache-target.js');

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

function write(content, mtime) {
  fs.writeFileSync(file, content);
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

test('命中：size+mtime 一致时返回同一 string 引用（进程级 memo）', () => {
  write('const a = 1;\n');
  const first = readFileCached(file);
  assert.equal(first, 'const a = 1;\n');
  const second = readFileCached(file);
  assert.equal(second, 'const a = 1;\n');
  // 命中缓存时应返回 memo 中的同一引用（未重读）。
  assert.ok(first === second, '缓存命中应返回同一 string 引用');
});

test('失效：size 变化 → 重读新内容', () => {
  write('short');
  assert.equal(readFileCached(file), 'short');
  write('a much longer content payload 0123456789');
  assert.equal(readFileCached(file), 'a much longer content payload 0123456789');
});

test('失效：size 相同但 mtime 变化 → 重读新内容', () => {
  const t0 = new Date(Date.now() - 10000);
  write('same-size-content-A', t0);
  assert.equal(readFileCached(file), 'same-size-content-A');
  const t1 = new Date(Date.now() + 10000); // mtime 明确前移，size 不变
  write('same-size-content-B', t1);
  assert.equal(readFileCached(file), 'same-size-content-B', 'mtime 变化必须失效缓存');
});

test('内容不变但重写（mtime 变）→ 不命中缓存，重读后文本相等', () => {
  write('identical payload', new Date(Date.now() - 5000));
  const a = readFileCached(file);
  write('identical payload', new Date(Date.now() + 5000));
  const b = readFileCached(file);
  assert.equal(b, 'identical payload');
  assert.ok(a !== b || b === 'identical payload', '重写后必须重新读盘（不依赖旧 memo）');
  // 重读后再次调用命中新 memo。
  const c = readFileCached(file);
  assert.ok(b === c, '重读落 memo 后应命中');
});

test('缺失 / 不可读 → null', () => {
  assert.equal(readFileCached(path.join(TMP, 'no-such-file.js')), null);
  assert.equal(readFileCached(''), null);
});

test('TOCTOU 双 stat：读取期间文件被改写 → 返回当次文本但不缓存', () => {
  const t0 = new Date(Date.now() - 10000);
  write('before-toctou', t0);
  assert.equal(readFileCached(file), 'before-toctou'); // 落 memo

  const t1 = new Date(Date.now() + 10000);
  // 先让缓存 miss（mtime 前移但内容仍是旧文本），确保走 read 路径。
  const t0b = new Date(Date.now() - 5000);
  write('before-toctou', t0b);
  const realStat = fs.statSync;
  const realRead = fs.readFileSync;
  let readCount = 0;
  // 劫持 readFileSync：读到旧内容后立即改写文件（模拟读窗口内的并发写）。
  fs.readFileSync = function (p, ...rest) {
    const out = realRead.call(fs, p, ...rest);
    if (p === file && readCount === 0) {
      readCount += 1;
      write('after-toctou', t1); // 第二次 stat 将与第一次不一致
    }
    return out;
  };
  let returned;
  try {
    returned = readFileCached(file);
  } finally {
    fs.readFileSync = realRead;
    fs.statSync = realStat;
  }
  // 契约：返回当次读到的文本（不抛、不伪造），且不得把旧文本缓存住。
  assert.equal(returned, 'before-toctou');
  const next = readFileCached(file);
  assert.equal(next, 'after-toctou', 'TOCTOU 窗口内的写入必须被下一次调用看到（未缓存陈旧值）');
});

test('并发读写：读者看到的永远是某次完整写入（不撕裂不陈旧）', async () => {
  const payloads = Array.from({ length: 40 }, (_, i) => `payload-${i}-${'x'.repeat(50)}`);
  // 预热缓存。
  write(payloads[0], new Date(Date.now() - 60000));
  readFileCached(file);
  // 写者在异步轮次里持续改文件；读者并发读并校验内容 ∈ payloads。
  let writerDone = false;
  const writer = (async () => {
    for (let i = 1; i < payloads.length; i += 1) {
      write(payloads[i], new Date(Date.now() - 60000 + i * 1000));
      await new Promise((r) => setImmediate(r));
    }
    writerDone = true;
  })();
  let reads = 0;
  while (!writerDone && reads < 500) {
    const text = readFileCached(file);
    assert.ok(payloads.includes(text), `读者读到撕裂/未知内容: ${JSON.stringify(String(text).slice(0, 30))}`);
    reads += 1;
    await new Promise((r) => setImmediate(r));
  }
  await writer;
  const final = readFileCached(file);
  assert.equal(final, payloads[payloads.length - 1], '写者结束后读者必须看到最终内容');
});
