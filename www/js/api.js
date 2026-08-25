/** Auth, persistence, and cloud sync. UI refresh via bindApiHooks. */

import { showToast, urlBase64ToUint8Array } from './utils.js';
import {
    state,
    DEFAULT_WEEKLY,
    DEFAULT_NOTES,
    DEFAULT_BOOKMARKS,
    DEFAULT_FEEDS,
} from './state.js';

let hooks = {
    onRefresh: (_kind, _opts) => {},
};

export function bindApiHooks( partial ) {
    hooks = { ...hooks, ...partial };
}

function refresh(kind, opts) {
    if (typeof hooks.onRefresh === 'function') hooks.onRefresh(kind, opts);
}

// ── API base / fetch ──────────────────────────────────────────
let API_BASE = '';
if (typeof CHILLIN_API_URL !== 'undefined' && CHILLIN_API_URL) {
    API_BASE = CHILLIN_API_URL;
} else if (window.location.protocol === 'file:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    API_BASE = 'https://chillin-bfc.pages.dev';
} else {
    API_BASE = '';
}
export { API_BASE };
export const CLOUD_WORKER_BASE = 'https://chillin-api.2089700996jy.workers.dev';

export function resolveAssetUrl(src) {
    if (src && API_BASE && (src.startsWith('/api/') || src.startsWith('/uploads/'))) {
        return API_BASE + src;
    }
    return src;
}

export async function fetchWithFallback(path, options = {}) {
    const primaryUrl = `${API_BASE}${path}`;
    try {
        return await fetch(primaryUrl, options);
    } catch (primaryErr) {
        if (API_BASE === '' && (primaryErr.name === 'TypeError' || (primaryErr.message && primaryErr.message.includes('fetch')))) {
            return await fetch(`${CLOUD_WORKER_BASE}${path}`, options);
        }
        throw primaryErr;
    }
}

export function getLocalKey(key) {
    return state.authUser ? `${state.authUser.id}_${key}` : `default_${key}`;
}

// ── Auth UI ───────────────────────────────────────────────────
export function checkAuth() {
    const authOverlay = document.getElementById('auth-overlay');
    const navUsername = document.getElementById('nav-username');
    if (!state.authToken) {
        authOverlay?.classList.remove('hidden');
        document.body.classList.add('not-authenticated');
        return false;
    }
    authOverlay?.classList.add('hidden');
    document.body.classList.remove('not-authenticated');
    if (state.authUser && navUsername) navUsername.innerText = `Hi, ${state.authUser.username}`;
    return true;
}

export function logout(opts = {}) {
    if (state.authToken) {
        apiRequest('/api/auth/logout', { method: 'POST' }).catch(() => {});
    }
    state.authToken = '';
    state.authUser = null;
    localStorage.removeItem('chillin_token');
    localStorage.removeItem('chillin_user');
    checkAuth();
    if (opts.silent) return;
    if (opts.reason === 'expired') {
        showToast('登录已过期，请重新登录', 'warn');
    } else {
        showToast('已退出登录', 'info');
    }
}

export async function doLogin() {
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value.trim();
    const btnAuthSubmit = document.getElementById('btn-auth-submit');
    const authErrorMsg = document.getElementById('auth-error-msg');
    if (authErrorMsg) authErrorMsg.style.display = 'none';
    if (!username || !password) {
        if (authErrorMsg) {
            authErrorMsg.innerText = '请输入账号和密码';
            authErrorMsg.style.display = 'block';
        }
        return;
    }

    if (btnAuthSubmit) {
        btnAuthSubmit.disabled = true;
        btnAuthSubmit.innerText = state.isRegisterMode ? '注册中...' : '登录中...';
    }

    try {
        const endpoint = state.isRegisterMode ? '/api/auth/register' : '/api/auth/login';
        if (state.isRegisterMode) {
            if (username.length < 3 || username.length > 32) throw new Error('账号长度需为 3–32 位');
            if (password.length < 8) throw new Error('密码至少 8 位');
            if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
                throw new Error('密码需同时包含字母和数字');
            }
        }
        const res = await fetchWithFallback(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '登录失败，请检查账号和密码');

        state.authToken = data.token;
        state.authUser = { id: data.userId, username: data.username };
        localStorage.setItem('chillin_token', state.authToken);
        localStorage.setItem('chillin_user', JSON.stringify(state.authUser));

        checkAuth();
        showToast('登录成功，欢迎来到数字花园', 'success');
        loadLocalData();
        syncFromApi();
        checkAndMergeGuestData();
        setTimeout(registerPushNotification, 2000);
    } catch (err) {
        const errorMsg = (err.message === 'Failed to fetch' || err.name === 'TypeError')
            ? '网络连接失败，请检查手机网络后重试'
            : (err.message || '登录失败');
        if (authErrorMsg) {
            authErrorMsg.innerText = errorMsg;
            authErrorMsg.style.display = 'block';
        }
        showToast(errorMsg, 'error');
    } finally {
        if (btnAuthSubmit) {
            btnAuthSubmit.disabled = false;
            btnAuthSubmit.innerText = state.isRegisterMode ? '注册并进入' : '登录';
        }
    }
}

