/**
 * Local persistence & cloud sync: merge, incremental pull, apiSync*, auto-sync.
 * Depends on auth.js for HTTP (apiRequest / getLocalKey / refresh).
 */
import { showToast, getEast8Time, skeletonListHtml, ensureLocalId, selectDirtyItems, confirmDialog } from './utils.js';
import {
    state,
    DEFAULT_WEEKLY,
    DEFAULT_NOTES,
    DEFAULT_BOOKMARKS,
    DEFAULT_FEEDS,
    DEFAULT_PROMPTS,
} from './state.js';
import {
    apiRequest,
    getLocalKey,
    refresh,
} from './auth.js';
import { setHtml } from './trusted-types.js';
import { idbSet, idbGetBatch, migrateFromLocalStorage } from './db.js';

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
    let rescuedPrompts = [];

    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;
            if (key.includes('gardenFeeds')) {
                const items = readJsonValue(key);
                if (Array.isArray(items)) rescuedFeeds.push(...items);
            } else if (key.includes('gardenNotes')) {
                const items = readJsonValue(key);
                if (Array.isArray(items)) rescuedNotes.push(...items);
            } else if (key.includes('gardenData')) {
                const items = readJsonValue(key);
                if (Array.isArray(items)) rescuedWeeklies.push(...items);
            } else if (key.includes('gardenBookmarks')) {
                const items = readJsonValue(key);
                if (Array.isArray(items)) rescuedBookmarks.push(...items);
            } else if (key.includes('gardenPrompts')) {
                const items = readJsonValue(key);
                if (Array.isArray(items)) rescuedPrompts.push(...items);
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
        bookmarks: cleanList(rescuedBookmarks, [201, 202, 203]),
        prompts: cleanList(rescuedPrompts, [301, 302, 303, 304])
    };
}

/**
 * 安全读取 localStorage 中的 JSON 值：存档被手工改坏或写入中断时返回 null，
 * 由调用方决定降级。裸 JSON.parse 会让一个损坏的 key 抛异常，中断整条离线同步链路。
 */
export function readJsonValue(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw == null ? null : JSON.parse(raw);
    } catch (err) {
        console.warn('[sync] 本地数据解析失败，按空值降级:', key);
        return null;
    }
}

