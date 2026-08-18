'use strict';
// 单元测试：scripts/plugin-manager-update.js（插件更新：版本比较/双源 URL/校验/解压定位）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  compareVersions,
  npmLatestUrl,
  githubReleaseApiUrl,
  githubAssetDownloadUrl,
  ghProxyUrl,
  verifyIntegrity,
  findPackageRoot,
  selectGithubAsset,
} = require('../plugin-manager-update');

const asset = (name) => ({ name });

test('版本比较：数值分段（0.12.2 > 0.2.1）', () => {
  assert.ok(compareVersions('0.12.2', '0.2.1') > 0);
  assert.ok(compareVersions('0.2.1', '0.12.2') < 0);
  assert.equal(compareVersions('0.2.1', '0.2.1'), 0);
  assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
  assert.equal(compareVersions('v0.2.3', '0.2.3'), 0, '前导 v 忽略');
});

test('版本比较：预发布与缺失段（semver 边界）', () => {
  assert.ok(compareVersions('0.2.3-beta', '0.2.3') < 0, '预发布 < 正式');
  assert.ok(compareVersions('0.2.3', '0.2.3-beta') > 0);
  assert.ok(compareVersions('0.2.4-beta', '0.2.3') > 0, '更新版预发布 > 旧版正式');
  assert.ok(compareVersions('0.2.3-alpha', '0.2.3-beta') < 0, '预发布之间按字符串');
  assert.equal(compareVersions('1.0', '1.0.0'), 0, '缺失段按 0');
  assert.equal(compareVersions('1.0.0', '1.0'), 0);
  assert.ok(compareVersions('1.0-beta', '1.0') < 0, '预发布 < 同号正式（缺失段场景）');
  assert.ok(compareVersions('1.0', '1.0-beta') > 0);
});

test('npm 双源 URL：官方与镜像同构', () => {
  assert.equal(npmLatestUrl('billion-context-dsh', false), 'https://registry.npmjs.org/billion-context-dsh/latest');
  assert.equal(npmLatestUrl('billion-context-dsh', true), 'https://registry.npmmirror.com/billion-context-dsh/latest');
  assert.equal(npmLatestUrl('@scope/pkg', false), 'https://registry.npmjs.org/%40scope%2Fpkg/latest', 'scoped 包名编码');});

test('GitHub URL：API / 资产直链 / 镜像前缀', () => {
  assert.equal(githubReleaseApiUrl('hzhz314159/dsh-side-session'), 'https://api.github.com/repos/hzhz314159/dsh-side-session/releases/latest');
  assert.equal(
    githubAssetDownloadUrl('hzhz314159/dsh-side-session', 'v0.2.3', 'dsh-side-session-0.2.3.zip'),
    'https://github.com/hzhz314159/dsh-side-session/releases/download/v0.2.3/dsh-side-session-0.2.3.zip'
  );
  const dl = 'https://github.com/a/b/releases/download/v1/x.zip';
  assert.equal(ghProxyUrl(dl), 'https://gh-proxy.com/' + dl);
  assert.equal(ghProxyUrl('https://gh-proxy.com/' + dl), 'https://gh-proxy.com/' + dl, '已带前缀不重复套');
});

test('integrity 校验：sha512 匹配/不匹配', () => {
  const buf = Buffer.from('hello plugin tarball');
  const crypto = require('node:crypto');
  const good = 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');
  assert.ok(verifyIntegrity(buf, good));
  assert.ok(!verifyIntegrity(buf, 'sha512-' + crypto.createHash('sha512').update(Buffer.from('other')).digest('base64')));
  assert.ok(!verifyIntegrity(buf, 'sha1-aaaa'));
  assert.ok(!verifyIntegrity(buf, ''));
});

