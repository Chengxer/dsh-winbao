'use strict';

// TA3 链路集成测试：文件拖放全链（Rust 载荷形态 → 垫片 onEvent 解包语义 →
// dsh-file-drop normalizeDropPayload → dedupeEntries → planPickedFiles）。
//
// 手法：
// - Rust 形态 drop 载荷按 lib.rs 契约构造（{type:'drop', files:[{path,name,
//   ext,size,kind}], skipped:[{path,name,reason}]}；ext/kind 多余键被插件
//   sanitizer 忽略——正是 Rust→JS 的宽容契约）；
// - 垫片（bridge-shim.js）的 onEvent 解包语义用「envelope{event,payload}
//   包装 → 事件名匹配 → payload 透传为 window CustomEvent detail」模拟
//   （垫片真源以 include 文本锚点对照，防漂移）；
// - 插件核心组件全真：vm 装载 assets/plugins/dsh-file-drop/lib/client.js，
//   纯逻辑面 window.__dshFileDropCore（生产暴露面，非复制实现）；
// - 双报去重窗口竞态：同载荷间隔 100ms（<1500ms 窗）→ 去重；间隔 2s → 放行。
//
// 运行：node --test scripts/test/ta3-file-drop-chain.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PLUGIN = path.join(__dirname, '..', '..', 'assets', 'plugins', 'dsh-file-drop', 'lib', 'client.js');
const SHIM = path.join(__dirname, '..', '..', '..', 'dsh-tauri', 'src-tauri', 'crates', 'bridge', 'dist', 'bridge-shim.js');

/** vm 装载 client.js，捕获 __dshFileDropCore（纯逻辑面）。 */
function loadCore() {
  const sandbox = { console, Date, Promise };
  sandbox.window = { __ModuleLoader__: { load() {} } }; // 注册面兜底（core 挂 window）
  vm.runInNewContext(fs.readFileSync(PLUGIN, 'utf8'), sandbox, { filename: PLUGIN });
  const core = sandbox.window.__dshFileDropCore;
  assert.ok(core && typeof core.normalizeDropPayload === 'function', '纯逻辑面应挂 window.__dshFileDropCore');
  return core;
}

/** 垫片 onEvent 解包语义模拟（bridge-shim.js:920 一带的行为形状）。 */
function makeShimSim() {
  const delivered = [];
  const windowListeners = {};
  const window = {
    addEventListener(type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn); },
    dispatchEvent(ev) {
      for (const fn of windowListeners[ev.type] || []) fn({ detail: ev.detail });
      return true;
    },
  };
  // 垫片真形态：onEvent('client-file-drop', listeners.fileDrop, p => p || {})
  // —— Tauri 事件载荷即第二个参数解包结果；这里以 envelope 显式表达
  // 「壳层事件名匹配 + payload 透传」两步解包语义。
  const unwrap = (envelope) => {
    if (!envelope || envelope.event !== 'client-file-drop') return null;
    return envelope.payload || {};
  };
  return {
    window,
    delivered,
    forward(envelope) {
      const payload = unwrap(envelope);
      if (payload == null) return false;
      delivered.push(payload);
      window.dispatchEvent({ type: 'client-file-drop', detail: payload });
      return true;
    },
  };
}

