'use strict';

// plugin-core 基础层单测：ids（全局唯一 id 税）/ errors（统一错误税）/ text（正则
// 转义、EOL 检测与保持、行级工具）。测试只编码规格（模块头注释 + 架构文档 §9）；
// 与矩阵预期不一致的正则宽松行为以注释 pin 在对应 test 内，不修改生产代码。

const test = require('node:test');
const assert = require('node:assert/strict');

const { LOADER_ID_RE, PACKAGE_NAME_RE, isLoaderId, isPackageName, assertLoaderId, assertPackageName, packageDirName } = require('../plugin-core/lib/ids');
const { PLUGIN_ERROR_CODES, PLUGIN_ERROR_MESSAGES, PluginError, isPluginError, asPluginError } = require('../plugin-core/lib/errors');
const { escRegExp, detectEol, splitLines, joinLines, preserveEol, yamlQuote } = require('../plugin-core/lib/text');

// ── ids: LOADER_ID_RE ───────────────────────────────────────────────────────

test('ids: LOADER_ID_RE 合法集（字母/数字开头，后接字母/数字/下划线/点/连字符）', () => {
  const valid = ['a', 'a1', 'a.b', 'a-b', 'a_b', 'a.b-c_1', '0', 'x'.repeat(200)];
  for (const id of valid) {
    assert.ok(LOADER_ID_RE.test(id), `正则应接受 ${JSON.stringify(id)}`);
    assert.ok(isLoaderId(id), `isLoaderId 应接受 ${JSON.stringify(id)}`);
  }
});

test('ids: LOADER_ID_RE 非法集', () => {
  const invalid = ['', ' ', '.', '-a', '_a', 'a b', 'a/b', 'a\\b', 'a:b', 'a*', 'a(', '..', 'a ', '插件'];
  for (const id of invalid) {
    assert.ok(!LOADER_ID_RE.test(id), `正则应拒绝 ${JSON.stringify(id)}`);
    assert.ok(!isLoaderId(id), `isLoaderId 应拒绝 ${JSON.stringify(id)}`);
  }
});

test('ids: LOADER_ID_RE 宽松边界（与矩阵预期相反的事实，pin）', () => {
  // 'a.'（尾点）：矩阵列为 invalid，但正则只要求「以字母/数字开头」，其后
  // [A-Za-z0-9_.-]* 允许尾随点，故 'a.' 实际通过 —— pin 之。
  assert.ok(LOADER_ID_RE.test('a.'), "'a.' 尾点实际被正则接受（仅约束首字符）");
  // '__proto__'：矩阵标注「passes regex」，但实际以 '_' 开头、不满足首字符
  // [A-Za-z0-9]，正则本身即拒绝；map 层防原型污染由 state-store 兜底。
  assert.ok(!LOADER_ID_RE.test('__proto__'), "'__proto__' 以 '_' 开头被正则拒绝");
});

test('ids: assertLoaderId 非法抛 PluginError(PLUGIN_BAD_ID)，合法原样返回', () => {
  assert.equal(assertLoaderId('ok.id'), 'ok.id');
  assert.equal(assertLoaderId('a'), 'a');
  assert.throws(() => assertLoaderId('bad id'), (err) => {
    assert.ok(err instanceof PluginError);
    assert.equal(err.code, PLUGIN_ERROR_CODES.PLUGIN_BAD_ID);
    return true;
  });
  assert.throws(() => assertLoaderId(''), (err) => err.code === PLUGIN_ERROR_CODES.PLUGIN_BAD_ID);
  assert.throws(() => assertLoaderId(null), (err) => err.code === PLUGIN_ERROR_CODES.PLUGIN_BAD_ID);
});

// ── ids: PACKAGE_NAME_RE ────────────────────────────────────────────────────

