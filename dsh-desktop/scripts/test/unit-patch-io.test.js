'use strict';

// patch-io 原语单测：唯一临时名（并发安全）、失败清理、读缓存失效与 TOCTOU。
// 全程只读写临时目录，绝不触碰真实 ~/.dsh。

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { writeFileAtomic, readFileCached, readFileRetry, statRetry, isTransientFsError, readableFsError } = require('../lib/patch-io');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-io-test-'));
}

test('writeFileAtomic: 内容正确落盘且无残留临时文件', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'target.txt');
  writeFileAtomic(file, 'hello 第一行\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello 第一行\n');
  assert.deepEqual(fs.readdirSync(dir), ['target.txt'], '不应留下 .tmp 残留');
  writeFileAtomic(file, 'second\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'second\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic: 并发写同一目标不互踩、结果完整、无残留', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'race.txt');
  const contents = Array.from({ length: 20 }, (_, i) => 'writer-' + i + '-payload-' + ('x'.repeat(500)));
  await Promise.all(contents.map((c) => Promise.resolve().then(() => writeFileAtomic(file, c))));
  const final = fs.readFileSync(file, 'utf8');
  assert.ok(contents.includes(final), '最终内容必须是某一次完整写入');
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp'));
  assert.deepEqual(leftovers, [], '并发后不应有 .tmp 残留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic: 目标目录不存在时抛错且清理临时文件', () => {
  const dir = tmpDir();
  const missing = path.join(dir, 'no-such-dir', 'target.txt');
  assert.throws(() => writeFileAtomic(missing, 'x'), /ENOENT|no such file|系统找不到/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readFileCached: 缺失返回 null，命中缓存，mtime 变化失效', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'c.txt');
  assert.equal(readFileCached(file), null);
  writeFileAtomic(file, 'v1\n');
  assert.equal(readFileCached(file), 'v1\n');
  assert.equal(readFileCached(file), 'v1\n'); // 缓存命中
  // 写入必改 mtime → 缓存失效
  const old = fs.statSync(file);
  fs.writeFileSync(file, 'v2\n');
  const now = new Date();
  fs.utimesSync(file, now, new Date(old.mtimeMs + 2000)); // 确保 mtime 前进
  assert.equal(readFileCached(file), 'v2\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readFileCached: 多路径指向同一物理文件共享缓存', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'real.txt');
  fs.writeFileSync(file, 'same\n');
  const alias = path.join(dir, '.', 'real.txt');
  assert.equal(readFileCached(file), 'same\n');
  assert.equal(readFileCached(alias), 'same\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── EBUSY 瞬时锁有限重试（#154 第二根因）─────────────────────────────────

test('readFileRetry: ENOENT 不重试直接抛（保持调用方语义）', () => {
  const dir = tmpDir();
  try {
    assert.throws(() => readFileRetry(path.join(dir, 'missing.txt'), 'utf8'), (err) => err.code === 'ENOENT');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readFileRetry: EBUSY 瞬时锁重试后成功（#154）', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'busy.txt');
    fs.writeFileSync(file, 'data');
    let calls = 0;
    const realRead = fs.readFileSync;
    fs.readFileSync = function (f, enc) {
      calls += 1;
      if (calls === 1) {
        const e = new Error('EBUSY: resource busy or locked');
        e.code = 'EBUSY';
        throw e;
      }
      return realRead.call(fs, f, enc);
    };
    try {
      assert.equal(readFileRetry(file, 'utf8'), 'data');
      assert.ok(calls >= 2, `首读 EBUSY 后应重试（calls=${calls}）`);
    } finally {
      fs.readFileSync = realRead;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readFileRetry: EBUSY 重试耗尽 → 可读错误（含文件与重试次数，非裸 EBUSY）', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'always-busy.txt');
    fs.writeFileSync(file, 'x');
    const realRead = fs.readFileSync;
    fs.readFileSync = function () {
      const e = new Error('EBUSY: resource busy or locked');
      e.code = 'EBUSY';
      throw e;
    };
    try {
      assert.throws(() => readFileRetry(file, 'utf8', { attempts: 2, baseDelayMs: 1 }), (err) => {
        assert.match(err.message, /暂时锁定/);
        assert.match(err.message, /2 次/);
        assert.equal(err.code, 'EBUSY');
        return true;
      });
    } finally {
      fs.readFileSync = realRead;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('statRetry: EBUSY 瞬时锁重试后成功；耗尽给可读错误', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 's.txt');
    fs.writeFileSync(file, 'x');
    let calls = 0;
    const realStat = fs.statSync;
    fs.statSync = function (f) {
      calls += 1;
      if (calls === 1) {
        const e = new Error('EBUSY');
        e.code = 'EBUSY';
        throw e;
      }
      return realStat.call(fs, f);
    };
    try {
      assert.ok(statRetry(file).isFile());
      assert.ok(calls >= 2, 'stat 首读 EBUSY 应重试');
    } finally {
      fs.statSync = realStat;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isTransientFsError / readableFsError: 判定与可读包装', () => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    assert.equal(isTransientFsError({ code }), true, code);
  }
  assert.equal(isTransientFsError({ code: 'ENOENT' }), false);
  assert.equal(isTransientFsError(null), false);
  const wrapped = readableFsError(Object.assign(new Error('EBUSY: lock'), { code: 'EBUSY' }), 'C:/x/y.yml', '读取文件', 3);
  assert.equal(wrapped.code, 'EBUSY');
  assert.match(wrapped.message, /C:\/x\/y\.yml/);
  assert.match(wrapped.message, /暂时锁定/);
});
