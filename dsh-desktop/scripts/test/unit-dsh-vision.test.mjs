// dsh-vision 图片自动识别（llm/stream 转换 + 前端多文件上传纯函数）单测。
// 运行：node --test scripts/test/unit-dsh-vision.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Config, convertMessagesWithImages, createLlmStreamHandler, wrapVisionAdapter, wrapVisionResolveModelInfo } from "../../assets/plugins/dsh-vision/lib/index.js";

const enc = new TextEncoder();
const ref = (id, extra = {}) => ({ attachmentId: id, mediaType: "image/png", bytes: 3, width: 2, height: 2, ...extra });
const imageBlock = (id, extra) => ({ type: "image", attachment: ref(id, extra) });
const textBlock = (text) => ({ type: "text", text });
const userMessage = (content) => ({ role: "user", content });

function makeDeps(overrides = {}) {
  const calls = [];
  const deps = {
    readImage: async (r) => ({ ref: r, data: enc.encode("abc") }),
    recognize: async (source, question) => { calls.push({ source, question }); return "识别文本"; },
    cache: new Map(),
    maxImageBytes: 10 * 1024 * 1024,
    ...overrides,
  };
  return { deps, calls };
}

test("无图消息原样返回，changed=false，零请求", async () => {
  const { deps, calls } = makeDeps();
  const message = userMessage([textBlock("你好")]);
  const result = await convertMessagesWithImages([message], deps);
  assert.equal(result.changed, false);
  assert.equal(result.messages[0], message); // 同一引用，未克隆
  assert.equal(calls.length, 0);
});

test("非数组输入安全返回", async () => {
  const { deps } = makeDeps();
  const result = await convertMessagesWithImages(undefined, deps);
  assert.equal(result.changed, false);
  assert.deepEqual(result.messages, undefined);
});

test("单图 + 用户文本：question 传入识别，图片块替换、文本块保留", async () => {
  const { deps, calls } = makeDeps();
  const result = await convertMessagesWithImages([userMessage([imageBlock("a1"), textBlock("这张图里写了什么")])], deps);
  assert.equal(result.changed, true);
  const out = result.messages[0];
  assert.equal(out.content.length, 2);
  assert.equal(out.content[0].type, "text");
  assert.match(out.content[0].text, /^\[图片\] 识别结果：\n识别文本$/);
  assert.deepEqual(out.content[1], { type: "text", text: "这张图里写了什么" }); // 原文本保留，模型能看到用户的问题
  assert.equal(calls.length, 1);
  assert.match(calls[0].source, /^data:image\/png;base64,/);
  assert.equal(calls[0].question, "这张图里写了什么");
});

test("多图编号 [图片 1/2] [图片 2/2]；纯图消息用默认描述", async () => {
  const { deps, calls } = makeDeps();
  const result = await convertMessagesWithImages([userMessage([imageBlock("a1"), imageBlock("a2")])], deps);
  assert.equal(result.changed, true);
  const blocks = result.messages[0].content;
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].text, /^\[图片 1\/2\] 识别结果：/);
  assert.match(blocks[1].text, /^\[图片 2\/2\] 识别结果：/);
  assert.equal(calls.length, 2);
  assert.match(calls[0].question, /请描述这张图片/); // 无文本 → 默认
});

test("文本与图片混排时顺序保留", async () => {
  const { deps } = makeDeps();
  const result = await convertMessagesWithImages([userMessage([textBlock("前"), imageBlock("a1"), textBlock("后")])], deps);
  const types = result.messages[0].content.map((b) => b.type);
  assert.deepEqual(types, ["text", "text", "text"]);
  assert.match(result.messages[0].content[0].text, /^前$/);
  assert.match(result.messages[0].content[2].text, /^后$/);
});

