'use strict';

/**
 * 社区 bundle 顺序检测与重排（参考 dsh-market/src/order.ts，issue #98 思路，
 * 适配 DSH Desktop 的 bundle 解析语义）。
 *
 * 官方内置 bundle（@deepseek-ai/dsh-base、@deepseek-ai/dsh-web-app、
 * @deepseek-ai/dsh-headless）位置固定：不参与重排、不被增删。
 * 只读函数不写任何文件；applyBundleOrder 是唯一写入口（原子写 + 失败回滚）。
 */

const path = require('node:path');

/** 官方内置 bundle：位置固定不可动。 */
const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
]);

/**
 * 官方判定（与 desktop-validity 语义一致）：@deepseek-ai/* 全部视为官方
 * （INBOX 之外的官方包同样不可重排），社区 = 其余。
 */
function isOfficialBundle(name) {
  return typeof name === 'string' && (name.startsWith('@deepseek-ai/') || INBOX_BUNDLES.has(name));
}

/**
 * 读取 profile 的 bundle 栈。
 * @param {string} profileDir
 * @param {object} fs
 * @returns {{ bundles: string[], community: string[], error?: string }}
 */
function readBundleStack(profileDir, fs = require('node:fs')) {
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  } catch (err) {
    return { bundles: [], community: [], error: `profile package.json 缺失或不可读: ${(err && err.message) || err}` };
  }
  const bundles = (manifest && manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles))
    ? manifest.dsh.profile.bundles.filter((n) => typeof n === 'string')
    : [];
  return { bundles, community: bundles.filter((n) => !isOfficialBundle(n)) };
}

/**
 * 按 boot 语义解析 bundle 包位置：profile node_modules → 官方核心目录
 * （app node_modules/@deepseek-ai，含 @deepseek-ai/ 前缀剥离）→ 内置配套 assets/plugins。
 * @param {string} profileDir
 * @param {string} name bundle 包名
 * @param {object} fs
 * @param {object|null} opts { coreDirDshAt, assetsDir }
 * @returns {string|null} 包目录（含 package.json），未找到返回 null
 */
function resolveBundlePackageDir(profileDir, name, fs = require('node:fs'), opts = {}) {
  const candidates = [path.join(profileDir, 'node_modules', ...name.split('/'))];
  if (opts.coreDirDshAt) {
    const short = name.startsWith('@deepseek-ai/') ? name.slice('@deepseek-ai/'.length) : name;
    candidates.push(path.join(opts.coreDirDshAt, ...short.split('/')));
  }
  if (opts.assetsDir) candidates.push(path.join(opts.assetsDir, ...name.split('/')));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return null;
}

/**
 * 读取每个 bundle 声明的排序规则（package.json 的 dsh.bundle.order.{before,after}）。
 * 无法解析的包或缺省声明不产生规则。
 * @param {string} profileDir
 * @param {object} fs
 * @param {object|null} opts
 * @returns {Array<{name:string, after:string[], before:string[]}>}
 */
function readBundleRules(profileDir, fs = require('node:fs'), opts = {}) {
  const { bundles } = readBundleStack(profileDir, fs);
  const rules = [];
  for (const name of bundles) {
    const dir = resolveBundlePackageDir(profileDir, name, fs, opts);
    if (!dir) continue;
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
    const order = manifest && manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.order;
    if (!order || typeof order !== 'object' || Array.isArray(order)) continue;
    const listOf = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    const rule = { name, after: listOf(order.after), before: listOf(order.before) };
    if (rule.after.length > 0 || rule.before.length > 0) rules.push(rule);
  }
  return rules;
}

/**
 * 检查 bundle 顺序是否满足声明的 before/after 规则。规则里提到
 * 不在 order 中的包被忽略（未安装包的规则不得阻塞当前栈）。
 * @param {string[]} bundleNames
 * @param {Array<{name:string, after:string[], before:string[]}>} rules
 * @returns {Array<{name:string, reason:string}>}
 */
function validateOrder(bundleNames, rules) {
  const position = new Map(bundleNames.map((name, index) => [name, index]));
  const conflicts = [];
  for (const rule of rules) {
    const pos = position.get(rule.name);
    if (pos === undefined) continue;
    for (const other of rule.after || []) {
      const otherPos = position.get(other);
      if (otherPos === undefined) continue;
      if (otherPos >= pos) {
        conflicts.push({ name: rule.name, reason: `必须晚于 ${other} 加载，但 ${other} 当前在前（位置 ${otherPos} vs ${pos}）` });
      }
    }
    for (const other of rule.before || []) {
      const otherPos = position.get(other);
      if (otherPos === undefined) continue;
      if (otherPos <= pos) {
        conflicts.push({ name: rule.name, reason: `必须早于 ${other} 加载，但 ${other} 当前在后（位置 ${otherPos} vs ${pos}）` });
      }
    }
  }
  return conflicts;
}

/**
 * 按 before/after 规则 + 插件依赖拓扑排序社区 bundle（LOOT 式自动修复）。
 * Kahn 算法 + 稳定 tie-break（沿用当前清单顺序）。只移动满足约束所必需的
 * 条目，避免无约束时把用户手工顺序改成字母序。
 * @param {string[]} bundleNames
 * @param {Array<{name:string, after:string[], before:string[]}>} rules
 * @param {Array<{from:string, to:string}>} dependencyEdges 「from 依赖 to」⇒ to 必须先于 from
 * @returns {{ok:true, order:string[]}|{ok:false, cycle:string[]}}
 */
