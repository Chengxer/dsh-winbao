import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

/**
 * dsh-plugin-marketplace — host half.
 *
 * Runs inside the `dsh web` process. Exposes the `pluginMarketplace` Typert
 * Remote the settings tab drives: browse/search npm for dsh plugins and
 * install/uninstall them into the current web profile (the same destination
 * the CLI's `dsh plugin --profile web add <pkg>` manages, but driven from
 * the settings page and executed with the bundled npm).
 *
 * Activation model (why a restart is needed):
 *   - a bundle package (declares dsh.bundle.patch) joins dsh.profile.bundles;
 *   - any other package (client-only or host-only plugin) gets an idempotent
 *     row inserted into the profile's cordis.patch.yml;
 * both take effect when dsh web next boots (the desktop's "restart service"
 * button restarts it in place).
 */

const PROFILE_NAME = "web";
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 60 * 1000;
const OUTPUT_CAP = 65536;

/** The harness home the host booted with (same rule dsh itself uses). */
function homeDir() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/** The web profile directory: $DSH_HOME/profiles/web. */
function profileDir() {
	return join(homeDir(), "profiles", PROFILE_NAME);
}

function manifestPath() {
	return join(profileDir(), "package.json");
}

function patchPath() {
	return join(profileDir(), "cordis.patch.yml");
}

/** Absolute directory a profile-installed package resolves to (scoped-aware). */
function packageDir(name) {
	return join(profileDir(), "node_modules", ...name.split("/"));
}

/**
 * The npm CLI to drive. Prefer the bundled copy beside the bundled node
 * runtime (packaged: resources/npm; dev: vendor/npm) and fall back to npm on
 * PATH when that copy is absent.
 */
function npmCommand() {
	const bundled = join(dirname(process.execPath), "..", "npm", "bin", "npm-cli.js");
	if (existsSync(bundled)) return { file: process.execPath, prefix: [bundled], shell: false };
	return { file: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [], shell: true };
}

/**
 * Run one npm invocation in the profile directory, collecting capped output.
 * @param args - npm arguments after the CLI script.
 * @param timeoutMs - hard timeout; resolves with a timed-out settlement.
 * @returns settlement { code, stdout, stderr, error?, timedOut? }.
 */