export function initAuthUI() {
    const btnLogout = document.getElementById('btn-logout');
    const btnAuthSwitch = document.getElementById('btn-auth-switch');
    const authSwitchText = document.getElementById('auth-switch-text');
    const authErrorMsg = document.getElementById('auth-error-msg');

    btnLogout?.addEventListener('click', logout);

    btnAuthSwitch?.addEventListener('click', () => {
        state.isRegisterMode = !state.isRegisterMode;
        if (state.isRegisterMode) {
            document.querySelector('.auth-btn').innerText = '注册并进入';
            if (authSwitchText) authSwitchText.innerText = '已有账号？';
            btnAuthSwitch.innerText = '直接登录';
        } else {
            document.querySelector('.auth-btn').innerText = '登录';
            if (authSwitchText) authSwitchText.innerText = '还没有账号？';
            btnAuthSwitch.innerText = '立即注册';
        }
        if (authErrorMsg) authErrorMsg.style.display = 'none';
    });

    window._chillinLogin = doLogin;
    document.getElementById('btn-auth-submit')?.addEventListener('click', doLogin);
    document.getElementById('auth-password')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doLogin();
    });
    document.getElementById('auth-username')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('auth-password')?.focus();
    });
}

export async function apiRequest(path, options = {}) {
    const timeoutMs = options.timeout || 25000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };
        if (state.authToken) {
            headers['Authorization'] = `Bearer ${state.authToken}`;
        }

        const res = await fetchWithFallback(path, {
            ...options,
            signal: controller.signal,
            headers
        });

        if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/register' && path !== '/api/auth/logout') {
            if (!options._isRetry) {
                await new Promise(r => setTimeout(r, 300));
                return await apiRequest(path, { ...options, _isRetry: true });
            }
            logout({ reason: 'expired' });
            throw new Error('未登录或登录状态已过期，请重新登录');
        }
        if (!res.ok) {
            let detail = '';
            try {
                const errBody = await res.json();
                detail = errBody && errBody.error ? String(errBody.error) : '';
            } catch (_) {}
            throw new Error(detail || `接口请求异常 (${res.status})`);
        }
        return res.json();
    } catch (err) {
        if (err.name === 'AbortError' || (err.message && (err.message.includes('aborted') || err.message.includes('signal')))) {
            throw new Error('网络请求超时，请检查网络后重试');
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

export async function registerPushNotification() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        const existingSub = await reg.pushManager.getSubscription();
        if (existingSub) {
            await sendSubscriptionToServer(existingSub);
            return;
        }

        const VAPID_PUBLIC_KEY = 'BBj8FZZ57_GfEm-HGPo9pXRA5jsd4FAzu-3bQJC7KjAoGp3TWlDGFt5D22JadZ6t5bw9u6NDNsy4Vgny9v3r2e0';
        const subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
        await sendSubscriptionToServer(subscription);
    } catch (e) {
        console.error('Push registration failed:', e);
    }
}

async function sendSubscriptionToServer(subscription) {
    try {
        await apiRequest('/api/push/subscribe', {
            method: 'POST',
            body: JSON.stringify(subscription)
        });
    } catch (e) {
        console.error('Failed to send subscription:', e);
    }
}

