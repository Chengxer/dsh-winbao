'use strict';

// ---------------------------------------------------------------------------
// 补丁适配器（唯一 transform 收口）。
//
// 所有运行时补丁的「变换」纯函数都从这里取用：
//   - runtime-patches.js 的 9 个 transform 原样 re-export（变换实现仍留在该
//     模块，锚点常量/注入代码字节级不变）；
//   - 原 main.js 内联的 6 个 transform（image-send / vision-key /
//     profile-patch-guard / settings-section-guard / workspace-search-rail /
//     plugin-inventory-tab-merge）在此声明化，字节级输出与旧实现一致；
//   - profile-bundle-guard 的两个 transform（app-boot / profile-boot）委托
//     profile-bundle-heal.js 的唯一实现；
//   - 包级补丁（web-search / menu-viewport / session-manage /
//     open-project-dir / session-persistence）以「node_modules 根应用器」形态
//     收口，patch-runner 直接调用，不复制其锚点逻辑。
//
// 本模块不读写文件（除 rootAppliers 委托的 patch-*.js 外），纯声明。
// ---------------------------------------------------------------------------

const {
  transformFlashFix,
  transformExposeFix,
  transformPersistenceAll,
  transformLegacySlotKey,
  transformSlotUnkeyedCompat,
  transformSlotErrorIsolation,
  transformShellDescriptionOptional,
  transformCodeModeCompat,
  transformAttachmentMimeTrust,
  SLOT_KEY_COMPAT_MARKER,
  SLOT_UNKEYED_COMPAT_MARKER,
  SLOT_ERROR_ISOLATE_MARKER,
  SLOT_ERROR_ISOLATE_MARKER_V2,
} = require('./runtime-patches');

const {
  PROFILE_BUNDLE_GUARD_MARKER,
  PROFILE_BOOT_GUARD_MARKER,
  applyAppBootBundleGuard,
  applyProfileBootHealGuard,
  applyProfileBootBundleGuard,
} = require('../../profile-bundle-heal');

// 包级补丁（node_modules 根应用器，唯一实现；签名 (nmRoot, log) => number）。
const { patchWebSearchBaseUrl } = require('../patch-web-search-baseurl');
const { patchMenuViewport } = require('../patch-menu-viewport');
const { patchSessionManage } = require('../patch-session-manage');
const { patchOpenProjectDir } = require('../patch-open-project-dir');
const { patchSessionPersistence } = require('../patch-session-persistence');
const { patchToolSourceCompat } = require('./tool-source-patch');
// 会话孤儿进程清理（C2：session-manage 注入区扩展，deleteSession 后杀子进程树）。
const { patchSessionOrphans } = require('./patch-session-orphans');
// pi-ai opencode-go 模型目录补丁（opencode-go.json 纯数据补充）。
const { patchPiAiOpencodeGoModels } = require('../patch-pi-ai-opencode-go-models');
// pi-ai 余额判定前置补丁（F2：第三方 provider 欠费 401+CreditsError 误判 AUTH
// →「API key is invalid」；此前仅 postinstall 应用，node_modules 刷新即丢，v0.5.3
// payload 实测缺失，补进 boot 期注册表幂等自愈）。
const { patchPiAiCredits } = require('../patch-pi-ai-credits');
// pi-ai 手声明路由思考档位默认（F4：v0.5.3「第三方思考强度不生效」——自定义
// 供应商模型条目无 reasoningEfforts 字典时 pi-ai 回落 reasoning:false，控件
// 永不出现；手声明条目回落标准 OpenAI 档位字典，开箱即用且未选档位不发字段）。
const { patchPiAiReasoningDefaults } = require('../patch-pi-ai-reasoning-defaults');
// 设置写入韧性（PR5：v0.5.2「添加供应商没反应/灰」两层根治——孤儿锁自愈 +
// 设置页命名空间自愈 + settings-conflict 静默重试）。
const {
  patchAtomicWriteOrphanLock,
  patchSettingsModelsResilience,
} = require('./patch-settings-write-resilience');
// 插件 client bundle 到达瞬态失败重试（E2/问题A：bundle script ... failed to
// load 单次 404/换内核即永久失败——浏览器半边 script 重试 + serveBundle 读盘
// 瞬态码短重试）。
const { patchBundleArrivalRetry } = require('./bundle-arrival-retry-patch');
// 工具调度器缺席防崩（E2/问题B：reading 'prepare'——agent-loop 跨副本解析守卫 +
// dsh-tools Symbol.for 全局镜像）。
const { patchSchedulerGuard } = require('./scheduler-guard-patch');

// ---------------------------------------------------------------------------
// 文本模型自动识图补丁（原 main.js applyImageSendFix 内联 transform）。
// ---------------------------------------------------------------------------
const IMAGE_SEND_MARKER = 'DSH Desktop: reuse the dsh-vision VLM config';
const IMAGE_SEND_HELPER_ANCHOR = '/** Validate one prompt as a batch before publishing any durable image object. */';
const IMAGE_SEND_HELPER = `
/** DSH Desktop: reuse the dsh-vision VLM config to describe images as text so text-only models can "see" them. */
async function describeImagesWithVision(ctx, content) {
	const settings = ctx.get("settings");
	let vision = null;
	if (settings !== void 0 && typeof settings.get === "function") {
		// dsh-desktop fix: read the resolved HOST-side value (settings.get), not the
		// redacted wire snapshot. redactSecrets strips role('secret') fields, so
		// describe({redactSecrets:true}) drops apiKey and every keyed VLM endpoint
		// answers 401 — image sends failed for configured users.
		const resolved = settings.get("dsh-vision");
		if (resolved !== void 0 && typeof resolved === "object") vision = resolved;
	}
	if (vision === null && settings !== void 0 && typeof settings.describe === "function") {
		try {
			const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === "dsh-vision");
			if (descriptor !== void 0 && descriptor.value !== void 0 && typeof descriptor.value === "object") vision = descriptor.value;
		} catch {}
	}
	// DSH Desktop: dsh-vision master switch (enabled) — off means the user turned
	// the whole capability off in 设置 → 识图插件：skip conversion and flag the
	// throw so the gate below restores the upstream MODEL_DOES_NOT_SUPPORT_IMAGES
	// rejection (the exact pre-plugin behavior: images neither sent nor converted).
	if (vision !== null && vision.enabled === false) {
		const visionDisabled = new Error("dsh-vision disabled");
		visionDisabled.dshVisionDisabled = true;
		throw visionDisabled;
	}
	if (vision === null || typeof vision.baseURL !== "string" || vision.baseURL.trim() === "" || typeof vision.model !== "string" || vision.model.trim() === "") {
		throw new Error("未配置识图服务：请到 设置 → 识图插件（view_image） 填写 VLM 接口地址与模型");
	}
	const apiKey = typeof vision.apiKey === "string" ? vision.apiKey.trim() : "";
	const endpoint = vision.baseURL.replace(/\\/+$/, "") + "/chat/completions";
	const out = [];
	let imageNo = 0;
	for (const part of content) {
		if (part.type !== "image") {
			if (part.type === "text") out.push(part);
			continue;
		}
		imageNo += 1;
		const dataUrl = \`data:\${part.mediaType};base64,\${part.data}\`;
		const payload = {
			model: vision.model,
			stream: false,
			messages: [
				{ role: "system", content: "You are an image understanding assistant. Describe the image in exhaustive detail and transcribe every visible text (OCR). If it is a UI, document, table, chart or code, preserve its structure. Answer in Chinese unless the user's language clearly differs." },
				{ role: "user", content: [
					{ type: "text", text: "请把这张图片完整转述为文字：包含画面内容、结构与全部可见文字（逐字 OCR）。" },
					{ type: "image_url", image_url: { url: dataUrl } }
				] }
			]
		};
		const headers = { "content-type": "application/json" };
		if (apiKey !== "") headers.authorization = "Bearer " + apiKey;
		const response = await fetch(endpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(120000)
		});
		if (!response.ok) {
			const bodyText = await response.text().catch(() => "");
			throw new Error("识图服务返回 HTTP " + response.status + "：" + bodyText.slice(0, 400));
		}
		const data = await response.json();
		const description = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
		if (typeof description !== "string" || description.trim() === "") throw new Error("识图服务未返回有效文字描述");
		out.push({ type: "text", text: "[图片" + imageNo + "] " + description.trim() });
	}
	return out;
}
`;
const IMAGE_SEND_GATE_MARKER = 'if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) return err(request, {';
const IMAGE_SEND_GATE_NEW = `if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) {
								try {
									admittedContent = await describeImagesWithVision(ctx, content);
								} catch (error) {
									if (error && error.dshVisionDisabled === true) {
										return err(request, {
											code: 'attachment-error',
											message: \`Model "\${current.model}" does not support image input.\`,
											details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' }
										});
									}
									return err(request, {
										code: "attachment-error",
										message: \`图片自动转述失败：\${error instanceof Error ? error.message : String(error)}。请在 设置 → 识图插件（view_image） 配置 VLM 后重试。\`,
										details: { reason: "IMAGE_DESCRIPTION_FAILED" }
									});
								}
							}`;