function suggestOrder(bundleNames, rules, dependencyEdges = []) {
  const names = bundleNames.filter((n) => !isOfficialBundle(n));
  const inOrder = new Set(names);
  const inputPosition = new Map(names.map((name, index) => [name, index]));
  const active = rules.filter((r) => inOrder.has(r.name));
  // 约束「a 必须先于 b」（a.before 或 b.after）→ 边 a → b
  const beforeOf = new Map(); // name → 必须在其后的集合
  const deps = new Map(); // name → 必须先于其的集合
  for (const name of names) { beforeOf.set(name, new Set()); deps.set(name, new Set()); }
  const addEdge = (a, b) => {
    if (!inOrder.has(a) || !inOrder.has(b) || a === b) return;
    beforeOf.get(a).add(b);
    deps.get(b).add(a);
  };
  for (const rule of active) {
    for (const other of rule.before || []) addEdge(rule.name, other);
    for (const other of rule.after || []) addEdge(other, rule.name);
  }
  for (const edge of dependencyEdges) addEdge(edge.to, edge.from);
  const remaining = new Map();
  for (const [name, depsOf] of deps) remaining.set(name, new Set(depsOf));
  const ready = names.filter((name) => (remaining.get(name) ? remaining.get(name).size : 0) === 0);
  const ordered = [];
  while (ready.length > 0) {
    let best = 0;
    for (let i = 1; i < ready.length; i += 1) {
      if (inputPosition.get(ready[i]) < inputPosition.get(ready[best])) best = i;
    }
    const name = ready.splice(best, 1)[0];
    ordered.push(name);
    for (const dependent of beforeOf.get(name) || []) {
      const depsOf = remaining.get(dependent);
      if (!depsOf) continue;
      depsOf.delete(name);
      if (depsOf.size === 0 && !ordered.includes(dependent) && !ready.includes(dependent)) ready.push(dependent);
    }
  }
  if (ordered.length < names.length) {
    return { ok: false, cycle: names.filter((n) => !ordered.includes(n)) };
  }
  return { ok: true, order: ordered };
}

/**
 * 收集社区 bundle 间的依赖边：某 bundle 的 dependencies/peerDependencies
 * 键名命中另一个社区 bundle → {from, to}。
 * @param {string} profileDir
 * @param {object} fs
 * @param {object|null} opts
 * @returns {Array<{from:string, to:string}>}
 */
function collectDependencyEdges(profileDir, fs = require('node:fs'), opts = {}) {
  const { bundles, community } = readBundleStack(profileDir, fs);
  const communitySet = new Set(community);
  const edges = [];
  for (const name of bundles) {
    const dir = resolveBundlePackageDir(profileDir, name, fs, opts);
    if (!dir) continue;
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
    const depNames = Object.keys(manifest.dependencies || {}).concat(Object.keys(manifest.peerDependencies || {}));
    for (const dep of depNames) {
      if (dep !== name && communitySet.has(dep)) edges.push({ from: name, to: dep });
    }
  }
  return edges;
}

/**
 * 把社区 bundle 顺序写回 profile package.json 的 dsh.profile.bundles。
 * 官方 bundle 保持原位；communityOrder 必须是当前社区集合的排列（同集合校验），
 * 否则拒绝。原子写（tmp + rename），写失败时原文件不受影响。
 * @param {string} profileDir
 * @param {string[]} communityOrder
 * @param {object} fs
 * @returns {{ok:boolean, bundles?:string[], changed?:boolean, error?:string}}
 */
function applyBundleOrder(profileDir, communityOrder, fs = require('node:fs')) {
  const { bundles, community, error: readError } = readBundleStack(profileDir, fs);
  if (readError) return { ok: false, error: readError };
  const currentSet = new Set(community);
  const nextSet = new Set(communityOrder);
  const hasDup = (arr) => new Set(arr).size !== arr.length;
  if (hasDup(community) || hasDup(communityOrder)) {
    return { ok: false, error: 'bundle 清单存在重复项，已拒绝写入' };
  }
  if (communityOrder.length !== community.length || community.some((n) => !nextSet.has(n)) || communityOrder.some((n) => !currentSet.has(n))) {
    return { ok: false, error: '重排清单与当前社区 bundle 集合不一致，已拒绝写入' };
  }
  // 官方 bundle 保持原位：按当前位置插入社区子序列
  const newBundles = [];
  let ci = 0;
  for (const name of bundles) {
    if (isOfficialBundle(name)) {
      newBundles.push(name);
    } else {
      newBundles.push(communityOrder[ci]);
      ci += 1;
    }
  }
  if (newBundles.join('\u0000') === bundles.join('\u0000')) {
    return { ok: true, bundles: bundles, changed: false };
  }
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  } catch (err) {
    return { ok: false, error: `无法读取 package.json: ${(err && err.message) || err}` };
  }
  if (!manifest.dsh) manifest.dsh = {};
  if (!manifest.dsh.profile) manifest.dsh.profile = {};
  manifest.dsh.profile.bundles = newBundles;
  const file = path.join(profileDir, 'package.json');
  const tmp = file + '.dsh-order-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  try {
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, error: `写入失败: ${(err && err.message) || err}` };
  }
  return { ok: true, bundles: newBundles, changed: true };
}

module.exports = {
  INBOX_BUNDLES,
  isOfficialBundle,
  readBundleStack,
  resolveBundlePackageDir,
  readBundleRules,
  validateOrder,
  suggestOrder,
  collectDependencyEdges,
  applyBundleOrder,
};