// ── Local storage / merge ─────────────────────────────────────
function rescueAndConsolidateLocalData() {
    let rescuedFeeds = [];
    let rescuedNotes = [];
    let rescuedWeeklies = [];
    let rescuedBookmarks = [];

    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;
            if (key.includes('gardenFeeds')) {
                const items = JSON.parse(localStorage.getItem(key));
                if (Array.isArray(items)) rescuedFeeds.push(...items);
            } else if (key.includes('gardenNotes')) {
                const items = JSON.parse(localStorage.getItem(key));
                if (Array.isArray(items)) rescuedNotes.push(...items);
            } else if (key.includes('gardenData')) {
                const items = JSON.parse(localStorage.getItem(key));
                if (Array.isArray(items)) rescuedWeeklies.push(...items);
            } else if (key.includes('gardenBookmarks')) {
                const items = JSON.parse(localStorage.getItem(key));
                if (Array.isArray(items)) rescuedBookmarks.push(...items);
            }
        }
    } catch (e) {}

    const cleanList = (list, defaultIds) => {
        if (!Array.isArray(list)) return [];
        const unique = list.filter((item, index, self) =>
            item && item.id && self.findIndex(t => String(t.id) === String(item.id)) === index
        );
        if (unique.length > defaultIds.length) {
            return unique.filter(item => !defaultIds.includes(Number(item.id)));
        }
        return unique;
    };

    return {
        feeds: cleanList(rescuedFeeds, [1]),
        notes: cleanList(rescuedNotes, [101, 102]),
        weeklies: cleanList(rescuedWeeklies, [1]),
        bookmarks: cleanList(rescuedBookmarks, [201, 202, 203])
    };
}

export function getSyncedIds() {
    try {
        return JSON.parse(localStorage.getItem(getLocalKey('gardenSyncedIds'))) || [];
    } catch (e) { return []; }
}

export function addSyncedIds(ids) {
    if (!Array.isArray(ids)) return;
    const current = getSyncedIds();
    let changed = false;
    for (const id of ids) {
        const str = String(id);
        if (str && !current.includes(str)) {
            current.push(str);
            changed = true;
        }
    }
    if (changed) {
        localStorage.setItem(getLocalKey('gardenSyncedIds'), JSON.stringify(current));
    }
}

export function getDeletedIds() {
    try {
        return JSON.parse(localStorage.getItem(getLocalKey('gardenDeletedIds'))) || [];
    } catch (e) { return []; }
}

export function addDeletedId(id) {
    if (!id) return;
    const current = getDeletedIds();
    const str = String(id);
    if (!current.includes(str)) {
        current.push(str);
        localStorage.setItem(getLocalKey('gardenDeletedIds'), JSON.stringify(current));
    }
}

export function toUpdatedTs(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const raw = String(value).trim();
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) return Number(raw);
    let s = raw.includes('T') ? raw : raw.replace(' ', 'T');
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
}

export function stampLocalUpdate(item) {
    if (!item || typeof item !== 'object') return item;
    item.updated_at = new Date().toISOString();
    item._dirty = true;
    return item;
}

export function stripClientSyncFlags(item) {
    if (!item || typeof item !== 'object') return item;
    const copy = { ...item };
    delete copy._dirty;
    return copy;
}

export function mergeDataLists(localList, apiList) {
    if (!Array.isArray(localList)) localList = [];
    if (!Array.isArray(apiList)) apiList = [];

    const deletedIds = getDeletedIds();
    const map = new Map();

    for (const item of apiList) {
        if (item && item.id != null && !deletedIds.includes(String(item.id))) {
            map.set(String(item.id), item);
        }
    }

    for (const item of localList) {
        if (!item || item.id == null || deletedIds.includes(String(item.id))) continue;
        const key = String(item.id);
        if (!map.has(key)) {
            map.set(key, item);
            continue;
        }
        const cloud = map.get(key);
        const localTs = toUpdatedTs(item.updated_at || item.updatedAt);
        const cloudTs = toUpdatedTs(cloud.updated_at || cloud.updatedAt);
        if (localTs > cloudTs || (localTs === cloudTs && item._dirty)) {
            map.set(key, item);
        }
    }

    return Array.from(map.values()).sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
}

