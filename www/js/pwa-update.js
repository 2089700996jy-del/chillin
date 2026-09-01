import { showToast } from './utils.js';
import { APP_VERSION } from './version.js';
import { CLOUD_WORKER_BASE } from './api.js';

/**
 * Faster, smoother PWA updates:
 * 1) register SW with updateViaCache:'none' (ignore HTTP cache for sw.js)
 * 2) probe Worker /api/app-version (bypasses Pages CDN — helps without proxy)
 * 3) soft bottom banner instead of hard auto-reload while typing
 */
export function initPwaUpdates() {
    if (!('serviceWorker' in navigator)) return;

    let reloading = false;
    let bannerShown = false;
    let pendingReloadReason = '';

    const softReload = (reason) => {
        if (reloading) return;
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
                <button type="button" id="pwa-update-btn" style="border:0;border-radius:999px;padding:8px 12px;background:#007AFF;color:#fff;font:600 12px/1 inherit;cursor:pointer">立即刷新</button>
            `;
            document.body.appendChild(bar);
            bar.querySelector('#pwa-update-btn')?.addEventListener('click', () => {
                softReload(pendingReloadReason || '正在刷新到新版本…');
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
                if (!reloading && bannerShown && document.visibilityState === 'visible') {
                    const stillTyping = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
                    if (!stillTyping) softReload(pendingReloadReason || '新版本已就绪，正在刷新…');
                }
            }, 8000);
        }
    };

    const watchInstalling = (worker, reg) => {
        if (!worker) return;
        worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                worker.postMessage({ type: 'SKIP_WAITING' });
                ensureBanner('手机端已下载新版本');
            } else if (worker.state === 'installed' && !navigator.serviceWorker.controller) {
                // first install — no reload needed
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
                watchInstalling(reg.installing, reg);
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
            // Visible: every 20s; cheap Worker JSON probe helps without proxy
            setInterval(() => {
                if (document.visibilityState === 'visible') checkForUpdate();
            }, 20 * 1000);
        } catch (_) {}
    };

    if (document.readyState === 'complete') setup();
    else window.addEventListener('load', setup);
}