/** Rust 形态 drop 载荷（lib.rs precheck_drop_paths 的 emit 形态）。 */
function rustDropPayload() {
  return {
    type: 'drop',
    files: [
      { path: 'C:\\work\\shots\\登录页.png', name: '登录页.png', ext: '.png', size: 512 * 1024, kind: 'image' },
      { path: 'C:\\work\\notes\\todo.md', name: 'todo.md', ext: '.md', size: 2048, kind: 'text' },
      { path: 'C:\\work\\bin\\dump.bin', name: 'dump.bin', ext: '.bin', size: 4096, kind: 'binary' },
    ],
    skipped: [
      { path: 'C:\\work\\assets', name: 'assets', reason: 'directory' },
      { path: 'C:\\work\\gone.txt', name: 'gone.txt', reason: 'missing' },
      { path: 'C:\\work\\huge.iso', name: 'huge.iso', reason: 'too-large' },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1) Rust 载荷 → 垫片解包 → normalizeDropPayload
// ---------------------------------------------------------------------------

test('全链：Rust 载荷（含 skipped/多余键）→ 垫片解包 → 归一（skipped 不进附件链）', () => {
  const core = loadCore();
  const shim = makeShimSim();
  let seenDetail = null;
  shim.window.addEventListener('client-file-drop', (ev) => { seenDetail = ev.detail; });

  const ok = shim.forward({ event: 'client-file-drop', payload: rustDropPayload() });
  assert.equal(ok, true, '事件名匹配应送达');
  assert.deepEqual(seenDetail, rustDropPayload(), '垫片解包后 detail 即 payload 原文');

  const entries = core.normalizeDropPayload(seenDetail);
  assert.equal(entries.length, 3, 'files 全部归一');
  // 多余键（ext/kind）被 sanitizer 忽略；path/name/size 归一。
  const png = entries.find((e) => e.name === '登录页.png');
  assert.equal(png.path, 'C:\\work\\shots\\登录页.png');
  assert.equal(png.size, 512 * 1024);
  assert.ok(!('kind' in png) && !('ext' in png), 'Rust 侧 ext/kind 不进入插件条目');
  // skipped 三项绝不进入附件链。
  for (const name of ['assets', 'gone.txt', 'huge.iso']) {
    assert.ok(!entries.some((e) => e.name === name), `skipped 项 ${name} 不得进入附件链`);
  }
  // 路径提示块（handleBridgeDrop 的 path-only 分流产物）。
  const hint = core.buildDropHint(entries);
  assert.match(hint, /\[拖入 3 个文件\]/);
  assert.ok(hint.includes('完整路径：C:\\work\\shots\\登录页.png'));
  assert.ok(!hint.includes('huge.iso'), 'skipped 不得出现在提示块');
});

test('垫片解包：事件名不匹配不送达（其它壳层事件不得误入拖放链）', () => {
  const shim = makeShimSim();
  assert.equal(shim.forward({ event: 'client-update-available', payload: { next: '0.5.3' } }), false);
  assert.equal(shim.forward({ event: 'notification-jump', payload: { sessionId: 's' } }), false);
  assert.equal(shim.forward(null), false);
  assert.equal(shim.delivered.length, 0);
});

test('垫片真源锚点：bridge-shim.js 必须监听 client-file-drop 并转发 window CustomEvent', () => {
  const src = fs.readFileSync(SHIM, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(src.includes("onEvent('client-file-drop', listeners.fileDrop"), '垫片监听 client-file-drop');
  assert.ok(src.includes("new CustomEvent('client-file-drop', { detail: payload })"), '垫片转发为页面 CustomEvent（detail=payload 解包语义）');
});

// ---------------------------------------------------------------------------
// 2) planPickedFiles 附件清单 oracle
// ---------------------------------------------------------------------------

test('planPickedFiles：混合清单裁决（rail/text/errors 三分流 + 限额整批前置）', () => {
  const core = loadCore();
  const MB = 1024 * 1024;
  const png = (name, size, type = 'image/png') => ({ name, size, type });
  const plan = core.planPickedFiles([
    png('a.png', 100 * 1024),                       // → rail
    { name: 'b.md', size: 100, type: 'text/markdown' }, // → text
    png('big.png', 4 * MB),                          // > 3.5MB 单图 → error
    { name: 'doc.pdf', size: 10, type: 'application/pdf' }, // binary → error
    png('bad-mime.bmp', 100, 'image/bmp'),           // 图片扩展但 MIME 不在内核白名单 → error
  ], 0);
  assert.equal(Array.from(plan.rail, (f) => f.name).join(), 'a.png', '唯一合法 png 进 rail');
  assert.equal(Array.from(plan.text, (f) => f.name).join(), 'b.md', '文本进 text');
  assert.equal(plan.errors.length, 3, '三种拒绝各一条');
  assert.ok(plan.errors.some((e) => e.name === 'big.png' && e.message.includes('单图')));
  assert.ok(plan.errors.some((e) => e.name === 'doc.pdf' && e.message.includes('不支持')));
  assert.ok(plan.errors.some((e) => e.name === 'bad-mime.bmp' && e.message.includes('PNG/JPEG/WebP/GIF')));

  // 张数上限：rail 已有 19 张，再选 2 张 → 第 2 张超 20 张上限。
  const plan2 = core.planPickedFiles([png('x1.png', 1024), png('x2.png', 1024)], 19);
  assert.equal(Array.from(plan2.rail, (f) => f.name).join(), 'x1.png');
  assert.ok(plan2.errors.some((e) => e.name === 'x2.png' && e.message.includes('20 张')));

  // 合计上限注入：单图 60MB×2，限额注入为 100MB → 第二张合计超限。
  const plan3 = core.planPickedFiles([png('h1.png', 60 * MB), png('h2.png', 60 * MB)], 0,
    { maxImageBytes: 100 * MB, maxImagesPerMessage: 20, maxMessageImageBytes: 100 * MB, maxImageDimension: 2000 });
  assert.equal(Array.from(plan3.rail, (f) => f.name).join(), 'h1.png');
  assert.ok(plan3.errors.some((e) => e.name === 'h2.png' && e.message.includes('合计')));

  // 空输入零副作用。
  assert.equal(JSON.stringify(core.planPickedFiles([], 5)), '{"rail":[],"text":[],"errors":[]}');
});

// ---------------------------------------------------------------------------
// 3) 双报去重窗口竞态（HTML5 drop × 壳层 client-file-drop）
// ---------------------------------------------------------------------------

test('双报去重：同载荷间隔 100ms 去重 / 2s 后放行（1500ms 窗）', () => {
  const core = loadCore();
  const payload = rustDropPayload();
  const t0 = 1_000_000;
  // 壳层报（带路径）。
  const shellEntries = core.normalizeDropPayload(payload);
  // HTML5 报（无路径，仅名+大小）——同一次物理拖放的另一形态。
  const htmlEntries = core.normalizeDropPayload({ files: payload.files.map((f) => ({ name: f.name, size: f.size })) });

  // 竞态 1：壳层先到，HTML5 100ms 后到 → 双报去重（path 键 + 名/大小 键互锁）。
  let seen = Object.create(null);
  let kept = core.dedupeEntries(shellEntries, seen, t0, 1500);
  assert.equal(kept.length, 3, '首报全保留');
  kept = core.dedupeEntries(htmlEntries, seen, t0 + 100, 1500);
  assert.equal(kept.length, 0, '100ms 内的双报（无路径键命中 名+大小 键）必须去重');

  // 竞态 2：2s 后同载荷再来（用户真的又拖了一次）→ 放行。
  kept = core.dedupeEntries(shellEntries, seen, t0 + 2_000, 1500);
  assert.equal(kept.length, 3, '1500ms 窗外的重复载荷视为新的物理拖放');

  // 反向序：HTML5 先到、壳层 100ms 后到 → 同样去重（键对称）。
  seen = Object.create(null);
  core.dedupeEntries(htmlEntries, seen, t0, 1500);
  kept = core.dedupeEntries(shellEntries, seen, t0 + 100, 1500);
  assert.equal(kept.length, 0, '反向双报同样去重');

  // 窗内不同文件不去重（只对同键去重）。
  seen = Object.create(null);
  core.dedupeEntries(core.normalizeDropPayload({ files: [{ path: 'C:\\a.png', name: 'a.png', size: 1 }] }), seen, t0, 1500);
  kept = core.dedupeEntries(core.normalizeDropPayload({ files: [{ path: 'C:\\b.png', name: 'b.png', size: 1 }] }), seen, t0 + 100, 1500);
  assert.equal(kept.length, 1, '不同文件在同一窗口内各自保留');
});

// ---------------------------------------------------------------------------
// 4) 归一化边界（不可信载荷）
// ---------------------------------------------------------------------------

test('normalizeDropPayload：宽容形态与洪水防护', () => {
  const core = loadCore();
  // detail 本身是数组（宽容形态）。
  assert.equal(core.normalizeDropPayload([{ name: 'a.png', size: 1 }]).length, 1);
  // 无效项剔除：非对象 / 无名无路径 / size 非数归 null。
  const out = core.normalizeDropPayload({ files: [null, 5, { size: 3 }, { name: 'ok.md', size: 'x' }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'ok.md');
  assert.equal(out[0].size, null, 'size 非有限数归 null（未知）');
  // 路径净化：控制字符与引号剥离。
  const clean = core.normalizeDropPayload({ files: [{ path: 'C:\\x\\"y\\\'.png', name: 'y.png', size: 1 }] });
  assert.equal(clean[0].path, 'C:\\x\\y\\.png', '控制字符与引号剥离（引号前的分隔符保留）');
  // 载荷洪水：>100 条截断。
  const flood = core.normalizeDropPayload({ files: Array.from({ length: 300 }, (_, i) => ({ name: `f${i}.md`, size: 1 })) });
  assert.equal(flood.length, 100, '一次最多收 100 条');
  // 其它形态 → []（不炸）。
  assert.equal(core.normalizeDropPayload({ type: 'enter', count: 3 }).length, 0);
  assert.equal(core.normalizeDropPayload(null).length, 0);
  assert.equal(core.normalizeDropPayload('nope').length, 0);
});
