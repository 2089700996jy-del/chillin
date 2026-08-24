import { escapeHtml } from './utils.js';
import { actions } from './actions.js';

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
let currentChapterIdx = 0;
let chapterMetas = [];
let saveTimer = null;

// ── Progress (localStorage) ──
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
function loadReaderSettings() {
    try { return JSON.parse(localStorage.getItem('reader_settings') || '{}'); } catch(e) { return {}; }
}
function saveReaderSettings(s) {
    localStorage.setItem('reader_settings', JSON.stringify(s));
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

function decodeBuffer(buf) {
    try {
        const text = new TextDecoder('gbk').decode(buf);
        if ((text.match(/[一-鿿]/g) || []).length > 50) return text;
    } catch(e) {}
    try { return new TextDecoder('utf-8').decode(buf); }
    catch(e) { return new TextDecoder('utf-8', { fatal: false }).decode(buf); }
}

// ── Import ──
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
        const chapters = parseChapters(text);
        if (!chapters.length) { alert('未检测到章节！'); progressEl.style.display = 'none'; return; }

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

        const bookId = 'book_' + Date.now();
        progressText.textContent = '正在保存书籍信息...';
        await rdbPut('books', {
            id: bookId, title: bookTitle, author: bookAuthor,
            fileName: file.name, totalChapters: chapters.length,
            groupCount: Math.ceil(chapters.length / 200), createdAt: Date.now()
        });

        const BATCH = 80;
        for (let i = 0; i < chapters.length; i += BATCH) {
            progressText.textContent = '正在保存章节 ' + (i + 1) + '/' + chapters.length + '...';
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

        progressEl.style.display = 'none';
        renderBookshelf();
        alert('✅ 导入完成！\n书名：' + bookTitle + '\n章节数：' + chapters.length);
    } catch (err) {
        console.error('Import failed:', err);
        progressEl.style.display = 'none';
        alert('导入失败：' + err.message);
    }
}

// ── Bookshelf ──
async function renderBookshelf() {
    const grid = document.getElementById('bookshelf-grid');
    const empty = document.getElementById('empty-bookshelf');
    const progress = loadReaderProgress();
    let books = [];
    try { books = await rdbGetAll('books'); } catch(e) { books = []; }
    if (!books.length) { grid.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    books.sort((a, b) => {
        const pa = progress[a.id], pb = progress[b.id];
        return (pb ? pb.timestamp : 0) - (pa ? pa.timestamp : 0) || b.createdAt - a.createdAt;
    });
    grid.innerHTML = books.map(b => {
        const prog = progress[b.id];
        const pct = prog && b.totalChapters ? Math.round((prog.chapterIdx / b.totalChapters) * 100) : 0;
        const lastRead = prog ? '看到第' + (prog.chapterIdx + 1) + '章' : '未开始阅读';
        return '<div class="book-card" data-bookid="' + b.id + '">' +
            '<span class="book-card-delete" data-delete="' + b.id + '">✕</span>' +
            '<span class="book-card-icon">📖</span>' +
            '<div class="book-card-title" title="' + escapeHtml(b.title) + '">' + escapeHtml(b.title) + '</div>' +
            '<div class="book-card-author">' + escapeHtml(b.author) + '</div>' +
            '<div class="book-card-progress"><div class="book-card-progress-bar" style="width:' + pct + '%"></div></div>' +
            '<div class="book-card-meta"><span>' + lastRead + '</span><span>' + b.totalChapters + '章</span></div></div>';
    }).join('');

    // Attach event listeners
    grid.querySelectorAll('.book-card').forEach(card => {
        card.addEventListener('click', function(e) {
            if (e.target.closest('.book-card-delete')) return;
            openReaderBook(this.dataset.bookid);
        });
    });
    grid.querySelectorAll('.book-card-delete').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            deleteReaderBook(this.dataset.delete);
        });
    });
}

// ── Open/Close Reader ──
window.openReaderBook = async function(bookId) {
    const book = await rdbGet('books', bookId);
    if (!book) return;
    currentBookId = bookId;
    document.getElementById('reader-book-title').textContent = book.title;
    const allChapters = await rdbGetAll('chapters');
    chapterMetas = allChapters.filter(c => c.bookId === bookId).sort((a, b) => a.index - b.index);
    if (!chapterMetas.length) { alert('数据异常！'); return; }
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
};

window.closeReaderBook = function() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    onReaderScroll();
    // Clear reader theme when exiting
    document.body.classList.remove('dark-reader-body', 'eyecare-reader-body');
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', '#ffffff');
    currentBookId = null; chapterMetas = []; currentChapterIdx = 0;
    actions.switchView('reader'); // actions.switchView will trigger renderBookshelf
};

