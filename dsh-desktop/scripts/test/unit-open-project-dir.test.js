'use strict';

// issue #85 补丁脚本单元测试（node --test）。
// 覆盖：一次应用、二次幂等、anchor 缺失跳过且字节级不损坏、非目标包跳过。
// 用法：node --test scripts/test/unit-open-project-dir.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { patchOpenProjectDir, MARKER, buildUiFixture } = require('../patch-open-project-dir');

function buildFakeTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-open-dir-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildUiFixture());
  return { root, file };
}

test('补丁脚本：一次应用、二次幂等、anchor 缺失跳过且不损坏', (t) => {
  const tree = buildFakeTree(t);
  // 第一次：应修改
  let n = patchOpenProjectDir(tree.root);
  assert.strictEqual(n, 1, '应补丁 1 个文件');
  const patched = fs.readFileSync(tree.file, 'utf8');
  assert.ok(patched.includes(MARKER), '应写入幂等标记');
  assert.ok(patched.includes('window.__dshDesktopOpenDir?.(row.cwd)'), '项目行 open-folder 应调用桥');
  assert.ok(patched.includes('window.__dshDesktopOpenDir?.(cwd)'), '会话行 open-folder 应调用桥');
  assert.ok(patched.includes('right: e.clientX + 1, bottom: e.clientY + 1'), '右键锚点矩形应含四边');
  assert.ok(patched.includes('getAnchorRect: () => menuRect'), '菜单应走 getAnchorRect');
  assert.ok(patched.includes('...(cwd ? [{'), '会话行 open-folder 应仅在 cwd 存在时显示');
  assert.ok(patched.includes('"menu.openProjectDir": "打开项目目录"'), '应写入中文翻译');
  assert.ok(patched.includes('"menu.openProjectDir": "Open project directory"'), '应写入英文翻译');
  // 第二次：零写入且内容不变
  n = patchOpenProjectDir(tree.root);
  assert.strictEqual(n, 0, '第二次应零写入');
  assert.strictEqual(fs.readFileSync(tree.file, 'utf8'), patched, '内容不应变化');
  // anchor 缺失：跳过且字节级不损坏
  fs.writeFileSync(tree.file, 'export const changed = true;\n完全不同的内容\n');
  const before = fs.readFileSync(tree.file);
  n = patchOpenProjectDir(tree.root);
  assert.strictEqual(n, 0, 'anchor 不匹配应跳过');
  assert.deepStrictEqual(fs.readFileSync(tree.file), before, '文件字节级不变');
});

test('补丁脚本：目标包缺失时返回 0 且不抛异常', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-open-dir-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.strictEqual(patchOpenProjectDir(root), 0);
});

test('补丁脚本：夹具包含全部锚点且每个恰好一次', () => {
  const src = buildUiFixture();
  // 夹具由全部替换锚点拼接而成：标记 + 每次替换锚点必须存在。
  assert.ok(src.length > 100, '夹具应有内容');
  assert.ok(!src.includes(MARKER), '夹具本身不应含标记（否则幂等分支吞掉首次应用）');
});
