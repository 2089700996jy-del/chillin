// Chillin Service Worker — 网络优先，离线回退缓存
const CACHE_NAME = 'chillin-v7';
const ASSETS = [
    '/',
    '/index.html',
    '/app.js?v=2.0.4',
    '/style.css',
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
