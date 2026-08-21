'use strict';
// dsh-hub 下载链加固单测（安全审计 2026-08）：
//   archiveRootMatchesRepo —— GitHub archive 顶层目录锚点（<repo>-<ref>）。
// 背景：插件源码包此前「镜像优先」下载且无任何结构校验，第三方镜像
// （ghfast.top / gh-proxy.com 等）串包或被替换的 zip 会直接进入 pnpm
// install/build 执行链。加固后：官方 codeload 优先（短 connect-timeout 探测，
// 镜像仍兜底）+ 顶层目录锚点拒绝串包。本文件只测纯函数面；网络顺序由
// downloadGithubZip 内联实现，人工/集成验证覆盖。
// 插件 lib 为 ESM（type:module），测试文件用 CJS 外壳动态 import。
const { test, before } = require('node:test');
const assert = require('node:assert');

const LIB = '../../assets/plugins/dsh-hub/lib/index.js';
let hub = null;

before(async () => {
  hub = await import(LIB);
});

test('archiveRootMatchesRepo：接受 codeload 形态的顶层目录', () => {
  assert.strictEqual(hub.archiveRootMatchesRepo('dsh-mini', 'dsh-mini-1.4.2'), true);
  assert.strictEqual(hub.archiveRootMatchesRepo('dsh-mini', 'dsh-mini-v1.4.2'), true);
  assert.strictEqual(hub.archiveRootMatchesRepo('dsh-mini', 'dsh-mini-main'), true);
  assert.strictEqual(hub.archiveRootMatchesRepo('my-plugin', 'my-plugin-2.0.0-beta.1'), true);
  // 仓库名含点/横线等合法字符
  assert.strictEqual(hub.archiveRootMatchesRepo('foo.bar-plugin', 'foo.bar-plugin-0.0.1'), true);
});

test('archiveRootMatchesRepo：拒绝串包/替换形态', () => {
  assert.strictEqual(hub.archiveRootMatchesRepo('dsh-mini', 'evil-pkg-9.9.9'), false, '不同仓库的包拒绝');
  assert.strictEqual(hub.archiveRootMatchesRepo('dsh-mini', 'dsh-mini'), false, '无 -<ref> 后缀拒绝');
  assert.strictEqual(hub.archiveRootMatchesRepo('dsh-mini', 'dsh-min-1.4.2'), false, '前缀相似但非同仓库名拒绝');
  assert.strictEqual(hub.archiveRootMatchesRepo('dsh-mini', ''), false, '空目录名拒绝');
  assert.strictEqual(hub.archiveRootMatchesRepo('dsh-mini', 'package'), false, 'npm 形态 package/ 拒绝（源码包必须是 repo-ref）');
  assert.strictEqual(hub.archiveRootMatchesRepo('', 'x-1'), false, '空 repo 拒绝');
  assert.strictEqual(hub.archiveRootMatchesRepo(undefined, 'x-1'), false, 'undefined repo 不抛错');
  assert.strictEqual(hub.archiveRootMatchesRepo('x', undefined), false, 'undefined rootBase 不抛错');
  assert.strictEqual(hub.archiveRootMatchesRepo('x', null), false, 'null rootBase 不抛错');
  assert.strictEqual(hub.archiveRootMatchesRepo(123, 'x-1'), false, '非字符串 repo 不抛错');
});
