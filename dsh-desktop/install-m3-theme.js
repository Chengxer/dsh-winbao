// 安装 M3 主题到已安装的 DSH Desktop 客户端
const fs = require('fs');
const path = require('path');

const installPath = 'D:\\app\\dsh\\DSH Desktop\\resources\\app';
const devPath = 'c:\\Users\\delinger\\Desktop\\dsh\\dsh-desktop';

console.log('=== DSH M3 主题安装器 ===\n');

// 1. 检查安装目录
if (!fs.existsSync(path.join(installPath, 'preload.js'))) {
  console.error('[错误] 未找到 DSH Desktop 安装目录:', installPath);
  process.exit(1);
}
console.log('[1/4] 找到安装目录:', installPath);

// 2. 备份原始 preload.js
const backupPath = path.join(installPath, 'preload.js.bak');
if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(path.join(installPath, 'preload.js'), backupPath);
  console.log('[2/4] 已备份原始 preload.js → preload.js.bak');
} else {
  console.log('[2/4] 备份已存在，跳过备份');
}

// 3. 读取开发目录的 preload.js 并写入安装目录
// 注意：安装目录的 preload.js 版本可能不同，我们基于安装目录的原始版本追加 M3 代码
const originalPreload = fs.readFileSync(backupPath, 'utf-8');
const m3Code = fs.readFileSync(path.join(devPath, 'assets', 'themes', 'm3-theme-manager.js'), 'utf-8');

// 组合：原始代码 + M3 代码
const combined = originalPreload + '\n\n' + m3Code;
fs.writeFileSync(path.join(installPath, 'preload.js'), combined, 'utf-8');
console.log('[3/4] 已写入 preload.js（含 M3 主题注入）');

// 4. 复制主题文件到安装目录
const themesDir = path.join(installPath, 'assets', 'themes');
if (!fs.existsSync(themesDir)) {
  fs.mkdirSync(themesDir, { recursive: true });
}

const themeFiles = ['m3-theme.css', 'm3-theme-manager.js', 'm3-preview.html'];
for (const f of themeFiles) {
  const src = path.join(devPath, 'assets', 'themes', f);
  const dst = path.join(themesDir, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  }
}
console.log('[4/4] 已复制主题文件到 assets/themes/');

console.log('\n=== 安装完成 ===');
console.log('请重启 DSH Desktop 客户端，然后在 设置 → 外观 中点击 M3 按钮切换主题。');
console.log('卸载：将 preload.js.bak 重命名回 preload.js 即可恢复。');