test('解压定位：npm tarball 的 package/ 顶层目录', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-root-'));
  try {
    fs.mkdirSync(path.join(tmp, 'package', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package', 'package.json'), '{"name":"x","version":"1.0.0"}');
    assert.equal(findPackageRoot(tmp), path.join(tmp, 'package'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('解压定位：GitHub zip 的 <repo>-<ref>/ 顶层目录', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-root-'));
  try {
    fs.mkdirSync(path.join(tmp, 'dsh-side-session-0.2.3', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'dsh-side-session-0.2.3', 'package.json'), '{"name":"x","version":"1.0.0"}');
    assert.equal(findPackageRoot(tmp), path.join(tmp, 'dsh-side-session-0.2.3'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('解压定位：直接就是包根 / 找不到返回 null', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-root-'));
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
    assert.equal(findPackageRoot(tmp), tmp);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-empty-'));
    assert.equal(findPackageRoot(empty), null);
    fs.rmSync(empty, { recursive: true, force: true });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('解压定位：唯一子目录递归深入 / 多层嵌套', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-root-'));
  try {
    fs.mkdirSync(path.join(tmp, 'repo-1.0.0', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'repo-1.0.0', 'package.json'), '{"name":"x","version":"1.0.0"}');
    assert.equal(findPackageRoot(tmp), path.join(tmp, 'repo-1.0.0'));
    // 多套一层（GitHub zip 内含子目录）
    const nested = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-root-'));
    fs.mkdirSync(path.join(nested, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(nested, 'a', 'b', 'package.json'), '{"name":"y","version":"2.0.0"}');
    assert.equal(findPackageRoot(nested), path.join(nested, 'a', 'b'));
    fs.rmSync(nested, { recursive: true, force: true });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ============ issue #97：GitHub Release 多资产选择 ============

test('资产选择：#97 多资产 darwin 在前时选 win32-x64（darwin 不再误判 win）', () => {
  const r = selectGithubAsset([asset('dsh-darwin-arm64.tgz'), asset('dsh-win32-x64.tgz')], 'win32');
  assert.equal(r.name, 'dsh-win32-x64.tgz');
});

test('资产选择：#97 乱序 win-ia32/win-x64 时选 x64（架构优先级）', () => {
  const r = selectGithubAsset([asset('dsh-win-ia32.tgz'), asset('dsh-win-x64.tgz')], 'win32');
  assert.equal(r.name, 'dsh-win-x64.tgz');
});

test('资产选择：#97 仅 .sha256 校验和时返回 null（任何阶段不选非二进制）', () => {
  const r = selectGithubAsset([asset('dsh-darwin-arm64.tgz.sha256'), asset('dsh-win32-x64.tgz.sha256')], 'win32');
  assert.equal(r, null);
});

test('资产选择：B2 无扩展名 SHA256SUMS/SHA512SUMS 与 .sha1 校验和不选', () => {
  assert.equal(selectGithubAsset([asset('SHA256SUMS')], 'win32'), null, '无点号校验和文件（真实发行常见命名）不得被选中');
  assert.equal(selectGithubAsset([asset('dsh-SHA512SUMS')], 'win32'), null, 'SHA512SUMS 同样剔除');
  assert.equal(selectGithubAsset([asset('dsh-win32-x64.tgz'), asset('SHA256SUMS')], 'win32').name, 'dsh-win32-x64.tgz', '校验和文件混入时被剔除、正常资产仍可选');
  assert.equal(selectGithubAsset([asset('dsh-SHA256SUMS.txt')], 'win32'), null, '.txt 后缀校验和仍被剔除');
  assert.equal(selectGithubAsset([asset('dsh-win32-x64.exe.sha1')], 'win32'), null, '.sha1 扩展名被剔除');
});

test('资产选择：#97 控制组 win32-x64 + linux-x64 选 win32-x64', () => {
  const r = selectGithubAsset([asset('dsh-win32-x64.tgz'), asset('dsh-linux-x64.tgz')], 'win32');
  assert.equal(r.name, 'dsh-win32-x64.tgz');
});

test('资产选择：词边界——darwin 不匹配 win，win32/windows 匹配', () => {
  const mixed = selectGithubAsset([asset('dsh-darwin-x64.tgz'), asset('dsh-win32-x64.tgz')], 'win32');
  assert.equal(mixed.name, 'dsh-win32-x64.tgz', '混合资产时 darwin 不误配 win，仍选 win32');
  assert.equal(selectGithubAsset([asset('dsh-win32-x64.tgz')], 'win32').name, 'dsh-win32-x64.tgz');
  assert.equal(selectGithubAsset([asset('dsh-windows-arm64.zip')], 'win32').name, 'dsh-windows-arm64.zip', 'windows 全称匹配');
  // 仅 darwin 资产（无本平台包）：回退选中（保持旧行为，digest 校验兜底）
  assert.equal(selectGithubAsset([asset('dsh-darwin-x64.tgz')], 'win32').name, 'dsh-darwin-x64.tgz');
});

test('资产选择：平台池为空时回退任意归档；无归档时回退平台文件', () => {
  const r1 = selectGithubAsset([asset('dsh-linux-x64.tgz')], 'win32');
  assert.equal(r1.name, 'dsh-linux-x64.tgz', '仅 linux 资产时回退（保持旧行为）');
  const r2 = selectGithubAsset([asset('dsh-win32-x64.exe'), asset('dsh-win32-x64.exe.sha256')], 'win32');
  assert.equal(r2.name, 'dsh-win32-x64.exe', '无归档时选平台文件而非校验和');
});

test('资产选择：架构优先级 arm64 优于无架构；amd64 等价 x64；大小写不敏感', () => {
  assert.equal(selectGithubAsset([asset('dsh-win.zip'), asset('dsh-win-arm64.zip')], 'win32').name, 'dsh-win-arm64.zip');
  assert.equal(selectGithubAsset([asset('dsh-WIN32-X64.TGZ')], 'win32').name, 'dsh-WIN32-X64.TGZ');
  const r = selectGithubAsset([asset('x.zip'), asset('x-amd64.zip')], 'win32');
  assert.equal(r.name, 'x-amd64.zip', 'amd64 与 x64 同级优先于无架构');
});

test('资产选择：非法输入不抛错', () => {
  assert.equal(selectGithubAsset(null, 'win32'), null);
  assert.equal(selectGithubAsset([], 'win32'), null);
  assert.equal(selectGithubAsset([null, { name: 'dsh-win32-x64.tgz' }], 'win32').name, 'dsh-win32-x64.tgz');
  assert.equal(selectGithubAsset([{ name: 'dsh-win32-x64.tgz' }], undefined).name, 'dsh-win32-x64.tgz', '未知平台回退全部候选');
});
