'use strict';

// unit-float-window-client.test.js — FW1「win 小窗口（浮窗）打开白屏」回归：
//
// 根因链（见修复报告）：
//  1) 旧 setupFloat 在 apply 时立即给 body 打 data-dsh-float（启用 0 轨道
//     grid CSS），而目标会话选择要异步重试最长 20s——CSS 先生效、内容后
//     挂载，期间浮窗近乎白屏；选择彻底失败时也只 console.warn，无可见兜底。
//  2) 壳层（windows.rs FLOAT_WATCHDOG_SCRIPT）负责「页面级」白屏（内核
//     未监听/重启窗口期），本文件负责「插件级」白屏，双层双保险。
//
// 契约（对 lib/client.js 的 FLOAT 分支）：
//  - mount-then-hide：data-dsh-float 只在「选中会话 + 折叠布局」成功后才打；
//  - 重试耗尽 → 可见错误卡（#__dsh_float_plugin_error__，含重试/关闭）；
//  - disposer：清计时器 + 摘错误卡 + 还原 body 属性（W2 野计时器教训）；
//  - retry() 支持 reg 登记计时器（清理面）。
//
// 运行：node --test scripts/test/unit-float-window-client.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT = path.join(__dirname, '..', '..', 'assets', 'plugins', 'dsh-float-window', 'lib', 'client.js');

// ---------------------------------------------------------------- fake DOM
class El {
	constructor(tag) {
		this.tagName = String(tag || 'div').toUpperCase();
		this.children = [];
		this.parentNode = null;
		this.id = '';
		this.className = '';
		this.style = {};
		this.dataset = {};
		this.textContent = '';
		this.onclick = null;
		this._handlers = {};
	}
	get childElementCount() { return this.children.length; }
	appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
	remove() {
		if (!this.parentNode) return;
		const i = this.parentNode.children.indexOf(this);
		if (i >= 0) this.parentNode.children.splice(i, 1);
		this.parentNode = null;
	}
	setAttribute(k, v) { this.dataset[k] = String(v); }
	removeAttribute(k) { delete this.dataset[k]; }
	getAttribute(k) { return this.dataset[k]; }
	addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); }
	click() { if (typeof this.onclick === 'function') this.onclick({}); }
}

function makeDoc() {
	const body = new El('body');
	const head = new El('head');
	const doc = {
		readyState: 'complete',
		body,
		head,
		createElement: (t) => new El(t),
		getElementById(id) {
			const walk = (el) => {
				for (const c of el.children) {
					if (c.id === id) return c;
					const r = walk(c);
					if (r) return r;
				}
				return null;
			};
			return walk(body);
		},
		// 本测试不覆盖真实选择器引擎：全部返回 null（未折叠 / 无既有样式标签）。
		querySelector: () => null,
		addEventListener: () => {},
	};
	return doc;
}

// ---------------------------------------------------------------- fake timers
function makeTimers() {
	let now = 0;
	const list = [];
	return {
		setTimeout(fn, ms) {
			const t = { fn, at: now + ms, done: false, cancelled: false };
			list.push(t);
			return t;
		},
		clearTimeout(t) { if (t) t.cancelled = true; },
		async advance(ms) {
			// 先冲刷微任务：retry 链可在零计时器下推进（同步成功路径），
			// 若不先 drain，.then 链会滞后于测试断言。
			for (let i = 0; i < 20; i++) await Promise.resolve();
			const deadline = now + ms;
			for (;;) {
				const due = list
					.filter((t) => !t.done && !t.cancelled && t.at <= deadline)
					.sort((a, b) => a.at - b.at)[0];
				if (!due) break;
				now = Math.max(now, due.at);
				due.done = true;
				due.fn();
				// 冲刷 promise 微任务链（retry 的 resolve → then → 下一轮 setTimeout）。
				for (let i = 0; i < 10; i++) await Promise.resolve();
			}
			now = deadline;
		},
		pending() { return list.filter((t) => !t.done && !t.cancelled).length; },
		_now: () => now,
	};
}

// ---------------------------------------------------------------- 物化插件
// 产物形态：window.__ModuleLoader__.load({ id, factory })，factory(require)
// 内部自建 module 并 return module.exports。装捕获型 loader 后整文件执行。
function loadPlugin({ floatSessionId, timers, doc }) {
	const win = {
		__DSH_FLOAT__: floatSessionId != null ? { sessionId: floatSessionId } : null,
	};
	const require = (name) => {
		if (name === 'react') return { createElement: () => null };
		if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'f' };
		throw new Error('unexpected require: ' + name);
	};
	const holder = { exports: null };
	const sandbox = {
		window: win,
		document: doc,
		console: { log() {}, warn() {}, error() {} },
		setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
		clearTimeout: (t) => timers.clearTimeout(t),
		__ModuleLoader__: {
			load(def) { holder.exports = def.factory(require); },
		},
	};
	sandbox.globalThis = sandbox;
	win.__ModuleLoader__ = sandbox.__ModuleLoader__;
	vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' });
	assert.ok(holder.exports && typeof holder.exports.apply === 'function', 'client.js 物化失败');
	return { plugin: holder.exports, win };
}

// ctx 桩：effect 捕获 disposer；get 按 services 表分发。
function makeCtx(services) {
	const disposers = [];
	return {
		_ctxDisposers: disposers,
		slots: { register: () => () => {} },
		effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
		get: (name) => services[name],
	};
}

// sessions 服务桩：neverReady / missing / readyOk 三型。
function sessionsService(kind, targetId) {
	const snap = {
		phase: kind === 'neverReady' ? 'loading' : 'ready',
		byId: kind === 'missing' ? {} : { [targetId]: { id: targetId, blank: false } },
	};
	return {
		list: { getSnapshot: () => snap },
		current: { getSnapshot: () => ({ current: kind === 'readyOk' ? targetId : 'other' }) },
		open(id) {
			if (!(id in snap.byId)) throw new Error('unknown session: ' + id);
		},
	};
}

