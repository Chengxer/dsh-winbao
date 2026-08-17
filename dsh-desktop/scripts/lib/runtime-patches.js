'use strict';

// ---------------------------------------------------------------------------
// 运行时补丁定义（唯一实现）。
//
// 「会话列表刷新闪跳修复」（dsh-client-runtime）与「设置暴露白名单补丁」
// （dsh-host-apiproxy）曾同时存在于 main.js（applyRuntimeFlashFix /
// applyPromptExposeFix）与 scripts/sync-companion-plugins.js
// （applyRuntimePatches，--with-patches）两处，是同一份补丁的第三次复制。
// 这里把锚点常量、变换与 WSL / CLI 共用的目标路径收口为唯一数据源，两个
// 入口只保留各自的候选路径选择与日志文案，杜绝漂移。
//
// 变换均为纯函数，字节级输出与旧实现一致；锚点失配时绝不改写文件内容。
// ---------------------------------------------------------------------------

const path = require('node:path');

/** dsh-client-runtime 会话列表刷新闪跳修复（mergeOrderedBaseline 保留本地新会话）。 */
const FLASH_OLD = '(value) => baselineByKey.get(keyOf(value))).filter((value) => value !== void 0);';
const FLASH_NEW = '(value) => baselineByKey.get(keyOf(value)) ?? value).filter((value) => value !== void 0);';

/** 设置暴露白名单（dsh-prompt / 第三方思考 / 识图 / 会话调整）。 */
const SETTINGS_NAMESPACES = ['dsh-prompt', 'dsh-third-party-thinking', 'dsh-vision', 'dsh-conversation-tweaks'];

/** 各补丁目标包内的相对路径（@deepseek-ai/<rel>）。 */
const FLASH_PKG_REL = path.join('dsh-client-runtime', 'lib', 'client.js');
const EXPOSE_PKG_REL = path.join('dsh-host-apiproxy', 'lib', 'index.js');

/**
 * WSL 托管模式 / sync CLI 共用目标：profile fallback + agent 两份副本。
 * bundle 初始化后的 dsh 安装（npm 版）两份副本通常互为同一文件（fallback
 * 符号链接写穿），逐文件幂等判定保证重复目标安全。
 * @param {string} home 目标 dsh 数据目录（WSL 模式为 UNC 等价路径）
 * @param {string} pkgRel @deepseek-ai/<pkgRel>
 * @returns {string[]}
 */
function patchTargets(home, pkgRel) {
  const mk = (root) => path.join(root, 'node_modules', '@deepseek-ai', pkgRel);
  return [
    mk(path.join(home, 'profiles')),
    mk(path.join(home, 'agent')),
  ];
}

// ---------------------------------------------------------------------------
// 运行时补丁候选路径构造（纯函数：路径根由调用方传入，便于单测；main.js 绑定
// 模块级变量）。三种布局与旧实现逐项一致，并补齐同系列补丁的历史覆盖缺口：
//   - localCopyFiles         本地模式三副本（profile fallback → 内置副本 → 更新 overlay）；
//   - guardCopyFiles         防护类补丁四副本（内置副本优先 + overlay 嵌套 dsh
//                            依赖副本 + profile fallback）；
//   - localNodeModulesRoots  包级补丁的 node_modules 根目录列表（extraRoots 用于
//                            WSL 模式追加 WSL agent 直连根，与 patchTargets 的
//                            agent 兜底语义一致）。
// ---------------------------------------------------------------------------

function localCopyFiles(home, appDir, userDataDir, pkgRel) {
  return [
    path.join(home, 'profiles', 'node_modules', '@deepseek-ai', pkgRel),
    path.join(appDir, 'node_modules', '@deepseek-ai', pkgRel),
    path.join(userDataDir, 'agent', 'node_modules', '@deepseek-ai', pkgRel),
  ];
}

