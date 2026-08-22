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
// pi-ai opencode-go 模型目录补丁（opencode-go.json 纯数据补充）。
const { patchPiAiOpencodeGoModels } = require('../patch-pi-ai-opencode-go-models');

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
  // 包级补丁 node_modules 根应用器（唯一实现）。
  rootAppliers: {
    patchWebSearchBaseUrl,
    patchMenuViewport,
    patchSessionManage,
    patchOpenProjectDir,
    patchSessionPersistence,
    patchToolSourceCompat,
    patchPiAiOpencodeGoModels,
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
    ...require('./loader-isolation').markers,
  },
};