test("识别失败降级为 [图片识别失败] 文本，不抛错", async () => {
  const { deps, calls } = makeDeps({
    recognize: async () => { calls.push({}); throw new Error("no api key"); }
  });
  const result = await convertMessagesWithImages([userMessage([imageBlock("a1")])], deps);
  assert.equal(result.changed, true);
  assert.match(result.messages[0].content[0].text, /^\[图片\] 识别结果：\n\[图片识别失败\] no api key/);
  assert.equal(calls.length, 1);
});

test("超过大小上限：不调 VLM，输出 [图片未识别] 提示", async () => {
  const { deps, calls } = makeDeps({ maxImageBytes: 2 });
  const result = await convertMessagesWithImages([userMessage([imageBlock("a1", { bytes: 100 })])], deps);
  assert.equal(result.changed, true);
  assert.match(result.messages[0].content[0].text, /\[图片未识别\] 图片 100 字节超过 2 字节上限/);
  assert.equal(calls.length, 0);
});

test("附件引用无效：降级文本，不调用任何 deps", async () => {
  const { deps, calls } = makeDeps();
  const result = await convertMessagesWithImages([userMessage([{ type: "image", attachment: { attachmentId: 42 } }])], deps);
  assert.equal(result.changed, true);
  assert.match(result.messages[0].content[0].text, /\[图片未识别\] 附件引用无效/);
  assert.equal(calls.length, 0);
});

test("readImage 返回裸 Uint8Array 也兼容", async () => {
  const { deps, calls } = makeDeps({ readImage: async () => enc.encode("abc") });
  const result = await convertMessagesWithImages([userMessage([imageBlock("a1")])], deps);
  assert.equal(result.changed, true);
  assert.match(calls[0].source, /^data:image\/png;base64,/);
});

test("缓存：同 attachmentId 第二次不重复调用 VLM", async () => {
  const { deps, calls } = makeDeps();
  const messages = [userMessage([imageBlock("a1")])];
  await convertMessagesWithImages(messages, deps);
  await convertMessagesWithImages(messages, deps); // 同一批消息再次 claim
  assert.equal(calls.length, 1);
});

test("多消息：只转换含图的消息", async () => {
  const { deps, calls } = makeDeps();
  const plain = userMessage([textBlock("普通消息")]);
  const result = await convertMessagesWithImages([plain, userMessage([imageBlock("b1")])], deps);
  assert.equal(result.changed, true);
  assert.equal(result.messages[0], plain); // 未动
  assert.equal(result.messages[1].content.length, 1);
  assert.equal(calls.length, 1);
});

// —— createLlmStreamHandler：llm/stream 拦截（识别结果不进 session/UI） ——
const MARKER = Symbol("dsh-vision.converted");
const message = (content) => ({ role: "user", content });
const img = (id = "a1") => ({ type: "image", attachment: ref(id) });

function makeHandler(overrides = {}) {
  const events = { next: 0, llm: 0 };
  const next = () => { events.next++; return (async function* () { yield "fallback-chunk"; })(); };
  const llm = {
    stream(options) {
      events.llm++;
      events.lastOptions = options;
      return (async function* () { yield "llm-chunk"; })();
    }
  };
  const deps = {
    convert: async (messages, signal) => ({ messages, changed: true }),
    getLlm: () => llm,
    markerKey: MARKER,
    ...overrides,
  };
  const handler = createLlmStreamHandler(deps);
  return { handler, events, next, llm };
}

const collect = async (stream) => { const out = []; for await (const chunk of stream) out.push(chunk); return out; };

test("handler：无图请求直接透传 next，零转换", async () => {
  const { handler, events, next } = makeHandler();
  const stream = handler({ messages: [message([textBlock("hi")])] }, next);
  assert.deepEqual(await collect(stream), ["fallback-chunk"]);
  assert.equal(events.next, 1);
  assert.equal(events.llm, 0);
});

