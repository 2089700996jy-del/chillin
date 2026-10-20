/** Local TXT reader (IndexedDB bookshelf, chapters, themes). */
import { escapeHtml, showToast, confirmDialog, applyAppTheme } from './utils.js';
import { actions } from './actions.js';
import { setHtml } from './trusted-types.js';
import { apiRequest, fetchWithFallback } from './api.js';
import { state } from './state.js';

/**
 * 文本解码：优先严格尝试 UTF-8，遇到非法字节时平滑降级至 GBK
 */
export function decodeBuffer(buf) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (_) {}
    try {
        const text = new TextDecoder('gbk').decode(buf);
        if ((text.match(/[\u4e00-\u9fa5]/g) || []).length > 0) return text;
    } catch (_) {}
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

/**
 * 把本机已存的章节重组成一份可用于补传的正文。
 *
 * 背景：导入时原文没有被保留（只存了切好章的正文），所以早年导入的书要补传到云端，
 * 只能按「章名 + 该章正文」拼回去。每章开头保留章名行，保证换设备下载后仍能被
 * 阅读器识别成同样多的章节。
 */
export function rebuildBookText(chapters) {
    if (!Array.isArray(chapters) || !chapters.length) return '';
    return chapters
        .slice()
        .sort((a, b) => (a.index || 0) - (b.index || 0))
        .map((ch) => {
            const title = ch && ch.title ? String(ch.title) : '';
            const body = ch && ch.content ? String(ch.content) : '';
            return title ? title + '\n' + body : body;
        })
        .join('\n');
}

