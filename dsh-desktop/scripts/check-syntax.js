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

// 正则字面量的 flags 白名单（dgimsuv，含 ES2022 d / ES2024 v）。闭 / 之后
// 只允许这些字母，否则像 `a / b / c` 这样的除法链会被误认成正则。
const REGEX_FLAG_CHARS = new Set('dgimsuv');

// 除法链识别（issue #98 补强）：正则起始 / 之前若紧跟表达式操作数
// （标识符 / 数字 / ) / ]），它更可能是除法运算符而非正则字面量——
// `a / /re/g` 的第一个 / 若不识别为除法，会在真正则的起始 / 处伪闭合、
// 把真正则内的引号放给字符串分支，整段涂白导致门禁失明。
// 但 `return /re/`、`typeof /re/` 等语句前导关键字后接正则属于合法 JS，
// 必须按关键字白名单放行（否则 return 后的正则内引号会重新致盲）。
const EXPR_END_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'delete', 'void', 'new',
  'throw', 'yield', 'await', 'case', 'else', 'do', 'of',
]);
function prevTokenIsOperand(text, i) {
  let j = i - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j -= 1;
  if (j < 0) return false;
  const c = text[j];
  if (/[A-Za-z0-9_)\]]/.test(c)) {
    // 字母/下划线开头：取完整标识符，命中关键字白名单 → 正则前导（非除法）
    if (/[A-Za-z_]/.test(c)) {
      let k = j;
      while (k >= 0 && /[A-Za-z0-9_$]/.test(text[k])) k -= 1;
      if (EXPR_END_KEYWORDS.has(text.slice(k + 1, j + 1))) return false;
    }
    return true;
  }
  return false;
}

/**
 * 在 text[start]（必须是 '/'）处试探「正则字面量」的闭 / 下标。
 * 规则：跳过转义（\/ 等）；字符类 [...] 内的 / 与引号不结束正则；
 * 传统正则字面量不跨行；闭 / 之后允许 flags 字母（gimsuy）与空白，
 * 但空白后若跟普通字母/数字则按除法链（a / b / c）处理，返回 -1。
 * 找不到返回 -1。
 */
function findRegexClose(text, start) {
  let j = start + 1;
  let inClass = false;
  for (; j < text.length; j += 1) {
    const c = text[j];
    if (c === '\\') { j += 1; continue; }
    if (c === '\n' || c === '\r') return -1;
    if (c === '[') { inClass = true; continue; }
    if (c === ']') { inClass = false; continue; }
    if (c === '/' && !inClass) break;
  }
  if (j >= text.length) return -1;
  let k = j + 1;
  while (k < text.length && REGEX_FLAG_CHARS.has(text[k])) k += 1;
  while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k += 1;
  const nxt = text[k];
  // 闭 / 后（跳过 flags 与空白）必须是分隔符/行尾/点号（.test 调用）——
  // 普通字母或数字说明是除法链（a / b / c）的下一操作数。
  if (nxt !== undefined && /[A-Za-z0-9_]/.test(nxt)) return -1;
  return j;
}

// 扫描前剔除字符串字面量（单/双引号）、模板字面量、块注释与正则字面量，
// 避免其中的 "async\nfunction" 合法文本被误判为「孤立 async」并终止打包
// （issue #75；issue #98：正则字面量内的引号若当字符串起始，会把中间
// 真实代码整段涂白，门禁失明——preload.js 实测曾 77.2% 被涂白）。
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
    // 行注释：跳到行尾（保留换行）。行注释内的引号/反引号若被当作字符串
    // 起始，会把后续真实代码整段剔除，导致「孤立 async」漏报并放行走私
    // （issue #75 补强：漏报比误报更危险）。
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i + 2);
      if (nl === -1) { out.push(repl(text.slice(i))); break; }
      out.push(repl(text.slice(i, nl)));
      i = nl;
      continue;
    }
    // 正则字面量（issue #98）：整体涂白，防止其中的引号被当成字符串起始。
    // 除法运算符（a / b）的 / 不是正则起始，跳过；关键字后接正则（return /re/）放行。
    if (c === '/' && text[i + 1] !== '/' && text[i + 1] !== '*') {
      if (!prevTokenIsOperand(text, i)) {
        const close = findRegexClose(text, i);
        if (close >= 0) {
          out.push(repl(text.slice(i, close + 1)));
          i = close + 1;
          continue;
        }
      }
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
  const scanned = stripStringsAndBlockComments(text);
  // issue #98 失明防护：preload.js 含正则字面量（如 /[&<>"']/g）。若剥离器
  // 失明复发（正则内引号当字符串起始，吞掉后续代码），非空格字符保留率会
  // 断崖下跌、真实 function 声明被成批吞掉（曾实测 77.2% 涂白 / 19 个被吞）。
  // 硬性断言防回归——失明 = 放行走私。正常基线：保留率 ~29%（字符串/注释/
  // 正则天然占 70%），function 仅字符串字面量内的文本被涂（0 个真实声明）。
  // 阈值 23% 相对基线留 6pp 余量（失明基线 22.8%，fn 吞没断言是主哨兵）。
  if (file === 'preload.js') {
    const ns0 = (text.match(/[^\s]/g) || []).length;
    const ns1 = (scanned.match(/[^\s]/g) || []).length;
    const ratio = ns0 > 0 ? ns1 / ns0 : 1;
    const fn0 = (text.match(/function\b/g) || []).length;
    const fn1 = (scanned.match(/function\b/g) || []).length;
    if (ratio < 0.23 || fn0 - fn1 > 5) {
      failed++;
      const why = ratio < 0.23
        ? `剥离保留率 ${(ratio * 100).toFixed(1)}%（阈值 23%）`
        : `function 被吞 ${fn0 - fn1} 个（阈值 5）`;
      console.error(`[check-syntax] FAIL preload.js（${why}，疑似剥离器失明）`);
      continue;
    }
  }
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