test("handler：带防重入标记的请求直接透传 next", async () => {
  const { handler, events, next } = makeHandler();
  const stream = handler({ [MARKER]: true, messages: [message([img()])] }, next);
  assert.deepEqual(await collect(stream), ["fallback-chunk"]);
  assert.equal(events.next, 1);
  assert.equal(events.llm, 0);
});

test("handler：非对象 options 透传 next", async () => {
  const { handler, events, next } = makeHandler();
  const s1 = handler(null, next);
  const s2 = handler("x", next);
  assert.deepEqual(await collect(s1), ["fallback-chunk"]);
  assert.deepEqual(await collect(s2), ["fallback-chunk"]);
  assert.equal(events.next, 2);
});

test("handler：有图且转换 changed → 重入 llm.stream 带标记与新消息", async () => {
  const converted = [message([textBlock("[图片] 识别结果：\n描述")])];
  const { handler, events, next } = makeHandler({
    convert: async () => ({ messages: converted, changed: true })
  });
  const options = { provider: "deepseek", model: "v4-flash", messages: [message([img("x1")])] };
  const stream = handler(options, next);
  assert.deepEqual(await collect(stream), ["llm-chunk"]);
  assert.equal(events.next, 0); // 未走 fallback
  assert.equal(events.llm, 1);
  assert.equal(events.lastOptions[MARKER], true); // 防重入标记
  assert.equal(events.lastOptions.messages, converted); // 新消息
  assert.equal(events.lastOptions.provider, "deepseek"); // 其余字段保留
});

test("handler：转换 changed=false → yield* next（原消息回退）", async () => {
  const { handler, events, next } = makeHandler({
    convert: async () => ({ messages: [message([img()])], changed: false })
  });
  const stream = handler({ messages: [message([img()])] }, next);
  assert.deepEqual(await collect(stream), ["fallback-chunk"]);
  assert.equal(events.next, 1);
  assert.equal(events.llm, 0);
});

test("handler：convert 抛错 → 降级 yield* next，不中断对话", async () => {
  const { handler, events, next } = makeHandler({
    convert: async () => { throw new Error("no api key"); }
  });
  const stream = handler({ messages: [message([img()])] }, next);
  assert.deepEqual(await collect(stream), ["fallback-chunk"]);
  assert.equal(events.next, 1);
});

test("handler：llm 服务不可用 → yield* next", async () => {
  const { handler, events, next } = makeHandler({ getLlm: () => undefined });
  const stream = handler({ messages: [message([img()])] }, next);
  assert.deepEqual(await collect(stream), ["fallback-chunk"]);
  assert.equal(events.next, 1);
});

test("handler：supportsImages=true（原生多模态模型）→ 原图透传 next，不调 convert", async () => {
  let convertCalls = 0;
  const { handler, events, next } = makeHandler({
    convert: async () => { convertCalls++; return { messages: [], changed: true }; },
    supportsImages: async () => true,
  });
  const stream = handler({ provider: "pi-ai", model: "gpt-image", messages: [message([img("native")])] }, next);
  assert.deepEqual(await collect(stream), ["fallback-chunk"]);
  assert.equal(events.next, 1);
  assert.equal(events.llm, 0);
  assert.equal(convertCalls, 0);
});

test("handler：supportsImages=false（文本型模型）→ 走识别替换重入 llm.stream", async () => {
  let convertCalls = 0;
  const { handler, events, next } = makeHandler({
    convert: async () => { convertCalls++; return { messages: [message([textBlock("[图片] 识别结果")])], changed: true }; },
    supportsImages: async () => false,
  });
  const stream = handler({ provider: "deepseek", model: "v4-flash", messages: [message([img("t1")])] }, next);
  assert.deepEqual(await collect(stream), ["llm-chunk"]);
  assert.equal(events.llm, 1);
  assert.equal(convertCalls, 1);
});

