'use strict';

// DSH Desktop 客户端自更新引擎（更新“封装客户端本身”，与 updater.js 的
// dsh agent 更新互相独立）。
//
// 流程：
//   1. checkLatest(): 依次查询上游发布源（GitHub Releases → Gitee Releases，
//      可用环境变量 DSH_DESKTOP_RELEASE_API 指向自定义镜像 API），取 latest
//      release 的 tag 作为版本号，与当前 APP_VERSION 比较。
//   2. selectAsset(): 按当前部署形态选择安装包 —— 便携版选
//      *-portable-x64.exe；安装版选 Setup-*-x64.exe。Gitee 因单文件 100MB
//      限制把安装包拆成 .part1/.part2 分片，此时自动按序下载并拼接。
//   3. downloadRelease(): 流式下载（带进度回调）到 <userData>/updates/。
//   4. applyUpdate(): 写一个纯 ASCII 的 cmd 脚本并以 detached 方式启动，随后
//      主进程退出：
//      · 便携版：等旧 exe 解锁 → 备份 → 用新 exe 原地替换 → 重新启动；
//        若旧 exe 所在目录只读，则退化为直接启动新 exe（保留旧文件）。
//      · 安装版：等 DSH Desktop 进程退出 → 以向导方式启动新 Setup 安装包
//        （安装器会记录原安装目录并在完成后自动启动新版本）。

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { compareVersions } = require('./updater');

const DEFAULT_REPOS = { github: 'myYangyunfan/dsh_desktop', gitee: 'my-yang-yunfan/dsh_desktop' };
const REPO_SLUG = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,64}$/;
const MIN_VALID_BYTES = 64 * 1024 * 1024; // 完整安装包远大于 64MB，防止把错误页当 exe

function isPortable() {
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
}

/** 解析仓库地址（格式非法或缺省时回退到内置默认仓库）。 */
function resolveRepos(repos) {
  const r = repos && typeof repos === 'object' ? repos : {};
  const github = REPO_SLUG.test(String(r.github || '')) ? r.github : DEFAULT_REPOS.github;
  const gitee = REPO_SLUG.test(String(r.gitee || '')) ? r.gitee : DEFAULT_REPOS.gitee;
  return { github, gitee };
}

function apiEndpoints() {
  if (process.env.DSH_DESKTOP_RELEASE_API) {
    return [{ name: '自定义镜像', url: process.env.DSH_DESKTOP_RELEASE_API }];
  }
  const { github, gitee } = resolveRepos();
  return [
    {
      name: 'GitHub',
      url: `https://api.github.com/repos/${github}/releases/latest`,
      headers: { Accept: 'application/vnd.github+json' },
    },
    { name: 'Gitee', url: `https://gitee.com/api/v5/repos/${gitee}/releases/latest` },
  ];
}

// --- HTTP ----------------------------------------------------------------