function transformImageSendFix(src, file) {
  if (src.includes(IMAGE_SEND_MARKER)) return { status: 'already' };
  // 上游已原生内置同名 helper（新版 dsh）：不重复插入（重复定义会留下
  // 被后者遮蔽的死代码），只做门槛替换；其 apiKey 脱敏缺陷由
  // transformVisionKeyFix 就地修复。
  const nativeHelper = src.includes('async function describeImagesWithVision');
  if (!nativeHelper) {
    // 1) 插入转述 helper（此后所有索引必须基于插入后的 src 重新计算）
    const anchorIdx = src.indexOf(IMAGE_SEND_HELPER_ANCHOR);
    if (anchorIdx === -1) {
      return { status: 'anchor-missing', detail: '未找到 helper 插入锚点（版本可能已变更），跳过 ' + file };
    }
    src = src.slice(0, anchorIdx) + IMAGE_SEND_HELPER + '\n' + src.slice(anchorIdx);
  }
  // 2) prompt 入口：声明 admittedContent
  const hasImageIdx = src.indexOf('const hasImage = content.some((part) => part.type === "image");');
  if (hasImageIdx === -1) {
    return { status: 'anchor-missing', detail: '未找到 hasImage 入口（版本可能已变更），跳过 ' + file };
  }
  src = src.slice(0, hasImageIdx) + 'let admittedContent = content;\n\t\t\t\t' + src.slice(hasImageIdx);
  // 3) 把“模型不支持图片”的直接拒绝替换为自动转述
  const gateIdx = src.indexOf(IMAGE_SEND_GATE_MARKER);
  if (gateIdx === -1) {
    return { status: 'anchor-missing', detail: '未找到模型图片门槛（版本可能已变更），跳过 ' + file };
  }
  const gateEnd = src.indexOf('});', gateIdx);
  if (gateEnd === -1) {
    return { status: 'anchor-missing', detail: '图片门槛收尾异常，跳过 ' + file };
  }
  src = src.slice(0, gateIdx) + IMAGE_SEND_GATE_NEW + src.slice(gateEnd + 3);
  // 4) durablePromptContent 使用转述后的内容（从门槛之后查找调用点，避免命中函数定义）
  const callIdx = src.indexOf('durablePromptContent(ctx, content)', gateIdx);
  if (callIdx === -1) {
    return { status: 'anchor-missing', detail: '未找到 durablePromptContent 调用，跳过 ' + file };
  }
  src = src.slice(0, callIdx) + 'durablePromptContent(ctx, admittedContent)' + src.slice(callIdx + 'durablePromptContent(ctx, content)'.length);
  return { status: 'changed', src };
}

// ---------------------------------------------------------------------------
// 图片自动转述 apiKey 修复（原 main.js applyVisionKeyFix 内联 transform）。
// ---------------------------------------------------------------------------
const VISION_KEY_MARKER = 'dsh-desktop fix: read the resolved HOST-side value';
const VISION_KEY_FROM = '\tlet vision = null;\n\tif (settings !== void 0 && typeof settings.describe === "function") {\n\t\ttry {\n\t\t\tconst descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === "dsh-vision");\n\t\t\tif (descriptor !== void 0 && descriptor.value !== void 0 && typeof descriptor.value === "object") vision = descriptor.value;\n\t\t} catch {}\n\t}';
const VISION_KEY_TO = '\tlet vision = null;\n\tif (settings !== void 0 && typeof settings.get === "function") {\n\t\t// dsh-desktop fix: read the resolved HOST-side value (settings.get), not the\n\t\t// redacted wire snapshot. redactSecrets strips role(\'secret\') fields, so\n\t\t// describe({redactSecrets:true}) drops apiKey and every keyed VLM endpoint\n\t\t// answers 401 — image sends failed for configured users.\n\t\tconst resolved = settings.get("dsh-vision");\n\t\tif (resolved !== void 0 && typeof resolved === "object") vision = resolved;\n\t}\n\tif (vision === null && settings !== void 0 && typeof settings.describe === "function") {\n\t\ttry {\n\t\t\tconst descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === "dsh-vision");\n\t\t\tif (descriptor !== void 0 && descriptor.value !== void 0 && typeof descriptor.value === "object") vision = descriptor.value;\n\t\t} catch {}\n\t}';

function transformVisionKeyFix(src, file) {
  if (src.includes(VISION_KEY_MARKER)) return { status: 'already' };
  if (!src.includes(VISION_KEY_FROM)) {
    return { status: 'anchor-missing', detail: '锚点未匹配（版本可能已变化），跳过 ' + file };
  }
  return { status: 'changed', src: src.replace(VISION_KEY_FROM, VISION_KEY_TO) };
}

// ---------------------------------------------------------------------------
// 识图总开关（enabled）门槛增量补丁：image-send-fix 已应用的旧树上补挂
// 「dsh-vision 关闭 → 不转述、按上游原样拒绝」。IMAGE_SEND_MARKER 相同而
// 内容已升级，旧树永远走 already 分支拿不到新常量，因此按 vision-key-fix
// 的先例单列 transform 与 marker；两处锚点（helper 配置检查行 / gate 调用
// 行）在旧树与新树均存在，产物与新版 IMAGE_SEND_HELPER / IMAGE_SEND_GATE_NEW
// 直接生成的字节一致（新树靠 marker 短路 already，不会重复插入）。
// ---------------------------------------------------------------------------
const VISION_TOGGLE_MARKER = 'DSH Desktop: dsh-vision master switch (enabled)';
const VISION_TOGGLE_HELPER_ANCHOR = '\tif (vision === null || typeof vision.baseURL !== "string" || vision.baseURL.trim() === "" || typeof vision.model !== "string" || vision.model.trim() === "") {';
const VISION_TOGGLE_HELPER_CHECK = [
  '\t// DSH Desktop: dsh-vision master switch (enabled) — off means the user turned',
  '\t// the whole capability off in 设置 → 识图插件：skip conversion and flag the',
  '\t// throw so the gate below restores the upstream MODEL_DOES_NOT_SUPPORT_IMAGES',
  '\t// rejection (the exact pre-plugin behavior: images neither sent nor converted).',
  '\tif (vision !== null && vision.enabled === false) {',
  '\t\tconst visionDisabled = new Error("dsh-vision disabled");',
  '\t\tvisionDisabled.dshVisionDisabled = true;',
  '\t\tthrow visionDisabled;',
  '\t}',
  '',
].join('\n');
// 旧 gate 的 catch 头（含转述调用行作唯一性前缀，避免命中文件内其它 catch）。
const VISION_TOGGLE_GATE_FROM = '\t\t\t\t\t\t\t\t\tadmittedContent = await describeImagesWithVision(ctx, content);\n\t\t\t\t\t\t\t\t} catch (error) {\n\t\t\t\t\t\t\t\t\treturn err(request, {';
const VISION_TOGGLE_GATE_TO = [
  '\t\t\t\t\t\t\t\t\tadmittedContent = await describeImagesWithVision(ctx, content);',
  '\t\t\t\t\t\t\t\t} catch (error) {',
  '\t\t\t\t\t\t\t\t\tif (error && error.dshVisionDisabled === true) {',
  '\t\t\t\t\t\t\t\t\t\treturn err(request, {',
  "\t\t\t\t\t\t\t\t\t\t\tcode: 'attachment-error',",
  '\t\t\t\t\t\t\t\t\t\t\tmessage: `Model "${current.model}" does not support image input.`,',
  "\t\t\t\t\t\t\t\t\t\t\tdetails: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' }",
  '\t\t\t\t\t\t\t\t\t\t});',
  '\t\t\t\t\t\t\t\t\t}',
  '\t\t\t\t\t\t\t\t\treturn err(request, {',
].join('\n');

function transformVisionToggleGate(src, file) {
  if (src.includes(VISION_TOGGLE_MARKER)) return { status: 'already' };
  // helper 不存在 = image-send-fix 本身没打上（或上游原生内置 helper 且无该
  // 检查行）——本补丁无从谈起，按失配跳过。
  const helperIdx = src.indexOf(VISION_TOGGLE_HELPER_ANCHOR);
  const gateIdx = src.indexOf(VISION_TOGGLE_GATE_FROM);
  if (helperIdx === -1 || gateIdx === -1) {
    return { status: 'anchor-missing', detail: '未找到识图 helper/门槛锚点（版本可能已变更或 image-send 未应用），跳过 ' + file };
  }
  const out = src.replace(VISION_TOGGLE_HELPER_ANCHOR, VISION_TOGGLE_HELPER_CHECK + VISION_TOGGLE_HELPER_ANCHOR)
    .replace(VISION_TOGGLE_GATE_FROM, VISION_TOGGLE_GATE_TO);
  return { status: 'changed', src: out };
}