function getSyncedIds() {
    try {
        return readJsonValue(getLocalKey('gardenSyncedIds')) || [];
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
        return readJsonValue(getLocalKey('gardenDeletedIds')) || [];
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
export function removeDeletedId(id) {
    if (!id) return;
    const current = getDeletedIds();
    const str = String(id);
    const next = current.filter((entry) => String(entry) !== str);
    if (next.length !== current.length) localStorage.setItem(getLocalKey('gardenDeletedIds'), JSON.stringify(next));
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

/**
 * Overlap the saved cursor by one second so writes sharing D1's second-precision
 * timestamp are returned again; mergeDataLists safely deduplicates those rows.
 */
export function getIncrementalSyncCursor(value) {
    const timestamp = toUpdatedTs(value);
    if (!timestamp) return value;
    const east8 = new Date(timestamp - 1000 + 8 * 60 * 60 * 1000);
    const pad = (part) => String(part).padStart(2, '0');
    return `${east8.getUTCFullYear()}-${pad(east8.getUTCMonth() + 1)}-${pad(east8.getUTCDate())} ${pad(east8.getUTCHours())}:${pad(east8.getUTCMinutes())}:${pad(east8.getUTCSeconds())}`;
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

/**
 * 记录本次推送中每条记录的 ID 及其对应的 updated_at 时间戳（毫秒）
 */
export function makePushedTimestampMap(items) {
    const map = new Map();
    if (!Array.isArray(items)) return map;
    for (const item of items) {
        if (item && item.id != null) {
            map.set(String(item.id), toUpdatedTs(item.updated_at));
        }
    }
    return map;
}

/**
 * 安全清除脏标记：仅清除更新时间戳不超过本次推送快照的记录
 * 若用户在网络传输期间进行了新编辑，其 updated_at 会大于推送快照，从而安全保留 _dirty: true
 */
export function clearPushedDirtyFlags(list, pushedMap) {
    if (!Array.isArray(list) || !pushedMap) return false;
    let changed = false;
    for (const item of list) {
        if (!item || item.id == null || !item._dirty) continue;
        const pushedTs = pushedMap.get(String(item.id));
        if (pushedTs !== undefined) {
            const currentTs = toUpdatedTs(item.updated_at);
            if (currentTs <= pushedTs) {
                item._dirty = false;
                changed = true;
            }
        }
    }
    return changed;
}

// ── 同步冲突保护：base 记录上次成功同步的云端版本，冲突时不覆盖本地 ──
const SYNC_BASES_KEY = 'gardenSyncBases';
const SYNC_CONFLICT_KEY = 'gardenSyncConflicts';
const SYNC_HISTORY_KEY = 'gardenSyncHistory';
const SYNC_CONFLICT_MAX = 30;
const SYNC_HISTORY_MAX = 30;
const RESOURCE_LABELS = { weeklies: '周记', notes: '笔记', bookmarks: '收藏', prompts: '提示词', feeds: '随手记' };
const RESOURCE_FIELDS = {
    weeklies: ['category', 'title', 'summary', 'date', 'cover', 'weeklyData', 'content', 'annotations'],
    notes: ['title', 'content', 'date', 'annotations'],
    bookmarks: ['type', 'title', 'url', 'description', 'image'],
    prompts: ['title', 'project', 'scene', 'content', 'description', 'tags', 'is_pinned'],
    feeds: ['content', 'type', 'media_url', 'summary', 'tags']
};

function stableStringify(value) {
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    }
    return JSON.stringify(value === undefined ? null : value);
}

function fnv1a(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

/** 只对用户可编辑字段做稳定指纹，忽略 _dirty/updated_at 等同步噪音。 */
function signatureValue(resource, item, field) {
    if (resource === 'bookmarks' && field === 'description') return item.description ?? item.desc ?? '';
    if (resource === 'feeds' && field === 'media_url') return item.media_url ?? item.mediaUrl ?? '';
    if (field === 'is_pinned') return item.is_pinned ? 1 : 0;
    if (field === 'cover' || field === 'image') return item[field] || '';
    return item[field] === undefined ? null : item[field];
}
export function syncSignature(resource, item) {
    if (!item) return '';
    const fields = RESOURCE_FIELDS[resource] || [];
    const text = fields.map((field) => JSON.stringify(field) + ':' + stableStringify(signatureValue(resource, item, field))).join('|');
    return fnv1a(text) + ':' + text.length;
}

let syncBasesCache = null;
let syncBasesCacheKey = '';
function syncBasesStore() {
    const key = getLocalKey(SYNC_BASES_KEY);
    if (syncBasesCache === null || syncBasesCacheKey !== key) {
        syncBasesCacheKey = key;
        try { syncBasesCache = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (_) { syncBasesCache = {}; }
    }
    return syncBasesCache;
}
function persistSyncBases() {
    try { localStorage.setItem(syncBasesCacheKey || getLocalKey(SYNC_BASES_KEY), JSON.stringify(syncBasesStore())); } catch (_) {}
}
function syncBaseKey(resource, id) { return resource + ':' + String(id); }
export function getSyncBase(resource, id) {
    if (id == null) return null;
    return syncBasesStore()[syncBaseKey(resource, id)] || null;
}
function writeSyncBase(resource, item, updatedAt) {
    if (!item || item.id == null) return false;
    const ts = updatedAt || item.updated_at || item.updatedAt || null;
    if (!ts) return false;
    syncBasesStore()[syncBaseKey(resource, item.id)] = { updated_at: ts, signature: syncSignature(resource, item) };
    return true;
}
export function rememberSyncBase(resource, item, updatedAt) {
    if (writeSyncBase(resource, item, updatedAt)) persistSyncBases();
}
export function forgetSyncBase(resource, id) {
    const bases = syncBasesStore();
    const key = syncBaseKey(resource, id);
    if (bases[key]) { delete bases[key]; persistSyncBases(); }
}
function rememberCloudBases(resource, apiList, protectKeys) {
    if (!Array.isArray(apiList) || !resource) return;
    let changed = false;
    for (const item of apiList) {
        if (!item || item.id == null || item.is_deleted) continue;
        if (protectKeys && protectKeys.has(String(item.id))) continue;
        if (writeSyncBase(resource, item)) changed = true;
    }
    if (changed) persistSyncBases();
}

function readStoredList(key) {
    try {
        const value = JSON.parse(localStorage.getItem(getLocalKey(key)) || '[]');
        return Array.isArray(value) ? value : [];
    } catch (_) { return []; }
}
const SYNC_STORAGE_MAX_CHARS = 1500000;
function saveStoredList(key, list, max) {
    const copy = list.slice(0, max);
    let text = JSON.stringify(copy);
    // 冲突快照含完整正文，不能让 localStorage 一次写入直接撞配额；超限时丢最旧的快照。
    while (text.length > SYNC_STORAGE_MAX_CHARS && copy.length > 1) {
        copy.pop();
        text = JSON.stringify(copy);
    }
    try { localStorage.setItem(getLocalKey(key), text); } catch (_) {}
}

export function getSyncConflicts() { return readStoredList(SYNC_CONFLICT_KEY); }
export function getSyncHistory() { return readStoredList(SYNC_HISTORY_KEY); }

function conflictIdentity(conflict) { return conflict.resource + ':' + String(conflict.id); }
function persistSyncConflicts(list) { saveStoredList(SYNC_CONFLICT_KEY, list, SYNC_CONFLICT_MAX); updateSyncConflictBanner(); }
function archiveConflictSnapshot(conflict, choice, keep) {
    if (!conflict) return;
    const history = readStoredList(SYNC_HISTORY_KEY);
    history.unshift({
        at: getEast8Time(), resource: conflict.resource, id: conflict.id,
        label: RESOURCE_LABELS[conflict.resource] || conflict.resource,
        choice, version: keep || null
    });
    saveStoredList(SYNC_HISTORY_KEY, history, SYNC_HISTORY_MAX);
}
export function addSyncConflict(resource, local, cloud) {
    if (!local || local.id == null) return;
    const list = getSyncConflicts();
    const key = conflictIdentity({ resource, id: local.id });
    const next = list.filter((entry) => conflictIdentity(entry) !== key);
    next.unshift({ resource, id: local.id, local, cloud, detectedAt: getEast8Time() });
    persistSyncConflicts(next);
}
export function removeSyncConflict(resource, id) {
    persistSyncConflicts(getSyncConflicts().filter((entry) => conflictIdentity(entry) !== resource + ':' + String(id)));
}

export function mergeDataLists(localList, apiList, options = {}) {
    if (!Array.isArray(localList)) localList = [];
    if (!Array.isArray(apiList)) apiList = [];
    const protectKeys = options.protectKeys || new Set();

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
        if (protectKeys.has(key)) { map.set(key, item); continue; }
        const localTs = toUpdatedTs(item.updated_at || item.updatedAt);
        const cloudTs = toUpdatedTs(cloud.updated_at || cloud.updatedAt);
        if (localTs > cloudTs || (localTs === cloudTs && item._dirty)) {
            map.set(key, item);
        }
    }

    return Array.from(map.values()).sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
}

export function processApiSyncResult(localList, apiData, isIncremental = false, resource = '') {
    if (!Array.isArray(apiData)) return { merged: localList || [], needsUpload: false, conflicts: 0 };
    const syncedIds = getSyncedIds();
    const validApiData = apiData.filter(item => !item.is_deleted);
    const allCloudMap = new Map(apiData.filter((item) => item && item.id != null).map((item) => [String(item.id), item]));
    const protectKeys = new Set();
    const localMap = new Map((localList || []).filter((item) => item && item.id != null).map((item) => [String(item.id), item]));
    let conflicts = 0;

    // 云端已变 + 本地有未推送改动 = 冲突；此时本地版本优先保留，绝不静默覆盖。
    if (resource) {
        for (const [key, local] of localMap) {
            if (!local._dirty) continue;
            const cloud = allCloudMap.get(key);
            if (!cloud) continue;
            if (cloud.is_deleted) {
                removeDeletedId(local.id);
                protectKeys.add(key);
                addSyncConflict(resource, local, cloud);
                conflicts++;
                continue;
            }
            const base = getSyncBase(resource, local.id);
            const localSig = syncSignature(resource, local);
            const cloudSig = syncSignature(resource, cloud);
            if (localSig === cloudSig) {
                // 内容其实相同（例如两端做了同样修改），直接采纳云端时间作为新基线。
                rememberSyncBase(resource, cloud);
                continue;
            }
            const cloudChanged = base
                ? (String(cloud.updated_at || cloud.updatedAt) !== String(base.updated_at) || cloudSig !== base.signature)
                : true; // 没有基线时，只要两边内容不同就保守判冲突，宁可多问一次也不静默覆盖
            if (cloudChanged) {
                protectKeys.add(key);
                addSyncConflict(resource, local, cloud);
                conflicts++;
            }
        }
    }

    const apiIds = apiData.map(item => String(item.id));
    if (!isIncremental) {
        addSyncedIds(apiIds);
    } else {
        const newSynced = new Set([...syncedIds, ...apiIds]);
        addSyncedIds(Array.from(newSynced));
    }

    // Soft-delete tombstones from cloud → remember locally so we don't re-upload.
    // 本地仍有未推送改动时不吞掉它：冲突条目会先把它保留在冲突中心。
    for (const item of apiData) {
        if (item && item.is_deleted && item.id != null && !protectKeys.has(String(item.id))) {
            addDeletedId(item.id);
        }
    }
    const deletedIdSet = new Set(getDeletedIds().map(String));

    const activeLocal = (localList || []).filter(item => {
        if (!item || item.id == null) return false;
        const strId = String(item.id);
        if (deletedIdSet.has(strId)) return false;
        const cloudItem = apiData.find(a => String(a.id) === strId);
        if (cloudItem && cloudItem.is_deleted && !protectKeys.has(strId)) return false;
        if (item._dirty) return true;
        if (!isIncremental && syncedIds.includes(strId) && !apiIds.includes(strId)) return false;
        return true;
    });

    const merged = mergeDataLists(activeLocal, validApiData, { protectKeys });
    if (resource) rememberCloudBases(resource, validApiData, protectKeys);

    const needsUpload = activeLocal.some(item => {
        if (!item._dirty || protectKeys.has(String(item.id))) return false;
        const cloud = validApiData.find(a => String(a.id) === String(item.id));
        if (!cloud) return true;
        return toUpdatedTs(item.updated_at) >= toUpdatedTs(cloud.updated_at);
    });

    return { merged, needsUpload, conflicts };
}

let syncStatusTimer = null;
/** 同步指示灯：ok=绿 / warn|info=黄 / error=红；无可见文字，同步完成 2 秒后自动隐藏 */
export function setSyncStatus(message, tone = 'info', autoHideMs = 0) {
    const el = document.getElementById('sync-status');
    const isBusy = (tone === 'info' || tone === 'warn') && !!message && !message.includes('已同步');
    document.body.classList.toggle('is-syncing', !!isBusy);
    if (!el) return;
    if (!message) {
        document.body.classList.remove('is-syncing');
        el.hidden = true;
        el.removeAttribute('data-tone');
        el.removeAttribute('aria-label');
        el.removeAttribute('title');
        return;
    }
    // ok→绿，error→红，其余（同步中/将重试）→黄
    const light = tone === 'ok' ? 'ok' : (tone === 'error' ? 'error' : 'warn');
    el.hidden = false;
    el.textContent = '';
    el.dataset.tone = light;
    el.setAttribute('aria-label', message);
    el.title = message === '已同步' 
        ? '云端数据已同步' 
        : (light === 'warn' ? '正在与云端同步中…' : `${message}（点击立即同步）`);

    if (syncStatusTimer) clearTimeout(syncStatusTimer);
    if (autoHideMs > 0) {
        syncStatusTimer = setTimeout(() => {
            if (el.getAttribute('aria-label') === message) {
                document.body.classList.remove('is-syncing');
                el.hidden = true;
                el.removeAttribute('data-tone');
                el.removeAttribute('aria-label');
                el.removeAttribute('title');
            }
        }, autoHideMs);
    }
}

function resourceList(resource) {
    return {
        weeklies: state.database,
        notes: state.notesDatabase,
        bookmarks: state.bookmarksDatabase,
        prompts: state.promptsDatabase,
        feeds: state.feedsDatabase
    }[resource] || null;
}

function resourceLabel(resource) { return RESOURCE_LABELS[resource] || resource; }
function conflictKeyOf(resource, id) { return resource + ':' + String(id); }
function conflictTitle(conflict) {
    const item = conflict.local || conflict.cloud || {};
    return item.title || (item.content ? String(item.content).slice(0, 28) : '') || '未命名记录';
}
function conflictPreview(item) {
    if (!item) return '（无）';
    const pieces = [];
    if (item.is_deleted) pieces.push('（云端已删除，本地版本仍保留）');
    if (item.title) pieces.push(item.title);
    if (item.content) pieces.push(item.content);
    if (!pieces.length) {
        if (item.url) pieces.push(item.url);
        if (item.description || item.desc) pieces.push(item.description || item.desc);
    }
    const text = pieces.join('\n\n') || JSON.stringify(item, null, 2);
    return text.length > 1600 ? text.slice(0, 1600) + '\n…' : text;
}
function conflictTime(item) { return (item && (item.updated_at || item.updatedAt)) || '未知时间'; }

export function updateSyncConflictBanner() {
    const banner = document.getElementById('sync-conflict-banner');
    if (!banner) return;
    const count = getSyncConflicts().length;
    banner.hidden = count === 0;
    const text = document.getElementById('sync-conflict-banner-text');
    if (text) text.textContent = '有 ' + count + ' 条同步冲突待处理';
}

function renderSyncConflictHistory(container) {
    if (!container) return;
    container.replaceChildren();
    const history = getSyncHistory();
    if (!history.length) {
        const empty = document.createElement('p');
        empty.className = 'sync-conflict-empty';
        empty.textContent = '还没有保留的旧版本。';
        container.appendChild(empty);
        return;
    }
    history.slice(0, 10).forEach((entry, index) => {
        const row = document.createElement('div');
        row.className = 'sync-conflict-history-row';
        const label = document.createElement('span');
        label.textContent = entry.label + ' · ' + (entry.version && (entry.version.title || (entry.version.content || '').slice(0, 16)) || '历史快照') + ' · ' + entry.at;
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'btn-text sync-conflict-restore';
        restore.textContent = '恢复';
        restore.dataset.historyIndex = String(index);
        row.append(label, restore);
        container.appendChild(row);
    });
}

function renderSyncConflictCenter() {
    const list = document.getElementById('sync-conflict-list');
    if (!list) return;
    const conflicts = getSyncConflicts();
    const count = document.getElementById('sync-conflict-count');
    if (count) count.textContent = String(conflicts.length);
    list.replaceChildren();
    if (!conflicts.length) {
        const empty = document.createElement('p');
        empty.className = 'sync-conflict-empty';
        empty.textContent = '没有待处理的冲突。';
        list.appendChild(empty);
    }
    for (const conflict of conflicts) {
        const card = document.createElement('article');
        card.className = 'sync-conflict-item';
        card.dataset.resource = conflict.resource;
        card.dataset.id = String(conflict.id);
        const heading = document.createElement('h3');
        heading.textContent = resourceLabel(conflict.resource) + ' · ' + conflictTitle(conflict);
        const meta = document.createElement('p');
        meta.className = 'sync-conflict-meta';
        meta.textContent = '本地修改 ' + conflictTime(conflict.local) + ' · 云端修改 ' + conflictTime(conflict.cloud);
        const panes = document.createElement('div');
        panes.className = 'sync-conflict-versions';
        for (const [label, item] of [['本地版本', conflict.local], ['云端版本', conflict.cloud]]) {
            const pane = document.createElement('div');
            pane.className = 'sync-conflict-pane';
            const title = document.createElement('strong');
            title.textContent = label;
            const pre = document.createElement('pre');
            pre.textContent = conflictPreview(item);
            pane.append(title, pre);
            panes.appendChild(pane);
        }
        const actions = document.createElement('div');
        actions.className = 'sync-conflict-actions';
        for (const [action, text] of [['local', '保留本地'], ['cloud', '保留云端'], ['manual', '手动合并']]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn-text';
            button.dataset.conflictAction = action;
            button.textContent = text;
            actions.appendChild(button);
        }
        const manual = document.createElement('div');
        manual.className = 'sync-conflict-manual';
        manual.hidden = true;
        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.dataset.mergeTitle = '1';
        titleInput.value = (conflict.local && conflict.local.title) || '';
        titleInput.placeholder = '标题';
        const contentInput = document.createElement('textarea');
        contentInput.dataset.mergeContent = '1';
        contentInput.rows = 5;
        contentInput.value = (conflict.local && (conflict.local.content || conflict.local.description || conflict.local.desc)) || '';
        contentInput.placeholder = '合并后的正文';
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'btn-text sync-conflict-save';
        save.dataset.conflictAction = 'save-manual';
        save.textContent = '保存合并结果';
        manual.append(titleInput, contentInput, save);
        card.append(heading, meta, panes, actions, manual);
        list.appendChild(card);
    }
    renderSyncConflictHistory(document.getElementById('sync-conflict-history'));
}

export function openSyncConflictCenter() {
    renderSyncConflictCenter();
    const modal = document.getElementById('sync-conflict-modal');
    if (!modal) return;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('sync-conflict-open');
    document.getElementById('sync-conflict-close')?.focus();
}

export function closeSyncConflictCenter() {
    const modal = document.getElementById('sync-conflict-modal');
    if (modal) {
        modal.classList.remove('show');
        modal.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('sync-conflict-open');
}

function replaceLocalItem(resource, item) {
    const list = resourceList(resource);
    if (!list) return;
    const index = list.findIndex((entry) => String(entry.id) === String(item.id));
    if (index >= 0) list[index] = item; else list.unshift(item);
}
function removeLocalItem(resource, id) {
    const list = resourceList(resource);
    if (!list) return;
    const index = list.findIndex((entry) => String(entry.id) === String(id));
    if (index >= 0) list.splice(index, 1);
}

function saveResource(resource) {
    if (resource === 'weeklies') saveDatabase();
    else if (resource === 'notes') saveNotesDatabase();
    else if (resource === 'bookmarks') saveBookmarksDatabase();
    else if (resource === 'prompts') savePromptsDatabase();
    else if (resource === 'feeds') saveFeedsDatabase();
}
function refreshResource(resource) {
    if (resource === 'weeklies') refresh('weeklies');
    else if (resource === 'notes') refresh('notes');
    else if (resource === 'bookmarks') refresh('bookmarks');
    else if (resource === 'prompts') refresh('prompts');
    else if (resource === 'feeds') refresh('feeds');
}
function pushConflictItem(resource, item) {
    const api = { weeklies: apiSyncWeekly, notes: apiSyncNote, bookmarks: apiSyncBookmark, prompts: apiSyncPrompt, feeds: apiSyncFeed }[resource];
    if (api) return api(item, 'PUT', { force: true });
    return null;
}

function resolveConflict(conflict, choice, merged) {
    if (!conflict) return;
    const cloudDeleted = !!(conflict.cloud && conflict.cloud.is_deleted);
    if (choice === 'cloud') {
        archiveConflictSnapshot(conflict, 'keep-cloud', conflict.local);
        if (cloudDeleted) {
            removeLocalItem(conflict.resource, conflict.id);
        } else {
            const cloud = { ...(conflict.cloud || {}) };
            cloud._dirty = false;
            replaceLocalItem(conflict.resource, cloud);
            rememberSyncBase(conflict.resource, cloud);
        }
        removeSyncConflict(conflict.resource, conflict.id);
        saveResource(conflict.resource);
        refreshResource(conflict.resource);
        setSyncStatus(cloudDeleted ? '已按云端删除本地版本' : '已保留云端版本', 'ok', 1800);
        return;
    }
    if (choice === 'manual') {
        archiveConflictSnapshot(conflict, 'merge-cloud', conflict.cloud);
        archiveConflictSnapshot(conflict, 'merge-local', conflict.local);
    } else {
        archiveConflictSnapshot(conflict, 'keep-local', conflict.cloud);
    }
    const next = { ...(merged || conflict.local || {}), _dirty: true, updated_at: getEast8Time() };
    if (cloudDeleted) {
        // 云端已删除；服务端拒绝复活墓碑。把本地版本另存为新记录，内容不丢。
        removeLocalItem(conflict.resource, conflict.id);
        next.id = null;
        ensureLocalId(next);
        showToast('云端已删除，本地版本已另存为新记录', 'info');
    } else {
        replaceLocalItem(conflict.resource, next);
    }
    removeSyncConflict(conflict.resource, conflict.id);
    saveResource(conflict.resource);
    refreshResource(conflict.resource);
    pushConflictItem(conflict.resource, next);
    setSyncStatus('已保留本地版本，正在重新上传', 'info');
}

async function restoreHistoryVersion(index) {
    const entry = getSyncHistory()[index];
    if (!entry || !entry.version) return;
    const ok = await confirmDialog('恢复这份历史快照会覆盖当前本地版本，并作为新版本上传。确定继续吗？');
    if (!ok) return;
    const item = { ...entry.version, _dirty: true, updated_at: getEast8Time() };
    replaceLocalItem(entry.resource, item);
    removeSyncConflict(entry.resource, item.id);
    saveResource(entry.resource);
    refreshResource(entry.resource);
    closeSyncConflictCenter();
    pushConflictItem(entry.resource, item);
    setSyncStatus('已恢复历史快照', 'ok', 1800);
}

export function initSyncConflictUI() {
    const modal = document.getElementById('sync-conflict-modal');
    const banner = document.getElementById('sync-conflict-banner');
    if (!modal || modal.dataset.bound === '1') { updateSyncConflictBanner(); return; }
    modal.dataset.bound = '1';
    const close = document.getElementById('sync-conflict-close');
    if (close) close.addEventListener('click', closeSyncConflictCenter);
    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeSyncConflictCenter();
        const action = event.target.closest('[data-conflict-action]');
        if (!action) return;
        const card = action.closest('.sync-conflict-item');
        if (!card) return;
        const conflict = getSyncConflicts().find((entry) => conflictKeyOf(entry.resource, entry.id) === conflictKeyOf(card.dataset.resource, card.dataset.id));
        if (!conflict) return;
        const name = action.dataset.conflictAction;
        if (name === 'manual') {
            const manual = card.querySelector('.sync-conflict-manual');
            if (manual) { manual.hidden = false; manual.querySelector('textarea')?.focus(); }
        } else if (name === 'save-manual') {
            const merged = { ...conflict.local };
            const title = card.querySelector('[data-merge-title]')?.value;
            const content = card.querySelector('[data-merge-content]')?.value;
            if (title != null && ('title' in merged)) merged.title = title;
            if (content != null) {
                if ('content' in merged) merged.content = content;
                if (!('content' in merged) && 'description' in merged) merged.description = content;
                // 收藏同时有 desc / description 两个别名，服务端优先读 desc，两个都要更新。
                if (!('content' in merged) && 'desc' in merged) merged.desc = content;
            }
            resolveConflict(conflict, 'manual', merged);
        } else if (name === 'local') {
            resolveConflict(conflict, 'local');
        } else if (name === 'cloud') {
            resolveConflict(conflict, 'cloud');
        }
    });
    const history = document.getElementById('sync-conflict-history');
    if (history) history.addEventListener('click', (event) => {
        const button = event.target.closest('[data-history-index]');
        if (button) restoreHistoryVersion(Number(button.dataset.historyIndex));
    });
    if (banner) banner.addEventListener('click', openSyncConflictCenter);
    if (!document.body.dataset.syncConflictDocBound) {
        document.body.dataset.syncConflictDocBound = '1';
        document.addEventListener('click', (event) => {
            if (event.target.closest && event.target.closest('[data-open-sync-conflicts]')) {
                event.preventDefault();
                openSyncConflictCenter();
            }
        });
    }
    updateSyncConflictBanner();
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

    const currentFeeds = readJsonValue(getLocalKey('gardenFeeds')) || [];
    const currentNotes = readJsonValue('gardenNotes') || readJsonValue(getLocalKey('gardenNotes')) || [];
    const currentData = readJsonValue('gardenData') || readJsonValue(getLocalKey('gardenData')) || [];
    const currentBookmarks = readJsonValue('gardenBookmarks') || readJsonValue(getLocalKey('gardenBookmarks')) || [];
    const currentPrompts = readJsonValue(getLocalKey('gardenPrompts')) || [];

    state.database = mergeDataLists(currentData, rescued.weeklies.length > 0 ? rescued.weeklies : DEFAULT_WEEKLY);
    state.notesDatabase = mergeDataLists(currentNotes, rescued.notes.length > 0 ? rescued.notes : DEFAULT_NOTES);
    state.bookmarksDatabase = mergeDataLists(currentBookmarks, rescued.bookmarks.length > 0 ? rescued.bookmarks : DEFAULT_BOOKMARKS);
    state.promptsDatabase = mergeDataLists(currentPrompts, rescued.prompts.length > 0 ? rescued.prompts : DEFAULT_PROMPTS);
    state.feedsDatabase = mergeDataLists(currentFeeds, rescued.feeds.length > 0 ? rescued.feeds : DEFAULT_FEEDS);
    state.echoCardsDatabase = readJsonValue(getLocalKey('gardenEchoCards')) || [];

    if (state.authUser) {
        saveDatabase();
        saveNotesDatabase();
        saveBookmarksDatabase();
        savePromptsDatabase();
        saveFeedsDatabase();
    }

    migrateFromLocalStorage([
        getLocalKey('gardenData'),
        getLocalKey('gardenNotes'),
        getLocalKey('gardenBookmarks'),
        getLocalKey('gardenPrompts'),
        getLocalKey('gardenFeeds'),
        getLocalKey('gardenEchoCards')
    ]);

    hydrateFromIndexedDb().catch((err) => console.warn('[IDB] hydrate error:', err));

    refresh('all');
}

/**
 * 阶段二异步注水：从 IndexedDB 批量拉取全量数据，
 * 当 IndexedDB 中有因超限未完整存入 localStorage 的历史全量数据时，无缝合并并静默刷新视图。
 */
export async function hydrateFromIndexedDb() {
    try {
        const keys = [
            getLocalKey('gardenData'),
            getLocalKey('gardenNotes'),
            getLocalKey('gardenBookmarks'),
            getLocalKey('gardenPrompts'),
            getLocalKey('gardenFeeds'),
            getLocalKey('gardenEchoCards')
        ];
        const dataMap = await idbGetBatch(keys);
        let hasNewData = false;

        const idbWeeklies = dataMap[getLocalKey('gardenData')];
        const idbNotes = dataMap[getLocalKey('gardenNotes')];
        const idbBookmarks = dataMap[getLocalKey('gardenBookmarks')];
        const idbPrompts = dataMap[getLocalKey('gardenPrompts')];
        const idbFeeds = dataMap[getLocalKey('gardenFeeds')];
        const idbEchoCards = dataMap[getLocalKey('gardenEchoCards')];

        if (Array.isArray(idbWeeklies) && idbWeeklies.length > 0) {
            const beforeLen = state.database.length;
            state.database = mergeDataLists(state.database, idbWeeklies);
            if (state.database.length !== beforeLen) hasNewData = true;
        }
        if (Array.isArray(idbNotes) && idbNotes.length > 0) {
            const beforeLen = state.notesDatabase.length;
            state.notesDatabase = mergeDataLists(state.notesDatabase, idbNotes);
            if (state.notesDatabase.length !== beforeLen) hasNewData = true;
        }
        if (Array.isArray(idbBookmarks) && idbBookmarks.length > 0) {
            const beforeLen = state.bookmarksDatabase.length;
            state.bookmarksDatabase = mergeDataLists(state.bookmarksDatabase, idbBookmarks);
            if (state.bookmarksDatabase.length !== beforeLen) hasNewData = true;
        }
        if (Array.isArray(idbPrompts) && idbPrompts.length > 0) {
            const beforeLen = state.promptsDatabase.length;
            state.promptsDatabase = mergeDataLists(state.promptsDatabase, idbPrompts);
            if (state.promptsDatabase.length !== beforeLen) hasNewData = true;
        }
        if (Array.isArray(idbFeeds) && idbFeeds.length > 0) {
            const beforeLen = state.feedsDatabase.length;
            state.feedsDatabase = mergeDataLists(state.feedsDatabase, idbFeeds);
            if (state.feedsDatabase.length !== beforeLen) hasNewData = true;
        }
        if (Array.isArray(idbEchoCards) && idbEchoCards.length > 0) {
            if (!state.echoCardsDatabase || state.echoCardsDatabase.length < idbEchoCards.length) {
                state.echoCardsDatabase = idbEchoCards;
                hasNewData = true;
            }
        }

        if (hasNewData && !isProtectingLocalEdits()) {
            refresh('all');
        }
    } catch (err) {
        console.warn('[IDB] hydrateFromIndexedDb failed:', err);
    }
}

const PULL_PAGE_SIZE = 100;
const PULL_MAX_PAGES = 500;

/**
 * 聚合拉取的分页版本：每次 RTT 只取每种资源的一页，用服务端 keyset 游标续页。
 * 离线口径不变——页面拉完后仍合并进完整的本地缓存，不裁成服务器第一页。
 * 旧版 Worker 不认识 page_size 时会直接返回全量；没有 next 就视为一次拉完。
 */
async function pullAggregatedPages(pullSpecs) {
    const accumulated = Object.fromEntries(pullSpecs.map((spec) => [spec.resource, []]));
    const cursors = {};
    let pages = 0;

    while (true) {
        const params = new URLSearchParams({ page_size: String(PULL_PAGE_SIZE) });
        for (const spec of pullSpecs) {
            const since = getSyncCursor(spec.resource);
            if (since) params.set('since_' + spec.resource, getIncrementalSyncCursor(since));
            if (cursors[spec.resource]) params.set('cursor_' + spec.resource, cursors[spec.resource]);
        }

        const data = await apiRequest('/api/sync/pull?' + params.toString());
        if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) {
            throw new Error('sync/pull page failed');
        }

        let hasMore = false;
        for (const spec of pullSpecs) {
            const rows = data[spec.resource];
            if (Array.isArray(rows)) accumulated[spec.resource].push(...rows);
            const next = data.next && data.next[spec.resource];
            if (next) {
                cursors[spec.resource] = next;
                hasMore = true;
            } else {
                // 已完成的资源不再从头拉：服务端把 done 当成空页，避免重复累积。
                cursors[spec.resource] = 'done';
            }
        }

        pages += 1;
        if (!hasMore) break;
        if (pages >= PULL_MAX_PAGES) throw new Error('sync/pull page limit exceeded');
    }

    // 防御性去重：分页边界/旧服务端重复返回时，同 id 只保留最后一条。
    for (const spec of pullSpecs) {
        const byId = new Map();
        for (const row of accumulated[spec.resource]) {
            if (row && row.id != null) byId.set(String(row.id), row);
        }
        accumulated[spec.resource] = Array.from(byId.values());
    }
    return accumulated;
}

/** 首屏同步时把仍停留在空态的列表换成骨架屏，避免"暂无内容"的误导 */
function showSkeletonsForEmptyLists() {
    const targets = ['gallery-container', 'notes-list-container', 'bookmark-list-container', 'feeds-stream-container'];
    for (const id of targets) {
        const el = document.getElementById(id);
        if (el && el.querySelector('.list-empty')) setHtml(el, skeletonListHtml(3));
    }
}

export async function syncFromApi() {
    if ((!state.authToken && !state.cookieSession) || isSyncingInBg) return;
    isSyncingInBg = true;
    let needsBatchUpload = false;
    let hadError = false;
    let conflictTotal = 0;
    setSyncStatus('同步中', 'info');
    showSkeletonsForEmptyLists();

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
            resource: 'prompts',
            path: '/api/prompts',
            getList: () => state.promptsDatabase,
            setList: (list) => { state.promptsDatabase = list; },
            save: savePromptsDatabase,
            shouldRefresh: () => getActiveViewId() === 'view-bookmarks',
            refresh: () => actions.renderPrompts?.(),
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
        // 1. 尝试聚合增量拉取（单次 RTT 打包获取 5 大资源，极大降低移动端延迟）
        let aggregatedData = null;
        try {
            aggregatedData = await pullAggregatedPages(pullSpecs);
        } catch (_) {
            aggregatedData = null; // 降级走独立并行拉取
        }

        if (aggregatedData && typeof aggregatedData === 'object' && !aggregatedData.error) {
            for (const spec of pullSpecs) {
                const apiData = aggregatedData[spec.resource];
                if (!Array.isArray(apiData)) continue;
                const lastSync = getSyncCursor(spec.resource);
                const { merged, needsUpload, conflicts } = processApiSyncResult(spec.getList(), apiData, !!lastSync, spec.resource);
                conflictTotal += conflicts || 0;
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
            }
        } else {
            // 降级：并发拉取各资源（Promise.all 代替原先的串行 for-await 循环）
            await Promise.all(pullSpecs.map(async (spec) => {
                try {
                    const lastSync = getSyncCursor(spec.resource);
                    const url = lastSync ? `${spec.path}?since=${encodeURIComponent(getIncrementalSyncCursor(lastSync))}` : spec.path;
                    const apiData = await apiRequest(url);
                    if (!Array.isArray(apiData)) return;
                    const { merged, needsUpload, conflicts } = processApiSyncResult(spec.getList(), apiData, !!lastSync, spec.resource);
                    conflictTotal += conflicts || 0;
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
            }));
        }

        // 2. 增量脏数据推送（Delta Push：仅上传本地改动 _dirty=true 项，不刷全表时间戳）
        if (needsBatchUpload) {
            try {
                const deleted = new Set(getDeletedIds().map(String));
                const conflicted = new Set(getSyncConflicts().map(conflictIdentity));
                // 缺 id 的本地改动会就地补 id 后照常推送（此前会被静默丢弃）；
                // 已进入冲突中心的记录不再自动上传，等待用户选择。
                const dirtyOnly = (list, resource) => selectDirtyItems(list, deleted)
                    .filter((item) => !conflicted.has(resource + ':' + String(item.id)))
                    .map((item) => {
                        const payload = stripClientSyncFlags(item);
                        const base = getSyncBase(resource, item.id);
                        if (base && base.updated_at) payload.base_updated_at = base.updated_at;
                        return payload;
                    });

                const dirtyWeeklies = dirtyOnly(state.database, 'weeklies');
                const dirtyNotes = dirtyOnly(state.notesDatabase, 'notes');
                const dirtyBookmarks = dirtyOnly(state.bookmarksDatabase, 'bookmarks');
                const dirtyFeeds = dirtyOnly(state.feedsDatabase, 'feeds');
                const dirtyPrompts = dirtyOnly(state.promptsDatabase, 'prompts');

                const totalDirty = dirtyWeeklies.length + dirtyNotes.length + dirtyBookmarks.length + dirtyFeeds.length + dirtyPrompts.length;

                if (totalDirty > 0) {
                    const pushedWeeklies = makePushedTimestampMap(dirtyWeeklies);
                    const pushedNotes = makePushedTimestampMap(dirtyNotes);
                    const pushedBookmarks = makePushedTimestampMap(dirtyBookmarks);
                    const pushedFeeds = makePushedTimestampMap(dirtyFeeds);
                    const pushedPrompts = makePushedTimestampMap(dirtyPrompts);

                    const res = await apiRequest('/api/sync/batch', {
                        method: 'POST',
                        body: JSON.stringify({
                            weeklies: dirtyWeeklies,
                            notes: dirtyNotes,
                            bookmarks: dirtyBookmarks,
                            feeds: dirtyFeeds,
                            prompts: dirtyPrompts
                        })
                    });
                    const resourceLists = { weeklies: state.database, notes: state.notesDatabase, bookmarks: state.bookmarksDatabase, feeds: state.feedsDatabase, prompts: state.promptsDatabase };
                    const conflictKeys = new Set(((res && res.conflicts) || []).map((entry) => entry.resource + ':' + String(entry.id)));
                    for (const changed of (res && res.updated) || []) {
                        if (conflictKeys.has(changed.resource + ':' + String(changed.id))) continue;
                        const list = resourceLists[changed.resource];
                        const item = (list || []).find((entry) => String(entry.id) === String(changed.id));
                        if (item && changed.updated_at) {
                            item.updated_at = changed.updated_at;
                            rememberSyncBase(changed.resource, item, changed.updated_at);
                        }
                    }
                    for (const conflict of (res && res.conflicts) || []) {
                        const list = resourceLists[conflict.resource];
                        const item = (list || []).find((entry) => String(entry.id) === String(conflict.id));
                        if (item) {
                            item._dirty = true;
                            addSyncConflict(conflict.resource, item, conflict.cloud);
                            conflictTotal++;
                        }
                    }

                    // 只清除服务端确认写入的条目：无效/越权/未落库的本地改动继续保持 dirty，
                    // 否则一次成功响应会把它们静默丢掉。旧 Worker 不返回 updated 时退回原行为。
                    const hasUpdatedField = !!(res && Array.isArray(res.updated));
                    const updatedKeys = new Set(((res && res.updated) || []).map((entry) => entry.resource + ':' + String(entry.id)));
                    // 服务端时间可能比本地推送时间晚 1–2 秒；把回传时间并入 map，
                    // 否则 clearPushedDirtyFlags 会因「当前时间 > 推送时间」而永远清不掉。
                    for (const changed of (res && res.updated) || []) {
                        const map = { weeklies: pushedWeeklies, notes: pushedNotes, bookmarks: pushedBookmarks, feeds: pushedFeeds, prompts: pushedPrompts }[changed.resource];
                        if (!map || !changed.updated_at) continue;
                        const key = String(changed.id);
                        const old = map.get(key) || 0;
                        map.set(key, Math.max(old, toUpdatedTs(changed.updated_at)));
                    }
                    const onlyWritten = (map, resource) => !hasUpdatedField
                        ? map
                        : new Map([...map].filter(([id]) => updatedKeys.has(resource + ':' + String(id))));
                    clearPushedDirtyFlags(state.database, onlyWritten(pushedWeeklies, 'weeklies'));
                    clearPushedDirtyFlags(state.notesDatabase, onlyWritten(pushedNotes, 'notes'));
                    clearPushedDirtyFlags(state.bookmarksDatabase, onlyWritten(pushedBookmarks, 'bookmarks'));
                    clearPushedDirtyFlags(state.feedsDatabase, onlyWritten(pushedFeeds, 'feeds'));
                    clearPushedDirtyFlags(state.promptsDatabase, onlyWritten(pushedPrompts, 'prompts'));

                    // 服务端拒绝覆盖的记录继续保持 dirty，不能被“已同步”误清。
                    for (const conflict of (res && res.conflicts) || []) {
                        const list = resourceLists[conflict.resource];
                        const item = (list || []).find((entry) => String(entry.id) === String(conflict.id));
                        if (item) item._dirty = true;
                    }

                    saveDatabase(); saveNotesDatabase(); saveBookmarksDatabase(); saveFeedsDatabase(); savePromptsDatabase();
                }
                setSyncStatus(conflictTotal > 0 ? '同步冲突待处理' : '已同步', conflictTotal > 0 ? 'warn' : 'ok', conflictTotal > 0 ? 0 : 2000);
            } catch (e) {
                hadError = true;
                setSyncStatus('未同步', 'warn');
            }
        }

        // 3. 回响卡片拉取
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
        } else if (conflictTotal > 0 || getSyncConflicts().length > 0) {
            setSyncStatus('同步冲突待处理', 'warn');
        } else if (!needsBatchUpload) {
            setSyncStatus('已同步', 'ok', 2000);
        }
        updateSyncConflictBanner();
    } finally {
        isSyncingInBg = false;
    }
}

export function saveDatabase() {
    idbSet(getLocalKey('gardenData'), state.database);
}
export function saveNotesDatabase() {
    idbSet(getLocalKey('gardenNotes'), state.notesDatabase);
}
export function saveBookmarksDatabase() {
    idbSet(getLocalKey('gardenBookmarks'), state.bookmarksDatabase);
}
export function savePromptsDatabase() {
    idbSet(getLocalKey('gardenPrompts'), state.promptsDatabase);
}
export function saveFeedsDatabase() {
    idbSet(getLocalKey('gardenFeeds'), state.feedsDatabase);
}

function markSyncedItem(item, pushedUpdatedAt) {
    if (!item || item.id == null) return;
    if (!pushedUpdatedAt || toUpdatedTs(item.updated_at) <= toUpdatedTs(pushedUpdatedAt)) {
        item._dirty = false;
    }
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

function apiSyncResource(resource, apiPath, item, method, opts = {}) {
    // 单条推送同样要保证 id：服务端缺 id 时会自增另赋，客户端将永远对不上
    if (method !== 'DELETE' && item) ensureLocalId(item);
    if (method === 'DELETE') {
        return apiRequest(`${apiPath}/${item.id}`, { method: 'DELETE' })
            .then((res) => { setSyncStatus('已同步', 'ok', 1800); return res; })
            .catch((err) => { handleSyncFailure(err); return null; });
    }

    const payload = stampLocalUpdate({ ...item });
    item.updated_at = payload.updated_at;
    item._dirty = true;
    const base = getSyncBase(resource, item.id);
    if (base && base.updated_at && !opts.force) payload.base_updated_at = base.updated_at;
    if (opts.force) payload.force_sync = true;

    return apiRequest('/api/sync/batch', {
        method: 'POST',
        body: JSON.stringify({ [resource]: [stripClientSyncFlags(payload)] })
    }).then((res) => {
        const conflict = (res && res.conflicts || []).find((entry) => String(entry.id) === String(item.id));
        if (conflict) {
            item._dirty = true;
            addSyncConflict(resource, item, conflict.cloud);
            setSyncStatus('同步冲突待处理', 'warn');
            return res;
        }
        const changed = (res && res.updated || []).find((entry) => String(entry.id) === String(item.id));
        if (!changed) {
            item._dirty = true;
            setSyncStatus('未同步', 'warn');
            return res;
        }
        if (changed.updated_at) {
            item.updated_at = changed.updated_at;
            rememberSyncBase(resource, item, changed.updated_at);
        }
        markSyncedItem(item, changed.updated_at || payload.updated_at);
        setSyncStatus('已同步', 'ok', 1800);
        return res;
    }).catch((err) => { handleSyncFailure(err); return null; });
}

export function apiSyncWeekly(item, method, opts) {
    return apiSyncResource('weeklies', '/api/weeklies', item, method, opts);
}

export function apiSyncNote(item, method, opts) {
    return apiSyncResource('notes', '/api/notes', item, method, opts);
}

export function apiSyncBookmark(item, method, opts) {
    return apiSyncResource('bookmarks', '/api/bookmarks', item, method, opts);
}

export function apiSyncPrompt(item, method, opts) {
    return apiSyncResource('prompts', '/api/prompts', item, method, opts);
}

export function apiSyncFeed(item, method, opts) {
    return apiSyncResource('feeds', '/api/feeds', item, method, opts);
}

export function filterRealGuestItems(list, defaultIds) {
    return (Array.isArray(list) ? list : []).filter(item => {
        if (!item || item.id == null) return false;
        if (defaultIds.includes(Number(item.id))) {
            return Boolean(item._dirty || item.updated_at);
        }
        return true;
    });
}

export async function checkAndMergeGuestData() {
    if (!state.authUser) return;

    const guestData = readJsonValue('default_gardenData') || [];
    const guestNotes = readJsonValue('default_gardenNotes') || [];
    const guestBookmarks = readJsonValue('default_gardenBookmarks') || [];
    const guestFeeds = readJsonValue('default_gardenFeeds') || [];
    const guestPrompts = readJsonValue('default_gardenPrompts') || [];

    const realGuestData = filterRealGuestItems(guestData, [1]);
    const realGuestNotes = filterRealGuestItems(guestNotes, [101, 102]);
    const realGuestBookmarks = filterRealGuestItems(guestBookmarks, [201, 202, 203]);
    const realGuestFeeds = filterRealGuestItems(guestFeeds, [1]);
    const realGuestPrompts = filterRealGuestItems(guestPrompts, [301, 302, 303, 304]);

    const totalRealGuestCount = realGuestData.length + realGuestNotes.length + realGuestBookmarks.length + realGuestFeeds.length + realGuestPrompts.length;

    if (totalRealGuestCount > 0) {
        if (await confirmDialog('检测到您在未登录时在当前设备上创建了本地数据（周记/笔记/收藏/随手记/提示词）。是否将这些数据导入并同步到您当前的账号中？')) {
            try {
                const userKey = getLocalKey('gardenData');
                let userDatabase = readJsonValue(userKey) || [];
                userDatabase = [...userDatabase, ...realGuestData].filter((item, index, self) =>
                    self.findIndex(t => t.id === item.id) === index
                );
                localStorage.setItem(userKey, JSON.stringify(userDatabase));
                state.database = userDatabase;

                const userNotesKey = getLocalKey('gardenNotes');
                let userNotesDatabase = readJsonValue(userNotesKey) || [];
                userNotesDatabase = [...userNotesDatabase, ...realGuestNotes].filter((item, index, self) =>
                    self.findIndex(t => t.id === item.id) === index
                );
                localStorage.setItem(userNotesKey, JSON.stringify(userNotesDatabase));
                state.notesDatabase = userNotesDatabase;

                const userBMKey = getLocalKey('gardenBookmarks');
                let userBMDatabase = readJsonValue(userBMKey) || [];
                userBMDatabase = [...userBMDatabase, ...realGuestBookmarks].filter((item, index, self) =>
                    self.findIndex(t => t.id === item.id) === index
                );
                localStorage.setItem(userBMKey, JSON.stringify(userBMDatabase));
                state.bookmarksDatabase = userBMDatabase;

                const userFeedsKey = getLocalKey('gardenFeeds');
                let userFeedsDatabase = readJsonValue(userFeedsKey) || [];
                userFeedsDatabase = [...userFeedsDatabase, ...realGuestFeeds].filter((item, index, self) =>
                    self.findIndex(t => t.id === item.id) === index
                );
                localStorage.setItem(userFeedsKey, JSON.stringify(userFeedsDatabase));
                state.feedsDatabase = userFeedsDatabase;

                const userPromptsKey = getLocalKey('gardenPrompts');
                let userPromptsDatabase = readJsonValue(userPromptsKey) || [];
                userPromptsDatabase = [...userPromptsDatabase, ...realGuestPrompts].filter((item, index, self) =>
                    self.findIndex(t => t.id === item.id) === index
                );
                localStorage.setItem(userPromptsKey, JSON.stringify(userPromptsDatabase));
                state.promptsDatabase = userPromptsDatabase;

                // 同步持久化至 IndexedDB，避免仅存 localStorage 导致超限或丢失
                saveDatabase();
                saveNotesDatabase();
                saveBookmarksDatabase();
                saveFeedsDatabase();
                savePromptsDatabase();

                await apiRequest('/api/sync/batch', {
                    method: 'POST',
                    body: JSON.stringify({
                        weeklies: realGuestData,
                        notes: realGuestNotes,
                        bookmarks: realGuestBookmarks,
                        feeds: realGuestFeeds,
                        prompts: realGuestPrompts
                    })
                });

                localStorage.removeItem('default_gardenData');
                localStorage.removeItem('default_gardenNotes');
                localStorage.removeItem('default_gardenBookmarks');
                localStorage.removeItem('default_gardenFeeds');
                localStorage.removeItem('default_gardenPrompts');

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
    if (!state.authToken && !state.cookieSession) return;
    const now = Date.now();
    if (now - lastAutoSyncAt < minGapMs) return;
    lastAutoSyncAt = now;
    syncFromApi();
}

export function startAutoSyncEngine() {
    initSyncConflictUI();
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

    const statusEl = document.getElementById('sync-status');
    if (statusEl && !statusEl.dataset.clickBound) {
        statusEl.dataset.clickBound = '1';
        statusEl.addEventListener('click', () => {
            showToast('正在触发云端同步…', 'info');
            syncFromApi();
        });
    }
}