function httpGetJson(url, headers = {}, timeoutMs = 20000, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向次数过多'));
    const req = https.get(url, { headers: { 'User-Agent': 'DSH-Desktop', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpGetJson(new URL(res.headers.location, url).toString(), headers, timeoutMs, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 4 * 1024 * 1024) req.destroy(new Error('响应过大'));
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('JSON 解析失败')); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

// --- release 规范化 -------------------------------------------------------

function normalizeRelease(source, data) {
  const tag = String(data.tag_name || data.tag || data.name || '').trim();
  const version = tag.replace(/^v/i, '');
  const assets = Array.isArray(data.assets)
    ? data.assets
        .map((a) => ({
          name: String(a.name || ''),
          url: String(a.browser_download_url || a.url || ''),
          size: Number(a.size || 0),
        }))
        .filter((a) => a.name && a.url)
    : [];
  return {
    source,
    version,
    name: data.name || null,
    body: String(data.body || ''),
    htmlUrl: data.html_url || null,
    assets,
  };
}

async function checkLatest(ctx, currentVersion) {
  const errors = [];
  for (const ep of apiEndpoints()) {
    try {
      const data = await httpGetJson(ep.url, ep.headers || {});
      const rel = normalizeRelease(ep.name, data);
      if (!rel.version || !rel.assets.length) {
        throw new Error('上游 release 缺少版本号或安装包资产');
      }
      rel.isNewer = compareVersions(rel.version, currentVersion) > 0;
      ctx.log('client-update', `[${ep.name}] latest=${rel.version} 当前=${currentVersion} 资产数=${rel.assets.length}`);
      return rel;
    } catch (err) {
      errors.push(`${ep.name}: ${err.message}`);
      ctx.log('client-update', `[${ep.name}] 查询失败: ${err.message}`);
    }
  }
  throw new Error('无法连接上游发布源（' + errors.join('；') + '）');
}

// --- 资产选择 / 下载 -------------------------------------------------------

function selectAsset(release) {
  const wanted = isPortable() ? /-portable-x64\.exe$/i : /-setup-.*-x64\.exe$/i;
  const direct = release.assets.find((a) => wanted.test(a.name));
  if (direct) return { parts: [direct], name: direct.name, totalSize: direct.size };

  // Gitee 单文件 100MB 限制：安装包拆分为 <file>.part1 / <file>.part2 …
  const base = isPortable()
    ? `DSH-Desktop-${release.version}-portable-x64.exe`
    : `DSH-Desktop-Setup-${release.version}-x64.exe`;
  const parts = release.assets
    .filter((a) => a.name.startsWith(base + '.part'))
    .sort((a, b) => {
      const n = (s) => parseInt(s.split('part').pop(), 10) || 0;
      return n(a.name) - n(b.name);
    });
  if (!parts.length) {
    throw new Error('未找到匹配的安装包资产（' + release.assets.map((a) => a.name).join(', ') + '）');
  }
  return { parts, name: base, totalSize: parts.reduce((s, p) => s + p.size, 0) };
}

function downloadFile(url, dest, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    const file = fs.createWriteStream(tmp);
    let received = 0;
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const fail = (err) => {
      file.close(() => {});
      try { fs.rmSync(tmp, { force: true }); } catch {}
      finish(reject, err);
    };
    const request = (url2, redirects) => {
      if (redirects > 5) return fail(new Error('重定向次数过多'));
      const req = https.get(url2, { headers: { 'User-Agent': 'DSH-Desktop' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return request(new URL(res.headers.location, url2).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error('下载失败 HTTP ' + res.statusCode));
        }
        const total = Number(res.headers['content-length'] || 0);
        res.on('data', (c) => {
          received += c.length;
          if (onProgress) { try { onProgress(received, total); } catch {} }
        });
        res.pipe(file);
      });
      req.setTimeout(60000, () => req.destroy(new Error('下载超时')));
      req.on('error', fail);
    };
    request(url, 0);
    file.on('finish', () => {
      if (settled) return;
      try { fs.renameSync(tmp, dest); } catch (err) { return finish(reject, err); }
      finish(resolve, { path: dest, size: received });
    });
    file.on('error', fail);
  });
}

async function concatFiles(sources, dest) {
  const out = fs.createWriteStream(dest);
  for (const s of sources) {
    await new Promise((res, rej) => {
      const rs = fs.createReadStream(s);
      rs.on('error', rej);
      rs.on('end', res);
      rs.pipe(out, { end: false });
    });
    fs.rmSync(s, { force: true });
  }
  await new Promise((res, rej) => {
    out.on('error', rej);
    out.end(res);
  });
}

async function downloadRelease(ctx, release, { onProgress } = {}) {
  const dir = path.join(ctx.userDataDir, 'updates');
  fs.mkdirSync(dir, { recursive: true });
  const sel = selectAsset(release);
  const split = sel.parts.length > 1;
  const finalPath = path.join(dir, sel.name);
  const partPaths = [];
  let merged = 0;
  for (let i = 0; i < sel.parts.length; i++) {
    const p = sel.parts[i];
    ctx.log('client-update', `下载 ${p.name}（${Math.round(p.size / 1048576)} MB）`);
    const dest = split ? finalPath + '.part' + (i + 1) : finalPath;
    const res = await downloadFile(p.url, dest, {
      onProgress: (r) => {
        if (onProgress) onProgress(split ? merged + r : r, sel.totalSize);
      },
    });
    if (split) { merged += res.size; partPaths.push(dest); }
  }
  if (split) {
    ctx.log('client-update', `合并 ${partPaths.length} 个分片 → ${sel.name}`);
    await concatFiles(partPaths, finalPath);
  }
  const stat = fs.statSync(finalPath);
  if (stat.size < MIN_VALID_BYTES) {
    fs.rmSync(finalPath, { force: true });
    throw new Error('下载文件异常（仅 ' + Math.round(stat.size / 1048576) + ' MB），已丢弃');
  }
  if (sel.totalSize > 0 && Math.abs(stat.size - sel.totalSize) > 2 * 1024 * 1024) {
    ctx.log('client-update', `大小与上游声明不一致：期望 ${sel.totalSize} 实际 ${stat.size}（继续，安装器会自校验）`);
  }
  ctx.log('client-update', `下载完成: ${finalPath}（${Math.round(stat.size / 1048576)} MB）`);
  return { filePath: finalPath, size: stat.size };
}

// --- 应用更新（detached 脚本 + 主进程退出） ---------------------------------

function applyUpdate(ctx, pending) {
  const newExe = pending.path;
  const portable = isPortable();
  const oldExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const exeBase = path.basename(oldExe);
  const script = path.join(ctx.userDataDir, 'updates', 'apply-update.cmd');
  const lines = ['@echo off'];
  if (portable) {
    lines.push(
      'set "NEW=%~1"',
      'set "OLD=%~2"',
      'set /a tries=0',
      ':wait',
      'set /a tries+=1',
      'if %tries% gtr 300 goto failed',
      'ping -n 2 127.0.0.1 >nul',
      'if not exist "%OLD%" goto replace',
      'copy /y "%OLD%" "%OLD%.bak" >nul 2>&1',
      'if errorlevel 1 goto wait',
      'del /f /q "%OLD%" >nul 2>&1',
      'if exist "%OLD%" goto wait',
      ':replace',
      'copy /y "%NEW%" "%OLD%" >nul 2>&1',
      'if errorlevel 1 goto failed',
      'del "%NEW%" >nul 2>&1',
      'start "" "%OLD%"',
      'if exist "%OLD%.bak" del "%OLD%.bak" >nul 2>&1',
      'del "%~f0" >nul 2>&1',
      'exit /b 0',
      ':failed',
      // M3 修复：超时后先尽力复制回原位再启动，避免便携版从 updates 目录
      // 直接启动导致新建 data 目录、丢失设置。
      'if exist "%OLD%.bak" copy /y "%OLD%.bak" "%OLD%" >nul 2>&1',
      'if not exist "%OLD%" copy /y "%NEW%" "%OLD%" >nul 2>&1',
      'if exist "%OLD%" (start "" "%OLD%") else (start "" "%NEW%")',
      'if exist "%OLD%.bak" del "%OLD%.bak" >nul 2>&1',
      'del "%~f0" >nul 2>&1',
      'exit /b 0'
    );
  } else {
    lines.push(
      'set "SETUP=%~1"',
      'set "EXENAME=%~2"',
      ':wait',
      'ping -n 2 127.0.0.1 >nul',
      'tasklist /fi "IMAGENAME eq %EXENAME%" 2>nul | find /i "%EXENAME%" >nul',
      'if not errorlevel 1 goto wait',
      'start /wait "" "%SETUP%"',
      'del "%SETUP%" >nul 2>&1',
      'del "%~f0" >nul 2>&1',
      'exit /b 0'
    );
  }
  fs.writeFileSync(script, lines.join('\r\n'));
  ctx.log('client-update', `启动更新脚本: ${script}（新: ${newExe}，旧: ${oldExe}）`);
  const child = spawn('cmd.exe', ['/c', script, newExe, portable ? oldExe : exeBase], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return script;
}

module.exports = { checkLatest, selectAsset, downloadRelease, applyUpdate, isPortable, resolveRepos, DEFAULT_REPOS };
