document.addEventListener('DOMContentLoaded', () => {

    // ==========================================
    // 0. 全局轻提示与防碰撞 ID 生成器
    // ==========================================
    let aiChatHistory = [];

    function generateUniqueId() {
        return Date.now() * 1000 + Math.floor(Math.random() * 1000);
    }

    function showToast(msg, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) {
            console.log(`[Toast ${type}] ${msg}`);
            return;
        }
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
        toast.innerHTML = `<span>${icon}</span> <span>${escapeHtml(msg)}</span>`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
            toast.style.transition = 'all 0.25s ease';
            setTimeout(() => toast.remove(), 250);
        }, 3000);
    }

    async function registerPushNotification() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
        try {
            const reg = await navigator.serviceWorker.ready;
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') return;

            const existingSub = await reg.pushManager.getSubscription();
            if (existingSub) {
                await sendSubscriptionToServer(existingSub);
                return;
            }

            const VAPID_PUBLIC_KEY = 'BG6qXQUDG6-gKkP3e2T4s4WBL22226fyU0N4QS_mkCCDW-M-5l3Ma44V5Mgw8ILke_dBrOzvsMbxkNW4lL_4Mtg';
            const convertedVapidKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
            
            const subscription = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: convertedVapidKey
            });
            await sendSubscriptionToServer(subscription);
        } catch (e) {
            console.error('Push registration failed:', e);
        }
    }

    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    async function sendSubscriptionToServer(subscription) {
        try {
            await apiRequest('/api/push/subscribe', {
                method: 'POST',
                body: JSON.stringify(subscription)
            });
        } catch (e) {
            console.error('Failed to send subscription:', e);
        }
    }

    // ==========================================
    // 1. 数据持久化与认证逻辑
    // ==========================================
    // 智能动态基地址：同源 Pages 代理优先（避免移动端跨域及 DNS 阻断），非同源降级直连 Worker
    let API_BASE = '';
    if (typeof CHILLIN_API_URL !== 'undefined' && CHILLIN_API_URL) {
        API_BASE = CHILLIN_API_URL;
    } else if (window.location.protocol === 'file:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        // 原生壳/本地调试：走 Pages 同源代理更可靠（workers.dev 在部分网络下不可达）
        API_BASE = 'https://chillin-bfc.pages.dev';
    } else {
        // 线上 Cloudflare Pages 部署环境 (chillin-bfc.pages.dev) 优先使用同源 /api 代理
        API_BASE = '';
    }
    const CLOUD_WORKER_BASE = 'https://chillin-api.2089700996jy.workers.dev';

    // 原生壳里相对路径 /api/... 会解析到 localhost，需转成绝对地址（网页端 API_BASE 为空则保持相对）
    const resolveAssetUrl = (src) => {
        if (src && API_BASE && (src.startsWith('/api/') || src.startsWith('/uploads/'))) {
            return API_BASE + src;
        }
        return src;
    };

    // 双端自动降级 Fetch（同源与直连自动容灾，解决移动端 Failed to fetch）
    const fetchWithFallback = async (path, options = {}) => {
        const primaryUrl = `${API_BASE}${path}`;
        try {
            const res = await fetch(primaryUrl, options);
            return res;
        } catch (primaryErr) {
            // 如果同源 /api 失败且是在线上域名，自动降级尝试跨域直连 Cloudflare Worker
            if (API_BASE === '' && (primaryErr.name === 'TypeError' || primaryErr.message.includes('fetch'))) {
                const secondaryUrl = `${CLOUD_WORKER_BASE}${path}`;
                return await fetch(secondaryUrl, options);
            }
            throw primaryErr;
        }
    };

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

    let isRegisterMode = false;

    // 显示/隐藏认证覆盖层及导航栏
    const checkAuth = () => {
        if (!authToken) {
            authOverlay.classList.remove('hidden');
            document.body.classList.add('not-authenticated');
            return false;
        }
        authOverlay.classList.add('hidden');
        document.body.classList.remove('not-authenticated');
        if (authUser) navUsername.innerText = `Hi, ${authUser.username}`;
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

    const doLogin = async () => {
        const username = document.getElementById('auth-username').value.trim();
        const password = document.getElementById('auth-password').value.trim();
        const btnAuthSubmit = document.getElementById('btn-auth-submit');
        authErrorMsg.style.display = 'none';
        if (!username || !password) {
            authErrorMsg.innerText = '请输入账号和密码';
            authErrorMsg.style.display = 'block';
            return;
        }

        if (btnAuthSubmit) {
            btnAuthSubmit.disabled = true;
            btnAuthSubmit.innerText = isRegisterMode ? '注册中...' : '登录中...';
        }

        try {
            const endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
            if (isRegisterMode) {
                if (username.length < 3 || username.length > 32) {
                    throw new Error('账号长度需为 3–32 位');
                }
                if (password.length < 8) {
                    throw new Error('密码至少 8 位');
                }
                if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
                    throw new Error('密码需同时包含字母和数字');
                }
            }
            const res = await fetchWithFallback(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '登录失败，请检查账号和密码');

            authToken = data.token;
            authUser = { id: data.userId, username: data.username };
            localStorage.setItem('chillin_token', authToken);
            localStorage.setItem('chillin_user', JSON.stringify(authUser));
            
            checkAuth();
            showToast('登录成功，欢迎来到数字花园', 'success');
            loadLocalData(); // Reload local cache for new user
            syncFromApi();   // Fetch new API data immediately
            checkAndMergeGuestData();
            setTimeout(registerPushNotification, 2000); // Request push permission after 2s

        } catch (err) {
            const errorMsg = (err.message === 'Failed to fetch' || err.name === 'TypeError')
                ? '网络连接失败，请检查手机网络后重试'
                : (err.message || '登录失败');
            authErrorMsg.innerText = errorMsg;
            authErrorMsg.style.display = 'block';
            showToast(errorMsg, 'error');
        } finally {
            if (btnAuthSubmit) {
                btnAuthSubmit.disabled = false;
                btnAuthSubmit.innerText = isRegisterMode ? '注册并进入' : '登录';
            }
        }
    };

    // 挂载到全局 window，HTML inline onclick 也能调用
    window._chillinLogin = doLogin;
    document.getElementById('btn-auth-submit').addEventListener('click', doLogin);
    document.getElementById('auth-password').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doLogin();
    });
    document.getElementById('auth-username').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('auth-password').focus();
    });

    const apiRequest = async (path, options = {}) => {
        const timeoutMs = options.timeout || 25000;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const headers = {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            };
            if (authToken) {
                headers['Authorization'] = `Bearer ${authToken}`;
            }

            const res = await fetchWithFallback(path, {
                ...options,
                signal: controller.signal,
                headers
            });
            
            if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/register') {
                // 防范极速连续请求与边缘同步延迟：单次 401 进行 300ms 重试一次
                if (!options._isRetry) {
                    await new Promise(r => setTimeout(r, 300));
                    return await apiRequest(path, { ...options, _isRetry: true });
                }
                logout();
                throw new Error('未登录或登录状态已过期，请重新登录');
            }
            if (!res.ok) {
                let detail = '';
                try {
                    const errBody = await res.json();
                    detail = errBody && errBody.error ? String(errBody.error) : '';
                } catch (_) {}
                throw new Error(detail || `接口请求异常 (${res.status})`);
            }
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

    // 自动扫描与挽救当前设备上的所有历史 LocalStorage 数据（无论前缀是 default_、数字ID_ 或无前缀，防止切账号或升级导致数据丢失）
    const rescueAndConsolidateLocalData = () => {
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
        } catch(e) {}

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
    };

    // 立即从本地全量安全缓存加载，保证页面秒开且绝不丢失手机原数据
    const loadLocalData = () => {
        const rescued = rescueAndConsolidateLocalData();

        const currentFeeds = JSON.parse(localStorage.getItem(getLocalKey('gardenFeeds'))) || [];
        const currentNotes = JSON.parse(localStorage.getItem('gardenNotes')) || JSON.parse(localStorage.getItem(getLocalKey('gardenNotes'))) || [];
        const currentData = JSON.parse(localStorage.getItem('gardenData')) || JSON.parse(localStorage.getItem(getLocalKey('gardenData'))) || [];
        const currentBookmarks = JSON.parse(localStorage.getItem('gardenBookmarks')) || JSON.parse(localStorage.getItem(getLocalKey('gardenBookmarks'))) || [];

        database = mergeDataLists(currentData, rescued.weeklies.length > 0 ? rescued.weeklies : DEFAULT_WEEKLY);
        notesDatabase = mergeDataLists(currentNotes, rescued.notes.length > 0 ? rescued.notes : DEFAULT_NOTES);
        bookmarksDatabase = mergeDataLists(currentBookmarks, rescued.bookmarks.length > 0 ? rescued.bookmarks : DEFAULT_BOOKMARKS);
        feedsDatabase = mergeDataLists(currentFeeds, rescued.feeds.length > 0 ? rescued.feeds : DEFAULT_FEEDS);
        echoCardsDatabase = JSON.parse(localStorage.getItem(getLocalKey('gardenEchoCards'))) || [];

        if (authUser) {
            saveDatabase();
            saveNotesDatabase();
            saveBookmarksDatabase();
            saveFeedsDatabase();
        }

        renderCards();
        renderNotes();
        renderBookmarks();
        renderFeeds();
        renderEchoCards();
        renderHeatmap();
    };

    // 已同步与已删除 Tombstones 机制，防止已删除项目在多端智能合并时“死而复活”
    const getSyncedIds = () => {
        try {
            return JSON.parse(localStorage.getItem(getLocalKey('gardenSyncedIds'))) || [];
        } catch(e) { return []; }
    };
    const addSyncedIds = (ids) => {
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
    };

    const getDeletedIds = () => {
        try {
            return JSON.parse(localStorage.getItem(getLocalKey('gardenDeletedIds'))) || [];
        } catch(e) { return []; }
    };
    const addDeletedId = (id) => {
        if (!id) return;
        const current = getDeletedIds();
        const str = String(id);
        if (!current.includes(str)) {
            current.push(str);
            localStorage.setItem(getLocalKey('gardenDeletedIds'), JSON.stringify(current));
        }
    };

    // 解析 updated_at（支持 ISO / SQLite datetime）
    const toUpdatedTs = (value) => {
        if (value == null || value === '') return 0;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        const raw = String(value).trim();
        if (!raw) return 0;
        if (/^\d+$/.test(raw)) return Number(raw);
        let s = raw.includes('T') ? raw : raw.replace(' ', 'T');
        if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
        const t = Date.parse(s);
        return Number.isFinite(t) ? t : 0;
    };

    const stampLocalUpdate = (item) => {
        if (!item || typeof item !== 'object') return item;
        item.updated_at = new Date().toISOString();
        item._dirty = true;
        return item;
    };

    const stripClientSyncFlags = (item) => {
        if (!item || typeof item !== 'object') return item;
        const copy = { ...item };
        delete copy._dirty;
        return copy;
    };

    // 通用双向合并：同 ID 取 updated_at 较新者，避免云端旧数据覆盖本地未同步编辑
    const mergeDataLists = (localList, apiList) => {
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
    };

    // 智能处理 API 同步结果：处理其他端删除同步与本地新添加/较新编辑上传
    const processApiSyncResult = (localList, apiData) => {
        if (!Array.isArray(apiData)) return { merged: localList || [], needsUpload: false };
        const deletedIds = getDeletedIds();
        const syncedIds = getSyncedIds();

        const apiIds = apiData.map(item => String(item.id));
        addSyncedIds(apiIds);

        const activeLocal = (localList || []).filter(item => {
            if (!item || item.id == null) return false;
            const strId = String(item.id);
            if (deletedIds.includes(strId)) return false;
            // 本地有未同步脏数据时，即使云端暂时看不到也不要当「他端已删」丢掉
            if (item._dirty) return true;
            if (syncedIds.includes(strId) && !apiIds.includes(strId)) return false;
            return true;
        });

        const merged = mergeDataLists(activeLocal, apiData);

        const unsyncedLocal = activeLocal.filter(item => !apiIds.includes(String(item.id)));
        const newerDirtyLocal = activeLocal.filter(item => {
            if (!item._dirty) return false;
            const cloud = apiData.find(a => String(a.id) === String(item.id));
            if (!cloud) return false;
            return toUpdatedTs(item.updated_at) >= toUpdatedTs(cloud.updated_at);
        });
        const needsUpload = unsyncedLocal.length > 0 || newerDirtyLocal.length > 0;

        return { merged, needsUpload };
    };

    let syncStatusTimer = null;
    const setSyncStatus = (message, tone = 'info', autoHideMs = 0) => {
        const el = document.getElementById('sync-status');
        if (!el) return;
        if (!message) {
            el.hidden = true;
            el.textContent = '';
            return;
        }
        el.hidden = false;
        el.textContent = message;
        el.dataset.tone = tone;
        if (syncStatusTimer) clearTimeout(syncStatusTimer);
        if (autoHideMs > 0) {
            syncStatusTimer = setTimeout(() => {
                if (el.textContent === message) {
                    el.hidden = true;
                    el.textContent = '';
                }
            }, autoHideMs);
        }
    };

    const getActiveViewId = () => document.querySelector('.view-section.active')?.id || '';

    const isProtectingLocalEdits = () => {
        const id = getActiveViewId();
        return id === 'view-editor' || id === 'view-note-editor' || id === 'view-bookmark-editor';
    };

    // 后台无感自动同步 API 最新数据（有变化则静默刷新；编辑中不重绘，避免打断输入）
    let isSyncingInBg = false;
    let pendingSyncRetryTimer = null;
    const syncFromApi = async () => {
        if (!authToken || isSyncingInBg) return;
        isSyncingInBg = true;
        let needsBatchUpload = false;
        let hadError = false;

        try {
            // 周记
            try {
                const apiData = await apiRequest('/api/weeklies');
                if (Array.isArray(apiData)) {
                    const { merged, needsUpload } = processApiSyncResult(database, apiData);
                    if (needsUpload) needsBatchUpload = true;
                    if (JSON.stringify(database) !== JSON.stringify(merged)) {
                        database = merged;
                        saveDatabase();
                        if (getActiveViewId() === 'view-home') {
                            renderCards(document.querySelector('.filter-btn.active')?.dataset.filter || 'all');
                        }
                    }
                }
            } catch (e) { hadError = true; }

            // 笔记
            try {
                const apiData = await apiRequest('/api/notes');
                if (Array.isArray(apiData)) {
                    const { merged, needsUpload } = processApiSyncResult(notesDatabase, apiData);
                    if (needsUpload) needsBatchUpload = true;
                    if (JSON.stringify(notesDatabase) !== JSON.stringify(merged)) {
                        notesDatabase = merged;
                        saveNotesDatabase();
                        if (getActiveViewId() === 'view-notes') renderNotes();
                    }
                }
            } catch (e) { hadError = true; }

            // 收藏
            try {
                const apiData = await apiRequest('/api/bookmarks');
                if (Array.isArray(apiData)) {
                    const { merged, needsUpload } = processApiSyncResult(bookmarksDatabase, apiData);
                    if (needsUpload) needsBatchUpload = true;
                    if (JSON.stringify(bookmarksDatabase) !== JSON.stringify(merged)) {
                        bookmarksDatabase = merged;
                        saveBookmarksDatabase();
                        if (getActiveViewId() === 'view-bookmarks') renderBookmarks();
                    }
                }
            } catch (e) { hadError = true; }

            // 随手记
            try {
                const apiData = await apiRequest('/api/feeds');
                if (Array.isArray(apiData)) {
                    const { merged, needsUpload } = processApiSyncResult(feedsDatabase, apiData);
                    if (needsUpload) needsBatchUpload = true;
                    if (JSON.stringify(feedsDatabase) !== JSON.stringify(merged)) {
                        feedsDatabase = merged;
                        saveFeedsDatabase();
                        if (getActiveViewId() === 'view-feeds' && !isProtectingLocalEdits()) renderFeeds();
                    }
                }
            } catch (e) { hadError = true; }

            // 本地未上传 / 较新脏数据 → 批量补传
            if (needsBatchUpload) {
                try {
                    await apiRequest('/api/sync/batch', {
                        method: 'POST',
                        body: JSON.stringify({
                            weeklies: database.map(stripClientSyncFlags),
                            notes: notesDatabase.map(stripClientSyncFlags),
                            bookmarks: bookmarksDatabase.map(stripClientSyncFlags),
                            feeds: feedsDatabase.map(stripClientSyncFlags)
                        })
                    });
                    database.forEach(i => { if (i) i._dirty = false; });
                    notesDatabase.forEach(i => { if (i) i._dirty = false; });
                    bookmarksDatabase.forEach(i => { if (i) i._dirty = false; });
                    feedsDatabase.forEach(i => { if (i) i._dirty = false; });
                    saveDatabase(); saveNotesDatabase(); saveBookmarksDatabase(); saveFeedsDatabase();
                    setSyncStatus('已同步', 'ok', 2000);
                } catch (e) {
                    hadError = true;
                    setSyncStatus('未同步 · 将重试', 'warn');
                }
            }

            // 回响卡片
            try {
                const apiData = await apiRequest('/api/echo/cards');
                if (Array.isArray(apiData)) {
                    if (JSON.stringify(echoCardsDatabase) !== JSON.stringify(apiData)) {
                        echoCardsDatabase = apiData;
                        localStorage.setItem(getLocalKey('gardenEchoCards'), JSON.stringify(echoCardsDatabase));
                        if (getActiveViewId() === 'view-feeds' || getActiveViewId() === 'view-home') {
                            renderEchoCards();
                        }
                    }
                }
            } catch (e) { hadError = true; }

            if (!isProtectingLocalEdits() && (getActiveViewId() === 'view-home' || getActiveViewId() === 'view-feeds')) {
                renderHeatmap();
            }

            if (hadError) {
                setSyncStatus('同步异常 · 将重试', 'warn');
                if (!pendingSyncRetryTimer) {
                    pendingSyncRetryTimer = setTimeout(() => {
                        pendingSyncRetryTimer = null;
                        syncFromApi();
                    }, 12000);
                }
            }
        } finally {
            isSyncingInBg = false;
        }
    };

    const saveDatabase = () => localStorage.setItem(getLocalKey('gardenData'), JSON.stringify(database));
    const saveNotesDatabase = () => localStorage.setItem(getLocalKey('gardenNotes'), JSON.stringify(notesDatabase));
    const saveBookmarksDatabase = () => localStorage.setItem(getLocalKey('gardenBookmarks'), JSON.stringify(bookmarksDatabase));
    const saveFeedsDatabase = () => localStorage.setItem(getLocalKey('gardenFeeds'), JSON.stringify(feedsDatabase));

    // API 同步辅助：失败可见并触发重试，不再静默吞掉
    const markSyncedItem = (item) => {
        if (!item || item.id == null) return;
        item._dirty = false;
        if (!item.updated_at) item.updated_at = new Date().toISOString();
        addSyncedIds([item.id]);
    };

    const handleSyncFailure = (err) => {
        console.warn('[sync] failed:', err);
        setSyncStatus('未同步 · 将重试', 'warn');
        if (!pendingSyncRetryTimer) {
            pendingSyncRetryTimer = setTimeout(() => {
                pendingSyncRetryTimer = null;
                syncFromApi();
            }, 8000);
        }
    };

    const apiSyncWeekly = (item, method) => {
        const payload = method === 'DELETE' ? item : stampLocalUpdate({ ...item });
        if (method !== 'DELETE' && item) {
            item.updated_at = payload.updated_at;
            item._dirty = true;
        }
        const bm = method === 'DELETE' ? { method: 'DELETE' } : { method, body: JSON.stringify(stripClientSyncFlags(payload)) };
        const id = method === 'POST' ? '' : `/${item.id}`;
        return apiRequest(`/api/weeklies${id}`, bm).then((res) => {
            if (method !== 'DELETE') markSyncedItem(item);
            setSyncStatus('已同步', 'ok', 1800);
            return res;
        }).catch((err) => { handleSyncFailure(err); return null; });
    };
    const apiSyncNote = (item, method) => {
        const payload = method === 'DELETE' ? item : stampLocalUpdate({ ...item });
        if (method !== 'DELETE' && item) {
            item.updated_at = payload.updated_at;
            item._dirty = true;
        }
        const bm = method === 'DELETE' ? { method: 'DELETE' } : { method, body: JSON.stringify(stripClientSyncFlags(payload)) };
        const id = method === 'POST' ? '' : `/${item.id}`;
        return apiRequest(`/api/notes${id}`, bm).then((res) => {
            if (method !== 'DELETE') markSyncedItem(item);
            setSyncStatus('已同步', 'ok', 1800);
            return res;
        }).catch((err) => { handleSyncFailure(err); return null; });
    };
    const apiSyncBookmark = (item, method) => {
        const payload = method === 'DELETE' ? item : stampLocalUpdate({ ...item });
        if (method !== 'DELETE' && item) {
            item.updated_at = payload.updated_at;
            item._dirty = true;
        }
        const bm = method === 'DELETE' ? { method: 'DELETE' } : { method, body: JSON.stringify(stripClientSyncFlags(payload)) };
        const id = method === 'POST' ? '' : `/${item.id}`;
        return apiRequest(`/api/bookmarks${id}`, bm).then((res) => {
            if (method !== 'DELETE') markSyncedItem(item);
            setSyncStatus('已同步', 'ok', 1800);
            return res;
        }).catch((err) => { handleSyncFailure(err); return null; });
    };
    const apiSyncFeed = (item, method) => {
        const payload = method === 'DELETE' ? item : stampLocalUpdate({ ...item });
        if (method !== 'DELETE' && item) {
            item.updated_at = payload.updated_at;
            item._dirty = true;
        }
        const bm = method === 'DELETE' ? { method: 'DELETE' } : { method, body: JSON.stringify(stripClientSyncFlags(payload)) };
        const id = method === 'POST' ? '' : `/${item.id}`;
        return apiRequest(`/api/feeds${id}`, bm).then((res) => {
            if (method !== 'DELETE') markSyncedItem(item);
            setSyncStatus('已同步', 'ok', 1800);
            return res;
        }).catch((err) => { handleSyncFailure(err); return null; });
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

    // 把 AI 返回的 Markdown 转成安全 HTML（先转义防 XSS，再做轻量格式化），用于对话/本周回顾展示
    const markdownToHtml = (text) => {
        if (!text) return '';
        const lines = escapeHtml(text).split('\n');
        let html = '';
        let inUl = false, inOl = false;
        const closeLists = () => {
            if (inUl) { html += '</ul>'; inUl = false; }
            if (inOl) { html += '</ol>'; inOl = false; }
        };
        const inline = (s) => s
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
        for (const raw of lines) {
            const line = raw.replace(/[ \t]+$/, '');
            const h = line.match(/^(#{1,6})\s+(.*)$/);
            if (h) {
                closeLists();
                const lv = h[1].length;
                html += `<h${lv}>${inline(h[2])}</h${lv}>`;
                continue;
            }
            const ul = line.match(/^\s*[-*]\s+(.*)$/);
            if (ul) {
                if (!inUl) { closeLists(); html += '<ul>'; inUl = true; }
                html += `<li>${inline(ul[1])}</li>`;
                continue;
            }
            const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
            if (ol) {
                if (!inOl) { closeLists(); html += '<ol>'; inOl = true; }
                html += `<li>${inline(ol[1])}</li>`;
                continue;
            }
            if (line.trim() === '') { closeLists(); continue; }
            closeLists();
            html += `<p>${inline(line)}</p>`;
        }
        closeLists();
        return html;
    };

    // 用 DOMPurify 白名单清洗用户可控的 HTML（正文支持标签，但必须防存储型 XSS）；
    // 若 CDN 未加载成功，则退化为纯文本转义，保证安全优先。
    const sanitizeHtml = (html) => {
        if (typeof window.DOMPurify !== 'undefined' && window.DOMPurify.sanitize) {
            return window.DOMPurify.sanitize(String(html || ''));
        }
        return escapeHtml(html);
    };

    const autoResizeTextarea = (el) => {
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
    };
    editNoteContent.addEventListener('input', () => autoResizeTextarea(editNoteContent));


    // ==========================================
    // 3. 视图切换逻辑（History 返回栈）
    // ==========================================
    const MAIN_VIEWS = new Set(['home', 'feeds', 'notes', 'bookmarks', 'reader']);
    let historyNavLock = false;
    let aiModalInHistory = false;

    const buildHashForView = (viewId) => {
        if (viewId === 'article' && currentArticleId != null) return `#/article/${currentArticleId}`;
        if (viewId === 'editor') {
            const id = document.getElementById('edit-id')?.value;
            return id ? `#/editor/${id}` : '#/editor';
        }
        if (viewId === 'note-editor') {
            const id = currentNoteId || document.getElementById('edit-note-id')?.value;
            return id ? `#/note-editor/${id}` : '#/note-editor';
        }
        if (viewId === 'bookmark-editor') return '#/bookmark-editor';
        if (viewId === 'reader-book') return '#/reader-book';
        if (viewId === 'ai') return '#/ai';
        return `#/${viewId || 'home'}`;
    };

    const parseHashRoute = (hash = location.hash) => {
        const raw = String(hash || '').replace(/^#\/?/, '').trim();
        if (!raw) return { view: 'home' };
        const [view, id] = raw.split('/');
        return { view: view || 'home', id: id || null };
    };

    const applyRoute = (route) => {
        if (!route || !route.view) return;
        if (route.view === 'ai') {
            const modal = document.getElementById('ai-chat-modal');
            if (modal) modal.classList.add('show');
            aiModalInHistory = true;
            return;
        }
        const modal = document.getElementById('ai-chat-modal');
        if (modal) modal.classList.remove('show');
        aiModalInHistory = false;

        if (route.view === 'article' && route.id) {
            const item = database.find(d => String(d.id) === String(route.id));
            if (item) {
                openArticle(item, { skipHistory: true });
                return;
            }
            switchView('home', { skipHistory: true });
            return;
        }
        if (route.view === 'editor') {
            openWeeklyEditor(route.id ? Number(route.id) || route.id : null, { skipHistory: true });
            return;
        }
        if (route.view === 'note-editor') {
            openNoteEditor(route.id ? Number(route.id) || route.id : null, { skipHistory: true });
            return;
        }
        if (route.view === 'bookmark-editor') {
            switchView('bookmark-editor', { skipHistory: true });
            return;
        }
        if (route.view === 'reader-book') {
            if (getActiveViewId() !== 'view-reader-book') switchView('reader', { skipHistory: true });
            else switchView('reader-book', { skipHistory: true });
            return;
        }
        if (MAIN_VIEWS.has(route.view)) {
            switchView(route.view, { skipHistory: true });
            return;
        }
        switchView('home', { skipHistory: true });
    };

    const switchView = (targetViewId, opts = {}) => {
        const { skipHistory = false, replaceHistory = false } = opts;
        const targetEl = document.getElementById(`view-${targetViewId}`);
        if (!targetEl) return;

        views.forEach(view => view.classList.remove('active'));
        targetEl.classList.add('active');
        
        if (MAIN_VIEWS.has(targetViewId)) {
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
            fabBtn.style.display = 'none';
            if (mobileBottomNav) {
                mobileBottomNav.style.display = 'none';
                mobileBottomNav.classList.add('hidden');
            }
            document.body.classList.add('hide-bottom-nav');
        } else {
            navMenu.style.display = '';
            btnBack.style.display = 'none';
            if (mobileBottomNav) {
                mobileBottomNav.style.display = '';
                mobileBottomNav.classList.remove('hidden');
            }
            document.body.classList.remove('hide-bottom-nav');

            // 随手记页面已有页内倾倒框，隐藏右下角悬浮 + 按钮
            if (targetViewId === 'feeds') {
                fabBtn.classList.add('hidden');
                fabBtn.style.display = 'none';
            } else {
                fabBtn.classList.remove('hidden');
                fabBtn.style.display = '';
            }
        }
        window.scrollTo(0, 0);

        if (!skipHistory && !historyNavLock) {
            const hash = buildHashForView(targetViewId);
            const state = { view: targetViewId, articleId: currentArticleId, noteId: currentNoteId };
            if (replaceHistory || !location.hash) {
                history.replaceState(state, '', hash);
            } else if (location.hash !== hash) {
                history.pushState(state, '', hash);
            } else {
                history.replaceState(state, '', hash);
            }
        }
    };

    const goBackOrHome = () => {
        document.body.classList.remove('dark-reader-body', 'eyecare-reader-body');
        const finish = () => {
            if (window.history.length > 1 && location.hash && !MAIN_VIEWS.has(parseHashRoute().view)) {
                history.back();
                return;
            }
            switchView(currentActiveNavView);
            currentArticleId = null;
            currentNoteId = null;
        };
        const activeView = document.querySelector('.view-section.active');
        if (activeView && activeView.id === 'view-editor') {
            handleExitWeeklyEditor(finish);
        } else {
            finish();
        }
    };

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const targetEl = e.currentTarget || e.target.closest('[data-view]');
            const view = targetEl ? targetEl.dataset.view : null;
            if (view) switchView(view);
        });
    });

    btnBack.addEventListener('click', () => goBackOrHome());

    window.addEventListener('popstate', (e) => {
        const intended = (e.state && e.state.view)
            ? { view: e.state.view, id: e.state.articleId || e.state.noteId || null }
            : parseHashRoute();

        const applyIntended = () => {
            historyNavLock = true;
            try {
                applyRoute(intended);
                let hash = '#/home';
                if (intended.view === 'ai') hash = '#/ai';
                else if (intended.id) hash = `#/${intended.view}/${intended.id}`;
                else hash = `#/${intended.view || 'home'}`;
                history.replaceState(
                    { view: intended.view, articleId: intended.id, noteId: intended.id },
                    '',
                    hash
                );
            } finally {
                historyNavLock = false;
            }
        };

        const activeView = document.querySelector('.view-section.active');
        if (activeView && activeView.id === 'view-editor' && hasUnsavedChanges()) {
            // 先顶回编辑页 hash，避免取消确认后 URL 已离开编辑器
            history.pushState({ view: 'editor', articleId: currentArticleId }, '', buildHashForView('editor'));
            handleExitWeeklyEditor(applyIntended);
            return;
        }
        applyIntended();
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
            let coverHtml = item.cover ? `<img src="${escapeHtml(resolveAssetUrl(item.cover))}" alt="Cover" class="notion-collection-card__cover">` : '';
            
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
        if (data.life && data.life.image) html += `<h2>🍳 烟火日常</h2><div class="widget-polaroid"><img src="${escapeHtml(resolveAssetUrl(data.life.image))}" alt="Life Snapshot"><div class="widget-polaroid-caption">${escapeHtml(data.life.caption)}</div></div>`;
        if (data.podcast) html += `<h2>🎙️ 播客新知</h2><div class="widget-callout"><div class="widget-callout-icon">💡</div><div class="widget-callout-text">${escapeHtml(data.podcast)}</div></div>`;
        if (data.work && data.work.title) html += `<h2>💻 工作切片</h2><div class="widget-work"><div class="widget-work-title">${escapeHtml(data.work.title)}</div><div class="widget-work-desc">${escapeHtml(data.work.desc)}</div></div>`;
        return html;
    };

    const openArticle = (item, opts = {}) => {
        currentArticleId = item.id;
        articleCategory.innerText = item.category;
        articleDate.innerText = item.date;
        articleTitle.innerText = item.title;
        let finalHtml = item.content || '';
        if (item.weeklyData) finalHtml += generateWeeklyWidgetsHtml(item.weeklyData);
        articleBody.innerHTML = sanitizeHtml(finalHtml);
        articleCoverContainer.innerHTML = item.cover ? `<img src="${escapeHtml(resolveAssetUrl(item.cover))}" alt="Cover">` : '';
        
        // 加载记忆片段的追加批注
        document.getElementById('new-weekly-annotation-content').value = '';
        currentWeeklyAnnotations = item.annotations || [];
        renderWeeklyAnnotationsList();
        
        switchView('article', opts);
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

    const openWeeklyEditor = (editId = null, opts = {}) => {
        editorForm.reset();
        if (editId) {
            editorPageTitle.innerText = "编辑记忆";
            const item = database.find(d => d.id === editId || String(d.id) === String(editId));
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
        switchView('editor', opts);
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
        stampLocalUpdate(newData);
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
        if (activeView && activeView.id === 'view-note-editor' && hasUnsavedNoteChanges()) {
            saveNoteDraft();
            e.preventDefault();
            e.returnValue = '';
        }
    });

    btnDeleteArticle.addEventListener('click', () => {
        if(confirm("确定要永久删除这篇记忆吗？")) { 
            const deletedId = currentArticleId; 
            addDeletedId(deletedId);
            database = database.filter(d => d.id !== currentArticleId); 
            saveDatabase(); 
            apiSyncWeekly({id: deletedId}, 'DELETE'); 
            renderCards(); 
            switchView('home'); 
        }
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
            el.setAttribute('data-note-id', String(note.id));
            const previewText = note.content ? escapeHtml(note.content.substring(0, 30)).replace(/\n/g, ' ') + '...' : '无正文内容';
            
            // 如果笔记有批注，显示批注数量气泡
            const annCount = note.annotations && note.annotations.length > 0 ? ` <span class="note-ann-badge">💬 ${note.annotations.length}</span>` : '';
            
            el.innerHTML = `<div class="note-item-content"><div class="note-item-title">${escapeHtml(note.title || '无标题笔记')}${annCount}</div><div class="note-item-preview">${previewText}</div></div><div class="note-item-date">${escapeHtml(note.date)}</div>`;
            el.addEventListener('click', () => openNoteEditor(note.id));
            notesListContainer.appendChild(el);
        });
    };

    const hasUnsavedNoteChanges = () => {
        const titleVal = (editNoteTitle.value || '').trim();
        const contentVal = (editNoteContent.value || '').trim();
        const idStr = editNoteId.value;
        if (idStr) {
            const note = notesDatabase.find(n => String(n.id) === String(idStr));
            if (!note) return titleVal !== '' || contentVal !== '';
            return titleVal !== (note.title || '').trim() || contentVal !== (note.content || '').trim();
        }
        return titleVal !== '' || contentVal !== '';
    };

    const saveNoteDraft = () => {
        const draft = {
            id: editNoteId.value || '',
            title: editNoteTitle.value || '',
            content: editNoteContent.value || '',
            timestamp: Date.now()
        };
        localStorage.setItem(getLocalKey('noteDraft'), JSON.stringify(draft));
    };

    const restoreNoteDraft = () => {
        const draftStr = localStorage.getItem(getLocalKey('noteDraft'));
        if (!draftStr) return;
        try {
            const draft = JSON.parse(draftStr);
            editNoteTitle.value = draft.title || '';
            editNoteContent.value = draft.content || '';
            autoResizeTextarea(editNoteContent);
            document.getElementById('note-draft-tip').style.display = 'none';
        } catch (e) {
            console.error('Failed to restore note draft', e);
        }
    };

    const discardNoteDraft = () => {
        localStorage.removeItem(getLocalKey('noteDraft'));
        const tip = document.getElementById('note-draft-tip');
        if (tip) tip.style.display = 'none';
    };

    const checkAndShowNoteDraftTip = (noteId) => {
        const tipBanner = document.getElementById('note-draft-tip');
        if (!tipBanner) return;
        const draftStr = localStorage.getItem(getLocalKey('noteDraft'));
        if (!draftStr) {
            tipBanner.style.display = 'none';
            return;
        }
        try {
            const draft = JSON.parse(draftStr);
            const currentIdStr = noteId != null && noteId !== '' ? String(noteId) : '';
            const draftIdStr = draft.id ? String(draft.id) : '';
            if (currentIdStr !== draftIdStr) {
                tipBanner.style.display = 'none';
                return;
            }
            const timeEl = document.getElementById('note-draft-time');
            if (timeEl && draft.timestamp) {
                timeEl.innerText = new Date(draft.timestamp).toLocaleString();
            }
            tipBanner.style.display = 'flex';
        } catch (e) {
            tipBanner.style.display = 'none';
        }
    };

    const openNoteEditor = (noteId = null, opts = {}) => {
        document.getElementById('new-annotation-content').value = '';
        if (noteId) {
            currentNoteId = noteId; const note = notesDatabase.find(n => n.id === noteId || String(n.id) === String(noteId));
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
        checkAndShowNoteDraftTip(noteId);
        switchView('note-editor', opts);
        autoResizeTextarea(editNoteContent);
    };

    btnSaveNote.addEventListener('click', () => {
        const idStr = editNoteId.value; const isEdit = !!idStr; const titleVal = editNoteTitle.value.trim(); const contentVal = editNoteContent.value.trim();
        if (!titleVal && !contentVal) { discardNoteDraft(); switchView('notes'); return; }
        const newNote = { 
            id: isEdit ? parseInt(idStr) : Date.now(), 
            title: titleVal || '无标题笔记', 
            content: contentVal, 
            date: isEdit ? notesDatabase.find(n => n.id === parseInt(idStr)).date : getChineseDate(),
            annotations: currentNoteAnnotations
        };
        stampLocalUpdate(newNote);
        if (isEdit) { const index = notesDatabase.findIndex(n => n.id === parseInt(idStr)); if(index !== -1) notesDatabase[index] = newNote; } else { notesDatabase.push(newNote); }
        discardNoteDraft();
        saveNotesDatabase(); apiSyncNote(newNote, isEdit ? 'PUT' : 'POST'); renderNotes(); switchView('notes');
    });

    const persistNoteDraftIfNeeded = () => {
        if (hasUnsavedNoteChanges()) saveNoteDraft();
        else discardNoteDraft();
    };
    editNoteTitle.addEventListener('input', persistNoteDraftIfNeeded);
    editNoteContent.addEventListener('input', persistNoteDraftIfNeeded);
    document.getElementById('btn-restore-note-draft')?.addEventListener('click', restoreNoteDraft);
    document.getElementById('btn-discard-note-draft')?.addEventListener('click', discardNoteDraft);

    btnDeleteNote.addEventListener('click', () => {
        if(confirm("确定删除这条笔记吗？")) { 
            const deletedId = currentNoteId; 
            addDeletedId(deletedId);
            notesDatabase = notesDatabase.filter(n => n.id !== currentNoteId); 
            saveNotesDatabase(); 
            discardNoteDraft();
            apiSyncNote({id: deletedId}, 'DELETE'); 
            renderNotes(); 
            switchView('notes'); 
        }
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
            const rawUrl = (bm.url || '').trim();
            const hasUrl = /^https?:\/\//i.test(rawUrl);
            const card = document.createElement(hasUrl ? 'a' : 'div');
            card.className = 'bookmark-card';
            card.setAttribute('data-bookmark-id', String(bm.id));
            if (hasUrl) { card.href = rawUrl; card.target = '_blank'; card.rel = 'noopener noreferrer'; }

            const hasImage = bm.image && bm.image.trim();
            card.innerHTML = `
                <div class="bookmark-swipe-actions">
                    <button class="bookmark-action-btn btn-edit-swipe" data-id="${escapeHtml(String(bm.id))}" title="编辑">✏️</button>
                </div>
                <div class="bookmark-card-inner">
                    ${hasImage
                        ? '<img class="bookmark-card-image" src="' + escapeHtml(resolveAssetUrl(bm.image)) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
                        : '<div class="bookmark-card-image-placeholder">' + (bm.type || '🔖').split(' ')[0] + '</div>'}
                    <div class="bookmark-card-type">${escapeHtml(bm.type)}</div>
                    <div class="bookmark-card-title">${escapeHtml(bm.title)}</div>
                    <div class="bookmark-card-desc">${escapeHtml(bm.desc || '暂无描述...')}</div>
                    <button class="bookmark-card-delete" data-id="${escapeHtml(String(bm.id))}" title="删除收藏">×</button>
                </div>
            `;

            // Swipe logic (Touch & Mouse)
            let startX = 0;
            let currentX = 0;
            let isDragging = false;
            const inner = card.querySelector('.bookmark-card-inner');
            const SWIPE_THRESHOLD = 60;
            
            const handleStart = (clientX) => {
                startX = clientX;
                isDragging = true;
                inner.style.transition = 'none';
            };

            const handleMove = (clientX) => {
                if (!isDragging) return;
                const diff = clientX - startX;
                // Only allow right swipe (diff > 0)
                if (diff > 0) {
                    currentX = diff > SWIPE_THRESHOLD + 20 ? SWIPE_THRESHOLD + 20 : diff;
                    inner.style.transform = `translateX(${currentX}px)`;
                }
            };

            const handleEnd = () => {
                if (!isDragging) return;
                isDragging = false;
                inner.style.transition = 'transform 0.2s ease';
                if (currentX > SWIPE_THRESHOLD / 2) {
                    inner.style.transform = `translateX(${SWIPE_THRESHOLD}px)`;
                } else {
                    inner.style.transform = `translateX(0px)`;
                }
                currentX = 0;
            };
            
            card.addEventListener('touchstart', e => handleStart(e.touches[0].clientX), {passive: true});
            card.addEventListener('touchmove', e => handleMove(e.touches[0].clientX), {passive: true});
            card.addEventListener('touchend', handleEnd);
            card.addEventListener('touchcancel', handleEnd);

            card.addEventListener('mousedown', e => {
                if (e.target.closest('.bookmark-action-btn')) return;
                handleStart(e.clientX);
            });
            card.addEventListener('mousemove', e => {
                if (isDragging) {
                    e.preventDefault(); // prevent text selection
                    handleMove(e.clientX);
                }
            });
            card.addEventListener('mouseup', handleEnd);
            card.addEventListener('mouseleave', handleEnd);
            // Restore on click outside
            document.addEventListener('touchstart', e => {
                if (!card.contains(e.target)) {
                    inner.style.transform = `translateX(0px)`;
                }
            });

            // Edit button logic
            const editBtn = card.querySelector('.btn-edit-swipe');
            if (editBtn) {
                editBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    inner.style.transform = `translateX(0px)`;
                    openBookmarkEditor(bm);
                });
            }

            // If no URL but has image, click to view image in modal
            if (!hasUrl && hasImage) {
                card.style.cursor = 'zoom-in';
                card.addEventListener('click', (e) => {
                    if (e.target.closest('.bookmark-card-delete')) return;
                    document.getElementById('image-preview-img').src = resolveAssetUrl(bm.image);
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
                    addDeletedId(deletedId);
                    bookmarksDatabase = bookmarksDatabase.filter(b => b.id !== bm.id);
                    saveBookmarksDatabase();
                    apiSyncBookmark({id: deletedId}, 'DELETE');
                    renderBookmarks();
                    showToast('已移除收藏', 'info');
                }
            });

            bookmarkListContainer.appendChild(card);
        });
    };

    const openBookmarkEditor = (bmToEdit = null) => {
        bookmarkEditorForm.reset();
        if (bmToEdit) {
            editBookmarkId.value = bmToEdit.id;
            editBookmarkTitle.value = bmToEdit.title || '';
            editBookmarkUrl.value = bmToEdit.url || '';
            editBookmarkDesc.value = bmToEdit.desc || bmToEdit.description || '';
            if (editBookmarkImage) editBookmarkImage.value = bmToEdit.image || '';
            const typeVal = bmToEdit.type || '🌐 网站';
            editBookmarkType.value = typeVal;
            document.querySelectorAll('.cat-chip').forEach(c => {
                c.classList.toggle('active', c.getAttribute('data-val') === typeVal);
            });
        } else {
            editBookmarkId.value = '';
            if (editBookmarkImage) editBookmarkImage.value = '';
            document.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('active'));
            const firstChip = document.querySelector('.cat-chip[data-val="🌐 网站"]');
            if (firstChip) { firstChip.classList.add('active'); editBookmarkType.value = '🌐 网站'; }
        }
        switchView('bookmark-editor');
    };

    btnCancelBookmark.addEventListener('click', () => switchView('bookmarks'));

    bookmarkEditorForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const existingIdStr = (editBookmarkId.value || '').trim();
        const isEdit = Boolean(existingIdStr);
        const targetId = isEdit ? (isNaN(Number(existingIdStr)) ? existingIdStr : Number(existingIdStr)) : generateUniqueId();
        
        const newBookmark = {
            id: targetId,
            type: editBookmarkType.value,
            title: editBookmarkTitle.value.trim(),
            url: editBookmarkUrl.value.trim(),
            desc: editBookmarkDesc.value.trim(),
            image: (editBookmarkImage && editBookmarkImage.value || '').trim()
        };
        stampLocalUpdate(newBookmark);
        
        if (isEdit) {
            const idx = bookmarksDatabase.findIndex(b => String(b.id) === String(targetId));
            if (idx !== -1) bookmarksDatabase[idx] = newBookmark;
            else bookmarksDatabase.unshift(newBookmark);
        } else {
            bookmarksDatabase.unshift(newBookmark);
        }

        saveBookmarksDatabase();
        apiSyncBookmark(newBookmark, 'POST');
        renderBookmarks();
        switchView('bookmarks');
        showToast(isEdit ? '收藏更新成功' : '新增收藏成功', 'success');
    });


    // ==========================================
    // 7. 全局事件与同步备份
    // ==========================================
    const navbar = document.getElementById('navbar');
    window.addEventListener('scroll', () => {
        if (window.scrollY > 20) navbar.classList.add('scrolled');
        else navbar.classList.remove('scrolled');
    });



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
                    
                    showToast('本地数据已成功合并并同步至云端！', 'success');
                } catch (e) {
                    showToast('合并同步部分数据失败：' + e.message, 'error');
                }
            }
        }
    };

    // 1. 页面初始化：首先校验登录状态（如果已登录自动隐藏登录遮罩层，免去重复输入密码）
    checkAuth();

    if (authToken) {
        setTimeout(registerPushNotification, 2000);
    }
    loadLocalData();
    if (authToken) {
        syncFromApi();
    }

    // 4. 后台检测合并游客数据
    checkAndMergeGuestData();

    // 智能后台无感自动同步引擎 (Seamless Auto-Sync Engine)
    let autoSyncInterval = null;
    const startAutoSyncEngine = () => {
        if (autoSyncInterval) clearInterval(autoSyncInterval);
        // 每 15 秒后台同步一次（编辑中不会重绘；失败会提示并重试）
        autoSyncInterval = setInterval(() => {
            if (document.visibilityState === 'visible' && authToken) {
                syncFromApi();
            }
        }, 15000);
    };

    // 页面切回、亮屏焦点、网络恢复时立即无感同步
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && authToken) {
            syncFromApi();
        }
    });
    window.addEventListener('focus', () => {
        if (authToken) syncFromApi();
    });
    window.addEventListener('online', () => {
        if (authToken) syncFromApi();
    });

    // 启动后台无感自动同步引擎
    startAutoSyncEngine();

    // 恢复 URL hash（刷新后回到对应视图）；无 hash 时写入首页，便于系统返回键工作
    if (location.hash && location.hash !== '#' && location.hash !== '#/home') {
        applyRoute(parseHashRoute());
    } else {
        history.replaceState({ view: currentActiveNavView || 'home' }, '', `#/${currentActiveNavView || 'home'}`);
    }

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

    let currentFeedFilterTag = null;
    window._filterFeedByTag = (tag) => {
        currentFeedFilterTag = currentFeedFilterTag === tag ? null : tag;
        renderFeeds();
    };

    function renderFeeds() {
        const container = document.getElementById('feeds-stream-container');
        const filterContainer = document.getElementById('feed-tag-filter-container');
        if (!container) return;

        // Extract all unique tags
        const allTags = new Set();
        (feedsDatabase || []).forEach(f => {
            (f.tags || []).forEach(t => allTags.add(t));
        });
        const tagsList = Array.from(allTags).sort();

        // Render filter bar
        if (filterContainer) {
            if (tagsList.length > 0) {
                filterContainer.style.display = 'flex';
                let filterHtml = `<div class="feed-filter-chip ${currentFeedFilterTag === null ? 'active' : ''}" data-tag="">全部</div>`;
                tagsList.forEach(tag => {
                    filterHtml += `<div class="feed-filter-chip ${currentFeedFilterTag === tag ? 'active' : ''}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</div>`;
                });
                filterContainer.innerHTML = filterHtml;

                // Bind click events
                filterContainer.querySelectorAll('.feed-filter-chip').forEach(chip => {
                    chip.addEventListener('click', (e) => {
                        const tag = e.target.dataset.tag;
                        currentFeedFilterTag = tag ? tag : null;
                        renderFeeds();
                    });
                });
            } else {
                filterContainer.style.display = 'none';
                filterContainer.innerHTML = '';
            }
        }

        const displayFeeds = currentFeedFilterTag 
            ? feedsDatabase.filter(f => f.tags && f.tags.includes(currentFeedFilterTag))
            : feedsDatabase;

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
            const tagHtml = tags.map(t => `<span class="feed-tag-pill" onclick="event.stopPropagation(); window._filterFeedByTag('${escapeHtml(t)}')">${escapeHtml(t)}</span>`).join('');

            
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

        feedsDatabase.unshift(newFeed);
        localStorage.setItem(getLocalKey('gardenFeeds'), JSON.stringify(feedsDatabase));
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
        addDeletedId(id);
        feedsDatabase = feedsDatabase.filter(f => String(f.id) !== String(id));
        localStorage.setItem(getLocalKey('gardenFeeds'), JSON.stringify(feedsDatabase));
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

        (database || []).forEach(w => addCount(w.created_at || w.updated_at || w.date));
        (notesDatabase || []).forEach(n => addCount(n.created_at || n.updated_at || n.date));
        (bookmarksDatabase || []).forEach(b => addCount(b.created_at || b.updated_at));
        (feedsDatabase || []).forEach(f => addCount(f.created_at || f.updated_at));

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

        if (!echoCardsDatabase || echoCardsDatabase.length === 0) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = echoCardsDatabase.map(card => {
            let feedLinksHtml = '';
            try {
                const feedIds = typeof card.related_feed_ids === 'string'
                    ? JSON.parse(card.related_feed_ids)
                    : (Array.isArray(card.related_feed_ids) ? card.related_feed_ids : []);
                if (Array.isArray(feedIds) && feedIds.length > 0) {
                    feedLinksHtml = `<div class="echo-card-feeds">` + feedIds.map(fid =>
                        `<span class="echo-card-feed-link" onclick="jumpToFeed('${escapeHtml(String(fid))}')">🔗 随手记 #${fid}</span>`
                    ).join('') + `</div>`;
                }
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
        echoCardsDatabase = echoCardsDatabase.filter(c => String(c.id) !== String(id));
        localStorage.setItem(getLocalKey('gardenEchoCards'), JSON.stringify(echoCardsDatabase));
        renderEchoCards();
        apiRequest('/api/echo/cards/' + id, { method: 'DELETE' }).catch(() => {});
    };

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
            btnTriggerEchoCard.innerText = 'AI 生成中...';
            try {
                const newCard = await apiRequest('/api/echo/generate', { method: 'POST', timeout: 60000 });
                if (newCard && newCard.title) {
                    echoCardsDatabase.unshift(newCard);
                    localStorage.setItem(getLocalKey('gardenEchoCards'), JSON.stringify(echoCardsDatabase));
                    renderEchoCards();
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
            if (!aiModalInHistory) {
                history.pushState({ view: 'ai' }, '', '#/ai');
                aiModalInHistory = true;
            }
            if (aiChatInput) aiChatInput.focus();
        });
    }
    if (btnCloseAiChat && aiChatModal) {
        btnCloseAiChat.addEventListener('click', () => {
            if (aiModalInHistory && parseHashRoute().view === 'ai') {
                history.back();
            } else {
                aiChatModal.classList.remove('show');
                aiModalInHistory = false;
            }
        });
    }

    window.closeAiChatModal = function() {
        if (aiModalInHistory && parseHashRoute().view === 'ai') {
            history.back();
            return;
        }
        if (aiChatModal) aiChatModal.classList.remove('show');
        aiModalInHistory = false;
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
        (database || []).forEach(w => {
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
        (feedsDatabase || []).forEach(f => {
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
        (notesDatabase || []).forEach(n => {
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
        (bookmarksDatabase || []).forEach(b => {
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
        (echoCardsDatabase || []).forEach(c => {
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
        if (targetView) switchView(targetView);
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
            if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

            // 多轮对话：保存 user 输入
            const recentHistory = [...aiChatHistory];
            aiChatHistory.push({ role: 'user', content: question });

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
                    aiChatHistory.push({ role: 'assistant', content: fullText });
                    return;
                }
            } else if (response.ok) {
                const res = await response.json();
                if (res && res.reply) {
                    bubbleEl.innerHTML = markdownToHtml(res.reply);
                    aiChatHistory.push({ role: 'assistant', content: res.reply });
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
        aiChatHistory.push({ role: 'assistant', content: localReply });
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




