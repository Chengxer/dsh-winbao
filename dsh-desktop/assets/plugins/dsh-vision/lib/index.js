/**
 * dsh-vision: eyes for a text-only model. Registers a `view_image` tool that
 * forwards the model's question about an image to an OpenAI-compatible VLM
 * endpoint and returns the answer as text. Backend is fully configurable —
 * Zhipu's free glm-4.6v-flash (default), DashScope, Ark, a local Ollama, or
 * DeepSeek's own vision API the day it ships (users' existing key then just works).
 *
 * Multimodal-feel layer: images the user attaches directly to a message
 * (composer attach button / paste / drop) are intercepted at the
 * `agent/pre-step` boundary and replaced with their VLM recognition text
 * BEFORE the conversation reaches the (text-only) LLM adapter — sending a
 * picture feels like a multimodal model, and the recognition stays in the
 * background. Recognition failures degrade to an explanatory text block and
 * never block the conversation.
 * @module dsh-vision
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { visionChat } from './vlm.js';
export const name = 'dsh-vision';
export const inject = ['tools', 'systemPrompt', 'settings'];
const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
/** Zhipu's free tier gets congested (HTTP 429 code 1305); older free models still answer. */
const DEFAULT_FREE_FALLBACKS = ['glm-4.1v-thinking-flash', 'glm-4v-flash'];
/** Errors worth trying the next model for: rate limit, missing model, server trouble. */
const RETRIABLE = /returned (?:429|404|5\d\d)/;
/**
 * Zhipu's older free vision models cap max_tokens at 1024 (HTTP 400 code 1210
 * "max_tokens参数非法"). The plugin default is 2048 (tuned for glm-4.6v-flash),
 * so a stored config that selects a legacy model 400s on every call and the
 * fallback chain never runs (400 is not in RETRIABLE). Clamp the budget for
 * these models instead of forcing users to know per-model limits.
 */
const LEGACY_1K_CAP_MODELS = new Set(['glm-4v-flash', 'glm-4.1v-thinking-flash']);
/**
 * Any HTTP 400 from the endpoint may be a max_tokens-over-cap rejection (Zhipu
 * replies "code 1210 max_tokens参数非法"; the body wording can change, and the
 * code may be the only stable signal). Matching plain `returned 400` keeps the
 * downgrade retry working even if the message text drifts — the cost of one
 * extra request is far lower than silently missing the rejection.
 */
const MAX_TOKENS_REJECTED = /returned 400/;
export const Config = z.object({
    baseURL: z.string().default(DEFAULT_BASE_URL)
        .description('OpenAI-compatible endpoint base URL (…/chat/completions is appended)'),
    apiKey: z.string().role('secret').default('')
        .description('API key; falls back to $DSH_VISION_API_KEY, then $ZHIPUAI_API_KEY / $DASHSCOPE_API_KEY'),
    model: z.string().default('glm-4.6v-flash')
        .description('Vision model id at the endpoint, e.g. glm-4.6v-flash (free) / glm-4.6v / qwen3-vl-flash / qwen3.7-plus / qwen3-vl:4b'),
    fallbackModels: z.array(z.string()).default([])
        .description('Models tried in order when the primary returns 429/404/5xx; defaults to Zhipu free-tier chain when baseURL is the default'),
    maxTokens: z.number().step(1).min(1).max(32_768).default(2048),
    timeoutMs: z.number().step(1).min(1_000).max(300_000).default(60_000),
    maxImageBytes: z.number().step(1).min(1).default(10 * 1024 * 1024),
});
const NS = settingsNamespace('dsh-vision');
// 配置的 getter；setSource 会被替换为 settings scope 读取器（热生效）。
let liveConfig = () => ({});