// ---------------------------------------------------------------------------
// dsh 装配层防护：profile patch 损坏自愈加载（原 applyProfilePatchGuard）。
// ---------------------------------------------------------------------------
const PROFILE_PATCH_GUARD_MARKER = 'function loadUserPatchLayer';
const PROFILE_PATCH_GUARD_CALL_SITE = '\t\tpatches: options.userLayer !== false && existsSync(patchPath) ? loadOverlayPatches(binName, patchPath) : []';
const PROFILE_PATCH_GUARD_CALL_REPLACEMENT = '\t\tpatches: loadUserPatchLayer(binName, patchPath, options)';
const PROFILE_PATCH_GUARD_INSERT_AFTER = '\treturn parsePatchList(binName, file, content, "overlay");\n}';
const PROFILE_PATCH_GUARD_INJECTED =
  '/** dsh-desktop guard: the profile\'s own patch layer is user-owned data; a broken file must not brick\n' +
  ' * the surface. Back the broken file up, reset the layer to an empty list, and boot without it.\n' +
  ' */\n' +
  'function loadUserPatchLayer(binName, patchPath, options) {\n' +
  '\tif (options.userLayer === false || !existsSync(patchPath)) return [];\n' +
  '\ttry {\n' +
  '\t\treturn loadOverlayPatches(binName, patchPath);\n' +
  '\t} catch (error) {\n' +
  '\t\ttry {\n' +
  '\t\t\tconst backup = `${patchPath}.broken-${Date.now()}`;\n' +
  '\t\t\twriteFileSync(backup, readFileSync(patchPath, "utf8"));\n' +
  '\t\t\twriteFileSync(patchPath, "# recovered by dsh: the previous content failed to parse and was moved to\\n# " + backup + "\\n[]\\n");\n' +
  '\t\t} catch {}\n' +
  '\t\tprocess.stderr.write(`${binName}: ${patchPath} failed to parse (${String(error?.message ?? error)}); the broken file was moved aside and the profile booted without its patch layer\\n`);\n' +
  '\t\treturn [];\n' +
  '\t}\n' +
  '}';

function transformProfilePatchGuard(src, file) {
  if (src.includes(PROFILE_PATCH_GUARD_MARKER)) return { status: 'already' }; // 已应用（幂等，静默）
  if (!src.includes(PROFILE_PATCH_GUARD_CALL_SITE) || !src.includes(PROFILE_PATCH_GUARD_INSERT_AFTER)) {
    return { status: 'anchor-missing', detail: file + ' 锚点未匹配（dsh 版本可能已变化），跳过' };
  }
  const out = src.replace(PROFILE_PATCH_GUARD_CALL_SITE, PROFILE_PATCH_GUARD_CALL_REPLACEMENT);
  return { status: 'changed', src: out.replace(PROFILE_PATCH_GUARD_INSERT_AFTER, PROFILE_PATCH_GUARD_INSERT_AFTER + '\n\n' + PROFILE_PATCH_GUARD_INJECTED) };
}

// ---------------------------------------------------------------------------
// profile bundle 装配防护（原 applyProfileBundleGuard 的两个 transform）。
// ---------------------------------------------------------------------------
function transformProfileBundleAppBoot(src, file) {
  const out = applyAppBootBundleGuard(src);
  if (!out.changed) {
    if (!src.includes(PROFILE_BUNDLE_GUARD_MARKER)) {
      return { status: 'anchor-missing', detail: file + ' 锚点未匹配（dsh 版本可能已变化），跳过' };
    }
    return { status: 'already' }; // 已注入（幂等，静默）
  }
  return { status: 'changed', src: out.src };
}

// rc.8 起 dsh 主包的两个 profile-boot-*.js 中可能有一个是纯 re-export 存根
// （如 `import { o as runProfile } from "./profile-boot-DG5t9aNs.js"; export { runProfile };`），
// 真实装配面在另一个 bundle 里（由它自身的注入覆盖）。存根没有可守护的代码，
// 不算版本漂移，按已处理跳过，避免每次启动误报失配。
const PROFILE_BOOT_STUB_RE = /^import\s*\{[^}]+\}\s*from\s*"\.\/profile-boot-[A-Za-z0-9_-]+\.js";\s*export\s*\{[^}]+\};?\s*$/;

function transformProfileBundleProfileBoot(src, file) {
  let current = src;
  // rc.8 纯 re-export 存根：无 heal/bundle 装配面，无需补丁（幂等静默）。
  if (PROFILE_BOOT_STUB_RE.test(current.trim())) return { status: 'already' };
  let changed = false;
  // heal 调用防护（独立幂等标记）：入口 bundle 无 heal 调用时静默。
  const heal = applyProfileBootHealGuard(current);
  if (heal.changed) { current = heal.src; changed = true; }
  const bundle = applyProfileBootBundleGuard(current);
  if (bundle.changed) { current = bundle.src; changed = true; }
  if (changed) return { status: 'changed', src: current };
  if (!current.includes(PROFILE_BOOT_GUARD_MARKER)) {
    return { status: 'anchor-missing', detail: file + ' 锚点未匹配（dsh 版本可能已变化），跳过' };
  }
  return { status: 'already' }; // 已注入（幂等，静默）
}

// ---------------------------------------------------------------------------
// dsh-settings 注册防护（原 applySettingsSectionGuard 内联 transform）。
// ---------------------------------------------------------------------------
const SETTINGS_SECTION_MARKER = 'dsh-desktop guard: an invalid stored section must not brick';
const SETTINGS_SECTION_ANCHOR = '\t\tconst scope = sctx.settings.register(ns, schema, {';
const SETTINGS_SECTION_GUARDED =
  '\t\tlet scope;\n' +
  '\t\ttry {\n' +
  '\t\t\tscope = sctx.settings.register(ns, schema, {\n' +
  '\t\t\t\tbase: entry,\n' +
  '\t\t\t\t...hooks.validate === void 0 ? {} : { validate: hooks.validate }\n' +
  '\t\t\t});\n' +
  '\t\t} catch (error) {\n' +
  '\t\t\t// dsh-desktop guard: an invalid stored section must not brick the consumer\n' +
  '\t\t\t// fiber (fail-loud boot). Fall back to the composition config; the\n' +
  '\t\t\t// namespace simply stays unavailable until the stored section is fixed.\n' +
  '\t\t\tsctx.logger.warn("settings: registration for \\"%s\\" failed; falling back to the composition config this boot", ns);\n' +
  '\t\t\tsctx.logger.warn(error);\n' +
  '\t\t\ttry {\n' +
  '\t\t\t\thooks.setSource(() => entry);\n' +
  '\t\t\t\thooks.onChange();\n' +
  '\t\t\t} catch {}\n' +
  '\t\t\treturn;\n' +
  '\t\t}\n' +
  '\t\thooks.setSource(() => scope.get());';
const SETTINGS_SECTION_FROM = '\t\tconst scope = sctx.settings.register(ns, schema, {\n\t\t\tbase: entry,\n\t\t\t...hooks.validate === void 0 ? {} : { validate: hooks.validate }\n\t\t});\n\t\thooks.setSource(() => scope.get());';

function transformSettingsSectionGuard(src, file) {
  if (src.includes(SETTINGS_SECTION_MARKER)) return { status: 'already' }; // 已应用（幂等，静默）
  if (!src.includes(SETTINGS_SECTION_ANCHOR)) {
    return { status: 'anchor-missing', detail: file + ' 锚点未匹配（dsh 版本可能已变化），跳过' };
  }
  return { status: 'changed', src: src.replace(SETTINGS_SECTION_FROM, SETTINGS_SECTION_GUARDED) };
}

// ---------------------------------------------------------------------------
// dsh-client-ui-workspace 搜索栏修复（原 applyWorkspaceSearchRailFix）。
// ---------------------------------------------------------------------------
const WORKSPACE_SEARCH_RAIL_MARKER = 'dsh-desktop fix: rail search expansion';
// rc.8 起上游原生包含了同款守卫（无 marker 注释的裸形态）：`if (!wide ||
// !searchExpanded || searchOnExpand) return;`。命中即视为已修复（幂等），
// rc.7 及更早仍走下方 OLD 锚点路径（双形态兼容）。
const WORKSPACE_SEARCH_RAIL_NATIVE = 'if (!wide || !searchExpanded || searchOnExpand) return;';
const WORKSPACE_SEARCH_RAIL_OLD_GUARD = '\t\t\t\tif (!wide || !searchExpanded) return;';
const WORKSPACE_SEARCH_RAIL_NEW_GUARD = '\t\t\t\tif (!wide || !searchExpanded || searchOnExpand) return; // ' + WORKSPACE_SEARCH_RAIL_MARKER;
const WORKSPACE_SEARCH_RAIL_OLD_DEPS = '\t\t\t}, [\n\t\t\t\tnormalizedQuery,\n\t\t\t\twide,\n\t\t\t\tsearchExpanded\n\t\t\t]);';
const WORKSPACE_SEARCH_RAIL_NEW_DEPS = '\t\t\t}, [\n\t\t\t\tnormalizedQuery,\n\t\t\t\twide,\n\t\t\t\tsearchExpanded,\n\t\t\t\tsearchOnExpand\n\t\t\t]);';

function transformWorkspaceSearchRailFix(src, file) {
  if (src.includes(WORKSPACE_SEARCH_RAIL_MARKER)) return { status: 'already' };
  // rc.8+ 原生守卫（无 marker）：视为已修复，不算版本漂移。
  if (src.includes(WORKSPACE_SEARCH_RAIL_NATIVE)) return { status: 'already' };
  if (!src.includes(WORKSPACE_SEARCH_RAIL_OLD_GUARD) || !src.includes(WORKSPACE_SEARCH_RAIL_OLD_DEPS)) {
    return { status: 'anchor-missing', detail: '锚点未匹配（dsh 版本可能已变化），跳过 ' + file };
  }
  return { status: 'changed', src: src.replace(WORKSPACE_SEARCH_RAIL_OLD_GUARD, WORKSPACE_SEARCH_RAIL_NEW_GUARD).replace(WORKSPACE_SEARCH_RAIL_OLD_DEPS, WORKSPACE_SEARCH_RAIL_NEW_DEPS) };
}

