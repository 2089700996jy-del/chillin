document.addEventListener('DOMContentLoaded', () => {

    // ==========================================
    // 1. 数据持久化与认证逻辑
    // ==========================================
    let API_BASE = (typeof CHILLIN_API_URL !== 'undefined') ? CHILLIN_API_URL : '';
    // 如果是本地 file 协议或者 localhost 调试，且 API_BASE 为空，自动指回云端 API 地址
    if (!API_BASE && (window.location.protocol === 'file:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
        API_BASE = 'https://chillin-api.2089700996jy.workers.dev';
    }
    const API_KEY = (typeof CHILLIN_API_KEY !== 'undefined') ? CHILLIN_API_KEY : '';

    let authToken = localStorage.getItem('chillin_token') || '';
    let authUser = JSON.parse(localStorage.getItem('chillin_user') || 'null');

    // DOM Elements for Auth
    const authOverlay = document.getElementById('auth-overlay');
    const authForm = document.getElementById('auth-form');
    const authErrorMsg = document.getElementById('auth-error-msg');
    const btnAuthSwitch = document.getElementById('btn-auth-switch');
    const authSwitchText = document.getElementById('auth-switch-text');
    const btnLogout = document.getElementById('btn-logout');
    const navUsername = document.getElementById('nav-username');
    const btnForceUpload = document.getElementById('btn-force-upload');

    let isRegisterMode = false;

    // 显示/隐藏认证覆盖层
    const checkAuth = () => {
        if (!authToken) {
            authOverlay.classList.remove('hidden');
            if (btnForceUpload) btnForceUpload.style.display = 'none';
            return false;
        }
        authOverlay.classList.add('hidden');
        if (authUser) navUsername.innerText = `Hi, ${authUser.username}`;
        if (btnForceUpload) btnForceUpload.style.display = 'inline-block';
        return true;
    };

    const logout = () => {
        if (authToken) {
            apiRequest('/api/auth/logout', { method: 'POST' }).catch(() => {});
        }
        authToken = '';
        authUser = null;
        localStorage.removeItem('chillin_token');
        localStorage.removeItem('chillin_user');
        checkAuth();
    };

    btnLogout.addEventListener('click', logout);

    btnAuthSwitch.addEventListener('click', () => {
        isRegisterMode = !isRegisterMode;
        if (isRegisterMode) {
            document.querySelector('.auth-btn').innerText = '注册并进入';
            authSwitchText.innerText = '已有账号？';
            btnAuthSwitch.innerText = '直接登录';
        } else {
            document.querySelector('.auth-btn').innerText = '登录';
            authSwitchText.innerText = '还没有账号？';
            btnAuthSwitch.innerText = '立即注册';
        }
        authErrorMsg.style.display = 'none';
    });

    authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('auth-username').value.trim();
        const password = document.getElementById('auth-password').value.trim();
        authErrorMsg.style.display = 'none';

        try {
            const endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
            const res = await fetch(`${API_BASE}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Authentication failed');

            authToken = data.token;
            authUser = { id: data.userId, username: data.username };
            localStorage.setItem('chillin_token', authToken);
            localStorage.setItem('chillin_user', JSON.stringify(authUser));
            
            checkAuth();
            checkAndMergeGuestData().then(() => {
                loadLocalData(); // Reload local cache for new user
                syncFromApi();   // Fetch new API data
            });
        } catch (err) {
            authErrorMsg.innerText = err.message;
            authErrorMsg.style.display = 'block';
        }
    });

    const apiRequest = async (path, options = {}) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
            const headers = {
                'Content-Type': 'application/json',
                'X-API-Key': API_KEY,
                ...(options.headers || {})
            };
            if (authToken) {
                headers['Authorization'] = `Bearer ${authToken}`;
            }

            const res = await fetch(`${API_BASE}${path}`, {
                ...options,
                signal: controller.signal,
                headers
            });
            
            if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/register') {
                logout();
                throw new Error('Unauthorized or token expired');
            }
            if (!res.ok) throw new Error(`API error: ${res.status}`);
            return res.json();
        } finally {
            clearTimeout(timeout);
        }
    };

    // 默认兜底数据
    const DEFAULT_WEEKLY = [{
        id: 1, category: "🌸", title: "2023-W42: 记忆切片",
        summary: "在这个节奏极快的秋周里，抓住了一些微小的确幸：黑塞、坂本龙一、和一碗完美的意面。",
        date: "2023年10月22日",
        cover: "https://images.unsplash.com/photo-1505909182942-e2f09aee3e89?q=80&w=800&auto=format&fit=crop",
        weeklyData: {
            music: { title: "Merry Christmas Mr. Lawrence", artist: "坂本龙一", lyric: "无需歌词，唯有宁静跨越时间。" },
            media: [{ icon: "🎬", title: "《奥本海默》", desc: "在 IMAX 厅感受了极其震撼的音效与人类群星闪耀的矛盾。" }],
            life: { image: "https://images.unsplash.com/photo-1473093295043-cdd812d0e601?q=80&w=600&auto=format&fit=crop", caption: "周五晚上的完美意面 🍝" },
            podcast: "在《Huberman Lab》里学到了，早晨醒来后不要立刻看手机，而是先去接触自然光 10 分钟，能够完美重置昼夜节律。",
            work: { title: "Next.js App Router 迁移", desc: "本周踩完了 Server Actions 的坑。结论：将复杂的数据验证逻辑全部移到单独的 API 路由。" }
        },
        content: "<p>时间的流逝在开始工作后变得惊人的快。周一到周五仿佛被压缩成了一天。所以决定用这样的方式，把每周值得记住的时刻切片保存下来。</p>"
    }];
    const DEFAULT_NOTES = [
        { id: 101, title: "下周购物清单", content: "1. 咖啡豆\n2. 全脂牛奶\n3. 极简风马克杯\n4. 绿植（龟背竹）", date: "2023年10月23日" },
        { id: 102, title: "零碎灵感", content: "也许可以尝试给博客加上深色模式？\n颜色方案可以参考 GitHub 的 Dark Dimmed。", date: "2023年10月24日" }
    ];
    const DEFAULT_BOOKMARKS = [
        { id: 201, type: "🛠️ 工具", title: "Notion", url: "https://notion.so", desc: "极致的块状编辑器，灵感的发源地。" },
        { id: 202, type: "🌐 网站", title: "Vercel", url: "https://vercel.com", desc: "前端项目一键部署的神仙平台。" },
        { id: 203, type: "🎬 电影", title: "豆瓣电影", url: "https://movie.douban.com", desc: "找冷门好片的唯一去处。" }
    ];

    // 初始化：优先从 API 拉数据，失败则用本地缓存，再失败用默认数据
    let database, notesDatabase, bookmarksDatabase;

    // 缓存前缀函数 (按用户隔离)
    const getLocalKey = (key) => authUser ? `${authUser.id}_${key}` : `default_${key}`;

    // 立即从本地缓存加载，保证页面秒开
    const loadLocalData = () => {
        if (!checkAuth()) return; // 未登录时不加载数据
        database = JSON.parse(localStorage.getItem(getLocalKey('gardenData'))) || DEFAULT_WEEKLY;
        notesDatabase = JSON.parse(localStorage.getItem(getLocalKey('gardenNotes'))) || DEFAULT_NOTES;
        bookmarksDatabase = JSON.parse(localStorage.getItem(getLocalKey('gardenBookmarks'))) || DEFAULT_BOOKMARKS;
        renderCards();
        renderNotes();
        renderBookmarks();
    };

    // 后台尝试从 API 同步最新数据，成功后自动刷新
    const syncFromApi = async () => {
        if (!authToken) return;
        // 周记
        try {
            const apiData = await apiRequest('/api/weeklies');
            if (apiData) {
                database = apiData;
                localStorage.setItem(getLocalKey('gardenData'), JSON.stringify(database));
                renderCards(document.querySelector('.filter-btn.active')?.dataset.filter || 'all');
            }
        } catch {}
        // 笔记
        try {
            const apiData = await apiRequest('/api/notes');
            if (apiData) {
                notesDatabase = apiData;
                localStorage.setItem(getLocalKey('gardenNotes'), JSON.stringify(notesDatabase));
                renderNotes();
            }
        } catch {}
        // 收藏
        try {
            const apiData = await apiRequest('/api/bookmarks');
            if (apiData) {
                bookmarksDatabase = apiData;
                localStorage.setItem(getLocalKey('gardenBookmarks'), JSON.stringify(bookmarksDatabase));
                renderBookmarks();
            }
        } catch {}
    };

    const saveDatabase = () => localStorage.setItem(getLocalKey('gardenData'), JSON.stringify(database));
    const saveNotesDatabase = () => localStorage.setItem(getLocalKey('gardenNotes'), JSON.stringify(notesDatabase));
    const saveBookmarksDatabase = () => localStorage.setItem(getLocalKey('gardenBookmarks'), JSON.stringify(bookmarksDatabase));

    // API 同步辅助函数（静默失败，不阻塞 UI）
    const apiSyncWeekly = (item, method) => {
        const bm = method === 'DELETE' ? { method: 'DELETE' } : { method, body: JSON.stringify(item) };
        const id = method === 'POST' ? '' : `/${item.id}`;
        apiRequest(`/api/weeklies${id}`, bm).catch(() => {});
    };
    const apiSyncNote = (item, method) => {
        const bm = method === 'DELETE' ? { method: 'DELETE' } : { method, body: JSON.stringify(item) };
        const id = method === 'POST' ? '' : `/${item.id}`;
        apiRequest(`/api/notes${id}`, bm).catch(() => {});
    };
    const apiSyncBookmark = (item, method) => {
        const bm = method === 'DELETE' ? { method: 'DELETE' } : { method, body: JSON.stringify(item) };
        const id = method === 'POST' ? '' : `/${item.id}`;
        apiRequest(`/api/bookmarks${id}`, bm).catch(() => {});
    };

    let currentArticleId = null;
    let currentNoteId = null;
    let currentActiveNavView = 'home'; 

    // ==========================================
    // 2. DOM 元素获取
    // ==========================================
    const views = document.querySelectorAll('.view-section');
    const navItems = document.querySelectorAll('.nav-item');
    const btnBack = document.getElementById('btn-back');
    const navMenu = document.getElementById('nav-menu');
    const fabBtn = document.getElementById('btn-create-new');

    // Home / Weekly
    const galleryContainer = document.getElementById('gallery-container');
    const filterBtns = document.querySelectorAll('.filter-btn');
    const articleCategory = document.getElementById('article-category');
    const articleDate = document.getElementById('article-date');
    const articleTitle = document.getElementById('article-title');
    const articleCoverContainer = document.getElementById('article-cover-container');
    const articleBody = document.getElementById('article-body');
    const btnEditArticle = document.getElementById('btn-edit-article');
    const btnDeleteArticle = document.getElementById('btn-delete-article');
    const editorForm = document.getElementById('editor-form');
    const btnCancelEdit = document.getElementById('btn-cancel-edit');
    const editorPageTitle = document.getElementById('editor-page-title');

    // Notes
    const notesListContainer = document.getElementById('notes-list-container');
    const editNoteTitle = document.getElementById('edit-note-title');
    const editNoteContent = document.getElementById('edit-note-content');
    const editNoteId = document.getElementById('edit-note-id');
    const btnSaveNote = document.getElementById('btn-save-note');
    const btnDeleteNote = document.getElementById('btn-delete-note');
    const noteEditorDate = document.getElementById('note-editor-date');

    // Bookmarks
    const bookmarkListContainer = document.getElementById('bookmark-list-container');
    const bookmarkEditorForm = document.getElementById('bookmark-editor-form');
    const btnCancelBookmark = document.getElementById('btn-cancel-bookmark');
    const editBookmarkId = document.getElementById('edit-bookmark-id');
    const editBookmarkType = document.getElementById('edit-bookmark-type');
    const editBookmarkTitle = document.getElementById('edit-bookmark-title');
    const editBookmarkUrl = document.getElementById('edit-bookmark-url');
    const editBookmarkDesc = document.getElementById('edit-bookmark-desc');


    const escapeHtml = (str) => {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    };

    const autoResizeTextarea = (el) => {
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
    };
    editNoteContent.addEventListener('input', () => autoResizeTextarea(editNoteContent));


    // ==========================================
    // 3. 视图切换逻辑
    // ==========================================
    const switchView = (targetViewId) => {
        views.forEach(view => view.classList.remove('active'));
        document.getElementById(`view-${targetViewId}`).classList.add('active');
        
        if (targetViewId === 'home' || targetViewId === 'notes' || targetViewId === 'bookmarks') {
            currentActiveNavView = targetViewId;
            navItems.forEach(item => item.classList.remove('active'));
            const activeNav = document.querySelector(`.nav-item[data-view="${targetViewId}"]`);
            if(activeNav) activeNav.classList.add('active');
        }

        if (targetViewId === 'article' || targetViewId === 'editor' || targetViewId === 'note-editor' || targetViewId === 'bookmark-editor') {
            navMenu.style.display = 'none';
            btnBack.style.display = 'block';
            fabBtn.classList.add('hidden');
        } else {
            navMenu.style.display = 'flex';
            btnBack.style.display = 'none';
            fabBtn.classList.remove('hidden');
        }
        window.scrollTo(0, 0); 
    };

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const view = e.target.dataset.view;
            if(view) switchView(view);
        });
    });

    btnBack.addEventListener('click', () => {
        switchView(currentActiveNavView);
        currentArticleId = null;
        currentNoteId = null;
    });

    fabBtn.addEventListener('click', () => {
        if (currentActiveNavView === 'home') openWeeklyEditor(null);
        else if (currentActiveNavView === 'notes') openNoteEditor(null);
        else if (currentActiveNavView === 'bookmarks') openBookmarkEditor();
    });

    const getChineseDate = () => {
        const date = new Date();
        return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    };

    // ==========================================
    // 4. 周记画廊逻辑 (Weekly Recaps)
    // ==========================================
    const renderCards = (filter = "all") => {
        galleryContainer.innerHTML = '';
        const sortedDB = [...database].sort((a, b) => b.id - a.id);
        sortedDB.forEach(item => {
            if (filter !== "all" && item.category !== filter) return;
            const card = document.createElement('div');
            card.className = "notion-collection-card";
            card.dataset.id = item.id;
            let coverHtml = item.cover ? `<img src="${escapeHtml(item.cover)}" alt="Cover" class="notion-collection-card__cover">` : '';
            card.innerHTML = `${coverHtml}<div class="notion-collection-card__content"><div class="card-property-category">${escapeHtml(item.category)}</div><div class="card-title">${escapeHtml(item.title)}</div><div class="card-summary">${escapeHtml(item.summary)}</div><div class="card-date">${escapeHtml(item.date)}</div></div>`;
            card.addEventListener('click', () => openArticle(item));
            galleryContainer.appendChild(card);
        });
    };

    const generateWeeklyWidgetsHtml = (data) => {
        if (!data) return '';
        let html = '';
        if (data.music && data.music.title) html += `<h2>🎵 本周循环</h2><div class="widget-music"><div class="widget-music-disk"></div><div class="widget-music-info"><div class="widget-music-title">${escapeHtml(data.music.title)}</div><div class="widget-music-artist">${escapeHtml(data.music.artist)}</div>${data.music.lyric ? `<div class="widget-music-lyric">"${escapeHtml(data.music.lyric)}"</div>` : ''}</div></div>`;
        if (data.media && data.media.length > 0 && data.media[0].title) html += `<h2>🎬 影音书影</h2><div class="widget-media">${data.media.map(m => `<div class="widget-media-item"><div class="widget-media-icon">${escapeHtml(m.icon || '🎬')}</div><div class="widget-media-content"><div class="widget-media-title">${escapeHtml(m.title)}</div><div class="widget-media-desc">${escapeHtml(m.desc)}</div></div></div>`).join('')}</div>`;
        if (data.life && data.life.image) html += `<h2>🍳 烟火日常</h2><div class="widget-polaroid"><img src="${escapeHtml(data.life.image)}" alt="Life Snapshot"><div class="widget-polaroid-caption">${escapeHtml(data.life.caption)}</div></div>`;
        if (data.podcast) html += `<h2>🎙️ 播客新知</h2><div class="widget-callout"><div class="widget-callout-icon">💡</div><div class="widget-callout-text">${escapeHtml(data.podcast)}</div></div>`;
        if (data.work && data.work.title) html += `<h2>💻 工作切片</h2><div class="widget-work"><div class="widget-work-title">${escapeHtml(data.work.title)}</div><div class="widget-work-desc">${escapeHtml(data.work.desc)}</div></div>`;
        return html;
    };

    const openArticle = (item) => {
        currentArticleId = item.id;
        articleCategory.innerText = item.category;
        articleDate.innerText = item.date;
        articleTitle.innerText = item.title;
        let finalHtml = item.content || '';
        if (item.weeklyData) finalHtml += generateWeeklyWidgetsHtml(item.weeklyData);
        articleBody.innerHTML = finalHtml;
        articleCoverContainer.innerHTML = item.cover ? `<img src="${escapeHtml(item.cover)}" alt="Cover">` : '';
        switchView('article');
    };

    const openWeeklyEditor = (editId = null) => {
        editorForm.reset();
        if (editId) {
            editorPageTitle.innerText = "编辑记忆";
            const item = database.find(d => d.id === editId);
            if (item) {
                document.getElementById('edit-id').value = item.id;
                document.getElementById('edit-category').value = item.category;
                document.getElementById('edit-title').value = item.title;
                document.getElementById('edit-summary').value = item.summary;
                document.getElementById('edit-cover').value = item.cover || '';
                document.getElementById('edit-content').value = item.content || '';
                if (item.weeklyData) {
                    if(item.weeklyData.music) { document.getElementById('edit-music-title').value = item.weeklyData.music.title || ''; document.getElementById('edit-music-artist').value = item.weeklyData.music.artist || ''; document.getElementById('edit-music-lyric').value = item.weeklyData.music.lyric || ''; }
                    if(item.weeklyData.media && item.weeklyData.media.length > 0) { document.getElementById('edit-media-icon').value = item.weeklyData.media[0].icon || '🎬'; document.getElementById('edit-media-title').value = item.weeklyData.media[0].title || ''; document.getElementById('edit-media-desc').value = item.weeklyData.media[0].desc || ''; }
                    if(item.weeklyData.life) { document.getElementById('edit-life-image').value = item.weeklyData.life.image || ''; document.getElementById('edit-life-caption').value = item.weeklyData.life.caption || ''; }
                    if(item.weeklyData.podcast) document.getElementById('edit-podcast').value = item.weeklyData.podcast || '';
                    if(item.weeklyData.work) { document.getElementById('edit-work-title').value = item.weeklyData.work.title || ''; document.getElementById('edit-work-desc').value = item.weeklyData.work.desc || ''; }
                }
            }
        } else {
            editorPageTitle.innerText = "新增记忆";
            document.getElementById('edit-id').value = '';
        }
        switchView('editor');
    };

    btnEditArticle.addEventListener('click', () => openWeeklyEditor(currentArticleId));
    btnCancelEdit.addEventListener('click', () => {
        const isNew = !document.getElementById('edit-id').value;
        switchView(isNew ? 'home' : 'article');
    });

    editorForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const idStr = document.getElementById('edit-id').value;
        const isEdit = !!idStr;
        const newData = {
            id: isEdit ? parseInt(idStr) : Date.now(), category: document.getElementById('edit-category').value, title: document.getElementById('edit-title').value, summary: document.getElementById('edit-summary').value, cover: document.getElementById('edit-cover').value, content: document.getElementById('edit-content').value,
            date: isEdit ? database.find(d => d.id === parseInt(idStr)).date : getChineseDate(),
            weeklyData: {
                music: { title: document.getElementById('edit-music-title').value, artist: document.getElementById('edit-music-artist').value, lyric: document.getElementById('edit-music-lyric').value },
                media: [{ icon: document.getElementById('edit-media-icon').value, title: document.getElementById('edit-media-title').value, desc: document.getElementById('edit-media-desc').value }],
                life: { image: document.getElementById('edit-life-image').value, caption: document.getElementById('edit-life-caption').value },
                podcast: document.getElementById('edit-podcast').value,
                work: { title: document.getElementById('edit-work-title').value, desc: document.getElementById('edit-work-desc').value }
            }
        };
        if(!newData.weeklyData.music.title) delete newData.weeklyData.music; if(!newData.weeklyData.media[0].title) delete newData.weeklyData.media; if(!newData.weeklyData.life.image) delete newData.weeklyData.life; if(!newData.weeklyData.podcast) delete newData.weeklyData.podcast; if(!newData.weeklyData.work.title) delete newData.weeklyData.work; if(Object.keys(newData.weeklyData).length === 0) delete newData.weeklyData;
        if (isEdit) { const index = database.findIndex(d => d.id === parseInt(idStr)); if(index !== -1) database[index] = newData; } else { database.push(newData); }
        saveDatabase(); apiSyncWeekly(newData, isEdit ? 'PUT' : 'POST'); renderCards(document.querySelector('.filter-btn.active').dataset.filter); switchView('home');
    });

    btnDeleteArticle.addEventListener('click', () => {
        if(confirm("确定要永久删除这篇记忆吗？")) { const deletedId = currentArticleId; database = database.filter(d => d.id !== currentArticleId); saveDatabase(); apiSyncWeekly({id: deletedId}, 'DELETE'); renderCards(); switchView('home'); }
    });

    filterBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            filterBtns.forEach(b => b.classList.remove('active')); e.target.classList.add('active'); renderCards(e.target.dataset.filter);
        });
    });

    // ==========================================
    // 5. 极简备忘录逻辑 (Notes)
    // ==========================================
    const renderNotes = () => {
        notesListContainer.innerHTML = '';
        const sortedNotes = [...notesDatabase].sort((a, b) => b.id - a.id);
        sortedNotes.forEach(note => {
            const el = document.createElement('div');
            el.className = 'note-item';
            const previewText = note.content ? escapeHtml(note.content.substring(0, 30)).replace(/\n/g, ' ') + '...' : '无正文内容';
            el.innerHTML = `<div class="note-item-content"><div class="note-item-title">${escapeHtml(note.title || '无标题笔记')}</div><div class="note-item-preview">${previewText}</div></div><div class="note-item-date">${escapeHtml(note.date)}</div>`;
            el.addEventListener('click', () => openNoteEditor(note.id));
            notesListContainer.appendChild(el);
        });
    };

    const openNoteEditor = (noteId = null) => {
        if (noteId) {
            currentNoteId = noteId; const note = notesDatabase.find(n => n.id === noteId);
            if (note) { editNoteId.value = note.id; editNoteTitle.value = note.title; editNoteContent.value = note.content; noteEditorDate.innerText = note.date; btnDeleteNote.style.display = 'inline-block'; }
        } else {
            currentNoteId = null; editNoteId.value = ''; editNoteTitle.value = ''; editNoteContent.value = ''; noteEditorDate.innerText = getChineseDate(); btnDeleteNote.style.display = 'none';
        }
        switchView('note-editor');
        autoResizeTextarea(editNoteContent);
    };

    btnSaveNote.addEventListener('click', () => {
        const idStr = editNoteId.value; const isEdit = !!idStr; const titleVal = editNoteTitle.value.trim(); const contentVal = editNoteContent.value.trim();
        if (!titleVal && !contentVal) { switchView('notes'); return; }
        const newNote = { id: isEdit ? parseInt(idStr) : Date.now(), title: titleVal || '无标题笔记', content: contentVal, date: isEdit ? notesDatabase.find(n => n.id === parseInt(idStr)).date : getChineseDate() };
        if (isEdit) { const index = notesDatabase.findIndex(n => n.id === parseInt(idStr)); if(index !== -1) notesDatabase[index] = newNote; } else { notesDatabase.push(newNote); }
        saveNotesDatabase(); apiSyncNote(newNote, isEdit ? 'PUT' : 'POST'); renderNotes(); switchView('notes');
    });

    btnDeleteNote.addEventListener('click', () => {
        if(confirm("确定删除这条笔记吗？")) { const deletedId = currentNoteId; notesDatabase = notesDatabase.filter(n => n.id !== currentNoteId); saveNotesDatabase(); apiSyncNote({id: deletedId}, 'DELETE'); renderNotes(); switchView('notes'); }
    });

    // ==========================================
    // 6. 收藏夹逻辑 (Bookmarks)
    // ==========================================
    const renderBookmarks = () => {
        bookmarkListContainer.innerHTML = '';
        const sortedBookmarks = [...bookmarksDatabase].sort((a, b) => b.id - a.id);
        
        sortedBookmarks.forEach(bm => {
            const card = document.createElement('a');
            card.className = 'bookmark-card';
            card.href = bm.url;
            card.target = '_blank'; // 新标签页打开

            card.innerHTML = `
                <div class="bookmark-card-type">${escapeHtml(bm.type)}</div>
                <div class="bookmark-card-title">${escapeHtml(bm.title)}</div>
                <div class="bookmark-card-desc">${escapeHtml(bm.desc || '暂无描述...')}</div>
                <button class="bookmark-card-delete" data-id="${escapeHtml(String(bm.id))}" title="删除收藏">×</button>
            `;

            // 删除按钮的独立逻辑，阻止默认的 a 标签跳转
            const deleteBtn = card.querySelector('.bookmark-card-delete');
            deleteBtn.addEventListener('click', (e) => {
                e.preventDefault(); 
                e.stopPropagation();
                if(confirm(`确定要移除对 "${bm.title}" 的收藏吗？`)) {
                    const deletedId = bm.id;
                    bookmarksDatabase = bookmarksDatabase.filter(b => b.id !== bm.id);
                    saveBookmarksDatabase();
                    apiSyncBookmark({id: deletedId}, 'DELETE');
                    renderBookmarks();
                }
            });

            bookmarkListContainer.appendChild(card);
        });
    };

    const openBookmarkEditor = () => {
        bookmarkEditorForm.reset();
        editBookmarkId.value = '';
        switchView('bookmark-editor');
    };

    btnCancelBookmark.addEventListener('click', () => switchView('bookmarks'));

    bookmarkEditorForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const newBookmark = {
            id: Date.now(),
            type: editBookmarkType.value,
            title: editBookmarkTitle.value.trim(),
            url: editBookmarkUrl.value.trim(),
            desc: editBookmarkDesc.value.trim()
        };
        bookmarksDatabase.push(newBookmark);
        saveBookmarksDatabase();
        apiSyncBookmark(newBookmark, 'POST');
        renderBookmarks();
        switchView('bookmarks');
    });


    // ==========================================
    // 7. 全局事件与同步备份
    // ==========================================
    const navbar = document.getElementById('navbar');
    window.addEventListener('scroll', () => {
        if (window.scrollY > 20) navbar.classList.add('scrolled');
        else navbar.classList.remove('scrolled');
    });

    // 备份本地数据到云端按钮事件
    if (btnForceUpload) {
        btnForceUpload.addEventListener('click', async () => {
            if (!confirm('确定要将当前电脑上的所有周记、笔记和收藏备份覆盖到云端吗？\n如果在其他设备（如手机）上有新写的数据，可能会被覆盖，请谨慎操作。')) {
                return;
            }
            
            const labelEl = btnForceUpload.querySelector('.btn-label');
            const originalLabelText = labelEl ? labelEl.innerText : '备份到云端';
            if (labelEl) labelEl.innerText = '正在备份...';
            btnForceUpload.disabled = true;
            
            try {
                // 备份周记
                for (const item of database) {
                    if (database.length > 1 && item.id === 1) continue; // 排除默认的示例
                    await apiRequest('/api/weeklies', {
                        method: 'POST',
                        body: JSON.stringify(item)
                    });
                }
                
                // 备份笔记
                for (const item of notesDatabase) {
                    if (notesDatabase.length > 2 && (item.id === 101 || item.id === 102)) continue;
                    await apiRequest('/api/notes', {
                        method: 'POST',
                        body: JSON.stringify(item)
                    });
                }
                
                // 备份收藏
                for (const item of bookmarksDatabase) {
                    if (bookmarksDatabase.length > 3 && (item.id === 201 || item.id === 202 || item.id === 203)) continue;
                    await apiRequest('/api/bookmarks', {
                        method: 'POST',
                        body: JSON.stringify(item)
                    });
                }
                
                alert('备份成功！当前电脑上的数据已成功同步至云端。你现在可以在手机上刷新页面同步了。');
            } catch (err) {
                alert('备份失败: ' + err.message);
            } finally {
                if (labelEl) labelEl.innerText = originalLabelText;
                btnForceUpload.disabled = false;
            }
        });
    }

    // 检测并合并游客/未登录状态下的本地数据
    const checkAndMergeGuestData = async () => {
        if (!authUser) return;
        
        const guestData = JSON.parse(localStorage.getItem('default_gardenData')) || [];
        const guestNotes = JSON.parse(localStorage.getItem('default_gardenNotes')) || [];
        const guestBookmarks = JSON.parse(localStorage.getItem('default_gardenBookmarks')) || [];
        
        const hasGuestData = guestData.length > 0 && !(guestData.length === 1 && guestData[0].id === 1);
        const hasGuestNotes = guestNotes.length > 0 && !guestNotes.every(n => n.id === 101 || n.id === 102);
        const hasGuestBookmarks = guestBookmarks.length > 0 && !guestBookmarks.every(b => b.id === 201 || b.id === 202 || b.id === 203);
        
        if (hasGuestData || hasGuestNotes || hasGuestBookmarks) {
            if (confirm('检测到您在未登录时在当前电脑上创建了本地数据（周记/笔记/收藏）。是否将这些数据导入并同步到您当前的账号中？')) {
                try {
                    // 1. 合并周记到当前用户的本地缓存
                    const userKey = getLocalKey('gardenData');
                    let userDatabase = JSON.parse(localStorage.getItem(userKey)) || [];
                    userDatabase = [...userDatabase, ...guestData].filter((item, index, self) => 
                        self.findIndex(t => t.id === item.id) === index
                    );
                    localStorage.setItem(userKey, JSON.stringify(userDatabase));
                    database = userDatabase;
                    
                    for (const item of guestData) {
                        if (item.id === 1) continue;
                        await apiSyncWeekly(item, 'POST');
                    }

                    // 2. 合并笔记到当前用户的本地缓存
                    const userNotesKey = getLocalKey('gardenNotes');
                    let userNotesDatabase = JSON.parse(localStorage.getItem(userNotesKey)) || [];
                    userNotesDatabase = [...userNotesDatabase, ...guestNotes].filter((item, index, self) => 
                        self.findIndex(t => t.id === item.id) === index
                    );
                    localStorage.setItem(userNotesKey, JSON.stringify(userNotesDatabase));
                    notesDatabase = userNotesDatabase;
                    
                    for (const item of guestNotes) {
                        if (item.id === 101 || item.id === 102) continue;
                        await apiSyncNote(item, 'POST');
                    }

                    // 3. 合并收藏到当前用户的本地缓存
                    const userBMKey = getLocalKey('gardenBookmarks');
                    let userBMDatabase = JSON.parse(localStorage.getItem(userBMKey)) || [];
                    userBMDatabase = [...userBMDatabase, ...guestBookmarks].filter((item, index, self) => 
                        self.findIndex(t => t.id === item.id) === index
                    );
                    localStorage.setItem(userBMKey, JSON.stringify(userBMDatabase));
                    bookmarksDatabase = userBMDatabase;
                    
                    for (const item of guestBookmarks) {
                        if (item.id === 201 || item.id === 202 || item.id === 203) continue;
                        await apiSyncBookmark(item, 'POST');
                    }

                    // 清空游客数据，防止重复提示
                    localStorage.removeItem('default_gardenData');
                    localStorage.removeItem('default_gardenNotes');
                    localStorage.removeItem('default_gardenBookmarks');
                    
                    alert('本地数据已成功合并并同步至云端！');
                } catch (e) {
                    alert('合并同步部分数据失败，请重试：' + e.message);
                }
            }
        }
    };

    // 1. 立即用本地缓存渲染（秒开）
    loadLocalData();

    // 2. 检测合并游客数据
    checkAndMergeGuestData().then(() => {
        // 3. 后台静默同步 API 数据（有变化则自动刷新）
        syncFromApi();
    });
});