export function initReader() {
// ── IndexedDB ──
const DB_NAME = 'chillin_reader_db';
const DB_VER = 1;
let readerDB = null;

function openReaderDB() {
    return new Promise((resolve, reject) => {
        if (readerDB) return resolve(readerDB);
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = (e) => {
            const d = e.target.result;
            if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
            if (!d.objectStoreNames.contains('chapters')) d.createObjectStore('chapters', { keyPath: 'id' });
        };
        req.onsuccess = (e) => { readerDB = e.target.result; resolve(readerDB); };
        req.onerror = () => reject(req.error);
    });
}

function rdbPut(store, obj) {
    return new Promise((resolve, reject) => {
        openReaderDB().then(db => {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).put(obj);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    });
}
function rdbGet(store, key) {
    return new Promise((resolve, reject) => {
        openReaderDB().then(db => {
            const req = db.transaction(store, 'readonly').objectStore(store).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    });
}
function rdbGetAll(store) {
    return new Promise((resolve, reject) => {
        openReaderDB().then(db => {
            const req = db.transaction(store, 'readonly').objectStore(store).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    });
}
function rdbDelete(store, key) {
    return new Promise((resolve, reject) => {
        openReaderDB().then(db => {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).delete(key);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    });
}

// ── Reader State ──
let currentBookId = null;
let currentBook = null;
let currentChapterIdx = 0;
let chapterMetas = [];
let saveTimer = null;
let cloudSyncTimer = null;

function computeBookKey(book) {
    if (!book) return '';
    const title = (book.title || '').trim().toLowerCase();
    const chapters = book.totalChapters || 0;
    return `${title}::${chapters}`;
}

// ── Progress (localStorage & Cloud) ──
function loadReaderProgress() {
    try { return JSON.parse(localStorage.getItem('reader_progress') || '{}'); } catch(e) { return {}; }
}
function saveReaderProgress(bookId, data) {
    const p = loadReaderProgress();
    p[bookId] = data;
    localStorage.setItem('reader_progress', JSON.stringify(p));
}
function deleteReaderProgress(bookId) {
    const p = loadReaderProgress();
    delete p[bookId];
    localStorage.setItem('reader_progress', JSON.stringify(p));
}
function systemPreferredTheme() {
    try {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_) {
        return 'light';
    }
}
function loadReaderSettings() {
    try {
        const raw = localStorage.getItem('reader_settings');
        if (raw) {
            const parsed = JSON.parse(raw) || {};
            if (!parsed.theme) parsed.theme = systemPreferredTheme();
            if (!parsed.fontSize) parsed.fontSize = 18;
            if (!parsed.lineHeight) parsed.lineHeight = '1.8';
            if (!parsed.fontFamily) parsed.fontFamily = 'sans';
            return parsed;
        }
    } catch (e) { /* 解析失败按默认处理 */ }
    return { theme: systemPreferredTheme(), fontSize: 18, lineHeight: '1.8', fontFamily: 'sans' };
}
function saveReaderSettings(s) {
    localStorage.setItem('reader_settings', JSON.stringify(s));
}

/** 云端进度行的写入时间（毫秒）：新行用 client_ts，历史行退化解析东八区的 updated_at */
function cloudProgressTs(row) {
    const ts = Number(row && row.client_ts);
    if (Number.isFinite(ts) && ts > 0) return ts;
    const m = String((row && row.updated_at) || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return 0;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
}

// ── P2 离线补推队列：推送失败先落 localStorage，联网 / 打开书 / 下次成功推送时补推 ──
const PROGRESS_QUEUE_KEY = 'reader_progress_queue';

function loadProgressQueue() {
    try { return JSON.parse(localStorage.getItem(PROGRESS_QUEUE_KEY) || '{}') || {}; } catch (_) { return {}; }
}
function saveProgressQueue(queue) {
    try { localStorage.setItem(PROGRESS_QUEUE_KEY, JSON.stringify(queue)); } catch (_) { /* 配额满则放弃排队，进度仍在本机 */ }
}
/** 同一本书只留最新一条，避免补推时把更旧的进度写回云端 */
function queueProgress(payload) {
    const queue = loadProgressQueue();
    const prev = queue[payload.book_key];
    if (!prev || Number(payload.client_ts) >= Number(prev.client_ts || 0)) {
        queue[payload.book_key] = payload;
        saveProgressQueue(queue);
    }
}
function dropQueuedProgress(bookKey) {
    const queue = loadProgressQueue();
    if (queue[bookKey]) { delete queue[bookKey]; saveProgressQueue(queue); }
}

/** 发一次进度；服务端返回 applied:false 表示比云端旧、被写入保护拒绝，同样算处理完毕（不再重试） */
async function pushProgress(payload) {
    return await apiRequest('/api/reader/progress', { method: 'POST', body: JSON.stringify(payload) });
}

async function syncReaderProgressToCloud(book, chapterIdx, scrollPct, chapterTitle, ts) {
    if (!book || (!state.authToken && !state.cookieSession)) return;
    const bookKey = book.bookKey || computeBookKey(book);
    const payload = {
        book_key: bookKey,
        book_title: book.title,
        chapter_index: chapterIdx,
        chapter_title: chapterTitle || '',
        scroll_percentage: scrollPct,
        // P4：带上本地时间戳，服务端据此拒绝过期写入（历史行 client_ts=0，本次必然通过）
        client_ts: Number(ts) || Date.now()
    };
    try {
        await pushProgress(payload);
        dropQueuedProgress(bookKey);
        const statusEl = document.getElementById('reader-sync-status-text');
        if (statusEl) statusEl.textContent = '已同步至云端 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    } catch (err) {
        queueProgress(payload);
        console.warn('[reader] progress sync failed, queued for retry', err);
    }
}

/** 补推积压进度（联网 / 打开书 / 成功推送后调用）；离线时试一条就停，避免连环失败 */
async function flushQueuedProgress() {
    if (!state.authToken && !state.cookieSession) return;
    const pending = Object.values(loadProgressQueue()).sort((a, b) => Number(a.client_ts || 0) - Number(b.client_ts || 0));
    for (const payload of pending.slice(0, 5)) {
        try {
            await pushProgress(payload);
            dropQueuedProgress(payload.book_key);
        } catch (err) {
            console.warn('[reader] queued progress still failing', err);
            break;
        }
    }
}

function scheduleCloudProgressSync() {
    if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(() => {
        if (!currentBookId || !currentBook || !chapterMetas.length) return;
        const ch = chapterMetas[currentChapterIdx];
        const area = document.getElementById('reader-content-area');
        const pct = area.scrollHeight > area.clientHeight
            ? Math.round((area.scrollTop / (area.scrollHeight - area.clientHeight)) * 100) : 0;
        syncReaderProgressToCloud(currentBook, currentChapterIdx, pct, ch ? ch.title : '', Date.now());
    }, 2500);
}

// ── Parser ──
function parseChapters(text) {
    // Detect actual newline length (CRLF=2, LF=1)
    const nlLen = text.indexOf('\r\n') > -1 ? 2 : 1;
    const lines = text.split(/\r?\n/);
    const reChapter = /^第[一二三四五六七八九十百千万零\d]+[章节卷部集篇]\s*[^\n]*/;

    // Build markers with correct byte offsets
    const markers = [];
    let charPos = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (reChapter.test(line)) {
            markers.push({ lineIdx: i, charStart: charPos, title: line });
        }
        charPos += lines[i].length + (i < lines.length - 1 ? nlLen : 0);
    }

    if (!markers.length) {
        return [{ title: '全文', groupIndex: 0, charStart: 0, charEnd: text.length }];
    }

    // Build chapters: each chapter starts at its marker's charStart
    // and ends just before the next marker's charStart
    const chapters = [];
    for (let i = 0; i < markers.length; i++) {
        const m = markers[i];
        const nextM = markers[i + 1];
        chapters.push({
            title: m.title,
            charStart: m.charStart,
            charEnd: nextM ? nextM.charStart : text.length,
            groupIndex: Math.floor(i / 200)
        });
    }
    return chapters;
}

function extractChapterContent(text, ch) {
    // Extract raw content between chapter boundaries
    let content = text.slice(ch.charStart, ch.charEnd);
    // Strip trailing newlines
    content = content.replace(/[\r\n]+$/, '');
    // Remove the chapter title line at the start (may end with \r\n or \n)
    const firstLineEnd = content.indexOf('\n');
    if (firstLineEnd > -1) {
        let firstLine = content.slice(0, firstLineEnd);
        if (firstLine.endsWith('\r')) firstLine = firstLine.slice(0, -1);
        if (firstLine.trim() === ch.title) {
            content = content.slice(firstLineEnd + 1);
        }
    }
    // Clean up leading/trailing whitespace but preserve paragraph structure
    content = content.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, '');
    return content;
}

// ── Import ──
/** 把正文切章后写入本地 IndexedDB（文件导入与云端下载共用同一套落库逻辑） */
async function saveBookToLocalDB(text, meta, onProgress) {
    const chapters = parseChapters(text);
    if (!chapters.length) { showToast('未检测到章节！', 'warn'); return null; }

    const totalChapters = chapters.length;
    const bookId = 'book_' + Date.now();
    // 云端下发时沿用原指纹，保证同一本书在各设备上的 bookKey 完全一致
    const bookKey = meta.bookKey || computeBookKey({ title: meta.title, totalChapters });
    await rdbPut('books', {
        id: bookId, bookKey: bookKey, title: meta.title, author: meta.author,
        fileName: meta.fileName, totalChapters: totalChapters,
        groupCount: Math.ceil(totalChapters / 200), createdAt: Date.now()
    });

    const BATCH = 80;
    for (let i = 0; i < chapters.length; i += BATCH) {
        if (onProgress) onProgress(i, chapters.length);
        const batch = chapters.slice(i, i + BATCH);
        const tx = (await openReaderDB()).transaction('chapters', 'readwrite');
        const store = tx.objectStore('chapters');
        for (let j = 0; j < batch.length; j++) {
            const ch = batch[j];
            store.put({
                id: bookId + '_' + (i + j),
                bookId: bookId, index: i + j,
                title: ch.title,
                content: extractChapterContent(text, ch),
                groupIndex: ch.groupIndex
            });
        }
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    }

    return { id: bookId, bookKey: bookKey, title: meta.title, author: meta.author, totalChapters: totalChapters };
}

async function importBook(file) {
    const progressEl = document.getElementById('import-progress');
    const progressText = document.getElementById('import-progress-text');
    progressEl.style.display = 'block';
    progressText.textContent = '正在读取文件...';
    try {
        const buf = await file.arrayBuffer();
        progressText.textContent = '正在解码文本...';
        const text = decodeBuffer(buf);
        progressText.textContent = '正在解析章节...';

        let bookTitle = file.name.replace(/\.\w+$/, '');
        let bookAuthor = '未知作者';
        const firstLines = text.slice(0, 2000).split(/\r?\n/);
        for (let i = 0; i < Math.min(firstLines.length, 15); i++) {
            const line = firstLines[i].trim();
            if (line.startsWith('作者：') || line.startsWith('作者:')) {
                bookAuthor = line.replace(/^作者[：:]/, '').trim();
            }
        }
        for (let i = 0; i < Math.min(firstLines.length, 20); i++) {
            const line = firstLines[i].trim();
            if (line && line.indexOf('==') !== 0 && line.indexOf('更多') !== 0 && line.indexOf('内容简介') !== 0
                && line.indexOf('作者') !== 0 && line.length > 1 && line.length < 50
                && !/^第[一二三四五六七八九十百千\d]+[章节部卷]/.test(line)) {
                bookTitle = line; break;
            }
        }

        progressText.textContent = '正在保存书籍信息...';
        const book = await saveBookToLocalDB(text, { title: bookTitle, author: bookAuthor, fileName: file.name }, (i, total) => {
            progressText.textContent = '正在保存章节 ' + (i + 1) + '/' + total + '...';
        });
        if (!book) { progressEl.style.display = 'none'; return; }

        // 云端同步要等结果再给结论：失败时不能报「导入完成」，否则用户会以为书已经备份好了
        const canSync = Boolean(state.authToken || state.cookieSession);
        let syncState = 'skipped';   // skipped | ok | failed
        if (canSync) {
            progressText.textContent = '正在同步到云端...';
            try {
                await uploadBookToCloud(book, text);
                syncState = 'ok';
            } catch (err) {
                console.warn('[reader] book upload failed', err);
                syncState = 'failed';
            }
        }

        progressEl.style.display = 'none';
        renderBookshelf();
        const importedSummary = book.title + '（' + book.totalChapters + ' 章）';
        if (syncState === 'ok') {
            showToast('✅ 导入完成，已同步到云端：' + importedSummary, 'success');
        } else if (syncState === 'failed') {
            // 本机已经能读；失败的书会被书架补传逻辑自动重试，这里顺手立刻再试一次
            showToast('⚠️ 已导入本机，但云端同步失败；打开书架会自动重试', 'warn');
            backfillLocalBooks([book]);
        } else {
            showToast('✅ 已完成本机导入：' + importedSummary + '（未登录，暂不云同步）', 'success');
        }
    } catch (err) {
        console.error('Import failed:', err);
        progressEl.style.display = 'none';
        showToast('导入失败：' + err.message, 'error');
    }
}

// ── Bookshelf（本地 + 云端） ──
// 云端书目缓存：本地没有的书先以「云端卡片」出现，点开时才按需下载正文
let cloudBooks = [];
// 只有「确实拉到过云端书目」才允许做本机补传判断——否则离线时 cloudBooks=[] 会被误判成「一本都没上云」
let cloudBooksSynced = false;

/** 拉取云端书目（未登录或离线时返回空，不影响本地书架） */
async function fetchCloudBooks() {
    if (!state.authToken && !state.cookieSession) { cloudBooks = []; cloudBooksSynced = false; return cloudBooks; }
    try {
        const list = await apiRequest('/api/reader/books');
        cloudBooks = Array.isArray(list) ? list : [];
        cloudBooksSynced = true;
    } catch (err) {
        console.warn('[reader] fetch cloud books failed', err);
        cloudBooks = [];
        cloudBooksSynced = false;
    }
    return cloudBooks;
}

// ── 本机书架补传：早年导入（或导入时上传失败）的书只有本机副本，这里把它们补推到云端 ──
const BACKFILL_MAX_PER_SESSION = 3;   // 每次会话最多补传几本，避免一次性把大文件全推上去
let backfillDone = 0;

async function backfillLocalBooks(localBooks) {
    if (!cloudBooksSynced || !localBooks.length || backfillDone >= BACKFILL_MAX_PER_SESSION) return;
    const cloudKeys = new Set(cloudBooks.map((b) => b.book_key));
    const pending = localBooks.filter((b) => {
        const key = b.bookKey || computeBookKey(b);
        return key && !cloudKeys.has(key);
    });
    if (!pending.length) return;

    let uploaded = 0;
    for (const book of pending) {
        if (backfillDone + uploaded >= BACKFILL_MAX_PER_SESSION) break;
        try {
            const chapters = (await rdbGetAll('chapters')).filter((c) => c.bookId === book.id);
            if (!chapters.length) continue;
            const text = rebuildBookText(chapters);
            if (!text.trim()) continue;
            console.log('[reader] backfill local book → cloud:', book.title, chapters.length, 'chapters');
            await uploadBookToCloud(book, text);
            uploaded++;
            // 记进云端缓存：同一轮渲染里不会再被当成「缺书」
            cloudBooks.push({ book_key: book.bookKey || computeBookKey(book), title: book.title, author: book.author, total_chapters: book.totalChapters || chapters.length });
        } catch (err) {
            // 补传失败（多半是离线/超时）：本轮停止、书留在下次再试
            console.warn('[reader] backfill failed, will retry later', err);
            break;
        }
    }
    if (uploaded) {
        backfillDone += uploaded;
        showToast('☁️ 已把 ' + uploaded + ' 本本机书补传到云端', 'success');
    }
}

/** 把本地导入的正文推到 R2，换设备也能接着读同一本书 */
async function uploadBookToCloud(book, text) {
    if (!state.authToken && !state.cookieSession) return false;
    const params = new URLSearchParams({
        key: book.bookKey,
        title: book.title,
        author: book.author || '',
        chapters: String(book.totalChapters || 0)
    });
    // 正文用纯文本直传，避免 JSON 转义带来的体积膨胀；大文件放宽超时
    await apiRequest('/api/reader/books?' + params.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: text,
        timeout: 120000
    });
    return true;
}

/** 删除云端书目（本地删除时同步调用，失败只记日志） */
async function deleteBookFromCloud(bookKey) {
    // 先乐观地把它移出缓存，删除后书架不会闪现旧卡片
    cloudBooks = cloudBooks.filter(b => b.book_key !== bookKey);
    if (!state.authToken && !state.cookieSession) return;
    try {
        await apiRequest('/api/reader/books/' + encodeURIComponent(bookKey), { method: 'DELETE' });
    } catch (err) {
        console.warn('[reader] cloud book delete failed', err);
    }
}

/** 云端独有的书：点开时下载正文 → 落到本地 → 直接进入阅读 */
async function downloadBookFromCloud(bookKey) {
    const meta = cloudBooks.find(b => b.book_key === bookKey);
    if (!meta) { showToast('云端书目已失效，请刷新后重试', 'warn'); return; }
    const progressEl = document.getElementById('import-progress');
    const progressText = document.getElementById('import-progress-text');
    progressEl.style.display = 'block';
    progressText.textContent = '正在从云端下载《' + meta.title + '》...';
    try {
        const res = await fetchWithFallback('/api/reader/books/' + encodeURIComponent(bookKey), {
            method: 'GET',
            headers: {
                Accept: 'text/plain',
                ...(state.authToken ? { Authorization: 'Bearer ' + state.authToken } : {})
            }
        });
        if (!res.ok) throw new Error('下载失败 (' + res.status + ')');
        const text = await res.text();
        const book = await saveBookToLocalDB(text, {
            title: meta.title,
            author: meta.author || '未知作者',
            fileName: meta.title + '.txt',
            bookKey: bookKey
        }, (i, total) => { progressText.textContent = '正在保存章节 ' + (i + 1) + '/' + total + '...'; });
        progressEl.style.display = 'none';
        if (!book) return;
        await renderBookshelf();
        window.openReaderBook(book.id);
        showToast('☁️ 已下载《' + meta.title + '》', 'success');
    } catch (err) {
        progressEl.style.display = 'none';
        showToast('云端下载失败：' + err.message, 'error');
    }
}

/** 删除云端书籍（云端卡片上的 ✕） */
async function deleteCloudBook(encodedKey) {
    const bookKey = decodeURIComponent(encodedKey);
    const meta = cloudBooks.find(b => b.book_key === bookKey);
    if (!(await confirmDialog('确定从云端删除《' + ((meta && meta.title) || '这本书') + '》吗？'))) return;
    await deleteBookFromCloud(bookKey);
    showToast('已从云端删除', 'success');
    renderBookshelf();
}

/** 纯渲染：本地书目 + 云端独有的书目 */
function paintBookshelf(grid, empty, books) {
    const progress = loadReaderProgress();
    const localKeys = new Set(books.map(b => b.bookKey || computeBookKey(b)));
    const cloudOnly = cloudBooks.filter(cb => !localKeys.has(cb.book_key));
    if (!books.length && !cloudOnly.length) { setHtml(grid, ''); empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    books.sort((a, b) => {
        const pa = progress[a.id], pb = progress[b.id];
        return (pb ? pb.timestamp : 0) - (pa ? pa.timestamp : 0) || b.createdAt - a.createdAt;
    });

    // 只有确实拉到过云端书目时才敢断言「这本没上云」
    const cloudKeys = new Set(cloudBooks.map((cb) => cb.book_key));
    const localCards = books.map(b => {
        const prog = progress[b.id];
        const pct = prog && b.totalChapters ? Math.round((prog.chapterIdx / b.totalChapters) * 100) : 0;
        const lastRead = prog ? '看到第' + (prog.chapterIdx + 1) + '章' : '未开始阅读';
        const notSynced = cloudBooksSynced && !cloudKeys.has(b.bookKey || computeBookKey(b));
        return '<div class="book-card" data-bookid="' + b.id + '">' +
            '<span class="book-card-delete" data-delete="' + b.id + '">✕</span>' +
            '<span class="book-card-icon">📖</span>' +
            '<div class="book-card-title" title="' + escapeHtml(b.title) + '">' + escapeHtml(b.title) + '</div>' +
            '<div class="book-card-author">' + escapeHtml(b.author) + (notSynced ? ' · 未上云' : '') + '</div>' +
            '<div class="book-card-progress"><div class="book-card-progress-bar" style="width:' + pct + '%"></div></div>' +
            '<div class="book-card-meta"><span>' + lastRead + '</span><span>' + b.totalChapters + '章</span></div></div>';
    });
    const cloudCards = cloudOnly.map(cb => {
        const encodedKey = encodeURIComponent(cb.book_key);
        return '<div class="book-card" data-bookid="cloud:' + encodedKey + '">' +
            '<span class="book-card-delete" data-delete-cloud="' + encodedKey + '">✕</span>' +
            '<span class="book-card-icon">☁️</span>' +
            '<div class="book-card-title" title="' + escapeHtml(cb.title || '') + '">' + escapeHtml(cb.title || '') + '</div>' +
            '<div class="book-card-author">' + escapeHtml(cb.author || '未知作者') + ' · 云端书库</div>' +
            '<div class="book-card-progress"><div class="book-card-progress-bar" style="width:0%"></div></div>' +
            '<div class="book-card-meta"><span>点击下载到本机</span><span>' + (cb.total_chapters || 0) + '章</span></div></div>';
    });
    setHtml(grid, localCards.concat(cloudCards).join(''));

    // Attach event listeners
    grid.querySelectorAll('.book-card').forEach(card => {
        card.addEventListener('click', function(e) {
            if (e.target.closest('.book-card-delete')) return;
            const bookId = this.dataset.bookid || '';
            // 云端卡片：先把正文下载到本机再打开
            if (bookId.indexOf('cloud:') === 0) { downloadBookFromCloud(decodeURIComponent(bookId.slice(6))); return; }
            window.openReaderBook(bookId);
        });
    });
    grid.querySelectorAll('.book-card-delete').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            if (this.dataset.deleteCloud) { deleteCloudBook(this.dataset.deleteCloud); return; }
            window.deleteReaderBook(this.dataset.delete);
        });
    });
}

async function renderBookshelf() {
    const grid = document.getElementById('bookshelf-grid');
    const empty = document.getElementById('empty-bookshelf');
    let books = [];
    try { books = await rdbGetAll('books'); } catch(e) { books = []; }
    // 先画本地书架，再后台补云端书目：离线或网络慢时首屏依然即时
    paintBookshelf(grid, empty, books);
    fetchCloudBooks().then(() => {
        paintBookshelf(grid, empty, books);
        // 拉取成功才判断「哪些本机书还没上云」，并把它们补传（每次会话限量）
        backfillLocalBooks(books);
    });
}

// ── Open/Close Reader ──
window.openReaderBook = async function(bookId) {
    const book = await rdbGet('books', bookId);
    if (!book) return;
    currentBookId = bookId;
    currentBook = book;
    const bookKey = book.bookKey || computeBookKey(book);
    document.getElementById('reader-book-title').textContent = book.title;
    const allChapters = await rdbGetAll('chapters');
    chapterMetas = allChapters.filter(c => c.bookId === bookId).sort((a, b) => a.index - b.index);
    if (!chapterMetas.length) { showToast('数据异常！', 'error'); return; }
    const prog = loadReaderProgress();
    const saved = prog[bookId];
    currentChapterIdx = (saved && saved.chapterIdx < chapterMetas.length) ? saved.chapterIdx : 0;
    actions.switchView('reader-book');
    document.getElementById('reader-sidebar').classList.add('hidden');
    applyReaderSettings();
    buildChapterTree();
    await loadChapterContent(currentChapterIdx);
    const area = document.getElementById('reader-content-area');
    if (saved && saved.scrollPct) {
        setTimeout(() => { area.scrollTop = (saved.scrollPct / 100) * area.scrollHeight; }, 200);
    }
    area.removeEventListener('scroll', onReaderScroll);
    area.addEventListener('scroll', onReaderScroll);

    // 尝试拉取云端进度并自动对齐
    if (state.authToken || state.cookieSession) {
        apiRequest('/api/reader/progress')
            .then(list => {
                if (!Array.isArray(list) || !currentBookId || currentBookId !== bookId) return;
                const cloud = list.find(p => p.book_key === bookKey);
                if (!cloud) {
                    // 云端还没有这本书：把本机进度推上去（老设备首次联网也能补齐）
                    const firstLocal = loadReaderProgress()[bookId] || {};
                    if (firstLocal.timestamp) syncReaderProgressToCloud(currentBook, firstLocal.chapterIdx || 0, firstLocal.scrollPct || 0, '', firstLocal.timestamp);
                    return;
                }
                const local = loadReaderProgress()[bookId] || { chapterIdx: 0, scrollPct: 0, timestamp: 0 };
                const localTs = Number(local.timestamp || 0);
                const remoteTs = cloudProgressTs(cloud);
                const remoteAhead = cloud.chapter_index > local.chapterIdx
                    || (cloud.chapter_index === local.chapterIdx && cloud.scroll_percentage > (local.scrollPct || 0) + 5);
                const localAhead = local.chapterIdx > cloud.chapter_index
                    || (local.chapterIdx === cloud.chapter_index && (local.scrollPct || 0) > cloud.scroll_percentage + 5);

                // 本地更新且本地更靠前 → 回推一次，让云端追上（P4 保证不会被更旧的写入覆盖）
                if (localAhead && localTs > remoteTs) {
                    syncReaderProgressToCloud(currentBook, local.chapterIdx, local.scrollPct || 0, '', localTs);
                }

                // 云端更新（或老数据没有时间戳 client_ts=0）且位置更靠前 → 采纳云端，绝不把读者往回带
                const acceptCloud = remoteAhead && (remoteTs === 0 || remoteTs >= localTs);
                if (acceptCloud && cloud.chapter_index < chapterMetas.length) {
                    showToast(`已从云端同步最新进度：第 ${cloud.chapter_index + 1} 章 (${cloud.scroll_percentage}%)`, 'info');
                    loadChapterContent(cloud.chapter_index).then(() => {
                        const contentEl = document.getElementById('reader-content-area');
                        if (contentEl && cloud.scroll_percentage) {
                            setTimeout(() => {
                                contentEl.scrollTop = (cloud.scroll_percentage / 100) * contentEl.scrollHeight;
                            }, 200);
                        }
                    });
                }
            })
            .then(() => flushQueuedProgress())
            .catch(err => console.warn('[reader] fetch cloud progress failed', err));
    }
};

window.closeReaderBook = function() {
    actions.clearReaderSession?.();
    actions.switchView('reader');
};

/** Leave reader chrome/theme without switching views (swipe-back / route change). */
function clearReaderSession() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (cloudSyncTimer) { clearTimeout(cloudSyncTimer); cloudSyncTimer = null; }
    if (currentBookId && currentBook && chapterMetas.length) {
        const ch = chapterMetas[currentChapterIdx];
        const area = document.getElementById('reader-content-area');
        const pct = (area && area.scrollHeight > area.clientHeight)
            ? Math.round((area.scrollTop / (area.scrollHeight - area.clientHeight)) * 100) : 0;
        const leaveTs = Date.now();
        saveReaderProgress(currentBookId, { chapterIdx: currentChapterIdx, scrollPct: pct, timestamp: leaveTs });
        syncReaderProgressToCloud(currentBook, currentChapterIdx, pct, ch ? ch.title : '', leaveTs);
    }
    document.body.classList.remove('dark-reader-body', 'eyecare-reader-body', 'in-reader-book');
    document.documentElement.classList.remove('in-reader-book');
    const layout = document.querySelector('.reader-layout');
    if (layout) layout.classList.remove('dark-reader', 'eyecare-reader');
    // 回到应用级外观（批次 A）：深色主题下不要把状态栏刷回浅色
    applyAppTheme();
    currentBookId = null;
    currentBook = null;
    chapterMetas = [];
    currentChapterIdx = 0;
}

function onReaderScroll() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        if (!currentBookId || !chapterMetas.length) return;
        const area = document.getElementById('reader-content-area');
        const pct = area.scrollHeight > area.clientHeight
            ? Math.round((area.scrollTop / (area.scrollHeight - area.clientHeight)) * 100) : 0;
        saveReaderProgress(currentBookId, { chapterIdx: currentChapterIdx, scrollPct: pct, timestamp: Date.now() });
        scheduleCloudProgressSync();
    }, 1500);
}