test("handler：supportsImages 抛错 → 保守走识别替换", async () => {
  let convertCalls = 0;
  const { handler, events, next } = makeHandler({
    convert: async () => { convertCalls++; return { messages: [message([textBlock("识别")])], changed: true }; },
    supportsImages: async () => { throw new Error("resolve failed"); },
  });
  const stream = handler({ provider: "x", model: "y", messages: [message([img()])] }, next);
  assert.deepEqual(await collect(stream), ["llm-chunk"]);
  assert.equal(events.llm, 1);
  assert.equal(convertCalls, 1);
});

test("handler：未提供 supportsImages（默认）→ 走识别替换", async () => {
  let convertCalls = 0;
  const { handler, events, next } = makeHandler({
    convert: async () => { convertCalls++; return { messages: [message([textBlock("识别")])], changed: true }; },
  });
  const stream = handler({ messages: [message([img()])] }, next);
  assert.deepEqual(await collect(stream), ["llm-chunk"]);
  assert.equal(convertCalls, 1);
});

test("handler：识别期间 signal 传入 convert", async () => {
  let seenSignal;
  const { handler, events, next } = makeHandler({
    convert: async (messages, signal) => { seenSignal = signal; return { messages: messages.slice(), changed: true }; }
  });
  const signal = new AbortController().signal;
  await collect(handler({ messages: [message([img()])], signal }, next));
  assert.equal(seenSignal, signal);
  assert.equal(events.lastOptions.signal, signal); // 重入时 signal 保留
});

// —— 前端纯函数（复制自 lib/client.js；client 模块加载器不支持相对 require） ——
const TEXT_FILE_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "yml", "yaml",
  "xml", "html", "htm", "css", "scss", "less", "js", "mjs", "cjs", "ts",
  "jsx", "tsx", "py", "java", "c", "h", "cpp", "hpp", "cs", "go", "rs",
  "rb", "php", "sh", "bash", "zsh", "ps1", "bat", "cmd", "ini", "cfg",
  "conf", "log", "toml", "sql", "env", "svg", "diff", "patch", "vue",
  "svelte", "dockerfile", "makefile", "gemfile", "rakefile", "justfile",
  "license", "copying", "notice", "editorconfig", "properties", "proto", "graphql", "tex",
  "gitignore", "gitattributes", "npmrc"
]);
const PLAIN_NAME_TEXT = new Set([
  "dockerfile", "makefile", "gemfile", "rakefile", "justfile",
  "license", "copying", "notice", "readme", "changelog", "contributing"
]);
function fileExtension(name) {
  const base = String(name || "").toLowerCase();
  const i = base.lastIndexOf(".");
  if (i < 0) return base.startsWith(".") ? base.slice(1) : "";
  const ext = base.slice(i + 1);
  return ext === "" ? base.slice(1) : ext;
}
function classifyFile(file) {
  const type = String((file && file.type) || "");
  if (type.startsWith("image/")) return "image";
  const ext = fileExtension(file && file.name);
  if (TEXT_FILE_EXTENSIONS.has(ext)) return "text";
  const base = String((file && file.name) || "").toLowerCase();
  if (PLAIN_NAME_TEXT.has(base)) return "text";
  return "unsupported";
}
function looksBinary(data) {
  const n = Math.min(data.length, 512);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}
function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
async function readFileText(file) {
  if (file.size > 2 * 1024 * 1024) { const e = new Error("file-too-large"); e.fileName = file.name; throw e; }
  const buf = new Uint8Array(await file.arrayBuffer());
  if (looksBinary(buf)) { const e = new Error("binary-file"); e.fileName = file.name; throw e; }
  let text = new TextDecoder("utf-8").decode(buf);
  if (text.length > 64 * 1024) text = text.slice(0, 64 * 1024) + `\n…（内容过长已截断，原 ${buf.length} 字节）`;
  return text;
}
function buildAttachmentInsertion(file, text) {
  return `\n\n📎 附件：${file.name}（${formatBytes(file.size)}）\n---- 文件内容 ----\n${text}`;
}
const fakeFile = (name, { type = "", size = 0, bytes } = {}) => ({
  name, type, size,
  async arrayBuffer() { return Uint8Array.from(bytes || []).buffer; }
});