export function processApiSyncResult(localList, apiData) {
    if (!Array.isArray(apiData)) return { merged: localList || [], needsUpload: false };
    const deletedIds = getDeletedIds();
    const syncedIds = getSyncedIds();

    const apiIds = apiData.map(item => String(item.id));
    addSyncedIds(apiIds);

    const activeLocal = (localList || []).filter(item => {
        if (!item || item.id == null) return false;
        const strId = String(item.id);
        if (deletedIds.includes(strId)) return false;
        if (item._dirty) return true;
        if (syncedIds.includes(strId) && !apiIds.includes(strId)) return false;
        return true;
    });

    const merged = mergeDataLists(activeLocal, apiData);

    const unsyncedLocal = activeLocal.filter(item => !apiIds.includes(String(item.id)));
    const newerDirtyLocal = activeLocal.filter(item => {
        if (!item._dirty) return false;
        const cloud = apiData.find(a => String(a.id) === String(item.id));
        if (!cloud) return false;
        return toUpdatedTs(item.updated_at) >= toUpdatedTs(cloud.updated_at);
    });
    const needsUpload = unsyncedLocal.length > 0 || newerDirtyLocal.length > 0;

    return { merged, needsUpload };
}

let syncStatusTimer = null;
export function setSyncStatus(message, tone = 'info', autoHideMs = 0) {
    const el = document.getElementById('sync-status');
    if (!el) return;
    if (!message) {
        el.hidden = true;
        el.textContent = '';
        return;
    }
    el.hidden = false;
    el.textContent = message;
    el.dataset.tone = tone;
    if (syncStatusTimer) clearTimeout(syncStatusTimer);
    if (autoHideMs > 0) {
        syncStatusTimer = setTimeout(() => {
            if (el.textContent === message) {
                el.hidden = true;
                el.textContent = '';
            }
        }, autoHideMs);
    }
}

function getActiveViewId() {
    return document.querySelector('.view-section.active')?.id || '';
}

function isProtectingLocalEdits() {
    const id = getActiveViewId();
    return id === 'view-editor' || id === 'view-note-editor' || id === 'view-bookmark-editor';
}

let isSyncingInBg = false;
let pendingSyncRetryTimer = null;

export function loadLocalData() {
    const rescued = rescueAndConsolidateLocalData();

    const currentFeeds = JSON.parse(localStorage.getItem(getLocalKey('gardenFeeds'))) || [];
    const currentNotes = JSON.parse(localStorage.getItem('gardenNotes')) || JSON.parse(localStorage.getItem(getLocalKey('gardenNotes'))) || [];
    const currentData = JSON.parse(localStorage.getItem('gardenData')) || JSON.parse(localStorage.getItem(getLocalKey('gardenData'))) || [];
    const currentBookmarks = JSON.parse(localStorage.getItem('gardenBookmarks')) || JSON.parse(localStorage.getItem(getLocalKey('gardenBookmarks'))) || [];

    state.database = mergeDataLists(currentData, rescued.weeklies.length > 0 ? rescued.weeklies : DEFAULT_WEEKLY);
    state.notesDatabase = mergeDataLists(currentNotes, rescued.notes.length > 0 ? rescued.notes : DEFAULT_NOTES);
    state.bookmarksDatabase = mergeDataLists(currentBookmarks, rescued.bookmarks.length > 0 ? rescued.bookmarks : DEFAULT_BOOKMARKS);
    state.feedsDatabase = mergeDataLists(currentFeeds, rescued.feeds.length > 0 ? rescued.feeds : DEFAULT_FEEDS);
    state.echoCardsDatabase = JSON.parse(localStorage.getItem(getLocalKey('gardenEchoCards'))) || [];

    if (state.authUser) {
        saveDatabase();
        saveNotesDatabase();
        saveBookmarksDatabase();
        saveFeedsDatabase();
    }

    refresh('all');
}

