'use strict';

// pi-ai opencode-go 模型目录补丁：补上 deepseek-v4-flash-vision-exp。
//
// 问题：设置页「模型」对 opencode-go 源「获取可用模型」拿不到
// DeepSeek V4 Flash Vision Exp（deepseek-v4-flash-vision-exp）。数据链是
// dsh-client-ui-settings-models → llm.discoverModels → dsh-llm-pi-ai 的
// discovery（lib/index.js discoverModels）：对 pi-ai 内置 catalog 已收录的
// provider（opencode-go 是其一），它直接以内置 catalog 作答、根本不访问
// 端点。而 pi-ai 的 catalog（dist/providers/data/opencode-go.json，由上游
// scripts/generate-models.ts 自动生成）落后于端点：线上
// https://opencode.ai/zen/go/v1/models 实际返回 deepseek-v4-flash-vision-exp，
// 内置 catalog 没有 → 获取列表与模型选择器（listModels 同样合并内置
// catalog）都看不到该型号。deepseek-official 源不受影响（dsh-llm-deepseek
// 的 DEFAULT_MODELS 已含该型号）。
//
// 修复（幂等、纯数据补充、锚点失配绝不损坏文件）：向 opencode-go.json 的
// openai-completions 分组克隆同族基型 deepseek-v4-flash 条目，仅改
// id / name / input（text+image）。容量、计费、compat、thinkingLevelMap 沿用
// 基型——与 dsh-llm-deepseek 官方 catalog 对 vision-exp 的登记方式一致（同
// contextWindow，仅追加 image 输入）。上游 pi-ai 重新生成 catalog 收录该
// 型号后，本补丁经「已存在即跳过」自然退役。
//
// 已知未一并补齐（有意）：端点还有 glm-5.3 / qwen3.8-max / mimo-v2-omni 等
// catalog 缺失型号，但 /models 列表不含容量与计费，凭空编造会污染路由决策；
// 这些型号请在设置页手工录入（模型目录编辑器）。本补丁只补可从同族基型
// 安全推导的 vision-exp。
//
// 用法：
//   node scripts/patch-pi-ai-opencode-go-models.js [<node_modules 根目录>]
// 同时导出 patchPiAiOpencodeGoModels(nmRoot, log, stats, options) 供
// patch-registry（桌面壳启动 / CLI 同步）与 patch-deps（postinstall dev
// node_modules）复用。

const fs = require('node:fs');
const path = require('node:path');
// 原子写与 main.js / 其它补丁脚本共用同一实现（scripts/lib/patch-io.js）。
const { writeFileAtomic } = require('./lib/patch-io');

/** 要补的型号（与端点 /models 及 dsh-llm-deepseek 官方目录同名 id）。 */
const MODEL_ID = 'deepseek-v4-flash-vision-exp';
/** 展示名（对齐 opencode-go.json 内空格命名惯例，如 "DeepSeek V4 Flash"）。 */
const MODEL_NAME = 'DeepSeek V4 Flash Vision Exp';
/** 克隆基型：同族非 vision 型号，容量/计费/compat 与 vision-exp 一致。 */
const BASE_MODEL_ID = 'deepseek-v4-flash';
/** pi-ai 目录文件相对 node_modules 根的路径（上游 generate-models 产物）。 */
const CATALOG_REL = path.join('@earendil-works', 'pi-ai', 'dist', 'providers', 'data', 'opencode-go.json');

/**
 * 计算目录 JSON 的新文本。
 * @param {string} src 原文件内容
 * @returns {{status:'present'}|{status:'changed', src:string}|{status:'invalid-json'}|{status:'anchor-missing'}}
 *   present=型号已在（上游已收录，补丁退役）；changed=需写入新文本；
 *   invalid-json=文件不是合法 JSON（不动它）；anchor-missing=结构变化（缺
 *   openai-completions 分组或基型条目），按版本漂移跳过。
 */
function transformCatalog(src) {
  let data;
  try {
    data = JSON.parse(src);
  } catch {
    return { status: 'invalid-json' };
  }
  const group = data?.['openai-completions'];
  if (group === null || typeof group !== 'object' || Array.isArray(group)) {
    return { status: 'anchor-missing' };
  }
  if (Object.prototype.hasOwnProperty.call(group, MODEL_ID)) return { status: 'present' };
  const base = group[BASE_MODEL_ID];
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    return { status: 'anchor-missing' };
  }
  group[MODEL_ID] = {
    ...JSON.parse(JSON.stringify(base)),
    id: MODEL_ID,
    name: MODEL_NAME,
    input: ['text', 'image'],
  };
  // 与原文件一致：紧凑 JSON + 单个尾换行。
  return { status: 'changed', src: JSON.stringify(data) + '\n' };
}

/**
 * 对某个 node_modules 根目录应用 opencode-go 模型目录补丁（幂等）。
 * @param {string} nmRoot node_modules 根目录
 * @param {(msg: string) => void} [log]
 * @param {{anchorMissing?: number, failed?: number}} [stats] 可选计数器（与
 *   patch-runner 的 patchReport 口径对齐：锚点失配 / 读写失败各计一次）。
 * @param {{dryRun?: boolean}} [options]
 * @returns {number} 实际发生修改的文件数
 */
function patchPiAiOpencodeGoModels(nmRoot, log = () => {}, stats, options) {
  const file = path.join(nmRoot, CATALOG_REL);
  if (!fs.existsSync(file)) return 0; // 该根未装 pi-ai（如 profile 副本），静默跳过
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log('opencode-go 模型目录补丁: 读取失败 ' + file + ': ' + err.message);
    if (stats) stats.failed += 1;
    return 0;
  }
  const result = transformCatalog(src);
  if (result.status === 'present') {
    log('opencode-go 模型目录补丁: 目录已含 ' + MODEL_ID + '（上游已收录），跳过 ' + file);
    return 0;
  }
  if (result.status === 'invalid-json' || result.status === 'anchor-missing') {
    log('opencode-go 模型目录补丁: 锚点未匹配（pi-ai 版本可能已变化），跳过 ' + file);
    if (stats) stats.anchorMissing += 1;
    return 0;
  }
  try {
    if (options && options.dryRun) {
      log('opencode-go 模型目录补丁: dry-run: 将补入 ' + MODEL_ID + ' ' + file);
    } else {
      writeFileAtomic(file, result.src);
      log('opencode-go 模型目录补丁: 已补入 ' + MODEL_ID + ' ' + file);
      return 1;
    }
  } catch (err) {
    log('opencode-go 模型目录补丁: 写入失败 ' + file + ': ' + err.message);
    if (stats) stats.failed += 1;
  }
  return 0;
}

module.exports = { patchPiAiOpencodeGoModels, transformCatalog, MODEL_ID, BASE_MODEL_ID, CATALOG_REL };

if (require.main === module) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'node_modules');
  const n = patchPiAiOpencodeGoModels(root, (m) => console.log(m));
  console.log(n > 0 ? `patched ${n} file(s) — restart DSH Desktop to pick it up` : 'nothing to patch (already up to date)');
}