const PROMPT_TEXT = `## Vision (view_image)
The chat model itself cannot see images, but the view_image tool can. Whenever an image matters — a screenshot path the user mentions, an image URL, a chart, a UI mockup — call view_image instead of guessing or refusing. Ask it a specific question (extract text, count objects, read a chart, describe the layout); it answers arbitrary questions, not just captions. Prefer one focused call per thing you need to know; ask a follow-up call rather than one vague question.
Images the user attaches to a message are recognized automatically in the background and arrive as "[图片] 识别结果" text blocks — treat them as ordinary text context (the image itself never reaches the model).`;
const TEXT_OUTPUT = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
};

/**
 * Cache cap for per-attachment recognition text. A turn re-claims messages on
 * later steps and the same attachment can legitimately recur across a long
 * session; caching the text avoids re-calling the VLM for the same bytes,
 * while the cap keeps memory bounded.
 */
const IMAGE_TEXT_CACHE_LIMIT = 64;

/**
 * Ask the configured VLM chain one question about one image (primary model,
 * then fallbacks on 429/404/5xx, plus the 1024-token downgrade retry for
 * legacy models). Reused by both the `view_image` tool and the automatic
 * attach-image recognition.
 * @param resolved - effective config from {@link current}.
 * @param apiKey - resolved key ('' for keyless local endpoints).
 * @param source - image as http(s)/data: URL (auto path already base64s bytes).
 * @param question - what to find out about the image.
 * @param signal - turn cancellation.
 * @returns the recognition text.
 * @throws the last error when every model failed.
 */
export async function recognizeWithFallbacks(resolved, apiKey, source, question, signal) {
    let lastError;
    for (const model of [resolved.model, ...resolved.fallbackModels]) {
        try {
            return await visionChat({ ...resolved, model, apiKey, source, question, signal });
        }
        catch (error) {
            lastError = error;
            if (!(error instanceof Error)) throw error;
            // 400（可能是 max_tokens 超上限，如智谱 code 1210）：降档到 1024
            // 重试同一模型一次，而不是直接放弃——fallback 链只对 429/404/5xx 生效。
            if (MAX_TOKENS_REJECTED.test(error.message) && resolved.maxTokens > 1024) {
                try {
                    return await visionChat({ ...resolved, model, apiKey, source, question, maxTokens: 1024, signal });
                }
                catch (error2) {
                    lastError = error2;
                    if (!(error2 instanceof Error) || !RETRIABLE.test(error2.message)) throw error2;
                    continue;
                }
            }
            if (!RETRIABLE.test(error.message)) throw error;
        }
    }
    throw lastError;
}

/**
 * Recognize one image block into text. NEVER throws: every failure (invalid
 * ref, oversized image, attachment store outage, VLM error, abort) degrades
 * to an explanatory text block so the conversation always proceeds.
 * @param block - the image content block ({type:'image', attachment: ref}).
 * @param question - user message text ('' when the message is image-only).
 * @param deps - { readImage, recognize, signal, maxImageBytes, cache }.
 */
async function describeImageBlock(block, question, deps) {
    const ref = block && block.attachment;
    if (!ref || typeof ref !== 'object' || typeof ref.attachmentId !== 'string' || typeof ref.mediaType !== 'string') {
        return '[图片未识别] 附件引用无效，该图片被跳过。';
    }
    const cache = deps.cache;
    if (cache) {
        const cached = cache.get(ref.attachmentId);
        if (cached !== undefined) return cached;
    }
    let text;
    try {
        const maxBytes = typeof deps.maxImageBytes === 'number' ? deps.maxImageBytes : 10 * 1024 * 1024;
        if (typeof ref.bytes === 'number' && ref.bytes > maxBytes) {
            text = `[图片未识别] 图片 ${ref.bytes} 字节超过 ${maxBytes} 字节上限（可在识图插件设置中调大 maxImageBytes）。`;
        }
        else {
            const { readImage, recognize } = deps;
            const read = await readImage(ref, deps.signal);
            const data = read && read.data instanceof Uint8Array ? read.data : read;
            if (!(data instanceof Uint8Array)) throw new Error('附件读取未返回图像字节');
            const source = `data:${ref.mediaType};base64,${Buffer.from(data).toString('base64')}`;
            const questionText = typeof question === 'string' && question.trim() !== ''
                ? question
                : '请描述这张图片：包括所有可见文字（逐字）、整体布局与值得注意的细节。';
            text = await recognize(source, questionText, deps.signal);
        }
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        text = `[图片识别失败] ${reason}（已跳过该图片，其余对话不受影响）。`;
    }
    if (cache) {
        if (cache.size >= IMAGE_TEXT_CACHE_LIMIT) cache.clear();
        cache.set(ref.attachmentId, text);
    }
    return text;
}