test('ids: PACKAGE_NAME_RE 合法集', () => {
  const valid = ['foo', 'foo.bar', 'foo_bar', 'foo-bar', 'foo123', '@scope/name', '@scope/foo.bar', 'Name', '@s-c0pe/x'];
  for (const n of valid) {
    assert.ok(PACKAGE_NAME_RE.test(n), `正则应接受 ${JSON.stringify(n)}`);
    assert.ok(isPackageName(n), `isPackageName 应接受 ${JSON.stringify(n)}`);
  }
});

test('ids: PACKAGE_NAME_RE 非法集', () => {
  const invalid = ['', ' ', '@scope', '@scope/', '/name', 'name ', 'name\n', '../x', 'name#tag'];
  for (const n of invalid) {
    assert.ok(!PACKAGE_NAME_RE.test(n), `正则应拒绝 ${JSON.stringify(n)}`);
    assert.ok(!isPackageName(n), `isPackageName 应拒绝 ${JSON.stringify(n)}`);
  }
});

test('ids: PACKAGE_NAME_RE 拒绝前导点（新增负向 (?!\\.)）', () => {
  // 头部注释新增负向：拒绝前导点（'.'/'..'/'...'）——这类名字过不了任何真实 npm 包，
  // 且会削弱下游路径围栏。当前正则 /^(?!\.)(@[a-z0-9-]+\/)?[a-z0-9._-]+$/i 实现。
  const leadingDot = ['.', '..', '...', '.foo'];
  for (const n of leadingDot) {
    assert.ok(!PACKAGE_NAME_RE.test(n), `正则应拒绝前导点 ${JSON.stringify(n)}`);
    assert.ok(!isPackageName(n), `isPackageName 应拒绝前导点 ${JSON.stringify(n)}`);
  }
});

test('ids: PACKAGE_NAME_RE 大小写边界（/i 标志，pin）', () => {
  // 'Name'（裸名大写）：/i 使整条正则不区分大小写，裸名大写通过 —— 历史兼容。
  assert.ok(PACKAGE_NAME_RE.test('Name'), "裸名 'Name' 因 /i 通过（历史兼容）");
  // '@Scope/name'（scope 大写）：矩阵标注「invalid per regex」，但 /i 作用于整个
  // 正则，scope 组 [a-z0-9-] 同样不区分大小写，故实际通过 —— 与头部注释
  // 「scope 仅小写字母数字连字符」存在偏差（兼容优先，未收紧）。pin 之。
  assert.ok(PACKAGE_NAME_RE.test('@Scope/name'), "'@Scope/name' 因 /i 实际通过（与 scope 仅小写注释有偏差）");
});

test('ids: assertPackageName 非法抛 PluginError(PLUGIN_BAD_PACKAGE)，合法原样返回', () => {
  assert.equal(assertPackageName('ok-pkg'), 'ok-pkg');
  assert.equal(assertPackageName('@scope/pkg'), '@scope/pkg');
  assert.throws(() => assertPackageName('bad name'), (err) => {
    assert.ok(err instanceof PluginError);
    assert.equal(err.code, PLUGIN_ERROR_CODES.PLUGIN_BAD_PACKAGE);
    return true;
  });
  assert.throws(() => assertPackageName('../evil'), (err) => err.code === PLUGIN_ERROR_CODES.PLUGIN_BAD_PACKAGE);
});

test('ids: packageDirName 去 scope 前缀 / String 强转（pin）', () => {
  assert.equal(packageDirName('@scope/name'), 'name');
  assert.equal(packageDirName('name'), 'name');
  assert.equal(packageDirName(''), '');
  // 非字符串：String 强转。注意 `name || ''` 只作用于 slash 检测，返回时用
  // String(name)，故 null/undefined 会强转成其字符串形式（pin）。
  assert.equal(packageDirName(123), '123');
  assert.equal(packageDirName(null), 'null');
});

// ── errors: PluginError ─────────────────────────────────────────────────────