export async function syncFromApi() {
    if (!state.authToken || isSyncingInBg) return;
    isSyncingInBg = true;
    let needsBatchUpload = false;
    let hadError = false;

    try {
        try {
            const apiData = await apiRequest('/api/weeklies');
            if (Array.isArray(apiData)) {
                const { merged, needsUpload } = processApiSyncResult(state.database, apiData);
                if (needsUpload) needsBatchUpload = true;
                if (JSON.stringify(state.database) !== JSON.stringify(merged)) {
                    state.database = merged;
                    saveDatabase();
                    if (getActiveViewId() === 'view-home') {
                        refresh('weeklies', {
                            filter: document.querySelector('.filter-btn.active')?.dataset.filter || 'all'
                        });
                    }
                }
            }
        } catch (e) { hadError = true; }

        try {
            const apiData = await apiRequest('/api/notes');
            if (Array.isArray(apiData)) {
                const { merged, needsUpload } = processApiSyncResult(state.notesDatabase, apiData);
                if (needsUpload) needsBatchUpload = true;
                if (JSON.stringify(state.notesDatabase) !== JSON.stringify(merged)) {
                    state.notesDatabase = merged;
                    saveNotesDatabase();
                    if (getActiveViewId() === 'view-notes') refresh('notes');
                }
            }
        } catch (e) { hadError = true; }

        try {
            const apiData = await apiRequest('/api/bookmarks');
            if (Array.isArray(apiData)) {
                const { merged, needsUpload } = processApiSyncResult(state.bookmarksDatabase, apiData);
                if (needsUpload) needsBatchUpload = true;
                if (JSON.stringify(state.bookmarksDatabase) !== JSON.stringify(merged)) {
                    state.bookmarksDatabase = merged.map((bm) => {
                        const desc = (bm && (bm.desc || bm.description)) || '';
                        return { ...bm, desc, description: desc };
                    });
                    saveBookmarksDatabase();
                    if (getActiveViewId() === 'view-bookmarks') refresh('bookmarks');
                }
            }
        } catch (e) { hadError = true; }

        try {
            const apiData = await apiRequest('/api/feeds');
            if (Array.isArray(apiData)) {
                const { merged, needsUpload } = processApiSyncResult(state.feedsDatabase, apiData);
                if (needsUpload) needsBatchUpload = true;
                if (JSON.stringify(state.feedsDatabase) !== JSON.stringify(merged)) {
                    state.feedsDatabase = merged;
                    saveFeedsDatabase();
                    if (getActiveViewId() === 'view-feeds' && !isProtectingLocalEdits()) refresh('feeds');
                }
            }
        } catch (e) { hadError = true; }

        if (needsBatchUpload) {
            try {
                await apiRequest('/api/sync/batch', {
                    method: 'POST',
                    body: JSON.stringify({
                        weeklies: state.database.map(stripClientSyncFlags),
                        notes: state.notesDatabase.map(stripClientSyncFlags),
                        bookmarks: state.bookmarksDatabase.map(stripClientSyncFlags),
                        feeds: state.feedsDatabase.map(stripClientSyncFlags)
                    })
                });
                state.database.forEach(i => { if (i) i._dirty = false; });
                state.notesDatabase.forEach(i => { if (i) i._dirty = false; });
                state.bookmarksDatabase.forEach(i => { if (i) i._dirty = false; });
                state.feedsDatabase.forEach(i => { if (i) i._dirty = false; });
                saveDatabase(); saveNotesDatabase(); saveBookmarksDatabase(); saveFeedsDatabase();
                setSyncStatus('已同步', 'ok', 2000);
            } catch (e) {
                hadError = true;
                setSyncStatus('未同步 · 将重试', 'warn');
            }
        }

        try {
            const apiData = await apiRequest('/api/echo/cards');
            if (Array.isArray(apiData)) {
                if (JSON.stringify(state.echoCardsDatabase) !== JSON.stringify(apiData)) {
                    state.echoCardsDatabase = apiData;
                    localStorage.setItem(getLocalKey('gardenEchoCards'), JSON.stringify(state.echoCardsDatabase));
                    if (getActiveViewId() === 'view-feeds' || getActiveViewId() === 'view-home') {
                        refresh('echo');
                    }
                }
            }
        } catch (e) { hadError = true; }

        if (!isProtectingLocalEdits() && (getActiveViewId() === 'view-home' || getActiveViewId() === 'view-feeds')) {
            refresh('heatmap');
        }

        if (hadError) {
            setSyncStatus('同步异常 · 将重试', 'warn');
            if (!pendingSyncRetryTimer) {
                pendingSyncRetryTimer = setTimeout(() => {
                    pendingSyncRetryTimer = null;
                    syncFromApi();
                }, 12000);
            }
        }
    } finally {
        isSyncingInBg = false;
    }
}

