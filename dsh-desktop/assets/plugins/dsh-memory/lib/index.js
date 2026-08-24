/**
 * @dsh-external/dsh-memory — DSH 记忆库（v3）：
 *   - 工具：memory_read / memory_write / memory_search（语义+关键词）/ memory_summarize
 *   - 自动：会话开始把 core.md+index 注入提示词（systemPrompt.context）
 *   - 自动：会话结束（session/disposed）自动写一条 history（无需 agent 自觉）
 *   - 语义后端（可插拔）：① U盘便携 transformers.js（纯 WASM 跨平台，进程内）
 *                         ② 本地 text2vec(:8188)  ③ 失败退化为关键词
 *   - 路径由环境变量驱动（Linux/Windows 盘符不同也可用）：
 *       DSH_MEMORY_ROOT（默认 /media/.../data/memory）
 *       DSH_EMBEDDING_ROOT（默认 /media/.../data/embedding）
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const MEMORY_ROOT = process.env.DSH_MEMORY_ROOT || '/media/chengxerxes/DSHPORTABLE/data/memory';
const EMB_ROOT = process.env.DSH_EMBEDDING_ROOT || '/media/chengxerxes/DSHPORTABLE/data/embedding';
const EMB_URL = 'http://127.0.0.1:8188/v1/embeddings';
const EMB_MODEL = 'shibing624/text2vec-base-chinese';

function toText(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return [{ type: 'text', text: s }];
}
function safePath(rel) {
  let p = String(rel || '').trim();
  p = p.replace(/^\.\//, '').replace(/\.md$/i, '');
  if (!p) p = 'index';
  if (p.split('/').includes('..')) throw new Error('invalid memory path (no traversal)');
  if (p.includes('\\')) throw new Error('invalid memory path');
  return join(MEMORY_ROOT, ...p.split('/')) + '.md';
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// —— U盘便携 transformers.js（纯 WASM，跨平台，进程内，懒加载）——
let _embedder = null;
async function getEmbedder() {
  if (_embedder) return _embedder;
  const { env, pipeline } = await import('file://' + EMB_ROOT + '/node_modules/@huggingface/transformers/src/transformers.js');
  env.backends.onnx.backend = 'wasm';
  env.backends.onnx.wasm.wasmPaths = 'file://' + EMB_ROOT + '/node_modules/onnxruntime-web/dist/';
  env.cacheDir = EMB_ROOT + '/models';
  env.remoteHost = 'https://hf-mirror.com';
  _embedder = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { dtype: 'q8' });
  return _embedder;
}
async function embedBatch(texts) {
  try {
    const pipe = await getEmbedder();
    const out = await pipe(texts, { pooling: 'mean', normalize: true });
    const dim = out.dims[out.dims.length - 1];
    const d = out.data;
    const vecs = [];
    for (let i = 0; i < d.length; i += dim) vecs.push(Array.from(d.slice(i, i + dim)));
    return vecs;
  } catch (e) {
    const res = await fetch(EMB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMB_MODEL, input: texts }),
    });
    if (!res.ok) throw new Error('embed HTTP ' + res.status);
    return (await res.json()).data.map((d) => d.embedding);
  }
}
async function listMd(dir) {
  const t = join(MEMORY_ROOT, dir);
  try { return (await readdir(t)).filter((n) => n.endsWith('.md')); } catch (e) { return []; }
}
async function readDoc(rel) {
  const p = rel === 'core' || rel === 'index' || rel === 'README' ? join(MEMORY_ROOT, rel + '.md') : safePath(rel);
  try { return await readFile(p, 'utf8'); } catch (e) { return undefined; }
}

export default {
  name: 'dsh-memory',
  apply(ctx) {
    const tools = ctx.get('tools');
    if (tools === undefined) return;

    // 自动1：会话提示词注入 core + index
    const systemPrompt = ctx.get('systemPrompt');
    if (systemPrompt !== undefined) {
      let coreText = '';
      readFile(join(MEMORY_ROOT, 'core.md'), 'utf8')
        .then((c) => readFile(join(MEMORY_ROOT, 'index.md'), 'utf8').then((i) => { coreText = c + '\n\n## 记忆索引\n' + i; }))
        .catch(() => { coreText = ''; });
      const dispose = systemPrompt.context({
        name: 'dsh-memory-core',
        order: 400,
        text: () => coreText,
      });
      ctx.effect(() => dispose);
    }

    // 自动2：会话结束自动写 history
    ctx.on('session/disposed', (session) => {
      (async () => {
        try {
          const id = (session && (session.id || session.sessionId)) || 'unknown';
          const title = (session && (session.title || session.header && session.header.title)) || '';
          const date = new Date().toISOString().slice(0, 10);
          const slug = (title ? String(title).replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 30) : 'session') || 'session';
          const entry = '# ' + date + ' ' + (title || '会话结束') + '\n\n' +
            '- session: ' + id + '\n' +
            '- 记录: 自动（session/disposed）\n' +
            '- 说明: 本会话已结束，要点可用 memory_search 回溯；如需沉淀教训写 lessons/。\n';
          const p = join(MEMORY_ROOT, 'history', date + '-' + slug + '.md');
          await mkdir(dirname(p), { recursive: true });
          await writeFile(p, entry, 'utf8');
          console.log('[dsh-memory] auto history written: ' + p);
        } catch (e) {
          console.error('[dsh-memory] auto history failed: ' + (e && e.message));
        }
      })();
    });

    function reg(name, description, parameters, outputSchema, execute) {
      const dispose = tools.register(defineTool({
        name, description, parameters,
        output: { schema: outputSchema, render: (args, value) => toText(value) },
        execute,
      }));
      ctx.effect(() => dispose);
      console.log('[dsh-memory] registered: ' + name);
    }

    reg('memory_read', '从 DSH 记忆库读取文件。path 用记忆库内相对路径（如 core、notes/xxx、lessons/xxx、history/xxx），自动补 .md。',
      { path: { type: 'string', required: true, description: '记忆库内相对路径，如 core' } },
      { type: 'object', additionalProperties: true, properties: { found: { type: 'boolean' }, path: { type: 'string' }, content: { type: 'string' }, hint: { type: 'string' } } },
      async (args) => {
        const content = await readDoc(args.path);
        return content === undefined ? { found: false, path: args.path, hint: '未找到，可先 memory_search' } : { found: true, path: args.path, content };
      });

    reg('memory_write', '写入 DSH 记忆库。path 为记忆库内相对路径（如 notes/xxx、lessons/YYYY-MM-DD-xxx、history/YYYY-MM-DD-xxx、core）。mode=replace 覆盖 / append 追加。',
      {
        path: { type: 'string', required: true, description: '相对路径（自动补 .md）' },
        content: { type: 'string', required: true, description: '要写入的内容' },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'replace 覆盖 / append 追加（默认）' },
      },
      { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, path: { type: 'string' }, mode: { type: 'string' }, chars: { type: 'number' } } },
      async (args) => {
        const p = safePath(args.path);
        const mode = args.mode === 'replace' ? 'replace' : 'append';
        let content;
        if (mode === 'replace') content = String(args.content);
        else {
          let existing = '';
          try { existing = await readFile(p, 'utf8'); } catch (e) { /* new */ }
          content = existing + (existing && !existing.endsWith('\n') ? '\n' : '') + String(args.content) + '\n';
        }
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, content, 'utf8');
        return { ok: true, path: args.path, mode, chars: content.length };
      });

    reg('memory_search', '按语义或关键词搜索 DSH 记忆库，返回最相关的记忆文件与摘要（先用 U盘便携 embedding 做语义匹配，失败退回本地/关键词）。',
      { query: { type: 'string', required: true, description: '搜索内容' } },
      { type: 'object', additionalProperties: true, properties: { query: { type: 'string' }, count: { type: 'number' }, semantic: { type: 'boolean' }, results: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
      async (args) => {
        const q = String(args.query || '').toLowerCase();
        const docs = [];
        for (const dir of [null, 'notes', 'lessons', 'history']) {
          const files = dir === null ? ['core.md', 'index.md', 'README.md'] : await listMd(dir);
          for (const f of files) {
            const rel = dir === null ? f : dir + '/' + f;
            const content = await readDoc(rel);
            if (content !== undefined) docs.push({ path: rel.replace(/\.md$/, ''), content });
          }
        }
        let semantic = false, scored;
        try {
          const texts = [args.query].concat(docs.map((d) => d.content.slice(0, 2000)));
          const vecs = await embedBatch(texts);
          const qv = vecs[0];
          scored = docs.map((d, i) => ({ d, score: cosine(qv, vecs[i + 1]) }));
          semantic = true;
        } catch (e) {
          scored = docs.map((d) => ({ d, score: 0 }));
        }
        const ranked = scored.map(({ d, score }) => {
          let s = score;
          if (d.path.toLowerCase().includes(q) || d.content.toLowerCase().includes(q)) s += 1;
          return { path: d.path, score: +s.toFixed(3), chars: d.content.length, snippet: d.content.slice(0, 160).replace(/\s+/g, ' ') };
        }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);
        return { query: args.query, count: ranked.length, semantic, results: ranked };
      });

    reg('memory_summarize', '为指定记忆库文件或当前会话生成一条历史摘要（写入 history/）。主要用于会话结束时的沉淀。',
      { title: { type: 'string', description: '摘要标题（可选，默认当前时间）' }, body: { type: 'string', description: '要点正文（可选；不填则只建骨架）' } },
      { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, path: { type: 'string' } } },
      async (args) => {
        const date = new Date().toISOString().slice(0, 10);
        const slug = (args.title ? String(args.title).replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 30) : 'summary') || 'summary';
        const p = join(MEMORY_ROOT, 'history', date + '-' + slug + '.md');
        const content = '# ' + date + ' ' + (args.title || '会话摘要') + '\n\n' + (args.body || '（骨架，待补充要点）') + '\n';
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, content, 'utf8');
        return { ok: true, path: p.replace(MEMORY_ROOT + '/', '') };
      });
  },
};
