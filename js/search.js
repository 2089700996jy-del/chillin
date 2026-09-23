/**
 * Global Search & Command Palette (Cmd/Ctrl + K).
 * Provides content searching across weeklies, notes, bookmarks, feeds, prompts, and echo cards,
 * combined with quick actions, keyword highlighting (<mark>), and full keyboard navigation (↑/↓/Enter).
 */
import { escapeHtml } from './utils.js';
import { state } from './state.js';
import { actions } from './actions.js';

export function highlightMatches(text, query) {
    if (!text) return '';
    if (!query) return escapeHtml(text);
    const trimmed = query.trim();
    if (!trimmed) return escapeHtml(text);
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
        const regex = new RegExp(`(${escaped})`, 'gi');
        return String(text).split(regex).map((part) => {
            if (part.toLowerCase() === trimmed.toLowerCase()) {
                return `<mark class="search-highlight">${escapeHtml(part)}</mark>`;
            }
            return escapeHtml(part);
        }).join('');
    } catch (_) {
        return escapeHtml(text);
    }
}

export function initSearch() {
    const globalSearchModal = document.getElementById('global-search-modal');
    const globalSearchInput = document.getElementById('global-search-input');
    const globalSearchResults = document.getElementById('global-search-results');
    const btnOpenGlobalSearch = document.getElementById('btn-open-global-search');
    const btnCloseGlobalSearch = document.getElementById('btn-close-global-search');

    let currentItems = [];
    let selectedIndex = 0;

    const QUICK_ACTIONS = [
        {
            id: 'action-ai',
            icon: '✨',
            title: '呼叫 AI 记忆回响',
            desc: '向你的个人数字花园记忆库发起深度提问与联想',
            keywords: ['ai', '回响', '问答', '助手', '对话', 'chat'],
            run: () => {
                closeGlobalSearch();
                const aiModal = document.getElementById('ai-chat-modal');
                const aiInput = document.getElementById('ai-chat-input');
                if (aiModal) {
                    aiModal.classList.add('show');
                    if (aiInput) setTimeout(() => aiInput.focus(), 150);
                }
            }
        },
        {
            id: 'action-new-feed',
            icon: '⚡',
            title: '快速写随手记',
            desc: '捕捉瞬间火花，写入时间轴流切片',
            keywords: ['写', '记', '随手记', 'feed', '新建', '发'],
            run: () => {
                closeGlobalSearch();
                actions.switchView('feeds');
                setTimeout(() => {
                    const feedInput = document.getElementById('feed-input');
                    if (feedInput) {
                        feedInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        feedInput.focus();
                    }
                }, 250);
            }
        },
        {
            id: 'action-new-note',
            icon: '📝',
            title: '新建长篇笔记',
            desc: '记录深度思考或长文，支持时间线批注',
            keywords: ['笔记', '新建', 'note', '写笔记', '文'],
            run: () => {
                closeGlobalSearch();
                if (actions.openNoteEditor) actions.openNoteEditor();
            }
        },
        {
            id: 'action-new-weekly',
            icon: '🌸',
            title: '撰写新周记',
            desc: '记录一周的生活、影视、音乐与烟火日常',
            keywords: ['周记', 'weekly', '写周记', '新建', '总结'],
            run: () => {
                closeGlobalSearch();
                if (actions.openWeeklyEditor) actions.openWeeklyEditor();
            }
        },
        {
            id: 'action-new-prompt',
            icon: '🤖',
            title: '新建提示词 (Prompt)',
            desc: '添加可填参的高效 AI 模板，便于随取随用',
            keywords: ['提示词', 'prompt', 'ai', '模板', '新建'],
            run: () => {
                closeGlobalSearch();
                if (actions.openPromptEditor) actions.openPromptEditor();
            }
        },
        {
            id: 'action-new-bookmark',
            icon: '🔖',
            title: '添加网页收藏',
            desc: '收藏高质量文章、灵感工具或灵感站点',
            keywords: ['收藏', '书签', 'bookmark', '网址', '链接', '新建'],
            run: () => {
                closeGlobalSearch();
                if (actions.openBookmarkEditor) actions.openBookmarkEditor();
            }
        },
        {
            id: 'action-sync-now',
            icon: '🔄',
            title: '立即执行云端同步',
            desc: '聚合拉取并双向合并本地变动数据',
            keywords: ['同步', 'sync', '刷新', '上传', '云端'],
            run: async () => {
                closeGlobalSearch();
                try {
                    const { syncFromApi } = await import('./api.js');
                    await syncFromApi();
                } catch (err) {
                    console.error('[CommandPalette] sync failed', err);
                }
            }
        }
    ];

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


    function updateSelectionHighlight() {
        const elList = globalSearchResults.querySelectorAll('.global-search-item');
        elList.forEach((el, idx) => {
            if (idx === selectedIndex) {
                el.classList.add('active-selection');
                el.scrollIntoView({ block: 'nearest' });
            } else {
                el.classList.remove('active-selection');
            }
        });
    }

    if (globalSearchInput) {
        globalSearchInput.addEventListener('input', (e) => {
            renderGlobalSearchResults(e.target.value.trim());
        });

        globalSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (currentItems.length > 0) {
                    selectedIndex = (selectedIndex + 1) % currentItems.length;
                    updateSelectionHighlight();
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (currentItems.length > 0) {
                    selectedIndex = (selectedIndex - 1 + currentItems.length) % currentItems.length;
                    updateSelectionHighlight();
                }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (currentItems[selectedIndex] && typeof currentItems[selectedIndex].run === 'function') {
                    currentItems[selectedIndex].run();
                }
            }
        });
    }

    function renderGlobalSearchResults(query) {
        if (!globalSearchResults) return;
        currentItems = [];
        selectedIndex = 0;

        const isActionCommand = query.startsWith('>');
        const cleanQuery = isActionCommand ? query.slice(1).trim().toLowerCase() : query.toLowerCase();

        // 1. 如果搜索框为空，渲染默认快捷操作建议
        if (!query) {
            let html = `
                <div class="global-search-section-header">⚡ 快捷操作（输入关键词搜索切片，或 ↑↓ 键选择）</div>
            `;
            html += QUICK_ACTIONS.map((action, idx) => {
                currentItems.push({
                    type: 'action',
                    run: action.run
                });
                return `
                    <div class="global-search-item command-action-item ${idx === 0 ? 'active-selection' : ''}" data-item-index="${idx}">
                        <div class="global-search-item-header">
                            <span class="global-search-title">${action.icon} ${escapeHtml(action.title)}</span>
                            <span class="global-search-tag">指令</span>
                        </div>
                        <div class="global-search-snippet">${escapeHtml(action.desc)}</div>
                    </div>
                `;
            }).join('');

            globalSearchResults.innerHTML = html;
            bindItemEvents();
            return;
        }

        // 2. 匹配快捷动作 (以 > 开头，或匹配动作关键词)
        const matchedActions = QUICK_ACTIONS.filter(act => {
            if (isActionCommand) {
                return !cleanQuery || act.title.toLowerCase().includes(cleanQuery) || act.keywords.some(k => k.includes(cleanQuery));
            }
            return act.title.toLowerCase().includes(cleanQuery) || act.keywords.some(k => k === cleanQuery);
        });

        // 3. 匹配花园记忆库 (周记、随手记、笔记、收藏、AI回响、提示词)
        const contentResults = [];
        if (!isActionCommand) {
            const q = cleanQuery;

            // 周记
            (state.database || []).forEach(w => {
                if ((w.title || '').toLowerCase().includes(q) || (w.summary || '').toLowerCase().includes(q) || (w.content || '').toLowerCase().includes(q)) {
                    contentResults.push({
                        type: '周记',
                        view: 'home',
                        id: w.id,
                        title: w.title || '无标题周记',
                        snippet: w.summary || (w.content || '').slice(0, 90),
                        targetElSelector: `.notion-collection-card[data-id="${CSS.escape(String(w.id))}"]`
                    });
                }
            });

            // 随手记
            (state.feedsDatabase || []).forEach(f => {
                if ((f.content || '').toLowerCase().includes(q) || (f.summary || '').toLowerCase().includes(q)) {
                    contentResults.push({
                        type: '⚡ 随手记',
                        view: 'feeds',
                        id: f.id,
                        title: f.created_at || '随手记切片',
                        snippet: f.content,
                        targetElSelector: `[data-feed-id="${CSS.escape(String(f.id))}"]`
                    });
                }
            });

            // 笔记
            (state.notesDatabase || []).forEach(n => {
                if ((n.title || '').toLowerCase().includes(q) || (n.content || '').toLowerCase().includes(q)) {
                    contentResults.push({
                        type: '📝 笔记',
                        view: 'notes',
                        id: n.id,
                        title: n.title || '无标题笔记',
                        snippet: (n.content || '').slice(0, 90),
                        targetElSelector: `[data-note-id="${CSS.escape(String(n.id))}"]`
                    });
                }
            });

            // 收藏
            (state.bookmarksDatabase || []).forEach(b => {
                if ((b.title || '').toLowerCase().includes(q) || (b.desc || b.description || '').toLowerCase().includes(q) || (b.url || '').toLowerCase().includes(q)) {
                    contentResults.push({
                        type: '🔖 收藏',
                        view: 'bookmarks',
                        id: b.id,
                        title: b.title || '无标题收藏',
                        snippet: (b.desc || b.description || b.url || ''),
                        targetElSelector: `[data-bookmark-id="${CSS.escape(String(b.id))}"]`
                    });
                }
            });

            // AI 回响卡片
            (state.echoCardsDatabase || []).forEach(c => {
                if ((c.title || '').toLowerCase().includes(q) || (c.summary || '').toLowerCase().includes(q) || (c.topic || '').toLowerCase().includes(q)) {
                    contentResults.push({
                        type: '✨ AI 回响',
                        view: 'feeds',
                        id: c.id,
                        title: c.title || 'AI 回响卡片',
                        snippet: c.summary,
                        targetElSelector: `#echo-card-${CSS.escape(String(c.id))}`
                    });
                }
            });

            // 提示词
            (state.promptsDatabase || []).forEach(p => {
                if (
                    (p.title || '').toLowerCase().includes(q) ||
                    (p.content || '').toLowerCase().includes(q) ||
                    (p.description || '').toLowerCase().includes(q) ||
                    (p.tags || '').toLowerCase().includes(q) ||
                    (p.project || '').toLowerCase().includes(q) ||
                    (p.scene || '').toLowerCase().includes(q)
                ) {
                    contentResults.push({
                        type: '🤖 提示词',
                        view: 'bookmarks',
                        subtab: 'prompts',
                        id: p.id,
                        title: (p.project ? `[${p.project}] ` : '') + (p.title || '无标题提示词'),
                        snippet: p.description || (p.content || '').slice(0, 90),
                        targetElSelector: `[data-prompt-id="${CSS.escape(String(p.id))}"]`
                    });
                }
            });
        }

        if (matchedActions.length === 0 && contentResults.length === 0) {
            globalSearchResults.innerHTML = `<div class="global-search-empty">未匹配到与 "${escapeHtml(query)}" 相关的动作或切片记忆</div>`;
            return;
        }

        let html = '';

        // 渲染匹配到的动作
        if (matchedActions.length > 0) {
            html += `<div class="global-search-section-header">⚡ 快捷动作</div>`;
            matchedActions.forEach(action => {
                const itemIdx = currentItems.length;
                currentItems.push({
                    type: 'action',
                    run: action.run
                });
                html += `
                    <div class="global-search-item command-action-item ${itemIdx === 0 ? 'active-selection' : ''}" data-item-index="${itemIdx}">
                        <div class="global-search-item-header">
                            <span class="global-search-title">${action.icon} ${highlightMatches(action.title, cleanQuery)}</span>
                            <span class="global-search-tag">指令</span>
                        </div>
                        <div class="global-search-snippet">${highlightMatches(action.desc, cleanQuery)}</div>
                    </div>
                `;
            });
        }

        // 渲染匹配到的内容
        if (contentResults.length > 0) {
            html += `<div class="global-search-section-header">🔍 花园记忆切片 (${contentResults.length})</div>`;
            contentResults.slice(0, 20).forEach(item => {
                const itemIdx = currentItems.length;
                currentItems.push({
                    type: 'content',
                    run: () => {
                        closeGlobalSearch();
                        jumpToElement(item.view, item.targetElSelector, item.subtab);
                    }
                });
                html += `
                    <div class="global-search-item ${itemIdx === 0 ? 'active-selection' : ''}" data-item-index="${itemIdx}">
                        <div class="global-search-item-header">
                            <span class="global-search-title">${highlightMatches(item.title, cleanQuery)}</span>
                            <span class="global-search-tag">${escapeHtml(item.type)}</span>
                        </div>
                        <div class="global-search-snippet">${highlightMatches(item.snippet, cleanQuery)}</div>
                    </div>
                `;
            });
        }

        globalSearchResults.innerHTML = html;
        bindItemEvents();
    }

    function bindItemEvents() {
        const itemEls = globalSearchResults.querySelectorAll('.global-search-item');
        itemEls.forEach((el) => {
            const idx = parseInt(el.getAttribute('data-item-index'), 10);
            el.addEventListener('mouseenter', () => {
                selectedIndex = idx;
                updateSelectionHighlight();
            });
            el.addEventListener('click', () => {
                if (currentItems[idx] && typeof currentItems[idx].run === 'function') {
                    currentItems[idx].run();
                }
            });
        });
    }

    function jumpToElement(targetView, selector, subtab = null) {
        if (targetView && actions.switchView) actions.switchView(targetView);
        if (subtab && actions.switchBookmarksSubtab) {
            actions.switchBookmarksSubtab(subtab);
        }
        if (!selector) return;
        setTimeout(() => {
            const el = document.querySelector(selector);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.remove('highlight-flash');
                void el.offsetWidth;
                el.classList.add('highlight-flash');
            }
        }, 220);
    }

    actions.jumpToElement = jumpToElement;

    return { openGlobalSearch, closeGlobalSearch, jumpToElement };
}
