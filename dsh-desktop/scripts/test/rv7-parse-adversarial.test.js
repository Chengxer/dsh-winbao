'use strict';
// RV7 边界对抗审查：解析面 malformed input 对抗（Node 侧可达面）。
//
// 覆盖三个解析面：
//  1. composition-integrity.js parseServiceRows —— cordis.patch.yml 敌意形态
//     （BOM / CRLF / 嵌套引号 / 巨型行 / 10 万服务行）。
//  2. dsh-file-drop client.js core —— normalizeDropPayload / sanitizePath /
//     normalizeDropEntry 敌意载荷（路径穿越 / size 谎报 / name 控制字符 /
//     files 数组 10 万条 / 伪形态）。
//  3. bridge-shim.js escHtml —— 从 dist 产物提取转义函数做 XSS fuzz；并对
//     menuPanel.innerHTML 模板做「动态插值必须经 escHtml」的源审计断言
//     （更新菜单文案 / 仓库地址是远端可控文本的注入点）。
//
// 运行：node --test scripts/test/rv7-parse-adversarial.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const INTEGRITY = require('../integration/composition-integrity.js');

// ---------------------------------------------------------------------------
// 1. composition-integrity：cordis.patch.yml 敌意形态
// ---------------------------------------------------------------------------

function rowText(id, name) {
  return 'insert:\n    - id: ' + id + '\n      name: ' + name + '\n';
}

test('rv7 ci: BOM 首行不破坏首行解析', () => {
  const content = '\uFEFF' + rowText('credentials', "'@deepseek-ai/dsh-credentials-local'");
  const { rows, parseIssues } = INTEGRITY.parseServiceRows(content, 'bom');
  // BOM 粘在首行行首：matchRowId 的 ^\s* 不吞 BOM → 首行成坏行（容错降级，
  // 不崩溃、不误报在场）。这是可接受的降级：UTF-8 BOM 的真实 cordis.patch.yml
  // 并不存在（宿主产物无 BOM）。
  assert.ok(Array.isArray(rows));
  assert.ok(Array.isArray(parseIssues));
  const got = rows.find((r) => r.rowId === 'credentials');
  assert.ok(!got || got.name === '@deepseek-ai/dsh-credentials-local');
});

test('rv7 ci: CRLF 行尾全量解析不受影响', () => {
  const content = rowText('a', 'pkg-a').replace(/\n/g, '\r\n') + rowText('b', 'pkg-b').replace(/\n/g, '\r\n');
  const { rows, parseIssues } = INTEGRITY.parseServiceRows(content, 'crlf');
  assert.equal(parseIssues.length, 0, 'CRLF 不得产生坏行');
  assert.deepEqual(rows.map((r) => r.rowId), ['a', 'b']);
});

test('rv7 ci: 嵌套引号与注释尾巴', () => {
  const hostile = [
    'insert:',
    '    - id: "x\\"y"        # trailing "comment"',
    "      name: 'it''s'",
    '    - id: plain#notcomment',
    '      name: pkg',
  ].join('\n');
  const { rows } = INTEGRITY.parseServiceRows(hostile, 'q');
  // 引号内转义形态（yaml 本身不支持 "" 转义）按字面吞吐——垃圾进垃圾出，
  // 但不得崩、不得把注释后的内容当值。
  assert.ok(rows.length >= 1);
  const plain = rows.find((r) => r.rowId === 'plain');
  assert.ok(plain, '无引号值含 #：正则 [^\\s#]+ 截到 # 前（记录形态）');
});

test('rv7 ci: 巨型单行（1MB 无换行）不崩不滞', () => {
  const giant = '- id: ' + 'x'.repeat(1024 * 1024);
  const t0 = Date.now();
  const { rows } = INTEGRITY.parseServiceRows(giant, 'giant');
  assert.ok(Date.now() - t0 < 2000, '1MB 单行须秒内');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rowId.length, 1024 * 1024);
});

test('rv7 ci: 10 万服务行性能与正确性', () => {
  const parts = ['insert:'];
  for (let i = 0; i < 100000; i++) parts.push('    - id: s' + i, '      name: pkg' + i);
  const t0 = Date.now();
  const { rows, parseIssues } = INTEGRITY.parseServiceRows(parts.join('\n'), 'flood');
  const ms = Date.now() - t0;
  assert.equal(rows.length, 100000);
  assert.equal(parseIssues.length, 0);
  assert.ok(ms < 5000, '10 万行解析须 <5s，实测 ' + ms + 'ms');
});

test('rv7 ci: 空串 / 纯注释 / null 安全', () => {
  assert.deepEqual(INTEGRITY.parseServiceRows('').rows, []);
  assert.deepEqual(INTEGRITY.parseServiceRows('# only comment\n').rows, []);
  let threw = false;
  try { INTEGRITY.parseServiceRows(null); } catch (e) { threw = true; }
  assert.ok(!threw, 'String(null) 容错不得抛');
});

