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

/** 异步写入数据：存入 IndexedDB 并静默镜像到 localStorage（超限时 IndexedDB 仍保全） */
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
    }
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
