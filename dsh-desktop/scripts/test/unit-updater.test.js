'use strict';

// Self-update release discovery tests. No network or Electron runtime needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const updater = require('../../updater');

test('parseReleaseVersion: strips dsh/v prefixes and rejects unsafe tags', () => {
  assert.equal(updater.parseReleaseVersion('dsh-v0.1.0-rc.7'), '0.1.0-rc.7');
  assert.equal(updater.parseReleaseVersion('v0.1.0'), '0.1.0');
  assert.equal(updater.parseReleaseVersion('dsh-v0.1.0-rc.7+build.1'), null);
  assert.equal(updater.parseReleaseVersion('dsh-latest'), null);
});

test('selectLatestRelease: includes prereleases, ignores drafts, and compares rc numbers numerically', () => {
  const selected = updater.selectLatestRelease([
    { tag_name: 'dsh-v0.1.0-rc.9', draft: false, published_at: '2026-08-16T00:00:00Z' },
    { tag_name: 'dsh-v0.1.0-rc.10', draft: false, published_at: '2026-08-17T00:00:00Z' },
    { tag_name: 'dsh-v0.1.0-rc.11', draft: true, published_at: '2026-08-18T00:00:00Z' },
  ]);
  assert.equal(selected.version, '0.1.0-rc.10');
});

test('parseNpmVersions: reads dist-tags JSON and plain output', () => {
  assert.deepEqual(
    updater.parseNpmVersions('{"latest":"0.1.0-rc.6","next":"0.1.0-rc.7"}'),
    ['0.1.0-rc.6', '0.1.0-rc.7'],
  );
  assert.deepEqual(updater.parseNpmVersions('0.1.0-rc.7\n'), ['0.1.0-rc.7']);
});

test('checkLatest: merges GitHub prerelease and npm fallback sources', async () => {
  const ctx = {
    fetchGitHubReleases: async () => [
      { tag_name: 'dsh-v0.1.0-rc.7', draft: false, published_at: '2026-08-17T12:01:58Z' },
    ],
    runNpm: async () => '{"latest":"0.1.0-rc.6","next":"0.1.0-rc.7"}',
  };
  assert.equal(await updater.checkLatest(ctx), '0.1.0-rc.7');
});

test('checkLatest: GitHub failure falls back to npm dist-tags', async () => {
  const ctx = {
    fetchGitHubReleases: async () => { throw new Error('network down'); },
    runNpm: async () => '{"latest":"0.1.0-rc.6","next":"0.1.0-rc.7"}',
  };
  assert.equal(await updater.checkLatest(ctx), '0.1.0-rc.7');
});

test('checkLatest: does not advertise a GitHub version missing from npm', async () => {
  const ctx = {
    fetchGitHubReleases: async () => [
      { tag_name: 'dsh-v0.1.0-rc.8', draft: false, published_at: '2026-08-18T00:00:00Z' },
    ],
    runNpm: async (_ctx, args) => args.includes('dist-tags')
      ? '{"latest":"0.1.0-rc.7","next":"0.1.0-rc.7"}'
      : '',
  };
  assert.equal(await updater.checkLatest(ctx), '0.1.0-rc.7');
});

test('activeVersion: returns "0.0.0" when both overlay and bundled are null', () => {
  // Bug fix: compareVersions(latest, null) treats null as empty string, always
  // returning -1, causing "already latest" branch to never trigger.
  const ctx = { userDataDir: '/nonexistent/path/that/does/not/exist' };
  const version = updater.activeVersion(ctx);
  assert.equal(typeof version, 'string');
  assert.equal(version, '0.0.0');
});

test('activeVersionInfo: returns fallback source when no overlay or bundled', () => {
  const ctx = { userDataDir: '/nonexistent/path/that/does/not/exist' };
  const info = updater.activeVersionInfo(ctx);
  assert.equal(info.version, '0.0.0');
  assert.equal(info.source, 'fallback');
});

test('compareVersions: null/undefined are treated as less than any real version', () => {
  // This is the root cause of the "repeated update prompt" bug:
  // compareVersions("0.1.0-rc.7", null) used to return -1 because
  // String(null) = "" which parsed as [''], a non-numeric segment that
  // compared as less than any numeric segment.
  // After the fix, activeVersion returns '0.0.0' instead of null.
  assert.ok(updater.compareVersions('0.1.0-rc.7', '0.0.0') > 0);
  assert.ok(updater.compareVersions('0.3.10', '0.0.0') > 0);
  // But compareVersions with actual null still returns > 0 (null → '' → less than everything).
  assert.ok(updater.compareVersions('0.1.0-rc.7', null) > 0);
});

test('saveSettings: atomic write never deletes the original on rename failure', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-settings-'));
  const userDataDir = path.join(tmp, 'userdata');
  const file = path.join(userDataDir, 'settings.json');
  const ctx = { userDataDir, log: () => {} };

  // Normal save works.
  assert.equal(updater.saveSettings(ctx, { webPort: 8080 }), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).webPort, 8080);

  // Force rename to fail by making the destination a directory: the original
  // content must be preserved (historical code deleted it before rename).
  fs.rmSync(file);
  fs.mkdirSync(file);
  const result = updater.saveSettings(ctx, { webPort: 9090 });
  // rename onto a directory fails on Windows; the directory must remain (not a lost file).
  assert.equal(result, false);
  assert.equal(fs.statSync(file).isDirectory(), true, 'original must not be clobbered to a deleted state');

  fs.rmSync(tmp, { recursive: true, force: true });
});
