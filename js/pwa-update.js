import { showToast } from './utils.js';

/**
 * Register SW and aggressively check for updates so PWA does not
 * stay stuck until the browser's rare automatic update check.
 */
export function initPwaUpdates() {
    if (!('serviceWorker' in navigator)) return;

    let reloading = false;
    const reloadOnce = (reason) => {
        if (reloading) return;
        reloading = true;
        showToast(reason || '发现新版本，正在刷新...', 'success');
        setTimeout(() => window.location.reload(), 1000);
    };

    const watchInstalling = (worker) => {
        if (!worker) return;
        worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                worker.postMessage({ type: 'SKIP_WAITING' });
                reloadOnce('手机 PWA 已感知到最新版本，正在加载...');
            }
        });
    };

    const setup = async () => {
        try {
            const reg = await navigator.serviceWorker.register('/sw.js');

            // New SW already waiting from a previous visit
            if (reg.waiting && navigator.serviceWorker.controller) {
                reg.waiting.postMessage({ type: 'SKIP_WAITING' });
                reloadOnce('手机 PWA 已感知到最新版本，正在加载...');
            }

            reg.addEventListener('updatefound', () => {
                watchInstalling(reg.installing);
            });

            // New controller activated → ensure page uses fresh assets
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                reloadOnce('新版本已就绪，正在刷新...');
            });

            const checkForUpdate = () => {
                reg.update().catch(() => {});
            };

            checkForUpdate();
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') checkForUpdate();
            });
            window.addEventListener('focus', checkForUpdate);
            // Periodic check while app stays open
            setInterval(checkForUpdate, 60 * 1000);
        } catch (_) {}
    };

    if (document.readyState === 'complete') setup();
    else window.addEventListener('load', setup);
}
