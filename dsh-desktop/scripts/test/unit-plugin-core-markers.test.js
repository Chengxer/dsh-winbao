'use strict';

// markers.js 单测：dsh web stderr 机器可读标记解析（parseMarkers）与跨 chunk
// 累积解析器（createMarkerAccumulator）。覆盖：loader/attribute 两类标记、
// 空/垃圾/CRLF 输入、name 去空格、count 解析、任意字节位置跨 chunk 断裂、
// KEEP=1024 边界、以及 accumulator 的 tail 有状态复用。

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseMarkers, createMarkerAccumulator } = require('../plugin-core/lib/markers');

// ── parseMarkers ────────────────────────────────────────────────────────────

test('markers: 单个 loader 标记', () => {
  const r = parseMarkers('[loader-isolation] entry balance (dsh-balance)');
  assert.deepEqual(r.isolations, [{ id: 'balance', name: 'dsh-balance' }]);
  assert.deepEqual(r.attributes, []);
});

test('markers: 同一文本多个 loader 标记', () => {
  const r = parseMarkers('[loader-isolation] entry a (one) [loader-isolation] entry b (two)');
  assert.deepEqual(r.isolations, [
    { id: 'a', name: 'one' },
    { id: 'b', name: 'two' },
  ]);
});

test('markers: 单个 attribute 标记', () => {
  const r = parseMarkers('[crash-shield] attribute: web.app count: 5');
  assert.deepEqual(r.attributes, [{ source: 'web.app', count: 5 }]);
  assert.deepEqual(r.isolations, []);
});

test('markers: loader 与 attribute 混合', () => {
  const r = parseMarkers('[loader-isolation] entry a (one)\n[crash-shield] attribute: x count: 3');
  assert.deepEqual(r.isolations, [{ id: 'a', name: 'one' }]);
  assert.deepEqual(r.attributes, [{ source: 'x', count: 3 }]);
});

test('markers: 垃圾文本 → 空结果', () => {
  assert.deepEqual(parseMarkers('hello world, nothing machine-readable here'), {
    isolations: [],
    attributes: [],
  });
});

test('markers: 无标记（空串/undefined）→ 空结果', () => {
  assert.deepEqual(parseMarkers(''), { isolations: [], attributes: [] });
  assert.deepEqual(parseMarkers(), { isolations: [], attributes: [] });
});

test('markers: CRLF 文本照常解析', () => {
  const r = parseMarkers('[loader-isolation] entry a (one)\r\n[loader-isolation] entry b (two)\r\n');
  assert.deepEqual(r.isolations, [
    { id: 'a', name: 'one' },
    { id: 'b', name: 'two' },
  ]);
});

test('markers: reason 含任意字符时正则停在 name 右括号', () => {
  // reason 可含任意字符（含额外的 ')'），正则 ([^)\n]*) 在 name 的 ')' 处截止。
  const r = parseMarkers('[loader-isolation] entry a.b-c_1 (some name) failed: boom (again)');
  assert.deepEqual(r.isolations, [{ id: 'a.b-c_1', name: 'some name' }]);
});

test('markers: name 首尾空格被 trim', () => {
  const r = parseMarkers('[loader-isolation] entry a (  padded name  )');
  assert.deepEqual(r.isolations, [{ id: 'a', name: 'padded name' }]);
});

test('markers: count 解析（0 / 前导零 / 多位数）', () => {
  assert.deepEqual(parseMarkers('[crash-shield] attribute: x count: 0').attributes, [{ source: 'x', count: 0 }]);
  assert.deepEqual(parseMarkers('[crash-shield] attribute: x count: 007').attributes, [{ source: 'x', count: 7 }]);
  assert.deepEqual(parseMarkers('[crash-shield] attribute: x count: 123').attributes, [{ source: 'x', count: 123 }]);
});

// ── createMarkerAccumulator ─────────────────────────────────────────────────

