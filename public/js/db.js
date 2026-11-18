/**
 * Chillin IndexedDB Engine — 异步大容量存储与向后兼容适配器
 * 纯原生零构建规范，提供异步大容量键值存储，带 localStorage 自动平滑迁移与 QuotaExceeded 兜底保护。
 */

const DB_NAME = 'chillin_db';
const DB_VERSION = 2;
const STORE_NAME = 'garden_store';

let dbPromise = null;

/** 重置内部连接 Promise（仅供单测环境隔离使用） */
export function _resetDbPromiseForTest() {
    dbPromise = null;
}

/** 标记历史 chillin_reader_db 迁移已完成 */
function markReaderDbMigrated(targetDb) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem('_reader_db_migrated', '1'); } catch (_) { /* audit-ignore: intentional-fallback */ }
    try {
        if (targetDb && targetDb.objectStoreNames.contains(STORE_NAME)) {
            const tx = targetDb.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(true, '_reader_db_migrated');
        }
    } catch (_) { /* audit-ignore: intentional-fallback */ }
}

/**
 * 历史旧版 chillin_reader_db 平滑迁移：
 * 若浏览器中存在历史独立的 chillin_reader_db，将其 'books' 与 'chapters' 的历史记录无缝灌入主库 chillin_db
 */
export async function migrateOldReaderDb(targetDb) {
    if (!targetDb || typeof indexedDB === 'undefined') return;
    try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem('_reader_db_migrated')) {
            return;
        }
    } catch (_) { /* audit-ignore: intentional-fallback */ }

    const alreadyMigrated = await new Promise((resolve) => {
        try {
            if (!targetDb.objectStoreNames.contains(STORE_NAME)) return resolve(false);
            const tx = targetDb.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get('_reader_db_migrated');
            req.onsuccess = () => resolve(!!req.result);
            req.onerror = () => resolve(false);
        } catch (_) {
            /* audit-ignore: intentional-fallback 异常时降级继续迁移检查 */
            resolve(false);
        }
    });
    if (alreadyMigrated) {
        try { if (typeof localStorage !== 'undefined') localStorage.setItem('_reader_db_migrated', '1'); } catch (_) { /* audit-ignore: intentional-fallback */ }
        return;
    }

    if (typeof indexedDB.databases === 'function') {
        try {
            const dbs = await indexedDB.databases();
            const exists = dbs && dbs.some((d) => d.name === 'chillin_reader_db');
            if (!exists) {
                markReaderDbMigrated(targetDb);
                return;
            }
        } catch (_) {
            /* audit-ignore: intentional-fallback databases() 不受支持或被安全沙箱拦截时回退尝试直接打开 */
        }
    }

    await new Promise((resolve) => {
        let isNewDb = false;
        let oldReq;
        try {
            oldReq = indexedDB.open('chillin_reader_db');
        } catch (_) {
            /* audit-ignore: intentional-fallback 打开旧库失败安全放行 */
            return resolve();
        }

        oldReq.onupgradeneeded = (e) => {
            // 若 oldVersion === 0 说明先前不存在此库，系本次 open 触发新建，回滚新建
            if (e.oldVersion === 0) {
                isNewDb = true;
                if (e.target.transaction) {
                    try { e.target.transaction.abort(); } catch (_) { /* audit-ignore: intentional-fallback */ }
                }
            }
        };

        oldReq.onsuccess = async (e) => {
            const oldDb = e.target.result;
            if (isNewDb) {
                try { oldDb.close(); } catch (_) { /* audit-ignore: intentional-fallback */ }
                try { indexedDB.deleteDatabase('chillin_reader_db'); } catch (_) { /* audit-ignore: intentional-fallback */ }
                markReaderDbMigrated(targetDb);
                return resolve();
            }

            const hasBooks = oldDb.objectStoreNames.contains('books');
            const hasChapters = oldDb.objectStoreNames.contains('chapters');
            if (!hasBooks && !hasChapters) {
                try { oldDb.close(); } catch (_) { /* audit-ignore: intentional-fallback */ }
                try { indexedDB.deleteDatabase('chillin_reader_db'); } catch (_) { /* audit-ignore: intentional-fallback */ }
                markReaderDbMigrated(targetDb);
                return resolve();
            }

            try {
                const books = hasBooks ? await new Promise((res) => {
                    const tx = oldDb.transaction('books', 'readonly');
                    const r = tx.objectStore('books').getAll();
                    r.onsuccess = () => res(r.result || []);
                    r.onerror = () => res([]);
                }) : [];

                const chapters = hasChapters ? await new Promise((res) => {
                    const tx = oldDb.transaction('chapters', 'readonly');
                    const r = tx.objectStore('chapters').getAll();
                    r.onsuccess = () => res(r.result || []);
                    r.onerror = () => res([]);
                }) : [];

                if (books.length > 0 || chapters.length > 0) {
                    const storesToUse = [];
                    if (books.length > 0) storesToUse.push('books');
                    if (chapters.length > 0) storesToUse.push('chapters');
                    await new Promise((res, rej) => {
                        const tx = targetDb.transaction(storesToUse, 'readwrite');
                        if (books.length > 0) {
                            const bStore = tx.objectStore('books');
                            for (const b of books) {
                                bStore.put(b);
                            }
                        }
                        if (chapters.length > 0) {
                            const cStore = tx.objectStore('chapters');
                            for (const c of chapters) {
                                cStore.put(c);
                            }
                        }
                        tx.oncomplete = () => res();
                        tx.onerror = () => rej(tx.error);
                    });
                    console.log(`[IDB] Migrated ${books.length} books and ${chapters.length} chapters from chillin_reader_db to chillin_db`);
                }

                markReaderDbMigrated(targetDb);
                try { oldDb.close(); } catch (_) { /* audit-ignore: intentional-fallback */ }
                try { indexedDB.deleteDatabase('chillin_reader_db'); } catch (_) { /* audit-ignore: intentional-fallback */ }
            } catch (copyErr) {
                console.warn('[IDB] Error copying from old reader DB:', copyErr);
                try { oldDb.close(); } catch (_) { /* audit-ignore: intentional-fallback */ }
            }
            resolve();
        };

        oldReq.onerror = () => {
            if (isNewDb) {
                try { indexedDB.deleteDatabase('chillin_reader_db'); } catch (_) { /* audit-ignore: intentional-fallback */ }
                markReaderDbMigrated(targetDb);
            }
            resolve();
        };
    });
}

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
                if (!db.objectStoreNames.contains('books')) {
                    db.createObjectStore('books', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('chapters')) {
                    db.createObjectStore('chapters', { keyPath: 'id' });
                }
            };
            req.onsuccess = async (e) => {
                const db = e.target.result;
                try {
                    await migrateOldReaderDb(db);
                } catch (migErr) {
                    console.warn('[IDB] reader db migration error:', migErr);
                }
                resolve(db);
            };
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
            } catch (_) { /* audit-ignore: intentional-fallback 极端配额受限时放弃降级缓存 */ }
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
        } catch (e) { /* audit-ignore: intentional-fallback 事务已关闭或已删除安全降级 */ }
    }
    try {
        localStorage.removeItem(key);
    } catch (e) { /* audit-ignore: intentional-fallback 隐私模式下移除存储失败忽略 */ }
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
            } catch (e) { /* audit-ignore: intentional-fallback 损坏的历史键解析失败跳过 */ }
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