test("前端：classifyFile 图片/文本/未知分类", () => {
  assert.equal(classifyFile({ name: "a.png", type: "image/png" }), "image");
  assert.equal(classifyFile({ name: "a.PDF", type: "" }), "unsupported"); // pdf 不在白名单
  assert.equal(classifyFile({ name: "note.TXT", type: "text/plain" }), "text");
  assert.equal(classifyFile({ name: "main.js", type: "" }), "text");
  assert.equal(classifyFile({ name: "Dockerfile", type: "" }), "text");
  assert.equal(classifyFile({ name: ".gitignore", type: "" }), "text");
  assert.equal(classifyFile({ name: "archive.zip", type: "" }), "unsupported");
  assert.equal(classifyFile({ name: "x.bin", type: "application/octet-stream" }), "unsupported");
});

test("前端：fileExtension 边界", () => {
  assert.equal(fileExtension("a.tar.gz"), "gz");
  assert.equal(fileExtension(".gitignore"), "gitignore");
  assert.equal(fileExtension("NOEXT"), "");
  assert.equal(fileExtension(""), "");
});

test("前端：readFileText 读取/二进制检测/超限截断", async () => {
  const enc = new TextEncoder();
  assert.equal(await readFileText(fakeFile("a.txt", { size: 3, bytes: enc.encode("abc") })), "abc");
  await assert.rejects(readFileText(fakeFile("b.bin", { size: 4, bytes: [1, 0, 2, 3] })), (e) => e.message === "binary-file");
  await assert.rejects(readFileText(fakeFile("c.big", { size: 3 * 1024 * 1024, bytes: [1] })), (e) => e.message === "file-too-large");
  const long = enc.encode("x".repeat(70 * 1024));
  const out = await readFileText(fakeFile("d.txt", { size: long.length, bytes: long }));
  assert.ok(out.includes("…（内容过长已截断"));
  assert.ok(out.length <= 64 * 1024 + 64);
});

test("前端：buildAttachmentInsertion 结构", () => {
  const out = buildAttachmentInsertion({ name: "readme.md", size: 2048 }, "内容");
  assert.match(out, /^\n\n📎 附件：readme\.md（2\.0 KB）\n---- 文件内容 ----\n内容$/);
});

// —— wrapVisionAdapter / wrapVisionResolveModelInfo：prompt 入口 inputModalities
// 放行 + 原生能力记录（加 image 只由服务实例 wrap 负责，adapter wrap 只记录） ——
test("wrapAdapter：resolveModel 只记录不改，listModels 加 image", async () => {
  const native = new Map();
  const adapter = {
    resolveModel: async () => ({ model: "v4-flash", inputModalities: ["text"] }),
    listModels: async () => [{ model: "v4-flash", inputModalities: ["text"] }],
  };
  const wrapped = wrapVisionAdapter(adapter, "deepseek", native);
  assert.notEqual(wrapped, adapter);
  const info = await wrapped.resolveModel("deepseek", "v4-flash");
  assert.deepEqual(info.inputModalities, ["text"]); // 原样：加 image 由服务实例 wrap 负责
  assert.equal(native.get("deepseek\0v4-flash"), false); // 原生能力已记录
  const listed = await wrapped.listModels("deepseek");
  assert.deepEqual(listed[0].inputModalities, ["text", "image"]); // listModels 仅 UI 一致性
  // 原生 adapter 未被修改（原型继承）
  assert.deepEqual(await adapter.resolveModel("deepseek", "v4-flash"), { model: "v4-flash", inputModalities: ["text"] });
});

