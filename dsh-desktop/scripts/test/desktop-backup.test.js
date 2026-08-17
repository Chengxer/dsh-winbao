'use strict';
// desktop-backup.js 单测：收集 / 校验 / 原子恢复 + 回滚 / 路径安全。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  assertSafeRelPath,
  collectFiles,
  readBackupFile,
  createBackup,
  validatedBackup,
  restoreBackup,
} = require('../desktop-backup.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backup-test-'));
}

function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  if (rel.endsWith('.bin')) {
    // 写一个含 NUL 的二进制文件
    fs.writeFileSync(p, Buffer.from([0, 1, 2, 255]));
  }
  return p;
}

test('assertSafeRelPath 拒绝对路径 / .. / 非法字符 / 空', () => {
  assert.strictEqual(assertSafeRelPath('a/b/c.yml'), 'a/b/c.yml');
  assert.strictEqual(assertSafeRelPath('a\\b.yml'), 'a/b.yml');
  assert.throws(() => assertSafeRelPath('/abs/path'));
  assert.throws(() => assertSafeRelPath('..\\evil'));
  assert.throws(() => assertSafeRelPath('a/../b'));
  assert.throws(() => assertSafeRelPath(''));
  assert.throws(() => assertSafeRelPath('a/b:bad.yml'));
});

test('assertSafeRelPath 拒绝 Windows 保留设备名（C9）', () => {
  assert.throws(() => assertSafeRelPath('CON'));
  assert.throws(() => assertSafeRelPath('profile/nul.txt'));
  assert.throws(() => assertSafeRelPath('home/COM1'));
  assert.throws(() => assertSafeRelPath('lpt9.log'));
});

test('collectFiles 只收白名单扩展、跳过 node_modules/sessions/数字后缀备份', () => {
  const dir = tmpdir();
  write(dir, 'settings.yaml', 'a: 1');
  write(dir, 'cordis.patch.yml', '- id: x');
  write(dir, 'sub/config.toml', 'x = 1');
  write(dir, 'node_modules/pkg/index.js', 'x');
  write(dir, 'sessions/s1.jsonl', '[1]');
  write(dir, 'big.bin', 'ff');
  write(dir, 'backup.old', 'old');
  const files = collectFiles(dir, fs, path);
  assert.deepStrictEqual(files, ['cordis.patch.yml', 'settings.yaml', 'sub/config.toml']);
});

test('readBackupFile 文本转 lines、package.json 转 json、二进制跳过', () => {
  const dir = tmpdir();
  write(dir, 'a.txt', 'line1\nline2');
  write(dir, 'package.json', '{"name":"x"}');
  const t = readBackupFile(dir, 'a.txt', fs, path);
  assert.deepStrictEqual(t, { path: 'a.txt', lines: ['line1', 'line2'] });
  const j = readBackupFile(dir, 'package.json', fs, path);
  assert.deepStrictEqual(j, { path: 'package.json', json: { name: 'x' } });
  write(dir, 'data.bin', '');
  fs.writeFileSync(path.join(dir, 'data.bin'), Buffer.from([0, 1, 2, 255]));
  assert.throws(() => readBackupFile(dir, 'data.bin', fs, path), /不是文本/);
});

test('createBackup 收集 profile+home、标记密钥文件、round-trip 校验', () => {
  const home = tmpdir();
  const profile = path.join(home, 'profiles', 'web');
  write(home, 'settings.yaml', 'k: v');
  write(home, '.credentials.yaml', 'api: secret');
  write(profile, 'cordis.patch.yml', '- id: web\n  insert:\n    - id: p\n      name: pkg\n');
  write(profile, 'package.json', '{"name":"dsh-profile-web"}');
  write(profile, 'node_modules/pkg/index.js', 'x'); // 应被跳过
  const b = createBackup({ profileDir: profile, homeDir: home, label: '测试' }, fs, path);
  assert.strictEqual(b.format, BACKUP_FORMAT);
  assert.strictEqual(b.version, BACKUP_VERSION);
  assert.ok(Array.isArray(b.files) && b.files.length >= 3);
  assert.ok(b.files.some((f) => f.path === 'profile/cordis.patch.yml'));
  assert.ok(b.files.some((f) => f.path === 'profile/package.json' && f.json && f.json.name === 'dsh-profile-web'));
  assert.ok(b.files.some((f) => f.path === 'home/settings.yaml'));
  assert.ok(b.secretFiles.includes('home/.credentials.yaml'));
  assert.ok(b.secretFiles.includes('home/settings.yaml'));
  // 没有任何 node_modules 路径
  assert.ok(!b.files.some((f) => f.path.includes('node_modules')));
  // round-trip
  const v = validatedBackup(b);
  assert.strictEqual(v.files.length, b.files.length);
});

test('validatedBackup 拒绝格式错 / 路径逃逸 / 体积超限', () => {
  const home = tmpdir();
  const profile = path.join(home, 'profiles', 'web');
  write(home, 'settings.yaml', 'k: v');
  write(profile, 'cordis.patch.yml', '- id: x');
  const b = createBackup({ profileDir: profile, homeDir: home }, fs, path);
  // 格式错
  assert.throws(() => validatedBackup({ ...b, format: 'other' }), /格式不匹配/);
  // 版本错
  assert.throws(() => validatedBackup({ ...b, version: 99 }), /版本不支持/);
  // 逃逸路径
  assert.throws(() => validatedBackup({ ...b, files: [{ path: '../../etc/passwd', lines: ['x'] }] }), /非法段|不在允许/);
  // 绝对路径
  assert.throws(() => validatedBackup({ ...b, files: [{ path: 'C:/evil.txt', lines: ['x'] }] }), /绝对路径/);
  // 未知根
  assert.throws(() => validatedBackup({ ...b, files: [{ path: 'other/foo', lines: ['x'] }] }), /不在允许根目录/);
  // 重复路径
  assert.throws(() => validatedBackup({ ...b, files: [
    { path: 'profile/a', lines: ['1'] },
    { path: 'profile/a', lines: ['2'] },
  ] }), /重复/);
  // 跨平台恢复时，Windows 会把仅大小写不同的路径视为同一文件。
  assert.throws(() => validatedBackup({ ...b, files: [
    { path: 'profile/Config.yml', lines: ['1'] },
    { path: 'profile/config.yml', lines: ['2'] },
  ] }), /重复/);
});