test('errors: PluginError 形态（name / 兜底文案 / 自定义 / instanceof Error）', () => {
  const e = new PluginError('PLUGIN_BUSY');
  assert.equal(e.name, 'PluginError');
  assert.ok(e instanceof Error);
  assert.equal(e.message, PLUGIN_ERROR_MESSAGES.PLUGIN_BUSY, '缺省 message 用稳定文案兜底');
  assert.equal(new PluginError('PLUGIN_BUSY', 'custom message').message, 'custom message');
  // 无映射 code → 退回 String(code)
  assert.equal(new PluginError('UNKNOWN_CODE').message, 'UNKNOWN_CODE');
});

test('errors: PluginError detail 保留 + toJSON 形态', () => {
  const withDetail = new PluginError('PLUGIN_BUSY', undefined, { id: 'x', at: 1 });
  assert.deepEqual(withDetail.detail, { id: 'x', at: 1 });
  assert.deepEqual(withDetail.toJSON(), {
    code: 'PLUGIN_BUSY',
    message: PLUGIN_ERROR_MESSAGES.PLUGIN_BUSY,
    detail: { id: 'x', at: 1 },
  });
  const noDetail = new PluginError('PLUGIN_BUSY');
  assert.deepEqual(noDetail.toJSON(), { code: 'PLUGIN_BUSY', message: PLUGIN_ERROR_MESSAGES.PLUGIN_BUSY });
  assert.ok(!('detail' in noDetail.toJSON()), '未提供 detail 时 toJSON 无 detail 键');
});

// ── errors: 码表不变量 ──────────────────────────────────────────────────────

test('errors: PLUGIN_ERROR_CODES 冻结且码值唯一', () => {
  assert.ok(Object.isFrozen(PLUGIN_ERROR_CODES), 'PLUGIN_ERROR_CODES 必须冻结');
  const values = Object.values(PLUGIN_ERROR_CODES);
  assert.equal(new Set(values).size, values.length, '所有 code 值唯一');
});

test('errors: PLUGIN_ERROR_MESSAGES 与 CODES 双向一致', () => {
  const codes = Object.values(PLUGIN_ERROR_CODES);
  const msgKeys = Object.keys(PLUGIN_ERROR_MESSAGES);
  for (const c of codes) {
    assert.ok(Object.prototype.hasOwnProperty.call(PLUGIN_ERROR_MESSAGES, c), `缺失文案: ${c}`);
    assert.equal(typeof PLUGIN_ERROR_MESSAGES[c], 'string', `文案非字符串: ${c}`);
    assert.ok(PLUGIN_ERROR_MESSAGES[c].length > 0, `文案为空: ${c}`);
  }
  for (const k of msgKeys) {
    assert.ok(codes.includes(k), `多余文案键（非 code）: ${k}`);
  }
  assert.equal(msgKeys.length, codes.length, '文案条目数必须等于 code 数');
});

// ── errors: isPluginError / asPluginError ───────────────────────────────────

test('errors: isPluginError 判定矩阵', () => {
  assert.ok(isPluginError(new PluginError('PLUGIN_BUSY')));
  assert.ok(isPluginError({ code: 'PLUGIN_BUSY' }));
  assert.ok(!isPluginError(null));
  assert.ok(!isPluginError(undefined));
  assert.ok(!isPluginError('PLUGIN_BUSY'));
  assert.ok(!isPluginError({}));
  assert.ok(!isPluginError({ code: 'toString' }));
  assert.ok(!isPluginError({ code: 'constructor' }));
  assert.ok(!isPluginError({ code: 'PLUGIN_NOT_A_REAL_CODE' }));
  assert.ok(!isPluginError(new Error('no code')));
});

test('errors: asPluginError 规整（原样 / 包装 Error / 包装非 Error / 默认码）', () => {
  const existing = new PluginError('PLUGIN_BUSY', 'm');
  assert.equal(asPluginError(existing, 'PLUGIN_BAD_ID'), existing, '已合规返回同一对象');

  const err = new Error('boom');
  const wrapped = asPluginError(err, 'PLUGIN_BAD_ID');
  assert.ok(wrapped instanceof PluginError);
  assert.equal(wrapped.code, 'PLUGIN_BAD_ID');
  assert.equal(wrapped.message, 'boom');
  assert.equal(wrapped.detail, err);

  const nonErr = asPluginError('plain string', 'PLUGIN_BAD_ID');
  assert.ok(nonErr instanceof PluginError);
  assert.equal(nonErr.code, 'PLUGIN_BAD_ID');
  assert.equal(nonErr.message, 'plain string');
  assert.equal(nonErr.detail, 'plain string');

  assert.equal(asPluginError(new Error('x')).code, 'PLUGIN_BUSY', '未给 code 默认 PLUGIN_BUSY');
});