function onReaderScroll() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        if (!currentBookId || !chapterMetas.length) return;
        const area = document.getElementById('reader-content-area');
        const pct = area.scrollHeight > area.clientHeight
            ? Math.round((area.scrollTop / (area.scrollHeight - area.clientHeight)) * 100) : 0;
        saveReaderProgress(currentBookId, { chapterIdx: currentChapterIdx, scrollPct: pct, timestamp: Date.now() });
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
    container.innerHTML = keys.map(gk => {
        const chs = groups[gk];
        const gid = 'rg-' + gk;
        const isCurrentGroup = chs.some(ch => ch.idx === currentChapterIdx);
        const collapsedClass = isCurrentGroup ? '' : ' collapsed';
        const arrowClass = isCurrentGroup ? '' : ' collapsed';
        return '<div class="chapter-group-header' + arrowClass + '" onclick="this.classList.toggle(\'collapsed\');document.getElementById(\'' + gid + '\').classList.toggle(\'collapsed\')">' +
            '<span class="group-arrow">▼</span>' +
            '第 ' + (chs[0].idx + 1) + ' - ' + (chs[chs.length - 1].idx + 1) + ' 章' +
            '<span style="margin-left:auto;font-size:0.65rem;opacity:0.5;font-weight:400;">' + chs.length + '章</span>' +
            '</div>' +
            '<div class="chapter-group-items' + collapsedClass + '" id="' + gid + '">' +
            chs.map(ch => '<div class="chapter-item' + (ch.idx === currentChapterIdx ? ' active' : '') +
                '" onclick="jumpToChapter(' + ch.idx + ')" title="' + escapeHtml(ch.title) + '">' +
                escapeHtml(ch.title) + '</div>').join('') +
            '</div>';
    }).join('');
    // Scroll to active chapter
    setTimeout(() => {
        const active = container.querySelector('.chapter-item.active');
        if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 150);
}

// ── Chapter Loading ──
async function loadChapterContent(idx) {
    if (idx < 0 || idx >= chapterMetas.length) return;
    currentChapterIdx = idx;
    const ch = chapterMetas[idx];
    const fullCh = await rdbGet('chapters', ch.id);
    const content = fullCh ? fullCh.content : '（加载失败）';

    document.getElementById('chapter-title-display').textContent = ch.title;
    document.getElementById('chapter-body').textContent = content;
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
window.deleteReaderBook = async function(bookId) {
    if (!confirm('确定删除这本书吗？')) return;
    const chapters = await rdbGetAll('chapters');
    for (const ch of chapters) { if (ch.bookId === bookId) await rdbDelete('chapters', ch.id); }
    await rdbDelete('books', bookId);
    deleteReaderProgress(bookId);
    renderBookshelf();
};

// ── Settings ──
function applyReaderSettings() {
    const s = loadReaderSettings();
    const fs = s.fontSize || 18;
    const theme = s.theme || 'light';
    document.getElementById('reader-content-area').style.setProperty('--reader-font-size', fs + 'px');
    document.getElementById('reader-content-area').style.fontSize = fs + 'px';

    // Remove all theme classes from body
    document.body.classList.remove('dark-reader-body', 'eyecare-reader-body');
    const layout = document.querySelector('.reader-layout');
    if (layout) layout.classList.remove('dark-reader', 'eyecare-reader');
    const btn = document.getElementById('btn-theme-toggle');
    const themeMeta = document.querySelector('meta[name="theme-color"]');

    if (theme === 'dark') {
        document.body.classList.add('dark-reader-body');
        if (layout) layout.classList.add('dark-reader');
        if (btn) btn.textContent = '☀️';
        if (themeMeta) themeMeta.setAttribute('content', '#0d1117');
    } else if (theme === 'eyecare') {
        document.body.classList.add('eyecare-reader-body');
        if (layout) layout.classList.add('eyecare-reader');
        if (btn) btn.textContent = '🌿';
        if (themeMeta) themeMeta.setAttribute('content', '#dcedc8');
    } else {
        if (btn) btn.textContent = '🌙';
        if (themeMeta) themeMeta.setAttribute('content', '#ffffff');
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
    if (!currentBookId) return;
    if (e.key === 'ArrowLeft' || (e.key === 'ArrowUp' && e.ctrlKey)) { e.preventDefault(); prevChapter(); }
    else if (e.key === 'ArrowRight' || (e.key === 'ArrowDown' && e.ctrlKey)) { e.preventDefault(); nextChapter(); }
});

// ── File Import ──
document.getElementById('book-file-input').addEventListener('change', function() {
    const file = this.files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.txt')) { alert('请选择 TXT 文件！'); return; }
    importBook(file);
    this.value = '';
});

// Initial bookshelf render on first load
openReaderDB().then(() => {
    if (document.getElementById('view-reader').classList.contains('active')) renderBookshelf();
});



    actions.renderBookshelf = renderBookshelf;
    actions.getReaderAnnotations = () => [];

    return { renderBookshelf, openReaderDB };
}
