/**
 * App bootstrap: wire hooks, init feature modules, auth + auto-sync + PWA.
 * Feature domains live under ./js/*.js; HTTP/sync via ./js/api.js facade.
 */
import { APP_BUILD_LABEL } from './js/version.js';
import { state } from './js/state.js';
import { ui } from './js/ui.js';
import { actions } from './js/actions.js';
import {
    checkAuth,
    initAuthUI,
    loadLocalData,
    syncFromApi,
    setSyncStatus,
    checkAndMergeGuestData,
    startAutoSyncEngine,
    bindApiHooks,
    restoreCookieSession,
    refreshSession,
} from './js/api.js';
import { initRouter } from './js/router.js';
import { initWeeklies } from './js/weeklies.js';
import { initNotes } from './js/notes.js';
import { initBookmarks } from './js/bookmarks.js';
import { initFeeds } from './js/feeds.js';
import { initEchoAi } from './js/echo-ai.js';
import { initSearch } from './js/search.js';
import { initWikilinks } from './js/wikilinks.js';
import { initDailySpark } from './js/daily-spark.js';
import { initEvergreenTopics } from './js/evergreen-topics.js';
import { showToast, initAppTheme } from './js/utils.js';
import { initPwaUpdates } from './js/pwa-update.js';
import { checkAndSendBackupGuardNotification } from './js/backup.js';
import { loadFeature, isFeatureReady } from './js/feature-loader.js';

// 应用级主题（批次 A）：在 DOMContentLoaded 之前生效，避免首帧闪白
initAppTheme();

// Disable device vibration across the entire app as requested
if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try { navigator.vibrate = () => false; } catch (_) {}
}

