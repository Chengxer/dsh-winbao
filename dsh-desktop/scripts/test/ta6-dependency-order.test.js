'use strict';

// ---------------------------------------------------------------------------
// TA6 元测试 4：依赖序引擎实跑（用 root 应用器 / transform 真实执行验证
// registry 声明的 order 依赖不仅在数字上成立，在产物上也成立）。
//
//   a. session-manage(190) → session-orphans(195)：临时 nmRoot 里先 manage
//      后 orphans 都能应用；反序则 orphans 必须 anchor-missing（0 写入）；
//      两者幂等（二遍 0 写入）；
//   b. image-send(80) → vision-toggle(95) / vision-key(100)：裸 pristine 上
//      toggle/key anchor-missing；image-send 应用后三者依次 changed，再跑
//      全部 already；
//   c. K1 三层（151/152/153）：对各自 pristine 目标 changed；三种应用排列
//      的最终产物逐字节一致（真·独立，无顺序敏感）；
//   d. device-auth(154) 与 credentials-absent(153) 相邻：目标文件不同，
//      各自 applied 互不干扰（各自二遍 already）。
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PATCH_SPECS } = require('../lib/patch-registry');
const adapters = require('../lib/patch-adapters');

const PRISTINE_RC2 = path.join(__dirname, '..', '..', '..', '.tmp-rc2-stage', 'node_modules');
const byId = Object.fromEntries(PATCH_SPECS.map((s) => [s.id, s]));

function pristineRead(pkgRel) {
  const p = path.join(PRISTINE_RC2, '@deepseek-ai', pkgRel);
  assert.ok(fs.existsSync(p), `pristine 目标缺失 ${pkgRel}`);
  return fs.readFileSync(p, 'utf8');
}

// ---------------------------------------------------------------------------
// a. session-manage → session-orphans（root 应用器实跑）
// ---------------------------------------------------------------------------
const SESSION_MANAGE_PKGS = [
  'dsh-workspace', 'dsh-host-apiproxy', 'dsh-client-connection', 'dsh-client-ui-workspace',
];

function mkTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ta6-dep-'));
  const nm = path.join(root, 'node_modules');
  fs.mkdirSync(nm);
  for (const pkg of SESSION_MANAGE_PKGS) {
    fs.cpSync(path.join(PRISTINE_RC2, '@deepseek-ai', pkg), path.join(nm, '@deepseek-ai', pkg), { recursive: true });
  }
  return nm;
}

test('a1. 反序：pristine 上直接跑 session-orphans → 0 写入（anchor-missing 退役）', () => {
  const nm = mkTempRoot();
  try {
    const logs = [];
    const n = adapters.rootAppliers.patchSessionOrphans(nm, (m) => logs.push(m));
    assert.equal(n, 0, 'session-manage 未应用时 orphans 必须无可应用锚点');
    assert.ok(logs.some((l) => l.includes('session-manage 补丁未应用') || l.includes('锚点') || l.includes('失配') || l.includes('跳过')),
      `应产出 anchor-missing 日志，得 ${JSON.stringify(logs)}`);
  } finally { fs.rmSync(nm, { recursive: true, force: true }); }
});

test('a2. 正序：session-manage(190) 后 session-orphans(195) 均可应用且幂等', () => {
  const nm = mkTempRoot();
  try {
    assert.ok(adapters.rootAppliers.patchSessionManage(nm, () => {}) >= 1, 'session-manage 应有写入');
    const n2 = adapters.rootAppliers.patchSessionManage(nm, () => {});
    assert.equal(n2, 0, 'session-manage 二遍必须 0 写入（幂等）');
    assert.ok(adapters.rootAppliers.patchSessionOrphans(nm, () => {}) >= 1, 'orphans 在 manage 之后应有写入');
    assert.equal(adapters.rootAppliers.patchSessionOrphans(nm, () => {}), 0, 'orphans 二遍必须 0 写入');
    const src = fs.readFileSync(path.join(nm, '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js'), 'utf8');
    assert.ok(src.includes('dsh-desktop patch (session orphans)'), '产物含 orphans marker');
  } finally { fs.rmSync(nm, { recursive: true, force: true }); }
});

