'use strict';

// pi-ai opencode-go 模型目录补丁单元测试（node --test）。
// 覆盖：一次应用（克隆基型 + image 输入 + 格式保持）、二次幂等、上游已收录
// 自然退役、锚点缺失 / 非法 JSON 跳过且字节级不损坏、目录缺失静默、dry-run
// 不落盘、stats 计数。
// 用法：node --test scripts/test/unit-patch-pi-ai-opencode-go-models.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  patchPiAiOpencodeGoModels,
  transformCatalog,
  MODEL_ID,
  BASE_MODEL_ID,
  CATALOG_REL,
} = require('../patch-pi-ai-opencode-go-models');

/** 与 pi-ai 上游 generate-models 产物同构的最小 opencode-go.json（紧凑 + 尾换行）。 */
function fixtureCatalog() {
  return JSON.stringify({
    'anthropic-messages': {
      'minimax-m3': {
        id: 'minimax-m3', name: 'MiniMax-M3', api: 'anthropic-messages',
        provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go',
        reasoning: true, input: ['text', 'image'],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
        contextWindow: 1000000, maxTokens: 131072,
      },
    },
    'openai-completions': {
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', api: 'openai-completions',
        provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1',
        reasoning: true, input: ['text'],
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
        compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens', requiresReasoningContentOnAssistantMessages: true, thinkingFormat: 'deepseek' },
        contextWindow: 1000000, maxTokens: 384000,
        thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
      },
      'deepseek-v4-pro': {
        id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', api: 'openai-completions',
        provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1',
        reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 384000,
      },
    },
  }) + '\n';
}

function buildFakeTree(t, initial) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ocg-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, CATALOG_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, initial);
  return { root, file };
}

test('补丁脚本：一次应用补入 vision-exp，克隆基型并追加 image 输入', (t) => {
  const tree = buildFakeTree(t, fixtureCatalog());
  const n = patchPiAiOpencodeGoModels(tree.root);
  assert.strictEqual(n, 1, '应补丁 1 个文件');
  const patched = JSON.parse(fs.readFileSync(tree.file, 'utf8'));
  const group = patched['openai-completions'];
  const vision = group[MODEL_ID];
  assert.ok(vision, '应补入 ' + MODEL_ID);
  assert.strictEqual(vision.id, MODEL_ID);
  assert.strictEqual(vision.name, 'DeepSeek V4 Flash Vision Exp');
  assert.deepStrictEqual(vision.input, ['text', 'image'], 'vision 变体应可收图');
  const base = group[BASE_MODEL_ID];
  // 容量 / 计费 / compat / thinkingLevelMap 沿用基型。
  assert.strictEqual(vision.contextWindow, base.contextWindow);
  assert.strictEqual(vision.maxTokens, base.maxTokens);
  assert.deepStrictEqual(vision.cost, base.cost);
  assert.deepStrictEqual(vision.compat, base.compat);
  assert.deepStrictEqual(vision.thinkingLevelMap, base.thinkingLevelMap);
  // 基型与其它分组不受影响。
  assert.strictEqual(base.name, 'DeepSeek V4 Flash');
  assert.deepStrictEqual(base.input, ['text']);
  assert.ok(patched['anthropic-messages']['minimax-m3']);
  // 格式保持：紧凑 JSON + 尾换行（与上游产物一致）。
  assert.ok(fs.readFileSync(tree.file, 'utf8').endsWith('}\n'));
});

test('补丁脚本：二次应用幂等（零写入且内容不变）', (t) => {
  const tree = buildFakeTree(t, fixtureCatalog());
  assert.strictEqual(patchPiAiOpencodeGoModels(tree.root), 1);
  const once = fs.readFileSync(tree.file, 'utf8');
  assert.strictEqual(patchPiAiOpencodeGoModels(tree.root), 0, '第二次应零写入');
  assert.strictEqual(fs.readFileSync(tree.file, 'utf8'), once, '内容不应变化');
});

test('补丁脚本：上游已收录时自然退役（不覆盖上游自己的条目）', (t) => {
  const catalog = JSON.parse(fixtureCatalog());
  const upstream = {
    id: MODEL_ID, name: 'Upstream Shipped', api: 'openai-completions',
    provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1',
    input: ['text', 'image'], contextWindow: 42,
  };
  catalog['openai-completions'][MODEL_ID] = upstream;
  const tree = buildFakeTree(t, JSON.stringify(catalog) + '\n');
  assert.strictEqual(patchPiAiOpencodeGoModels(tree.root), 0, '已存在应跳过');
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(tree.file, 'utf8'))['openai-completions'][MODEL_ID],
    upstream,
    '上游条目应原样保留',
  );
});

test('补丁脚本：锚点缺失（无基型条目）跳过且字节级不损坏', (t) => {
  const catalog = JSON.parse(fixtureCatalog());
  delete catalog['openai-completions'][BASE_MODEL_ID];
  const tree = buildFakeTree(t, JSON.stringify(catalog) + '\n');
  const before = fs.readFileSync(tree.file);
  const stats = { anchorMissing: 0, failed: 0 };
  assert.strictEqual(patchPiAiOpencodeGoModels(tree.root, () => {}, stats), 0);
  assert.deepStrictEqual(fs.readFileSync(tree.file), before, '文件字节级不变');
  assert.strictEqual(stats.anchorMissing, 1, '锚点失效应计数');
});

test('补丁脚本：非法 JSON 跳过且字节级不损坏', (t) => {
  const tree = buildFakeTree(t, '{"openai-completions": [broken');
  const before = fs.readFileSync(tree.file);
  const stats = { anchorMissing: 0, failed: 0 };
  assert.strictEqual(patchPiAiOpencodeGoModels(tree.root, () => {}, stats), 0);
  assert.deepStrictEqual(fs.readFileSync(tree.file), before, '文件字节级不变');
  assert.strictEqual(stats.anchorMissing, 1);
});

test('补丁脚本：pi-ai 未安装的根目录静默返回 0', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ocg-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.strictEqual(patchPiAiOpencodeGoModels(root), 0);
});

test('补丁脚本：dry-run 不落盘', (t) => {
  const tree = buildFakeTree(t, fixtureCatalog());
  const before = fs.readFileSync(tree.file);
  assert.strictEqual(patchPiAiOpencodeGoModels(tree.root, () => {}, undefined, { dryRun: true }), 0);
  assert.deepStrictEqual(fs.readFileSync(tree.file), before, 'dry-run 不应写文件');
});

test('transformCatalog：分组结构变化按 anchor-missing 处理', () => {
  assert.strictEqual(transformCatalog('{"openai-responses":{"grok-4.5":{}}}\n').status, 'anchor-missing');
  assert.strictEqual(transformCatalog('[]\n').status, 'anchor-missing');
  assert.strictEqual(transformCatalog(fixtureCatalog()).status, 'changed');
});
