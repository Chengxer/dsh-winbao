// @deepseek-ai/dsh-prompt-custom
// 服务端半边：在 DSH 设置页注册「自定义提示词」命名空间 dsh-prompt，
// 并对每个新建 agent 向其作用域注入提示词节，覆盖/追加官方内核的默认 persona。
//
// 注入方式：
//   - mode = "replace"：注册与预设 persona 同名的 deployment:persona（order 0），
//     在 agent 作用域遮蔽（shadow）预设 persona，实现整体替换。
//   - mode = "append"：注册新节 dsh:custom-prompt（order 1），紧随 persona 之后追加。
//
// 不修改任何官方包，仅通过官方 systemPrompt.section() 与 dsh-settings 能力注入。
// 设置保存后「新创建的会话/agent」立即生效；运行中会话保持原提示词（与官方 preset 语义一致）。

import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { PERSONA_SECTION, PERSONA_ORDER } from "@deepseek-ai/dsh-system-prompt";

const name = "@deepseek-ai/dsh-prompt-custom";
const inject = ["settings"];

const NS = settingsNamespace("dsh-prompt");
const Config = z.object({
	enabled: z.boolean().default(false),
	mode: z.union([z.const("replace"), z.const("append")]).default("append"),
	text: z.string().default("")
});

// 取配置的 getter；setSource 会被替换为 settings scope 读取器（热生效）。
let liveConfig = () => ({ enabled: false, mode: "append", text: "" });

function apply(ctx, config) {
	liveConfig = () => config || {};
	installSettingsSection(ctx, NS, Config, config || {}, {
		setSource: (source) => {
			liveConfig = source;
		},
		onChange: () => {
			const cfg = liveConfig() || {};
			console.log("[dsh-prompt-custom] settings updated: " + JSON.stringify({ enabled: cfg.enabled, mode: cfg.mode }));
		}
	});

	// 每个 agent 创建时，向 agent 作用域注册提示词节。
	// 注册随 agent 纤维自动销毁，无泄漏。
	ctx.on("agent/created", ({ agent }) => {
		const cfg = liveConfig() || {};
		if (!cfg.enabled || !String(cfg.text || "").trim()) return;
		const text = String(cfg.text).trim();
		if (cfg.mode === "replace") {
			agent.ctx.systemPrompt.section({ name: PERSONA_SECTION, order: PERSONA_ORDER, text });
		} else {
			agent.ctx.systemPrompt.section({ name: "dsh:custom-prompt", order: PERSONA_ORDER + 1, text });
		}
	});
}

export { Config, apply, inject, name };