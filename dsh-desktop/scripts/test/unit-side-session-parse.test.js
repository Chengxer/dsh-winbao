'use strict';
// dsh-side-session 增量解析等价性测试：
// 大日志（7MB 压缩 ≈ 20MB 文本）全量解压+逐行解析约 600ms 同步阻塞，会拖慢
// 同进程的聊天请求；增量版只解自上次帧边界以来的新帧。本测试验证：
//   1) 首次全量解析结果正确；
//   2) 追加新帧后增量续解，transcript/title/files 正确延伸；
//   3) 增量结果与「重置缓存后全量解析」逐字段一致；
//   4) 文件整体替换（新文件写回）后自动回退全量解析。
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-parse-'));
process.env.DSH_HOME = home;
const SID = 'session-parse-test-1';
const sessDir = path.join(home, 'sessions', 'proj-x', SID);
fs.mkdirSync(sessDir, { recursive: true });
const logFile = path.join(sessDir, 'session.jsonl.zstd');

const ev = (type, data) => JSON.stringify({ type, data }) + '\n';
const head = JSON.stringify({ type: 'session', id: SID, cwd: home }) + '\n';
const append = (text) => fs.appendFileSync(logFile, zlib.zstdCompressSync(Buffer.from(text)));

let mod;
test('setup: 导入插件模块并写入首帧', async () => {
  mod = await import(pathToFileURL(path.join(__dirname, '..', '..', 'assets', 'plugins', 'dsh-side-session', 'lib', 'index.js')));
  assert.equal(typeof mod.parseSession, 'function', '导出 parseSession');
  append(head + ev('user/message', { content: [{ type: 'text', text: '第一条问题' }] }));
  mod.resetParseCacheForTest();
});

test('首次解析：全量基线', () => {
  const r = mod.parseSession(SID);
  assert.equal(r.transcript.length, 1);
  assert.equal(r.transcript[0].role, 'user');
  assert.equal(r.transcript[0].text, '第一条问题');
});

test('追加新帧：增量续解正确延伸', () => {
  // 追加：助手回复 + 标题 + 一次文件读取（write 事件）
  append(
    ev('assistant/message', { message: { content: [{ type: 'text', text: '这是回复一' }] } }) +
    ev('session/title', { title: '增量解析测试' }) +
    ev('tool/code-dispatch', { name: 'read', arguments: { file_path: 'C:\\demo\\a.ts' } })
  );
  const r = mod.parseSession(SID);
  assert.equal(r.transcript.length, 2, '增量后 transcript 两条');
  assert.equal(r.transcript[1].role, 'assistant');
  assert.equal(r.transcript[1].text, '这是回复一');
  assert.equal(r.title, '增量解析测试');
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].path, 'C:\\demo\\a.ts');
  assert.equal(r.files[0].op, 'read');
});

test('增量结果与全量解析逐字段一致', () => {
  // 再追加两帧（多帧拼接场景）
  append(ev('user/message', { content: [{ type: 'text', text: '第二个问题' }] }));
  append(ev('assistant/message', { message: { content: [{ type: 'text', text: '这是回复二' }] } }));
  const rInc = mod.parseSession(SID);
  mod.resetParseCacheForTest();
  const rFull = mod.parseSession(SID);
  assert.deepEqual(rInc.transcript, rFull.transcript, 'transcript 一致');
  assert.deepEqual(rInc.files, rFull.files, 'files 一致');
  assert.equal(rInc.title, rFull.title, 'title 一致');
  assert.equal(rInc.provider, rFull.provider, 'provider 一致');
  assert.equal(rInc.model, rFull.model, 'model 一致');
  assert.equal(rInc.truncated, rFull.truncated, 'truncated 一致');
});

test('文件整体替换：自动回退全量解析', () => {
  // 用另一个 id 的文件覆盖（模拟整文件替换）
  const replaced = JSON.stringify({ type: 'session', id: SID, cwd: home }) + '\n' +
    ev('user/message', { content: [{ type: 'text', text: '替换后的新会话' }] });
  fs.writeFileSync(logFile, zlib.zstdCompressSync(Buffer.from(replaced)));
  mod.resetParseCacheForTest();
  const r1 = mod.parseSession(SID); // 建立新基线缓存
  assert.equal(r1.transcript.length, 1);
  assert.equal(r1.transcript[0].text, '替换后的新会话');
  // 追加后增量续解
  append(ev('assistant/message', { message: { content: [{ type: 'text', text: '替换后的回复' }] } }));
  const r2 = mod.parseSession(SID);
  assert.equal(r2.transcript.length, 2);
  assert.equal(r2.transcript[1].text, '替换后的回复');
  // 与全量一致
  mod.resetParseCacheForTest();
  const r3 = mod.parseSession(SID);
  assert.deepEqual(r2.transcript, r3.transcript);
});

test('cleanup: 删除临时 DSH_HOME', () => {
  fs.rmSync(home, { recursive: true, force: true });
});
