import {
    showToast,
    escapeHtml,
    markdownToHtml,
} from './js/utils.js';
import { state } from './js/state.js';
import { ui } from './js/ui.js';
import { actions } from './js/actions.js';
import {
    API_BASE,
    resolveAssetUrl,
    fetchWithFallback,
    getLocalKey,
    checkAuth,
    initAuthUI,
    apiRequest,
    registerPushNotification,
    loadLocalData,
    syncFromApi,
    stampLocalUpdate,
    addDeletedId,
    apiSyncFeed,
    checkAndMergeGuestData,
    startAutoSyncEngine,
    bindApiHooks,
} from './js/api.js';
import { initRouter } from './js/router.js';
import { initWeeklies } from './js/weeklies.js';
import { initNotes } from './js/notes.js';
import { initBookmarks } from './js/bookmarks.js';

document.addEventListener('DOMContentLoaded', () => {

    // Auth / sync / persistence: ./js/api.js + ./js/state.js

    // ui nav/search state: ./js/ui.js
    // Domains: router / weeklies / notes / bookmarks → js/*.js

    // ==========================================
    // 7. 全局事件与同步备份
    // ==========================================
    const navbar = document.getElementById('navbar');
    window.addEventListener('scroll', () => {
        if (window.scrollY > 20) navbar.classList.add('scrolled');
        else navbar.classList.remove('scrolled');
    });





    // 图片上传处理
    const globalImageUploader = document.getElementById('global-image-uploader');
    let currentUploadTargetInput = null;

    document.querySelectorAll('.btn-upload-image').forEach(btn => {
        btn.addEventListener('click', () => {
            currentUploadTargetInput = document.getElementById(btn.dataset.target);
            if (globalImageUploader) {
                globalImageUploader.click();
            }
        });
    });

    // 客户端图片压缩，避免手机相册原图过大（Telegraph 限制 5MB 且不支持 HEIC）
    const compressImage = (file, maxWidth = 1600, maxHeight = 1600, quality = 0.8) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = (event) => {
                const img = new Image();
                img.src = event.target.result;
                img.onload = () => {
                    let width = img.width;
                    let height = img.height;

                    if (width > maxWidth || height > maxHeight) {
                        if (width > height) {
                            height = Math.round((height * maxWidth) / width);
                            width = maxWidth;
                        } else {
                            width = Math.round((width * maxHeight) / height);
                            height = maxHeight;
                        }
                    }

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);

                    canvas.toBlob((blob) => {
                        if (blob) {
                            resolve(blob);
                        } else {
                            reject(new Error('Canvas to Blob conversion failed'));
                        }
                    }, 'image/jpeg', quality);
                };
                img.onerror = (err) => reject(err);
            };
            reader.onerror = (err) => reject(err);
        });
    };

    if (globalImageUploader) {
        globalImageUploader.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file || !currentUploadTargetInput) return;

            const uploadBtn = document.querySelector(`.btn-upload-image[data-target="${currentUploadTargetInput.id}"]`);
            const originalBtnText = uploadBtn ? uploadBtn.innerText : '📷 上传';
            
            let uploadFile = file;
            if (file.type.startsWith('image/')) {
                if (uploadBtn) {
                    uploadBtn.innerText = '压缩中...';
                    uploadBtn.disabled = true;
                }
                try {
                    const compressedBlob = await compressImage(file, 1600, 1600, 0.85);
                    const baseName = file.name.includes('.') ? file.name.substring(0, file.name.lastIndexOf('.')) : file.name;
                    const newFileName = `${baseName || 'image'}.jpg`;
                    uploadFile = new File([compressedBlob], newFileName, { type: 'image/jpeg' });
                } catch (compressErr) {
                    console.warn('Image compression failed, using original file:', compressErr);
                }
            }

            if (uploadBtn) {
                uploadBtn.innerText = '上传中...';
                uploadBtn.disabled = true;
            }

            const formData = new FormData();
            formData.append('file', uploadFile);

            const headers = {};
            if (state.authToken) {
                headers['Authorization'] = `Bearer ${state.authToken}`;
            }

            try {
                const res = await fetch(`${API_BASE}/api/upload`, {
                    method: 'POST',
                    headers: headers,
                    body: formData
                });
                if (!res.ok) throw new Error('上传接口返回异常');
                const data = await res.json();
                if (data && data[0] && data[0].src) {
                    currentUploadTargetInput.value = data[0].src;
                    currentUploadTargetInput.dispatchEvent(new Event('input', { bubbles: true }));
                    if (currentUploadTargetInput.id === 'feed-media-url') {
                        const previewWrap = document.getElementById('feed-media-preview');
                        const previewImg = document.getElementById('feed-media-preview-img');
                        if (previewWrap && previewImg) {
                            previewImg.src = resolveAssetUrl(data[0].src);
                            previewWrap.style.display = 'block';
                        }
                        const mediaWrap = document.getElementById('feed-media-input-wrapper');
                        if (mediaWrap) mediaWrap.style.display = 'block';
                    } else {
                        alert('图片上传成功！已填入链接。');
                    }
                } else {
                    throw new Error('解析上传结果失败');
                }
            } catch (err) {
                alert('图片上传失败，请重试：' + err.message);
            } finally {
                if (uploadBtn) {
                    uploadBtn.innerText = originalBtnText;
                    uploadBtn.disabled = false;
                }
                globalImageUploader.value = '';
            }
        });
    }

    // ════════════════════════════════════════════
    // READER MODULE — 小说阅读器
    // ════════════════════════════════════════════

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

        if (theme === 'dark') {
            document.body.classList.add('dark-reader-body');
            if (layout) layout.classList.add('dark-reader');
            if (btn) btn.textContent = '☀️';
        } else if (theme === 'eyecare') {
            document.body.classList.add('eyecare-reader-body');
            if (layout) layout.classList.add('eyecare-reader');
            if (btn) btn.textContent = '🌿';
        } else {
            if (btn) btn.textContent = '🌙';
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

    // ════════════════════════════════════════════

    // 搜索输入框事件监听
    const searchHomeInput = document.getElementById('search-home');
    if (searchHomeInput) {
        searchHomeInput.addEventListener('input', (e) => {
            ui.currentHomeSearchQuery = e.target.value;
            actions.renderCards();
        });
    }

    const searchNotesInput = document.getElementById('search-notes');
    if (searchNotesInput) {
        searchNotesInput.addEventListener('input', (e) => {
            ui.currentNotesSearchQuery = e.target.value;
            actions.renderNotes();
        });
    }

    const searchBookmarksInput = document.getElementById('search-bookmarks');
    if (searchBookmarksInput) {
        searchBookmarksInput.addEventListener('input', (e) => {
            ui.currentBookmarksSearchQuery = e.target.value;
            actions.renderBookmarks();
        });
    }

    // ════════════════════════════════════════════
    // MINDBACK ECHO FEATURES JAVASCRIPT LOGIC
    // ════════════════════════════════════════════

    // 1. Render Feeds Stream (随手记流)
    function extractUrlFromText(text) {
        if (!text) return null;
        const match = text.match(/(https?:\/\/[^\s]+|(?:www\.)?[a-zA-Z0-9-]+\.(?:com|net|org|cn|fm|cc|co|tv|me|io|xyz)[^\s]*)/i);
        if (!match) return null;
        let raw = match[0].trim();
        let normalized = raw;
        if (!normalized.match(/^https?:\/\//i)) {
            normalized = 'https://' + normalized;
        }
        return { raw, normalized };
    }

    function renderFeeds() {
        const container = document.getElementById('feeds-stream-container');
        if (!container) return;

        const displayFeeds = state.feedsDatabase;

        if (!displayFeeds || displayFeeds.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 40px 20px; color: #9ca3af;">
                    <div style="font-size: 32px; margin-bottom: 8px;">⚡️</div>
                    <div style="font-size: 14px; font-weight: 500;">随手记流空空如也</div>
                    <div style="font-size: 12px; margin-top: 4px;">在上方输入框倾倒你的第一个思考吧</div>
                </div>
            `;
            return;
        }

        const pendingEnrichFeeds = [];

        container.innerHTML = displayFeeds.map(feed => {
            const tags = feed.tags || [];
            const tagHtml = tags.map(t => `<span class="feed-tag-pill">${escapeHtml(t)}</span>`).join('');

            
            // Format link preview if summary or link exists
            let linkHtml = '';
            const extracted = extractUrlFromText(feed.content);
            if (extracted || feed.summary) {
                const targetUrl = extracted ? extracted.normalized : '#';
                let meta = null;
                if (feed.summary) {
                    try {
                        if (feed.summary.trim().startsWith('{')) {
                            meta = JSON.parse(feed.summary);
                        }
                    } catch {}
                }

                let title = meta?.title || (feed.summary && !feed.summary.startsWith('{') ? feed.summary : '');
                let description = meta?.description || '';
                let coverUrl = meta?.cover || feed.media_url || '';
                let platformName = meta?.platform || '';
                let platformIcon = meta?.icon || '';

                if (!title || /^(403|404|500|Forbidden|Access Denied|Error)/i.test(title.trim())) {
                    try {
                        title = new URL(targetUrl).hostname;
                    } catch {
                        title = targetUrl;
                    }
                }

                if (!platformName) {
                    try {
                        const u = new URL(targetUrl);
                        const host = u.hostname;
                        if (host.includes('xiaoyuzhoufm.com')) { platformName = '小宇宙'; platformIcon = '🪐'; }
                        else if (host.includes('xiaohongshu.com') || host.includes('xhslink.com')) { platformName = '小红书'; platformIcon = '📕'; }
                        else if (host.includes('bilibili.com') || host.includes('b23.tv')) { platformName = 'Bilibili'; platformIcon = '📺'; }
                        else if (host.includes('weixin.qq.com')) { platformName = '微信文章'; platformIcon = '💬'; }
                        else if (host.includes('zhihu.com')) { platformName = '知乎'; platformIcon = '💡'; }
                        else if (host.includes('music.163.com')) { platformName = '网易云音乐'; platformIcon = '🎵'; }
                        else if (host.includes('weibo.com') || host.includes('weibo.cn')) { platformName = '微博'; platformIcon = '🔴'; }
                        else { platformName = host; platformIcon = '🌐'; }
                    } catch {
                        platformName = '网络链接';
                        platformIcon = '🌐';
                    }
                }

                // Auto enrich unparsed links or plain hostnames (e.g. historical posts)
                if (extracted && (!meta || !meta.cover || title === 'www.xiaoyuzhoufm.com' || title === 'xiaoyuzhoufm.com')) {
                    if (!feed._enriching) {
                        pendingEnrichFeeds.push({ feed, url: extracted.normalized });
                    }
                }

                linkHtml = `
                    <a href="${escapeHtml(targetUrl)}" target="_blank" class="rich-link-card" onclick="event.stopPropagation()">
                        <div class="rich-link-main">
                            <div class="rich-link-info">
                                <div class="rich-link-title">${escapeHtml(title)}</div>
                                ${description ? `<div class="rich-link-desc">${escapeHtml(description)}</div>` : ''}
                            </div>
                            ${coverUrl ? `<img src="${escapeHtml(resolveAssetUrl(coverUrl))}" class="rich-link-cover" referrerpolicy="no-referrer" alt="" onerror="this.onerror=null; this.style.display='none'">` : ''}
                        </div>
                        <div class="rich-link-footer">
                            <span class="rich-platform-pill">
                                <span class="platform-icon">${platformIcon}</span>
                                <span class="platform-name">${escapeHtml(platformName)}</span>
                                <span class="platform-divider">|</span>
                                <span class="platform-action">链接速览</span>
                                <svg class="platform-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
                            </span>
                        </div>
                    </a>
                `;
            }

            // Image preview
            let mediaHtml = '';
            if (feed.media_url && !linkHtml) {
                mediaHtml = `<img src="${escapeHtml(resolveAssetUrl(feed.media_url))}" class="feed-media-preview" alt="" onclick="previewImage(this.src)">`;
            }

            // Remove raw URL text if a rich link card is displayed
            let contentText = feed.content || '';
            if (extracted && linkHtml) {
                contentText = contentText.replace(extracted.raw, '').replace(extracted.normalized, '').trim();
            }

            let textHtml = '';
            if (contentText) {
                const formattedContent = escapeHtml(contentText).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:#6366f1;">$1</a>');
                textHtml = `<div class="feed-content-text">${formattedContent}</div>`;
            }

            return `
                <div class="feed-item-card" data-feed-id="${feed.id}">
                    <div class="feed-header">
                        <div class="feed-tags">${tagHtml}</div>
                        <div style="display:flex;align-items:center;gap:10px;">
                            <span class="feed-date">${escapeHtml(feed.created_at || '')}</span>
                            <button class="btn-text text-danger" onclick="deleteFeed(${feed.id})" style="font-size:12px;">删除</button>
                        </div>
                    </div>
                    ${textHtml}
                    ${mediaHtml}
                    ${linkHtml}
                </div>
            `;
        }).join('');

        // Async auto enrichment for historical unparsed links
        if (pendingEnrichFeeds.length > 0) {
            pendingEnrichFeeds.forEach(({ feed, url }) => {
                feed._enriching = true;
                apiRequest('/api/link/parse', {
                    method: 'POST',
                    body: JSON.stringify({ url })
                }).then(parseRes => {
                    if (parseRes && parseRes.title) {
                        feed.summary = JSON.stringify(parseRes);
                        if (parseRes.cover) feed.media_url = parseRes.cover;
                        feed.updated_at = new Date().toISOString();
                        feed._dirty = true;
                        saveFeedsDatabase();
                        renderFeeds();
                        apiSyncFeed(feed, 'PUT');
                    }
                }).catch(() => {});
            });
        }
    }

    // 2. Add Feed Handler
    const btnSendFeed = document.getElementById('btn-send-feed');
    const feedInputText = document.getElementById('feed-input-text');
    const feedMediaUrlInput = document.getElementById('feed-media-url');
    const btnFeedAddMedia = document.getElementById('btn-feed-add-media');
    const feedMediaInputWrapper = document.getElementById('feed-media-input-wrapper');
    const btnFeedRemoveMedia = document.getElementById('btn-feed-remove-media');

    if (btnFeedAddMedia && feedMediaInputWrapper) {
        btnFeedAddMedia.addEventListener('click', () => {
            const uploader = document.getElementById('global-image-uploader');
            if (uploader) {
                // Manually trigger upload flow
                currentUploadTargetInput = feedMediaUrlInput;
                uploader.click();
            }
        });
    }

    if (btnFeedRemoveMedia) {
        btnFeedRemoveMedia.addEventListener('click', () => {
            if (feedMediaUrlInput) {
                feedMediaUrlInput.value = '';
                feedMediaUrlInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
    }

    const updateFeedMediaPreview = () => {
        const previewWrap = document.getElementById('feed-media-preview');
        const previewImg = document.getElementById('feed-media-preview-img');
        if (!previewWrap || !previewImg || !feedMediaUrlInput) return;
        const url = feedMediaUrlInput.value.trim();
        if (url) {
            previewImg.src = resolveAssetUrl(url);
            previewWrap.style.display = 'inline-block';
            if (feedMediaInputWrapper) feedMediaInputWrapper.style.display = 'block';
        } else {
            previewImg.removeAttribute('src');
            previewWrap.style.display = 'none';
            if (feedMediaInputWrapper) feedMediaInputWrapper.style.display = 'none';
        }
    };
    if (feedMediaUrlInput) {
        feedMediaUrlInput.addEventListener('input', updateFeedMediaPreview);
    }

    // Chip Tag click listener
    document.querySelectorAll('.feed-tools .btn-chip[data-tag]').forEach(chip => {
        chip.addEventListener('click', () => {
            const tag = chip.dataset.tag;
            if (feedInputText) {
                if (!feedInputText.value.includes(tag)) {
                    feedInputText.value += ` ${tag} `;
                }
            }
        });
    });

    async function sendFeed() {
        if (!feedInputText) return;
        const content = feedInputText.value.trim();
        const mediaUrl = feedMediaUrlInput ? feedMediaUrlInput.value.trim() : '';
        if (!content && !mediaUrl) return;

        btnSendFeed.disabled = true;
        btnSendFeed.innerText = '解析中...';

        let summary = null;
        let type = mediaUrl ? 'image' : 'text';
        let parsedCover = '';

        // Check if content contains a URL (supports https:// and www. domain URLs)
        const extracted = extractUrlFromText(content);
        if (extracted) {
            type = 'link';
            try {
                const parseRes = await apiRequest('/api/link/parse', {
                    method: 'POST',
                    body: JSON.stringify({ url: extracted.normalized })
                });
                if (parseRes) {
                    summary = JSON.stringify(parseRes);
                    if (parseRes.cover) parsedCover = parseRes.cover;
                }
            } catch {}
        } else if (mediaUrl) {
            type = 'image';
        }

        const newFeed = {
            id: Date.now(),
            content: content || '分享了图片/链接',
            type,
            media_url: mediaUrl || parsedCover || null,
            summary,
            tags: [],
            created_at: new Date().toISOString().replace('T', ' ').slice(0, 16)
        };
        stampLocalUpdate(newFeed);

        state.feedsDatabase.unshift(newFeed);
        localStorage.setItem(getLocalKey('gardenFeeds'), JSON.stringify(state.feedsDatabase));
        renderFeeds();
        renderHeatmap();

        feedInputText.value = '';
        if (feedMediaUrlInput) feedMediaUrlInput.value = '';
        if (feedMediaInputWrapper) feedMediaInputWrapper.style.display = 'none';
        const feedPreview = document.getElementById('feed-media-preview');
        const feedPreviewImg = document.getElementById('feed-media-preview-img');
        if (feedPreview) feedPreview.style.display = 'none';
        if (feedPreviewImg) feedPreviewImg.removeAttribute('src');

        btnSendFeed.disabled = false;
        btnSendFeed.innerText = '发送 🚀';

        // Sync with Cloudflare Worker API
        try {
            const apiRes = await apiRequest('/api/feeds', {
                method: 'POST',
                body: JSON.stringify(newFeed)
            });
            if (apiRes && apiRes.id) {
                const idx = state.feedsDatabase.findIndex(f => f.id === newFeed.id);
                if (idx !== -1) {
                    state.feedsDatabase[idx] = apiRes;
                } else {
                    state.feedsDatabase.unshift(apiRes);
                }
                saveFeedsDatabase();
                renderFeeds();
            }
        } catch (err) {
            console.warn('Silent feed sync failed:', err);
        }
    }

    if (btnSendFeed) {
        btnSendFeed.addEventListener('click', sendFeed);
    }
    if (feedInputText) {
        feedInputText.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                sendFeed();
            }
        });
    }

    window.deleteFeed = function(id) {
        if (!confirm('确定要删除这条随手记吗？')) return;
        addDeletedId(id);
        state.feedsDatabase = state.feedsDatabase.filter(f => String(f.id) !== String(id));
        localStorage.setItem(getLocalKey('gardenFeeds'), JSON.stringify(state.feedsDatabase));
        renderFeeds();
        renderHeatmap();
        apiRequest(`/api/feeds/${id}`, { method: 'DELETE' }).catch(() => {});
    };

    window.previewImage = function(src) {
        if (!src) return;
        const img = document.getElementById('image-preview-img');
        const modal = document.getElementById('image-preview-modal');
        if (img && modal) {
            img.src = src;
            modal.classList.add('show');
        }
    };

    // 3. Render Heatmap (思考与记忆轨迹热力图)
    function renderHeatmap() {
        const grid = document.getElementById('heatmap-grid');
        if (!grid) return;

        // Build date counts map for last 365 days
        const dateMap = {};
        const toLocalIsoDate = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };
        const toIsoDateKey = (value) => {
            if (!value) return '';
            const s = String(value).trim();
            const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
            if (iso) return iso[1];
            const cn = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
            if (cn) {
                return `${cn[1]}-${String(cn[2]).padStart(2, '0')}-${String(cn[3]).padStart(2, '0')}`;
            }
            const t = Date.parse(s.includes('T') || s.includes('-') ? s : s.replace(' ', 'T'));
            if (Number.isFinite(t)) return toLocalIsoDate(new Date(t));
            return '';
        };
        const addCount = (dateStr) => {
            const key = toIsoDateKey(dateStr);
            if (!key) return;
            dateMap[key] = (dateMap[key] || 0) + 1;
        };

        (state.database || []).forEach(w => addCount(w.created_at || w.updated_at || w.date));
        (state.notesDatabase || []).forEach(n => addCount(n.created_at || n.updated_at || n.date));
        (state.bookmarksDatabase || []).forEach(b => addCount(b.created_at || b.updated_at));
        (state.feedsDatabase || []).forEach(f => addCount(f.created_at || f.updated_at));

        // Generate columns (52 weeks x 7 days)
        const today = new Date();
        let colsHtml = '';

        for (let w = 51; w >= 0; w--) {
            let cellsHtml = '';
            for (let d = 0; d < 7; d++) {
                const dayOffset = (w * 7) + (6 - d);
                const cellDate = new Date(today);
                cellDate.setDate(today.getDate() - dayOffset);
                const dateKey = toLocalIsoDate(cellDate);
                const count = dateMap[dateKey] || 0;

                let levelClass = '';
                if (count >= 5) levelClass = 'level-4';
                else if (count >= 3) levelClass = 'level-3';
                else if (count >= 2) levelClass = 'level-2';
                else if (count >= 1) levelClass = 'level-1';

                cellsHtml += `<div class="heatmap-cell ${levelClass}" title="${dateKey}: ${count} 次记录"></div>`;
            }
            colsHtml += `<div class="heatmap-col">${cellsHtml}</div>`;
        }

        grid.innerHTML = colsHtml;
        grid.scrollLeft = grid.scrollWidth;
    }

    // 4. Render Echo Cards & Generator
    function renderEchoCards() {
        const container = document.getElementById('echo-cards-container');
        if (!container) return;

        if (!state.echoCardsDatabase || state.echoCardsDatabase.length === 0) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = state.echoCardsDatabase.map(card => {
            let feedLinksHtml = '';
            try {
                // Removed feed links logic
            } catch (e) {}

            return `
                <div class="echo-card" id="echo-card-${card.id}">
                    <button class="echo-card-delete" onclick="deleteEchoCard(${card.id})" title="删除卡片">×</button>
                    <div class="echo-card-badge">✨ AI 记忆回响 · ${escapeHtml(card.topic || '周记串联')}</div>
                    <div class="echo-card-title">${escapeHtml(card.title)}</div>
                    <div class="echo-card-summary">${escapeHtml(card.summary)}</div>
                    ${feedLinksHtml}
                </div>
            `;
        }).join('');
    }

    window.jumpToFeed = function(feedId) {
        jumpToElement('feeds', `[data-feed-id="${feedId}"]`);
    };

    window.deleteEchoCard = function(id) {
        if (!confirm('确定要删除这张 AI 回响卡片吗？')) return;
        state.echoCardsDatabase = state.echoCardsDatabase.filter(c => String(c.id) !== String(id));
        localStorage.setItem(getLocalKey('gardenEchoCards'), JSON.stringify(state.echoCardsDatabase));
        renderEchoCards();
        apiRequest('/api/echo/cards/' + id, { method: 'DELETE' }).catch(() => {});
    };

    function getLocalAiReply(question) {
        const allMemory = [];
        (state.feedsDatabase || []).forEach(f => allMemory.push(`[随手记 ${f.created_at || ''}] ${f.content}`));
        (state.notesDatabase || []).forEach(n => allMemory.push(`[备忘录 ${n.date || ''}] ${n.title}: ${n.content || ''}`));
        (state.database || []).forEach(w => allMemory.push(`[周记 ${w.date || ''}] ${w.title}: ${w.summary || ''}`));
        (state.bookmarksDatabase || []).forEach(b => allMemory.push(`[书签] ${b.title}: ${b.desc || b.description || ''} (${b.url || ''})`));

        if (allMemory.length === 0) {
            return `我在您的记忆花园里还没有找到记录。试试先在“随手记”里记录一些想法吧！`;
        }

        const keywords = question.replace(/[？?！!，,。.\s]/g, '').split('').filter(c => c);
        const matches = allMemory.filter(item => {
            return keywords.some(kw => item.toLowerCase().includes(kw.toLowerCase()));
        });

        if (matches.length > 0) {
            return `针对您的提问 “${question}”，我在您的记忆库中检索到了以下相关切片：\n\n` +
                matches.slice(0, 5).map(m => `• ${m}`).join('\n') +
                `\n\n💡 提示：持续添加随手记，我会帮您记住更多细节！`;
        } else {
            return `针对您的提问 “${question}”，未找到相关精确词汇，为您找到最近的记忆切片：\n\n` +
                allMemory.slice(0, 4).map(m => `• ${m}`).join('\n');
        }
    }

    const btnTriggerEchoCard = document.getElementById('btn-trigger-echo-card');
    if (btnTriggerEchoCard) {
        btnTriggerEchoCard.addEventListener('click', async () => {
            btnTriggerEchoCard.disabled = true;
            btnTriggerEchoCard.innerText = 'AI 生成中...';
            try {
                const newCard = await apiRequest('/api/echo/generate', { method: 'POST', timeout: 60000 });
                if (newCard && newCard.title) {
                    state.echoCardsDatabase.unshift(newCard);
                    localStorage.setItem(getLocalKey('gardenEchoCards'), JSON.stringify(state.echoCardsDatabase));
                    renderEchoCards();
                    actions.switchView('feeds');
                    setSyncStatus('回响卡片已生成', 'ok', 2500);
                    return;
                }
                throw new Error('生成结果为空');
            } catch (err) {
                const msg = (err && err.message) ? err.message : '生成失败';
                if (/暂无足够|随手记/.test(msg)) {
                    alert(msg);
                } else {
                    alert('AI 回响生成失败：' + msg + '\n请确认已登录且 LLM 密钥可用后重试。');
                }
            } finally {
                btnTriggerEchoCard.disabled = false;
                btnTriggerEchoCard.innerText = '✨ 生成 AI 回响卡片';
            }
        });
    }

    // 5. AI Memory Chat Modal Logic (🤖 AI 记忆回响助手)
    const aiChatModal = document.getElementById('ai-chat-modal');
    const btnOpenAiChat = document.getElementById('btn-open-ai-chat');
    const btnCloseAiChat = document.getElementById('btn-close-ai-chat');
    const btnSendAiChat = document.getElementById('btn-send-ai-chat');
    const aiChatInput = document.getElementById('ai-chat-input');
    const aiChatBody = document.getElementById('ai-chat-body');

    if (btnOpenAiChat && aiChatModal) {
        btnOpenAiChat.addEventListener('click', () => {
            aiChatModal.classList.add('show');
            if (!ui.aiModalInHistory) {
                history.pushState({ view: 'ai' }, '', '#/ai');
                ui.aiModalInHistory = true;
            }
            if (aiChatInput) aiChatInput.focus();
        });
    }
    if (btnCloseAiChat && aiChatModal) {
        btnCloseAiChat.addEventListener('click', () => {
            if (ui.aiModalInHistory && actions.parseHashRoute().view === 'ai') {
                history.back();
            } else {
                aiChatModal.classList.remove('show');
                ui.aiModalInHistory = false;
            }
        });
    }

    window.closeAiChatModal = function() {
        if (ui.aiModalInHistory && actions.parseHashRoute().view === 'ai') {
            history.back();
            return;
        }
        if (aiChatModal) aiChatModal.classList.remove('show');
        ui.aiModalInHistory = false;
    };

    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (aiChatModal && aiChatModal.classList.contains('show')) {
            window.closeAiChatModal();
            return;
        }
        const imgModal = document.getElementById('image-preview-modal');
        if (imgModal && imgModal.classList.contains('show')) {
            imgModal.classList.remove('show');
        }
    });

    // ==========================================
    // 6.5 全局搜索 (Cmd/Ctrl + K) & 页面跳转定位
    // ==========================================
    const globalSearchModal = document.getElementById('global-search-modal');
    const globalSearchInput = document.getElementById('global-search-input');
    const globalSearchResults = document.getElementById('global-search-results');
    const btnOpenGlobalSearch = document.getElementById('btn-open-global-search');
    const btnCloseGlobalSearch = document.getElementById('btn-close-global-search');

    function openGlobalSearch() {
        if (!globalSearchModal) return;
        globalSearchModal.classList.add('show');
        if (globalSearchInput) {
            globalSearchInput.value = '';
            globalSearchInput.focus();
            renderGlobalSearchResults('');
        }
    }

    function closeGlobalSearch() {
        if (!globalSearchModal) return;
        globalSearchModal.classList.remove('show');
    }

    if (btnOpenGlobalSearch) btnOpenGlobalSearch.addEventListener('click', openGlobalSearch);
    if (btnCloseGlobalSearch) btnCloseGlobalSearch.addEventListener('click', closeGlobalSearch);

    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            if (globalSearchModal && globalSearchModal.classList.contains('show')) closeGlobalSearch();
            else openGlobalSearch();
        } else if (e.key === 'Escape' && globalSearchModal && globalSearchModal.classList.contains('show')) {
            closeGlobalSearch();
        }
    });

    if (globalSearchInput) {
        globalSearchInput.addEventListener('input', (e) => {
            renderGlobalSearchResults(e.target.value.trim());
        });
    }

    function renderGlobalSearchResults(query) {
        if (!globalSearchResults) return;
        if (!query) {
            globalSearchResults.innerHTML = `<div class="global-search-empty">输入关键词，搜索您的数字花园所有切片记忆...</div>`;
            return;
        }

        const q = query.toLowerCase();
        const results = [];

        // 1. 周记
        (state.database || []).forEach(w => {
            if ((w.title || '').toLowerCase().includes(q) || (w.summary || '').toLowerCase().includes(q) || (w.content || '').toLowerCase().includes(q)) {
                results.push({
                    type: '周记',
                    view: 'home',
                    id: w.id,
                    title: w.title || '无标题周记',
                    snippet: w.summary || (w.content || '').slice(0, 80),
                    targetElSelector: `#weekly-card-${w.id}`
                });
            }
        });

        // 2. 随手记
        (state.feedsDatabase || []).forEach(f => {
            if ((f.content || '').toLowerCase().includes(q) || (f.summary || '').toLowerCase().includes(q)) {
                results.push({
                    type: '⚡ 随手记',
                    view: 'feeds',
                    id: f.id,
                    title: f.created_at || '随手记切片',
                    snippet: f.content,
                    targetElSelector: `[data-feed-id="${f.id}"]`
                });
            }
        });

        // 3. 笔记
        (state.notesDatabase || []).forEach(n => {
            if ((n.title || '').toLowerCase().includes(q) || (n.content || '').toLowerCase().includes(q)) {
                results.push({
                    type: '📝 笔记',
                    view: 'notes',
                    id: n.id,
                    title: n.title || '无标题笔记',
                    snippet: (n.content || '').slice(0, 80),
                    targetElSelector: `[data-note-id="${n.id}"]`
                });
            }
        });

        // 4. 收藏
        (state.bookmarksDatabase || []).forEach(b => {
            if ((b.title || '').toLowerCase().includes(q) || (b.desc || b.description || '').toLowerCase().includes(q) || (b.url || '').toLowerCase().includes(q)) {
                results.push({
                    type: '🔖 收藏',
                    view: 'bookmarks',
                    id: b.id,
                    title: b.title || '无标题收藏',
                    snippet: (b.desc || b.description || b.url || ''),
                    targetElSelector: `[data-bookmark-id="${b.id}"]`
                });
            }
        });

        // 5. AI 回响卡片
        (state.echoCardsDatabase || []).forEach(c => {
            if ((c.title || '').toLowerCase().includes(q) || (c.summary || '').toLowerCase().includes(q) || (c.topic || '').toLowerCase().includes(q)) {
                results.push({
                    type: '✨ AI 回响',
                    view: 'home',
                    id: c.id,
                    title: c.title || 'AI 回响卡片',
                    snippet: c.summary,
                    targetElSelector: `#echo-card-${c.id}`
                });
            }
        });

        // 6. 阅读批注
        (readerAnnotations || []).forEach(a => {
            if ((a.text || '').toLowerCase().includes(q)) {
                results.push({
                    type: '📚 阅读批注',
                    view: 'reader',
                    id: a.id,
                    title: a.bookTitle ? `《${a.bookTitle}》批注` : '阅读批注',
                    snippet: a.text,
                    targetElSelector: `[data-annotation-id="${a.id}"]`
                });
            }
        });

        if (results.length === 0) {
            globalSearchResults.innerHTML = `<div class="global-search-empty">未匹配到与 "${escapeHtml(query)}" 相关的切片</div>`;
            return;
        }

        globalSearchResults.innerHTML = results.slice(0, 15).map(item => `
            <div class="global-search-item" data-view="${item.view}" data-selector="${escapeHtml(item.targetElSelector || '')}">
                <div class="global-search-item-header">
                    <span class="global-search-title">${escapeHtml(item.title)}</span>
                    <span class="global-search-tag">${escapeHtml(item.type)}</span>
                </div>
                <div class="global-search-snippet">${escapeHtml(item.snippet)}</div>
            </div>
        `).join('');

        globalSearchResults.querySelectorAll('.global-search-item').forEach(el => {
            el.addEventListener('click', () => {
                const targetView = el.getAttribute('data-view');
                const selector = el.getAttribute('data-selector');
                closeGlobalSearch();
                jumpToElement(targetView, selector);
            });
        });
    }

    function jumpToElement(targetView, selector) {
        if (targetView) actions.switchView(targetView);
        if (!selector) return;
        setTimeout(() => {
            const el = document.querySelector(selector);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.remove('highlight-flash');
                void el.offsetWidth;
                el.classList.add('highlight-flash');
            }
        }, 150);
    }

    async function sendAiChatMessage() {
        if (!aiChatInput || !aiChatBody) return;
        const question = aiChatInput.value.trim();
        if (!question) return;

        // Append User Message
        const userMsgDiv = document.createElement('div');
        userMsgDiv.className = 'ai-msg ai-msg-user';
        userMsgDiv.innerHTML = `<div class="ai-msg-bubble">${escapeHtml(question)}</div>`;
        aiChatBody.appendChild(userMsgDiv);

        aiChatInput.value = '';
        aiChatBody.scrollTop = aiChatBody.scrollHeight;

        // Append Bot Typing Indicator
        const botMsgDiv = document.createElement('div');
        botMsgDiv.className = 'ai-msg ai-msg-bot';
        botMsgDiv.innerHTML = `<div class="ai-msg-bubble">🤖 思考中...</div>`;
        aiChatBody.appendChild(botMsgDiv);
        aiChatBody.scrollTop = aiChatBody.scrollHeight;

        const bubbleEl = botMsgDiv.querySelector('.ai-msg-bubble');

        try {
            const headers = { 'Content-Type': 'application/json' };
            if (state.authToken) headers['Authorization'] = `Bearer ${state.authToken}`;

            // 多轮对话：保存 user 输入
            const recentHistory = [...state.aiChatHistory];
            state.aiChatHistory.push({ role: 'user', content: question });

            const response = await fetchWithFallback('/api/ai/chat', {
                method: 'POST',
                headers,
                body: JSON.stringify({ question, stream: true, history: recentHistory })
            });

            if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let fullText = '';
                let isFirstChunk = true;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed) continue;
                        if (trimmed === 'data: [DONE]') break;
                        if (trimmed.startsWith('data: ')) {
                            try {
                                const payload = JSON.parse(trimmed.slice(6));
                                if (payload.error) {
                                    bubbleEl.innerHTML = '🤖 ' + escapeHtml(payload.error);
                                    break;
                                }
                                if (payload.delta) {
                                    if (isFirstChunk) {
                                        fullText = '';
                                        isFirstChunk = false;
                                    }
                                    fullText += payload.delta;
                                    bubbleEl.innerHTML = markdownToHtml(fullText);
                                    aiChatBody.scrollTop = aiChatBody.scrollHeight;
                                }
                            } catch (e) {}
                        }
                    }
                }
                if (fullText) {
                    state.aiChatHistory.push({ role: 'assistant', content: fullText });
                    return;
                }
            } else if (response.ok) {
                const res = await response.json();
                if (res && res.reply) {
                    bubbleEl.innerHTML = markdownToHtml(res.reply);
                    state.aiChatHistory.push({ role: 'assistant', content: res.reply });
                    aiChatBody.scrollTop = aiChatBody.scrollHeight;
                    return;
                }
            }
        } catch (err) {
            console.error('AI chat stream fetch error:', err);
        }

        // 本地规则检索兜底（DeepSeek 密钥已收敛到后端 Worker，前端不再直连）
        const localReply = getLocalAiReply(question);
        bubbleEl.innerHTML = markdownToHtml(localReply);
        state.aiChatHistory.push({ role: 'assistant', content: localReply });
        aiChatBody.scrollTop = aiChatBody.scrollHeight;
    }

    // 📅 AI 本周回顾：打开对话并展示回顾结果
    const btnWeeklyReview = document.getElementById('btn-weekly-review');
    if (btnWeeklyReview) {
        btnWeeklyReview.addEventListener('click', async () => {
            if (!aiChatModal || !aiChatBody) return;
            aiChatModal.classList.add('show');
            const botMsgDiv = document.createElement('div');
            botMsgDiv.className = 'ai-msg ai-msg-bot';
            botMsgDiv.innerHTML = `<div class="ai-msg-bubble">🤖 正在为你生成本周回顾...</div>`;
            aiChatBody.appendChild(botMsgDiv);
            aiChatBody.scrollTop = aiChatBody.scrollHeight;
            try {
                const res = await apiRequest('/api/ai/review', { method: 'POST', body: JSON.stringify({}) });
                botMsgDiv.querySelector('.ai-msg-bubble').innerHTML = (res && res.reply)
                    ? markdownToHtml(res.reply)
                    : '本周回顾生成失败，请稍后再试。';
            } catch (err) {
                botMsgDiv.querySelector('.ai-msg-bubble').innerHTML = '本周回顾生成失败：' + escapeHtml(err.message);
            }
            aiChatBody.scrollTop = aiChatBody.scrollHeight;
        });
    }

    if (btnSendAiChat) btnSendAiChat.addEventListener('click', sendAiChatMessage);
    if (aiChatInput) {
        aiChatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendAiChatMessage();
            }
        });
    }

    // 📱 移动端软键盘唤起检测：打字时自动隐藏底部导航栏与悬浮加号按钮
    document.addEventListener('focusin', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
            document.body.classList.add('keyboard-open');
        }
    });

    document.addEventListener('focusout', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
            setTimeout(() => {
                const active = document.activeElement;
                if (!active || (active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA')) {
                    document.body.classList.remove('keyboard-open');
                }
            }, 100);
        }
    });

    initWeeklies();
    initNotes();
    initBookmarks();

    // Remaining views still live in app.js — expose for router actions.switchView
    actions.renderFeeds = renderFeeds;
    actions.renderHeatmap = renderHeatmap;
    actions.renderBookshelf = typeof renderBookshelf === 'function' ? renderBookshelf : null;
    actions.renderEchoCards = renderEchoCards;

    initRouter();

    bindApiHooks({
        onRefresh(kind, opts = {}) {
            if (kind === 'all') {
                actions.renderCards?.();
                actions.renderNotes?.();
                actions.renderBookmarks?.();
                actions.renderFeeds?.();
                actions.renderEchoCards?.();
                actions.renderHeatmap?.();
                return;
            }
            if (kind === 'weeklies') actions.renderCards?.(opts.filter || 'all');
            if (kind === 'notes') actions.renderNotes?.();
            if (kind === 'bookmarks') actions.renderBookmarks?.();
            if (kind === 'feeds') actions.renderFeeds?.();
            if (kind === 'echo') actions.renderEchoCards?.();
            if (kind === 'heatmap') actions.renderHeatmap?.();
        }
    });

    initAuthUI();

    // 1. 页面初始化：首先校验登录状态（如果已登录自动隐藏登录遮罩层，免去重复输入密码）
    checkAuth();

    if (state.authToken) {
        setTimeout(registerPushNotification, 2000);
    }
    loadLocalData();
    if (state.authToken) {
        syncFromApi();
    }

    // 4. 后台检测合并游客数据
    checkAndMergeGuestData();

    // 启动后台无感自动同步引擎
    startAutoSyncEngine();

    // 恢复 URL hash（刷新后回到对应视图）；无 hash 时写入首页，便于系统返回键工作
    if (location.hash && location.hash !== '#' && location.hash !== '#/home') {
        actions.applyRoute(actions.parseHashRoute());
    } else {
        history.replaceState({ view: ui.currentActiveNavView || 'home' }, '', `#/${ui.currentActiveNavView || 'home'}`);
    }

    // PWA：注册与自动感知更新 Service Worker
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js').then(reg => {
                reg.onupdatefound = () => {
                    const installingWorker = reg.installing;
                    if (installingWorker) {
                        installingWorker.onstatechange = () => {
                            if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                showToast('手机 PWA 已感知到最新版本，正在加载...', 'success');
                                setTimeout(() => window.location.reload(), 1200);
                            }
                        };
                    }
                };
            }).catch(() => {});
        });
    }
});




