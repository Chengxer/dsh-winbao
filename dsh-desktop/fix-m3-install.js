// 修正 M3 主题安装 - 确保初始化函数被正确调用
const fs = require('fs');
const path = require('path');

const installPath = 'D:\\app\\dsh\\DSH Desktop\\resources\\app';
const devPath = 'c:\\Users\\delinger\\Desktop\\dsh\\dsh-desktop';

console.log('=== 修正 M3 主题安装 ===\n');

// 读取备份的原始 preload.js
const originalPreload = fs.readFileSync(path.join(installPath, 'preload.js.bak'), 'utf-8');

// 读取开发目录 preload.js 中的 M3 部分（从 "M3 (Material Design 3) 主题系统" 开始到末尾）
const devPreload = fs.readFileSync(path.join(devPath, 'preload.js'), 'utf-8');
const m3StartIndex = devPreload.indexOf('// M3 (Material Design 3) 主题系统');
const m3Code = devPreload.slice(m3StartIndex);

// 组合：原始代码 + M3 代码
const combined = originalPreload + '\n\n' + m3Code;
fs.writeFileSync(path.join(installPath, 'preload.js'), combined, 'utf-8');

console.log('[1/2] 已重新写入 preload.js（使用开发版本的 M3 代码）');

// 验证
const finalContent = fs.readFileSync(path.join(installPath, 'preload.js'), 'utf-8');
const hasM3 = finalContent.includes('m3InitTheme');
const hasAutoInit = finalContent.includes("m3InitTheme()");
console.log('[2/2] 验证:');
console.log('       包含 m3InitTheme 函数:', hasM3 ? '是 ✓' : '否 ✗');
console.log('       包含自动初始化调用:', hasAutoInit ? '是 ✓' : '否 ✗');
console.log('       文件大小:', Math.round(finalContent.length / 1024, 1), 'KB');

console.log('\n=== 修正完成 ===');
console.log('请重启 DSH Desktop 客户端即可使用 M3 主题。');