test("wrapAdapter：原生多模态模型原样返回并记录原生 true", async () => {
  const native = new Map();
  const adapter = {
    resolveModel: async () => ({ model: "gpt-image", inputModalities: ["text", "image"] }),
  };
  const wrapped = wrapVisionAdapter(adapter, "pi-ai", native);
  const info = await wrapped.resolveModel("pi-ai", "gpt-image");
  assert.deepEqual(info.inputModalities, ["text", "image"]);
  assert.equal(native.get("pi-ai\0gpt-image"), true);
});

test("wrapAdapter：inputModalities 未声明 → 原样返回并记录原生 false（保守）", async () => {
  const native = new Map();
  const adapter = { resolveModel: async () => ({ model: "x" }) };
  const wrapped = wrapVisionAdapter(adapter, "p", native);
  const info = await wrapped.resolveModel("p", "x");
  assert.deepEqual(info, { model: "x" });
  assert.equal(native.get("p\0x"), false);
});

test("wrapAdapter：幂等（已 wrap 的原引用返回）", async () => {
  const native = new Map();
  const adapter = { resolveModel: async () => ({ inputModalities: ["text"] }) };
  const once = wrapVisionAdapter(adapter, "p", native);
  const twice = wrapVisionAdapter(once, "p", native);
  assert.equal(once, twice);
  const twice2 = wrapVisionAdapter(adapter, "p", native); // 原始 adapter 无标记时会再包一层（防串）
  assert.notEqual(adapter, twice2);
});

test("wrapAdapter：与第三方 wrap 链式兼容（不污染 thinking 注入）", async () => {
  const native = new Map();
  const base = {
    resolveModel: async () => ({ model: "m", inputModalities: ["text"], reasoning: { efforts: ["off", "high"] } }),
  };
  const thinkingWrapped = Object.create(base);
  thinkingWrapped.__dshThirdPartyThinkingWrapped = true;
  thinkingWrapped.resolveModel = async (p, m, s) => ({ ...await base.resolveModel(p, m, s), reasoning: { efforts: ["off", "high", "max"] } });
  const visionWrapped = wrapVisionAdapter(thinkingWrapped, "deepseek", native);
  const info = await visionWrapped.resolveModel("deepseek", "m");
  assert.deepEqual(info.inputModalities, ["text"]); // 记录不改
  assert.deepEqual(info.reasoning.efforts, ["off", "high", "max"]); // thinking 注入保留
  assert.equal(native.get("deepseek\0m"), false);
});

test("wrapAdapter：resolveModel 抛错时原生传播，不写缓存", async () => {
  const native = new Map();
  const adapter = { resolveModel: async () => { throw new Error("NO_ADAPTER"); } };
  const wrapped = wrapVisionAdapter(adapter, "p", native);
  await assert.rejects(wrapped.resolveModel("p", "m"), /NO_ADAPTER/);
  assert.equal(native.has("p\0m"), false); // 异常不写缓存 → llm/stream 拦截保守识别
});

// —— wrapVisionResolveModelInfo：服务实例方法 wrap（prompt 入口放行的可靠路径） ——
test("wrapService：text-only 模型加 image 并记录原生 false", async () => {
  const native = new Map();
  const service = {
    resolveModelInfo: async (provider, model) => ({ model, inputModalities: ["text"] }),
  };
  const restore = wrapVisionResolveModelInfo(service, native);
  assert.equal(typeof restore, "function");
  const info = await service.resolveModelInfo("deepseek", "v4-flash");
  assert.deepEqual(info.inputModalities, ["text", "image"]); // 放行 host prompt 检查
  assert.equal(native.get("deepseek\0v4-flash"), false);
});

test("wrapService：原生多模态原样返回并记录 true", async () => {
  const native = new Map();
  const service = {
    resolveModelInfo: async (provider, model) => ({ model, inputModalities: ["text", "image"] }),
  };
  wrapVisionResolveModelInfo(service, native);
  const info = await service.resolveModelInfo("pi-ai", "gpt-image");
  assert.deepEqual(info.inputModalities, ["text", "image"]);
  assert.equal(native.get("pi-ai\0gpt-image"), true);
});