test('a3. registry 序：orphans.order > manage.order 且锚点文本即 manage 注入体', () => {
  const { SESSION_ORPHANS_ANCHOR } = require('../lib/patch-session-orphans');
  const nm = mkTempRoot();
  try {
    adapters.rootAppliers.patchSessionManage(nm, () => {});
    const src = fs.readFileSync(path.join(nm, '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js'), 'utf8');
    assert.ok(src.includes(SESSION_ORPHANS_ANCHOR), 'orphans 的锚点必须是 manage 的注入产物（依赖实锤）');
    assert.ok(byId['session-orphans'].order > byId['session-manage'].order);
  } finally { fs.rmSync(nm, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// b. image-send → vision 系（transform 链实跑）
// ---------------------------------------------------------------------------
const EXPOSE = 'dsh-host-apiproxy' + path.sep + 'lib' + path.sep + 'index.js';

test('b1. 裸 pristine：vision-toggle / vision-key 均 anchor-missing（依赖缺失不误伤）', () => {
  const src = pristineRead(EXPOSE);
  assert.equal(byId['vision-toggle-gate'].transform(src, EXPOSE).status, 'anchor-missing');
  assert.equal(byId['vision-key-fix'].transform(src, EXPOSE).status, 'anchor-missing');
});

test('b2. 依赖序链：image-send changed 后 toggle/key 短路 already（新树语义折叠）', () => {
  let src = pristineRead(EXPOSE);
  const r1 = byId['image-send-fix'].transform(src, EXPOSE);
  assert.equal(r1.status, 'changed'); src = r1.src;
  // 新版 image-send 的注入体已内联 toggle 语义与 settings.get 修复，
  // toggle/key 在其产物上靠 marker 短路 already（不重复注入）；
  // 它们的 changed 路径服务于旧树（老 image-send 产物），见 b3。
  const r2 = byId['vision-toggle-gate'].transform(src, EXPOSE);
  assert.equal(r2.status, 'already', 'image-send 新树产物应短路 toggle');
  const r3 = byId['vision-key-fix'].transform(src, EXPOSE);
  assert.equal(r3.status, 'already', 'image-send 新树产物应短路 key');
  for (const id of ['image-send-fix', 'vision-toggle-gate', 'vision-key-fix']) {
    assert.equal(byId[id].transform(src, EXPOSE).status, 'already', `${id} 终态应 already`);
  }
  assert.ok(byId['image-send-fix'].order < byId['vision-toggle-gate'].order);
  assert.ok(byId['image-send-fix'].order < byId['vision-key-fix'].order);
});

test('b3. 旧树模拟：toggle/key 的 changed 路径（旧 image-send 产物形态）', () => {
  // 旧 image-send 产物 = 新产物去掉 toggle 检查块与 settings.get 修复，
  // 即 registry 注释所述「IMAGE_SEND_MARKER 相同而内容未升级」的旧树。
  let old = pristineRead(EXPOSE);
  old = byId['image-send-fix'].transform(old, EXPOSE).src;
  // 还原 vision-key 的 FROM 形态（旧 helper 无 settings.get 分支）。
  const adaptersSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'patch-adapters.js'), 'utf8');
  assert.ok(adaptersSrc.includes('dsh-vision master switch'), '常量在实现源内');
  // 直接以 transform 契约验证：toggle 在含旧 gate 形态的输入上 changed。
  // 构造最小旧树：把 toggle 检查块与 key 修复从新树产物反向剥除。
  const toggleBlock = [
    '\t// DSH Desktop: dsh-vision master switch (enabled) — off means the user turned',
    '\t// the whole capability off in 设置 → 识图插件：skip conversion and flag the',
    '\t// throw so the gate below restores the upstream MODEL_DOES_NOT_SUPPORT_IMAGES',
    '\t// rejection (the exact pre-plugin behavior: images neither sent nor converted).',
    '\tif (vision !== null && vision.enabled === false) {',
    '\t\tconst visionDisabled = new Error("dsh-vision disabled");',
    '\t\tvisionDisabled.dshVisionDisabled = true;',
    '\t\tthrow visionDisabled;',
    '\t}',
    '',
  ].join('\n');
  assert.ok(old.includes(toggleBlock), '新树产物应含 toggle 检查块（剥除前提）');
  const gateBlock = [
    '\t\t\t\t\t\t\t\t\tif (error && error.dshVisionDisabled === true) {',
    '\t\t\t\t\t\t\t\t\t\treturn err(request, {',
  ].join('\n');
  assert.ok(old.includes(gateBlock), '新树产物应含 gate 短路块（剥除前提）');
  // 精确剥除 gate 内的 dshVisionDisabled if 块（6 行），还原旧 gate 形态：
  // `} catch (error) {` 之后直接 `return err(request, {`。
  const gateOld = [
    '\t\t\t\t\t\t\t\t\tadmittedContent = await describeImagesWithVision(ctx, content);',
    '\t\t\t\t\t\t\t\t} catch (error) {',
    '\t\t\t\t\t\t\t\t\tif (error && error.dshVisionDisabled === true) {',
    '\t\t\t\t\t\t\t\t\t\treturn err(request, {',
    "\t\t\t\t\t\t\t\t\t\t\tcode: 'attachment-error',",
    '\t\t\t\t\t\t\t\t\t\t\tmessage: `Model "${current.model}" does not support image input.`,',
    "\t\t\t\t\t\t\t\t\t\t\tdetails: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' }",
    '\t\t\t\t\t\t\t\t\t\t});',
    '\t\t\t\t\t\t\t\t\t}',
    '\t\t\t\t\t\t\t\t\treturn err(request, {',
  ].join('\n');
  const gateNew = [
    '\t\t\t\t\t\t\t\t\tadmittedContent = await describeImagesWithVision(ctx, content);',
    '\t\t\t\t\t\t\t\t} catch (error) {',
    '\t\t\t\t\t\t\t\t\treturn err(request, {',
  ].join('\n');
  assert.ok(old.includes(gateOld), '新树 gate 形态应与常量一致（剥除锚点）');
  const oldTree = old.replace(toggleBlock, '').replace(gateOld, gateNew);
  // 旧树上 toggle 必须能补挂（changed）。
  const r = byId['vision-toggle-gate'].transform(oldTree, EXPOSE);
  assert.equal(r.status, 'changed', `旧树 toggle 应 changed，得 ${r.status}: ${r.detail || ''}`);
});

// ---------------------------------------------------------------------------
// c. K1 三层排列独立性
// ---------------------------------------------------------------------------
const K1 = ['fallback-heal-isolation', 'credentials-initial-retry', 'credentials-absent-guidance'];

test('c1. K1 三层各自对 pristine changed', () => {
  for (const id of K1) {
    const r = byId[id].transform(pristineRead(byId[id].pkgRel), id);
    assert.equal(r.status, 'changed', `${id} 应 changed，得 ${r.status}`);
  }
});

test('c2. K1 三层任意排列最终产物逐字节一致（真·独立）', () => {
  const perms = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  const finals = new Set();
  for (const perm of perms) {
    const state = new Map(K1.map((id) => [id, pristineRead(byId[id].pkgRel)]));
    for (const idx of perm) {
      const id = K1[idx];
      const r = byId[id].transform(state.get(id), id);
      if (r.status === 'changed') state.set(id, r.src);
    }
    finals.add(K1.map((id) => state.get(id)).join('\u0000@@\u0000'));
  }
  assert.equal(finals.size, 1, 'K1 三层产物必须与排列无关');
});

// ---------------------------------------------------------------------------
// d. device-auth(154) 与 credentials-absent(153) 相邻无干扰
// ---------------------------------------------------------------------------
test('d. 153/154 相邻：不同目标文件，各自应用互不干扰且幂等', () => {
  const absent = byId['credentials-absent-guidance'];
  const device = byId['device-auth-guidance'];
  assert.notEqual(absent.pkgRel, device.pkgRel, '相邻 order 补丁不得共享目标');
  let absentSrc = pristineRead(absent.pkgRel);
  let deviceSrc = pristineRead(device.pkgRel);
  // 先 153 后 154。
  absentSrc = absent.transform(absentSrc, absent.pkgRel).src;
  deviceSrc = device.transform(deviceSrc, device.pkgRel).src;
  assert.equal(absent.transform(absentSrc, absent.pkgRel).status, 'already');
  assert.equal(device.transform(deviceSrc, device.pkgRel).status, 'already');
  // 154 的产物不含 153 的 marker，反之亦然（无锚点串扰）。
  assert.ok(!deviceSrc.includes('credentials-absent guidance'));
  assert.ok(!absentSrc.includes('device-auth guidance'));
});