// ── Chapter Tree ──
function buildChapterTree() {
    const container = document.getElementById('sidebar-chapter-list');
    const groups = {};
    chapterMetas.forEach((ch, idx) => {
        const g = ch.groupIndex;
        if (!groups[g]) groups[g] = [];
        groups[g].push({ title: ch.title, idx: idx, id: ch.id });
    });
    const keys = Object.keys(groups).sort((a, b) => Number(a) - Number(b));
    setHtml(container, keys.map(gk => {
        const chs = groups[gk];
        const gid = 'rg-' + gk;
        const isCurrentGroup = chs.some(ch => ch.idx === currentChapterIdx);
        const collapsedClass = isCurrentGroup ? '' : ' collapsed';
        const arrowClass = isCurrentGroup ? '' : ' collapsed';
        return '<div class="chapter-group-header' + arrowClass + '" data-chapter-toggle="' + gid + '">' +
            '<span class="group-arrow">▼</span>' +
            '第 ' + (chs[0].idx + 1) + ' - ' + (chs[chs.length - 1].idx + 1) + ' 章' +
            '<span style="margin-left:auto;font-size:0.65rem;opacity:0.5;font-weight:400;">' + chs.length + '章</span>' +
            '</div>' +
            '<div class="chapter-group-items' + collapsedClass + '" id="' + gid + '">' +
            chs.map(ch => '<div class="chapter-item' + (ch.idx === currentChapterIdx ? ' active' : '') +
                '" data-chapter-jump="' + ch.idx + '" title="' + escapeHtml(ch.title) + '">' +
                escapeHtml(ch.title) + '</div>').join('') +
            '</div>';
    }).join(''));
    // Scroll to active chapter
    setTimeout(() => {
        const active = container.querySelector('.chapter-item.active');
        if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 150);
}

// ── Chapter Loading ──
async function loadChapterContent(idx) {
    if (idx < 0 || idx >= chapterMetas.length) return;
    document.body.classList.add('is-loading');
    try {
        currentChapterIdx = idx;
        const ch = chapterMetas[idx];
        const fullCh = await rdbGet('chapters', ch.id);
        const content = fullCh ? fullCh.content : '（加载失败）';

        document.getElementById('chapter-title-display').textContent = ch.title;
        document.getElementById('chapter-body').textContent = typeof content === 'string' ? content.trimEnd() : content;
        document.getElementById('chapter-indicator').textContent = (idx + 1) + ' / ' + chapterMetas.length;
        document.getElementById('btn-prev-chapter').disabled = (idx <= 0);
        document.getElementById('btn-next-chapter').disabled = (idx >= chapterMetas.length - 1);

        // Update sidebar highlight
        const allItems = document.querySelectorAll('.chapter-item');
        allItems.forEach(el => el.classList.remove('active'));
        if (allItems[idx]) {
            allItems[idx].classList.add('active');
            // Expand parent group if collapsed
            const groupItems = allItems[idx].closest('.chapter-group-items');
            if (groupItems && groupItems.classList.contains('collapsed')) {
                groupItems.classList.remove('collapsed');
                const groupHeader = groupItems.previousElementSibling;
                if (groupHeader) groupHeader.classList.remove('collapsed');
            }
            allItems[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }

        document.getElementById('reader-content-area').scrollTop = 0;
        saveReaderProgress(currentBookId, { chapterIdx: idx, scrollPct: 0, timestamp: Date.now() });
        scheduleCloudProgressSync();
    } finally {
        setTimeout(() => {
            document.body.classList.remove('is-loading');
        }, 150);
    }
}

window.jumpToChapter = async function(idx) {
    await loadChapterContent(idx);
    if (window.innerWidth <= 768) document.getElementById('reader-sidebar').classList.add('hidden');
};
window.prevChapter = async function() {
    if (currentChapterIdx > 0) await loadChapterContent(currentChapterIdx - 1);
};
window.nextChapter = async function() {
    if (currentChapterIdx < chapterMetas.length - 1) await loadChapterContent(currentChapterIdx + 1);
};
window.toggleSidebar = function() {
    document.getElementById('reader-sidebar').classList.toggle('hidden');
};

// 事件绑定：等价于此前的内联 onclick（CSP 收紧后内联处理器会被浏览器拦截）
document.getElementById('btn-reader-sidebar-toggle')?.addEventListener('click', () => window.toggleSidebar());
document.getElementById('btn-reader-sidebar-close')?.addEventListener('click', () => window.toggleSidebar());
document.getElementById('btn-theme-toggle')?.addEventListener('click', () => window.toggleReaderTheme());
document.getElementById('btn-prev-chapter')?.addEventListener('click', () => window.prevChapter());
document.getElementById('btn-next-chapter')?.addEventListener('click', () => window.nextChapter());

const closeReaderTypographyModal = () => {
    document.getElementById('reader-typography-modal')?.classList.remove('show');
};

document.getElementById('btn-reader-typography-toggle')?.addEventListener('click', () => {
    applyReaderSettings();
    document.getElementById('reader-typography-modal')?.classList.add('show');
});

document.querySelectorAll('[data-close-modal="reader-typography-modal"]').forEach(btn => {
    btn.addEventListener('click', closeReaderTypographyModal);
});

document.getElementById('reader-typography-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'reader-typography-modal') {
        closeReaderTypographyModal();
    }
});