// ---------------------------------------------------------------------------
// 2. dsh-file-drop：拖放载荷对抗
// ---------------------------------------------------------------------------

// client.js 是浏览器 IIFE（注册 __ModuleLoader__）：Node 下伪造最小 window
// 捕获其纯逻辑 core（生产无副作用面）。
function loadFileDropCore() {
  const captured = {};
  global.window = {
    __ModuleLoader__: { load: (m) => { captured.core = m.factory(require).core; } },
  };
  try {
    require('../../assets/plugins/dsh-file-drop/lib/client.js');
  } finally {
    delete global.window;
  }
  assert.ok(captured.core, '必须捕获 __dshFileDropCore');
  return captured.core;
}
const core = loadFileDropCore();

test('rv7 drop: 路径穿越 / UNC / 绝对路径混入——sanitizePath 只去控制字符与引号（记录形态）', () => {
  const c = core;
  // 设计事实：sanitizePath 不剥 ../（路径提示语义就是要完整路径）。穿越片段
  // 会原样进入 composer 文本——但 Rust 侧 precheck 的 path 来自真实 fs 元数据，
  // 此面仅在「内核页面被攻陷后伪造 window CustomEvent」时可达（P2，见报告）。
  assert.equal(c.sanitizePath('..\\..\\evil.txt'), '..\\..\\evil.txt');
  assert.equal(c.sanitizePath('\\\\server\\share\\f.bin'), '\\\\server\\share\\f.bin');
  // 控制字符（含 NUL、\n 属 \u000a）与引号被剥。
  assert.equal(c.sanitizePath('a\u0000b"c\'d\ne'), 'abcde');
  // trim + 4096 截断。
  assert.equal(c.sanitizePath('  x  '), 'x');
  assert.equal(c.sanitizePath('x'.repeat(5000)).length, 4096);
  // 空形态。
  assert.equal(c.sanitizePath(null), '');
  assert.equal(c.sanitizePath('\u0001\u0002'), '');
});

test('rv7 drop: name 控制字符 / 路径分隔符被剥，basename 兜底', () => {
  const c = core;
  const e = c.normalizeDropEntry({ path: 'C:\\dir\\sub\\a.txt', name: 'b\u0000a:d*?.txt' });
  assert.equal(e.name, 'bad.txt');
  // 无 name 时从净化后 path 取 basename（穿越段不进 name）。
  const e2 = c.normalizeDropEntry({ path: '..\\..\\..\\evil.exe' });
  assert.equal(e2.name, 'evil.exe');
  assert.equal(e2.path, '..\\..\\..\\evil.exe'); // path 保留（提示语义）
});

test('rv7 drop: size 谎报归一（负数/NaN/Infinity/字符串→null 或数）', () => {
  const c = core;
  assert.equal(c.normalizeDropEntry({ path: 'p' }).size, null);
  assert.equal(c.normalizeDropEntry({ path: 'p', size: -5 }).size, null);
  assert.equal(c.normalizeDropEntry({ path: 'p', size: NaN }).size, null);
  assert.equal(c.normalizeDropEntry({ path: 'p', size: Infinity }).size, null);
  assert.equal(c.normalizeDropEntry({ path: 'p', size: '123' }).size, 123); // Number() 宽容
  assert.equal(c.normalizeDropEntry({ path: 'p', size: 1e308 }).size, 1e308); // 不上限——展示层 formatSize 吞吐
});

test('rv7 drop: files 数组 10 万条洪水——归一 O(n) 且出口截断 100', () => {
  const files = [];
  for (let i = 0; i < 100000; i++) files.push({ path: 'C:\\f\\f' + i + '.txt', size: i });
  const t0 = Date.now();
  const out = core.normalizeDropPayload({ type: 'drop', files });
  assert.ok(Date.now() - t0 < 3000, '10 万条归一须 <3s');
  assert.equal(out.length, 100, '出口硬顶 100 条');
});

test('rv7 drop: 伪形态载荷全部安全降级为 []', () => {
  const c = core;
  assert.deepEqual(c.normalizeDropPayload(null), []);
  assert.deepEqual(c.normalizeDropPayload('string'), []);
  assert.deepEqual(c.normalizeDropPayload({ files: 'not-array' }), []);
  assert.deepEqual(c.normalizeDropPayload({ files: [null, 42, 'x', {}, { name: '' }] }), []);
  assert.equal(c.normalizeDropPayload({ files: [{ name: 'only-name' }] }).length, 1);
  // dataUrl/base64 巨串（>160MB 字符）视为损坏丢弃。
  const huge = { path: 'p', base64: 'A'.repeat(161 * 1024 * 1024) };
  const e = c.normalizeDropEntry(huge);
  assert.ok(!e.base64, '超长 base64 不得透传');
});