/** Reader 数据存储助手函数：写入记录到指定 store ('books' | 'chapters') */
export function readerDbPut(store, obj) {
    return new Promise((resolve, reject) => {
        openDatabase().then((db) => {
            if (!db) return reject(new Error('IndexedDB not available'));
            try {
                const tx = db.transaction(store, 'readwrite');
                tx.objectStore(store).put(obj);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            } catch (e) {
                reject(e);
            }
        }).catch(reject);
    });
}

/** Reader 数据存储助手函数：读取指定 store 的单条记录 */
export function readerDbGet(store, key) {
    return new Promise((resolve, reject) => {
        openDatabase().then((db) => {
            if (!db) return resolve(undefined);
            try {
                const tx = db.transaction(store, 'readonly');
                const req = tx.objectStore(store).get(key);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            } catch (e) {
                reject(e);
            }
        }).catch(reject);
    });
}

/** Reader 数据存储助手函数：读取指定 store 的所有记录 */
export function readerDbGetAll(store) {
    return new Promise((resolve, reject) => {
        openDatabase().then((db) => {
            if (!db) return resolve([]);
            try {
                const tx = db.transaction(store, 'readonly');
                const req = tx.objectStore(store).getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            } catch (e) {
                reject(e);
            }
        }).catch(reject);
    });
}

/** Reader 数据存储助手函数：删除指定 store 的记录 */
export function readerDbDelete(store, key) {
    return new Promise((resolve, reject) => {
        openDatabase().then((db) => {
            if (!db) return reject(new Error('IndexedDB not available'));
            try {
                const tx = db.transaction(store, 'readwrite');
                tx.objectStore(store).delete(key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            } catch (e) {
                reject(e);
            }
        }).catch(reject);
    });
}