test("wrapService：inputModalities 未声明 → 原样（host 检查本就跳过）并记录 false", async () => {
  const native = new Map();
  const service = { resolveModelInfo: async () => ({ model: "x" }) };
  wrapVisionResolveModelInfo(service, native);
  const info = await service.resolveModelInfo("p", "x");
  assert.deepEqual(info, { model: "x" });
  assert.equal(native.get("p\0x"), false);
});

test("wrapService：this 绑定保持（服务方法内部用 this）", async () => {
  const native = new Map();
  const service = {
    baseModalities: ["text"],
    resolveModelInfo(provider, model) {
      return { model, inputModalities: this.baseModalities };
    },
  };
  wrapVisionResolveModelInfo(service, native);
  const info = await service.resolveModelInfo("p", "m");
  assert.deepEqual(info.inputModalities, ["text", "image"]);
});

test("wrapService：幂等（第二次调用返回 undefined，行为不叠加）", async () => {
  const native = new Map();
  const service = { resolveModelInfo: async () => ({ inputModalities: ["text"] }) };
  assert.equal(typeof wrapVisionResolveModelInfo(service, native), "function");
  assert.equal(wrapVisionResolveModelInfo(service, native), undefined);
  const info = await service.resolveModelInfo("p", "m");
  assert.deepEqual(info.inputModalities, ["text", "image"]); // 只加一次
});

test("wrapService：restore 恢复原方法（own property 与原型方法两种形态）", async () => {
  const native = new Map();
  // own property 形态
  const own = { resolveModelInfo: async () => ({ inputModalities: ["text"] }) };
  const r1 = wrapVisionResolveModelInfo(own, native);
  assert.equal((await own.resolveModelInfo("p", "m")).inputModalities.length, 2);
  r1();
  assert.equal((await own.resolveModelInfo("p", "m")).inputModalities.length, 1); // 已恢复
  assert.equal(own.__dshVisionResolveWrapped, undefined);
  // 原型方法形态：恢复后 own property 被删除，回退原型
  class ServiceClass {
    async resolveModelInfo() { return { inputModalities: ["text"] }; }
  }
  const proto = new ServiceClass();
  const r2 = wrapVisionResolveModelInfo(proto, native);
  assert.ok(Object.prototype.hasOwnProperty.call(proto, "resolveModelInfo"));
  r2();
  assert.ok(!Object.prototype.hasOwnProperty.call(proto, "resolveModelInfo")); // 回退原型
  assert.deepEqual((await proto.resolveModelInfo("p", "m")).inputModalities, ["text"]);
});

test("wrapService：无 resolveModelInfo 方法 → undefined 不抛错", () => {
  const native = new Map();
  assert.equal(wrapVisionResolveModelInfo({}, native), undefined);
  assert.equal(wrapVisionResolveModelInfo(undefined, native), undefined);
});

// —— 总开关（enabled）：默认值 / 读写往返 / 关闭时各面停用 ——
test("Config：enabled 默认 true（不破坏既有用户）", () => {
  assert.equal(Config({}).enabled, true); // 无存储节 → schema 默认开
  assert.equal(Config({ baseURL: "https://x" }).enabled, true); // 其它字段存在亦然
});

test("Config：enabled 读写往返（存 false 读 false，再存 true 读 true）", () => {
  // 模拟 settings 用户文档节的往返：存储只落用户覆盖字段。
  let stored = {};
  const write = (patch) => { stored = { ...stored, ...patch }; };
  const read = () => Config(stored);
  assert.equal(read().enabled, true); // 初始：无覆盖 → 默认开
  write({ enabled: false });
  assert.equal(read().enabled, false); // 关 → 落盘 → 读回 false
  assert.equal(read().model, "glm-4.6v-flash"); // 开关与 VLM 配置互不干扰
  write({ enabled: true });
  assert.equal(read().enabled, true); // 再开 → 读回 true（往返闭合）
  // JSON 序列化往返（YAML/JSON 存储同构）
  assert.equal(Config(JSON.parse(JSON.stringify({ enabled: false }))).enabled, false);
});