function runNpm(args, timeoutMs) {
	return new Promise((resolve) => {
		const cmd = npmCommand();
		const child = spawn(cmd.file, [...cmd.prefix, ...args], {
			cwd: profileDir(),
			env: process.env,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			shell: cmd.shell
		});
		const out = { stdout: "", stderr: "" };
		const feed = (key) => (chunk) => {
			const text = chunk.toString();
			const keep = OUTPUT_CAP - out[key].length;
			if (keep > 0) out[key] += text.slice(0, keep);
		};
		child.stdout.on("data", feed("stdout"));
		child.stderr.on("data", feed("stderr"));
		let settled = false;
		const settle = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		const timer = setTimeout(() => {
			try { child.kill(); } catch {}
			settle({ code: null, stdout: out.stdout, stderr: out.stderr, timedOut: true, error: "npm 执行超时" });
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			settle({ code: null, stdout: out.stdout, stderr: out.stderr, error: String((error && error.message) || error) });
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			settle({ code, stdout: out.stdout, stderr: out.stderr });
		});
	});
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** Snapshot of what the web profile currently has installed (user-managed). */
function snapshot() {
	const dir = profileDir();
	const manifest = existsSync(manifestPath()) ? readJson(manifestPath()) : {};
	const dependencies = manifest.dependencies ?? {};
	const bundles = manifest.dsh?.profile?.bundles ?? [];
	const plugins = [];
	for (const name of Object.keys(dependencies)) {
		let version = "";
		let isBundle = false;
		let isClient = false;
		try {
			const pkg = readJson(join(packageDir(name), "package.json"));
			version = pkg.version ?? "";
			isBundle = pkg.dsh?.bundle?.patch !== undefined;
			isClient = pkg.dsh?.client?.platform === "web";
		} catch {}
		plugins.push({
			name,
			version: version || String(dependencies[name] ?? "").replace(/^[\^~]/, ""),
			isBundle,
			isClient,
			inBundles: bundles.includes(name)
		});
	}
	plugins.sort((a, b) => a.name.localeCompare(b.name));
	return { profileDir: dir, bundles, plugins };
}

/** Row-id slug for packages this plugin manages in cordis.patch.yml. */
function slugOf(name) {
	return name.replace(/^@/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
}

/**
 * Idempotently add a loader row for a non-bundle plugin package.
 * @returns whether the patch file changed.
 */
function ensureRow(name) {
	const path = patchPath();
	let text = existsSync(path) ? readFileSync(path, "utf8") : "[]\n";
	if (text.includes(`name: '${name}'`) || text.includes(`name: "${name}"`)) return false;
	const id = `pm-${slugOf(name)}`;
	const block = `- insert:\n    - id: ${id}\n      name: '${name}'\n`;
	if (/^\s*\[\]\s*$/m.test(text)) text = text.replace(/\[\]/m, block);
	else text = text.replace(/\s+$/, "") + "\n" + block;
	writeFileSync(path, text);
	return true;
}

/** Remove the row this plugin added for a package (exact block match). */
function removeRow(name) {
	const path = patchPath();
	if (!existsSync(path)) return;
	const text = readFileSync(path, "utf8");
	const id = `pm-${slugOf(name)}`;
	const block = `- insert:\n    - id: ${id}\n      name: '${name}'\n`;
	if (!text.includes(block)) return;
	writeFileSync(path, text.split(block).join(""));
}

/** Validate and normalize a package name from the wire. */
function validName(value) {
	const name = String(value ?? "").trim();
	if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) throw new Error(`无效的包名 ${JSON.stringify(name)}`);
	return name;
}

/**
 * Normalize an install spec from the wire: an npm package name, or a git
 * source (`github:owner/repo#branch` / `git+https://github.com/owner/repo#branch`).
 * @returns { {kind:"npm"|"github", spec:string, repo?:string} }
 */
function validSpec(value) {
	const spec = String(value ?? "").trim();
	if (/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(spec)) return { kind: "npm", spec };
	const git = spec.match(/^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#.+)?$/);
	if (git) return { kind: "github", spec, repo: git[1] };
	throw new Error(`不支持的插件来源 ${JSON.stringify(spec)}`);
}

/** First useful npm failure text (stderr wins, then stdout, then the code). */
function npmFailure(run, verb) {
	return (run.error || run.stderr || run.stdout || `npm ${verb} 失败 (exit ${run.code})`).trim().slice(0, 800);
}

// --- multi-source discovery (npm registry + GitHub topic + deepseekdocs) ----

const GITHUB_SEARCH_URL = "https://api.github.com/search/repositories";
const GITHUB_TOPIC = "dsh-plugin";
const DEEPSEEKDOCS_ECOSYSTEM_URL = "https://deepseekdocs.com/ecosystem";
const FETCH_TIMEOUT_MS = 15000;
const SOURCE_LABELS = { npm: "npm", github: "GitHub", deepseekdocs: "deepseekdocs" };

/** In-memory cache for remote catalog fetches (GitHub rate-limit / mirror cost). */
const fetchCache = new Map();

function fetchWithTimeout(url, headers) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	return fetch(url, { headers, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function fetchJson(url) {
	const res = await fetchWithTimeout(url, { "User-Agent": "dsh-desktop-marketplace", Accept: "application/json" });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
	return await res.json();
}

async function fetchText(url) {
	const res = await fetchWithTimeout(url, { "User-Agent": "dsh-desktop-marketplace", Accept: "text/html" });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
	return await res.text();
}

async function cachedFetch(key, ttlMs, fetcher) {
	const hit = fetchCache.get(key);
	if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
	const value = await fetcher();
	fetchCache.set(key, { at: Date.now(), ttl: ttlMs, value });
	return value;
}

/**
 * Normalize a discovery record into a marketplace card, tagging the source and
 * the installable spec (`spec` may be an npm name or a git source).
 */
function toCard(record, byName) {
	const hit = record.source === "npm" ? byName.get(record.name) : null;
	return {
		name: record.name,
		source: record.source,
		sourceLabel: SOURCE_LABELS[record.source] || record.source,
		spec: record.spec,
		version: record.version || "",
		description: record.description || "",
		date: record.date || null,
		license: record.license || "",
		links: record.links || {},
		stars: record.stars || 0,
		category: record.category || "插件",
		installed: hit === undefined ? null : { version: hit.version, isBundle: hit.isBundle, isClient: hit.isClient }
	};
}

/** Query the GitHub `dsh-plugin` topic (official search API). Graceful on failure. */
async function githubResults(query) {
	return cachedFetch("github:" + (query || ""), 5 * 60 * 1000, async () => {
		const terms = [`topic:${GITHUB_TOPIC}`];
		if (query) terms.push(query);
		const url = `${GITHUB_SEARCH_URL}?q=${encodeURIComponent(terms.join(" "))}&sort=updated&order=desc&per_page=25`;
		const data = await fetchJson(url);
		const items = Array.isArray(data && data.items) ? data.items : [];
		return items
			.filter((repo) => repo && typeof repo.full_name === "string")
			.map((repo) => ({
				name: repo.name,
				source: "github",
				spec: `github:${repo.full_name}#${repo.default_branch || "main"}`,
				fullName: repo.full_name,
				version: "",
				description: repo.description || "",
				date: repo.updated_at || null,
				license: (repo.license && repo.license.spdx_id) || "",
				links: { github: repo.html_url, homepage: repo.homepage || "" },
				stars: repo.stargazers_count || 0,
				category: "插件"
			}));
	});
}

/**
 * Fetch the deepseekdocs ecosystem page (a curated mirror of the dsh-plugin
 * topic) and extract GitHub repo references. Best-effort: never breaks the
 * marketplace if the page structure changes or the site is unreachable.
 */
async function deepseekDocsResults(query) {
	return cachedFetch("deepseekdocs:ecosystem", 15 * 60 * 1000, async () => {
		const html = await fetchText(DEEPSEEKDOCS_ECOSYSTEM_URL);
		const seen = new Set();
		const out = [];
		const pattern = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g;
		let m;
		while ((m = pattern.exec(html)) !== null) {
			const full = m[1];
			if (seen.has(full)) continue;
			seen.add(full);
			out.push({
				name: full.split("/")[1],
				source: "deepseekdocs",
				spec: `github:${full}#main`,
				fullName: full,
				version: "",
				description: "",
				date: null,
				license: "",
				links: { github: `https://github.com/${full}` },
				stars: 0,
				category: "插件"
			});
			if (out.length >= 50) break;
		}
		return out;
	}).then((all) => {
		if (!query) return all;
		const q = query.toLowerCase();
		return all.filter((r) => r.name.toLowerCase().includes(q) || r.fullName.toLowerCase().includes(q));
	});
}

class PluginMarketplaceGateway extends TypertRemoteService {
	constructor(ctx) {
		super(ctx, "pluginMarketplace");
		// Apply the @Remote markers without decorator syntax (the host runs
		// plain ESM on Node 22). Marker state lives on the prototype and
		// re-marking is an idempotent no-op, so this is safe per instance.
		for (const name of ["search", "installed", "installPlugin", "uninstallPlugin"]) {
			const decorator = Remote(name);
			decorator(PluginMarketplaceGateway.prototype[name], {
				name,
				private: false,
				static: false,
				addInitializer: (initializer) => initializer.call(this)
			});
		}
	}

	/**
	 * Search for dsh plugins across every configured source: the npm registry
	 * (keyword dsh-plugin), the GitHub `dsh-plugin` topic, and the deepseekdocs
	 * curated mirror. Results are tagged with their source and a `spec` that
	 * `installPlugin` accepts (npm name or `github:owner/repo#branch`).
	 * @param query - optional free-text filter.
	 */
	async search(query) {
		const text = String(query ?? "").trim();

		// Source 1: npm registry (keywords:dsh-plugin).
		const terms = text.length > 0 ? `keywords:dsh-plugin ${text}` : "keywords:dsh-plugin";
		const run = await runNpm(["search", "--json", "--searchlimit=25", terms], SEARCH_TIMEOUT_MS);
		if (run.code !== 0) throw new Error(npmFailure(run, "search"));
		let parsed;
		try {
			parsed = JSON.parse(run.stdout);
		} catch {
			throw new Error("npm search 返回了无法解析的结果");
		}
		const installed = snapshot();
		const byName = new Map(installed.plugins.map((plugin) => [plugin.name, plugin]));
		const npmList = (Array.isArray(parsed) ? parsed : [])
			.filter((row) => row !== null && typeof row === "object" && typeof row.name === "string" && row.name.length > 0)
			.map((row) => toCard({
				name: row.name,
				source: "npm",
				spec: row.name,
				version: typeof row.version === "string" ? row.version : "",
				description: typeof row.description === "string" ? row.description : "",
				date: typeof row.date === "string" ? row.date : null,
				license: typeof row.license === "string" ? row.license : "",
				links: row.links !== null && typeof row.links === "object" ? row.links : {}
			}, byName));

		// Source 2 & 3: GitHub topic + deepseekdocs mirror (deduped by repo).
		// 任一源失败都不影响整体：各自独立熔断，返回空数组。
		const [githubList, mirrorList] = await Promise.all([
			githubResults(text).catch(() => []),
			deepseekDocsResults(text).catch(() => [])
		]);
		const seenRepos = new Set();
		const externalList = [];
		for (const record of [...githubList, ...mirrorList]) {
			if (seenRepos.has(record.fullName)) continue;
			seenRepos.add(record.fullName);
			externalList.push(toCard(record, byName));
		}

		return { query: text, results: [...npmList, ...externalList] };
	}

	/** The profile's currently installed user plugins. */
	installed() {
		return snapshot();
	}

	/**
	 * Install a plugin into the web profile and activate it: bundles join
	 * dsh.profile.bundles, everything else gets a loader row.
	 * @param spec - either an exact npm package name or a git source
	 *   (`github:owner/repo#branch`), as returned in a search result's `spec`.
	 */
	async installPlugin(spec) {
		const resolved = validSpec(spec);
		const before = snapshot();
		const run = await runNpm(["install", "--save", "--no-fund", "--no-audit", resolved.spec], INSTALL_TIMEOUT_MS);
		if (run.code !== 0) return { ok: false, name: resolved.spec, error: npmFailure(run, "install") };
		const after = snapshot();
		// npm 源按包名直接定位；git 源在安装后才知道解析出的包名，取“新增”的那个。
		let entry;
		if (resolved.kind === "npm") {
			entry = after.plugins.find((plugin) => plugin.name === resolved.spec);
		} else {
			const beforeNames = new Set(before.plugins.map((plugin) => plugin.name));
			entry = after.plugins.find((plugin) => !beforeNames.has(plugin.name));
		}
		if (entry === undefined) return { ok: false, name: resolved.spec, error: "安装命令成功，但未在 profile 依赖中找到该包（git/别名规格不受支持）" };
		let rowsAdded = false;
		if (entry.isBundle) {
			const manifest = readJson(manifestPath());
			manifest.dsh ??= {};
			manifest.dsh.profile ??= {};
			manifest.dsh.profile.bundles ??= [];
			if (!manifest.dsh.profile.bundles.includes(entry.name)) {
				manifest.dsh.profile.bundles.push(entry.name);
				writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2) + "\n");
			}
		} else {
			rowsAdded = ensureRow(entry.name);
		}
		return { ok: true, name: entry.name, version: entry.version, isBundle: entry.isBundle, isClient: entry.isClient, rowsAdded, needsRestart: true };
	}

	/**
	 * Remove one user-installed plugin from the web profile, including the
	 * activation state this plugin manages.
	 * @param packageName - exact npm package name.
	 */
	async uninstallPlugin(packageName) {
		const name = validName(packageName);
		const before = snapshot();
		if (!before.plugins.some((plugin) => plugin.name === name)) return { ok: false, name, error: "该插件不在本 profile 的依赖里" };
		const run = await runNpm(["uninstall", "--save", "--no-fund", "--no-audit", name], INSTALL_TIMEOUT_MS);
		if (run.code !== 0) return { ok: false, name, error: npmFailure(run, "uninstall") };
		const manifest = readJson(manifestPath());
		if (Array.isArray(manifest.dsh?.profile?.bundles)) {
			manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((bundle) => bundle !== name);
			writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2) + "\n");
		}
		removeRow(name);
		return { ok: true, name, needsRestart: true };
	}
}

export default PluginMarketplaceGateway;
export { PluginMarketplaceGateway };
