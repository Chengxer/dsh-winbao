window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-float-window",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		/**
		 * DSH Desktop 会话浮窗：把当前会话弹出到独立窗口（分屏多任务）。
		 *
		 * 两个角色：
		 *  - 主窗口：在会话头部动作行（conversation.session.header.actions）
		 *    挂一个「弹出到独立窗口」按钮，点击调 window.dshDesktop.floatWindow.open(sessionId)。
		 *  - 浮窗：preload 注入 window.__DSH_FLOAT__ = { sessionId }。本插件据此
		 *    进入浮窗模式——选中目标会话、折叠侧栏/关闭详情、隐藏侧栏 rail，
		 *    让会话尽量占满窗口，并把 document.title 推给壳层作为窗口标题。
		 *
		 * 纯浏览器端即可完成，不依赖宿主侧任何专属服务（除 preload 桥）。
		 */

		const FLOAT = (typeof window !== "undefined" && window.__DSH_FLOAT__) || null;

		// ------------------------------------------------------------------
		// CSS
		// ------------------------------------------------------------------
		const TAG = "@deepseek-ai/dsh-float-window/client.css";

		const CSS = [
		// 浮窗侧：折叠时隐藏 56px 侧栏 rail，让会话占满。
		// AppFrame 根节点在折叠时带 data-sidebar-collapsed 属性（官方布局源码），
		// 用它做稳定选择器，避免依赖哈希类名。
		// 注意：绝不能对首个子列（sidebarCol）用 display:none —— 该列离开
		// grid 后，centerCol/detailsCol 会自动前移一列：centerCol 落入 0px
		// 侧栏轨道，detailsCol 落入 1fr 中间轨道，表现为「会话空白、只剩详情」。
		// 注意：data-dsh-float 由 setupFloat 在「目标会话已选中且布局折叠完成」
		// 之后才打上（mount-then-hide）——若在 apply 时立即打，选择会话的
		// 20s 重试期内 0 轨道 CSS 已生效而会话内容未挂，浮窗表现为白屏。
		'body[data-dsh-float] [data-sidebar-collapsed]{grid-template-columns:0 minmax(0,1fr) 0!important}',
		// 浮窗插件超时错误卡（W2 重试环模式兜底：重试耗尽→可见错误，不白屏）。
		"#__dsh_float_plugin_error__{position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;",
		"align-items:center;justify-content:center;gap:12px;background:#0b1220;color:#e6ecff;",
		"font:14px 'Segoe UI','Microsoft YaHei',sans-serif;text-align:center;padding:24px}",
		"#__dsh_float_plugin_error__ .dsh-fl-err-sub{color:#8b9ac4;font-size:12px;line-height:18px}",
		"#__dsh_float_plugin_error__ button{min-width:88px;padding:6px 14px;border:1px solid #3a4656;",
		"border-radius:8px;background:#1a2332;color:#e6ecff;cursor:pointer;font-size:13px}",
		"#__dsh_float_plugin_error__ button:hover{background:#243247}",
		// 主窗侧：弹出按钮（与头部其它动作一致的小图标按钮）。
			".dsh-float-btn{display:inline-flex;align-items:center;justify-content:center;",
			"box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;",
			"background:transparent;color:var(--dsw-alias-label-tertiary);width:26px;height:26px;",
			"padding:0;cursor:pointer;transition:color .15s,border-color .15s,background .15s}",
			".dsh-float-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);",
			"background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
			".dsh-float-btn svg{width:14px;height:14px}"
		].join("");

		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG) + "]")) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-float-window";
			tag.dataset.pluginCss = TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ------------------------------------------------------------------
		// 主窗口：会话头部「弹出到独立窗口」按钮
		// ------------------------------------------------------------------
		function PopOutButton(props) {
			const sessionId = props && (props.sessionId ?? (props.session && props.session.id));
			const onClick = () => {
				if (!sessionId) return;
				const bridge = typeof window !== "undefined" ? window.dshDesktop : undefined;
				if (bridge && bridge.floatWindow && typeof bridge.floatWindow.open === "function") {
					bridge.floatWindow.open(sessionId);
				}
			};
			return react_jsx_runtime.jsx("button", {
				type: "button",
				className: "dsh-float-btn",
				title: "弹出到独立窗口（分屏）",
				"aria-label": "弹出到独立窗口",
				onClick,
				children: react_jsx_runtime.jsx("svg", {
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.8",
					strokeLinecap: "round",
					strokeLinejoin: "round",
					children: [
						react_jsx_runtime.jsx("path", { d: "M14 4h6v6" }),
						react_jsx_runtime.jsx("path", { d: "M20 4l-9 9" }),
						react_jsx_runtime.jsx("rect", { x: "3", y: "8", width: "13", height: "13", rx: "2" })
					]
				})
			});
		}

		// ------------------------------------------------------------------
		// 公共工具：带重试的调用（sessions/layout 可能在 boot 中尚未就绪）
		// ------------------------------------------------------------------
		function retry(fn, { attempts = 40, delayMs = 500, label = "", reg } = {}) {
			return new Promise((resolve) => {
				let tries = 0;
				const tick = () => {
					tries += 1;
					let ok = false;
					try {
						ok = fn() !== false;
					} catch {
						ok = false;
					}
					if (ok) return resolve(true);
					if (tries >= attempts) {
						if (label) console.warn("[dsh-float-window] " + label + " 未就绪");
						return resolve(false);
					}
					const t = setTimeout(tick, delayMs);
					if (reg) reg.push(t);
				};
				tick();
			});
		}
		// ------------------------------------------------------------------
		// 会话完成通知点击跳转：主窗口订阅主进程通知点击事件，
		// 通过 sessions.open(id) 切换到对应会话。
		// ------------------------------------------------------------------
		function setupNotificationJump(ctx) {
			const bridge = typeof window !== "undefined" ? window.dshDesktop : undefined;
			if (!bridge || typeof bridge.onNotificationJump !== "function") return;
			return bridge.onNotificationJump((payload) => {
				const sessionId = payload && payload.sessionId ? String(payload.sessionId) : "";
				if (!sessionId) return;
				retry(() => {
					const sessions = typeof ctx.get === "function" ? ctx.get("sessions", false) : undefined;
					if (!sessions || typeof sessions.open !== "function") return false;
					try {
						sessions.open(sessionId);
						return true;
					} catch {
						return false;
					}
				}, { label: "通知跳转会话", attempts: 40, delayMs: 300 });
			});
		}

		// ------------------------------------------------------------------
		// 浮窗：沉浸折叠 + 选中目标会话
		// 窗口标题由壳层在 page-title-updated 时跟随 document.title 处理，
		// 插件无需监听。
		// ------------------------------------------------------------------
		function setupFloat(ctx) {
			// 所有 setTimeout/setRetry 计时器统一登记：dispose（插件卸载/HMR）
			// 时全部清理，杜绝野计时器在窗口关闭后继续弹错误卡（W2 教训）。
			const timers = [];
			const later = (fn, ms) => {
				const t = setTimeout(fn, ms);
				timers.push(t);
				return t;
			};
			let card = null;
			const dismissCard = () => {
				if (card) {
					try { card.remove(); } catch { /* fake DOM/已移除 */ }
					card = null;
				}
			};
			const targetId = FLOAT && FLOAT.sessionId ? String(FLOAT.sessionId) : "";

			// 1) 选中目标会话。sessions 服务在 runtime apply 时已提供，对外方法
			//    是 open(id)（select 是内部私有方法，不暴露到服务上）。
			//    必须等会话列表就绪（summaries 已加载）后再 open，否则 open() 会抛
			//    「unknown session」导致浮窗空内容。因此先轮询列表就绪，再显式 open，
			//    若 open 仍抛 unknown session（该会话尚未纳入列表）则继续等待重试。
			const ready = (sessions) => {
				// 优先用 list 能力判断列表 phase 已 ready；退化：检查是否存在 current 能力。
				if (sessions && typeof sessions.list === "object" && sessions.list !== null) {
					const snap =
						typeof sessions.list.getSnapshot === "function" ? sessions.list.getSnapshot() : undefined;
					if (snap && typeof snap === "object" && snap.phase === "ready") return true;
				}
				if (sessions && typeof sessions.current !== "undefined") return true;
				return false;
			};
			// 1) 选中目标会话（串行第一步）。
			const selectTarget = () => {
				const sessions = typeof ctx.get === "function" ? ctx.get("sessions", false) : undefined;
				if (!sessions || typeof sessions.open !== "function") return false;
				if (!ready(sessions)) return false; // 列表尚未就绪，继续等待
				// 检查快照中是否已包含目标会话，避免 open() 因 "unknown session" 失败
				if (sessions.list && typeof sessions.list.getSnapshot === "function") {
					const snap = sessions.list.getSnapshot();
					if (snap && typeof snap === "object") {
						if (!selectTarget._debugged) {
							selectTarget._debugged = true;
							console.log("[dsh-float-window] snap keys:", JSON.stringify(Object.keys(snap)), "phase:", snap.phase, "targetId:", targetId);
						}
						let found = false;
						if (snap.byId && typeof snap.byId === "object" && snap.byId[targetId]) {
							found = true;
						} else if (Array.isArray(snap.items)) {
							found = snap.items.some((item) => item && String(item.id) === targetId);
						} else if (Array.isArray(snap.summaries)) {
							found = snap.summaries.some((s) => s && String(s.id) === targetId);
						}
						if (!found) return false;
					}
				}
				try {
					sessions.open(targetId);
				} catch {
					// unknown session：会话尚未纳入列表，继续重试等待
					return false;
				}
				return true;
			};

			// 目标会话是否已选中且已渲染（非 blank）。blank 表示会话内容尚未加载，
			// 此刻关闭详情会被详情面板占用者随后重新打开。读取失败时退化放行。
			const targetRendered = (sessions) => {
				try {
					const cur = sessions && sessions.current;
					if (!cur || typeof cur.getSnapshot !== "function") return true;
					const snap = cur.getSnapshot();
					if (!snap || typeof snap !== "object") return true;
					const id = snap.current ?? snap.sessionId;
					if (id === undefined || String(id) !== targetId) return false;
					const sess = snap.byId && snap.byId[id];
					return !(sess && sess.blank === true);
				} catch {
					return true;
				}
			};

			// 关闭详情 + 折叠侧栏。layout 服务需 root 挂载后才有动作。
			const foldLayout = () => {
				const layout = typeof ctx.get === "function" ? ctx.get("layout", false) : undefined;
				if (!layout || typeof layout.closeDetails !== "function") return false;
				try {
					layout.closeDetails();
					// 侧栏：仅当根 frame 尚未折叠时再 toggle 一次；已折叠（含窄屏默认
					// data-sidebar-collapsed）则跳过，避免 toggle 反向把侧栏展开。
					if (typeof document !== "undefined" && !document.querySelector("[data-sidebar-collapsed]")) {
						layout.toggleSidebar();
					}
				} catch {
					return false;
				}
				return true;
			};

			// mount-then-hide：目标会话选中且布局折叠完成后，才打 data-dsh-float
			// 启用 0 轨道 CSS。旧实现在 apply 时立即打属性——选择会话最长要重试
			// 20s，期间 56px rail 被清零而会话内容未挂，浮窗呈现为白屏。
			const armFloatCss = () => {
				if (typeof document !== "undefined" && document.body && document.body.setAttribute) {
					document.body.setAttribute("data-dsh-float", "1");
				}
			};

			// 重试耗尽兜底：可见错误卡 + 重试/关闭（不再静默留白屏）。
			const showError = (reason) => {
				if (typeof document === "undefined" || !document.body || !document.createElement) return;
				dismissCard();
				card = document.createElement("div");
				card.id = "__dsh_float_plugin_error__";
				var t1 = document.createElement("div");
				t1.textContent = "浮窗未能载入会话";
				var t2 = document.createElement("div");
				t2.className = "dsh-fl-err-sub";
				t2.textContent = reason + "。会话可能已被删除，或内核仍在启动。";
				var btns = document.createElement("div");
				btns.style.display = "flex";
				btns.style.gap = "10px";
				var retryBtn = document.createElement("button");
				retryBtn.textContent = "重试";
				retryBtn.onclick = () => {
					dismissCard();
					run();
				};
				var closeBtn = document.createElement("button");
				closeBtn.textContent = "关闭浮窗";
				closeBtn.onclick = () => {
					try {
						const bridge = typeof window !== "undefined" ? window.dshDesktop : undefined;
						if (bridge && bridge.floatWindow && typeof bridge.floatWindow.close === "function") {
							bridge.floatWindow.close();
						} else if (typeof window !== "undefined" && window.close) {
							window.close();
						}
					} catch { /* 桥不可用时按钮静默 */ }
				};
				btns.appendChild(retryBtn);
				btns.appendChild(closeBtn);
				card.appendChild(t1);
				card.appendChild(t2);
				card.appendChild(btns);
				document.body.appendChild(card);
			};

			// 2) 串行化：先确保目标会话选中并渲染，再关闭详情/折叠侧栏。
			//    弃用原先两个并发 retry 的竞态实现——若关闭详情先于会话选中完成，
			//    详情面板会在会话选中后被占用者重新打开，导致占位文案残留。
			const run = () => {
				retry(selectTarget, { label: "选中目标会话", reg: timers }).then((ok) => {
					if (!ok) {
						showError("目标会话 " + (targetId || "(空)") + " 未在会话列表出现（已重试 20 秒）");
						return;
					}
					retry(() => {
						const sessions = typeof ctx.get === "function" ? ctx.get("sessions", false) : undefined;
						if (!targetRendered(sessions)) return false;
						return foldLayout();
					}, { label: "折叠布局", reg: timers }).then((done) => {
						if (!done) {
							showError("布局折叠超时（layout 服务不可用）");
							return;
						}
						armFloatCss();
						// 兜底：详情面板占用者可能在会话挂载后才打开面板，稍后再补一次关闭。
						later(() => {
							const sessions = typeof ctx.get === "function" ? ctx.get("sessions", false) : undefined;
							if (targetRendered(sessions)) foldLayout();
						}, 1200);
					});
				});
			};
			run();

			// disposer：插件卸载/HMR 时清计时器、摘错误卡、还原 body 属性。
			return () => {
				for (const t of timers) clearTimeout(t);
				timers.length = 0;
				dismissCard();
				if (typeof document !== "undefined" && document.body && document.body.removeAttribute) {
					document.body.removeAttribute("data-dsh-float");
				}
			};
		}

		// ------------------------------------------------------------------
		// 主窗口：从侧栏会话行拖出到独立窗口（微信式拖出，二期）
		//
		// 侧栏会话行本身是 draggable（官方用于列表内重排），其 onDragStart
		// 已把 sessionId 写入 dataTransfer 的 text/plain。我们在 document 上
		// 监听 dragstart/dragleave/dragend：仅当拖拽手势越出窗口边界
		// （dragleave 且 relatedTarget 为 null）时才触发「弹出独立窗口」，
		// 从而与列表内重排互不冲突。
		// 注意：sessionId 由行内 handler 在 bubble 阶段写入，故 dragstart
		// 必须用 bubble 阶段读取，不能在 capture 阶段。
		// ------------------------------------------------------------------
		function setupDragOut() {
			let dragCtx = null;
			// 主进程已按 sessionId 去重；这里再对拖拽手势做 1.2s 节流，
			// 防止同一手势被重复监听器/dragleave 触发多次。
			let lastPop = { at: 0, sessionId: "" };

			const onDragStart = (e) => {
				const row = e.target && e.target.closest ? e.target.closest('[role="treeitem"][draggable]') : null;
				if (!row) return;
				const dt = e.dataTransfer;
				if (!dt || !dt.types || !Array.prototype.includes.call(dt.types, "text/plain")) return;
				const sessionId = dt.getData("text/plain");
				if (!sessionId) return;
				dragCtx = { sessionId, popped: false };
			};

			const onDragLeave = (e) => {
				if (!dragCtx || dragCtx.popped) return;
				if (e.relatedTarget !== null) return; // 仍在窗口内（子元素间切换也会触发）
				const now = Date.now();
				if (lastPop.sessionId === dragCtx.sessionId && now - lastPop.at < 1200) return;
				// 拖拽已越出窗口边界 → 弹出独立窗口（一个拖拽手势只触发一次）。
				dragCtx.popped = true;
				lastPop = { at: now, sessionId: dragCtx.sessionId };
				const bridge = typeof window !== "undefined" ? window.dshDesktop : undefined;
				if (bridge && bridge.floatWindow && typeof bridge.floatWindow.open === "function") {
					bridge.floatWindow.open(dragCtx.sessionId);
				}
			};

			const onDragEnd = () => { dragCtx = null; };

			document.addEventListener("dragstart", onDragStart);
			document.addEventListener("dragleave", onDragLeave);
			document.addEventListener("dragend", onDragEnd);
		}

		// ------------------------------------------------------------------
		// 插件入口
		// ------------------------------------------------------------------
		function apply(ctx) {
			ensureCss();
			if (!FLOAT) {
				// 主窗口：注册弹出按钮 + 侧栏拖出代理。
				ctx.effect(() => ctx.slots.register({
					name: "conversation.session.header.actions",
					id: "float-window",
					order: 200
				}, PopOutButton), "dsh-float-window: pop-out button");
				ctx.effect(() => setupDragOut(), "dsh-float-window: drag-out proxy");
				ctx.effect(() => setupNotificationJump(ctx), "dsh-float-window: notification jump");
				return;
			}
			// 浮窗：沉浸折叠 + 选中会话 + 标题。setupFloat 返回 disposer
			// （清计时器/摘错误卡/还原 body 属性），ctx.effect 回调原样透传，
			// 插件卸载/HMR 时由 cordis 自动调用。
			ctx.effect(() => setupFloat(ctx), "dsh-float-window: float adjustments");
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		// 纯逻辑单测钩子（scripts/test/unit-float-window-client.test.js）：
		// 不参与运行时（setupFloat 为闭包内部函数，只有这里能拿到）。
		exports.__test = { setupFloat, retry };
		return module.exports;
	}
});