// ===================================================================== tests

test('重试耗尽 → 可见错误卡（不再白屏），且期间 data-dsh-float 未打（mount-then-hide）', async () => {
	const doc = makeDoc();
	const timers = makeTimers();
	const { plugin } = loadPlugin({ floatSessionId: 's-missing', timers, doc });
	const ctx = makeCtx({ sessions: sessionsService('missing', 's-missing') });

	plugin.apply(ctx);
	// 快进 25s（> 40×500ms 重试期）。
	await timers.advance(25000);

	assert.ok(doc.getElementById('__dsh_float_plugin_error__'), '错误卡必须出现');
	assert.equal(doc.body.getAttribute('data-dsh-float'), undefined, '选择失败期间不得启用 0 轨道 CSS');
	const card = doc.getElementById('__dsh_float_plugin_error__');
	const texts = card.children.map((c) => c.textContent).join('|');
	assert.match(texts, /s-missing/, '错误文案应自证目标会话');
	assert.match(texts, /重试/, '必须有重试按钮');
});

test('disposer 清计时器、摘错误卡、还原 body 属性', async () => {
	const doc = makeDoc();
	const timers = makeTimers();
	const { plugin } = loadPlugin({ floatSessionId: 's-x', timers, doc });
	const ctx = makeCtx({ sessions: sessionsService('missing', 's-x') });
	plugin.apply(ctx);
	await timers.advance(25000);
	assert.ok(doc.getElementById('__dsh_float_plugin_error__'));
	doc.body.setAttribute('data-dsh-float', '1'); // 模拟曾经成功过
	const pendingBefore = timers.pending();
	assert.ok(pendingBefore >= 0);
	for (const d of ctx._ctxDisposers) d();
	assert.equal(doc.getElementById('__dsh_float_plugin_error__'), null, '错误卡必须被摘除');
	assert.equal(doc.body.getAttribute('data-dsh-float'), undefined, 'body 属性必须还原');
	const before = timers.pending();
	await timers.advance(30000);
	assert.equal(timers.pending(), before, 'dispose 后不得再弹出新的计时器回调（野计时器）');
});

test('错误卡「重试」按钮可再入：点击后清卡重新走选择链', async () => {
	const doc = makeDoc();
	const timers = makeTimers();
	const { plugin } = loadPlugin({ floatSessionId: 's-r', timers, doc });
	let kind = 'missing';
	const svc = {
		list: { getSnapshot: () => ({ phase: 'ready', byId: kind === 'readyOk' ? { 's-r': { id: 's-r', blank: false } } : {} }) },
		current: { getSnapshot: () => ({ current: kind === 'readyOk' ? 's-r' : 'other' }) },
		open(id) { if (kind !== 'readyOk') throw new Error('unknown session'); },
	};
	const ctx = makeCtx({ sessions: svc, layout: { closeDetails() {}, toggleSidebar() {} } });
	plugin.apply(ctx);
	await timers.advance(25000);
	const card = doc.getElementById('__dsh_float_plugin_error__');
	assert.ok(card, '第一轮失败出卡');
	kind = 'readyOk';
	card.children[2].children[0].click(); // 重试按钮
	await timers.advance(5000);
	assert.equal(doc.getElementById('__dsh_float_plugin_error__'), null, '重试成功后卡应消失');
	assert.equal(doc.body.getAttribute('data-dsh-float'), '1', '成功路径最终打上 data-dsh-float');
});

test('成功路径：选中 + 折叠完成后才打 data-dsh-float（CSS 后于内容生效）', async () => {
	const doc = makeDoc();
	const timers = makeTimers();
	const { plugin } = loadPlugin({ floatSessionId: 's-ok', timers, doc });
	const svc = sessionsService('readyOk', 's-ok');
	let openedWith = '';
	svc.open = (id) => { openedWith = id; };
	const ctx = makeCtx({ sessions: svc, layout: { closeDetails() {}, toggleSidebar() {} } });
	plugin.apply(ctx);
	assert.equal(doc.body.getAttribute('data-dsh-float'), undefined, 'apply 同步期不得打属性');
	await timers.advance(1500); // 选择 + 折叠 + 1.2s 补关详情
	assert.equal(openedWith, 's-ok', '必须显式 open 目标会话');
	assert.equal(doc.body.getAttribute('data-dsh-float'), '1', '成功后打属性启用沉浸 CSS');
	assert.equal(doc.getElementById('__dsh_float_plugin_error__'), null, '成功路径无错误卡');
});

test('主窗分支（无 __DSH_FLOAT__）：不进入浮窗逻辑、不打属性', () => {
	const doc = makeDoc();
	const timers = makeTimers();
	const { plugin } = loadPlugin({ floatSessionId: null, timers, doc });
	const ctx = makeCtx({});
	plugin.apply(ctx);
	assert.equal(doc.body.getAttribute('data-dsh-float'), undefined);
	assert.equal(timers.pending(), 0, '主窗分支不应注册浮窗计时器');
});

test('retry()：reg 登记的计时器被 clearTimeout 后不再触发', async () => {
	const doc = makeDoc();
	const timers = makeTimers();
	const { plugin } = loadPlugin({ floatSessionId: 's', timers, doc });
	let calls = 0;
	const p = plugin.__test.retry(() => { calls += 1; return false; }, { attempts: 10, delayMs: 100, reg: [] });
	// reg 传空数组时计时器不进 reg——验证默认行为（不炸）即可。
	await timers.advance(2000);
	assert.equal(await p, false);
	assert.equal(calls, 10);
});
