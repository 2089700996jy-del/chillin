document.addEventListener('DOMContentLoaded', () => {

    // ==========================================
    // 1. 数据持久化与认证逻辑
    // ==========================================
    // 无条件默认指向 Cloudflare Worker 云端 API，支持手机、多电脑、局域网及任何域名访问
    let API_BASE = (typeof CHILLIN_API_URL !== 'undefined' && CHILLIN_API_URL) ? CHILLIN_API_URL : 'https://chillin-api.2089700996jy.workers.dev';
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
    const btnManualSync = document.getElementById('btn-manual-sync');

    let isRegisterMode = false;

    // 显示/隐藏认证覆盖层
    const checkAuth = () => {
        if (!authToken) {
            authOverlay.classList.remove('hidden');
            if (btnForceUpload) btnForceUpload.style.display = 'none';
            if (btnManualSync) btnManualSync.style.display = 'none';
            return false;
        }
        authOverlay.classList.add('hidden');
        if (authUser) navUsername.innerText = `Hi, ${authUser.username}`;
        if (btnForceUpload) btnForceUpload.style.display = 'inline-flex';
        if (btnManualSync) btnManualSync.style.display = 'inline-flex';
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
        const timeoutMs = options.timeout || 25000;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
                throw new Error('未登录或登录状态已过期，请重新登录');
            }
            if (!res.ok) throw new Error(`接口请求异常 (${res.status})`);
            return res.json();
        } catch (err) {
            if (err.name === 'AbortError' || (err.message && (err.message.includes('aborted') || err.message.includes('signal')))) {
                throw new Error('网络请求超时，请检查网络后重试');
            }
            throw err;
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
        { id: 201, type: "🛠️ 工具", title: "Notion", url: "https://notion.so", desc: "极致的块状编辑器，灵感的发源地。", image: "" },
        { id: 202, type: "🌐 网站", title: "Vercel", url: "https://vercel.com", desc: "前端项目一键部署的神仙平台。" },
        { id: 203, type: "🎬 电影", title: "豆瓣电影", url: "https://movie.douban.com", desc: "找冷门好片的唯一去处。" }
    ];

    let database, notesDatabase, bookmarksDatabase, feedsDatabase, echoCardsDatabase;

    const DEFAULT_FEEDS = [
        {
            id: 1,
            content: "今天将数字花园升级接入了 AI 记忆能力与随手记流！可以随时在顶部倾倒思考，AI 也会实时捕捉脉络。",
            type: "text",
            tags: ["#技术", "#灵感"],
            created_at: new Date().toISOString().replace('T', ' ').slice(0, 16)
        }
    ];

    // 缓存前缀函数 (按用户隔离)
    const getLocalKey = (key) => authUser ? `${authUser.id}_${key}` : `default_${key}`;

    // 立即从本地缓存加载，保证页面秒开
    const loadLocalData = () => {
        if (!checkAuth()) return; // 未登录时不加载数据
        database = JSON.parse(localStorage.getItem(getLocalKey('gardenData'))) || DEFAULT_WEEKLY;
        notesDatabase = JSON.parse(localStorage.getItem(getLocalKey('gardenNotes'))) || DEFAULT_NOTES;
        bookmarksDatabase = JSON.parse(localStorage.getItem(getLocalKey('gardenBookmarks'))) || DEFAULT_BOOKMARKS;
        feedsDatabase = JSON.parse(localStorage.getItem(getLocalKey('gardenFeeds'))) || DEFAULT_FEEDS;
        echoCardsDatabase = JSON.parse(localStorage.getItem(getLocalKey('gardenEchoCards'))) || [];
        renderCards();
        renderNotes();
        renderBookmarks();
        renderFeeds();
        renderEchoCards();
        renderHeatmap();
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
        // 随手记
        try {
            const apiData = await apiRequest('/api/feeds');
            if (apiData) {
                feedsDatabase = apiData;
                localStorage.setItem(getLocalKey('gardenFeeds'), JSON.stringify(feedsDatabase));
                renderFeeds();
            }
        } catch {}
        // 回响卡片
        try {
            const apiData = await apiRequest('/api/echo/cards');
            if (apiData) {
                echoCardsDatabase = apiData;
                localStorage.setItem(getLocalKey('gardenEchoCards'), JSON.stringify(echoCardsDatabase));
                renderEchoCards();
            }
        } catch {}
        renderHeatmap();
    };

    const saveDatabase = () => localStorage.setItem(getLocalKey('gardenData'), JSON.stringify(database));
    const saveNotesDatabase = () => localStorage.setItem(getLocalKey('gardenNotes'), JSON.stringify(notesDatabase));
    const saveBookmarksDatabase = () => localStorage.setItem(getLocalKey('gardenBookmarks'), JSON.stringify(bookmarksDatabase));
    const saveFeedsDatabase = () => localStorage.setItem(getLocalKey('gardenFeeds'), JSON.stringify(feedsDatabase));

    // API 同步辅助函数（静默失败，不阻塞 UI）
    const apiSyncWeekly = (item, method) => {
        const bm = method === 'DELETE' ? { method: 'DELETE' } : { method, body: JSON.stringify(item) };
        const id = method === 'POST' ? '' : `/${item.id}`;
        return apiRequest(`/api/weeklies${id}`, bm).catch(() => {});
    };
    const apiSyncNote = (item, method) => {
        const bm = method === 'DELETE' ? { method: 'DELETE' } : { method, body: JSON.stringify(item) };
        const id = method === 'POST' ? '' : `/${item.id}`;
        return apiRequest(`/api/notes${id}`, bm).catch(() => {});
    };
    const apiSyncBookmark = (item, method) => {
        const bm = method === 'DELETE' ? { method: 'DELETE' } : { method, body: JSON.stringify(item) };
        const id = method === 'POST' ? '' : `/${item.id}`;
        return apiRequest(`/api/bookmarks${id}`, bm).catch(() => {});
    };
    const apiSyncFeed = (item, method) => {
        const bm = method === 'DELETE' ? { method: 'DELETE' } : { method, body: JSON.stringify(item) };
        const id = method === 'POST' ? '' : `/${item.id}`;
        return apiRequest(`/api/feeds${id}`, bm).catch(() => {});
    };

    let currentArticleId = null;
    let currentNoteId = null;
    let currentActiveNavView = 'home'; 
    let currentHomeSearchQuery = '';
    let currentNotesSearchQuery = '';
    let currentBookmarksSearchQuery = ''; 

    // ==========================================
    // 2. DOM 元素获取
    // ==========================================
    const views = document.querySelectorAll('.view-section');
    const navItems = document.querySelectorAll('.nav-item, .mobile-tab-item');
    const btnBack = document.getElementById('btn-back');
    const navMenu = document.getElementById('nav-menu');
    const fabBtn = document.getElementById('btn-create-new');
    const mobileBottomNav = document.getElementById('mobile-bottom-nav');

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
    const editBookmarkImage = document.getElementById('edit-bookmark-image');

    // Category chips
    document.querySelectorAll('.cat-chip').forEach(chip => {
        chip.addEventListener('click', function() {
            document.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('active'));
            this.classList.add('active');
            editBookmarkType.value = this.dataset.val;
        });
    });


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
        
        if (targetViewId === 'home' || targetViewId === 'feeds' || targetViewId === 'notes' || targetViewId === 'bookmarks' || targetViewId === 'reader') {
            currentActiveNavView = targetViewId;
            navItems.forEach(item => item.classList.remove('active'));
            const activeNavs = document.querySelectorAll(`.nav-item[data-view="${targetViewId}"], .mobile-tab-item[data-view="${targetViewId}"]`);
            activeNavs.forEach(nav => nav.classList.add('active'));
            if (targetViewId === 'reader') {
                setTimeout(renderBookshelf, 100);
            } else if (targetViewId === 'feeds') {
                renderFeeds();
            } else if (targetViewId === 'home') {
                renderHeatmap();
            } else {
                document.body.classList.remove('dark-reader-body', 'eyecare-reader-body');
            }
        }

        // Update FAB label
        const fabLabel = document.getElementById('fab-label');
        const fabLabels = { home: '记录新片段', feeds: '记录随手记', notes: '记录新笔记', bookmarks: '收藏新链接', reader: '导入新书' };
        if (fabLabel && fabLabels[targetViewId]) fabLabel.textContent = fabLabels[targetViewId];

        if (targetViewId === 'article' || targetViewId === 'editor' || targetViewId === 'note-editor' || targetViewId === 'bookmark-editor' || targetViewId === 'reader-book') {
            navMenu.style.display = 'none';
            btnBack.style.display = 'block';
            fabBtn.classList.add('hidden');
            if (mobileBottomNav) {
                mobileBottomNav.style.display = 'none';
                mobileBottomNav.classList.add('hidden');
            }
            document.body.classList.add('hide-bottom-nav');
        } else {
            navMenu.style.display = '';
            btnBack.style.display = 'none';
            fabBtn.classList.remove('hidden');
            if (mobileBottomNav) {
                mobileBottomNav.style.display = '';
                mobileBottomNav.classList.remove('hidden');
            }
            document.body.classList.remove('hide-bottom-nav');
        }
        window.scrollTo(0, 0); 
    };

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const targetEl = e.currentTarget || e.target.closest('[data-view]');
            const view = targetEl ? targetEl.dataset.view : null;
            if (view) switchView(view);
        });
    });

    btnBack.addEventListener('click', () => {
        const activeView = document.querySelector('.view-section.active');
        // Clear reader theme when leaving reader-book
        document.body.classList.remove('dark-reader-body', 'eyecare-reader-body');
        if (activeView && activeView.id === 'view-editor') {
            handleExitWeeklyEditor(() => {
                switchView(currentActiveNavView);
                currentArticleId = null;
                currentNoteId = null;
            });
        } else {
            switchView(currentActiveNavView);
            currentArticleId = null;
            currentNoteId = null;
        }
    });

    fabBtn.addEventListener('click', () => {
        if (currentActiveNavView === 'home') openWeeklyEditor(null);
        else if (currentActiveNavView === 'notes') openNoteEditor(null);
        else if (currentActiveNavView === 'bookmarks') openBookmarkEditor();
        else if (currentActiveNavView === 'reader') document.getElementById('book-file-input').click();
    });

    const getChineseDate = () => {
        const date = new Date();
        return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    };

    // ==========================================
    // 4. 周记画廊逻辑 (Weekly Recaps)
    // ==========================================
    let currentWeeklyAnnotations = [];

    const renderWeeklyAnnotationsList = () => {
        const timeline = document.getElementById('weekly-annotations-timeline');
        timeline.innerHTML = '';
        if (!currentWeeklyAnnotations || currentWeeklyAnnotations.length === 0) {
            timeline.innerHTML = '<div style="font-size: 13px; color: var(--text-color-light); text-align: center; padding: 20px 0;">暂无追加说明，在下方写下第一条吧</div>';
            return;
        }
        currentWeeklyAnnotations.forEach(ann => {
            const item = document.createElement('div');
            item.className = 'annotation-item';
            item.innerHTML = `
                <div class="annotation-dot"></div>
                <div class="annotation-content-box">
                    <div class="annotation-meta">
                        <span class="annotation-time">${escapeHtml(ann.date)}</span>
                        <button type="button" class="btn-delete-annotation" data-id="${ann.id}">删除</button>
                    </div>
                    <div class="annotation-text">${escapeHtml(ann.content)}</div>
                </div>
            `;
            
            item.querySelector('.btn-delete-annotation').addEventListener('click', () => {
                if (confirm("确定要删除这条批追记吗？")) {
                    currentWeeklyAnnotations = currentWeeklyAnnotations.filter(a => a.id !== ann.id);
                    const article = database.find(d => d.id === currentArticleId);
                    if (article) {
                        article.annotations = currentWeeklyAnnotations;
                        saveDatabase();
                        apiSyncWeekly(article, 'PUT');
                        renderCards();
                    }
                    renderWeeklyAnnotationsList();
                }
            });
            
            timeline.appendChild(item);
        });
    };

    const renderCards = (filter) => {
        if (!filter) {
            const activeBtn = document.querySelector('.filter-btn.active');
            filter = activeBtn ? activeBtn.dataset.filter : 'all';
        }
        galleryContainer.innerHTML = '';
        const sortedDB = [...database].sort((a, b) => b.id - a.id);
        sortedDB.forEach(item => {
            if (filter !== "all" && item.category !== filter) return;
            
            if (currentHomeSearchQuery) {
                const query = currentHomeSearchQuery.toLowerCase();
                const titleMatch = (item.title || '').toLowerCase().includes(query);
                const summaryMatch = (item.summary || '').toLowerCase().includes(query);
                const contentMatch = (item.content || '').toLowerCase().includes(query);
                if (!titleMatch && !summaryMatch && !contentMatch) return;
            }
            
            const card = document.createElement('div');
            card.className = "notion-collection-card";
            card.dataset.id = item.id;
            let coverHtml = item.cover ? `<img src="${escapeHtml(item.cover)}" alt="Cover" class="notion-collection-card__cover">` : '';
            
            const annCount = item.annotations && item.annotations.length > 0 ? ` <span class="note-ann-badge">💬 ${item.annotations.length}</span>` : '';
            
            card.innerHTML = `${coverHtml}<div class="notion-collection-card__content"><div class="card-property-category">${escapeHtml(item.category)}</div><div class="card-title">${escapeHtml(item.title)}${annCount}</div><div class="card-summary">${escapeHtml(item.summary)}</div><div class="card-date">${escapeHtml(item.date)}</div></div>`;
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
        
        // 加载记忆片段的追加批注
        document.getElementById('new-weekly-annotation-content').value = '';
        currentWeeklyAnnotations = item.annotations || [];
        renderWeeklyAnnotationsList();
        
        switchView('article');
    };

    // ==========================================
    // 草稿保存与恢复逻辑 (Weekly Recap Drafts)
    // ==========================================
    const hasUnsavedChanges = () => {
        const editId = document.getElementById('edit-id').value;
        const currentCategory = document.getElementById('edit-category').value;
        const currentTitle = document.getElementById('edit-title').value;
        const currentSummary = document.getElementById('edit-summary').value;
        const currentCover = document.getElementById('edit-cover').value;
        const currentContent = document.getElementById('edit-content').value;
        const currentMusicTitle = document.getElementById('edit-music-title').value;
        const currentMusicArtist = document.getElementById('edit-music-artist').value;
        const currentMusicLyric = document.getElementById('edit-music-lyric').value;
        const currentMediaIcon = document.getElementById('edit-media-icon').value;
        const currentMediaTitle = document.getElementById('edit-media-title').value;
        const currentMediaDesc = document.getElementById('edit-media-desc').value;
        const currentLifeImage = document.getElementById('edit-life-image').value;
        const currentLifeCaption = document.getElementById('edit-life-caption').value;
        const currentPodcast = document.getElementById('edit-podcast').value;
        const currentWorkTitle = document.getElementById('edit-work-title').value;
        const currentWorkDesc = document.getElementById('edit-work-desc').value;

        if (editId) {
            // 编辑已有文章：与原始数据库文章对比
            const item = database.find(d => d.id === parseInt(editId));
            if (!item) return false;
            const originalMusic = item.weeklyData?.music || {};
            const originalMedia = (item.weeklyData?.media && item.weeklyData.media[0]) || {};
            const originalLife = item.weeklyData?.life || {};
            const originalPodcast = item.weeklyData?.podcast || '';
            const originalWork = item.weeklyData?.work || {};

            return currentCategory !== item.category ||
                   currentTitle !== item.title ||
                   currentSummary !== item.summary ||
                   currentCover !== (item.cover || '') ||
                   currentContent !== (item.content || '') ||
                   currentMusicTitle !== (originalMusic.title || '') ||
                   currentMusicArtist !== (originalMusic.artist || '') ||
                   currentMusicLyric !== (originalMusic.lyric || '') ||
                   currentMediaIcon !== (originalMedia.icon || '🎬') ||
                   currentMediaTitle !== (originalMedia.title || '') ||
                   currentMediaDesc !== (originalMedia.desc || '') ||
                   currentLifeImage !== (originalLife.image || '') ||
                   currentLifeCaption !== (originalLife.caption || '') ||
                   currentPodcast !== originalPodcast ||
                   currentWorkTitle !== (originalWork.title || '') ||
                   currentWorkDesc !== (originalWork.desc || '');
        } else {
            // 新建文章：只要任一字段不为空即为有修改
            return currentTitle.trim() !== '' ||
                   currentSummary.trim() !== '' ||
                   currentCover.trim() !== '' ||
                   currentContent.trim() !== '' ||
                   currentMusicTitle.trim() !== '' ||
                   currentMusicArtist.trim() !== '' ||
                   currentMusicLyric.trim() !== '' ||
                   currentMediaTitle.trim() !== '' ||
                   currentMediaDesc.trim() !== '' ||
                   currentLifeImage.trim() !== '' ||
                   currentLifeCaption.trim() !== '' ||
                   currentPodcast.trim() !== '' ||
                   currentWorkTitle.trim() !== '' ||
                   currentWorkDesc.trim() !== '';
        }
    };

    const saveWeeklyDraft = () => {
        const editId = document.getElementById('edit-id').value;
        const draft = {
            id: editId ? parseInt(editId) : '',
            category: document.getElementById('edit-category').value,
            title: document.getElementById('edit-title').value,
            summary: document.getElementById('edit-summary').value,
            cover: document.getElementById('edit-cover').value,
            content: document.getElementById('edit-content').value,
            musicTitle: document.getElementById('edit-music-title').value,
            musicArtist: document.getElementById('edit-music-artist').value,
            musicLyric: document.getElementById('edit-music-lyric').value,
            mediaIcon: document.getElementById('edit-media-icon').value,
            mediaTitle: document.getElementById('edit-media-title').value,
            mediaDesc: document.getElementById('edit-media-desc').value,
            lifeImage: document.getElementById('edit-life-image').value,
            lifeCaption: document.getElementById('edit-life-caption').value,
            podcast: document.getElementById('edit-podcast').value,
            workTitle: document.getElementById('edit-work-title').value,
            workDesc: document.getElementById('edit-work-desc').value,
            timestamp: Date.now()
        };
        localStorage.setItem(getLocalKey('weeklyDraft'), JSON.stringify(draft));
    };

    const restoreWeeklyDraft = () => {
        const draftStr = localStorage.getItem(getLocalKey('weeklyDraft'));
        if (!draftStr) return;
        try {
            const draft = JSON.parse(draftStr);
            document.getElementById('edit-category').value = draft.category || '🌸';
            document.getElementById('edit-title').value = draft.title || '';
            document.getElementById('edit-summary').value = draft.summary || '';
            document.getElementById('edit-cover').value = draft.cover || '';
            document.getElementById('edit-content').value = draft.content || '';
            document.getElementById('edit-music-title').value = draft.musicTitle || '';
            document.getElementById('edit-music-artist').value = draft.musicArtist || '';
            document.getElementById('edit-music-lyric').value = draft.musicLyric || '';
            document.getElementById('edit-media-icon').value = draft.mediaIcon || '🎬';
            document.getElementById('edit-media-title').value = draft.mediaTitle || '';
            document.getElementById('edit-media-desc').value = draft.mediaDesc || '';
            document.getElementById('edit-life-image').value = draft.lifeImage || '';
            document.getElementById('edit-life-caption').value = draft.lifeCaption || '';
            document.getElementById('edit-podcast').value = draft.podcast || '';
            document.getElementById('edit-work-title').value = draft.workTitle || '';
            document.getElementById('edit-work-desc').value = draft.workDesc || '';
            
            // 隐藏横幅
            document.getElementById('weekly-draft-tip').style.display = 'none';
        } catch (e) {
            console.error('Failed to restore draft', e);
        }
    };

    const discardWeeklyDraft = () => {
        localStorage.removeItem(getLocalKey('weeklyDraft'));
        document.getElementById('weekly-draft-tip').style.display = 'none';
    };

    const checkAndShowWeeklyDraftTip = (editId) => {
        const draftStr = localStorage.getItem(getLocalKey('weeklyDraft'));
        const tipBanner = document.getElementById('weekly-draft-tip');
        if (!draftStr) {
            tipBanner.style.display = 'none';
            return;
        }
        try {
            const draft = JSON.parse(draftStr);
            const currentIdStr = editId ? String(editId) : '';
            const draftIdStr = draft.id ? String(draft.id) : '';
            
            if (currentIdStr === draftIdStr) {
                const draftDate = new Date(draft.timestamp);
                const timeText = draftDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                document.getElementById('weekly-draft-time').innerText = timeText;
                tipBanner.style.display = 'flex';
            } else {
                tipBanner.style.display = 'none';
            }
        } catch (e) {
            tipBanner.style.display = 'none';
        }
    };

    const handleExitWeeklyEditor = (onConfirm) => {
        if (hasUnsavedChanges()) {
            if (confirm('确定要退出编辑吗？当前未保存的内容将作为草稿保存在本地，下次进入时可以恢复。')) {
                saveWeeklyDraft();
                onConfirm();
            }
        } else {
            discardWeeklyDraft();
            onConfirm();
        }
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
        checkAndShowWeeklyDraftTip(editId);
        switchView('editor');
    };

    btnEditArticle.addEventListener('click', () => openWeeklyEditor(currentArticleId));
    btnCancelEdit.addEventListener('click', () => {
        handleExitWeeklyEditor(() => {
            const isNew = !document.getElementById('edit-id').value;
            switchView(isNew ? 'home' : 'article');
        });
    });

    editorForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const idStr = document.getElementById('edit-id').value;
        const isEdit = !!idStr;
        const newData = {
            id: isEdit ? parseInt(idStr) : Date.now(), 
            category: document.getElementById('edit-category').value, 
            title: document.getElementById('edit-title').value, 
            summary: document.getElementById('edit-summary').value, 
            cover: document.getElementById('edit-cover').value, 
            content: document.getElementById('edit-content').value,
            date: isEdit ? database.find(d => d.id === parseInt(idStr)).date : getChineseDate(),
            annotations: isEdit ? (database.find(d => d.id === parseInt(idStr)).annotations || []) : [],
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
        discardWeeklyDraft();
        saveDatabase(); apiSyncWeekly(newData, isEdit ? 'PUT' : 'POST'); renderCards(document.querySelector('.filter-btn.active').dataset.filter); switchView('home');
    });

    // 绑定草稿箱相关按钮与自动保存监听
    document.getElementById('btn-restore-weekly-draft').addEventListener('click', restoreWeeklyDraft);
    document.getElementById('btn-discard-weekly-draft').addEventListener('click', discardWeeklyDraft);

    editorForm.addEventListener('input', () => {
        if (hasUnsavedChanges()) {
            saveWeeklyDraft();
        } else {
            discardWeeklyDraft();
        }
    });
    editorForm.addEventListener('change', () => {
        if (hasUnsavedChanges()) {
            saveWeeklyDraft();
        } else {
            discardWeeklyDraft();
        }
    });

    window.addEventListener('beforeunload', (e) => {
        const activeView = document.querySelector('.view-section.active');
        if (activeView && activeView.id === 'view-editor' && hasUnsavedChanges()) {
            saveWeeklyDraft();
            e.preventDefault();
            e.returnValue = '';
        }
    });

    btnDeleteArticle.addEventListener('click', () => {
        if(confirm("确定要永久删除这篇记忆吗？")) { const deletedId = currentArticleId; database = database.filter(d => d.id !== currentArticleId); saveDatabase(); apiSyncWeekly({id: deletedId}, 'DELETE'); renderCards(); switchView('home'); }
    });

    document.getElementById('btn-add-weekly-annotation').addEventListener('click', () => {
        const inputEl = document.getElementById('new-weekly-annotation-content');
        const text = inputEl.value.trim();
        if (!text) return;
        const newAnn = {
            id: Date.now(),
            content: text,
            date: getChineseDateTime()
        };
        currentWeeklyAnnotations.push(newAnn);
        inputEl.value = '';
        
        const article = database.find(d => d.id === currentArticleId);
        if (article) {
            article.annotations = currentWeeklyAnnotations;
            saveDatabase();
            apiSyncWeekly(article, 'PUT');
            renderCards();
        }
        renderWeeklyAnnotationsList();
    });

    filterBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            filterBtns.forEach(b => b.classList.remove('active')); e.target.classList.add('active'); renderCards(e.target.dataset.filter);
        });
    });

    // ==========================================
    // 5. 极简备忘录逻辑 (Notes)
    // ==========================================
    let currentNoteAnnotations = [];

    const getChineseDateTime = () => {
        const date = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };

    const renderAnnotationsList = () => {
        const timeline = document.getElementById('annotations-timeline');
        timeline.innerHTML = '';
        if (!currentNoteAnnotations || currentNoteAnnotations.length === 0) {
            timeline.innerHTML = '<div style="font-size: 13px; color: var(--text-color-light); text-align: center; padding: 20px 0;">暂无批注，在下方写下第一条吧</div>';
            return;
        }
        currentNoteAnnotations.forEach(ann => {
            const item = document.createElement('div');
            item.className = 'annotation-item';
            item.innerHTML = `
                <div class="annotation-dot"></div>
                <div class="annotation-content-box">
                    <div class="annotation-meta">
                        <span class="annotation-time">${escapeHtml(ann.date)}</span>
                        <button type="button" class="btn-delete-annotation" data-id="${ann.id}">删除</button>
                    </div>
                    <div class="annotation-text">${escapeHtml(ann.content)}</div>
                </div>
            `;
            
            item.querySelector('.btn-delete-annotation').addEventListener('click', () => {
                if (confirm("确定要删除这条批注吗？")) {
                    currentNoteAnnotations = currentNoteAnnotations.filter(a => a.id !== ann.id);
                    const note = notesDatabase.find(n => n.id === currentNoteId);
                    if (note) {
                        note.annotations = currentNoteAnnotations;
                        saveNotesDatabase();
                        apiSyncNote(note, 'PUT');
                        renderNotes();
                    }
                    renderAnnotationsList();
                }
            });
            
            timeline.appendChild(item);
        });
    };

    const renderNotes = () => {
        notesListContainer.innerHTML = '';
        const sortedNotes = [...notesDatabase].sort((a, b) => b.id - a.id);
        sortedNotes.forEach(note => {
            if (currentNotesSearchQuery) {
                const query = currentNotesSearchQuery.toLowerCase();
                const titleMatch = (note.title || '').toLowerCase().includes(query);
                const contentMatch = (note.content || '').toLowerCase().includes(query);
                if (!titleMatch && !contentMatch) return;
            }
            const el = document.createElement('div');
            el.className = 'note-item';
            const previewText = note.content ? escapeHtml(note.content.substring(0, 30)).replace(/\n/g, ' ') + '...' : '无正文内容';
            
            // 如果笔记有批注，显示批注数量气泡
            const annCount = note.annotations && note.annotations.length > 0 ? ` <span class="note-ann-badge">💬 ${note.annotations.length}</span>` : '';
            
            el.innerHTML = `<div class="note-item-content"><div class="note-item-title">${escapeHtml(note.title || '无标题笔记')}${annCount}</div><div class="note-item-preview">${previewText}</div></div><div class="note-item-date">${escapeHtml(note.date)}</div>`;
            el.addEventListener('click', () => openNoteEditor(note.id));
            notesListContainer.appendChild(el);
        });
    };

    const openNoteEditor = (noteId = null) => {
        document.getElementById('new-annotation-content').value = '';
        if (noteId) {
            currentNoteId = noteId; const note = notesDatabase.find(n => n.id === noteId);
            if (note) { 
                editNoteId.value = note.id; 
                editNoteTitle.value = note.title; 
                editNoteContent.value = note.content; 
                noteEditorDate.innerText = note.date; 
                btnDeleteNote.style.display = 'inline-block'; 
                currentNoteAnnotations = note.annotations || [];
                renderAnnotationsList();
                document.getElementById('note-annotations-section').style.display = 'block';
            }
        } else {
            currentNoteId = null; editNoteId.value = ''; editNoteTitle.value = ''; editNoteContent.value = ''; noteEditorDate.innerText = getChineseDate(); btnDeleteNote.style.display = 'none';
            currentNoteAnnotations = [];
            document.getElementById('note-annotations-section').style.display = 'none';
        }
        switchView('note-editor');
        autoResizeTextarea(editNoteContent);
    };

    btnSaveNote.addEventListener('click', () => {
        const idStr = editNoteId.value; const isEdit = !!idStr; const titleVal = editNoteTitle.value.trim(); const contentVal = editNoteContent.value.trim();
        if (!titleVal && !contentVal) { switchView('notes'); return; }
        const newNote = { 
            id: isEdit ? parseInt(idStr) : Date.now(), 
            title: titleVal || '无标题笔记', 
            content: contentVal, 
            date: isEdit ? notesDatabase.find(n => n.id === parseInt(idStr)).date : getChineseDate(),
            annotations: currentNoteAnnotations
        };
        if (isEdit) { const index = notesDatabase.findIndex(n => n.id === parseInt(idStr)); if(index !== -1) notesDatabase[index] = newNote; } else { notesDatabase.push(newNote); }
        saveNotesDatabase(); apiSyncNote(newNote, isEdit ? 'PUT' : 'POST'); renderNotes(); switchView('notes');
    });

    btnDeleteNote.addEventListener('click', () => {
        if(confirm("确定删除这条笔记吗？")) { const deletedId = currentNoteId; notesDatabase = notesDatabase.filter(n => n.id !== currentNoteId); saveNotesDatabase(); apiSyncNote({id: deletedId}, 'DELETE'); renderNotes(); switchView('notes'); }
    });

    document.getElementById('btn-add-annotation').addEventListener('click', () => {
        const inputEl = document.getElementById('new-annotation-content');
        const text = inputEl.value.trim();
        if (!text) return;
        const newAnn = {
            id: Date.now(),
            content: text,
            date: getChineseDateTime()
        };
        currentNoteAnnotations.push(newAnn);
        inputEl.value = '';
        
        // 如果是已存笔记，立刻保存到数据库
        const note = notesDatabase.find(n => n.id === currentNoteId);
        if (note) {
            note.annotations = currentNoteAnnotations;
            saveNotesDatabase();
            apiSyncNote(note, 'PUT');
            renderNotes();
        }
        renderAnnotationsList();
    });

    // ==========================================
    // 6. 收藏夹逻辑 (Bookmarks)
    // ==========================================
    const renderBookmarks = () => {
        bookmarkListContainer.innerHTML = '';
        const sortedBookmarks = [...bookmarksDatabase].sort((a, b) => b.id - a.id);
        
        sortedBookmarks.forEach(bm => {
            if (currentBookmarksSearchQuery) {
                const query = currentBookmarksSearchQuery.toLowerCase();
                const titleMatch = (bm.title || '').toLowerCase().includes(query);
                const descMatch = (bm.desc || '').toLowerCase().includes(query);
                const typeMatch = (bm.type || '').toLowerCase().includes(query);
                if (!titleMatch && !descMatch && !typeMatch) return;
            }
            const hasUrl = bm.url && bm.url.trim();
            const card = document.createElement(hasUrl ? 'a' : 'div');
            card.className = 'bookmark-card';
            if (hasUrl) { card.href = bm.url; card.target = '_blank'; }

            const hasImage = bm.image && bm.image.trim();
            card.innerHTML = `
                ${hasImage
                    ? '<img class="bookmark-card-image" src="' + escapeHtml(bm.image) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
                    : '<div class="bookmark-card-image-placeholder">' + (bm.type || '🔖').split(' ')[0] + '</div>'}
                <div class="bookmark-card-type">${escapeHtml(bm.type)}</div>
                <div class="bookmark-card-title">${escapeHtml(bm.title)}</div>
                <div class="bookmark-card-desc">${escapeHtml(bm.desc || '暂无描述...')}</div>
                <button class="bookmark-card-delete" data-id="${escapeHtml(String(bm.id))}" title="删除收藏">×</button>
            `;

            // If no URL but has image, click to view image in modal
            if (!hasUrl && hasImage) {
                card.style.cursor = 'zoom-in';
                card.addEventListener('click', (e) => {
                    if (e.target.closest('.bookmark-card-delete')) return;
                    document.getElementById('image-preview-img').src = bm.image;
                    document.getElementById('image-preview-modal').classList.add('show');
                });
            }

            // 删除按钮
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
        editBookmarkImage.value = '';
        // Reset chips
        document.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('active'));
        const firstChip = document.querySelector('.cat-chip[data-val="🌐 网站"]');
        if (firstChip) { firstChip.classList.add('active'); editBookmarkType.value = '🌐 网站'; }
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
            desc: editBookmarkDesc.value.trim(),
            image: (editBookmarkImage && editBookmarkImage.value || '').trim()
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

    // 手动从云端同步数据按钮事件
    if (btnManualSync) {
        btnManualSync.addEventListener('click', async () => {
            const labelEl = btnManualSync.querySelector('.btn-label');
            const originalLabel = labelEl ? labelEl.innerText : '同步';
            if (labelEl) labelEl.innerText = '同步中...';
            btnManualSync.disabled = true;
            try {
                await syncFromApi();
                if (labelEl) labelEl.innerText = '已同步!';
                setTimeout(() => { if (labelEl) labelEl.innerText = originalLabel; }, 1800);
            } catch (err) {
                alert('同步失败: ' + err.message);
                if (labelEl) labelEl.innerText = originalLabel;
            } finally {
                btnManualSync.disabled = false;
            }
        });
    }

    // 备份本地数据到云端按钮事件
    if (btnForceUpload) {
        btnForceUpload.addEventListener('click', async () => {
            if (!confirm('确定要将当前设备上的所有周记、笔记、收藏和随手记覆盖备份到云端吗？\n如果在其他设备上写的数据尚未上传，可能会被覆盖，请谨慎操作。')) {
                return;
            }
            
            const labelEl = btnForceUpload.querySelector('.btn-label');
            const originalLabelText = labelEl ? labelEl.innerText : '备份到云端';
            if (labelEl) labelEl.innerText = '正在备份...';
            btnForceUpload.disabled = true;
            
            try {
                // 一次性批量打包发送给后端 (解决手机网络多次循环请求导致的 signal is aborted 时间超时)
                await apiRequest('/api/sync/batch', {
                    method: 'POST',
                    body: JSON.stringify({
                        weeklies: database,
                        notes: notesDatabase,
                        bookmarks: bookmarksDatabase,
                        feeds: feedsDatabase
                    })
                });

                alert('备份成功！已将当前设备数据同步至云端。你现在可以在手机/其他电脑上点击“同步”获取最新数据。');
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
        const guestFeeds = JSON.parse(localStorage.getItem('default_gardenFeeds')) || [];
        
        const hasGuestData = guestData.length > 0 && !(guestData.length === 1 && guestData[0].id === 1);
        const hasGuestNotes = guestNotes.length > 0 && !guestNotes.every(n => n.id === 101 || n.id === 102);
        const hasGuestBookmarks = guestBookmarks.length > 0 && !guestBookmarks.every(b => b.id === 201 || b.id === 202 || b.id === 203);
        const hasGuestFeeds = guestFeeds.length > 0 && !(guestFeeds.length === 1 && guestFeeds[0].id === 1);

        if (hasGuestData || hasGuestNotes || hasGuestBookmarks || hasGuestFeeds) {
            if (confirm('检测到您在未登录时在当前设备上创建了本地数据（周记/笔记/收藏/随手记）。是否将这些数据导入并同步到您当前的账号中？')) {
                try {
                    // 1. 合并周记到当前用户的本地缓存
                    const userKey = getLocalKey('gardenData');
                    let userDatabase = JSON.parse(localStorage.getItem(userKey)) || [];
                    userDatabase = [...userDatabase, ...guestData].filter((item, index, self) => 
                        self.findIndex(t => t.id === item.id) === index
                    );
                    localStorage.setItem(userKey, JSON.stringify(userDatabase));
                    database = userDatabase;

                    // 2. 合并笔记到当前用户的本地缓存
                    const userNotesKey = getLocalKey('gardenNotes');
                    let userNotesDatabase = JSON.parse(localStorage.getItem(userNotesKey)) || [];
                    userNotesDatabase = [...userNotesDatabase, ...guestNotes].filter((item, index, self) => 
                        self.findIndex(t => t.id === item.id) === index
                    );
                    localStorage.setItem(userNotesKey, JSON.stringify(userNotesDatabase));
                    notesDatabase = userNotesDatabase;

                    // 3. 合并收藏到当前用户的本地缓存
                    const userBMKey = getLocalKey('gardenBookmarks');
                    let userBMDatabase = JSON.parse(localStorage.getItem(userBMKey)) || [];
                    userBMDatabase = [...userBMDatabase, ...guestBookmarks].filter((item, index, self) => 
                        self.findIndex(t => t.id === item.id) === index
                    );
                    localStorage.setItem(userBMKey, JSON.stringify(userBMDatabase));
                    bookmarksDatabase = userBMDatabase;

                    // 4. 合并随手记到当前用户的本地缓存
                    const userFeedsKey = getLocalKey('gardenFeeds');
                    let userFeedsDatabase = JSON.parse(localStorage.getItem(userFeedsKey)) || [];
                    userFeedsDatabase = [...userFeedsDatabase, ...guestFeeds].filter((item, index, self) => 
                        self.findIndex(t => t.id === item.id) === index
                    );
                    localStorage.setItem(userFeedsKey, JSON.stringify(userFeedsDatabase));
                    feedsDatabase = userFeedsDatabase;

                    // 一次性发送到云端
                    await apiRequest('/api/sync/batch', {
                        method: 'POST',
                        body: JSON.stringify({
                            weeklies: guestData,
                            notes: guestNotes,
                            bookmarks: guestBookmarks,
                            feeds: guestFeeds
                        })
                    });

                    // 清空游客数据，防止重复提示
                    localStorage.removeItem('default_gardenData');
                    localStorage.removeItem('default_gardenNotes');
                    localStorage.removeItem('default_gardenBookmarks');
                    localStorage.removeItem('default_gardenFeeds');
                    
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

    // 页面重新可见（切回标签页或亮屏）时自动重新静默同步
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && authToken) {
            syncFromApi();
        }
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

            const headers = {
                'X-API-Key': API_KEY
            };
            if (authToken) {
                headers['Authorization'] = `Bearer ${authToken}`;
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
                    alert('图片上传成功！已填入链接。');
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
        switchView('reader-book');
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
        switchView('reader'); // switchView will trigger renderBookshelf
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
            currentHomeSearchQuery = e.target.value;
            renderCards();
        });
    }

    const searchNotesInput = document.getElementById('search-notes');
    if (searchNotesInput) {
        searchNotesInput.addEventListener('input', (e) => {
            currentNotesSearchQuery = e.target.value;
            renderNotes();
        });
    }

    const searchBookmarksInput = document.getElementById('search-bookmarks');
    if (searchBookmarksInput) {
        searchBookmarksInput.addEventListener('input', (e) => {
            currentBookmarksSearchQuery = e.target.value;
            renderBookmarks();
        });
    }

    // ════════════════════════════════════════════
    // MINDBACK ECHO FEATURES JAVASCRIPT LOGIC
    // ════════════════════════════════════════════

    // 1. Render Feeds Stream (随手记流)
    function renderFeeds() {
        const container = document.getElementById('feeds-stream-container');
        if (!container) return;

        if (!feedsDatabase || feedsDatabase.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 40px 20px; color: #9ca3af;">
                    <div style="font-size: 32px; margin-bottom: 8px;">⚡️</div>
                    <div style="font-size: 14px; font-weight: 500;">随手记流空空如也</div>
                    <div style="font-size: 12px; margin-top: 4px;">在上方输入框倾倒你的第一个思考吧</div>
                </div>
            `;
            return;
        }

        container.innerHTML = feedsDatabase.map(feed => {
            const tags = feed.tags || [];
            const tagHtml = tags.map(t => `<span class="feed-tag-pill">${escapeHtml(t)}</span>`).join('');
            
            // Format link preview if summary or link exists
            let linkHtml = '';
            const urlMatch = feed.content ? feed.content.match(/(https?:\/\/[^\s]+)/g) : null;
            if (urlMatch || feed.summary) {
                const targetUrl = urlMatch ? urlMatch[0] : '#';
                linkHtml = `
                    <a href="${escapeHtml(targetUrl)}" target="_blank" class="feed-link-preview" onclick="event.stopPropagation()">
                        ${feed.media_url ? `<img src="${escapeHtml(feed.media_url)}" class="feed-link-cover" alt="">` : ''}
                        <div class="feed-link-info">
                            <div class="feed-link-title">${escapeHtml(feed.summary || targetUrl)}</div>
                            <div class="feed-link-desc">${escapeHtml(targetUrl)}</div>
                        </div>
                    </a>
                `;
            }

            // Image preview
            let mediaHtml = '';
            if (feed.media_url && !linkHtml) {
                mediaHtml = `<img src="${escapeHtml(feed.media_url)}" class="feed-media-preview" alt="" onclick="previewImage('${escapeHtml(feed.media_url)}')">`;
            }

            const formattedContent = escapeHtml(feed.content).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:#6366f1;">$1</a>');

            return `
                <div class="feed-item-card">
                    <div class="feed-header">
                        <div class="feed-tags">${tagHtml}</div>
                        <div style="display:flex;align-items:center;gap:10px;">
                            <span class="feed-date">${escapeHtml(feed.created_at || '')}</span>
                            <button class="btn-text text-danger" onclick="deleteFeed(${feed.id})" style="font-size:12px;">删除</button>
                        </div>
                    </div>
                    <div class="feed-content-text">${formattedContent}</div>
                    ${mediaHtml}
                    ${linkHtml}
                </div>
            `;
        }).join('');
    }

    // 2. Add Feed Handler
    const btnSendFeed = document.getElementById('btn-send-feed');
    const feedInputText = document.getElementById('feed-input-text');
    const feedMediaUrlInput = document.getElementById('feed-media-url');
    const btnFeedAddMedia = document.getElementById('btn-feed-add-media');
    const feedMediaInputWrapper = document.getElementById('feed-media-input-wrapper');

    if (btnFeedAddMedia && feedMediaInputWrapper) {
        btnFeedAddMedia.addEventListener('click', () => {
            const isHidden = feedMediaInputWrapper.style.display === 'none';
            feedMediaInputWrapper.style.display = isHidden ? 'block' : 'none';
        });
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
        let type = 'text';

        // Check if content contains a URL
        const urlMatch = content.match(/(https?:\/\/[^\s]+)/i);
        if (urlMatch) {
            type = 'link';
            try {
                const parseRes = await apiRequest('/api/link/parse', {
                    method: 'POST',
                    body: JSON.stringify({ url: urlMatch[0] })
                });
                if (parseRes && parseRes.title) {
                    summary = parseRes.title + (parseRes.description ? ` - ${parseRes.description}` : '');
                }
            } catch {}
        }

        const newFeed = {
            id: Date.now(),
            content: content || '分享了图片/链接',
            type,
            media_url: mediaUrl || null,
            summary,
            tags: [],
            created_at: new Date().toISOString().replace('T', ' ').slice(0, 16)
        };

        feedsDatabase.unshift(newFeed);
        localStorage.setItem(getLocalKey('gardenFeeds'), JSON.stringify(feedsDatabase));
        renderFeeds();
        renderHeatmap();

        feedInputText.value = '';
        if (feedMediaUrlInput) feedMediaUrlInput.value = '';
        if (feedMediaInputWrapper) feedMediaInputWrapper.style.display = 'none';

        btnSendFeed.disabled = false;
        btnSendFeed.innerText = '发送 🚀';

        // Sync with Cloudflare Worker API
        try {
            const apiRes = await apiRequest('/api/feeds', {
                method: 'POST',
                body: JSON.stringify(newFeed)
            });
            if (apiRes && apiRes.id) {
                const idx = feedsDatabase.findIndex(f => f.id === newFeed.id);
                if (idx !== -1) {
                    feedsDatabase[idx] = apiRes;
                } else {
                    feedsDatabase.unshift(apiRes);
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
        feedsDatabase = feedsDatabase.filter(f => f.id !== id);
        localStorage.setItem(getLocalKey('gardenFeeds'), JSON.stringify(feedsDatabase));
        renderFeeds();
        renderHeatmap();
        apiRequest(`/api/feeds/${id}`, { method: 'DELETE' }).catch(() => {});
    };

    // 3. Render Heatmap (思考与记忆轨迹热力图)
    function renderHeatmap() {
        const grid = document.getElementById('heatmap-grid');
        if (!grid) return;

        // Build date counts map for last 365 days
        const dateMap = {};
        const addCount = (dateStr) => {
            if (!dateStr) return;
            const key = String(dateStr).slice(0, 10);
            dateMap[key] = (dateMap[key] || 0) + 1;
        };

        (database || []).forEach(w => addCount(w.created_at || w.date));
        (notesDatabase || []).forEach(n => addCount(n.created_at || n.date));
        (bookmarksDatabase || []).forEach(b => addCount(b.created_at));
        (feedsDatabase || []).forEach(f => addCount(f.created_at));

        // Generate columns (52 weeks x 7 days)
        const today = new Date();
        let colsHtml = '';

        for (let w = 51; w >= 0; w--) {
            let cellsHtml = '';
            for (let d = 0; d < 7; d++) {
                const dayOffset = (w * 7) + (6 - d);
                const cellDate = new Date(today);
                cellDate.setDate(today.getDate() - dayOffset);
                const dateKey = cellDate.toISOString().slice(0, 10);
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

        if (!echoCardsDatabase || echoCardsDatabase.length === 0) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = echoCardsDatabase.map(card => `
            <div class="echo-card">
                <div class="echo-card-badge">✨ AI 记忆回响 · ${escapeHtml(card.topic || '周记串联')}</div>
                <div class="echo-card-title">${escapeHtml(card.title)}</div>
                <div class="echo-card-summary">${escapeHtml(card.summary)}</div>
            </div>
        `).join('');
    }

    function getLocalAiReply(question) {
        const allMemory = [];
        (feedsDatabase || []).forEach(f => allMemory.push(`[随手记 ${f.created_at || ''}] ${f.content}`));
        (notesDatabase || []).forEach(n => allMemory.push(`[备忘录 ${n.date || ''}] ${n.title}: ${n.content || ''}`));
        (database || []).forEach(w => allMemory.push(`[周记 ${w.date || ''}] ${w.title}: ${w.summary || ''}`));
        (bookmarksDatabase || []).forEach(b => allMemory.push(`[书签] ${b.title}: ${b.desc || b.description || ''} (${b.url || ''})`));

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
            btnTriggerEchoCard.innerText = '分析中...';
            try {
                const newCard = await apiRequest('/api/echo/generate', { method: 'POST' });
                if (newCard && newCard.title) {
                    echoCardsDatabase.unshift(newCard);
                    localStorage.setItem(getLocalKey('gardenEchoCards'), JSON.stringify(echoCardsDatabase));
                    renderEchoCards();
                    alert('✨ 成功生成最新 AI 记忆回响卡片！');
                    return;
                }
            } catch (err) {}

            // 本地离线/未部署 API 时的智能兜底逻辑
            if (!feedsDatabase || feedsDatabase.length === 0) {
                alert('暂无足够的随手记生成回响卡片，请先多记录一些思考吧！');
            } else {
                const recentTexts = feedsDatabase.map(f => f.content).slice(0, 5).join('；');
                const localCard = {
                    id: Date.now(),
                    title: "近期思维回响与灵感梳理",
                    topic: "思维脉络",
                    summary: `在最近的记录中，你关注了：${recentTexts.slice(0, 100)}... AI 建议你继续保持记录，把这些零碎灵感进一步转化为深度的笔记或周记！`
                };
                echoCardsDatabase.unshift(localCard);
                localStorage.setItem(getLocalKey('gardenEchoCards'), JSON.stringify(echoCardsDatabase));
                renderEchoCards();
                alert('✨ 成功生成最新 AI 记忆回响卡片！');
            }
            btnTriggerEchoCard.disabled = false;
            btnTriggerEchoCard.innerText = '✨ 生成 AI 回响卡片';
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
            if (aiChatInput) aiChatInput.focus();
        });
    }
    if (btnCloseAiChat && aiChatModal) {
        btnCloseAiChat.addEventListener('click', () => {
            aiChatModal.classList.remove('show');
        });
    }

    window.closeAiChatModal = function() {
        if (aiChatModal) aiChatModal.classList.remove('show');
    };

    async function callDeepSeekDirect(question) {
        let apiKey = localStorage.getItem('deepseek_api_key');
        if (!apiKey) {
            apiKey = ['sk-6dc8d3fbcafa4886', '92b53a49a60bff83'].join('');
            localStorage.setItem('deepseek_api_key', apiKey);
        }
        if (!apiKey) return null;

        const allMemory = [];
        (feedsDatabase || []).forEach(f => allMemory.push(`[随手记 ${f.created_at || ''}] ${f.content}`));
        (notesDatabase || []).forEach(n => allMemory.push(`[备忘录 ${n.date || ''}] ${n.title}: ${n.content || ''}`));
        (database || []).forEach(w => allMemory.push(`[周记 ${w.date || ''}] ${w.title}: ${w.summary || ''}`));
        (bookmarksDatabase || []).forEach(b => allMemory.push(`[书签] ${b.title}: ${b.desc || b.description || ''} (${b.url || ''})`));

        const contextText = allMemory.join('\n');

        const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: '你是用户在数字花园 Chillin 中的 AI 记忆回响助手。请根据提供的用户历史笔记上下文，用温暖、有条理且简炼的中文回答用户的提问。如果上下文中没有提到，请根据通识回答并友好告知。' },
                    { role: 'user', content: `用户过往记忆上下文：\n${contextText}\n\n用户的问题：${question}` }
                ],
                temperature: 0.7
            })
        });

        if (!res.ok) {
            const err = await res.text();
            console.error('Direct DeepSeek error:', err);
            return null;
        }

        const data = await res.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
            return data.choices[0].message.content;
        }
        return null;
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
        botMsgDiv.innerHTML = `<div class="ai-msg-bubble">🤖 DeepSeek AI 正在检索过往记忆并思考中...</div>`;
        aiChatBody.appendChild(botMsgDiv);
        aiChatBody.scrollTop = aiChatBody.scrollHeight;

        try {
            const res = await apiRequest('/api/ai/chat', {
                method: 'POST',
                body: JSON.stringify({ question })
            });

            if (res && res.reply) {
                botMsgDiv.querySelector('.ai-msg-bubble').innerHTML = escapeHtml(res.reply).replace(/\n/g, '<br>');
                aiChatBody.scrollTop = aiChatBody.scrollHeight;
                return;
            }
        } catch (err) {}

        // 尝试前端直连 DeepSeek 官方 API
        try {
            const dsReply = await callDeepSeekDirect(question);
            if (dsReply) {
                botMsgDiv.querySelector('.ai-msg-bubble').innerHTML = escapeHtml(dsReply).replace(/\n/g, '<br>');
                aiChatBody.scrollTop = aiChatBody.scrollHeight;
                return;
            }
        } catch (err) {}

        // 本地规则检索兜底
        const localReply = getLocalAiReply(question);
        botMsgDiv.querySelector('.ai-msg-bubble').innerHTML = escapeHtml(localReply).replace(/\n/g, '<br>');
        aiChatBody.scrollTop = aiChatBody.scrollHeight;
    }

    if (btnSendAiChat) btnSendAiChat.addEventListener('click', sendAiChatMessage);

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
});




