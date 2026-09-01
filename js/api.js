/** Auth, persistence, and cloud sync. UI refresh via bindApiHooks. */

import { showToast, urlBase64ToUint8Array, getEast8Time } from './utils.js';
import { CLOUD_WORKER_BASE, resolveApiBase } from './config.js';
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
let API_BASE = resolveApiBase();
export { API_BASE };
export { CLOUD_WORKER_BASE };

export function resolveAssetUrl(src) {
    if (src && API_BASE && (src.startsWith('/api/') || src.startsWith('/uploads/'))) {
        return API_BASE + src;
    }
    return src;
}

async function readErrorMessage(res) {
    try {
        const data = await res.clone().json();
        if (data && data.error) return String(data.error);
    } catch (_) {}
    try {
        const text = (await res.clone().text()).trim();
        if (text && text.length < 200 && !text.startsWith('<')) return text;
    } catch (_) {}
    if (res.status === 429) return '请求过于频繁，请稍后再试';
    if (res.status >= 500) return `服务暂时不可用 (${res.status})`;
    return `请求失败 (${res.status})`;
}

/** 登录/注册错误：区分密码错、限流、网络、服务异常 */
function formatAuthError(err, res, data) {
    if (!res && err) {
        if (err.name === 'AbortError') return '请求超时，请检查网络后重试';
        if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
            return '网络连接失败，请检查手机网络后重试';
        }
        return err.message || '登录失败';
    }
    const status = res ? res.status : 0;
    const serverMsg = (data && data.error) ? String(data.error) : '';
    if (status === 429) {
        const retry = (data && data.retryAfter)
            || (res && res.headers.get('Retry-After'))
            || null;
        const tip = serverMsg.includes('登录') ? serverMsg : '登录过于频繁，请稍后再试';
        if (retry) return `${tip}（约 ${retry} 秒）`;
        return tip;
    }
    if (status === 401) return '账号或密码错误';
    if (status === 403) return serverMsg || '暂无权限，请联系管理员';
    if (status === 400) return serverMsg || '请检查账号和密码格式';
    if (status >= 500) return '服务暂时不可用，请稍后重试';
    if (status === 0) return '网络连接失败，请检查手机网络后重试';
    return serverMsg || (err && err.message) || '登录失败';
}

export async function fetchWithFallback(path, options = {}) {
    const primaryUrl = `${API_BASE}${path}`;
    const workerUrl = `${CLOUD_WORKER_BASE}${path}`;
    const isAuth = path.startsWith('/api/auth/');

    const looksBad = (res) => {
        if (!res) return true;
        if (res.status >= 500) return true;
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        return ct.includes('text/html');
    };

    let primaryRes = null;
    let primaryErr = null;
    try {
        primaryRes = await fetch(primaryUrl, options);
    } catch (err) {
        primaryErr = err;
    }

    if (primaryRes && !looksBad(primaryRes)) return primaryRes;

    // 同源代理失败 / 5xx / HTML：改打 Worker（登录尤其依赖）
    if (isAuth || primaryErr || looksBad(primaryRes)) {
        try {
            return await fetch(workerUrl, options);
        } catch (workerErr) {
            if (primaryRes) return primaryRes;
            throw primaryErr || workerErr;
        }
    }

    if (primaryRes) return primaryRes;
    throw primaryErr || new Error('网络连接失败');
}

async function parseJsonSafe(res) {
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) {
        throw new Error('服务返回异常页面，请刷新后重试');
    }
    try {
        return await res.json();
    } catch {
        throw new Error(await readErrorMessage(res) || '无法解析服务器响应');
    }
}

export function getLocalKey(key) {
    return state.authUser ? `${state.authUser.id}_${key}` : `default_${key}`;
}

const SYNC_RESOURCES = ['weeklies', 'notes', 'bookmarks', 'feeds'];

/** Per-user incremental sync cursor (migrates legacy global keys once). */
export function getSyncCursor(resource) {
    const keyed = localStorage.getItem(getLocalKey(`sync_${resource}`));
    if (keyed) return keyed;
    const legacy = localStorage.getItem(`chillin_sync_${resource}`);
    if (legacy && state.authUser) {
        localStorage.setItem(getLocalKey(`sync_${resource}`), legacy);
        localStorage.removeItem(`chillin_sync_${resource}`);
        return legacy;
    }
    return null;
}

export function setSyncCursor(resource, value) {
    if (!value) return;
    localStorage.setItem(getLocalKey(`sync_${resource}`), value);
}

export function clearSyncCursorsForUser(userId) {
    if (userId == null) return;
    for (const resource of SYNC_RESOURCES) {
        localStorage.removeItem(`${userId}_sync_${resource}`);
        localStorage.removeItem(`chillin_sync_${resource}`);
    }
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
    const uid = state.authUser?.id;
    if (state.authToken) {
        apiRequest('/api/auth/logout', { method: 'POST' }).catch(() => {});
    }
    state.authToken = '';
    state.authUser = null;
    localStorage.removeItem('chillin_token');
    localStorage.removeItem('chillin_user');
    clearSyncCursorsForUser(uid);
    checkAuth();
    if (opts.silent) return;
    if (opts.reason === 'expired') {
        showToast('登录已过期，请重新登录', 'warn');
    } else {
        showToast('已退出登录', 'info');
    }
}

