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
    checkAndMergeGuestData,
    startAutoSyncEngine,
    bindApiHooks,
    restoreCookieSession,
} from './js/api.js';
import { initRouter } from './js/router.js';
import { initWeeklies } from './js/weeklies.js';
import { initNotes } from './js/notes.js';
import { initBookmarks } from './js/bookmarks.js';
import { initPrompts } from './js/prompts.js';
import { initUpload } from './js/upload.js';
import { initReader } from './js/reader.js';
import { initFeeds } from './js/feeds.js';
import { initEchoAi } from './js/echo-ai.js';
import { initSearch } from './js/search.js';
import { initWikilinks } from './js/wikilinks.js';
import { showToast } from './js/utils.js';
import { initPwaUpdates } from './js/pwa-update.js';

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

    // Navbar scroll affordance
    const navbar = document.getElementById('navbar');
    window.addEventListener('scroll', () => {
        if (window.scrollY > 20) navbar.classList.add('scrolled');
        else navbar.classList.remove('scrolled');
    });





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
            fn();
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
                return;
            }
            if (kind === 'weeklies') actions.renderCards?.(opts.filter || 'all');
            if (kind === 'notes') actions.renderNotes?.();
            if (kind === 'bookmarks') actions.renderBookmarks?.();
            if (kind === 'prompts') actions.renderPrompts?.();
            if (kind === 'feeds') actions.renderFeeds?.();
            if (kind === 'echo') actions.renderEchoCards?.();
            if (kind === 'heatmap') actions.renderHeatmap?.();
        }
    });
    safeInit('authUI', initAuthUI);
    checkAuth();

    safeInit('upload', initUpload);
    safeInit('weeklies', initWeeklies);
    safeInit('notes', initNotes);
    safeInit('bookmarks', initBookmarks);
    safeInit('prompts', initPrompts);
    safeInit('reader', initReader);
    safeInit('feeds', initFeeds);
    safeInit('echoAi', initEchoAi);
    safeInit('search', initSearch);
    safeInit('wikilinks', initWikilinks);
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

    // 📶 离线感知与网络恢复自动同步
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        document.body.classList.add('is-offline');
    }

    window.addEventListener('offline', () => {
        document.body.classList.add('is-offline');
        showToast('📶 当前处于离线状态，新内容将保存在本地', 'warn');
    });

    window.addEventListener('online', () => {
        document.body.classList.remove('is-offline');
        showToast('🌐 网络已恢复连接，正在自动同步...', 'success');
        if (state.authToken || state.cookieSession) {
            syncFromApi().catch((err) => console.warn('[online] auto sync failed', err));
        }
    });
});