// 字号调节：步进器与滑块
document.getElementById('btn-reader-font-decrease')?.addEventListener('click', () => {
    const s = loadReaderSettings();
    s.fontSize = Math.max(14, (Number(s.fontSize) || 18) - 1);
    saveReaderSettings(s);
    applyReaderSettings();
});

document.getElementById('btn-reader-font-increase')?.addEventListener('click', () => {
    const s = loadReaderSettings();
    s.fontSize = Math.min(28, (Number(s.fontSize) || 18) + 1);
    saveReaderSettings(s);
    applyReaderSettings();
});

document.getElementById('reader-font-size-slider')?.addEventListener('input', (e) => {
    const s = loadReaderSettings();
    s.fontSize = Number(e.target.value);
    saveReaderSettings(s);
    applyReaderSettings();
});

// 行间距切换
document.getElementById('reader-line-height-control')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.segment-btn');
    if (!btn) return;
    const lh = btn.getAttribute('data-lh');
    if (lh) {
        const s = loadReaderSettings();
        s.lineHeight = lh;
        saveReaderSettings(s);
        applyReaderSettings();
    }
});

// 字体风格切换
document.getElementById('reader-font-family-control')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.segment-btn');
    if (!btn) return;
    const font = btn.getAttribute('data-font');
    if (font) {
        const s = loadReaderSettings();
        s.fontFamily = font;
        saveReaderSettings(s);
        applyReaderSettings();
    }
});