// ── text: escRegExp ─────────────────────────────────────────────────────────

test('text: escRegExp 转义全部元字符', () => {
  const metachars = ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '[', ']', '|', '\\'];
  for (const c of metachars) {
    assert.equal(escRegExp(c), '\\' + c, `应转义 ${JSON.stringify(c)}`);
  }
  assert.equal(escRegExp('a.b+c'), 'a\\.b\\+c');
});

test('text: escRegExp 结果用于 new RegExp 仅匹配字面量', () => {
  const literal = 'a.b*c+d?^$';
  const re = new RegExp(escRegExp(literal));
  assert.ok(re.test(literal), '匹配字面量本身');
  assert.ok(!re.test('aXbXXcXXdXX'), '不得按元字符语义匹配');
  assert.ok(!new RegExp(escRegExp('.')).test('x'), "'.' 已字面量化，不匹配任意字符");
  assert.ok(new RegExp(escRegExp('.')).test('.'));
});

// ── text: detectEol / splitLines / joinLines ────────────────────────────────

test('text: detectEol 主导换行符判定', () => {
  assert.equal(detectEol('a\r\nb'), '\r\n');
  assert.equal(detectEol('a\nb'), '\n');
  assert.equal(detectEol('a\nb\r\nc'), '\r\n', '含单个 CRLF 的混合文本判 CRLF');
  assert.equal(detectEol(''), '\n');
});

test('text: splitLines 按行拆分', () => {
  assert.deepEqual(splitLines('a\r\nb\r\nc'), ['a', 'b', 'c']);
  assert.deepEqual(splitLines('a\nb\nc'), ['a', 'b', 'c']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b'], '无尾随换行时最后一行仍在');
  assert.deepEqual(splitLines(''), [''], '空串 → [""]（pin）');
});

test('text: joinLines 用指定 EOL 连接，非法 EOL 回退 LF', () => {
  assert.equal(joinLines(['a', 'b', 'c'], '\r\n'), 'a\r\nb\r\nc');
  assert.equal(joinLines(['a', 'b', 'c'], '\n'), 'a\nb\nc');
  assert.equal(joinLines(['a', 'b'], 'not-an-eol'), 'a\nb');
});

// ── text: preserveEol ───────────────────────────────────────────────────────

test('text: preserveEol EOL 保持', () => {
  // CRLF 原文 + 混合 changed（孤立 LF + CRLF）→ 全 CRLF，且无双重 CRLF。
  const out1 = preserveEol('a\r\nb', 'x\ny\r\nz');
  assert.equal(out1, 'x\r\ny\r\nz');
  assert.ok(!out1.includes('\r\r\n'), '不得出现双重 CRLF');
  // LF 原文 + CRLF changed → 全 LF。
  assert.equal(preserveEol('a\nb', 'x\r\ny'), 'x\ny');
  // CRLF 原文 + 已 CRLF changed → 字节不变。
  assert.equal(preserveEol('a\r\nb', 'x\r\ny'), 'x\r\ny');
  // 空原文 → LF 归一。
  assert.equal(preserveEol('', 'x\r\ny'), 'x\ny');
});

// ── text: yamlQuote ─────────────────────────────────────────────────────────

test('text: yamlQuote 单引号包裹与加倍', () => {
  assert.equal(yamlQuote('hello'), "'hello'");
  assert.equal(yamlQuote("it's"), "'it''s'");
  assert.equal(yamlQuote(''), "''");
});