// ---------------------------------------------------------------------------
// 插件页标签合并补丁（原 applyPluginInventoryTabMergeFix）。
// ---------------------------------------------------------------------------
const PLUGIN_INVENTORY_TAB_MARKER = 'dsh-desktop fix: hide inventory tab';
const PLUGIN_INVENTORY_TAB_OLD = 'tabs = ctx.slots.entries("settings.plugins.tab").map((entry) => ({';
const PLUGIN_INVENTORY_TAB_NEW = 'tabs = ctx.slots.entries("settings.plugins.tab").filter((entry) => (entry.options.id ?? "") !== "all").map((entry) => ({ // ' + PLUGIN_INVENTORY_TAB_MARKER;

function transformPluginInventoryTabMergeFix(src, file) {
  if (src.includes(PLUGIN_INVENTORY_TAB_MARKER)) return { status: 'already' };
  if (!src.includes(PLUGIN_INVENTORY_TAB_OLD)) {
    return { status: 'anchor-missing', detail: '锚点未匹配（dsh 版本可能已变化），跳过 ' + file };
  }
  return { status: 'changed', src: src.replace(PLUGIN_INVENTORY_TAB_OLD, PLUGIN_INVENTORY_TAB_NEW) };
}

// ---------------------------------------------------------------------------
// 持久 shell 停止修复（会话内停止任务停不下来，Windows 主现场）。
//
// 根因（调查定案）：持久 shell 工具 executeCommand 里 `await operation.done`
// 在用户中止后只能等 PTY 侧 300s 发送超时才醒来——中止动作只是向 PTY 写
// \x03，对 trap/忽略 SIGINT 的命令（dev server 等）无效；而兜底杀梯
// （SIGTERM/SIGKILL descendants）在 Windows 上因 node-pty 1.2.0-beta.15
// 返回 pid=0、rootIdentity 恒 undefined 而恒空，是死代码。实测
// terminal.kill()（经 shells.reset 收口）能杀掉附着进程（含 Ctrl+C 掩码者）。
//
// 修法：`await operation.done` 改为与「工具 signal 的 abort latch」race；
// abort 先醒即 shells.reset(...) 复位会话，让 terminal.kill() 生效。正常
// 完成路径逐字不变（race 只加 abort 分支）；pwsh / bash 两包共用同一
// transform，方言（reset reason 措辞）按包内既有字面量推导。
// 上游修复意向：上游在 persistent 工具内内置 abort race 后，本补丁经
// already / anchor-missing 自然退役（参照 vision-key-fix 休眠先例）。
// ---------------------------------------------------------------------------
const PERSISTENT_ABORT_RACE_MARKER = 'dsh-desktop fix: race the persistent send against tool abort';
const PERSISTENT_ABORT_RACE_ANCHOR = '\t\t\t\tfirst = false;\n\t\t\t\tresult = await operation.done;';
// `upstream` 形参名护栏：注入代码直接引用 upstream；若上游重命名形参而
// 锚点串恰好仍命中，会在运行时抛 ReferenceError。此锚点证明 executeCommand
// 内仍是 `deadline(upstream, ...)` 原名，缺它按失配跳过（不冒险注入）。
const PERSISTENT_ABORT_RACE_SCOPE_GUARD = 'deadline(upstream, config.timeoutMs, TIMEOUT_CODE)';

function persistentAbortRaceInjection(reason) {
  return '\t\t\t\tfirst = false;\n' +
    '\t\t\t\t// ' + PERSISTENT_ABORT_RACE_MARKER + '. On Windows the kill ladder is dead code\n' +
    '\t\t\t\t// (node-pty 1.2.0-beta.15 reports pid=0, so descendants() never resolves the tree)\n' +
    '\t\t\t\t// and a bare \\x03 cannot stop commands that trap/ignore SIGINT (dev servers),\n' +
    '\t\t\t\t// so this await used to hang until the 300s send timeout. Racing the tool abort\n' +
    '\t\t\t\t// signal lets us reset now; terminal.kill() does kill attached processes.\n' +
    '\t\t\t\tconst abortWake = { dshDesktopToolAbort: true };\n' +
    '\t\t\t\tlet wakeOnToolAbort = null;\n' +
    '\t\t\t\tconst abortLatch = new Promise((wake) => {\n' +
    '\t\t\t\t\twakeOnToolAbort = () => wake(abortWake);\n' +
    '\t\t\t\t\tif (upstream.aborted) wake(abortWake);\n' +
    '\t\t\t\t\telse upstream.addEventListener("abort", wakeOnToolAbort, { once: true });\n' +
    '\t\t\t\t});\n' +
    '\t\t\t\ttry {\n' +
    '\t\t\t\t\tresult = await Promise.race([operation.done, abortLatch]);\n' +
    '\t\t\t\t\tif (result === abortWake) {\n' +
    '\t\t\t\t\t\tawait shells.reset(owner, "' + reason + '");\n' +
    '\t\t\t\t\t\tcommandDeadline.signal.throwIfAborted();\n' +
    '\t\t\t\t\t}\n' +
    '\t\t\t\t} finally {\n' +
    '\t\t\t\t\tif (wakeOnToolAbort !== null) upstream.removeEventListener("abort", wakeOnToolAbort);\n' +
    '\t\t\t\t}';
}

function transformPersistentShellAbortRace(src, file) {
  if (src.includes(PERSISTENT_ABORT_RACE_MARKER)) return { status: 'already' };
  if (!src.includes(PERSISTENT_ABORT_RACE_ANCHOR) || !src.includes(PERSISTENT_ABORT_RACE_SCOPE_GUARD)) {
    return { status: 'anchor-missing', detail: '锚点未匹配（版本可能已变化），跳过 ' + file };
  }
  // 方言推导：复用包内既有中止分支的 reason 字面量，注入分支与其一致。
  for (const reason of ['persistent pwsh command aborted', 'persistent bash command aborted']) {
    if (src.includes('"' + reason + '"')) {
      return { status: 'changed', src: src.replace(PERSISTENT_ABORT_RACE_ANCHOR, persistentAbortRaceInjection(reason)) };
    }
  }
  return { status: 'anchor-missing', detail: '未识别持久 shell 方言（pwsh/bash reason 字面量缺失），跳过 ' + file };
}

// ---------------------------------------------------------------------------
// PTY 中断升级（dsh-terminal-bash interruptOnce）。
//
// 根因同上：中断只是 signalForeground("SIGINT")（Windows 上等价向 PTY 写
// \x03），对掩码 SIGINT 的前台命令无效；杀梯因 pid=0 恒空。中断后 operation
// 长时间不 settle，消费方只能等 300s 发送超时。
//
// 修法：中断发出后挂 2s 定时器，届时 operation 仍未 settle 且句柄仍 active
// → 直接 close("interrupt escalation") 复位会话（terminate 会杀附着进程，
// 并以 session_exit settle 挂起的发送），不再等 300s。
// 上游修复意向：上游内置中断升级后本补丁经 already / anchor-missing 退役。
// ---------------------------------------------------------------------------
const INTERRUPT_ESCALATION_MARKER = 'dsh-desktop fix: interrupt escalation';
const INTERRUPT_ESCALATION_ANCHOR = '\t\tif (this.active === operation && operation.settled) this.clearActive();\n\t\telse if (this.active === operation && !this.closing) {\n\t\t\tthis.pollingReady = operation;\n\t\t\tthis.schedulePoll(operation, 0);\n\t\t}\n\t}\n\tasync closeOnce(reason) {';
const INTERRUPT_ESCALATION_INJECTION =
  '\t\tif (this.active === operation && operation.settled) this.clearActive();\n' +
  '\t\telse if (this.active === operation && !this.closing) {\n' +
  '\t\t\tthis.pollingReady = operation;\n' +
  '\t\t\tthis.schedulePoll(operation, 0);\n' +
  '\t\t\t// ' + INTERRUPT_ESCALATION_MARKER + ': a bare SIGINT/\\x03 cannot stop foreground\n' +
  '\t\t\t// commands that trap or ignore it, and the pid-based kill ladder is dead code on\n' +
  '\t\t\t// Windows (node-pty 1.2.0-beta.15 reports pid=0). If the operation is still\n' +
  '\t\t\t// unsettled 2s after the interrupt, close the session: terminate() kills the\n' +
  '\t\t\t// attached process tree and settles the pending send with session_exit.\n' +
  '\t\t\tsetTimeout(() => {\n' +
  '\t\t\t\tif (this.active !== operation || operation.settled || this.closing) return;\n' +
  '\t\t\t\tthis.close("interrupt escalation").catch(() => {});\n' +
  '\t\t\t}, 2e3);\n' +
  '\t\t}\n' +
  '\t}\n' +
  '\tasync closeOnce(reason) {';

function transformTerminalInterruptEscalation(src, file) {
  if (src.includes(INTERRUPT_ESCALATION_MARKER)) return { status: 'already' };
  if (!src.includes(INTERRUPT_ESCALATION_ANCHOR)) {
    return { status: 'anchor-missing', detail: '锚点未匹配（版本可能已变化），跳过 ' + file };
  }
  return { status: 'changed', src: src.replace(INTERRUPT_ESCALATION_ANCHOR, INTERRUPT_ESCALATION_INJECTION) };
}

