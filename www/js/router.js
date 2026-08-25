import { state } from './state.js';
import { ui } from './ui.js';
import { actions } from './actions.js';

export function initRouter() {
    const views = document.querySelectorAll('.view-section');
    const navItems = document.querySelectorAll('.nav-item, .mobile-tab-item');
    const btnBack = document.getElementById('btn-back');
    const navMenu = document.getElementById('nav-menu');
    const fabBtn = document.getElementById('btn-create-new');
    const mobileBottomNav = document.getElementById('mobile-bottom-nav');

    const MAIN_VIEWS = new Set(['home', 'feeds', 'notes', 'bookmarks', 'reader']);

    const buildHashForView = (viewId) => {
    if (viewId === 'article' && ui.currentArticleId != null) return `#/article/${ui.currentArticleId}`;
    if (viewId === 'editor') {
        const id = document.getElementById('edit-id')?.value;
        return id ? `#/editor/${id}` : '#/editor';
    }
    if (viewId === 'note-editor') {
        const id = ui.currentNoteId || document.getElementById('edit-note-id')?.value;
        return id ? `#/note-editor/${id}` : '#/note-editor';
    }
    if (viewId === 'bookmark-editor') return '#/bookmark-editor';
    if (viewId === 'reader-book') return '#/reader-book';
    if (viewId === 'ai') return '#/ai';
    return `#/${viewId || 'home'}`;
};

const parseHashRoute = (hash = location.hash) => {
    const raw = String(hash || '').replace(/^#\/?/, '').trim();
    if (!raw) return { view: 'home' };
    const [view, id] = raw.split('/');
    return { view: view || 'home', id: id || null };
};

const applyRoute = (route) => {
    if (!route || !route.view) return;
    if (route.view === 'ai') {
        const modal = document.getElementById('ai-chat-modal');
        if (modal) modal.classList.add('show');
        ui.aiModalInHistory = true;
        return;
    }
    const modal = document.getElementById('ai-chat-modal');
    if (modal) modal.classList.remove('show');
    ui.aiModalInHistory = false;

    if (route.view === 'article' && route.id) {
        const item = state.database.find(d => String(d.id) === String(route.id));
        if (item) {
            actions.openArticle(item, { skipHistory: true });
            return;
        }
        switchView('home', { skipHistory: true });
        return;
    }
    if (route.view === 'editor') {
        actions.openWeeklyEditor(route.id ? Number(route.id) || route.id : null, { skipHistory: true });
        return;
    }
    if (route.view === 'note-editor') {
        actions.openNoteEditor(route.id ? Number(route.id) || route.id : null, { skipHistory: true });
        return;
    }
    if (route.view === 'bookmark-editor') {
        switchView('bookmark-editor', { skipHistory: true });
        return;
    }
    if (route.view === 'reader-book') {
        if ((document.querySelector('.view-section.active')?.id || '') !== 'view-reader-book') switchView('reader', { skipHistory: true });
        else switchView('reader-book', { skipHistory: true });
        return;
    }
    if (MAIN_VIEWS.has(route.view)) {
        switchView(route.view, { skipHistory: true });
        return;
    }
    switchView('home', { skipHistory: true });
};

const switchView = (targetViewId, opts = {}) => {
    const { skipHistory = false, replaceHistory = false } = opts;
    const targetEl = document.getElementById(`view-${targetViewId}`);
    if (!targetEl) return;

    const prevActiveId = document.querySelector('.view-section.active')?.id || '';
    if (prevActiveId === 'view-reader-book' && targetViewId !== 'reader-book') {
        actions.clearReaderSession?.();
    }

    views.forEach(view => view.classList.remove('active'));
    targetEl.classList.add('active');
    
    if (MAIN_VIEWS.has(targetViewId)) {
        ui.currentActiveNavView = targetViewId;
        navItems.forEach(item => item.classList.remove('active'));
        const activeNavs = document.querySelectorAll(`.nav-item[data-view="${targetViewId}"], .mobile-tab-item[data-view="${targetViewId}"]`);
        activeNavs.forEach(nav => nav.classList.add('active'));
        // Always leave reader chrome when on a main tab (fixes swipe-back theme leak)
        document.body.classList.remove('dark-reader-body', 'eyecare-reader-body');
        const readerLayout = document.querySelector('.reader-layout');
        if (readerLayout) readerLayout.classList.remove('dark-reader', 'eyecare-reader');
        const themeMeta = document.querySelector('meta[name="theme-color"]');
        if (themeMeta && (themeMeta.getAttribute('content') === '#0d1117' || themeMeta.getAttribute('content') === '#dcedc8' || themeMeta.getAttribute('content') === '#ffffff')) {
            themeMeta.setAttribute('content', '#F2F2F7');
        }
        if (targetViewId === 'reader') {
            setTimeout(actions.renderBookshelf, 100);
        } else if (targetViewId === 'feeds') {
            actions.renderFeeds();
        } else if (targetViewId === 'home') {
            actions.renderHeatmap();
        }
    }

    // Update FAB label
    const fabLabel = document.getElementById('fab-label');
    const fabLabels = { home: '记录新片段', feeds: '记录随手记', notes: '记录新笔记', bookmarks: '收藏新链接', reader: '导入新书' };
    if (fabLabel && fabLabels[targetViewId]) fabLabel.textContent = fabLabels[targetViewId];

    if (targetViewId === 'article' || targetViewId === 'editor' || targetViewId === 'note-editor' || targetViewId === 'bookmark-editor' || targetViewId === 'reader-book') {
        navMenu.style.display = 'none';
        btnBack.style.display = 'block';
        fabBtn.classList.add('hidden');
        fabBtn.style.display = 'none';
        if (mobileBottomNav) {
            mobileBottomNav.style.display = 'none';
            mobileBottomNav.classList.add('hidden');
        }
        document.body.classList.add('hide-bottom-nav');
    } else {
        navMenu.style.display = '';
        btnBack.style.display = 'none';
        if (mobileBottomNav) {
            mobileBottomNav.style.display = '';
            mobileBottomNav.classList.remove('hidden');
        }
        document.body.classList.remove('hide-bottom-nav');

        // 随手记页面已有页内倾倒框，隐藏右下角悬浮 + 按钮
        if (targetViewId === 'feeds') {
            fabBtn.classList.add('hidden');
            fabBtn.style.display = 'none';
        } else {
            fabBtn.classList.remove('hidden');
            fabBtn.style.display = '';
        }
    }
    window.scrollTo(0, 0);

    if (!skipHistory && !ui.historyNavLock) {
        const hash = buildHashForView(targetViewId);
        const histState = { view: targetViewId, articleId: ui.currentArticleId, noteId: ui.currentNoteId };
        if (replaceHistory || !location.hash) {
            history.replaceState(histState, '', hash);
        } else if (location.hash !== hash) {
            history.pushState(histState, '', hash);
        } else {
            history.replaceState(histState, '', hash);
        }
    }
};

const goBackOrHome = () => {
    document.body.classList.remove('dark-reader-body', 'eyecare-reader-body');
    const finish = () => {
        if (window.history.length > 1 && location.hash && !MAIN_VIEWS.has(parseHashRoute().view)) {
            history.back();
            return;
        }
        switchView(ui.currentActiveNavView);
        ui.currentArticleId = null;
        ui.currentNoteId = null;
    };
    const activeView = document.querySelector('.view-section.active');
    if (activeView && activeView.id === 'view-editor') {
        actions.handleExitWeeklyEditor(finish);
    } else {
        finish();
    }
};

navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const targetEl = e.currentTarget || e.target.closest('[data-view]');
        const view = targetEl ? targetEl.dataset.view : null;
        if (view) switchView(view);
    });
});

