// dsh-vision 图片自动识别（agent/pre-step 转换）单测。
// 运行：node --test scripts/test/unit-dsh-vision.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertMessagesWithImages } from "../../assets/plugins/dsh-vision/lib/index.js";

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