/**
 * Replace every image block in the claimed messages with its recognition
 * text. Pure over the injected deps, so it is unit-testable without cordis.
 * Messages without images pass through untouched (changed=false, zero cost).
 * @param messages - claimed message array (agent/pre-step payload.messages).
 * @param deps - { readImage(ref, signal), recognize(source, question, signal),
 *   signal?, maxImageBytes?, cache? (Map)}.
 * @returns { messages, changed }.
 */
export async function convertMessagesWithImages(messages, deps) {
    if (!Array.isArray(messages)) return { messages, changed: false };
    let changed = false;
    const out = [];
    for (const message of messages) {
        if (!message || !Array.isArray(message.content)) {
            out.push(message);
            continue;
        }
        const imageBlocks = message.content.filter((b) => b && b.type === 'image');
        if (imageBlocks.length === 0) {
            out.push(message);
            continue;
        }
        changed = true;
        // 用户消息里的文本部分就是识别问题（贴合「这张图里写了什么」这类问法）。
        const question = message.content
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('')
            .trim();
        const blocks = [];
        let index = 0;
        for (const block of message.content) {
            if (!block || block.type !== 'image') {
                blocks.push(block);
                continue;
            }
            index += 1;
            const label = imageBlocks.length > 1 ? `[图片 ${index}/${imageBlocks.length}]` : '[图片]';
            const description = await describeImageBlock(block, question, deps);
            blocks.push({ type: 'text', text: `${label} 识别结果：\n${description}` });
        }
        out.push({ ...message, content: blocks });
    }
    return { messages: out, changed };
}

