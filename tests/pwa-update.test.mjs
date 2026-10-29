import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * PWA 更新提示回归：
 * 远端探针、updatefound、controllerchange 连续触发时，只能出现一条 banner；
 * 自动刷新也只能更新这条 banner，不能再额外弹 toast。
 *
 * 这里不启动浏览器，用最小 DOM/SW/定时器桩把真实 initPwaUpdates() 跑一遍。
 */
test('PWA - 同一次更新只出现一条提示，自动刷新不再叠 toast', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realSetInterval = globalThis.setInterval;
    const realFetch = globalThis.fetch;

    const timers = [];
    const toasts = [];
    let reloads = 0;

    const makeEl = (tag = 'div') => {
        const listeners = {};
        const el = {
            tagName: String(tag).toUpperCase(),
            id: '',
            style: {},
            children: [],
            textContent: '',
            _html: '',
            setAttribute(key, value) { this[key] = value; },
            addEventListener(type, fn) { listeners[type] = fn; },
            appendChild(child) {
                this.children.push(child);
                if (child.id) docIndex.set(child.id, child);
                return child;
            },
            querySelector(selector) {
                if (selector === '#pwa-update-msg') return this._msg || (this._msg = makeEl('span'));
                if (selector === '#pwa-update-btn') return this._updateBtn || (this._updateBtn = makeEl('button'));
                if (selector === '#pwa-force-btn') return this._forceBtn || (this._forceBtn = makeEl('button'));
                return null;
            },
            remove() {
                const parent = this.parentNode;
                if (parent) parent.children = parent.children.filter((x) => x !== this);
            },
            get innerHTML() { return this._html; },
            set innerHTML(value) { this._html = String(value); },
            _listeners: listeners
        };
        return el;
    };

    const docIndex = new Map();
    const body = makeEl('body');
    const toastContainer = makeEl('div');
    toastContainer.id = 'toast-container';
    toastContainer.appendChild = function (child) {
        toasts.push(child);
        return child;
    };
    docIndex.set('toast-container', toastContainer);

    const documentStub = {
        readyState: 'complete',
        visibilityState: 'visible',
        activeElement: null,
        body,
        createElement: makeEl,
        getElementById(id) { return docIndex.get(id) || null; },
        querySelector(selector) {
            if (selector === '#pwa-update-bar #pwa-update-msg') {
                const bar = docIndex.get('pwa-update-bar');
                return bar ? bar.querySelector('#pwa-update-msg') : null;
            }
            if (selector === '.auth-force-refresh') return null;
            return null;
        },
        querySelectorAll() { return []; },
        addEventListener() {}
    };

    const windowStub = {
        location: {
            href: 'http://localhost/',
            reload() { reloads += 1; }
        },
        addEventListener() {}
    };

    const stateListeners = {};
    const installing = makeEl('worker');
    installing.state = 'installing';
    installing.postMessage = () => {};
    installing.addEventListener = (type, fn) => { stateListeners[type] = fn; };

    const reg = {
        waiting: null,
        installing,
        addEventListener(type, fn) { this._listeners = this._listeners || {}; this._listeners[type] = fn; },
        async update() {}
    };

    const swListeners = {};
    const navigatorStub = {
        serviceWorker: {
            controller: {},
            async register() { return reg; },
            addEventListener(type, fn) { swListeners[type] = fn; }
        }
    };

    const fetchStub = async () => ({
        ok: true,
        async json() { return { version: '9.9.9' }; }
    });

    globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
    globalThis.setInterval = () => 0;
    globalThis.document = documentStub;
    globalThis.window = windowStub;
    Object.defineProperty(globalThis, 'navigator', { value: navigatorStub, configurable: true, writable: true });
    globalThis.fetch = fetchStub;

    try {
        const { initPwaUpdates } = await import('../public/js/pwa-update.js');
        initPwaUpdates();
        // 让 register / remote probe 的微任务全部落地
        for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));

        // 模拟：远端探针 -> updatefound -> installed -> controllerchange 连续触发
        reg._listeners.updatefound();
        installing.state = 'installed';
        stateListeners.statechange();
        swListeners.controllerchange();
        await new Promise((resolve) => setImmediate(resolve));

        const bars = body.children.filter((x) => x.id === 'pwa-update-bar');
        assert.equal(bars.length, 1, '同一次更新必须只有一条更新 banner');
        assert.equal(timers.filter((t) => t.ms === 8000).length, 1, '自动刷新定时器只能排一次');
        assert.equal(toasts.length, 0, '更新阶段不能额外弹 toast');

        const auto = timers.find((t) => t.ms === 8000);
        assert.ok(auto, '应安排一次自动刷新');
        auto.fn();
        assert.equal(toasts.length, 0, '自动刷新也不能再叠 toast');
        assert.equal(bars.length, 1, '自动刷新时仍只能有一条 banner');

        const reloadTimer = timers.find((t) => t.ms === 600);
        assert.ok(reloadTimer, '自动刷新应延迟 reload');
        reloadTimer.fn();
        assert.equal(reloads, 1, '自动刷新只 reload 一次');
    } finally {
        globalThis.setTimeout = realSetTimeout;
        globalThis.setInterval = realSetInterval;
        globalThis.fetch = realFetch;
        delete globalThis.document;
        delete globalThis.window;
        try { delete globalThis.navigator; } catch (_) {}
    }
});
