'use strict';
// unit-empty-tool-name.test.js —— K11（unknown tool "" 死循环）空工具名指引补丁单测。
//
// 覆盖：
//   1. transform 三态：pristine 命中（空 name 特判 + 指引）/ already 幂等 /
//      anchor-missing 容忍（版本漂移不改写）。
//   2. 补丁语义（真实 eval）：空 name → 带「工具调用 name 为空」指引；非空
//      name → `unknown tool "${name}"` 与带 reachableFrom 分支逐字不变。
//   3. 根应用器：临时目录真实读写（应用 → already → 计数与日志）。
//   4. 注册表登记：empty-tool-name-guidance 条目存在、root 应用器可解析、
//      cli:true（CLI 同步期也应用）、failPolicy warn。
//   5. patch-deps 集成：dev node_modules 目标文件在补丁后含 marker。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  patchEmptyToolName,
  transformEmptyToolName,
  EMPTY_TOOL_NAME_MARKER,
  TOOLS_REL,
} = require('../lib/empty-tool-name-patch');

/** ToolNotFoundError 上游 pristine 形态（2-tab 缩进，含最小 HarnessError 桩供 eval）。 */
const PRISTINE = [
  'class HarnessError extends Error {',
  '\tconstructor(message, code) { super(message); this.code = code; }',
  '}',
  'var ToolNotFoundError = class extends HarnessError {',
  '\tconstructor(toolName, reachableFrom) {',
  '\t\tsuper(reachableFrom === void 0 ? `unknown tool "${toolName}"` : `unknown tool "${toolName}": ${reachableFrom}`, "UNKNOWN_TOOL");',
  '\t\tthis.name = "ToolNotFoundError";',
  '\t}',
  '};',
].join('\n');

/** 把（补丁后）源码 eval 成 ToolNotFoundError 构造器，供语义断言用。 */
function instantiate(src) {
  return new Function(src + '\nreturn ToolNotFoundError;')();
}

const PKG_DIR = path.resolve(__dirname, '..');

test('transform: pristine 命中 → 空 name 特判 + 指引注入', () => {
  const r = transformEmptyToolName(PRISTINE, 'x.js');
  assert.equal(r.status, 'changed');
  assert.ok(r.src.includes(EMPTY_TOOL_NAME_MARKER));
  // 语义核心：空 name 报错携带可操作指引，非空 name 逐字不变。
  const E = instantiate(r.src);
  const emptyMsg = new E('').message;
  assert.ok(emptyMsg.includes('工具调用 name 为空'), '空 name 必须携带中文指引');
  assert.ok(!emptyMsg.includes('unknown tool ""'), '不再输出裸 `unknown tool ""`');
  assert.equal(new E('foo').message, 'unknown tool "foo"');
  assert.equal(new E('foo', 'bar').message, 'unknown tool "foo": bar');
});

test('transform: 已应用 → already 幂等', () => {
  const once = transformEmptyToolName(PRISTINE, 'x.js');
  const twice = transformEmptyToolName(once.src, 'x.js');
  assert.equal(twice.status, 'already');
});

test('transform: 锚点失配 → anchor-missing 不改写', () => {
  const drifted = PRISTINE.replace('"UNKNOWN_TOOL"', '"UNKNOWN_TOOL_CODE"');
  const r = transformEmptyToolName(drifted, 'x.js');
  assert.equal(r.status, 'anchor-missing');
});

test('根应用器: 临时目录 应用→幂等→计数', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-tool-name-'));
  try {
    const target = path.join(tmp, '@deepseek-ai', TOOLS_REL);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, PRISTINE, 'utf8');
    const logs = [];
    const stats = { anchorMissing: 0, failed: 0 };
    assert.equal(patchEmptyToolName(tmp, (m) => logs.push(m), stats), 1, '首次应用应计 1');
    assert.equal(fs.readFileSync(target, 'utf8').includes(EMPTY_TOOL_NAME_MARKER), true);
    assert.equal(patchEmptyToolName(tmp, () => {}, stats), 0, '再次应用幂等计 0');
    assert.equal(stats.anchorMissing, 0);
    assert.equal(stats.failed, 0);
    // 目录缺包 → 静默 0。
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-tool-name-empty-'));
    try {
      assert.equal(patchEmptyToolName(empty, () => {}), 0);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('注册表: empty-tool-name-guidance 条目登记齐全', () => {
  const { getSpecsByGroup } = require('../lib/patch-registry');
  const spec = getSpecsByGroup().find((s) => s.id === 'empty-tool-name-guidance');
  assert.ok(spec, 'patch-registry 必须登记 empty-tool-name-guidance');
  assert.equal(spec.kind, 'root');
  assert.equal(spec.group, 'package');
  assert.equal(spec.failPolicy, 'warn');
  assert.equal(spec.cli, true, 'CLI 同步期也应应用（内核包补丁）');
  assert.equal(typeof spec.apply, 'function');
  assert.ok(spec.successLog && spec.failLog);
});

test('dev node_modules: 补丁后目标文件含 marker 且裸报错已替换', () => {
  const file = path.join(PKG_DIR, 'node_modules', '@deepseek-ai', TOOLS_REL);
  if (!fs.existsSync(file)) {
    // CI 干净环境可能未 npm install；postinstall 会补，跳过即可。
    return;
  }
  const n = patchEmptyToolName(path.join(PKG_DIR, 'node_modules'), () => {});
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(src.includes(EMPTY_TOOL_NAME_MARKER), 'dev node_modules 应含空工具名指引 marker（本断言前已幂等应用）');
  assert.ok(src.includes('工具调用 name 为空'), 'dev node_modules 应含中文指引正文');
  // 裸 `unknown tool ""` 分支已被替换：原始 super 行不应再存在。
  assert.ok(!src.includes('super(reachableFrom === void 0 ? `unknown tool "${toolName}"` : `unknown tool "${toolName}": ${reachableFrom}`, "UNKNOWN_TOOL");'), '原始 super 行应已替换');
  // 非空 name 两分支逐字保留。
  assert.ok(src.includes('message = `unknown tool "${toolName}"`;'));
  assert.ok(src.includes('message = `unknown tool "${toolName}": ${reachableFrom}`;'));
});