// 阅读主题色板选择
document.getElementById('reader-theme-swatches')?.addEventListener('click', (e) => {
    const item = e.target.closest('.theme-swatch-item');
    if (!item) return;
    const theme = item.getAttribute('data-theme-swatch');
    if (theme) {
        const s = loadReaderSettings();
        s.theme = theme;
        saveReaderSettings(s);
        applyReaderSettings();
    }
});

document.getElementById('sidebar-chapter-list')?.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const toggle = target.closest('[data-chapter-toggle]');
    if (toggle) {
        toggle.classList.toggle('collapsed');
        const gid = toggle.getAttribute('data-chapter-toggle');
        if (gid) document.getElementById(gid)?.classList.toggle('collapsed');
        return;
    }
    const jump = target.closest('[data-chapter-jump]');
    if (jump) {
        const idx = Number(jump.getAttribute('data-chapter-jump'));
        if (Number.isInteger(idx) && typeof window.jumpToChapter === 'function') window.jumpToChapter(idx);
    }
});
window.deleteReaderBook = async function(bookId) {
    if (!(await confirmDialog('确定删除这本书吗？'))) return;
    const book = await rdbGet('books', bookId);
    const chapters = await rdbGetAll('chapters');
    for (const ch of chapters) { if (ch.bookId === bookId) await rdbDelete('chapters', ch.id); }
    await rdbDelete('books', bookId);
    deleteReaderProgress(bookId);
    // 本地删掉后同步删云端副本，避免下次刷新又变回「云端卡片」
    if (book) {
        const cloudKey = book.bookKey || computeBookKey(book);
        dropQueuedProgress(cloudKey);   // 队列里若还压着这本书的进度，别在删完之后补推回去
        await deleteBookFromCloud(cloudKey);
    }
    renderBookshelf();
};

