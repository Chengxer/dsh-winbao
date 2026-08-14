window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-conversation-tweaks",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");
		const { bindSnapshotSelector } = require("@deepseek-ai/dsh-client-web-react");

		// ------------------------------------------------------------------
		// Settings
		// ------------------------------------------------------------------
		const NS = "dsh-conversation-tweaks";
		const L = {
			quietTitle: "隐藏对话输出",
			quietDesc: "开启后不显示模型的长篇文字输出，只保留工具调用、文件操作与结果等重要信息。",
			quietOn: "已隐藏",
			quietOff: "显示全部"
		};

		const CSS = [
			// 通用设置行
			".dct-row{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}",
			".dct-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}",
			".dct-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}",
			".dct-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}",
			".dct-switch{width:44px;height:26px;background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;border:none;border-radius:999px;flex:none;position:relative;transition:background .15s}",
			".dct-switch[aria-checked=true]{background:var(--dsw-alias-state-business-primary)}",
			".dct-switch:disabled{opacity:.5;cursor:default}",
			".dct-knob{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .15s}",
			".dct-switch[aria-checked=true] .dct-knob{transform:translateX(18px)}",

			// 隐藏长篇对话输出：AssistantMarkdown 的根节点（文本/思考/图片），
			// 工具调用与工具结果由其它组件渲染，不受影响。
			'body[data-dsh-quiet-output] .Sxvs8a_root{display:none!important}',

			// 会话右侧导航滑轨
			".dct-rail{position:fixed;z-index:60;width:16px;cursor:pointer;user-select:none;-webkit-app-region:no-drag}",
			".dct-railTrack{position:absolute;top:0;bottom:0;left:7px;width:0;border-left:2px dashed color-mix(in srgb,var(--dsw-alias-label-tertiary) 55%,transparent);opacity:.25;transition:opacity .15s}",
			".dct-railThumb{position:absolute;left:4px;width:8px;border-radius:999px;background:var(--dsw-alias-label-tertiary);opacity:.45;transition:opacity .15s,background .15s}",
			".dct-rail:hover .dct-railTrack{opacity:.8}",
			".dct-rail:hover .dct-railThumb{background:var(--dsw-alias-state-business-primary);opacity:.95}",
			".dct-railPreview{position:absolute;left:1px;width:14px;height:28px;border-radius:7px;background:var(--dsw-alias-state-business-primary);opacity:0;pointer-events:none;box-shadow:0 0 10px color-mix(in srgb,var(--dsw-alias-state-business-primary) 65%,transparent);transition:opacity .1s}",
			".dct-rail[data-preview=\"1\"] .dct-railPreview{opacity:.9}"
		].join("");

		function ensureCss() {
			if (typeof document === "undefined") return;
			const tagId = "@deepseek-ai/dsh-conversation-tweaks/client.css";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]")) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-conversation-tweaks";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ------------------------------------------------------------------
		// 设置-通用：隐藏对话输出
		// ------------------------------------------------------------------
		function QuietOutputRow({ useScope, scope }) {
			const snap = useScope((s) => s);
			const ready = snap && snap.status === "ready";
			const enabled = !!(ready && snap.value && snap.value.quietOutput === true);
			return jsxs("div", {
				className: "dct-row",
				children: [
					jsxs("div", {
						className: "dct-rowText",
						children: [
							jsx("div", { className: "dct-title", children: L.quietTitle }),
							jsx("div", { className: "dct-desc", children: L.quietDesc })
						]
					}),
					jsx("button", {
						type: "button",
						role: "switch",
						"aria-checked": enabled,
						"aria-label": L.quietTitle,
						title: enabled ? L.quietOn : L.quietOff,
						className: "dct-switch",
						disabled: !ready || !snap.writable,
						onClick: () => { scope.set("quietOutput", !enabled).catch(() => {}); },
						children: jsx("span", { className: "dct-knob" })
					})
				]
			});
		}

		// ------------------------------------------------------------------
		// 会话右侧导航滑轨
		// ------------------------------------------------------------------
		function setupNavRail() {
			if (typeof document === "undefined") return () => {};

			const rail = document.createElement("div");
			rail.className = "dct-rail";
			rail.style.display = "none";
			const track = document.createElement("div");
			track.className = "dct-railTrack";
			const thumb = document.createElement("div");
			thumb.className = "dct-railThumb";
			const preview = document.createElement("div");
			preview.className = "dct-railPreview";
			rail.append(track, thumb, preview);
			(document.body || document.documentElement).appendChild(rail);

			let target = null;
			let previewRatio = 0.5;

			function findTarget() {
				const root = document.querySelector(".wSkVaW_root");
				const flow = document.querySelector("[data-chat-flow]");
				if (!root || !flow || !root.contains(flow)) return null;
				// 官方 ConversationRoot 的主滚动容器；若未来版本改名，
				// 退化到 data-chat-flow 的最近可滚动祖先。
				const primary = root.querySelector(".wSkVaW_scrollBody");
				if (primary && (primary.scrollHeight > primary.clientHeight + 1 || primary.scrollTop > 0)) return primary;
				const fallback = flow.closest(".Md3f7G_scroll");
				if (fallback && fallback.scrollHeight > fallback.clientHeight + 1) return fallback;
				return primary || fallback;
			}

			function update() {
				const t = findTarget();
				if (t !== target) {
					if (target) target.removeEventListener("scroll", update);
					target = t;
					if (target) target.addEventListener("scroll", update, { passive: true });
				}
				if (!target) {
					rail.style.display = "none";
					return;
				}
				const rect = target.getBoundingClientRect();
				const top = Math.max(0, rect.top) + 12;
				const height = Math.max(0, rect.height - 24);
				if (height < 80) {
					rail.style.display = "none";
					return;
				}
				rail.style.display = "block";
				rail.style.top = top + "px";
				rail.style.height = height + "px";

				const viewport = target.clientHeight;
				const content = Math.max(target.scrollHeight, viewport);
				const trackHeight = height;
				// 长条长度随 session 内容长度变化：内容越长，滑块越短。
				const thumbHeight = Math.max(24, Math.min(trackHeight, (viewport / content) * trackHeight));
				thumb.style.height = thumbHeight + "px";
				const travel = Math.max(0, trackHeight - thumbHeight);
				const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
				thumb.style.top = (maxScroll > 0 ? (target.scrollTop / maxScroll) * travel : 0) + "px";

				const previewTop = Math.max(0, Math.min(1, previewRatio)) * trackHeight - 14;
				preview.style.top = Math.max(0, Math.min(trackHeight - 28, previewTop)) + "px";
			}

			function ratioFromEvent(e) {
				const r = rail.getBoundingClientRect();
				if (r.height <= 0) return 0;
				return Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
			}

			rail.addEventListener("pointermove", (e) => {
				previewRatio = ratioFromEvent(e);
				rail.dataset.preview = "1";
				update();
			});
			rail.addEventListener("pointerleave", () => {
				rail.dataset.preview = "0";
				update();
			});
			// 只有真实点击才跳转；hover 只预览位置。
			rail.addEventListener("click", (e) => {
				const t = findTarget();
				if (!t) return;
				const ratio = ratioFromEvent(e);
				const max = Math.max(0, t.scrollHeight - t.clientHeight);
				if (max <= 0) return;
				t.scrollTo({ top: ratio * max, behavior: "smooth" });
			});

			const timer = setInterval(update, 1000);
			window.addEventListener("resize", update);
			document.addEventListener("scroll", update, true);
			update();

			return () => {
				clearInterval(timer);
				window.removeEventListener("resize", update);
				document.removeEventListener("scroll", update, true);
				if (target) target.removeEventListener("scroll", update);
				rail.remove();
			};
		}

		// ------------------------------------------------------------------
		// 插件入口
		// ------------------------------------------------------------------
		function apply(ctx) {
			ensureCss();

			const scope = ctx.settingsScope.bind({ namespace: NS });
			const useScope = bindSnapshotSelector(scope);

			const applyQuiet = () => {
				if (typeof document === "undefined") return;
				const snap = scope.getSnapshot();
				const enabled = snap && snap.status === "ready" && snap.value && snap.value.quietOutput === true;
				if (enabled) document.body.setAttribute("data-dsh-quiet-output", "1");
				else document.body.removeAttribute("data-dsh-quiet-output");
			};
			applyQuiet();
			scope.subscribe(applyQuiet);

			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "quiet-output",
				order: 25,
				inject: () => ({ useScope, scope })
			}, QuietOutputRow), "dsh-conversation-tweaks: quiet output row");

			ctx.effect(() => setupNavRail(), "dsh-conversation-tweaks: conversation nav rail");
		}

		exports.apply = apply;
		exports.inject = ["slots", "settingsScope"];
		return module.exports;
	}
});