export function saveDatabase() {
    localStorage.setItem(getLocalKey('gardenData'), JSON.stringify(state.database));
}
export function saveNotesDatabase() {
    localStorage.setItem(getLocalKey('gardenNotes'), JSON.stringify(state.notesDatabase));
}
export function saveBookmarksDatabase() {
    localStorage.setItem(getLocalKey('gardenBookmarks'), JSON.stringify(state.bookmarksDatabase));
}
export function saveFeedsDatabase() {
    localStorage.setItem(getLocalKey('gardenFeeds'), JSON.stringify(state.feedsDatabase));
}

function markSyncedItem(item) {
    if (!item || item.id == null) return;
    item._dirty = false;
    if (!item.updated_at) item.updated_at = new Date().toISOString();
    addSyncedIds([item.id]);
}

function handleSyncFailure(err) {
    console.warn('[sync] failed:', err);
    setSyncStatus('未同步 · 将重试', 'warn');
    if (!pendingSyncRetryTimer) {
        pendingSyncRetryTimer = setTimeout(() => {
            pendingSyncRetryTimer = null;
            syncFromApi();
        }, 8000);
    }
}

export function apiSyncWeekly(item, method) {
    const payload = method === 'DELETE' ? item : stampLocalUpdate({ ...item });
    if (method !== 'DELETE' && item) {
        item.updated_at = payload.updated_at;
        item._dirty = true;
    }
    const bm = method === 'DELETE' ? { method: 'DELETE' } : { method, body: JSON.stringify(stripClientSyncFlags(payload)) };
    const id = method === 'POST' ? '' : `/${item.id}`;
    return apiRequest(`/api/weeklies${id}`, bm).then((res) => {
        if (method !== 'DELETE') markSyncedItem(item);
        setSyncStatus('已同步', 'ok', 1800);
        return res;
    }).catch((err) => { handleSyncFailure(err); return null; });
}

export function apiSyncNote(item, method) {
    const payload = method === 'DELETE' ? item : stampLocalUpdate({ ...item });
    if (method !== 'DELETE' && item) {
        item.updated_at = payload.updated_at;
        item._dirty = true;
    }
    const bm = method === 'DELETE' ? { method: 'DELETE' } : { method, body: JSON.stringify(stripClientSyncFlags(payload)) };
    const id = method === 'POST' ? '' : `/${item.id}`;
    return apiRequest(`/api/notes${id}`, bm).then((res) => {
        if (method !== 'DELETE') markSyncedItem(item);
        setSyncStatus('已同步', 'ok', 1800);
        return res;
    }).catch((err) => { handleSyncFailure(err); return null; });
}

export function apiSyncBookmark(item, method) {
    const payload = method === 'DELETE' ? item : stampLocalUpdate({ ...item });
    if (method !== 'DELETE' && item) {
        item.updated_at = payload.updated_at;
        item._dirty = true;
    }
    const bm = method === 'DELETE' ? { method: 'DELETE' } : { method, body: JSON.stringify(stripClientSyncFlags(payload)) };
    const id = method === 'POST' ? '' : `/${item.id}`;
    return apiRequest(`/api/bookmarks${id}`, bm).then((res) => {
        if (method !== 'DELETE') markSyncedItem(item);
        setSyncStatus('已同步', 'ok', 1800);
        return res;
    }).catch((err) => { handleSyncFailure(err); return null; });
}

export function apiSyncFeed(item, method) {
    const payload = method === 'DELETE' ? item : stampLocalUpdate({ ...item });
    if (method !== 'DELETE' && item) {
        item.updated_at = payload.updated_at;
        item._dirty = true;
    }
    const bm = method === 'DELETE' ? { method: 'DELETE' } : { method, body: JSON.stringify(stripClientSyncFlags(payload)) };
    const id = method === 'POST' ? '' : `/${item.id}`;
    return apiRequest(`/api/feeds${id}`, bm).then((res) => {
        if (method !== 'DELETE') markSyncedItem(item);
        setSyncStatus('已同步', 'ok', 1800);
        return res;
    }).catch((err) => { handleSyncFailure(err); return null; });
}