// ---------------------------------------------------------------------------
// agent-preset 未知 id 回落补丁（0.5.0 存量用户 resume 变砖修复）。
//
// 根因（真实用户 0.5.0 反馈）：Electron 老版本随包装过 minimal-win 预设，
// 用户 profile/会话 header 引用了它；0.5.0 Tauri 版内核 dsh-agent-presets 的
// roster 只有 standard/code/minimal/cordis，resolve() 查无此 id 即抛
// UnknownPresetError，resume 硬失败且无任何回落——会话永久变砖（第二轮白屏）。
//
// 修法：resolve() 的「查无此 id」分支改为 warn 降级回落（minimal-win→语义
// 最近的 minimal；其余未知 id→保底 standard；回落目标必须真实存在于 roster），
// 回落时 console.warn 中文日志（原 id / 回落目标 / 原因 / 原错误 message，保留
// 原错误对象信息便于诊断）。roster 全空或回落目标也缺失时维持原样抛错（此时
// 无可回落，硬抛是对的）。只动「Unknown」：PresetMountError（组合文件损坏 =
// 部署真坏了）不经本补丁、保持硬抛。
// 目标双文件：lib/index.js（运行时经 exports "." 实际加载的唯一入口）与同源
// 的 lib/invariant.js（无人加载，一并覆盖防未来消费方；两文件锚点文本一致）。
// 上游修复意向：上游在 resolve()/resume 链内置同款回落后，本补丁经 already /
// anchor-missing 自然退役（参照 vision-key-fix 休眠先例）。
// ---------------------------------------------------------------------------
const AGENT_PRESET_FALLBACK_MARKER = 'dsh-desktop fix: agent-preset-fallback';
const AGENT_PRESET_FALLBACK_ANCHOR = '\t\tconst found = presets.find((preset) => preset.id === wanted);\n\t\tif (found === void 0) throw new UnknownPresetError(wanted, presets.map((preset) => preset.id));\n\t\treturn found;';
const AGENT_PRESET_FALLBACK_INJECTION = [
  '\t\tconst found = presets.find((preset) => preset.id === wanted);',
  '\t\tif (found === void 0) {',
  '\t\t\t// dsh-desktop fix: agent-preset-fallback — a session or profile may reference a',
  '\t\t\t// preset id this deployment no longer ships (0.5.0 dropped the Electron-era',
  '\t\t\t// "minimal-win"). A hard UnknownPresetError here bricks resume forever; fall',
  '\t\t\t// back to the closest semantic preset and warn instead. Only "unknown id"',
  '\t\t\t// degrades — a PresetMountError (broken composition) stays a loud failure.',
  '\t\t\tconst availableIds = presets.map((preset) => preset.id);',
  '\t\t\tconst fallbackId = wanted === "minimal-win" && availableIds.includes("minimal") ? "minimal" : availableIds.includes("standard") ? "standard" : void 0;',
  '\t\t\tconst fallback = fallbackId === void 0 ? void 0 : presets.find((preset) => preset.id === fallbackId);',
  '\t\t\tif (fallback !== void 0) {',
  '\t\t\t\tconst originalError = new UnknownPresetError(wanted, availableIds);',
  '\t\t\t\tconsole.warn(`[dsh] agent-presets 预设回落：引用的预设 "${wanted}" 在当前安装中不存在（可用：${availableIds.join(", ") || "无"}），已自动回落到语义最近的预设 "${fallback.id}"（原因：该预设随版本升级移除，回落规则 minimal-win→minimal、其余未知 id→standard）。会话将以回落预设继续恢复，建议在预设选择中重新挑选。原始错误：${originalError.message}`);',
  '\t\t\t\treturn fallback;',
  '\t\t\t}',
  '\t\t\tthrow new UnknownPresetError(wanted, presets.map((preset) => preset.id));',
  '\t\t}',
  '\t\treturn found;',
].join('\n');

function transformAgentPresetFallback(src, file) {
  if (src.includes(AGENT_PRESET_FALLBACK_MARKER)) return { status: 'already' };
  if (!src.includes(AGENT_PRESET_FALLBACK_ANCHOR)) {
    return { status: 'anchor-missing', detail: '未找到 agent-presets resolve 抛错锚点（版本可能已变化），跳过 ' + file };
  }
  // 函数替换器：注入文本含 ${...} 模板字面量，规避 String.replace 对 $ 序列的替换语义。
  return { status: 'changed', src: src.replace(AGENT_PRESET_FALLBACK_ANCHOR, () => AGENT_PRESET_FALLBACK_INJECTION) };
}

// ---------------------------------------------------------------------------
// prompt-context-literal 补丁（context/section 文本里的字面 {{...}} 不再炸整轮）。
//
// 根因（真实用户现场）：内核 dsh-system-prompt 的 interpolate() 对所有 section
// 与 context 文本做 {{name}} 插值扫描，VARIABLE_NAME=/^[a-z][a-z0-9_]*$/：字面量
// {{state.gold}}（graph-memory 从图数据库 recall 出的节点/episode 内容，属不可信
// 数据而非模板作者手笔）名字带点 → malformed 硬抛 → 整轮 prompt 组装失败，会话
// 每轮必瘫。这是「不可信数据进了模板插值器」的经典注入类问题：任何把动态/用户
// 数据拼进 context 的插件都会中招。
//
// 修法：name 不合法（含点、大写、空格等）时不再硬抛，改为 console.warn（附
// kind / context 名 / 原文字面组 / 邻近片段）+ 按字面透传该组，渲染继续。
// **只放宽 name-invalid，不放宽 unknown-variable**（下一分支 {{合法名}} 但变量
// 未注册保持硬抛）：不合法名字出现在 context 文本里几乎必然是数据碰巧长得像
// 模板（DB 内容、用户粘贴文本），透传即用户本意；而合法名字的 {{name}} 是刻意的
// 模板作者语法（dsh-workspace-anchor 的 section 就有意引用 {{cwd}}），引用了未
// 注册变量是真实作者错误，静默透传会把真错误漏成悄悄不渲染的文本——必须响亮。
// value===void 0 分支同理不动（合法引用取到 undefined 属装配期真错误）。
// 与 graph-memory 插件侧 defuseTemplateGroups（打断 {{ / }} 序列，护存量 DB）
// 互补：插件净化护住本插件，内核放宽兜住其他一切动态数据源。
// 上游修复意向：上游在 interpolate 内置同款「无效名透传 + warn」后，本补丁经
// already / anchor-missing 自然退役（参照 vision-key-fix 休眠先例）。
// ---------------------------------------------------------------------------
const PROMPT_CONTEXT_LITERAL_MARKER = 'dsh-desktop fix: prompt-context-literal';
// 锚点 = interpolate() 的 name-invalid 抛错整行（含上一行 const name 取组名，
// 双行保证唯一；dsh-system-prompt lib/index.js:117-118 逐字抄录）。
const PROMPT_CONTEXT_LITERAL_ANCHOR = '\t\tconst name = group[0].slice(2, -2);\n\t\tif (!VARIABLE_NAME.test(name)) throw new Error(`malformed prompt variable reference "{{${name}}}" in ${kind} "${input.name}" (variable names match ${String(VARIABLE_NAME)})`);';
const PROMPT_CONTEXT_LITERAL_INJECTION = [
  '\t\tconst name = group[0].slice(2, -2);',
  '\t\tif (!VARIABLE_NAME.test(name)) {',
  '\t\t\t// dsh-desktop fix: prompt-context-literal — context/section text is often',
  '\t\t\t// untrusted data (graph-memory recalls DB node/episode content verbatim),',
  '\t\t\t// so a stored literal like {{state.gold}} reaching this scanner is not a',
  '\t\t\t// template authoring error. Pass the group through verbatim and warn instead',
  '\t\t\t// of killing the whole prompt assembly. Only the invalid-name case is',
  '\t\t\t// relaxed: the unknown-variable throw below stays loud, because a valid',
  '\t\t\t// {{name}} that resolves to nothing IS a real author error',
  '\t\t\t// (dsh-workspace-anchor sections intentionally reference {{cwd}}).',
  '\t\t\tconsole.warn(`[dsh] system-prompt: ${kind} "${input.name}" carries literal "${group[0]}" which is not a variable reference (names match ${String(VARIABLE_NAME)}); passing through unchanged. Fragment: ${JSON.stringify(text.slice(open, open + 32))}`);',
  '\t\t\tresult += text.slice(last, open) + group[0];',
  '\t\t\tlast = open + group[0].length;',
  '\t\t\tcontinue;',
  '\t\t}',
].join('\n');

function transformPromptContextLiteral(src, file) {
  if (src.includes(PROMPT_CONTEXT_LITERAL_MARKER)) return { status: 'already' };
  if (!src.includes(PROMPT_CONTEXT_LITERAL_ANCHOR)) {
    return { status: 'anchor-missing', detail: '未找到 dsh-system-prompt interpolate 抛错锚点（版本可能已变化），跳过 ' + file };
  }
  // 函数替换器：注入文本含 ${...} 模板字面量，规避 String.replace 对 $ 序列的替换语义。
  return { status: 'changed', src: src.replace(PROMPT_CONTEXT_LITERAL_ANCHOR, () => PROMPT_CONTEXT_LITERAL_INJECTION) };
}