document.addEventListener('DOMContentLoaded', () => {

    // Auth / sync: ./js/api.js + ./js/state.js
    // Feature domains: ./js/{router,weeklies,notes,bookmarks,upload,reader,feeds,echo-ai,search}.js

    const versionEls = document.querySelectorAll('[data-app-version]');
    versionEls.forEach((el) => { el.textContent = APP_BUILD_LABEL; });
    document.title = `Chillin · ${APP_BUILD_LABEL}`;

    // 懒加载模块的首击兜底：先 import、再重放这次点击，避免用户第一次点上传/提示词/导入书时没反应。
    // 这三个模块不在首屏静态图里；router 会按路由提前加载，但用户可能赶在 chunk 到达前就点。
    let replayingLazyClick = false;
    document.addEventListener('click', (e) => {
        if (replayingLazyClick) return;
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;
        const uploadBtn = target.closest('.btn-upload-image');
        const promptTab = target.closest('.segment-btn[data-subtab]');
        const bookInput = target.closest('#book-file-input');
        const feature = uploadBtn ? 'upload' : (promptTab ? 'prompts' : (bookInput ? 'reader' : null));
        if (!feature || isFeatureReady(feature)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        loadFeature(feature)
            .then(() => {
                replayingLazyClick = true;
                try { (uploadBtn || promptTab || bookInput).click(); }
                finally { replayingLazyClick = false; }
            })
            .catch((err) => console.error('[lazy] ' + feature + ' failed', err));
    }, true);

    // 全局事件委托：取代原有的内联 onclick / onerror（CSP 收紧后内联处理器会被拦截）
    document.addEventListener('click', (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;

        const closer = target.closest('[data-close-modal]');
        if (closer) {
            const modalId = closer.getAttribute('data-close-modal');
            if (modalId) document.getElementById(modalId)?.classList.remove('show');
            return;
        }

        // 点击遮罩空白处关闭弹层
        if (target.classList.contains('modal-overlay')) {
            target.classList.remove('show');
            return;
        }

        // 图片灯箱：由 data-preview-image 标记接管
        const previewImg = target.closest('img[data-preview-image]');
        if (previewImg && typeof window.previewImage === 'function') {
            window.previewImage(previewImg.getAttribute('src'));
        }
    });


    // 弹层无障碍：role/aria-modal、焦点陷阱、Esc 关闭、关闭后归还焦点
    const modalState = new WeakMap();
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = (root) => Array.from(root.querySelectorAll(FOCUSABLE))
        .filter((el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true');

    const modalObserver = new MutationObserver((records) => {
        for (const record of records) {
            const el = record.target;
            if (!(el instanceof Element) || !el.classList.contains('modal-overlay')) continue;
            const visible = el.classList.contains('show');
            const wasVisible = modalState.has(el);
            if (visible && !wasVisible) {
                el.setAttribute('role', 'dialog');
                el.setAttribute('aria-modal', 'true');
                if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) {
                    el.setAttribute('aria-label', '对话框');
                }
                modalState.set(el, document.activeElement instanceof HTMLElement ? document.activeElement : null);
                setTimeout(() => { const list = focusables(el); (list[0] || el).focus?.(); }, 30);
            } else if (!visible && wasVisible) {
                const previous = modalState.get(el);
                modalState.delete(el);
                if (previous && document.contains(previous)) previous.focus?.();
            }
        }
    });
    document.querySelectorAll('.modal-overlay').forEach((el) => {
        modalObserver.observe(el, { attributes: true, attributeFilter: ['class'] });
    });

    // Esc 关闭 / Tab 焦点循环
    document.addEventListener('keydown', (e) => {
        const openModal = Array.from(document.querySelectorAll('.modal-overlay.show')).pop();
        if (!openModal) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            openModal.classList.remove('show');
            return;
        }
        if (e.key !== 'Tab') return;
        const items = focusables(openModal);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    });

    // 图片加载失败兜底（error 事件不冒泡，必须在捕获阶段代理）
    window.addEventListener('error', (e) => {
        const el = e.target;
        if (!el || el.tagName !== 'IMG' || el.dataset.imgFallback) return;
        el.dataset.imgFallback = '1';
        el.classList.add('img-load-failed');
        if (el.parentElement) el.parentElement.classList.add('is-fallback');
        const mode = el.getAttribute('data-img-hide-on-error');
        if (mode === 'remove') el.remove();
        else if (mode === 'hide') el.style.display = 'none';
    }, true);

    // Navbar scroll affordance + 底部胶囊智能收起 + 回到顶部浮钮
    const navbar = document.getElementById('navbar');
    const bottomNav = document.getElementById('mobile-bottom-nav');
    const backToTopBtn = document.getElementById('btn-back-to-top');
    const fabBtn = document.getElementById('btn-create-new');
    let lastScrollY = Math.max(0, window.scrollY);

    // 只切 class，不动 display：编辑器/键盘/弹层的既有 display:none 逻辑仍然优先。
    // inert 让收起后的导航同时退出 Tab 序列与读屏树，避免「看不见但还能聚焦」。
    const setBottomNavScrollHidden = (hidden) => {
        if (!bottomNav) return;
        if (bottomNav.classList.contains('scroll-hidden') === hidden) return;
        bottomNav.classList.toggle('scroll-hidden', hidden);
        bottomNav.toggleAttribute('inert', hidden);
    };

    if (backToTopBtn) {
        backToTopBtn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }
    window.addEventListener('scroll', () => {
        const y = Math.max(0, window.scrollY);
        if (navbar) {
            if (y > 20) navbar.classList.add('scrolled');
            else navbar.classList.remove('scrolled');
        }

        // 顶部始终显示；向下超过 96px 才收起，向上 6px 即恢复。
        // 阈值避免一点抖动就切换；停下后保持当前状态，不参与滚动惯性判断。
        if (y <= 48) {
            setBottomNavScrollHidden(false);
            lastScrollY = y;
        } else {
            const delta = y - lastScrollY;
            if (Math.abs(delta) >= 6) {
                setBottomNavScrollHidden(delta > 0 && y > 96);
                lastScrollY = y;
            }
        }

        if (!backToTopBtn) return;
        // 滚过约一屏半才值得给一个「回去」的入口（列表越长越有用，首屏不要多一个浮钮）
        const shouldShow = y > window.innerHeight * 1.5;
        backToTopBtn.classList.toggle('is-visible', shouldShow);
        if (!shouldShow) return;
        const fabVisible = !!fabBtn && fabBtn.style.display !== 'none' && !fabBtn.classList.contains('hidden');
        backToTopBtn.classList.toggle('above-fab', fabVisible);
    }, { passive: true });





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

    const safeInit = (name, fn) => {
        try {
            const result = fn();
            // 大多数 init* 是 async：同步 try/catch 抓不到 Promise rejection，
            // 一个模块初始化失败会变成 unhandledrejection 且不落日志。
            if (result && typeof result.then === 'function') {
                result.catch((err) => console.error(`[init] ${name} failed`, err));
            }
        } catch (err) {
            console.error(`[init] ${name} failed`, err);
        }
    };

    // 登录 UI 优先挂载，避免其它模块初始化失败导致按钮无响应
    bindApiHooks({
        onRefresh(kind, opts = {}) {
            if (kind === 'all') {
                actions.renderCards?.();
                actions.renderNotes?.();
                actions.renderBookmarks?.();
                actions.renderPrompts?.();
                actions.renderFeeds?.();
                actions.renderEchoCards?.();
                actions.renderHeatmap?.();
                actions.renderMoodPills?.();
                actions.renderSerendipityCard?.();
                actions.renderTopicShelves?.();
                return;
            }
            if (kind === 'weeklies') {
                actions.renderCards?.(opts.filter || 'all');
                actions.renderTopicShelves?.();
            }
            if (kind === 'notes') {
                actions.renderNotes?.();
                actions.renderTopicShelves?.();
            }
            if (kind === 'bookmarks') actions.renderBookmarks?.();
            if (kind === 'prompts') actions.renderPrompts?.();
            if (kind === 'feeds') {
                actions.renderFeeds?.();
                actions.renderTopicShelves?.();
            }
            if (kind === 'echo') actions.renderEchoCards?.();
            if (kind === 'heatmap') actions.renderHeatmap?.();
        }
    });
    safeInit('authUI', initAuthUI);
    checkAuth();

    safeInit('weeklies', initWeeklies);
    safeInit('notes', initNotes);
    safeInit('bookmarks', initBookmarks);
    safeInit('feeds', initFeeds);
    safeInit('echoAi', initEchoAi);
    safeInit('search', initSearch);
    safeInit('wikilinks', initWikilinks);
    safeInit('dailySpark', initDailySpark);
    safeInit('evergreenTopics', initEvergreenTopics);
    safeInit('router', initRouter);

    loadLocalData();

    // 会话恢复：优先本地 Bearer（旧版），其次服务端 HttpOnly Cookie（新版）
    restoreCookieSession()
        .catch(() => false)
        .then((restored) => {
            if (restored) {
                checkAuth();
            }
            if (state.authToken || state.cookieSession) {
                // 滑动续期：静默换新令牌，避免固定 7 天到期被强制登出
                refreshSession().catch(() => {});
                syncFromApi().catch((e) => console.warn('[init] syncFromApi', e));
            }
        });

    safeInit('mergeGuest', checkAndMergeGuestData);
    safeInit('autoSync', startAutoSyncEngine);

    // 恢复 URL hash（刷新后回到对应视图）；无 hash 时写入首页，便于系统返回键工作
    try {
        if (location.hash && location.hash !== '#' && location.hash !== '#/home') {
            actions.applyRoute(actions.parseHashRoute());
        } else {
            history.replaceState({ view: ui.currentActiveNavView || 'home' }, '', `#/${ui.currentActiveNavView || 'home'}`);
        }
    } catch (err) {
        console.warn('[init] route restore failed', err);
    }

    // PWA：注册 SW，并在打开/切回前台时主动检查更新
    safeInit('pwaUpdates', initPwaUpdates);

    // 定期备份守卫：延迟静默巡检并适时提醒
    setTimeout(() => {
        checkAndSendBackupGuardNotification().catch(() => {});
    }, 3000);

    // 📶 极简 Apple HIG 离线韧性提示条 (Reassuring Offline Bar)
    const offlineBar = document.getElementById('offline-bar');
    const offlineBarText = document.getElementById('offline-bar-text');
    let offlineDismissTimer = null;

    function showOfflineBar(message, status = 'offline') {
        if (!offlineBar) return;
        if (offlineDismissTimer) {
            clearTimeout(offlineDismissTimer);
            offlineDismissTimer = null;
        }
        offlineBar.hidden = false;
        offlineBar.className = `offline-banner is-${status}`;
        if (offlineBarText) offlineBarText.textContent = message;
    }

    function hideOfflineBar(delay = 0) {
        if (!offlineBar) return;
        if (offlineDismissTimer) clearTimeout(offlineDismissTimer);
        const performHide = () => {
            offlineBar.classList.add('is-hiding');
            setTimeout(() => {
                offlineBar.hidden = true;
                offlineBar.classList.remove('is-hiding');
            }, 350);
        };
        if (delay <= 0) {
            performHide();
        } else {
            offlineDismissTimer = setTimeout(performHide, delay);
        }
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        document.body.classList.add('is-offline');
        setSyncStatus('离线就绪', 'warn');
        showOfflineBar('离线就绪 · 本地 IndexedDB 已安全持久化，联网自动增量同步', 'offline');
    }

    window.addEventListener('offline', () => {
        document.body.classList.add('is-offline');
        setSyncStatus('离线就绪', 'warn');
        showOfflineBar('离线就绪 · 本地 IndexedDB 已安全持久化，联网自动增量同步', 'offline');
    });

    window.addEventListener('online', () => {
        document.body.classList.remove('is-offline');
        setSyncStatus('正在同步', 'warn');
        showOfflineBar('网络已恢复 · 正在增量同步本地最新改动...', 'syncing');

        if (state.authToken || state.cookieSession) {
            syncFromApi()
                .then(() => {
                    showOfflineBar('已恢复在线 · 云端与本地数据已全部对齐', 'synced');
                    hideOfflineBar(3000);
                })
                .catch((err) => {
                    console.warn('[online] auto sync failed', err);
                    showOfflineBar('网络已连接 · 后台增量同步重试中', 'warn');
                    hideOfflineBar(4000);
                });
        } else {
            showOfflineBar('已恢复在线', 'synced');
            hideOfflineBar(2500);
        }
    });
});




