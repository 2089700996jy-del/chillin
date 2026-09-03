/**
 * Local persistence & cloud sync: merge, incremental pull, apiSync*, auto-sync.
 * Depends on auth.js for HTTP (apiRequest / getLocalKey / refresh).
 */
import { showToast, getEast8Time } from './utils.js';
import {
    state,
    DEFAULT_WEEKLY,
    DEFAULT_NOTES,
    DEFAULT_BOOKMARKS,
    DEFAULT_FEEDS,
} from './state.js';
import {
    apiRequest,
    getLocalKey,
    refresh,
} from './auth.js';

const SYNC_RESOURCES = ['weeklies', 'notes', 'bookmarks', 'feeds'];

/** Per-user incremental sync cursor (migrates legacy global keys once). */
function getSyncCursor(resource) {
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

function setSyncCursor(resource, value) {
    if (!value) return;
    localStorage.setItem(getLocalKey(`sync_${resource}`), value);
}

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

function getSyncedIds() {
    try {
        return JSON.parse(localStorage.getItem(getLocalKey('gardenSyncedIds'))) || [];
    } catch (e) { return []; }
}

function addSyncedIds(ids) {
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

function getDeletedIds() {
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

function toUpdatedTs(value) {
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

function stripClientSyncFlags(item) {
    if (!item || typeof item !== 'object') return item;
    const copy = { ...item };
    delete copy._dirty;
    return copy;
}

function mergeDataLists(localList, apiList) {
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

function processApiSyncResult(localList, apiData, isIncremental = false) {
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

    const pullSpecs = [
        {
            resource: 'weeklies',
            path: '/api/weeklies',
            getList: () => state.database,
            setList: (list) => { state.database = list; },
            save: saveDatabase,
            shouldRefresh: () => getActiveViewId() === 'view-home',
            refresh: () => refresh('weeklies', {
                filter: document.querySelector('.filter-btn.active')?.dataset.filter || 'all'
            }),
        },
        {
            resource: 'notes',
            path: '/api/notes',
            getList: () => state.notesDatabase,
            setList: (list) => { state.notesDatabase = list; },
            save: saveNotesDatabase,
            shouldRefresh: () => getActiveViewId() === 'view-notes',
            refresh: () => refresh('notes'),
        },
        {
            resource: 'bookmarks',
            path: '/api/bookmarks',
            getList: () => state.bookmarksDatabase,
            setList: (list) => {
                state.bookmarksDatabase = list.map((bm) => {
                    const desc = (bm && (bm.desc || bm.description)) || '';
                    return { ...bm, desc, description: desc };
                });
            },
            save: saveBookmarksDatabase,
            shouldRefresh: () => getActiveViewId() === 'view-bookmarks',
            refresh: () => refresh('bookmarks'),
        },
        {
            resource: 'feeds',
            path: '/api/feeds',
            getList: () => state.feedsDatabase,
            setList: (list) => { state.feedsDatabase = list; },
            save: saveFeedsDatabase,
            shouldRefresh: () => getActiveViewId() === 'view-feeds' && !isProtectingLocalEdits(),
            refresh: () => refresh('feeds'),
        },
    ];

    try {
        for (const spec of pullSpecs) {
            try {
                const lastSync = getSyncCursor(spec.resource);
                const url = lastSync ? `${spec.path}?since=${encodeURIComponent(lastSync)}` : spec.path;
                const apiData = await apiRequest(url);
                if (!Array.isArray(apiData)) continue;
                const { merged, needsUpload } = processApiSyncResult(spec.getList(), apiData, !!lastSync);
                if (needsUpload) needsBatchUpload = true;
                if (JSON.stringify(spec.getList()) !== JSON.stringify(merged)) {
                    spec.setList(merged);
                    spec.save();
                    if (spec.shouldRefresh()) spec.refresh();
                }
                if (apiData.length > 0) {
                    const maxTs = apiData.map(a => a.updated_at).filter(Boolean).sort().pop();
                    if (maxTs) setSyncCursor(spec.resource, maxTs);
                }
            } catch (e) {
                hadError = true;
            }
        }

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

function apiSyncResource(apiPath, item, method) {
    const payload = method === 'DELETE' ? item : stampLocalUpdate({ ...item });
    if (method !== 'DELETE' && item) {
        item.updated_at = payload.updated_at;
        item._dirty = true;
    }
    const bm = method === 'DELETE'
        ? { method: 'DELETE' }
        : { method, body: JSON.stringify(stripClientSyncFlags(payload)) };
    const id = method === 'POST' ? '' : `/${item.id}`;
    return apiRequest(`${apiPath}${id}`, bm).then((res) => {
        if (method !== 'DELETE') markSyncedItem(item);
        setSyncStatus('已同步', 'ok', 1800);
        return res;
    }).catch((err) => { handleSyncFailure(err); return null; });
}

export function apiSyncWeekly(item, method) {
    return apiSyncResource('/api/weeklies', item, method);
}

export function apiSyncNote(item, method) {
    return apiSyncResource('/api/notes', item, method);
}

export function apiSyncBookmark(item, method) {
    return apiSyncResource('/api/bookmarks', item, method);
}

export function apiSyncFeed(item, method) {
    return apiSyncResource('/api/feeds', item, method);
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
let lastAutoSyncAt = 0;

function requestAutoSync(minGapMs = 2500) {
    if (!state.authToken) return;
    const now = Date.now();
    if (now - lastAutoSyncAt < minGapMs) return;
    lastAutoSyncAt = now;
    syncFromApi();
}

export function startAutoSyncEngine() {
    if (autoSyncInterval) clearInterval(autoSyncInterval);
    // 省电：以前台切回/联网为主；前台常开时最多约每 5 分钟兜底一次（原 15 秒）
    autoSyncInterval = setInterval(() => {
        if (document.visibilityState === 'visible') requestAutoSync(60 * 1000);
    }, 5 * 60 * 1000);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') requestAutoSync();
    });
    window.addEventListener('focus', () => requestAutoSync());
    window.addEventListener('online', () => requestAutoSync(0));
}