function guardCopyFiles(home, appDir, userDataDir, pkgRel) {
  return [
    path.join(appDir, 'node_modules', '@deepseek-ai', pkgRel),
    path.join(userDataDir, 'agent', 'node_modules', '@deepseek-ai', pkgRel),
    path.join(userDataDir, 'agent', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', pkgRel),
    path.join(home, 'profiles', 'node_modules', '@deepseek-ai', pkgRel),
  ];
}

function localNodeModulesRoots(home, appDir, userDataDir, extraRoots = []) {
  return [
    path.join(home, 'profiles', 'node_modules'),
    path.join(appDir, 'node_modules'),
    path.join(userDataDir, 'agent', 'node_modules'),
    ...extraRoots,
  ];
}

/**
 * 闪跳修复变换（纯函数）。锚点失配的 detail 含文件路径，与两个调用方
 * （main.js / 同步脚本）的旧日志文案逐字一致。
 * @returns {{status:'already'} | {status:'anchor-missing', detail: string} | {status:'changed', src: string}}
 */
function transformFlashFix(src, file) {
  if (src.includes(FLASH_NEW)) return { status: 'already' };
  if (!src.includes(FLASH_OLD)) {
    return { status: 'anchor-missing', detail: '未匹配到目标代码（版本可能已变更），跳过 ' + file };
  }
  return { status: 'changed', src: src.replace(FLASH_OLD, FLASH_NEW) };
}

/**
 * 设置暴露白名单变换（纯函数）。只认声明之后最近的 `];`，避免插进文件里
 * 其它数组；缺失的命名空间以与旧实现逐字节一致的格式追加。原数组以尾逗号
 * 收尾（`"x",\n];`）时不重复前导逗号——历史实现无条件前置 `,\n`，遇到带
 * 尾逗号的文件会生成 `,\n,` 双逗号语法错误。
 * @returns {{status:'already'} | {status:'anchor-missing', detail: string} | {status:'changed', src: string, note: string[]}}
 */
function transformExposeFix(src, file) {
  const declIdx = src.indexOf('const WEB_SETTINGS_NAMESPACES = [');
  if (declIdx === -1) {
    return { status: 'anchor-missing', detail: '未找到 WEB_SETTINGS_NAMESPACES（版本可能已变更），跳过 ' + file };
  }
  const closeIdx = src.indexOf('];', declIdx);
  if (closeIdx === -1) {
    return { status: 'anchor-missing', detail: '未匹配到命名空间数组收尾，跳过 ' + file };
  }
  const arrText = src.slice(declIdx, closeIdx);
  const missing = SETTINGS_NAMESPACES.filter((ns) => !arrText.includes('"' + ns + '"'));
  if (missing.length === 0) return { status: 'already' };
  const hasTrailingComma = /,\s*$/.test(arrText);
  const block = (hasTrailingComma ? '\n' : ',\n') + missing.map((ns) => '\t"' + ns + '"').join(',\n') + '\n';
  return { status: 'changed', src: src.slice(0, closeIdx) + block + src.slice(closeIdx), note: missing };
}

// ---------------------------------------------------------------------------
// 模型工具兼容补丁（问题背景：code 模式的 run_code 程序经常省略 shell 工具
// 的 `description`，而该字段只用于 UI/日志展示，不应让整个工具调用失败）。
// 变换：validateBashArgs / validatePwshArgs 在缺省时用 command 首行自动补值。
// 曾同时改 schema 的 description.required: true → false，但引擎 schema 校验器
// 拒绝（"unsupported JSON schema: parameters.description.required must be true
// when present"）→ 该部分已废弃，transform 会自动回滚已写入的 false。
// 幂等标记 = dsh-desktop compat: optional shell description。
// ---------------------------------------------------------------------------

const SHELL_DESC_MARKER = "dsh-desktop compat: optional shell description";
const SHELL_DESC_VALIDATE_OLD = "\tif (args.description.trim().length === 0) throw new Error(\"invalid description: expected a non-empty string\");";
const SHELL_DESC_VALIDATE_NEW = "\tif (typeof args.description !== \"string\" || args.description.trim().length === 0) {\n\t\t// " + SHELL_DESC_MARKER + ": description is only for UI/log; derive one when the model omits it.\n\t\targs.description = args.command.trim().split(/\\r?\\n/)[0].slice(0, 80) || \"Run shell command\";\n\t}";
const SHELL_DESC_SCHEMA_OLD = "\t\t\tdescription: {\n\t\t\t\ttype: \"string\",\n\t\t\t\trequired: true,\n\t\t\t\tdescription: \"Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples:";
// 已废弃：仅作旧补丁回滚识别锚点（引擎 schema 校验器拒绝 required: false）。
const SHELL_DESC_SCHEMA_NEW = "\t\t\tdescription: {\n\t\t\t\ttype: \"string\",\n\t\t\t\trequired: false, // " + SHELL_DESC_MARKER + "\n\t\t\t\tdescription: \"Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples:";

const PW_REL = path.join("dsh-tool-pwsh", "lib", "index.js");
const BASH_REL = path.join("dsh-tool-bash", "lib", "index.js");

/** shell 工具 description 兜底变换（pwsh/bash 共用，锚点逐字节一致）。
 *  只改 validate 校验（缺省时用 command 首行补值）；schema 的
 *  required: false 已被引擎拒绝（必须 true），旧补丁若已写入会自动回滚。 */
function transformShellDescriptionOptional(src, file) {
  let reverted = false;
  if (src.includes(SHELL_DESC_SCHEMA_NEW)) {
    src = src.replace(SHELL_DESC_SCHEMA_NEW, SHELL_DESC_SCHEMA_OLD);
    reverted = true;
  }
  if (src.includes(SHELL_DESC_MARKER)) {
    return reverted ? { status: "changed", src, note: "已回滚 schema required: false" } : { status: "already" };
  }
  if (!src.includes(SHELL_DESC_VALIDATE_OLD)) {
    return { status: "anchor-missing", detail: "未找到 shell description 锚点（版本可能已变更），跳过 " + file };
  }
  return { status: "changed", src: src.replace(SHELL_DESC_VALIDATE_OLD, SHELL_DESC_VALIDATE_NEW), note: reverted ? "已回滚 schema required: false" : undefined };
}

const CODE_MODE_MARKER = 'dsh-desktop compat: direct tools alongside run_code';
const CODE_MODE_OLD = `- id: tool-presentation
  name: '@deepseek-ai/dsh-agent-tool-presentation'
  config:
    mode: code`;
const CODE_MODE_NEW = `- id: tool-presentation
  name: '@deepseek-ai/dsh-agent-tool-presentation'
  config:
    # ${CODE_MODE_MARKER}
    mode: both`;

const CODE_PRESET_REL = path.join('dsh', 'config', 'agent-presets', 'code', 'agent.cordis.yml');

/** code preset `mode: code` → `mode: both` 变换（幂等，锚点失配跳过）。 */
// ---------------------------------------------------------------------------
// 图片字节信任补丁（问题背景：浏览器声明的 MIME 跟随文件扩展名，不可信——
// webp/jpeg 改名 .png 后 file.type 仍是 image/png，而字节解码为 webp，官方
// 严格比对 declared !== detected 直接拒发整条消息，用户看到「仅支持 PNG、JPG、
// WebP、GIF」却发不出去）。decoded 字节才是权威：声明为 image/* 时以字节
// 实际格式为准记录，不再拒绝发送。
// 幂等标记 = dsh-desktop compat: trust decoded image bytes。
// ---------------------------------------------------------------------------

const ATTACH_MIME_MARKER = "dsh-desktop compat: trust decoded image bytes";
const ATTACH_MIME_OLD = '\tif (detected.mediaType !== declaredMediaType) throw new AttachmentError("Declared image type does not match its bytes.", "IMAGE_TYPE_MISMATCH");';
const ATTACH_MIME_NEW = '\t// ' + ATTACH_MIME_MARKER + '. The browser-declared MIME follows the file extension and is\n\t// untrusted (a webp/jpeg renamed to .png arrives as image/png while the bytes decode as\n\t// webp); the decoded bytes are authoritative, so record the detected type instead of\n\t// rejecting the whole send.\n\tif (detected.mediaType !== declaredMediaType && typeof declaredMediaType === "string" && declaredMediaType.startsWith("image/")) declaredMediaType = detected.mediaType;';

const ATTACH_LOCAL_REL = path.join("dsh-attachment-local", "lib", "index.js");

/** attachment-local 图片字节信任变换（幂等，锚点失配跳过）。 */
function transformAttachmentMimeTrust(src, file) {
  if (src.includes(ATTACH_MIME_MARKER)) return { status: "already" };
  if (!src.includes(ATTACH_MIME_OLD)) {
    return { status: "anchor-missing", detail: "未找到 attachment-local MIME 校验锚点（版本可能已变更），跳过 " + file };
  }
  return { status: "changed", src: src.replace(ATTACH_MIME_OLD, ATTACH_MIME_NEW) };
}
function transformCodeModeCompat(src, file) {
  if (src.includes(CODE_MODE_MARKER)) return { status: 'already' };
  if (!src.includes(CODE_MODE_OLD)) {
    return { status: 'anchor-missing', detail: '未找到 code preset 的 tool-presentation 锚点（版本可能已变更），跳过 ' + file };
  }
  return { status: 'changed', src: src.replace(CODE_MODE_OLD, CODE_MODE_NEW) };
}

module.exports = {
  FLASH_OLD,
  FLASH_NEW,
  SETTINGS_NAMESPACES,
  FLASH_PKG_REL,
  EXPOSE_PKG_REL,
  patchTargets,
  localCopyFiles,
  guardCopyFiles,
  localNodeModulesRoots,
  transformFlashFix,
  transformExposeFix,
  SHELL_DESC_MARKER,
  SHELL_DESC_VALIDATE_OLD,
  SHELL_DESC_VALIDATE_NEW,
  SHELL_DESC_SCHEMA_OLD,
  SHELL_DESC_SCHEMA_NEW,
  PW_REL,
  BASH_REL,
  transformShellDescriptionOptional,
  CODE_MODE_MARKER,
  CODE_MODE_OLD,
  CODE_MODE_NEW,
  CODE_PRESET_REL,
  transformCodeModeCompat,
  ATTACH_MIME_MARKER,
  ATTACH_MIME_OLD,
  ATTACH_MIME_NEW,
  ATTACH_LOCAL_REL,
  transformAttachmentMimeTrust,
};