// ---------------------------------------------------------------------------
// K1 根因修复（2026-08）：「credentials service is absent」偶发于桌面端。
//
// 根因链（字节级证据见 scripts/test/unit-fallback-heal-isolation.test.js）：
//   1. `$DSH_HOME/profiles/node_modules/@deepseek-ai/*` fallback junction 曾被
//      指向一个后来被删除的安装（活体现场：全部指向已不存在的
//      `%TEMP%\dsh-portable-sandbox\...`）；
//   2. `healProfilesModuleFallback`（dsh-app-boot）是「单点中断、整体放弃」：
//      写链接循环里任何一个名字抛错（Windows AV/EPERM 瞬时锁、真实目录占位、
//      双安装并发 heal 的 EEXIST 竞态）→ 整轮 heal 中止 → 半套 fallback 树
//      （受保护核心 dsh-base/dsh-web-app 恰在 BFS 序前段已写好，而
//      dsh-credentials-local 之类的宿主组合服务条目留在悬空/被占状态）；
//   3. loader-isolation 补丁把「非受保护条目导入/激活失败」静默降级为
//      stderr 标记 + 跳过 → boot 照常成功 → 用户直到在模型设置页保存
//      API key 才看到 apiproxy 的「credentials service is absent」。
// 网页端不共享 `%TEMP%`/双安装现场，故表现为「桌面端偶发」。
//
// 三层修复（均为幂等纯变换）：
//   a. fallback-heal-isolation（dsh-app-boot）：单个坏名字就地重试后跳过并打
//      `[fallback-heal] entry <name> failed: ...` 标记，其余名字照常 heal——
//      半套树窗口从「整轮放弃」缩小到「恰好那一个坏名字」；
//   b. credentials-initial-retry（dsh-credentials-local）：activate 首读的
//      stat/readFile 对 Windows 瞬时 EBUSY/EPERM/EACCES 重试 3 次（递增退避），
//      「AV 锁瞬时报错 → 激活失败 → 静默缺席」的触发面收窄；
//   c. credentials-absent-guidance（dsh-host-apiproxy）：报错文案追加修复指引，
//      即使降级态发生，用户看到的也是「重启一次自动修复」而不是死谜语。
// ---------------------------------------------------------------------------

// a. fallback heal 单点容错。
const FALLBACK_HEAL_ISOLATION_MARKER = 'dsh-desktop heal isolation: one stale fallback entry must not abort the whole heal';
const FALLBACK_HEAL_LOOP_OLD = [
  '\tfor (const [packageName, target] of links) {',
  '\t\tconst link = join(modulesDir, packageName);',
  '\t\tmkdirSync(dirname(link), { recursive: true });',
  '\t\tensureSymlink(link, target);',
  '\t}',
].join('\n');
const FALLBACK_HEAL_LOOP_NEW = [
  '\tfor (const [packageName, target] of links) {',
  '\t\tconst link = join(modulesDir, packageName);',
  '\t\tmkdirSync(dirname(link), { recursive: true });',
  '\t\t// ' + FALLBACK_HEAL_ISOLATION_MARKER + ' (K1): a single bad entry must',
  '\t\t// not abort the whole heal — a half-healed fallback tree leaves host-',
  '\t\t// composition services (e.g. dsh-credentials-local) silently absent and',
  '\t\t// the user only finds out when saving an API key. Retry the move in',
  '\t\t// place (Windows AV/EPERM transients, concurrent-heal EEXIST races),',
  '\t\t// then isolate the one name and keep healing the rest.',
  '\t\ttry {',
  '\t\t\tensureSymlink(link, target);',
  '\t\t} catch (healError) {',
  '\t\t\tlet healed = false;',
  '\t\t\tfor (let healRetry = 0; healRetry < 3; healRetry += 1) {',
  '\t\t\t\ttry {',
  '\t\t\t\t\tensureSymlink(link, target);',
  '\t\t\t\t\thealed = true;',
  '\t\t\t\t\tbreak;',
  '\t\t\t\t} catch {}',
  '\t\t\t}',
  '\t\t\tif (!healed) process.stderr.write(`[fallback-heal] entry ${packageName} failed: ${healError instanceof Error ? healError.message : String(healError)}\\n`);',
  '\t\t}',
  '\t}',
].join('\n');

function transformFallbackHealIsolation(src, file) {
  if (src.includes(FALLBACK_HEAL_ISOLATION_MARKER) && src.includes('[fallback-heal] entry ')) return { status: 'already' };
  if (!src.includes(FALLBACK_HEAL_LOOP_OLD)) {
    return { status: 'anchor-missing', detail: '未找到 fallback heal 写链接循环锚点（版本可能已变更），跳过 ' + file };
  }
  return { status: 'changed', src: src.replace(FALLBACK_HEAL_LOOP_OLD, FALLBACK_HEAL_LOOP_NEW) };
}

// b. credentials-local activate 首读的瞬时文件错误重试。
const CREDENTIALS_INITIAL_RETRY_MARKER = 'dsh-desktop compat: transient initial credentials read retries';
const CREDENTIALS_LOAD_INITIAL_OLD = [
  '\t\tlet text;',
  '\t\ttry {',
  '\t\t\ttext = await readFile(this.spec.filename, "utf8");',
  '\t\t} catch (error) {',
  '\t\t\tif (!isENOENT(error)) throw error;',
  '\t\t\treturn;',
  '\t\t}',
].join('\n');
const CREDENTIALS_LOAD_INITIAL_NEW = [
  '\t\tlet text;',
  '\t\ttry {',
  '\t\t\t// ' + CREDENTIALS_INITIAL_RETRY_MARKER + ' (K1): Windows AV/indexer can hold',
  '\t\t\t// the document through a transient EBUSY/EPERM/EACCES at exactly the boot read;',
  '\t\t\t// a failed activation silently drops the credentials service for the whole',
  '\t\t\t// session (loader isolation), so retry transient failures before giving up.',
  '\t\t\ttext = await readInitialDocumentWithRetry(this.spec.filename);',
  '\t\t} catch (error) {',
  '\t\t\tif (!isENOENT(error)) throw error;',
  '\t\t\treturn;',
  '\t\t}',
].join('\n');
const CREDENTIALS_OWNER_STAT_OLD = '\t\tmode = (await stat(filename)).mode;';
const CREDENTIALS_OWNER_STAT_NEW = '\t\tmode = (await statInitialWithRetry(filename)).mode;';
const CREDENTIALS_HELPERS_ANCHOR = [
  '/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */',
  'function isENOENT(error) {',
  '\treturn error?.code === "ENOENT";',
  '}',
].join('\n');
const CREDENTIALS_HELPERS_CODE = [
  'async function statInitialWithRetry(filename) {',
  '\tfor (let attempt = 0; ; attempt += 1) {',
  '\t\ttry {',
  '\t\t\treturn await stat(filename);',
  '\t\t} catch (error) {',
  '\t\t\tif (attempt >= 2 || !isTransientInitialReadError(error)) throw error;',
  '\t\t\tawait new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));',
  '\t\t}',
  '\t}',
  '}',
  'async function readInitialDocumentWithRetry(filename) {',
  '\tfor (let attempt = 0; ; attempt += 1) {',
  '\t\ttry {',
  '\t\t\treturn await readFile(filename, "utf8");',
  '\t\t} catch (error) {',
  '\t\t\tif (attempt >= 2 || !isTransientInitialReadError(error)) throw error;',
  '\t\t\tawait new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));',
  '\t\t}',
  '\t}',
  '}',
  'function isTransientInitialReadError(error) {',
  '\treturn error?.code === "EBUSY" || error?.code === "EPERM" || error?.code === "EACCES";',
  '}',
].join('\n');

function transformCredentialsInitialRetry(src, file) {
  if (src.includes(CREDENTIALS_INITIAL_RETRY_MARKER) && src.includes('readInitialDocumentWithRetry')) return { status: 'already' };
  if (!src.includes(CREDENTIALS_LOAD_INITIAL_OLD) || !src.includes(CREDENTIALS_OWNER_STAT_OLD) || !src.includes(CREDENTIALS_HELPERS_ANCHOR)) {
    return { status: 'anchor-missing', detail: '未找到 credentials 首读锚点（版本可能已变更），跳过 ' + file };
  }
  let out = src.replace(CREDENTIALS_LOAD_INITIAL_OLD, CREDENTIALS_LOAD_INITIAL_NEW);
  out = out.replace(CREDENTIALS_OWNER_STAT_OLD, CREDENTIALS_OWNER_STAT_NEW);
  out = out.replace(CREDENTIALS_HELPERS_ANCHOR, CREDENTIALS_HELPERS_ANCHOR + '\n\n' + CREDENTIALS_HELPERS_CODE);
  return { status: 'changed', src: out };
}

// c. apiproxy「credentials service is absent」报错文案追加修复指引。
const CREDENTIALS_ABSENT_GUIDANCE_MARKER = 'dsh-desktop compat: credentials-absent guidance';
const CREDENTIALS_ABSENT_OLD = 'message: "credentials service is absent: this deployment does not mount a credential provider (e.g. @deepseek-ai/dsh-credentials-local) in its composition",';
const CREDENTIALS_ABSENT_NEW = [
  '\t\t\t// ' + CREDENTIALS_ABSENT_GUIDANCE_MARKER + ' (K1): the absent provider is almost always a',
  '\t\t\t// half-healed profile module fallback (`~/.dsh/profiles/node_modules`), not a',
  '\t\t\t// broken deployment — tell the user the one-step remedy instead of a riddle.',
  '\t\t\tmessage: "credentials service is absent: this deployment does not mount a credential provider (e.g. @deepseek-ai/dsh-credentials-local) in its composition — a required plugin failed to load this boot; restart DSH Desktop once to auto-repair the profile module fallback, then save the key again —— 请完全退出并重启 DSH Desktop 一次（启动链会自动修复），再重新保存密钥",',
].join('\n');

