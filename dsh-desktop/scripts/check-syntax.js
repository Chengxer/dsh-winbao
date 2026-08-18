'use strict';

// 构建前语法预检（prepack / predist 自动执行）。
// v0.3.8 事故：main.js 中 `async` 关键字与 function 声明被注释拆开，
// 打包出启动即抛 ReferenceError: async is not defined 的安装包。
// 该类问题 node --check 查不出来（孤立 async 是合法的表达式语句，
// 错误发生在运行时），因此本脚本额外做模式扫描。
// 检查范围与 electron-builder.yml 的 files 清单保持一致（入口 js）。

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const entryFiles = [
  'main.js',
  'preload.js',
  'updater.js',
  'client-updater.js',
  'balance.js',
  'session-watcher.js',
  'renderer-recovery.js',
  'wsl-backend.js',
  'watchdog.js',
  // 自愈 / 补丁模块（electron-builder files 清单内，随包分发，必须过语法门）。
  'profile-manifest.js',
  'profile-patch-heal.js',
  'profile-bundle-heal.js',
  // 统一补丁引擎与配套插件共享模块（main.js / 同步脚本 / after-pack 共用）。
  'scripts/lib/patch-io.js',
  'scripts/lib/patch-engine.js',
  'scripts/lib/companion-plugins.js',
  'scripts/lib/runtime-patches.js',
  'scripts/lib/companion-profile.js',
  'scripts/lib/profile-reconcile.js',
  'scripts/lib/versions.js',
  'scripts/lib/preset-guard.js',
  'scripts/patch-web-search-baseurl.js',
  'scripts/patch-menu-viewport.js',
  'scripts/patch-session-manage.js',
  'scripts/patch-open-project-dir.js',
  'scripts/patch-session-persistence.js',
  'scripts/patch-slot-compat.js',
  'scripts/gpu-crash-guard.js',
  'scripts/install-minimal-win-preset.js',
  'scripts/patch-deps.js',
  'scripts/patch-pi-ai-credits.js',
  'scripts/sync-companion-plugins.js',
  'scripts/after-pack.js',
  'scripts/patch-portable-template.js',
  'scripts/plugin-manager-patch.js',
  'scripts/plugin-manager-update.js',
  'scripts/desktop-diagnostics.js',
  'scripts/desktop-backup.js',
  'scripts/desktop-ordering.js',
  'scripts/desktop-validity.js',
];

// 匹配「async/await 关键字与紧随其后的 function 声明之间被空行/注释行拆开」：
//   async // 注释…
//   // 更多注释…
//   function probeOverlayAgent() {}
// 孤立 async/await 表达式在运行时会抛 ReferenceError，必须在打包前拦截。
const DETACHED_KEYWORD = /^[ \t]*(async|await)[ \t]*(?:\/\/[^\r\n]*)?[ \t]*\r?\n(?:[ \t]*(?:\/\/[^\r\n]*)?[ \t]*\r?\n)*[ \t]*function\b/gm;

// 扫描前剔除字符串字面量（单/双引号）、模板字面量与块注释，避免其中的
// "async\nfunction" 合法文本被误判为「孤立 async」并终止打包（issue #75）。
// 用等长空白替换以保持行号与列号不变，使报错定位仍准确。
function stripStringsAndBlockComments(text) {
  const out = [];
  const repl = (m) => m.replace(/[^\r\n]/g, ' ');
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // 块注释
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) { out.push(repl(text.slice(i))); break; }
      out.push(repl(text.slice(i, end + 2)));
      i = end + 2;
      continue;
    }
    // 字符串 / 模板字面量（含插值片段）。处理转义；模板插值 ${} 内的内容在
    // 绝大多数场景也是文档/示例文本，统一剔除即可规避误报。
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === quote) break;
        j += 1;
      }
      if (j >= text.length) { out.push(repl(text.slice(i))); break; }
      out.push(repl(text.slice(i, j + 1)));
      i = j + 1;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join('');
}

function detachedHits(text) {
  const scanned = stripStringsAndBlockComments(text);
  const hits = [];
  let match;
  DETACHED_KEYWORD.lastIndex = 0;
  while ((match = DETACHED_KEYWORD.exec(scanned)) !== null) {
    const upTo = scanned.slice(0, match.index);
    hits.push({ keyword: match[1], line: upTo.split(/\r?\n/).length });
  }
  return hits;
}

const missing = entryFiles.filter((f) => !fs.existsSync(path.join(root, f)));
if (missing.length) {
  console.error('[check-syntax] 缺少入口文件: ' + missing.join(', '));
  process.exit(1);
}

let failed = 0;
for (const file of entryFiles) {
  const filePath = path.join(root, file);
  const result = spawnSync(process.execPath, ['--check', filePath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    failed++;
    console.error(`[check-syntax] FAIL ${file}（node --check）`);
    if (result.stderr) console.error(result.stderr.trim());
    continue;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const hits = detachedHits(text);
  if (hits.length > 0) {
    failed++;
    console.error(`[check-syntax] FAIL ${file}（疑似 async/await 关键字与声明被拆开）`);
    for (const hit of hits) {
      console.error(`  行 ${hit.line}: 孤立的 ${hit.keyword} 后跟 function 声明，运行时会抛 ReferenceError`);
    }
    continue;
  }
  console.log(`[check-syntax] ok   ${file}`);
}

if (failed > 0) {
  console.error(`[check-syntax] ${failed} 个文件未通过，终止打包。`);
  process.exit(1);
}
console.log('[check-syntax] 全部入口文件语法检查通过。');
