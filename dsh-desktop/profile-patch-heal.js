'use strict';

// profile cordis.patch.yml 的「重复 loader 条目」识别与自愈核心（纯函数、无
// electron 依赖，便于 node:test 单测）。
//
// 背景（issue #17）：旧版本（如 v0.3.4）的插件安装路径会向 cordis.patch.yml
// 写入与桌面端配套插件相同的 `- insert: - id: balance` 条目，同一 id 出现
// 两次。cordis loader 装配时抛
//   duplicate loader entry id: balance
//   或 failed to apply loader entry <hash> (@scope/pkg): list slot ... already
//   has an entry with id ... at priority 0
// 且该存量状态无法自愈，用户「进不来主界面」。这里提供：
//   · dedupePatchEntries —— 块级按 id 去重（只整块删除「后出现且全部 id 均
//     已出现过」的顶层条目，绝不改动块内部行，防止行级手术破坏 YAML）；
//   · parseFailedLoaderIds —— 识别 loader 失败日志中的三种 id 形态
//     （旧 hash 形态 / duplicate loader entry id: X 形态 / 括号包名形态）；
//   · mapPackagesToPatchIds —— 把括号中的包名映射回 patch 条目 id
//     （供安全启动 overlay 兜底禁用）。

/**
 * 移除顶层条目中「按 id 重复」的后出现条目（issue #17 存量自愈）。
 * 只做块级判断与整块删除；块内（同一 insert 内）的重复 id 属更罕见形态，
 * 不在本函数内行级手术，交由安全启动 overlay 兜底。
 * @param {string} text cordis.patch.yml 原文
 * @returns {{ text: string, removed: string[] }} 修复后的文本与被移除的重复 id；
 *   无重复时返回原文本与空数组（零写入）。
 */
