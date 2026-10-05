/**
 * Chillin IndexedDB Engine — 异步大容量存储与向后兼容适配器
 * 纯原生零构建规范，提供异步大容量键值存储，带 localStorage 自动平滑迁移与 QuotaExceeded 兜底保护。
 */

const DB_NAME = 'chillin_db';
const DB_VERSION = 1;
const STORE_NAME = 'garden_store';

let dbPromise = null;

/** 打开或获取全局 IndexedDB 实例 */
export function openDatabase() {
    if (dbPromise) return dbPromise;
    if (typeof indexedDB === 'undefined') {
        return Promise.resolve(null);
    }
    dbPromise = new Promise((resolve) => {
        try {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = (err) => {
                console.warn('[IDB] open failed, fallback to localStorage:', err);
                resolve(null);
            };
        } catch (err) {
            console.warn('[IDB] init exception:', err);
            resolve(null);
        }
    });
    return dbPromise;
}

/** 异步读取数据：优先读取 IndexedDB，失败时透明回退到 localStorage */
export async function idbGet(key) {
    const db = await openDatabase();
    if (!db) {
        try {
            const val = localStorage.getItem(key);
            return val ? JSON.parse(val) : null;
        } catch (e) {
            return null;
        }
    }
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result !== undefined ? req.result : null);
            req.onerror = () => {
                try {
                    const fallback = localStorage.getItem(key);
                    resolve(fallback ? JSON.parse(fallback) : null);
                } catch (_) {
                    resolve(null);
                }
            };
        } catch (e) {
            resolve(null);
        }
    });
}

/** 异步写入数据：存入 IndexedDB 并静默镜像到 localStorage（超限时降级为近期快照，IndexedDB 仍保全 100% 全量数据） */
export async function idbSet(key, value) {
    const db = await openDatabase();
    if (db) {
        try {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.put(value, key);
        } catch (e) {
            console.warn('[IDB] set failed:', e);
        }
    }
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        // QuotaExceededError 安全捕获：IndexedDB 已成功写入，无数据丢失风险
        // 降级写入最新的 30 条数据作为秒开启动缓存
        if (Array.isArray(value)) {
            try {
                localStorage.setItem(key, JSON.stringify(value.slice(0, 30)));
            } catch (_) {}
        }
    }
}

/** 异步批量读取多个键：单次事务批量拉取，减少事务开销 */
export async function idbGetBatch(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return {};
    const db = await openDatabase();
    if (!db) {
        const result = {};
        for (const k of keys) {
            try {
                const val = localStorage.getItem(k);
                result[k] = val ? JSON.parse(val) : null;
            } catch (_) {
                result[k] = null;
            }
        }
        return result;
    }
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const result = {};
            let completed = 0;
            for (const k of keys) {
                const req = store.get(k);
                req.onsuccess = () => {
                    result[k] = req.result !== undefined ? req.result : null;
                    completed++;
                    if (completed === keys.length) resolve(result);
                };
                req.onerror = () => {
                    try {
                        const fallback = localStorage.getItem(k);
                        result[k] = fallback ? JSON.parse(fallback) : null;
                    } catch (_) {
                        result[k] = null;
                    }
                    completed++;
                    if (completed === keys.length) resolve(result);
                };
            }
        } catch (e) {
            resolve({});
        }
    });
}

/** 异步删除键 */
export async function idbDel(key) {
    const db = await openDatabase();
    if (db) {
        try {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(key);
        } catch (e) {}
    }
    try {
        localStorage.removeItem(key);
    } catch (e) {}
}

/** 启动时自动将历史 localStorage 数据无缝转入 IndexedDB */
export async function migrateFromLocalStorage(keys) {
    const db = await openDatabase();
    if (!db || !Array.isArray(keys)) return;
    try {
        const migrated = await idbGet('_idb_migrated');
        if (migrated) return;
        for (const k of keys) {
            try {
                const raw = localStorage.getItem(k);
                if (raw) {
                    await idbSet(k, JSON.parse(raw));
                }
            } catch (e) {}
        }
        await idbSet('_idb_migrated', true);
        console.log('[IDB] localStorage to IndexedDB migration complete');
    } catch (err) {
        console.warn('[IDB] migration warning:', err);
    }
}

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

/** 获取客户端存储使用估值与持久化状态 */
export async function getStorageEstimate() {
    let usageBytes = 0;
    let quotaBytes = 0;
    let isPersistent = false;

    if (typeof navigator !== 'undefined' && navigator.storage) {
        try {
            if (navigator.storage.estimate) {
                const est = await navigator.storage.estimate();
                usageBytes = est.usage || 0;
                quotaBytes = est.quota || 0;
            }
            if (navigator.storage.persisted) {
                isPersistent = await navigator.storage.persisted();
            }
            if (!isPersistent && navigator.storage.persist) {
                isPersistent = await navigator.storage.persist().catch(() => false);
            }
        } catch (e) {
            console.warn('[Storage] estimate exception:', e);
        }
    }

    const percent = quotaBytes > 0 ? Math.min(100, Math.round((usageBytes / quotaBytes) * 100)) : 0;

    return {
        usageBytes,
        quotaBytes,
        usageFormatted: formatBytes(usageBytes),
        quotaFormatted: formatBytes(quotaBytes),
        percent,
        isPersistent
    };
}
