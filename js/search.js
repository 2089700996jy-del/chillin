import { escapeHtml } from './utils.js';
import { state } from './state.js';
import { actions } from './actions.js';

export function initSearch() {
const globalSearchModal = document.getElementById('global-search-modal');
const globalSearchInput = document.getElementById('global-search-input');
const globalSearchResults = document.getElementById('global-search-results');
const btnOpenGlobalSearch = document.getElementById('btn-open-global-search');
const btnCloseGlobalSearch = document.getElementById('btn-close-global-search');

function openGlobalSearch() {
    if (!globalSearchModal) return;
    globalSearchModal.classList.add('show');
    if (globalSearchInput) {
        globalSearchInput.value = '';
        globalSearchInput.focus();
        renderGlobalSearchResults('');
    }
}

function closeGlobalSearch() {
    if (!globalSearchModal) return;
    globalSearchModal.classList.remove('show');
}

if (btnOpenGlobalSearch) btnOpenGlobalSearch.addEventListener('click', openGlobalSearch);
if (btnCloseGlobalSearch) btnCloseGlobalSearch.addEventListener('click', closeGlobalSearch);
if (globalSearchModal) {
    globalSearchModal.addEventListener('click', (e) => {
        if (e.target === globalSearchModal) closeGlobalSearch();
    });
}

document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (globalSearchModal && globalSearchModal.classList.contains('show')) closeGlobalSearch();
        else openGlobalSearch();
    } else if (e.key === 'Escape' && globalSearchModal && globalSearchModal.classList.contains('show')) {
        closeGlobalSearch();
    }
});

if (globalSearchInput) {
    globalSearchInput.addEventListener('input', (e) => {
        renderGlobalSearchResults(e.target.value.trim());
    });
}

function renderGlobalSearchResults(query) {
    if (!globalSearchResults) return;
    if (!query) {
        globalSearchResults.innerHTML = `<div class="global-search-empty">输入关键词，搜索您的数字花园所有切片记忆...</div>`;
        return;
    }

    const q = query.toLowerCase();
    const results = [];

    // 1. 周记
    (state.database || []).forEach(w => {
        if ((w.title || '').toLowerCase().includes(q) || (w.summary || '').toLowerCase().includes(q) || (w.content || '').toLowerCase().includes(q)) {
            results.push({
                type: '周记',
                view: 'home',
                id: w.id,
                title: w.title || '无标题周记',
                snippet: w.summary || (w.content || '').slice(0, 80),
                targetElSelector: `#weekly-card-${w.id}`
            });
        }
    });

    // 2. 随手记
    (state.feedsDatabase || []).forEach(f => {
        if ((f.content || '').toLowerCase().includes(q) || (f.summary || '').toLowerCase().includes(q)) {
            results.push({
                type: '⚡ 随手记',
                view: 'feeds',
                id: f.id,
                title: f.created_at || '随手记切片',
                snippet: f.content,
                targetElSelector: `[data-feed-id="${f.id}"]`
            });
        }
    });

    // 3. 笔记
    (state.notesDatabase || []).forEach(n => {
        if ((n.title || '').toLowerCase().includes(q) || (n.content || '').toLowerCase().includes(q)) {
            results.push({
                type: '📝 笔记',
                view: 'notes',
                id: n.id,
                title: n.title || '无标题笔记',
                snippet: (n.content || '').slice(0, 80),
                targetElSelector: `[data-note-id="${n.id}"]`
            });
        }
    });

    // 4. 收藏
    (state.bookmarksDatabase || []).forEach(b => {
        if ((b.title || '').toLowerCase().includes(q) || (b.desc || b.description || '').toLowerCase().includes(q) || (b.url || '').toLowerCase().includes(q)) {
            results.push({
                type: '🔖 收藏',
                view: 'bookmarks',
                id: b.id,
                title: b.title || '无标题收藏',
                snippet: (b.desc || b.description || b.url || ''),
                targetElSelector: `[data-bookmark-id="${b.id}"]`
            });
        }
    });

    // 5. AI 回响卡片
    (state.echoCardsDatabase || []).forEach(c => {
        if ((c.title || '').toLowerCase().includes(q) || (c.summary || '').toLowerCase().includes(q) || (c.topic || '').toLowerCase().includes(q)) {
            results.push({
                type: '✨ AI 回响',
                view: 'home',
                id: c.id,
                title: c.title || 'AI 回响卡片',
                snippet: c.summary,
                targetElSelector: `#echo-card-${c.id}`
            });
        }
    });

    // 6. 阅读批注
    (actions.getReaderAnnotations?.() || []).forEach(a => {
        if ((a.text || '').toLowerCase().includes(q)) {
            results.push({
                type: '📚 阅读批注',
                view: 'reader',
                id: a.id,
                title: a.bookTitle ? `《${a.bookTitle}》批注` : '阅读批注',
                snippet: a.text,
                targetElSelector: `[data-annotation-id="${a.id}"]`
            });
        }
    });

    if (results.length === 0) {
        globalSearchResults.innerHTML = `<div class="global-search-empty">未匹配到与 "${escapeHtml(query)}" 相关的切片</div>`;
        return;
    }

    globalSearchResults.innerHTML = results.slice(0, 15).map(item => `
        <div class="global-search-item" data-view="${item.view}" data-selector="${escapeHtml(item.targetElSelector || '')}">
            <div class="global-search-item-header">
                <span class="global-search-title">${escapeHtml(item.title)}</span>
                <span class="global-search-tag">${escapeHtml(item.type)}</span>
            </div>
            <div class="global-search-snippet">${escapeHtml(item.snippet)}</div>
        </div>
    `).join('');

    globalSearchResults.querySelectorAll('.global-search-item').forEach(el => {
        el.addEventListener('click', () => {
            const targetView = el.getAttribute('data-view');
            const selector = el.getAttribute('data-selector');
            closeGlobalSearch();
            jumpToElement(targetView, selector);
        });
    });
}

function jumpToElement(targetView, selector) {
    if (targetView) actions.switchView(targetView);
    if (!selector) return;
    setTimeout(() => {
        const el = document.querySelector(selector);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.remove('highlight-flash');
            void el.offsetWidth;
            el.classList.add('highlight-flash');
        }
    }, 150);
}



    return { openGlobalSearch, closeGlobalSearch };
}
