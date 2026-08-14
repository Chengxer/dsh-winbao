// Host-side entry for dsh-conversation-tweaks:
// registers the durable settings namespace used by the General-settings row.
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

const name = "@deepseek-ai/dsh-conversation-tweaks";
const inject = ["settings"];

const NS = settingsNamespace("dsh-conversation-tweaks");
const Config = z.object({
  quietOutput: z.boolean().default(false)
});

function apply(ctx, config) {
  const disposer = installSettingsSection(ctx, NS, Config, config || {}, {
    setSource: () => {
      // 客户端通过 settingsScope 订阅热更新，这里无需额外缓存。
    },
    onChange: () => {
      // Client observes the scope and toggles body[data-dsh-quiet-output].
    }
  });
  return disposer;
}

export { Config, apply, inject, name };
