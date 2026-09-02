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
    registerPushNotification,
    loadLocalData,
    syncFromApi,
    checkAndMergeGuestData,
    startAutoSyncEngine,
    bindApiHooks,
} from './js/api.js';
import { initRouter } from './js/router.js';
import { initWeeklies } from './js/weeklies.js';
import { initNotes } from './js/notes.js';
import { initBookmarks } from './js/bookmarks.js';
import { initUpload } from './js/upload.js';
import { initReader } from './js/reader.js';
import { initFeeds } from './js/feeds.js';
import { initEchoAi } from './js/echo-ai.js';
import { initSearch } from './js/search.js';
import { initPwaUpdates } from './js/pwa-update.js';

document.addEventListener('DOMContentLoaded', () => {

    // Auth / sync: ./js/api.js + ./js/state.js
    // Feature domains: ./js/{router,weeklies,notes,bookmarks,upload,reader,feeds,echo-ai,search}.js

    const versionEls = document.querySelectorAll('[data-app-version]');
    versionEls.forEach((el) => { el.textContent = APP_BUILD_LABEL; });
    document.title = `Chillin · ${APP_BUILD_LABEL}`;

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
                actions.renderFeeds?.();
                actions.renderEchoCards?.();
                actions.renderHeatmap?.();
                return;
            }
            if (kind === 'weeklies') actions.renderCards?.(opts.filter || 'all');
            if (kind === 'notes') actions.renderNotes?.();
            if (kind === 'bookmarks') actions.renderBookmarks?.();
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
    safeInit('reader', initReader);
    safeInit('feeds', initFeeds);
    safeInit('echoAi', initEchoAi);
    safeInit('search', initSearch);
    safeInit('router', initRouter);

    if (state.authToken) {
        setTimeout(registerPushNotification, 2000);
    }
    loadLocalData();
    if (state.authToken) {
        syncFromApi().catch((e) => console.warn('[init] syncFromApi', e));
    }

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
});




