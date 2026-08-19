'use strict';

// ---------------------------------------------------------------------------
// plugin-core 静态高危扫描（scan）：只读静态木马模式扫描，绝不 require/执行
// 插件代码。plugin-guard 的体检与插件更新门禁共用本实现（消除复制漂移）。
//
// 模式面向「装完即失控」的常见木马形态，刻意保守以压低误报；命中只报告，
// 处置（确认/拒绝）由调用方决定（更新门禁=确认后继续/拒绝；体检=展示）。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

const TROJAN_PATTERNS = [
  { code: 'TROJAN_REMOTE_EXEC', re: /(?:child_process|execSync|spawnSync|exec|spawn)\s*\(\s*['"`](?:curl|wget|powershell|cmd|bash|sh)\b[^'"`]*['"`][\s\S]{0,200}(?:\|\s*(?:sh|bash|iex|Invoke-Expression)|-enc\b)/i },
  { code: 'TROJAN_DOWNLOAD_EXEC', re: /(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr)\b[\s\S]{0,160}?(?:\|\s*(?:sh|bash|iex|Invoke-Expression)\b|Out-File[\s\S]{0,80}\.(?:ps1|bat|cmd|vbs))/i },
  { code: 'TROJAN_BASE64_EVAL', re: /(?:eval|Function)\s*\(\s*(?:atob|Buffer\.from\([^)]*,\s*['"]base64['"]\)|window\.atob)\s*\(/i },
  { code: 'TROJAN_PERSISTENCE', re: /(?:reg(?:\.exe)?\s+add[\s\S]{0,120}(?:Run|RunOnce)|Startup[\\/][\w.-]+\.(?:bat|cmd|ps1|vbs|lnk)|schtasks\s+\/create|Register-ScheduledTask)/i },
  { code: 'TROJAN_EXFIL_ENV', re: /(?:process\.env|os\.env)[\s\S]{0,120}(?:https?:\/\/|fetch\s*\(|XMLHttpRequest|net\.connect|dgram)/i },
];

const SCAN_MAX_FILE_BYTES = 2 * 1024 * 1024;   // 单文件扫描上限 2MB
const SCAN_MAX_TOTAL_BYTES = 32 * 1024 * 1024; // 单包总扫描上限 32MB
const SCAN_EXTS = /\.(c?js|mjs|cjs|json|yml|yaml|sh|ps1|bat|cmd)$/i;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/**
 * 扫描一个目录树（包目录或 node_modules 根）。
 * @param {Object} opts
 * @param {string} opts.root            扫描根目录
 * @param {Set<string>} [opts.builtinNames] 内置分发包名集合（命中即跳过整个包）
 * @param {number} [opts.maxDepth]      目录深度上限（默认 4）
 * @param {number} [opts.maxFindings]   发现数上限（默认 20）
 * @param {string} [opts.labelOf]       相对路径展示函数（默认相对 root）
 * @param {boolean} [opts.skipDotDirs]  跳过 .pnpm 与点开头目录（默认 true）
 * @returns {Array<{code:string, severity:'high', message:string, file:string}>}
 */
function scanDir(opts) {
  const {
    root,
    builtinNames = new Set(),
    maxDepth = 4,
    maxFindings = 20,
    labelOf = (p) => path.relative(root, p),
    skipDotDirs = true,
  } = opts;
  const findings = [];
  let total = 0;
  const walk = (d, depth) => {
    if (depth > maxDepth || total > SCAN_MAX_TOTAL_BYTES || findings.length >= maxFindings) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skipDotDirs && (e.name === '.pnpm' || e.name.startsWith('.'))) continue;
      if (findings.length >= maxFindings) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        const pkg = readJson(path.join(p, 'package.json'), null);
        if (pkg && pkg.name && builtinNames.has(pkg.name)) continue; // 内置分发包不扫
        walk(p, depth + 1);
      } else if (e.isFile() && SCAN_EXTS.test(e.name)) {
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.size > SCAN_MAX_FILE_BYTES || total + st.size > SCAN_MAX_TOTAL_BYTES) continue;
        total += st.size;
        let text;
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        for (const { code, re } of TROJAN_PATTERNS) {
          if (re.test(text)) {
            findings.push({
              code,
              severity: 'high',
              message: `静态扫描命中高危模式（${code}）：${labelOf(p)}`,
              file: p,
            });
            break; // 每文件只报首个模式
          }
        }
      }
    }
  };
  walk(root, 0);
  return findings;
}

module.exports = {
  TROJAN_PATTERNS,
  SCAN_MAX_FILE_BYTES,
  SCAN_MAX_TOTAL_BYTES,
  SCAN_EXTS,
  scanDir,
};