test("handler：isEnabled=false → 完全透明（透传 next，不识别不重入）", async () => {
  let convertCalls = 0;
  let supportsCalls = 0;
  const { handler, events, next } = makeHandler({
    isEnabled: () => false,
    convert: async () => { convertCalls++; return { messages: [], changed: true }; },
    supportsImages: async () => { supportsCalls++; return false; },
  });
  const stream = handler({ provider: "deepseek", model: "v4-flash", messages: [message([img("t1")])] }, next);
  assert.deepEqual(await collect(stream), ["fallback-chunk"]);
  assert.equal(events.next, 1); // 走原始链
  assert.equal(events.llm, 0); // 未重入
  assert.equal(convertCalls, 0); // 未识别
  assert.equal(supportsCalls, 0); // 连原生能力判定都跳过
});

test("handler：isEnabled 热切换（关→开往返，同一次注册）", async () => {
  let enabled = false;
  let convertCalls = 0;
  const { handler, events, next } = makeHandler({
    isEnabled: () => enabled,
    convert: async (messages) => { convertCalls++; return { messages: messages.slice(), changed: true }; },
  });
  const options = { messages: [message([img()])] };
  assert.deepEqual(await collect(handler(options, next)), ["fallback-chunk"]); // 关：透传
  enabled = true;
  assert.deepEqual(await collect(handler(options, next)), ["llm-chunk"]); // 开：识别替换
  assert.equal(events.llm, 1);
  assert.equal(convertCalls, 1);
});

test("wrapService：isEnabled=false → 不加 image（host 门槛将按原样拒绝）", async () => {
  const native = new Map();
  const service = {
    resolveModelInfo: async (provider, model) => ({ model, inputModalities: ["text"] }),
  };
  wrapVisionResolveModelInfo(service, native, () => false);
  const info = await service.resolveModelInfo("deepseek", "v4-flash");
  assert.deepEqual(info.inputModalities, ["text"]); // 原样：vision admission 不生效
  assert.equal(native.get("deepseek\0v4-flash"), false); // 原生能力仍记录（缓存保温）
});

test("wrapService：isEnabled 热切换往返（同一次 wrap 内关→开）", async () => {
  const native = new Map();
  let enabled = false;
  const service = {
    resolveModelInfo: async (provider, model) => ({ model, inputModalities: ["text"] }),
  };
  wrapVisionResolveModelInfo(service, native, () => enabled);
  assert.deepEqual((await service.resolveModelInfo("p", "m")).inputModalities, ["text"]); // 关
  enabled = true;
  assert.deepEqual((await service.resolveModelInfo("p", "m")).inputModalities, ["text", "image"]); // 开
});

test("wrapAdapter：isEnabled=false → listModels 不加 image；原生多模态行不动", async () => {
  const native = new Map();
  const adapter = {
    resolveModel: async () => ({ model: "v4-flash", inputModalities: ["text"] }),
    listModels: async () => [
      { model: "v4-flash", inputModalities: ["text"] },
      { model: "native-vlm", inputModalities: ["text", "image"] },
    ],
  };
  const wrapped = wrapVisionAdapter(adapter, "deepseek", native, () => false);
  const listed = await wrapped.listModels("deepseek");
  assert.deepEqual(listed[0].inputModalities, ["text"]); // 关：UI 一致性声明也停
  assert.deepEqual(listed[1].inputModalities, ["text", "image"]); // 本就支持的行不受影响
  const info = await wrapped.resolveModel("deepseek", "v4-flash");
  assert.deepEqual(info.inputModalities, ["text"]); // resolveModel 本就只记录不改
  assert.equal(native.get("deepseek\0v4-flash"), false); // 记录照常
});