function transformCredentialsAbsentGuidance(src, file) {
  if (src.includes(CREDENTIALS_ABSENT_GUIDANCE_MARKER)) return { status: 'already' };
  if (!src.includes(CREDENTIALS_ABSENT_OLD)) {
    return { status: 'anchor-missing', detail: '未找到 credentialsAbsent 报错文案锚点（版本可能已变更），跳过 ' + file };
  }
  return { status: 'changed', src: src.replace(CREDENTIALS_ABSENT_OLD, CREDENTIALS_ABSENT_NEW) };
}

// ---------------------------------------------------------------------------
// 设备未授权指引（2026-08 用户实机反馈）：DeepSeek 服务端 403 风控原文
// 「This device is not authorized. Please contact the administrator or try
// again later.」经 dsh-llm-deepseek 透传，前端红框只显示这句英文死谜语——
// 用户既不知道是凭据/风控问题，也不知道该干什么（点「重试」无用、重装无用）。
// 本补丁在 401/403 且报文命中设备授权/风控特征时追加中文可操作指引。
// 一般性 401（密钥填错，已有 INVALID_CREDENTIAL 链路文案）不追加，防噪音。
// ---------------------------------------------------------------------------
const DEVICE_AUTH_GUIDANCE_MARKER = 'dsh-desktop compat: device-auth guidance';
// 双形态锚点（A1 验证：上游 rc.1 重构了非 2xx 块——3-tab + response.text() +
// JSON.parse；rc.8 及更早为 2-tab + response.json()。V2 优先，V1 兜底）。
const DEVICE_AUTH_THROW_ANCHOR_V2 = [
  '\t\t\tif (!response.ok) {',
  '\t\t\t\tlet message = `DeepSeek API error (HTTP ${response.status})`;',
  '\t\t\t\tlet providerError;',
  '\t\t\t\tconst rawResponse = await response.text();',
  '\t\t\t\ttry {',
  '\t\t\t\t\tproviderError = JSON.parse(rawResponse).error;',
  '\t\t\t\t\tif (providerError?.message) message = providerError.message;',
  '\t\t\t\t} catch {}',
].join('\n');
const DEVICE_AUTH_THROW_ANCHOR = [
  '\t\tif (!response.ok) {',
  '\t\t\tlet message = `DeepSeek API error (HTTP ${response.status})`;',
  '\t\t\tlet providerError;',
  '\t\t\ttry {',
  '\t\t\t\tproviderError = (await response.json()).error;',
  '\t\t\t\tif (providerError?.message) message = providerError.message;',
  '\t\t\t} catch {}',
].join('\n');
/** 指引注入体（indent = 抛错块 if 体的缩进层级；注释/if/message 行随层）。 */
function deviceAuthGuidanceBlock(indent) {
  const inner = indent + '\t';
  return [
    indent + '// ' + DEVICE_AUTH_GUIDANCE_MARKER + ': a provider-side device/risk-control',
    indent + '// rejection (e.g. "This device is not authorized. Please contact the',
    indent + '// administrator or try again later.") is a credential problem the client',
    indent + '// cannot retry or reinstall its way out of — append the actionable remedy',
    indent + '// so the user is not left with an English riddle.',
    indent + 'if ((response.status === 401 || response.status === 403) && /not authorized|\\u8bbe\\u5907\\u672a\\u6388\\u6743|contact the administrator|device.{0,24}(unauthorized|not allowed)/i.test(message)) {',
    inner + 'message += " ——【凭据被 DeepSeek 服务端拒绝（令牌失效或账号设备风控）】请到 chat.deepseek.com 重新登录获取新令牌，在 设置 → 模型 页重新填入 API 密钥后重试；重装客户端或反复点「重试」无效。";',
    indent + '}',
  ].join('\n');
}

function transformDeviceAuthGuidance(src, file) {
  if (src.includes(DEVICE_AUTH_GUIDANCE_MARKER)) return { status: 'already' };
  // rc.1/rc.2 形态（3-tab if 体 → 指引 4-tab 基准）。
  if (src.includes(DEVICE_AUTH_THROW_ANCHOR_V2)) {
    return { status: 'changed', src: src.replace(DEVICE_AUTH_THROW_ANCHOR_V2, () => DEVICE_AUTH_THROW_ANCHOR_V2 + '\n' + deviceAuthGuidanceBlock('\t\t\t\t')) };
  }
  // rc.8 及更早形态（2-tab if 体 → 指引 3-tab 基准）。
  if (src.includes(DEVICE_AUTH_THROW_ANCHOR)) {
    return { status: 'changed', src: src.replace(DEVICE_AUTH_THROW_ANCHOR, () => DEVICE_AUTH_THROW_ANCHOR + '\n' + deviceAuthGuidanceBlock('\t\t\t')) };
  }
  return { status: 'anchor-missing', detail: '未找到 dsh-llm-deepseek 非 2xx 抛错锚点（双形态 V2/V1 均未命中，版本可能已变更），跳过 ' + file };
}

// ---------------------------------------------------------------------------
// wsl-picker-browse 补丁（W1 问题四，2026-08）：目录选择器在 WSL 内误判 native。
//
// 根因（真实 WSL2 实机）：dsh-host-directory-picker-auto 的
// resolveDirectoryPickerBackend 在 platform=linux 且 DISPLAY 在场（WSLg 默认
// 设 DISPLAY=:0）且 PATH 上有 zenity/kdialog 时判 "native"——zenity 窗口弹在
// WSLg 的 Linux 桌面会话里，Windows 用户看不见，表现为「点选择目录没反应」。
//
// 修法：检测到 WSL 环境标记（WSL_INTEROP / WSL_DISTRO_NAME，WSL 内 Microsoft
// 注入、Linux 裸机不可能有）时强制返回 "browse"（网页内浏览交互，Windows
// 浏览器直接可见）。非 WSL 的 Linux 裸机行为不变（真在 Linux 桌面前的用户
// zenity 仍是最优交互）。
// 上游修复意向：上游 resolver 内置同款 WSL 判定后，本补丁经 already /
// anchor-missing 自然退役（参照 vision-key-fix 休眠先例）。
// ---------------------------------------------------------------------------
const WSL_PICKER_BROWSE_MARKER = 'dsh-desktop fix: WSL picker must browse, not zenity into WSLg';
// 锚点 = resolveDirectoryPickerBackend 的 SSH 分支行（该函数唯一出现处，
// dsh-host-directory-picker-auto lib/index.js:65 逐字抄录）。
const WSL_PICKER_ANCHOR = '\tif (present(facts.env.SSH_CONNECTION) || present(facts.env.SSH_TTY)) return "browse";';
const WSL_PICKER_INJECTION = [
  '\tif (present(facts.env.SSH_CONNECTION) || present(facts.env.SSH_TTY)) return "browse";',
  '\t// ' + WSL_PICKER_BROWSE_MARKER + ': under WSL (WSLg) DISPLAY=:0 is always set and',
  '\t// zenity/kdialog exist on PATH, so the resolver would mount the native backend —',
  '\t// but the chooser window opens in the Linux session desktop the Windows user',
  '\t// never sees. WSL_INTEROP/WSL_DISTRO_NAME are Microsoft-injected WSL markers',
  '\t// (never present on bare Linux), so force the web browse flow there.',
  '\tif (present(facts.env.WSL_INTEROP) || present(facts.env.WSL_DISTRO_NAME)) return "browse";',
].join('\n');

function transformDirectoryPickerWslBrowse(src, file) {
  if (src.includes(WSL_PICKER_BROWSE_MARKER)) return { status: 'already' };
  if (!src.includes(WSL_PICKER_ANCHOR)) {
    return { status: 'anchor-missing', detail: '未找到 directory-picker-auto SSH 分支锚点（版本可能已变化），跳过 ' + file };
  }
  return { status: 'changed', src: src.replace(WSL_PICKER_ANCHOR, () => WSL_PICKER_INJECTION) };
}

