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

/** First useful npm failure text (stderr wins, then stdout, then the code). */
function npmFailure(run, verb) {
	return (run.error || run.stderr || run.stdout || `npm ${verb} 失败 (exit ${run.code})`).trim().slice(0, 800);
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
	 * Search the configured npm registry for dsh plugins.
	 * @param query - optional free-text terms combined with keywords:dsh-plugin.
	 */
	async search(query) {
		const text = String(query ?? "").trim();
		const terms = text.length > 0 ? `keywords:dsh-plugin ${text}` : "keywords:dsh-plugin";
		const run = await runNpm(["search", "--json", "--searchlimit=25", terms], SEARCH_TIMEOUT_MS);
		if (run.code !== 0) throw new Error(npmFailure(run, "search"));
		let parsed;
		try {
			parsed = JSON.parse(run.stdout);
		} catch {
			throw new Error("npm search 返回了无法解析的结果");
		}
		const rows = Array.isArray(parsed) ? parsed : [];
		const installed = snapshot();
		const byName = new Map(installed.plugins.map((plugin) => [plugin.name, plugin]));
		return {
			query: text,
			results: rows.filter((row) => row !== null && typeof row === "object" && typeof row.name === "string" && row.name.length > 0).map((row) => {
				const hit = byName.get(row.name);
				return {
					name: row.name,
					version: typeof row.version === "string" ? row.version : "",
					description: typeof row.description === "string" ? row.description : "",
					date: typeof row.date === "string" ? row.date : null,
					license: typeof row.license === "string" ? row.license : "",
					links: row.links !== null && typeof row.links === "object" ? row.links : {},
					installed: hit === undefined ? null : { version: hit.version, isBundle: hit.isBundle, isClient: hit.isClient }
				};
			})
		};
	}

	/** The profile's currently installed user plugins. */
	installed() {
		return snapshot();
	}

	/**
	 * Install one npm package into the web profile and activate it: bundles
	 * join dsh.profile.bundles, everything else gets a loader row.
	 * @param packageName - exact npm package name from the search results.
	 */
	async installPlugin(packageName) {
		const name = validName(packageName);
		const run = await runNpm(["install", "--save", "--no-fund", "--no-audit", name], INSTALL_TIMEOUT_MS);
		if (run.code !== 0) return { ok: false, name, error: npmFailure(run, "install") };
		const after = snapshot();
		const entry = after.plugins.find((plugin) => plugin.name === name);
		if (entry === undefined) return { ok: false, name, error: "安装命令成功，但未在 profile 依赖中找到该包（git/别名规格不受支持）" };
		let rowsAdded = false;
		if (entry.isBundle) {
			const manifest = readJson(manifestPath());
			manifest.dsh ??= {};
			manifest.dsh.profile ??= {};
			manifest.dsh.profile.bundles ??= [];
			if (!manifest.dsh.profile.bundles.includes(name)) {
				manifest.dsh.profile.bundles.push(name);
				writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2) + "\n");
			}
		} else {
			rowsAdded = ensureRow(name);
		}
		return { ok: true, name, version: entry.version, isBundle: entry.isBundle, isClient: entry.isClient, rowsAdded, needsRestart: true };
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