export async function doLogin() {
    const username = document.getElementById('auth-username')?.value.trim() || '';
    const password = document.getElementById('auth-password')?.value.trim() || '';
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
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        let data = null;
        try {
            data = await parseJsonSafe(res);
        } catch (parseErr) {
            throw Object.assign(parseErr, { _authRes: res, _authData: null });
        }
        if (!res.ok) {
            const msg = formatAuthError(null, res, data);
            throw Object.assign(new Error(msg), { _authRes: res, _authData: data });
        }
        if (!data.token) throw new Error('登录响应异常，请刷新后重试');

        state.authToken = data.token;
        state.authUser = { id: data.userId, username: data.username };
        localStorage.setItem('chillin_token', state.authToken);
        localStorage.setItem('chillin_user', JSON.stringify(state.authUser));

        checkAuth();
        showToast('登录成功，欢迎来到数字花园', 'success');
        try { loadLocalData(); } catch (_) {}
        // 同步失败不应把用户踢回登录页
        Promise.resolve()
            .then(() => syncFromApi())
            .catch((e) => console.warn('[login] sync after login failed', e));
        try { checkAndMergeGuestData(); } catch (_) {}
        setTimeout(registerPushNotification, 2000);
    } catch (err) {
        const errorMsg = formatAuthError(err, err._authRes, err._authData);
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

// 模块加载后立刻挂上，避免后续 init 抛错导致按钮无响应
if (typeof window !== 'undefined') {
    window._chillinLogin = doLogin;
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
    if (!/[zZ]|[+\-]\d{2}:?\d{2}$/.test(s)) s += '+08:00';
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
}

export function stampLocalUpdate(item) {
    if (!item || typeof item !== 'object') return item;
    item.updated_at = getEast8Time();
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

export function processApiSyncResult(localList, apiData, isIncremental = false) {
    if (!Array.isArray(apiData)) return { merged: localList || [], needsUpload: false };
    const syncedIds = getSyncedIds();

    const apiIds = apiData.map(item => String(item.id));
    if (!isIncremental) {
        addSyncedIds(apiIds);
    } else {
        const newSynced = new Set([...syncedIds, ...apiIds]);
        addSyncedIds(Array.from(newSynced));
    }

    // Soft-delete tombstones from cloud → remember locally so we don't re-upload
    for (const item of apiData) {
        if (item && item.is_deleted && item.id != null) addDeletedId(item.id);
    }
    const deletedIdSet = new Set(getDeletedIds().map(String));

    const activeLocal = (localList || []).filter(item => {
        if (!item || item.id == null) return false;
        const strId = String(item.id);
        if (deletedIdSet.has(strId)) return false;
        
        // Soft delete from incremental sync
        const cloudItem = apiData.find(a => String(a.id) === strId);
        if (cloudItem && cloudItem.is_deleted) return false;

        if (item._dirty) return true;
        
        // Full sync: if synced but missing from cloud, it was deleted
        if (!isIncremental && syncedIds.includes(strId) && !apiIds.includes(strId)) return false;
        
        return true;
    });

    const validApiData = apiData.filter(item => !item.is_deleted);
    const merged = mergeDataLists(activeLocal, validApiData);

    const needsUpload = activeLocal.some(item => {
        if (!item._dirty) return false;
        const cloud = validApiData.find(a => String(a.id) === String(item.id));
        if (!cloud) return true;
        return toUpdatedTs(item.updated_at) >= toUpdatedTs(cloud.updated_at);
    });

    return { merged, needsUpload };
}

let syncStatusTimer = null;
/** 同步指示灯：ok=绿 / warn|info=黄 / error=红；无可见文字 */
export function setSyncStatus(message, tone = 'info', autoHideMs = 0) {
    const el = document.getElementById('sync-status');
    if (!el) return;
    if (!message) {
        el.hidden = true;
        el.removeAttribute('data-tone');
        el.removeAttribute('aria-label');
        return;
    }
    // ok→绿，error→红，其余（同步中/将重试）→黄
    const light = tone === 'ok' ? 'ok' : (tone === 'error' ? 'error' : 'warn');
    el.hidden = false;
    el.textContent = '';
    el.dataset.tone = light;
    el.setAttribute('aria-label', message);
    if (syncStatusTimer) clearTimeout(syncStatusTimer);
    if (autoHideMs > 0) {
        syncStatusTimer = setTimeout(() => {
            if (el.getAttribute('aria-label') === message) {
                el.hidden = true;
                el.removeAttribute('data-tone');
                el.removeAttribute('aria-label');
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
    setSyncStatus('同步中', 'info');

    try {
        try {
            const lastSync = getSyncCursor('weeklies');
            const url = lastSync ? `/api/weeklies?since=${encodeURIComponent(lastSync)}` : '/api/weeklies';
            const apiData = await apiRequest(url);
            if (Array.isArray(apiData)) {
                const { merged, needsUpload } = processApiSyncResult(state.database, apiData, !!lastSync);
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
                if (apiData.length > 0) {
                    const maxTs = apiData.map(a => a.updated_at).filter(Boolean).sort().pop();
                    if (maxTs) setSyncCursor('weeklies', maxTs);
                }
            }
        } catch (e) { hadError = true; }

        try {
            const lastSync = getSyncCursor('notes');
            const url = lastSync ? `/api/notes?since=${encodeURIComponent(lastSync)}` : '/api/notes';
            const apiData = await apiRequest(url);
            if (Array.isArray(apiData)) {
                const { merged, needsUpload } = processApiSyncResult(state.notesDatabase, apiData, !!lastSync);
                if (needsUpload) needsBatchUpload = true;
                if (JSON.stringify(state.notesDatabase) !== JSON.stringify(merged)) {
                    state.notesDatabase = merged;
                    saveNotesDatabase();
                    if (getActiveViewId() === 'view-notes') refresh('notes');
                }
                if (apiData.length > 0) {
                    const maxTs = apiData.map(a => a.updated_at).filter(Boolean).sort().pop();
                    if (maxTs) setSyncCursor('notes', maxTs);
                }
            }
        } catch (e) { hadError = true; }

        try {
            const lastSync = getSyncCursor('bookmarks');
            const url = lastSync ? `/api/bookmarks?since=${encodeURIComponent(lastSync)}` : '/api/bookmarks';
            const apiData = await apiRequest(url);
            if (Array.isArray(apiData)) {
                const { merged, needsUpload } = processApiSyncResult(state.bookmarksDatabase, apiData, !!lastSync);
                if (needsUpload) needsBatchUpload = true;
                if (JSON.stringify(state.bookmarksDatabase) !== JSON.stringify(merged)) {
                    state.bookmarksDatabase = merged.map((bm) => {
                        const desc = (bm && (bm.desc || bm.description)) || '';
                        return { ...bm, desc, description: desc };
                    });
                    saveBookmarksDatabase();
                    if (getActiveViewId() === 'view-bookmarks') refresh('bookmarks');
                }
                if (apiData.length > 0) {
                    const maxTs = apiData.map(a => a.updated_at).filter(Boolean).sort().pop();
                    if (maxTs) setSyncCursor('bookmarks', maxTs);
                }
            }
        } catch (e) { hadError = true; }

        try {
            const lastSync = getSyncCursor('feeds');
            const url = lastSync ? `/api/feeds?since=${encodeURIComponent(lastSync)}` : '/api/feeds';
            const apiData = await apiRequest(url);
            if (Array.isArray(apiData)) {
                const { merged, needsUpload } = processApiSyncResult(state.feedsDatabase, apiData, !!lastSync);
                if (needsUpload) needsBatchUpload = true;
                if (JSON.stringify(state.feedsDatabase) !== JSON.stringify(merged)) {
                    state.feedsDatabase = merged;
                    saveFeedsDatabase();
                    if (getActiveViewId() === 'view-feeds' && !isProtectingLocalEdits()) refresh('feeds');
                }
                if (apiData.length > 0) {
                    const maxTs = apiData.map(a => a.updated_at).filter(Boolean).sort().pop();
                    if (maxTs) setSyncCursor('feeds', maxTs);
                }
            }
        } catch (e) { hadError = true; }

        if (needsBatchUpload) {
            try {
                const deleted = new Set(getDeletedIds().map(String));
                const alive = (list) => (list || [])
                    .filter(item => item && item.id != null && !deleted.has(String(item.id)))
                    .map(stripClientSyncFlags);
                await apiRequest('/api/sync/batch', {
                    method: 'POST',
                    body: JSON.stringify({
                        weeklies: alive(state.database),
                        notes: alive(state.notesDatabase),
                        bookmarks: alive(state.bookmarksDatabase),
                        feeds: alive(state.feedsDatabase)
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
                setSyncStatus('未同步', 'warn');
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
            setSyncStatus('同步异常', 'error');
            if (!pendingSyncRetryTimer) {
                pendingSyncRetryTimer = setTimeout(() => {
                    pendingSyncRetryTimer = null;
                    syncFromApi();
                }, 12000);
            }
        } else if (!needsBatchUpload) {
            setSyncStatus('已同步', 'ok', 2000);
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
    if (!item.updated_at) item.updated_at = getEast8Time();
    addSyncedIds([item.id]);
}

function handleSyncFailure(err) {
    console.warn('[sync] failed:', err);
    setSyncStatus('未同步', 'warn');
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
