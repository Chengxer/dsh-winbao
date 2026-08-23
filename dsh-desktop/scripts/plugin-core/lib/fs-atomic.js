'use strict';

// ---------------------------------------------------------------------------
// plugin-core 原子文件写入与跨进程写锁（fs-atomic）。
//
// 全仓唯一原子写实现（历史存在 patch-io / profile-patch-heal / desktop-ordering /
// desktop-backup 四份 tmp+rename 复制，逐步漂移）。WriteGate 以「锁文件 + 存活
// 探测 + 超时抢占」提供跨进程互斥，profile 的 package.json / cordis.patch.yml /
// desktop-plugin-state.json 三类共享文件的写入口必须经同一 gate 串行化，
// 杜绝「壳层与 CLI 并发写同一 manifest」的丢更新。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { PluginError, PLUGIN_ERROR_CODES } = require('./errors');

// 同 key 重入识别（见 WriteGate.run）。
const runAls = new AsyncLocalStorage();

/** tmp+rename 原子写：EPERM/EBUSY（杀软短暂锁定）重试 3 次（递增退避），失败抛错（调用方兜底）。
 *  目标目录必须已存在（与历史契约一致：不隐式创建目录，缺失即抛错）。
 *  绝不先删目标再写——「失败时原文件完好」是原子写契约的一部分
 *  （只读目标等场景 rename 失败即失败，不降级为破坏性覆盖）。
 *  #154 第二根因：重试间加 120ms 递增退避（杀软锁窗口通常是几十 ms 级），
 *  并给出可读错误（含文件与重试次数），替代裸 EBUSY。 */
function writeFileAtomic(file, content) {
  sweepStaleTmp(file);
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      lastErr = err;
      try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略清理失败 */ }
      if (isTransientFsError(err) && attempt < 2) {
        sleepSync(120 * (attempt + 1));
      }
    }
  }
  const readable = lastErr && isTransientFsError(lastErr)
    ? `${file}: 写入失败（${lastErr.message}），文件可能被杀毒软件/索引服务暂时锁定，已重试 3 次仍失败`
    : `writeFileAtomic failed: ${file}（${(lastErr && lastErr.message) || lastErr}）`;
  const out = new Error(readable);
  if (lastErr) {
    out.cause = lastErr;
    // 保留原始错误码（EPERM/EACCES/EBUSY/ENOENT…）：调用方（manifest-store/
    // lifecycle 只读目标传播、测试断言 err.code）依赖 code 而非包装文本。
    if (lastErr.code) out.code = lastErr.code;
  }
  throw out;
}

/** 是否为可重试的 Windows 瞬时锁错误码（EBUSY/EPERM/EACCES）。 */
function isTransientFsError(err) {
  return !!err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* 同步退避 */ }
}

/** 清理同一目标文件 1 小时前的孤儿 .tmp-*（崩溃残留；尽力而为，绝不动其它文件）。 */
function sweepStaleTmp(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const prefix = base + '.tmp-';
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (Date.now() - st.mtimeMs > 3600 * 1000) fs.rmSync(path.join(dir, name), { force: true });
    } catch { /* 占用/消失则跳过 */ }
  }
}

/** JSON 序列化 + 尾换行 + 原子写（自动创建父目录）。 */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

/**
 * 备份文件并裁剪历史备份（保留最近 keep 份，按文件名后缀时间戳排序）。
 * 备份名：<file>.bak-<ts>-<pid>（时间戳 + pid，同毫秒并发不碰撞）。
 * 返回备份路径；失败返回 null（备份失败不阻塞主流程）。
 */
function backupFile(file, { keep = 5, log = () => {} } = {}) {
  try {
    if (!fs.existsSync(file)) return null;
    const backup = file + '.bak-' + Date.now() + '-' + process.pid;
    fs.copyFileSync(file, backup);
    const dir = path.dirname(file);
    const base = path.basename(file);
    const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.bak-(\\d+)-\\d+$');
    let backups = [];
    try {
      backups = fs.readdirSync(dir)
        .filter((n) => re.test(n))
        .map((n) => ({ name: n, ts: Number(re.exec(n)[1]) || 0 }))
        .sort((a, b) => b.ts - a.ts);
    } catch { /* 枚举失败不裁剪 */ }
    for (const item of backups.slice(keep)) {
      try { fs.rmSync(path.join(dir, item.name), { force: true, maxRetries: 2 }); } catch { /* 忽略 */ }
    }
    return backup;
  } catch (err) {
    if (log) log('备份文件失败 ' + file + ': ' + (err && err.message));
    return null;
  }
}

// ---------------------------------------------------------------------------
// WriteGate：锁文件互斥（跨进程）。
//   acquire —— 创建 <key>.lock（内容 { pid, at }）；EEXIST 时读锁判定：
//             持有进程已死（ESRCH）或锁龄 > staleMs → 抢占；否则退避重试至
//             timeoutMs，超时抛 PluginError(PLUGIN_BUSY)。
//   run(key, fn) —— acquire → fn() → release（finally 保证释放；只释放自己
//             写入的锁，绝不误删他人抢占后的新锁）。
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeLockKey(key) {
  return String(key || 'default').replace(/[^A-Za-z0-9_.-]/g, '_');
}

class WriteGate {
  /**
   * @param {Object} opts
   * @param {string} opts.lockDir      锁文件目录（必须已存在或可创建）
   * @param {number} [opts.timeoutMs]  获取锁超时（默认 8000）
   * @param {number} [opts.staleMs]    锁龄阈值：持有者进程已死或超过该时长可抢占（默认 30000）
   * @param {(msg: string) => void} [opts.log]
   * @param {number} [opts.retryMs]    退避间隔（默认 40）
   */
  constructor({ lockDir, timeoutMs = 8000, staleMs = 30000, log = () => {}, retryMs = 40 } = {}) {
    this.lockDir = lockDir;
    this.timeoutMs = timeoutMs;
    this.staleMs = staleMs;
    this.log = log;
    this.retryMs = retryMs;
    this.inflight = new Map(); // key -> Promise（进程内同 key 串行化）
  }