function dedupePatchEntries(text) {
  const lines = text.split(/\r?\n/);
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^-(\s|$)/.test(lines[i])) starts.push(i);
  }
  if (starts.length < 2) return { text, removed: [] };
  const seen = new Set();
  const removed = [];
  const keep = [];
  if (starts[0] > 0) keep.push([0, starts[0]]); // 文件头注释等前置内容
  for (let s = 0; s < starts.length; s += 1) {
    const begin = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const block = lines.slice(begin, end).join('\n');
    const ids = [...block.matchAll(/(?:^|\n)\s*-\s*id:\s*([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    if (ids.length === 0) { keep.push([begin, end]); continue; } // 无 id 的条目原样保留
    const dups = ids.filter((id) => seen.has(id));
    if (dups.length === ids.length) {
      // 该块声明的 id 全部已出现过：整块移除（后出现的注册是冲突源）。
      removed.push(...dups);
      continue;
    }
    // 块内仍有新 id：保留整块；块内的部分重复不在此手术（极端形态由
    // 安全启动 overlay 兜底），但已见过的 id 仍计入，避免后续块再撞。
    for (const id of ids) seen.add(id);
    keep.push([begin, end]);
  }
  if (removed.length === 0) return { text, removed };
  const out = [];
  for (const [b, e] of keep) out.push(...lines.slice(b, e));
  return { text: out.join('\n'), removed };
}

/**
 * 移除「已迁移为 bundle 的插件」在 patch 层残留的旧注册条目（双登记自愈）。
 * 旧版本客户端把某些配套插件当非 bundle 写入 cordis.patch.yml（insert 块）；
 * 插件升级为 bundle（经 dsh.profile.bundles 装配）后，残留行会让 cordis loader
 * 抛 `duplicate loader entry id: X` 且整树加载失败（更新后首次启动崩溃的根因）。
 *
 * 处理规则（块级优先、行级兜底）：
 *   · 顶层条块声明的 id 全部命中移除集 → 整块删除（含块头注释之外的块内行）；
 *   · insert 块内仅部分 id 命中 → 只删除命中的「- id: X」行及其同缩进兄弟行
 *     （name 等），其余条目原样保留 —— 绝不整块误删；
 *   · 其余内容（注释/空行/非命中条目）原样保留。
 * 无命中时返回原文本（零写入）。
 * @param {string} text cordis.patch.yml 原文
 * @param {string[]} ids 需要从 patch 层移除的 loader id 集合
 * @returns {{ text: string, removed: string[] }} 修复后的文本与被移除的 id
 */
function dropBlocksByIds(text, ids) {
  const removal = new Set((ids || []).filter((i) => typeof i === 'string' && i));
  if (removal.size === 0) return { text, removed: [] };
  const lines = text.split(/\r?\n/);
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^-(\s|$)/.test(lines[i])) starts.push(i);
  }
  if (starts.length === 0) return { text, removed: [] };
  const idRe = /^\s*-\s*id:\s*([A-Za-z0-9_-]+)/;
  const removed = [];
  const out = [];
  if (starts[0] > 0) out.push(...lines.slice(0, starts[0])); // 文件头注释等
  for (let s = 0; s < starts.length; s += 1) {
    const begin = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const block = lines.slice(begin, end);
    const idRows = block
      .map((line, idx) => ({ line, idx, m: idRe.exec(line) }))
      .filter((r) => r.m !== null)
      .map((r) => ({ ...r, id: r.m[1] }));
    const hitIds = idRows.filter((r) => removal.has(r.id)).map((r) => r.id);
    if (hitIds.length === 0) { out.push(...block); continue; }
    if (hitIds.length === idRows.length) {
      // 全部命中：整块删除。
      removed.push(...hitIds);
      continue;
    }
    // 部分命中：行级删除命中的「- id: X」行及其同缩进兄弟行（name 等），
    // 保留块内其余条目。兄弟行判定：缩进大于 id 行、且不以「- 」开头。
    const keep = block.map((line) => ({ line, drop: false }));
    for (const r of idRows) {
      if (!removal.has(r.id)) continue;
      removed.push(r.id);
      const indent = /^\s*/.exec(r.line)[0].length;
      keep[r.idx].drop = true;
      let j = r.idx + 1;
      while (j < block.length) {
        const l = block[j];
        const li = /^\s*/.exec(l)[0].length;
        if (l.trim() === '' || (li > indent && !/^\s*-\s+/.test(l))) { keep[j].drop = true; j += 1; continue; }
        break;
      }
    }
    for (const k of keep) if (!k.drop) out.push(k.line);
  }
  if (removed.length === 0) return { text, removed };
  return { text: out.join('\n'), removed };
}

/**
 * 从 dsh-web.log 尾部识别 loader 失败条目 id。覆盖三种形态：
 *   1. failed to apply loader entry <hash> (@scope/pkg): ...（旧形态，hash 是
 *      条目实例 id，对 overlay 无用但保留兼容）；
 *   2. duplicate loader entry id: X（cordis-plugin-loader 的重复注册 TypeError）；
 *   3. 括号中的包名 @scope/pkg（交由 mapPackagesToPatchIds 映射回 patch id）。
 * @param {string} text 日志文本
 * @returns {string[]} 去重后的 id/包名 token 列表
 */
function parseFailedLoaderIds(text) {
  const ids = new Set();
  const hashRe = /failed to apply loader entry\s+([A-Za-z0-9_-]+)\s*\(/g;
  let m;
  while ((m = hashRe.exec(text)) !== null) {
    if (m[1] !== 'include') ids.add(m[1]);
  }
  const dupRe = /duplicate loader entry id:\s*([A-Za-z0-9_-]+)/g;
  while ((m = dupRe.exec(text)) !== null) ids.add(m[1]);
  const pkgRe = /failed to apply loader entry[\s\S]{0,120}?\((@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\)/g;
  while ((m = pkgRe.exec(text)) !== null) ids.add(m[1]);
  return [...ids];
}

/**
 * 把 loader 日志中的包名（@scope/pkg）映射回 cordis.patch.yml 条目 id。
 * 按「- id: X 之后紧邻的 name: '包名'」扫描；一个包名可能对应多个条目
 * （重复注册场景），全部返回供 overlay 一并禁用。
 * @param {string} patchText cordis.patch.yml 原文
 * @param {string[]} packages 包名列表（可含 @scope/）
 * @returns {string[]} 匹配到的 patch 条目 id
 */
function mapPackagesToPatchIds(patchText, packages) {
  const wanted = new Set((packages || []).filter((p) => typeof p === 'string' && p));
  if (wanted.size === 0) return [];
  const ids = [];
  const entryRe = /(?:^|\n)\s*-\s*id:\s*([A-Za-z0-9_-]+)([\s\S]*?)(?=(?:\n\s*-\s*id:)|\n\s*-\s+(?:insert|id)|\s*$)/g;
  let m;
  while ((m = entryRe.exec(patchText)) !== null) {
    const id = m[1];
    const body = m[2];
    const nameRe = /(?:^|\n)\s*name:\s*['"]?(@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)['"]?/g;
    let nm;
    while ((nm = nameRe.exec(body)) !== null) {
      if (wanted.has(nm[1])) ids.push(id);
    }
  }
  return ids;
}

module.exports = { dedupePatchEntries, dropBlocksByIds, parseFailedLoaderIds, mapPackagesToPatchIds };
