// Chillin Service Worker — 网络优先，离线回退缓存
const CACHE_NAME = 'chillin-v14';
const ASSETS = [
    '/',
    '/index.html',
    '/app.js?v=2.1.1',
    '/style.css?v=2.1.1',
    '/manifest.json',
    '/icons/icon-192.png',
    '/icons/icon-512.png'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    const url = new URL(e.request.url);
    if (url.origin !== self.location.origin) return;      // 只处理同源
    if (url.pathname.startsWith('/api/')) return;          // API 不缓存，交给网络
    e.respondWith(
        fetch(e.request)
            .then((res) => {
                const clone = res.clone();
                caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
                return res;
            })
            .catch(() => caches.match(e.request).then((m) => m || caches.match('/index.html')))
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
