// @deepseek-ai/dsh-vision 客户端半边：DSH 设置页的「识图插件」栏 +
// composer 工具行的「🖼 添加图片」按钮（多模态体感入口）。
// 字段与宿主半边 Config 一一对应：baseURL / apiKey / model /
// fallbackModels / maxTokens / timeoutMs / maxImageBytes。
window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-vision",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { bindSnapshotSelector } = require("@deepseek-ai/dsh-client-web-react");
    const { Button, Tooltip } = require("@deepseek-ai/dsh-client-ui-primitives");

    const NS = "dsh-vision";
    const DEFAULTS = {
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4.6v-flash",
      maxTokens: 2048,
      timeoutMs: 60000,
      maxImageBytes: 10485760
    };

    const L = {
      nav: "识图插件（view_image）",
      navSub: "为纯文本模型提供识图能力。填写任意 OpenAI 兼容 VLM 端点的地址与密钥后，会话中即可调用 view_image 工具；输入框旁的「🖼」按钮可直接发图，发送后由后台自动识别（识别结果以文本形式带入对话）。",
      baseURLLabel: "API 地址",
      baseURLHint: "OpenAI 兼容 base URL，例如 https://open.bigmodel.cn/api/paas/v4 或 http://localhost:11434/v1",
      apiKeyLabel: "API 密钥",
      apiKeyHint: "留空 = 保持已保存的密钥（密钥保存后不回显）；也可用环境变量 DSH_VISION_API_KEY / ZHIPUAI_API_KEY / DASHSCOPE_API_KEY；本地 Ollama 可留空",
      modelLabel: "模型",
      modelHint: "例如 glm-4.6v-flash（智谱免费）/ qwen3-vl-flash / glm-4.6v / qwen3-vl:4b",
      fallbackLabel: "备用模型",
      fallbackHint: "逗号分隔；主模型返回 429/404/5xx 时按顺序尝试，可留空",
      maxTokensLabel: "最大输出 token",
      timeoutLabel: "请求超时（毫秒）",
      maxImageBytesLabel: "图片大小上限（字节）",
      save: "保存",
      saving: "保存中…",
      saved: "已保存",
      loading: "加载中…",
      unavailable: "设置不可用（需要在本机浏览器中打开）",
      imageButton: "添加图片（发送后自动识别）"
    };

    function fieldRow(label, hint, input) {
      return jsxs("div", {
        style: { display: "flex", flexDirection: "column", gap: 4 },
        children: [
          jsx("span", { children: label }),
          input,
          hint ? jsx("span", { style: { fontSize: 12, opacity: 0.65 }, children: hint }) : null
        ]
      });
    }

    function textInput(value, onChange, type = "text") {
      return jsx("input", {
        type,
        value: value || "",
        style: { padding: "4px 8px", fontFamily: "inherit" },
        onChange: (e) => onChange(e.target.value)
      });
    }

    function VisionSettingsCard(props) {
      const { useScope, scope } = props;
      const snap = useScope((s) => s);
      const [form, setForm] = react.useState({});
      const [busy, setBusy] = react.useState(false);
      const [saved, setSaved] = react.useState(false);

      react.useEffect(() => {
        if (snap.status !== "ready") return;
        const v = snap.value || {};
        setForm({
          baseURL: String(v.baseURL || DEFAULTS.baseURL),
          apiKey: "",
          model: String(v.model || DEFAULTS.model),
          fallbackModels: Array.isArray(v.fallbackModels) ? v.fallbackModels.join(", ") : "",
          maxTokens: String(v.maxTokens ?? DEFAULTS.maxTokens),
          timeoutMs: String(v.timeoutMs ?? DEFAULTS.timeoutMs),
          maxImageBytes: String(v.maxImageBytes ?? DEFAULTS.maxImageBytes)
        });
      }, [snap.status]);

      if (snap.status !== "ready") {
        return jsx("div", { children: snap.status === "loading" ? L.loading : L.unavailable });
      }

      const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
      const numberOr = (text, fallback) => {
        const n = Number(text);
        return Number.isFinite(n) && n > 0 ? n : fallback;
      };

      const save = async () => {
        setBusy(true);
        setSaved(false);
        try {
          const apiKeyValue = (form.apiKey || "").trim();
          const values = {
            baseURL: (form.baseURL || "").trim() || DEFAULTS.baseURL,
            model: (form.model || "").trim() || DEFAULTS.model,
            fallbackModels: (form.fallbackModels || "").split(",").map((s) => s.trim()).filter(Boolean),
            maxTokens: numberOr(form.maxTokens, 2048),
            timeoutMs: numberOr(form.timeoutMs, 60000),
            maxImageBytes: numberOr(form.maxImageBytes, 10485760)
          };
          for (const [key, value] of Object.entries(values)) {
            const have = (snap.value || {})[key];
            // 不把「等于插件默认值」且存储里没有的字段写进配置：默认值本就由
            // 宿主生效，写死会把未来模型/端点变化的适配空间一起固化（例如
            // maxTokens 2048 遇上旧模型上限 1024 直接 400）。
            // 注：apiKey 不在 DEFAULTS 中，不受此跳过影响（保留 #32 的语义）。
            if (have === undefined && DEFAULTS[key] !== undefined && JSON.stringify(value) === JSON.stringify(DEFAULTS[key])) continue;
            if (JSON.stringify(value) !== JSON.stringify(have)) await scope.set(key, value);
          }
          // apiKey 是 role('secret') 字段：settings.describe 会脱敏、永不回显，
          // 表单里它恒为空。只有用户这次输入了非空新值才写入；留空 = 保持
          // 已保存的密钥 —— 否则「改模型/地址后点保存」会把已存密钥静默清空
          // （用户反馈“识图 API 密钥没法保存”的根因）。
          if (apiKeyValue !== "") await scope.set("apiKey", apiKeyValue);
          setSaved(true);
        } finally {
          setBusy(false);
        }
      };

      return jsxs("div", {
        style: { display: "flex", flexDirection: "column", gap: 12, padding: 16, maxWidth: 560 },
        children: [
          jsx("h2", { children: L.navSub }),
          fieldRow(L.baseURLLabel, L.baseURLHint, textInput(form.baseURL, set("baseURL"))),
          fieldRow(L.apiKeyLabel, L.apiKeyHint, textInput(form.apiKey, set("apiKey"), "password")),
          fieldRow(L.modelLabel, L.modelHint, textInput(form.model, set("model"))),
          fieldRow(L.fallbackLabel, L.fallbackHint, textInput(form.fallbackModels, set("fallbackModels"))),
          fieldRow(L.maxTokensLabel, null, textInput(form.maxTokens, set("maxTokens"), "number")),
          fieldRow(L.timeoutLabel, null, textInput(form.timeoutMs, set("timeoutMs"), "number")),
          fieldRow(L.maxImageBytesLabel, null, textInput(form.maxImageBytes, set("maxImageBytes"), "number")),
          jsxs("div", {
            style: { display: "flex", alignItems: "center", gap: 8 },
            children: [
              jsx(Button, {
                variant: "primary",
                size: "sm",
                disabled: busy || !snap.writable,
                onClick: save,
                children: busy ? L.saving : L.save
              }),
              saved ? jsx("span", { children: L.saved }) : null
            ]
          })
        ]
      });
    }

    // —— 多模态体感：composer 工具行「🖼 添加图片」按钮 ——
    // 选文件 → 官方 createDraftImages 校验/注册（MIME 白名单、限额）→
    // inputActions.addImages 加入草稿，与官方粘贴/拖放同一链路；发送后由
    // 宿主半边 agent/pre-step 后台识别，图片不会到达纯文本模型。
    // 组件 props 由 slots 渲染器注入 standard kit（session 作用域）：
    // inputActions = 官方 InputActions（sessions.provide props 注入）。
    const IMAGE_BUTTON_CSS = [
      ".dsh-vision-image-btn{display:inline-flex;align-items:center;justify-content:center;",
      "width:24px;height:24px;padding:0;border:none;border-radius:6px;background:transparent;",
      "cursor:pointer;font-size:14px;line-height:1;color:var(--dsw-alias-label-tertiary);",
      "transition:background-color .15s,color .15s}",
      ".dsh-vision-image-btn:hover:not(:disabled){background:rgba(127,127,127,.14);color:var(--dsw-alias-label-secondary)}",
      ".dsh-vision-image-btn:disabled{opacity:.45;cursor:default}"
    ].join("");

    const CSS_TAG = "@dsh-external/dsh-vision/client.css";
    function ensureCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]")) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "@dsh-external/dsh-vision";
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = IMAGE_BUTTON_CSS;
      document.head.appendChild(tag);
    }

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NS });
      const useScope = bindSnapshotSelector(scope);
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "dsh-vision",
        order: 75,
        label: () => L.nav,
        inject: () => ({ useScope, scope })
      }, VisionSettingsCard), "dsh-vision: settings section entry");

      ensureCss();
      // conversation 服务（createDraftImages/releaseDraftImages）由
      // ui-conversation 注册在根上下文；缺失时按钮禁用而非崩溃。
      let conversation;
      try { conversation = ctx.get("conversation"); } catch { conversation = undefined; }
      const canAttach = !!conversation && typeof conversation.createDraftImages === "function" &&
        typeof conversation.releaseDraftImages === "function";

      function VisionImageButton({ inputActions }) {
        const fileRef = react.useRef(null);
        const actions = inputActions || {};
        const disabled = !canAttach || typeof actions.addImages !== "function";
        const pick = () => {
          if (!disabled && fileRef.current) fileRef.current.click();
        };
        const onChange = (e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = "";
          if (files.length === 0) return;
          try {
            const images = conversation.createDraftImages(files);
            if (!actions.addImages(images.map((image) => image.id))) conversation.releaseDraftImages(images);
          } catch (error) {
            console.warn("[dsh-vision] 添加图片失败:", error);
            if (typeof actions.notify === "function") {
              actions.notify("error", error instanceof Error ? error.message : String(error));
            }
          }
        };
        return jsxs(react.Fragment, {
          children: [
            jsx("input", {
              ref: fileRef,
              type: "file",
              accept: "image/*",
              multiple: true,
              style: { display: "none" },
              onChange
            }),
            jsx(Tooltip, {
              label: L.imageButton,
              side: "top",
              delayMs: 500,
              children: jsx("button", {
                type: "button",
                className: "dsh-vision-image-btn",
                "aria-label": L.imageButton,
                disabled,
                onClick: pick,
                children: "🖼"
              })
            })
          ]
        });
      }

      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
        name: "conversation.input.left",
        id: "dsh-vision-image",
        order: 80
      }, VisionImageButton), "dsh-vision: image attach button");
    }

    exports.apply = apply;
    exports.inject = ["slots", "settingsScope"];
    return module.exports;
  }
});
