'use strict';
// 单元测试：scripts/lib/github-release-assets.js（GitHub Release 多资产选择）
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectReleaseAsset, isBinaryAsset, isArchive, isWinAsset, archRank } = require('../lib/github-release-assets');

const asset = (name) => ({ name });

test('isWinAsset: 词边界判定，不误判 darwin / winrar / window', () => {
  assert.equal(isWinAsset('DSH-Desktop-v0.3.9-win-x64.zip'), true);
  assert.equal(isWinAsset('DSH-Desktop-v0.3.9-windows-x64-portable.exe'), true);
  assert.equal(isWinAsset('DSH-Desktop-v0.3.9-darwin-arm64.zip'), false, 'darwin 含子串 win 不得误判');
  assert.equal(isWinAsset('DSH-Desktop-v0.3.9-macos-x64.dmg'), false);
  assert.equal(isWinAsset('DSH-Desktop-v0.3.9-linux-x64.tar.gz'), false);
  assert.equal(isWinAsset('winrar-x64.zip'), false, 'winrar 不是 win 资产');
  assert.equal(isWinAsset('window-manager.zip'), false);
  assert.equal(isWinAsset('setup-win.exe'), true);
});

test('isArchive: 识别 .tgz/.tar.gz/.zip，忽略大小写', () => {
  assert.equal(isArchive('a.tgz'), true);
  assert.equal(isArchive('a.tar.gz'), true);
  assert.equal(isArchive('a.ZIP'), true);
  assert.equal(isArchive('a.tar.xz'), false);
  assert.equal(isArchive('a.sha256'), false);
  assert.equal(isArchive('a.exe'), false);
});

test('isBinaryAsset: 排除校验和/签名/元数据文本文件', () => {
  assert.equal(isBinaryAsset(asset('pkg.zip')), true);
  assert.equal(isBinaryAsset(asset('pkg.zip.sha256')), false);
  assert.equal(isBinaryAsset(asset('SHA256SUMS')), false);
  assert.equal(isBinaryAsset(asset('SHA256SUMS.txt')), false);
  assert.equal(isBinaryAsset(asset('pkg.exe.asc')), false);
  assert.equal(isBinaryAsset(asset('latest.json')), false);
  assert.equal(isBinaryAsset(asset('')), false);
  assert.equal(isBinaryAsset(null), false);
});

test('archRank: 偏好 x64 > arm64 > ia32/x86 > 未知', () => {
  assert.ok(archRank('a-x64.zip') < archRank('a-arm64.zip'));
  assert.ok(archRank('a-arm64.zip') < archRank('a-ia32.zip'));
  assert.ok(archRank('a-x86.zip') < archRank('a-generic.zip'));
  assert.equal(archRank('a-x86_64.zip'), 0, 'x86_64 视为 x64');
  assert.equal(archRank('a-amd64.zip'), 0);
  assert.equal(archRank('a-aarch64.zip'), 1);
});

test('issue #97: 平台匹配的归档优先，且同平台内 x64 先于 arm64', () => {
  const assets = [
    asset('pkg-darwin-arm64.zip'),
    asset('pkg-win-arm64.zip'),
    asset('pkg-win-x64.zip'),
    asset('pkg-linux-x64.zip'),
    asset('pkg.zip.sha256'),
  ];
  const a = selectReleaseAsset(assets);
  assert.equal(a.name, 'pkg-win-x64.zip', 'darwin 不得被当作 win；同平台优选 x64');
});

test('issue #97: 无 win 归档时退回任意归档（优先 x64）', () => {
  const assets = [
    asset('pkg-linux-x64.zip'),
    asset('pkg-linux-arm64.zip'),
    asset('pkg.sha256'),
  ];
  const a = selectReleaseAsset(assets);
  assert.equal(a.name, 'pkg-linux-x64.zip');
});

test('issue #97: 无归档时退回平台匹配任意二进制，不再选 .sha256', () => {
  const assets = [
    asset('pkg-win-x64.exe'),
    asset('pkg-win-arm64.exe'),
    asset('pkg.sha256'),
    asset('SHA256SUMS'),
  ];
  const a = selectReleaseAsset(assets);
  assert.equal(a.name, 'pkg-win-x64.exe', 'x64 优先，且跳过校验和文件');
});

test('issue #97: 仅校验和文件时返回 null（不拿文本当安装包）', () => {
  assert.equal(selectReleaseAsset([asset('pkg.zip.sha256'), asset('SHA256SUMS')]), null);
  assert.equal(selectReleaseAsset([]), null);
  assert.equal(selectReleaseAsset(null), null);
  assert.equal(selectReleaseAsset(undefined), null);
});

test('selectReleaseAsset 保留资产对象原字段（name/digest 等），非归档 exe 兜底可选中', () => {
  const assets = [{ name: 'setup-win-x64.exe', digest: 'sha256:abc' }];
  const a = selectReleaseAsset(assets);
  assert.equal(a.name, 'setup-win-x64.exe');
  assert.equal(a.digest, 'sha256:abc');
});

test('第一项非二进制之后的资产也可被首位二进制兜底选中', () => {
  const assets = [
    asset('pkg.zip.sha256'),
    asset('pkg-linux-x64.AppImage'),
    asset('pkg-win-x64.7z'),
  ];
  const a = selectReleaseAsset(assets);
  assert.equal(a.name, 'pkg-win-x64.7z', '无归档时平台匹配任意文件优先');
});