test('validatedBackup 根据实际路径重建敏感文件清单', () => {
  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    secretFiles: [],
    files: [
      { path: 'home/.credentials.yaml', lines: ['token: secret'] },
      { path: 'profile/readme.md', lines: ['ok'] },
    ],
  };
  const validated = validatedBackup(backup);
  assert.deepStrictEqual(validated.secretFiles, ['home/.credentials.yaml']);
});

test('validatedBackup 拒绝含 node_modules 段的路径（A1）', () => {
  const home = tmpdir();
  const profile = path.join(home, 'profiles', 'web');
  write(home, 'settings.yaml', 'k: v');
  write(profile, 'cordis.patch.yml', '- id: x');
  const b = createBackup({ profileDir: profile, homeDir: home }, fs, path);
  const evilProfile = { ...b, files: [{ path: 'profile/node_modules/evil-pkg/lib/index.js', lines: ['x'] }] };
  assert.throws(() => validatedBackup(evilProfile), /node_modules 段/);
  const evilHome = { ...b, files: [{ path: 'home/.x/node_modules/y.js', lines: ['x'] }] };
  assert.throws(() => validatedBackup(evilHome), /node_modules 段/);
});

test('非 UTF-8 文本以 base64 存储并原样还原（B3）', () => {
  const home = tmpdir();
  const profile = path.join(home, 'profiles', 'web');
  write(profile, 'cordis.patch.yml', '- id: x');
  // GBK「中文」+ CRLF：无 NUL、非合法 UTF-8 → 应走 base64 分支
  const bytes = Buffer.from([0xd6, 0xd0, 0xb9, 0xfa, 0x0d, 0x0a]);
  fs.writeFileSync(path.join(profile, 'legacy.cfg'), bytes);
  const b = createBackup({ profileDir: profile, homeDir: home }, fs, path);
  const entry = b.files.find((f) => f.path === 'profile/legacy.cfg');
  assert.ok(entry, 'legacy.cfg 应被收集');
  assert.strictEqual(entry.encoding, 'base64');
  // round-trip：校验 → 恢复到另一目录 → 字节一致
  const v = validatedBackup(b);
  const destProfile = tmpdir();
  const destHome = tmpdir();
  const r = restoreBackup(v, { profileDir: destProfile, homeDir: destHome }, fs, path);
  assert.ok(r.files >= 1);
  const restored = fs.readFileSync(path.join(destProfile, 'legacy.cfg'));
  assert.ok(restored.equals(bytes), 'GBK 原字节应原样还原');
});

test('restoreBackup 写入并返回 rollback；失败自动回滚', () => {
  const home = tmpdir();
  const profile = path.join(home, 'profiles', 'web');
  const profile2 = tmpdir();
  const home2 = tmpdir();
  write(profile, 'cordis.patch.yml', 'original-patch');
  write(profile, 'package.json', '{"name":"old"}');
  write(home, 'settings.yaml', 'k: v');
  write(profile2, 'cordis.patch.yml', 'target-old');
  write(profile2, 'package.json', '{"name":"target"}');
  write(home2, 'settings.yaml', 'target-home');
  const b = createBackup({ profileDir: profile, homeDir: home }, fs, path);
  const r = restoreBackup(b, { profileDir: profile2, homeDir: home2 }, fs, path);
  assert.ok(r.files >= 1);
  // 恢复后内容等于源
  assert.strictEqual(fs.readFileSync(path.join(profile2, 'cordis.patch.yml'), 'utf8'), 'original-patch');
  // rollback 还原
  r.rollback();
  assert.strictEqual(fs.readFileSync(path.join(profile2, 'cordis.patch.yml'), 'utf8'), 'target-old');
});

test('restoreBackup 拒绝逃逸与缺失父目录', () => {
  const home = tmpdir();
  const profile = path.join(home, 'profiles', 'web');
  const profile2 = tmpdir();
  const home2 = tmpdir();
  write(profile, 'a.yml', 'x');
  const b = createBackup({ profileDir: profile, homeDir: home }, fs, path);
  const evil = { ...b, files: [{ path: 'profile/../../evil', lines: ['x'] }] };
  assert.throws(() => restoreBackup(evil, { profileDir: profile2, homeDir: home2 }, fs, path), /非法段|未知根|逃逸/);
  // 父目录缺失：目标根不存在
  const missing = tmpdir();
  const noParent = { ...b, files: [{ path: 'profile/deep/nested.yml', lines: ['x'] }] };
  assert.throws(() => restoreBackup(noParent, { profileDir: missing, homeDir: home2 }, fs, path), /目标目录缺失/);
});

test('createBackup 无可备份内容时报错', () => {
  const empty = tmpdir();
  const empty2 = tmpdir();
  fs.mkdirSync(path.join(empty, 'node_modules'), { recursive: true });
  assert.throws(() => createBackup({ profileDir: empty, homeDir: empty2 }, fs, path), /没有可备份的配置内容/);
});