test('markers: 完整标记在每个字节位置断裂均恰好解析一次', () => {
  // 无 reason 的完整标记：其结尾 ')' 是最后一个字符，任意 1..len-1 处切分时
  // 前片必缺 ')'（不构成完整标记），后片与 tail 拼接恢复完整标记，故总计恰好一次。
  const marker = '[loader-isolation] entry abc (name)';
  for (let i = 1; i < marker.length; i += 1) {
    const acc = createMarkerAccumulator();
    const r1 = acc(marker.slice(0, i));
    const r2 = acc(marker.slice(i));
    const total = [...r1.isolations, ...r2.isolations];
    assert.equal(total.length, 1, `切分点 ${i} 应恰好解析一次`);
    assert.deepEqual(total[0], { id: 'abc', name: 'name' });
  }
});

test('markers: 多个不同标记跨 chunk 断裂均被解析', () => {
  const acc = createMarkerAccumulator();
  const text = '[loader-isolation] entry a (one)[loader-isolation] entry b (two)';
  const cut = text.indexOf('one'); // 在第一个标记内部断裂
  const r1 = acc(text.slice(0, cut));
  const r2 = acc(text.slice(cut));
  assert.deepEqual(r1.isolations, [], '前片为残缺前缀，不产出标记');
  assert.deepEqual(r2.isolations, [
    { id: 'a', name: 'one' },
    { id: 'b', name: 'two' },
  ]);
});

test('markers: 残缺前缀 + 垃圾 → 不解析', () => {
  const acc = createMarkerAccumulator();
  const r1 = acc('[loader-isolation] entry abc');
  const r2 = acc(' this is junk without a closing paren');
  assert.equal(r1.isolations.length, 0);
  assert.equal(r2.isolations.length, 0);
});

test('markers: 垃圾前缀 + 合法标记 → 解析', () => {
  const acc = createMarkerAccumulator();
  const r1 = acc('garbage noise ');
  const r2 = acc('[loader-isolation] entry a (b)');
  assert.equal(r1.isolations.length, 0);
  assert.deepEqual(r2.isolations, [{ id: 'a', name: 'b' }]);
});

test('markers: KEEP 边界——长 id(200) + 长 name(200) 在 ~300 处断裂仍解析', () => {
  const id = 'x'.repeat(200);
  const name = 'n'.repeat(200);
  const marker = `[loader-isolation] entry ${id} (${name})`;
  const cut = 300; // 标记起点距 chunk 边界约 300 字符
  const acc = createMarkerAccumulator();
  const r1 = acc(marker.slice(0, cut));
  const r2 = acc(marker.slice(cut));
  const total = [...r1.isolations, ...r2.isolations];
  assert.equal(total.length, 1, '长标记跨 chunk 仍应恰好解析一次');
  assert.equal(total[0].id, id);
  assert.equal(total[0].name, name);
});

test('markers: 第二个 chunk 长于 KEEP（2048 个 x + 末尾标记）仍解析', () => {
  const acc = createMarkerAccumulator();
  acc('seed '); // 建立 tail
  const marker = '[loader-isolation] entry e (n)';
  const r = acc('x'.repeat(2048) + marker);
  assert.deepEqual(r.isolations, [{ id: 'e', name: 'n' }]);
});

test('markers: accumulator 有状态（tail），同一实例复用可跨 chunk 补全', () => {
  const acc = createMarkerAccumulator();
  const r1 = acc('[loader-isolation] entry first (one');
  const r2 = acc(') [loader-isolation] entry second (two)');
  assert.deepEqual(r1.isolations, [], '前片残缺不产出');
  assert.deepEqual(r2.isolations, [
    { id: 'first', name: 'one' },
    { id: 'second', name: 'two' },
  ]);

  // 对照：全新 accumulator 只见后片，无法恢复被切掉的 'first'（证明 tail 在起作用）。
  const fresh = createMarkerAccumulator();
  const rf = fresh(') [loader-isolation] entry second (two)');
  assert.deepEqual(rf.isolations, [{ id: 'second', name: 'two' }]);
});
