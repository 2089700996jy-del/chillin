// Chillin Service Worker — 网络优先，离线回退缓存，防模块语法崩溃
const CACHE_NAME = 'chillin-v215';
const APP_V = '2.5.168';
const ASSETS = [
    '/',
    '/index.html',
    '/app.js',
    `/app.js?v=${APP_V}`,
    '/style.css',
    `/style.css?v=${APP_V}`,
    '/manifest.json',
    '/favicon.ico',
    '/vendor/dompurify.min.js',
    '/icons/icon-180.png',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/transparent.png',
    '/js/actions.js',
    '/js/api.js',
    '/js/auth.js',
    '/js/backup.js',
    '/js/bookmarks.js',
    '/js/config.js',
    '/js/daily-spark.js',
    '/js/db.js',
    '/js/echo-ai.js',
    '/js/evergreen-topics.js',
    '/js/feeds.js',
    '/js/notes.js',
    '/js/prompts.js',
    '/js/pwa-update.js',
    '/js/reader.js',
    '/js/router.js',
    '/js/search.js',
    '/js/state.js',
    '/js/sync.js',
    '/js/trusted-types.js',
    '/js/ui.js',
    '/js/upload.js',
    '/js/utils.js',
    '/js/version.js',
    '/js/weeklies.js',
    '/js/wikilinks.js'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(async (c) => {
            await Promise.allSettled(
                ASSETS.map((asset) => c.add(asset).catch((err) => {
                    console.warn('[SW] Cache asset skipped:', asset, err?.message || err);
                }))
            );
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    const url = new URL(e.request.url);
    if (url.origin !== self.location.origin) return;      // 只处理同源
    if (url.pathname.startsWith('/api/') || url.pathname === '/version.json') return; // API 与版本探活直接穿透网络，绝不缓存

    /**
     * 先写缓存、再返回响应——但写入挂在 waitUntil 上，不让用户等它。
     *
     * 两个历史教训：拿到响应就直接 return、把 put 丢到后台 fire-and-forget，浏览器随时
     * 可能回收 SW，那次写入来不及完成，用户下次离线就发现这一版没被缓存住；反过来把
     * await cache.put 塞进 respondWith 的 promise 里，则每次请求都要多等一次缓存落盘。
     * 现在响应立刻返回，写入用 e.waitUntil() 挂进 SW 生命周期——浏览器会保活到写完，
     * 用户也不用等。写入失败（配额满等）只吞掉异常，绝不影响这次请求本身。
     */
    const networkThenCache = async (fallback) => {
        try {
            const res = await fetch(e.request);
            if (res && res.status === 200) {
                const clone = res.clone();
                try {
                    e.waitUntil(
                        caches.open(CACHE_NAME)
                            .then((cache) => cache.put(e.request, clone))
                            .catch(() => { /* 配额满等：写入失败不能影响本次响应 */ })
                    );
                } catch (_) { /* 极少数引擎在事件失活后拒绝 waitUntil：退化为后台写入，总比抛错强 */ }
            }
            return res;
        } catch (_) {
            return (await fallback()) || Response.error();
        }
    };

    // 1. ES modules / app shell JS:
    // 离线时决不能降级到 /index.html（会触发 Uncaught SyntaxError: Unexpected token '<' 导致整站崩溃）
    const isModuleJs = url.pathname.startsWith('/js/') || url.pathname.endsWith('/app.js') || url.pathname === '/app.js';
    if (isModuleJs) {
        e.respondWith(networkThenCache(() => caches.match(e.request, { ignoreSearch: true })));
        return;
    }

    // 2. 页面导航请求（离线时回退到 /index.html 单页容器）
    if (e.request.mode === 'navigate') {
        e.respondWith(networkThenCache(() => caches.match('/index.html')));
        return;
    }

    // 3. 静态资源（CSS, 图片, 图标等）
    e.respondWith(networkThenCache(() => caches.match(e.request, { ignoreSearch: true })));
});

// 处理推送通知
self.addEventListener('push', (e) => {
    let data = { title: 'Chillin', body: '收到来自花园的新消息' };
    try {
        if (e.data) {
            data = e.data.json();
        }
    } catch (err) {}

    const title = data.title || 'Chillin';
    const options = {
        body: data.body || '随时安放思绪与时光回响',
        icon: data.icon || '/icons/transparent.png',
        tag: data.tag || ('chillin-' + Date.now()),
        renotify: true,
        vibrate: [80, 40, 80],
        data: {
            url: data.url || '/'
        }
    };

    e.waitUntil(
        self.registration.showNotification(title, options)
    );
});

// 点击通知跳转
self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    const urlToOpen = new URL(e.notification.data.url, self.location.origin).href;

    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            for (let i = 0; i < windowClients.length; i++) {
                const client = windowClients[i];
                if (client.url === urlToOpen && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(urlToOpen);
            }
        })
    );
});