btnBack.addEventListener('click', () => {
    const activeView = document.querySelector('.view-section.active');
    if (activeView && activeView.id === 'view-reader-book') {
        window.closeReaderBook?.();
        return;
    }
    goBackOrHome();
});

window.addEventListener('popstate', (e) => {
    const intended = (e.state && e.state.view)
        ? { view: e.state.view, id: e.state.articleId || e.state.noteId || null }
        : parseHashRoute();

    const applyIntended = () => {
        ui.historyNavLock = true;
        try {
            applyRoute(intended);
            let hash = '#/home';
            if (intended.view === 'ai') hash = '#/ai';
            else if (intended.id) hash = `#/${intended.view}/${intended.id}`;
            else hash = `#/${intended.view || 'home'}`;
            history.replaceState(
                { view: intended.view, articleId: intended.id, noteId: intended.id },
                '',
                hash
            );
        } finally {
            ui.historyNavLock = false;
        }
    };

    const activeView = document.querySelector('.view-section.active');
    if (activeView && activeView.id === 'view-editor' && actions.hasUnsavedChanges()) {
        // 先顶回编辑页 hash，避免取消确认后 URL 已离开编辑器
        history.pushState({ view: 'editor', articleId: ui.currentArticleId }, '', buildHashForView('editor'));
        actions.handleExitWeeklyEditor(applyIntended);
        return;
    }
    applyIntended();
});

fabBtn.addEventListener('click', () => {
    if (ui.currentActiveNavView === 'home') actions.openWeeklyEditor(null);
    else if (ui.currentActiveNavView === 'notes') actions.openNoteEditor(null);
    else if (ui.currentActiveNavView === 'bookmarks') actions.openBookmarkEditor();
    else if (ui.currentActiveNavView === 'reader') document.getElementById('book-file-input').click();
});



    actions.switchView = switchView;
    actions.applyRoute = applyRoute;
    actions.parseHashRoute = parseHashRoute;

    return { switchView, applyRoute, parseHashRoute, goBackOrHome, buildHashForView };
}
