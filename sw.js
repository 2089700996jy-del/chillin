// Chillin Service Worker — 网络优先，离线回退缓存，防模块语法崩溃
const CACHE_NAME = 'chillin-v73';
const APP_V = '2.5.26';
const ASSETS = [
    '/',
    '/index.html',
    `/app.js?v=${APP_V}`,
    `/style.css?v=${APP_V}`,
    '/manifest.json',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/js/actions.js',
    '/js/api.js',
    '/js/auth.js',
    '/js/bookmarks.js',
    '/js/config.js',
    '/js/echo-ai.js',
    '/js/feeds.js',
    '/js/notes.js',
    '/js/prompts.js',
    '/js/pwa-update.js',
    '/js/reader.js',
    '/js/router.js',
    '/js/search.js',
    '/js/state.js',
    '/js/sync.js',
    '/js/ui.js',
    '/js/upload.js',
    '/js/utils.js',
    '/js/version.js',
    '/js/weeklies.js'
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
    if (url.pathname.startsWith('/api/')) return;          // API 不缓存，交给网络

    // 1. ES modules / app shell JS:
    // 离线时决不能降级到 /index.html（会触发 Uncaught SyntaxError: Unexpected token '<' 导致整站崩溃）
    const isModuleJs = url.pathname.startsWith('/js/') || url.pathname.endsWith('/app.js') || url.pathname === '/app.js';
    if (isModuleJs) {
        e.respondWith(
            fetch(e.request)
                .then((res) => {
                    if (res && res.status === 200) {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
                    }
                    return res;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }

    // 2. 页面导航请求（离线时回退到 /index.html 单页容器）
    if (e.request.mode === 'navigate') {
        e.respondWith(
            fetch(e.request)
                .then((res) => {
                    if (res && res.status === 200) {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
                    }
                    return res;
                })
                .catch(() => caches.match('/index.html'))
        );
        return;
    }

    // 3. 静态资源（CSS, 图片, 图标等）
    e.respondWith(
        fetch(e.request)
            .then((res) => {
                if (res && res.status === 200) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
                }
                return res;
            })
            .catch(() => caches.match(e.request))
    );
});

// 处理推送通知
self.addEventListener('push', (e) => {
    let data = { title: '新消息', body: '你收到了一条新消息' };
    try {
        if (e.data) {
            data = e.data.json();
        }
    } catch (err) {}

    const options = {
        body: data.body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        vibrate: [100, 50, 100],
        data: {
            url: data.url || '/'
        }
    };

    e.waitUntil(
        self.registration.showNotification(data.title, options)
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