  lockFileOf(key) {
    return path.join(this.lockDir, safeLockKey(key) + '.lock');
  }

  async acquire(key) {
    const file = this.lockFileOf(key);
    try { fs.mkdirSync(this.lockDir, { recursive: true }); } catch { /* 已存在 */ }
    const deadline = Date.now() + this.timeoutMs;
    // 持有期间心跳：每 staleMs/3 刷新锁文件 mtime，防止长临界区被「锁龄抢占」
    // 误判为死锁（staleMs 只应命中真正的僵尸持有者）。
    let heartbeat = null;
    const startHeartbeat = () => {
      heartbeat = setInterval(() => {
        try { fs.utimesSync(file, new Date(), new Date()); } catch { /* 锁已失则停 */ }
      }, Math.max(50, Math.floor(this.staleMs / 3)));
      if (heartbeat.unref) heartbeat.unref();
    };
    for (;;) {
      try {
        // 锁内容含随机 token：release 前必须比对，杜绝「被抢占后误删新持有者的锁」。
        const token = crypto.randomBytes(12).toString('hex');
        // TOCTOU 防线：先写「候选文件」，再硬链接进锁名——link 对已存在的目标
        // 原子失败（EEXIST），竞争者永远读不到空锁/半写锁（历史上 openSync('wx')
        // 先建空文件再写内容，竞争者在该窗口把空锁误判为「可抢占」→ 双持锁）。
        const candidate = file + '.cand-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
        let linked = false;
        try {
          fs.writeFileSync(candidate, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
          try {
            fs.linkSync(candidate, file);
            linked = true;
          } catch (err) {
            if (!err || err.code !== 'EEXIST') {
              // 不支持硬链接的文件系统（如 FAT/exFAT）：退化到 wx 独占创建
              //（残留的空锁窗口极窄且仅限该文件系统，可接受）。
              try {
                const fd = fs.openSync(file, 'wx');
                try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token })); } finally { fs.closeSync(fd); }
                linked = true;
              } catch (err2) {
                if (!err2 || err2.code !== 'EEXIST') throw err2;
              }
            }
          }
        } finally {
          try { fs.rmSync(candidate, { force: true }); } catch { /* 忽略 */ }
        }
        if (linked) {
          startHeartbeat();
          return { file, token, heartbeat };
        }
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
      }
      {
        let holder = null;
        try {
          holder = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch { /* 锁文件半写/损坏按可抢占处理 */ }
        const holderDead = !holder || !pidAlive(Number(holder.pid));
        let stale = false;
        try {
          const st = fs.statSync(file);
          stale = Date.now() - st.mtimeMs > this.staleMs;
        } catch { /* 文件消失，重试创建 */ }
        if (holderDead || stale) {
          try { fs.rmSync(file, { force: true }); } catch { /* 抢占竞争，重试 */ }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new PluginError(PLUGIN_ERROR_CODES.PLUGIN_BUSY,
            '写入锁获取超时（另一进程正在修改同一文件）: ' + file);
        }
        await sleep(this.retryMs);
      }
    }
  }

  release(held) {
    const file = typeof held === 'string' ? held : held && held.file;
    const token = typeof held === 'string' ? null : held && held.token;
    if (!file) return;
    if (held && held.heartbeat) { try { clearInterval(held.heartbeat); } catch { /* 忽略 */ } }
    try {
      // 所有权校验：仍持有（token 匹配）才删除；被抢占后绝不删新持有者的锁。
      if (token !== null) {
        const current = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (current && current.token !== token) return;
      }
      fs.rmSync(file, { force: true });
    } catch { /* 释放失败无害 */ }
  }

  /** 在写锁内执行 fn（进程内同 key 串行，跨进程互斥）。 */
  run(key, fn) {
    // 同 key 重入死锁防线：fn 在执行中（同一异步链上）再次 run 同 key 会永远
    // 等自己。用 AsyncLocalStorage 携带「gate 实例 + key」识别同链重入（同一
    // gate 同 key）直接以 PLUGIN_BUSY 拒绝；不同异步链的并发调用、或其它 gate
    // 的同名 key 不受影响（排队语义不变）。
    const cur = runAls.getStore();
    if (cur && cur.gate === this && cur.key === key) {
      return Promise.reject(new PluginError(PLUGIN_ERROR_CODES.PLUGIN_BUSY, '写入锁同键重入（同一操作链上重复修改同一文件）: ' + key));
    }
    const prev = this.inflight.get(key) || Promise.resolve();
    const next = prev.then(async () => {
      const held = await this.acquire(key);
      try {
        return await runAls.run({ gate: this, key }, fn);
      } finally {
        this.release(held);
      }
    });
    this.inflight.set(key, next.catch(() => {}));
    return next;
  }
}

/** 全进程共享的默认 gate（profile 文件写入口共用同一实例；锁目录 = <profileDir>/.dsh-locks）。 */
const sharedGates = new Map();
function sharedWriteGate(profileDir) {
  const lockDir = path.join(path.resolve(profileDir), '.dsh-locks');
  const key = lockDir;
  if (!sharedGates.has(key)) sharedGates.set(key, new WriteGate({ lockDir: key }));
  return sharedGates.get(key);
}

module.exports = {
  writeFileAtomic,
  writeJsonAtomic,
  backupFile,
  pidAlive,
  WriteGate,
  sharedWriteGate,
  isTransientFsError,
};