// ---------------------------------------------------------------------------
// api-gateway 缺席指引补丁（E1，2026-08 v0.5.2 用户反馈）：
// 「报错: 加载提供方目录失败: transport failure for /api/agentPreset.list:
//   HTTP 404，整个桌面端都没法用了」。
//
// 根因链（与 K1 credentials 缺席同族）：
//   1. `/api` 前缀路由由 dsh-client-connection 注册，其 fallback fetch 里
//      `if (apiProxy === void 0) return 404` —— api-gateway 插件
//      （@deepseek-ai/dsh-host-apiproxy，提供 ctx.apiProxy）一旦本 boot
//      加载/激活失败（半套 profile fallback 树 + loader-isolation 静默跳过
//      非保护核心，即 K1 的半树窗口恰好砸中网关本身），**所有** /api 方法
//      一律裸 404；
//   2. 前端每个面（模型设置页 llm.providers、预设 agentPreset.list、会话
//      session.list…）首载即炸，各面只显示「transport failure … HTTP 404」
//      英文死谜语，用户观感即「整个桌面端都没法用了」且无路可走。
//   注意：agentPresets 服务缺席 / 预设目录缺失都不产生 404——apiproxy 的
//   handler 在服务缺席时返回空目录 ok，scanRoot 对 ENOENT 返回 []；此 404
//   只能来自 apiProxy 服务整体缺席。
//
// 修法：缺席分支对 POST（unary 调用腿）改为回 200 + 错误信封——code 用
// "internal"（客户端 rpcErrorSchema 是闭合 discriminated union，新 code 会
// 在 client 侧 parse 失败换一种谜语），message 携带中英双语的一步修复指引
// （完全退出重启一次，boot 链会重 heal 模块回落树；不愈再重装）。rpcId 回
// 读请求体回显（客户端 callUnary 校验 echo）。非 POST 腿（SSE 打开器）保留
// 原 404，与其传输契约一致。上游内置同款缺席指引后本补丁经 already /
// anchor-missing 自然退役。
// ---------------------------------------------------------------------------
const API_GATEWAY_ABSENT_MARKER = 'dsh-desktop compat: api-gateway-absent';
// 锚点 = apply() fallback fetch 的 apiProxy 缺席三分支（payload rc.2 逐字节；
// 三行联合在文件内唯一，toFetchHandler(apiProxy) 全文件仅此一处）。
const API_GATEWAY_ABSENT_ANCHOR = [
  '\t\tconst apiProxy = ctx.get("apiProxy");',
  '\t\tif (apiProxy === void 0) return new Response("not found", { status: 404 });',
  '\t\treturn toFetchHandler(apiProxy).fetch(request);',
].join('\n');
const API_GATEWAY_ABSENT_INJECTION = [
  '\t\tconst apiProxy = ctx.get("apiProxy");',
  '\t\tif (apiProxy === void 0) {',
  '\t\t\t// ' + API_GATEWAY_ABSENT_MARKER + ' (E1): the api-gateway plugin',
  '\t\t\t// (@deepseek-ai/dsh-host-apiproxy) can fail to load on a half-healed',
  '\t\t\t// profile module fallback (the K1 family). The old bare 404 read as',
  '\t\t\t// "transport failure … HTTP 404" on EVERY surface at once with no way',
  '\t\t\t// forward. Unary POSTs now get a well-formed error envelope with the',
  '\t\t\t// one-step remedy instead; non-POST legs (SSE openers) keep the 404,',
  '\t\t\t// matching their transport contract.',
  '\t\t\tif (request.method !== "POST") return new Response("not found", { status: 404 });',
  '\t\t\tlet rpcId = INVALID_REQUEST_RPC_ID;',
  '\t\t\ttry {',
  '\t\t\t\tconst body = await request.json();',
  '\t\t\t\tif (typeof body?.rpcId === "string") rpcId = RpcId(body.rpcId);',
  '\t\t\t} catch {}',
  '\t\t\treturn errorResponse(rpcId, {',
  '\t\t\t\tcode: "internal",',
  '\t\t\t\tmessage: "api gateway service is absent: the API gateway plugin (@deepseek-ai/dsh-host-apiproxy) failed to load this boot, so every /api method answers with this error — fully exit and restart DSH Desktop once (the boot chain auto-repairs the profile module fallback), and reinstall only if it persists —— 桌面端后端服务（API 网关）本次启动未能加载，所有接口暂不可用：请完全退出并重启 DSH Desktop 一次（启动链会自动修复），若仍报此错请重装。",',
  '\t\t\t\tdetails: {}',
  '\t\t\t});',
  '\t\t}',
  '\t\treturn toFetchHandler(apiProxy).fetch(request);',
].join('\n');

function transformApiGatewayAbsent(src, file) {
  // CRLF 归一化匹配（对齐 loader-isolation 先例）；写回保持原 EOL。
  const crlf = src.includes('\r\n');
  const text = crlf ? src.replace(/\r\n/g, '\n') : src;
  // 幂等判定 = marker 存在 且 新形态注入体存在（仅 marker 残留的损坏文件必须重注入）。
  if (text.includes(API_GATEWAY_ABSENT_MARKER) && text.includes('code: "internal",') && text.includes('api gateway service is absent')) {
    return { status: 'already' };
  }
  if (!text.includes(API_GATEWAY_ABSENT_ANCHOR)) {
    return { status: 'anchor-missing', detail: '未找到 dsh-client-connection apiProxy 缺席分支锚点（版本可能已变更），跳过 ' + file };
  }
  // 函数替换器：注入文本含 ${...} 无，但保持与同族补丁一致的防御式替换语义。
  const out = text.replace(API_GATEWAY_ABSENT_ANCHOR, () => API_GATEWAY_ABSENT_INJECTION);
  return { status: 'changed', src: crlf ? out.replace(/\n/g, '\r\n') : out };
}

module.exports = {
  // runtime-patches 的 9 个 transform（re-export）。其中
  // transformPersistenceAll 不被 registry 直接引用，其消费方是
  // rootAppliers.patchSessionPersistence（session-persistence 以 root 应用器
  // 形态登记），此处 re-export 仅为保持 transform 收口的对称性，非死代码。
  transformFlashFix,
  transformExposeFix,
  transformPersistenceAll,
  transformLegacySlotKey,
  transformSlotUnkeyedCompat,
  transformSlotErrorIsolation,
  transformShellDescriptionOptional,
  transformCodeModeCompat,
  transformAttachmentMimeTrust,
  // 原 main.js 内联 transform（声明化，字节级等价）。
  transformImageSendFix,
  transformVisionKeyFix,
  // 识图总开关（enabled）门槛增量补丁（旧树 → 新语义）。
  transformVisionToggleGate,
  transformProfilePatchGuard,
  transformProfileBundleAppBoot,
  transformProfileBundleProfileBoot,
  transformSettingsSectionGuard,
  transformWorkspaceSearchRailFix,
  transformPluginInventoryTabMergeFix,
  // 持久 shell 停止修复（abort race + 中断升级）。
  transformPersistentShellAbortRace,
  transformTerminalInterruptEscalation,
  // agent-preset 未知 id 回落（0.5.0 存量用户 resume 变砖修复）。
  transformAgentPresetFallback,
  // dsh-system-prompt 字面量透传（graph-memory {{state.gold}} 模板注入瘫会话修复）。
  transformPromptContextLiteral,
  // K1（credentials service is absent 偶发）三层修复。
  transformFallbackHealIsolation,
  transformCredentialsInitialRetry,
  transformCredentialsAbsentGuidance,
  // 设备未授权（DeepSeek 服务端风控 403）报文追加可操作指引。
  transformDeviceAuthGuidance,
  // E1（apiProxy 缺席 → /api 全裸 404 → 桌面端整体不可用）缺席分支改错误信封 + 指引。
  transformApiGatewayAbsent,
  // W1 问题四：WSL 内目录选择器强制 browse（zenity 窗口在 WSLg 里不可见）。
  transformDirectoryPickerWslBrowse,
  // K1 注入体常量（单测 vm 行为验证用，与 transform 同源；非 marker）。
  CREDENTIALS_HELPERS_CODE,
  // 包级补丁 node_modules 根应用器（唯一实现）。
  rootAppliers: {
    patchWebSearchBaseUrl,
    patchMenuViewport,
    patchSessionManage,
    patchSessionOrphans,
    patchOpenProjectDir,
    patchSessionPersistence,
    patchToolSourceCompat,
    patchPiAiOpencodeGoModels,
    patchPiAiCredits,
    patchPiAiReasoningDefaults,
    patchAtomicWriteOrphanLock,
    patchSettingsModelsResilience,
    patchBundleArrivalRetry,
    patchSchedulerGuard,
  },
  // 幂等 marker（单一数据源）：registry 与 transform 的 already 判定引用同一常量，
  // 杜绝「marker 跨模块复制漂移」。slot 系 marker 来自 runtime-patches（与 slot
  // transform 同源），bundle-guard 系来自 profile-bundle-heal，loader 隔离系
  // 来自 loader-isolation，其余为本文档声明化。
  markers: {
    SLOT_KEY_COMPAT_MARKER,
    SLOT_UNKEYED_COMPAT_MARKER,
    SLOT_ERROR_ISOLATE_MARKER,
    SLOT_ERROR_ISOLATE_MARKER_V2,
    IMAGE_SEND_MARKER,
    VISION_KEY_MARKER,
    VISION_TOGGLE_MARKER,
    PROFILE_PATCH_GUARD_MARKER,
    PROFILE_BUNDLE_GUARD_MARKER,
    PROFILE_BOOT_GUARD_MARKER,
    SETTINGS_SECTION_MARKER,
    WORKSPACE_SEARCH_RAIL_MARKER,
    PLUGIN_INVENTORY_TAB_MARKER,
    PERSISTENT_ABORT_RACE_MARKER,
    INTERRUPT_ESCALATION_MARKER,
    AGENT_PRESET_FALLBACK_MARKER,
    PROMPT_CONTEXT_LITERAL_MARKER,
    FALLBACK_HEAL_ISOLATION_MARKER,
    CREDENTIALS_INITIAL_RETRY_MARKER,
    CREDENTIALS_ABSENT_GUIDANCE_MARKER,
    DEVICE_AUTH_GUIDANCE_MARKER,
    API_GATEWAY_ABSENT_MARKER,
    WSL_PICKER_BROWSE_MARKER,
    ...require('./loader-isolation').markers,
  },
};
