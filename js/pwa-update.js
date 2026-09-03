/**
 * PWA Service Worker registration, remote version probe, soft update banner,
 * and forceRefreshToLatest (clear SW/Cache; keep login in localStorage).
 */
import { showToast } from './utils.js';
import { APP_VERSION } from './version.js';
import { CLOUD_WORKER_BASE } from './config.js';

let forceRefreshing = false;

/**
 * 注销 Service Worker、清空 Cache Storage，再带时间戳硬刷新。
 * 不清理 localStorage（登录态保留）。
 */
async function forceRefreshToLatest(opts = {}) {
    if (forceRefreshing) return;
    const skipConfirm = !!opts.skipConfirm;
    if (!skipConfirm) {
        const ok = window.confirm(
            '将清除应用缓存并强制加载最新版（登录状态会保留）。是否继续？'
        );
        if (!ok) return;
    }

    forceRefreshing = true;
    showToast('正在清除缓存并刷新到最新版…', 'success');

    try {
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
        }
    } catch (_) {}

    try {
        if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
        }
    } catch (_) {}

    const url = new URL(window.location.href);
    url.searchParams.set('_fresh', String(Date.now()));
    // 稍等让 toast 可见，再跳转
    setTimeout(() => {
        window.location.replace(url.pathname + url.search + url.hash);
    }, 400);
}

function stripFreshParam() {
    try {
        const url = new URL(window.location.href);
        if (!url.searchParams.has('_fresh')) return;
        url.searchParams.delete('_fresh');
        const next = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '') + url.hash;
        history.replaceState(null, '', next);
    } catch (_) {}
}

if (typeof window !== 'undefined') {
    window._chillinForceRefresh = () => forceRefreshToLatest();
}

function bindForceRefreshControls() {
    document.querySelectorAll('[data-app-version]').forEach((el) => {
        if (el.dataset.forceBound === '1') return;
        el.dataset.forceBound = '1';
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.title = '点击强制刷新到最新版';
        el.addEventListener('click', () => forceRefreshToLatest());
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                forceRefreshToLatest();
            }
        });
    });
}

/**
 * Faster, smoother PWA updates:
 * 1) register SW with updateViaCache:'none' (ignore HTTP cache for sw.js)
 * 2) probe Worker /api/app-version (bypasses Pages CDN — helps without proxy)
 * 3) soft bottom banner instead of hard auto-reload while typing
 * 4) forceRefreshToLatest for stuck / stale installs
 */
export function initPwaUpdates() {
    stripFreshParam();
    bindForceRefreshControls();

    if (!('serviceWorker' in navigator)) return;

    let reloading = false;
    let bannerShown = false;
    let pendingReloadReason = '';

    const softReload = (reason) => {
        if (reloading || forceRefreshing) return;
        reloading = true;
        showToast(reason || '正在刷新到新版本…', 'success');
        setTimeout(() => window.location.reload(), 600);
    };

    const ensureBanner = (message) => {
        pendingReloadReason = message || '发现新版本';
        let bar = document.getElementById('pwa-update-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'pwa-update-bar';
            bar.setAttribute('role', 'status');
            bar.style.cssText = [
                'position:fixed', 'left:12px', 'right:12px', 'bottom:calc(72px + env(safe-area-inset-bottom, 0px))',
                'z-index:2000', 'display:flex', 'align-items:center', 'justify-content:space-between', 'gap:10px',
                'padding:12px 14px', 'border-radius:14px', 'background:rgba(28,28,30,0.92)', 'color:#fff',
                'font:600 13px/1.35 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif',
                'box-shadow:0 10px 30px rgba(0,0,0,0.22)', 'backdrop-filter:blur(12px)',
                '-webkit-backdrop-filter:blur(12px)', 'transform:translateY(120%)', 'transition:transform .28s ease'
            ].join(';');
            bar.innerHTML = `
                <span id="pwa-update-msg" style="flex:1"></span>
                <span style="display:flex;gap:8px;flex-shrink:0">
                  <button type="button" id="pwa-force-btn" style="border:0;border-radius:999px;padding:8px 10px;background:rgba(255,255,255,0.14);color:#fff;font:600 12px/1 inherit;cursor:pointer">强制更新</button>
                  <button type="button" id="pwa-update-btn" style="border:0;border-radius:999px;padding:8px 12px;background:#007AFF;color:#fff;font:600 12px/1 inherit;cursor:pointer">立即刷新</button>
                </span>
            `;
            document.body.appendChild(bar);
            bar.querySelector('#pwa-update-btn')?.addEventListener('click', () => {
                softReload(pendingReloadReason || '正在刷新到新版本…');
            });
            bar.querySelector('#pwa-force-btn')?.addEventListener('click', () => {
                forceRefreshToLatest({ skipConfirm: true });
            });
            requestAnimationFrame(() => { bar.style.transform = 'translateY(0)'; });
        }
        const msg = bar.querySelector('#pwa-update-msg');
        if (msg) msg.textContent = message || '发现新版本，刷新即可体验';
        bannerShown = true;

        // Idle auto-refresh: only when not editing, after a short delay
        const typing = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
        if (!typing) {
            setTimeout(() => {
                if (!reloading && !forceRefreshing && bannerShown && document.visibilityState === 'visible') {
                    const stillTyping = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
                    if (!stillTyping) softReload(pendingReloadReason || '新版本已就绪，正在刷新…');
                }
            }, 8000);
        }
    };

    const watchInstalling = (worker) => {
        if (!worker) return;
        worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                worker.postMessage({ type: 'SKIP_WAITING' });
                ensureBanner('手机端已下载新版本');
            }
        });
    };

    const probeRemoteVersion = async (reg) => {
        const urls = [
            `${CLOUD_WORKER_BASE}/api/app-version?t=${Date.now()}`,
            `/version.json?t=${Date.now()}`
        ];
        for (const url of urls) {
            try {
                const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
                if (!res.ok) continue;
                const data = await res.json();
                const remote = String(data.version || '').trim();
                if (remote && remote !== APP_VERSION) {
                    try { await reg?.update(); } catch (_) {}
                    ensureBanner(`云端已是 v${remote}，当前 v${APP_VERSION}`);
                    return true;
                }
                return false;
            } catch (_) {
                // try next probe
            }
        }
        return false;
    };

    const setup = async () => {
        try {
            const reg = await navigator.serviceWorker.register('/sw.js', {
                updateViaCache: 'none'
            });

            if (reg.waiting && navigator.serviceWorker.controller) {
                reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                ensureBanner('新版本已就绪');
            }

            reg.addEventListener('updatefound', () => {
                watchInstalling(reg.installing);
            });

            navigator.serviceWorker.addEventListener('controllerchange', () => {
                ensureBanner('新版本已激活');
            });

            const checkForUpdate = () => {
                reg.update().catch(() => {});
                probeRemoteVersion(reg);
            };

            checkForUpdate();
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') checkForUpdate();
            });
            window.addEventListener('focus', checkForUpdate);
            window.addEventListener('online', checkForUpdate);
            // 省电：前台常开时约每 5 分钟探一次（原 20 秒）
            setInterval(() => {
                if (document.visibilityState === 'visible') checkForUpdate();
            }, 5 * 60 * 1000);
        } catch (_) {}
    };

    if (document.readyState === 'complete') setup();
    else window.addEventListener('load', setup);
}