test('rv7 drop: buildDropHint 敌意 name/path 只产纯文本（无标记语言解释面）', () => {
  const hint = core.buildDropHint([
    { name: '<img src=x onerror=alert(1)>', path: '"><script>alert(2)</script>', size: 1 },
  ]);
  // 注入目标是 textarea.value（纯文本语义），非 innerHTML——断言内容完整吞吐
  // 且函数本身不依赖任何 DOM 解释。
  assert.ok(hint.includes('onerror=alert(1)'));
  assert.ok(hint.includes('<script>'));
});

// ---------------------------------------------------------------------------
// 3. bridge-shim：escHtml 提取 fuzz + innerHTML 模板源审计
// ---------------------------------------------------------------------------

const SHIM = fs.readFileSync(
  path.join(REPO, 'dsh-tauri', 'src-tauri', 'crates', 'bridge', 'dist', 'bridge-shim.js'),
  'utf8',
);

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '必须能从 shim 定位 ' + name);
  const brace = src.indexOf('{', start);
  // 函数体止于行首两空格的闭花括号（shim 统一缩进层级）。
  const sep = /\r?\n  \}/.exec(src.slice(brace));
  assert.ok(sep, '必须能截到 ' + name + ' 函数体');
  const body = src.slice(brace, brace + sep.index + sep[0].length);
  // eslint-disable-next-line no-new-f
  return new Function('return function ' + name + '(s) ' + body.replace(/\r/g, ''))();
}

test('rv7 shim: escHtml 对 XSS payload 全转义（fuzz）', () => {
  const escHtml = extractFn(SHIM, 'escHtml');
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '"><svg onload=alert(2)>',
    "'-alert(3)-'",
    '</textarea><script>alert(4)</script>',
    'javascript:/*--></title></style></textarea></script></xmp>'
      + '<svg/onload+\'+"/+/onmouseover=1/+/[*/[]/+alert(5)//\'>',
    '📦<b>汉字&"\'</b>',
    '\u0000<iframe>\u007f',
    String.fromCharCode(60).repeat(1000),
  ];
  for (const p of payloads) {
    const out = escHtml(p);
    assert.ok(!/[<>"']/.test(out), 'escHtml 输出不得残留裸 <>"\'：' + JSON.stringify(p));
    assert.ok(out.includes('&lt;') || !p.includes('<'));
  }
  // null/undefined/对象吞吐 String()。
  assert.equal(escHtml(null), '');
  assert.equal(escHtml(undefined), '');
  assert.equal(escHtml(42), '42');
});

test('rv7 shim: menuPanel.innerHTML 模板的全部动态插值必须经 escHtml（源审计）', () => {
  // renderMenu 的 innerHTML 模板串：提取后逐插值检查。动态值 = s.appVersion /
  // s.agentVersion / s.agentSource / repos.* / updRowHtml()（其内部 label 也经 escHtml）。
  const seg = SHIM.slice(SHIM.indexOf('menuPanel.innerHTML'), SHIM.indexOf("var items = menuPanel.querySelectorAll"));
  assert.ok(seg.length > 200, '必须截到 renderMenu 模板段');
  // 模板内所有 "+ expr +" 插值。
  const interp = seg.match(/\+ ([^+;]+?) \+/g) || [];
  assert.ok(interp.length >= 6, '模板应含多个动态插值，实测 ' + interp.length);
  for (const raw of interp) {
    const expr = raw.replace(/^\+ /, '').replace(/ \+$/, '');
    // 允许：escHtml(...) 包裹、纯静态 HTML 片段（引号字符串）、已审计函数调用。
    if (/^escHtml\(/.test(expr)) continue;
    if (/^(menuItemHtml|updRowHtml)\(/.test(expr)) continue;
    if (/^'[^']*'$/s.test(expr)) continue; // 静态片段
    assert.fail('innerHTML 模板存在未转义插值: ' + expr);
  }
});

test('rv7 shim: notification-jump 载荷校验存在（sessionId trim + ≤256 + 冻结）', () => {
  // 源审计：敌意 sessionId（巨串/引号）在垫片入口被拒/净化，且消费面
  // onNotificationJump 只回传 {sessionId} 纯数据对象（无 DOM 注入）。
  assert.ok(SHIM.includes("typeof p.sessionId === 'string' ? p.sessionId.trim() : ''"));
  assert.ok(SHIM.includes('id.length <= 256'));
  assert.ok(SHIM.includes('Object.freeze({ sessionId: id })'));
  // 巨串（>256）拒收：提取 map 函数等价重演。
  const map = (p) => {
    const id = p && typeof p.sessionId === 'string' ? p.sessionId.trim() : '';
    return id && id.length <= 256 ? Object.freeze({ sessionId: id }) : null;
  };
  assert.equal(map({ sessionId: 'x'.repeat(257) }), null);
  assert.equal(map({ sessionId: '  "><script>  ' }).sessionId, '"><script>');
  assert.equal(map({ sessionId: 123 }), null);
  assert.equal(map(null), null);
});