export async function checkAndMergeGuestData() {
    if (!state.authUser) return;

    const guestData = JSON.parse(localStorage.getItem('default_gardenData')) || [];
    const guestNotes = JSON.parse(localStorage.getItem('default_gardenNotes')) || [];
    const guestBookmarks = JSON.parse(localStorage.getItem('default_gardenBookmarks')) || [];
    const guestFeeds = JSON.parse(localStorage.getItem('default_gardenFeeds')) || [];

    const hasGuestData = guestData.length > 0 && !(guestData.length === 1 && guestData[0].id === 1);
    const hasGuestNotes = guestNotes.length > 0 && !guestNotes.every(n => n.id === 101 || n.id === 102);
    const hasGuestBookmarks = guestBookmarks.length > 0 && !guestBookmarks.every(b => b.id === 201 || b.id === 202 || b.id === 203);
    const hasGuestFeeds = guestFeeds.length > 0 && !(guestFeeds.length === 1 && guestFeeds[0].id === 1);

    if (hasGuestData || hasGuestNotes || hasGuestBookmarks || hasGuestFeeds) {
        if (confirm('检测到您在未登录时在当前设备上创建了本地数据（周记/笔记/收藏/随手记）。是否将这些数据导入并同步到您当前的账号中？')) {
            try {
                const userKey = getLocalKey('gardenData');
                let userDatabase = JSON.parse(localStorage.getItem(userKey)) || [];
                userDatabase = [...userDatabase, ...guestData].filter((item, index, self) =>
                    self.findIndex(t => t.id === item.id) === index
                );
                localStorage.setItem(userKey, JSON.stringify(userDatabase));
                state.database = userDatabase;

                const userNotesKey = getLocalKey('gardenNotes');
                let userNotesDatabase = JSON.parse(localStorage.getItem(userNotesKey)) || [];
                userNotesDatabase = [...userNotesDatabase, ...guestNotes].filter((item, index, self) =>
                    self.findIndex(t => t.id === item.id) === index
                );
                localStorage.setItem(userNotesKey, JSON.stringify(userNotesDatabase));
                state.notesDatabase = userNotesDatabase;

                const userBMKey = getLocalKey('gardenBookmarks');
                let userBMDatabase = JSON.parse(localStorage.getItem(userBMKey)) || [];
                userBMDatabase = [...userBMDatabase, ...guestBookmarks].filter((item, index, self) =>
                    self.findIndex(t => t.id === item.id) === index
                );
                localStorage.setItem(userBMKey, JSON.stringify(userBMDatabase));
                state.bookmarksDatabase = userBMDatabase;

                const userFeedsKey = getLocalKey('gardenFeeds');
                let userFeedsDatabase = JSON.parse(localStorage.getItem(userFeedsKey)) || [];
                userFeedsDatabase = [...userFeedsDatabase, ...guestFeeds].filter((item, index, self) =>
                    self.findIndex(t => t.id === item.id) === index
                );
                localStorage.setItem(userFeedsKey, JSON.stringify(userFeedsDatabase));
                state.feedsDatabase = userFeedsDatabase;

                await apiRequest('/api/sync/batch', {
                    method: 'POST',
                    body: JSON.stringify({
                        weeklies: guestData,
                        notes: guestNotes,
                        bookmarks: guestBookmarks,
                        feeds: guestFeeds
                    })
                });

                localStorage.removeItem('default_gardenData');
                localStorage.removeItem('default_gardenNotes');
                localStorage.removeItem('default_gardenBookmarks');
                localStorage.removeItem('default_gardenFeeds');

                showToast('本地数据已成功合并并同步至云端！', 'success');
                refresh('all');
            } catch (e) {
                showToast('合并同步部分数据失败：' + e.message, 'error');
            }
        }
    }
}

let autoSyncInterval = null;
export function startAutoSyncEngine() {
    if (autoSyncInterval) clearInterval(autoSyncInterval);
    autoSyncInterval = setInterval(() => {
        if (document.visibilityState === 'visible' && state.authToken) {
            syncFromApi();
        }
    }, 15000);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && state.authToken) {
            syncFromApi();
        }
    });
    window.addEventListener('focus', () => {
        if (state.authToken) syncFromApi();
    });
    window.addEventListener('online', () => {
        if (state.authToken) syncFromApi();
    });
}
