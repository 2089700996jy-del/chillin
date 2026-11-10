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

    const sessionStore = new Map();
    const sessionStorageStub = {
        getItem(key) { return sessionStore.has(key) ? sessionStore.get(key) : null; },
        setItem(key, val) { sessionStore.set(key, String(val)); },
        removeItem(key) { sessionStore.delete(key); },
        clear() { sessionStore.clear(); }
    };

    const windowStub = {
        sessionStorage: sessionStorageStub,
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
    globalThis.sessionStorage = sessionStorageStub;
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
        assert.equal(sessionStore.get('chillin_pwa_update_reloaded'), '1', 'reload 前必须记录 reload 状态标志');
    } finally {
        globalThis.setTimeout = realSetTimeout;
        globalThis.setInterval = realSetInterval;
        globalThis.fetch = realFetch;
        delete globalThis.document;
        delete globalThis.window;
        delete globalThis.sessionStorage;
        try { delete globalThis.navigator; } catch (_) {}
    }
});

/**
 * 部署顺序自检的判定逻辑：
 * 正常流程是「先 deploy Worker，再推前端」；写反时前端会打到旧 Worker，
 * 此时必须能识别出「前端更新」并提示，而 Worker 领先时一句话都不许多说。
 */
test('PWA - 只有前端领先后端时才判定为部署顺序写反', async () => {
    const { isVersionAhead } = await import('../public/js/version.js');

    assert.equal(isVersionAhead('2.5.226', '2.5.226'), false, '版本相同不该提示');
    assert.equal(isVersionAhead('2.5.226', '2.5.227'), false, 'Worker 领先是正常发布顺序，不该提示');
    assert.equal(isVersionAhead('2.5.227', '2.5.226'), true, '前端领先旧 Worker 必须提示');
    assert.equal(isVersionAhead('2.5.10', '2.5.9'), true, '必须按数字比较，不能按字符串比较');
    assert.equal(isVersionAhead('2.5.226', ''), false, 'Worker 没回版本号时保持静默');
    assert.equal(isVersionAhead('', '2.5.226'), false, '前端版本缺失时同样静默');
});

test('PWA - 切回前台时 visibilitychange 与 focus 并发触发防抖消抖，且旧远端版本不弹更新提示', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realSetInterval = globalThis.setInterval;
    const realFetch = globalThis.fetch;

    let fetchCount = 0;
    const docListeners = {};
    const winListeners = {};
    const body = { children: [], appendChild(c) { this.children.push(c); return c; } };

    const docStub = {
        readyState: 'complete',
        visibilityState: 'visible',
        activeElement: null,
        body,
        createElement(tag) {
            return {
                tagName: tag.toUpperCase(),
                children: [],
                style: {},
                appendChild(c) { this.children.push(c); return c; },
                querySelector() { return { textContent: '' }; },
                setAttribute() {}
            };
        },
        getElementById() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener(type, fn) { docListeners[type] = fn; }
    };

    const winStub = {
        sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        location: { href: 'http://localhost/', reload() {} },
        addEventListener(type, fn) { winListeners[type] = fn; }
    };

    const reg = {
        updateCalls: 0,
        async update() { this.updateCalls += 1; },
        addEventListener() {}
    };

    globalThis.setTimeout = (fn) => fn;
    globalThis.setInterval = () => 0;
    globalThis.document = docStub;
    globalThis.window = winStub;
    globalThis.sessionStorage = winStub.sessionStorage;
    Object.defineProperty(globalThis, 'navigator', {
        value: {
            serviceWorker: {
                controller: {},
                async register() { return reg; },
                addEventListener() {}
            }
        },
        configurable: true,
        writable: true
    });

    globalThis.fetch = async () => {
        fetchCount += 1;
        // 模拟远端版本比当前版本旧（如云端是 2.5.200，本地是 2.5.236）
        return { ok: true, json: async () => ({ version: '2.5.200' }) };
    };

    try {
        const pwaMod = await import('../public/js/pwa-update.js?t=' + Date.now());
        pwaMod.initPwaUpdates();
        await new Promise((resolve) => setImmediate(resolve));

        const initialFetches = fetchCount;
        assert.equal(initialFetches, 1, '首次初始化只发起一次版本探测');

        // 模拟用户从其他应用切回页面：浏览器毫秒内接连抛出 visibilitychange 与 focus
        if (docListeners.visibilitychange) docListeners.visibilitychange();
        if (winListeners.focus) winListeners.focus();
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(fetchCount, initialFetches, '切回前台时高频触发被防抖拦截，不重复发起请求');
        assert.equal(body.children.length, 0, '云端版本滞后时不应弹出更新横幅');
    } finally {
        globalThis.setTimeout = realSetTimeout;
        globalThis.setInterval = realSetInterval;
        globalThis.fetch = realFetch;
        delete globalThis.document;
        delete globalThis.window;
        delete globalThis.sessionStorage;
        try { delete globalThis.navigator; } catch (_) {}
    }
});