export function apply(ctx, config) {
    liveConfig = () => config || {};
    // settings 已在本插件 inject 中声明，apply 时服务必在；直接同步注册并
    // try/catch：存储的 dsh-vision 配置节非法会让 register() 抛异常 → 插件
    // fiber 失败 → dsh fail-loud 启动崩溃。降级为组合配置继续运行（不阻断启动）。
    try {
        const scope = ctx.settings.register(NS, Config, { base: config || {} });
        liveConfig = () => scope.get();
        scope.watch(() => {
            const cfg = liveConfig() || {};
            console.log("[dsh-vision] settings updated: " + JSON.stringify({ baseURL: cfg.baseURL, model: cfg.model, apiKey: cfg.apiKey ? "***" : "" }));
        });
    } catch (error) {
        console.warn("[dsh-vision] settings section unavailable (invalid stored config); falling back to composition config: " + ((error && error.message) || error));
    }
    // 每次调用都从热配置计算，设置页保存后无需重启服务即可生效。
    const current = () => {
        const cfg = liveConfig() || {};
        const baseURL = cfg.baseURL ?? DEFAULT_BASE_URL;
        const model = cfg.model ?? "glm-4.6v-flash";
        const fallbackModels = Array.isArray(cfg.fallbackModels) && cfg.fallbackModels.length > 0
            ? cfg.fallbackModels
            : baseURL === DEFAULT_BASE_URL && model === "glm-4.6v-flash" ? DEFAULT_FREE_FALLBACKS : [];
        // 旧模型（glm-4v-flash 等）max_tokens 上限 1024：默认 2048 必然 400，直接钳制。
        const maxTokens = LEGACY_1K_CAP_MODELS.has(model)
            ? Math.min(cfg.maxTokens ?? 2048, 1024)
            : cfg.maxTokens ?? 2048;
        return {
            baseURL,
            model,
            fallbackModels,
            maxTokens,
            timeoutMs: cfg.timeoutMs ?? 60_000,
            maxImageBytes: cfg.maxImageBytes ?? 10 * 1024 * 1024,
        };
    };
    // Key is resolved per call, not at mount: the plugin loads fine without one
    // and the tool explains exactly where to put it. Local endpoints need none.
    const resolveApiKey = () => {
        const cfg = liveConfig() || {};
        const resolved = current();
        const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(resolved.baseURL);
        const key = cfg.apiKey !== undefined && cfg.apiKey !== "" ? cfg.apiKey
            : process.env.DSH_VISION_API_KEY ?? process.env.ZHIPUAI_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? "";
        if (key === "" && !isLocal) {
            throw new Error("view_image: no API key. Set the dsh-vision apiKey in Settings, or export DSH_VISION_API_KEY (also honored: ZHIPUAI_API_KEY, DASHSCOPE_API_KEY). The default model glm-4.6v-flash is FREE — create a key at https://open.bigmodel.cn. Offline alternative: baseURL http://localhost:11434/v1 + an Ollama vision model, no key needed.");
        }
        return key;
    };
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'view_image',
        description: 'Look at an image and answer a question about it (OCR, counting, chart reading, layout, arbitrary visual questions). Accepts an absolute local file path, an http(s) URL, or a data: URL.',
        parameters: {
            source: {
                type: 'string',
                required: true,
                description: 'The image: absolute local file path, http(s) URL, or data: URL',
            },
            question: {
                type: 'string',
                description: 'What to find out about the image. Be specific. Default: a thorough general description including any visible text.',
            },
        },
        output: TEXT_OUTPUT,
        timeoutMs: current().timeoutMs,
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const input = args;
            const source = typeof input.source === 'string' ? input.source : '';
            if (source === '')
                throw new Error('view_image: source is required');
            const question = typeof input.question === 'string' && input.question !== ''
                ? input.question
                : 'Describe this image thoroughly. Include any visible text verbatim, the overall layout, and notable details.';
            return recognizeWithFallbacks(current(), resolveApiKey(), source, question, exec.signal);
        },
    })), 'dsh-vision.tool');
    ctx.effect(() => ctx.systemPrompt.section({
        name: 'tool:dsh-vision',
        order: 116,
        text: PROMPT_TEXT,
    }), 'dsh-vision.prompt');
    // —— 多模态体感：用户直接发图 → 后台 VLM 识别后以文本送入纯文本模型 ——
    // agent/pre-step 是每次 step 前的 waterfall（payload={messages, turn, step,
    // signal}）；监听器返回新 payload 即整体覆盖（非 reject 即 enter）。只在
    // 有 image block 时才改写，否则 next(payload) 零开销放行。{global:true} 让
    // 本插件（非 agent 作用域）也能收到 agent 作用域事件（与 llm/stream 同款）。
    // 识别结果按 attachmentId 缓存（同图跨步/跨轮不重复请求 VLM）。
    const imageTextCache = new Map();
    ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
        const messages = payload && Array.isArray(payload.messages) ? payload.messages : null;
        if (!messages) return next(payload);
        let attachments;
        try { attachments = ctx.attachments; } catch { attachments = undefined; }
        const converted = await convertMessagesWithImages(messages, {
            readImage: async (ref, signal) => {
                if (!attachments || typeof attachments.readImage !== 'function') {
                    throw new Error('附件存储服务不可用（attachments.readImage 缺失）');
                }
                return attachments.readImage(ref, signal);
            },
            recognize: (source, question, signal) =>
                recognizeWithFallbacks(current(), resolveApiKey(), source, question, signal),
            signal: payload.signal,
            cache: imageTextCache,
            maxImageBytes: current().maxImageBytes,
        });
        if (!converted.changed) return next(payload);
        return { ...payload, messages: converted.messages };
    }, { global: true, prepend: true }), 'dsh-vision.agent-pre-step');
}