// ── Settings ──
function applyReaderSettings() {
    const s = loadReaderSettings();
    const fs = Number(s.fontSize) || 18;
    const lh = s.lineHeight || '1.8';
    const font = s.fontFamily || 'sans';
    const theme = s.theme || 'light';

    const contentArea = document.getElementById('reader-content-area');
    if (contentArea) {
        contentArea.style.setProperty('--reader-font-size', fs + 'px');
        contentArea.style.setProperty('--reader-line-height', lh);
        if (font === 'serif') {
            contentArea.style.setProperty('--reader-font-family', '-apple-system-ui-serif, "Songti SC", "SimSun", "Noto Serif CJK SC", Georgia, serif');
        } else {
            contentArea.style.setProperty('--reader-font-family', '-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif');
        }
        contentArea.style.fontSize = fs + 'px';
    }

    // 更新排版弹层控件状态
    const sizeVal = document.getElementById('reader-font-size-val');
    if (sizeVal) sizeVal.textContent = fs + 'px';
    const slider = document.getElementById('reader-font-size-slider');
    if (slider) slider.value = fs;

    document.querySelectorAll('#reader-line-height-control .segment-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-lh') === lh);
    });

    document.querySelectorAll('#reader-font-family-control .segment-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-font') === font);
    });

    document.querySelectorAll('#reader-theme-swatches .theme-swatch-item').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-theme-swatch') === theme);
    });

    // Remove all theme classes from body
    document.body.classList.remove('dark-reader-body', 'eyecare-reader-body');
    const layout = document.querySelector('.reader-layout');
    if (layout) layout.classList.remove('dark-reader', 'eyecare-reader');
    const btn = document.getElementById('btn-theme-toggle');
    const themeMeta = document.querySelector('meta[name="theme-color"]');

    const THEME_ICONS = {
        moon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`,
        sun: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`,
        leaf: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"></path><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"></path></svg>`
    };

    if (theme === 'dark') {
        document.body.classList.add('dark-reader-body');
        if (layout) layout.classList.add('dark-reader');
        if (btn) setHtml(btn, THEME_ICONS.sun);
        if (themeMeta) themeMeta.setAttribute('content', '#0f1115');
    } else if (theme === 'eyecare') {
        document.body.classList.add('eyecare-reader-body');
        if (layout) layout.classList.add('eyecare-reader');
        if (btn) setHtml(btn, THEME_ICONS.leaf);
        if (themeMeta) themeMeta.setAttribute('content', '#e8f0e0');
    } else {
        if (btn) setHtml(btn, THEME_ICONS.moon);
        if (themeMeta) themeMeta.setAttribute('content', '#f8f8fa');
    }
}
window.toggleReaderTheme = function() {
    const s = loadReaderSettings();
    // Cycle: light → dark → eyecare → light
    if (s.theme === 'dark') s.theme = 'eyecare';
    else if (s.theme === 'eyecare') s.theme = 'light';
    else s.theme = 'dark';
    saveReaderSettings(s);
    applyReaderSettings();
};

// ── Keyboard ──
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        closeReaderTypographyModal();
    }
    if (!currentBookId) return;
    if (e.key === 'ArrowLeft' || (e.key === 'ArrowUp' && e.ctrlKey)) { e.preventDefault(); prevChapter(); }
    else if (e.key === 'ArrowRight' || (e.key === 'ArrowDown' && e.ctrlKey)) { e.preventDefault(); nextChapter(); }
});

// ── File Import ──
document.getElementById('book-file-input').addEventListener('change', function() {
    const file = this.files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.txt')) { showToast('请选择 TXT 文件！', 'warn'); return; }
    importBook(file);
    this.value = '';
});

// Initial bookshelf render on first load
openReaderDB().then(() => {
    if (document.getElementById('view-reader').classList.contains('active')) renderBookshelf();
});

// Prevent outer page overscroll pull/bounce when reading on mobile touch devices
let readerTouchStartY = 0;
document.addEventListener('touchstart', (e) => {
    if (!document.body.classList.contains('in-reader-book')) return;
    if (e.touches && e.touches.length === 1) {
        readerTouchStartY = e.touches[0].clientY;
    }
}, { passive: true });

document.addEventListener('touchmove', (e) => {
    if (!document.body.classList.contains('in-reader-book')) return;
    const scrollContainer = e.target.closest('#reader-content-area, #sidebar-chapter-list');
    if (!scrollContainer) {
        // Prevent outer dragging on toolbar, bottom navigation, and screen edges
        e.preventDefault();
        return;
    }
    if (!e.touches || e.touches.length !== 1) return;
    const currentY = e.touches[0].clientY;
    const deltaY = currentY - readerTouchStartY;
    const isAtTop = scrollContainer.scrollTop <= 0;
    const isAtBottom = scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 1;

    // Pulling down while already at the top
    if (isAtTop && deltaY > 0) {
        e.preventDefault();
        return;
    }
    // Pulling up while already at the bottom (prevents pulling out blank gap)
    if (isAtBottom && deltaY < 0) {
        e.preventDefault();
        return;
    }
}, { passive: false });

    // P2：网络恢复后自动补推断网期间积压的阅读进度
    window.addEventListener('online', () => { flushQueuedProgress(); });

    actions.renderBookshelf = renderBookshelf;
    actions.clearReaderSession = clearReaderSession;

    return { renderBookshelf, openReaderDB };
}
