/**
 * Wikilinks & Backlinks Engine for Chillin (Zero-Build ESM).
 * Provides bi-directional linking [[title]] or [[title|alias]],
 * backlink discovery, and iOS-style typing autocomplete.
 */
import { escapeHtml, confirmDialog, getChineseDate } from './utils.js';
import { setHtml } from './trusted-types.js';
import { state } from './state.js';
import { actions } from './actions.js';
import { saveNotesDatabase, apiSyncNote, stampLocalUpdate } from './api.js';

/** Regular expression for matching [[target]] or [[target|alias]] */
export const WIKILINK_REGEX = /\[\[([^[\]|\n\r]+)(?:\|([^[\]|\n\r]+))?\]\]/g;

/**
 * Parses wikilinks in safe text into clickable HTML pills.
 * Can be used after or during HTML formatting.
 *
 * @param {string} text Raw or escaped text containing [[wikilinks]]
 * @param {boolean} [preEscaped=false] If true, the text is already HTML escaped
 * @returns {string} HTML string with .wikilink-pill elements
 */
export function parseWikilinksToHtml(text, preEscaped = false) {
    if (!text) return '';
    const safeBase = preEscaped ? String(text) : escapeHtml(text);
    return safeBase.replace(WIKILINK_REGEX, (match, target, alias) => {
        let cleanTarget = (target || '').trim();
        let cleanLabel = (alias || target || '').trim();
        if (!cleanTarget) return match;
        if (preEscaped) {
            cleanTarget = escapeHtml(cleanTarget);
            cleanLabel = escapeHtml(cleanLabel);
        }
        return `<span class="wikilink-pill" data-wikilink="${cleanTarget}" role="button" tabindex="0"><span class="wikilink-icon">🔗</span><span class="wikilink-label">${cleanLabel}</span></span>`;
    });
}

/**
 * Extracts an array of unique referenced target titles from text.
 *
 * @param {string} text
 * @returns {string[]} Array of target titles
 */
export function extractWikilinks(text) {
    if (!text) return [];
    const titles = new Set();
    const regex = new RegExp(WIKILINK_REGEX.source, 'g');
    let match;
    while ((match = regex.exec(text)) !== null) {
        const t = (match[1] || '').trim();
        if (t) titles.add(t);
    }
    return Array.from(titles);
}

/**
 * Extracts a short snippet around a wikilink mention in content.
 *
 * @param {string} content Full text
 * @param {string} targetTitle Target to find
 * @param {number} [radius=28] Context radius
 * @returns {string} Escaped HTML snippet with <mark> around the link
 */
export function extractBacklinkSnippet(content, targetTitle, radius = 28) {
    if (!content || !targetTitle) return '';
    const normalizedTarget = targetTitle.trim().toLowerCase();
    const regex = new RegExp(WIKILINK_REGEX.source, 'gi');
    let match;
    let snippetFound = '';

    while ((match = regex.exec(content)) !== null) {
        const t = (match[1] || '').trim().toLowerCase();
        if (t === normalizedTarget) {
            const start = Math.max(0, match.index - radius);
            const end = Math.min(content.length, match.index + match[0].length + radius);
            const prefix = start > 0 ? '…' : '';
            const suffix = end < content.length ? '…' : '';
            const rawSnippet = prefix + content.slice(start, end).replace(/[\r\n]+/g, ' ') + suffix;
            
            // Safe escape and highlight target
            const displayLabel = (match[2] || match[1] || '').trim();
            const escaped = escapeHtml(rawSnippet);
            const escapedTarget = escapeHtml(match[0]);
            snippetFound = escaped.replace(escapedTarget, `<mark>${escapeHtml(displayLabel || targetTitle)}</mark>`);
            break;
        }
    }

    if (!snippetFound) {
        const clean = content.replace(/[\r\n]+/g, ' ').trim();
        snippetFound = escapeHtml(clean.slice(0, radius * 2) + (clean.length > radius * 2 ? '…' : ''));
    }
    return snippetFound;
}

/**
 * Finds all items across notes, weeklies, and feeds referencing targetTitle.
 *
 * @param {string} targetTitle
 * @param {number|string|null} [currentId=null]
 * @param {string|null} [currentType=null] 'note' | 'weekly' | 'feed'
 * @returns {Array<{type: string, id: any, title: string, date: string, snippet: string}>}
 */
export function findBacklinks(targetTitle, currentId = null, currentType = null) {
    if (!targetTitle || !targetTitle.trim()) return [];
    const normalizedTarget = targetTitle.trim().toLowerCase();
    const results = [];

    // Helper: checks if text mentions [[targetTitle]]
    const mentionsTarget = (text) => {
        if (!text) return false;
        const links = extractWikilinks(text);
        return links.some(link => link.trim().toLowerCase() === normalizedTarget);
    };

    // 1. Scan Notes
    if (Array.isArray(state.notesDatabase)) {
        for (const note of state.notesDatabase) {
            if (currentType === 'note' && String(note.id) === String(currentId)) continue;
            if (mentionsTarget(note.content)) {
                results.push({
                    type: 'note',
                    id: note.id,
                    title: note.title || '无标题笔记',
                    date: note.date || '',
                    snippet: extractBacklinkSnippet(note.content, targetTitle)
                });
            }
        }
    }

    // 2. Scan Weeklies
    if (Array.isArray(state.database)) {
        for (const weekly of state.database) {
            if (currentType === 'weekly' && String(weekly.id) === String(currentId)) continue;
            if (mentionsTarget(weekly.content) || mentionsTarget(weekly.summary)) {
                results.push({
                    type: 'weekly',
                    id: weekly.id,
                    title: weekly.title || '无标题周记',
                    date: weekly.date || '',
                    snippet: extractBacklinkSnippet(weekly.content || weekly.summary, targetTitle)
                });
            }
        }
    }

    // 3. Scan Feeds
    if (Array.isArray(state.feedsDatabase)) {
        for (const feed of state.feedsDatabase) {
            if (currentType === 'feed' && String(feed.id) === String(currentId)) continue;
            if (mentionsTarget(feed.content)) {
                results.push({
                    type: 'feed',
                    id: feed.id,
                    title: `随手记 #${feed.id}`,
                    date: feed.created_at ? feed.created_at.slice(0, 16) : '',
                    snippet: extractBacklinkSnippet(feed.content, targetTitle)
                });
            }
        }
    }

    return results;
}

/**
 * Navigates to the note or weekly matching targetTitle.
 * Prompts to create a new note if neither exists.
 *
 * @param {string} targetTitle
 */
export async function navigateToWikilink(targetTitle) {
    if (!targetTitle || !targetTitle.trim()) return;
    const cleanTitle = targetTitle.trim();
    const normalized = cleanTitle.toLowerCase();

    // 1. Look for matching Note
    const matchedNote = (state.notesDatabase || []).find(n => (n.title || '').trim().toLowerCase() === normalized);
    if (matchedNote) {
        if (actions.openNoteEditor) {
            actions.openNoteEditor(matchedNote.id);
        }
        return;
    }

    // 2. Look for matching Weekly
    const matchedWeekly = (state.database || []).find(w => (w.title || '').trim().toLowerCase() === normalized);
    if (matchedWeekly) {
        if (actions.openArticle) {
            actions.openArticle(matchedWeekly);
        }
        return;
    }

    // 3. Neither found: prompt to create a new note
    const ok = await confirmDialog(`未找到与「${cleanTitle}」匹配的笔记或周记。\n是否立即创建以此为标题的新笔记？`, {
        confirmText: '立即创建',
        cancelText: '取消',
        danger: false
    });

    if (ok) {
        const newNote = {
            id: Date.now(),
            title: cleanTitle,
            content: '',
            date: getChineseDate(),
            annotations: []
        };
        stampLocalUpdate(newNote);
        state.notesDatabase.push(newNote);
        saveNotesDatabase();
        apiSyncNote(newNote, 'POST');
        if (actions.renderNotes) actions.renderNotes();
        if (actions.openNoteEditor) actions.openNoteEditor(newNote.id);
    }
}

/**
 * Renders the Backlinks section in Note or Weekly view.
 *
 * @param {HTMLElement|null} containerEl
 * @param {string} targetTitle
 * @param {number|string|null} currentId
 * @param {string} currentType
 */
export function renderBacklinksSection(containerEl, targetTitle, currentId, currentType) {
    if (!containerEl) return;
    if (!targetTitle) {
        containerEl.style.display = 'none';
        return;
    }

    const backlinks = findBacklinks(targetTitle, currentId, currentType);
    const countEl = containerEl.querySelector('[data-backlinks-count]') || containerEl.querySelector('#note-backlinks-count') || containerEl.querySelector('#weekly-backlinks-count');
    if (countEl) countEl.textContent = String(backlinks.length);

    const listEl = containerEl.querySelector('.backlinks-list');
    if (!listEl) return;

    if (backlinks.length === 0) {
        setHtml(listEl, '<div class="backlinks-empty">暂无其他内容引用此页面</div>');
        containerEl.style.display = 'block';
        return;
    }

    const typeIcons = {
        note: '📝',
        weekly: '🌸',
        feed: '⚡'
    };

    const typeLabels = {
        note: '笔记',
        weekly: '记忆',
        feed: '随手记'
    };

    setHtml(listEl, backlinks.map(b => `
        <div class="backlink-card" data-backlink-type="${b.type}" data-backlink-id="${b.id}" role="button" tabindex="0">
            <div class="backlink-meta">
                <span class="backlink-title-group">
                    <span class="backlink-type-badge">${typeIcons[b.type] || '📄'} ${typeLabels[b.type] || ''}</span>
                    <strong class="backlink-item-title">${escapeHtml(b.title)}</strong>
                </span>
                <span class="backlink-date">${escapeHtml(b.date)}</span>
            </div>
            <div class="backlink-snippet">${b.snippet}</div>
        </div>
    `).join(''));

    // Bind backlink jump click
    listEl.querySelectorAll('.backlink-card').forEach(card => {
        card.addEventListener('click', () => {
            const bType = card.dataset.backlinkType;
            const bId = card.dataset.backlinkId;
            if (bType === 'note') {
                actions.openNoteEditor?.(parseInt(bId) || bId);
            } else if (bType === 'weekly') {
                const item = (state.database || []).find(d => String(d.id) === String(bId));
                if (item) actions.openArticle?.(item);
            } else if (bType === 'feed') {
                actions.switchView?.('feeds');
            }
        });
    });

    containerEl.style.display = 'block';
}

/**
 * Renders the Outgoing Links (正向引用) pill strip.
 *
 * @param {HTMLElement|null} containerEl
 * @param {string} content
 */
export function renderOutgoingLinksStrip(containerEl, content) {
    if (!containerEl) return;
    const links = extractWikilinks(content);
    if (links.length === 0) {
        containerEl.style.display = 'none';
        return;
    }

    const pillContainer = containerEl.querySelector('.outgoing-links-container');
    if (!pillContainer) return;

    setHtml(pillContainer, links.map(title => `
        <span class="wikilink-pill" data-wikilink="${escapeHtml(title)}" role="button" tabindex="0">
            <span class="wikilink-icon">🔗</span>
            <span class="wikilink-label">${escapeHtml(title)}</span>
        </span>
    `).join(''));

    containerEl.style.display = 'flex';
}

/**
 * Sets up typing autocomplete for [[ inside a textarea.
 *
 * @param {HTMLTextAreaElement|null} textarea
 */
export function setupWikilinkAutocomplete(textarea) {
    if (!textarea) return;

    let popup = document.getElementById('wikilink-autocomplete-popup');
    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'wikilink-autocomplete-popup';
        popup.className = 'wikilink-autocomplete-popup';
        popup.style.display = 'none';
        popup.setAttribute('role', 'listbox');
        popup.setAttribute('aria-label', '双链联想建议');
        document.body.appendChild(popup);
    }

    let selectedIndex = 0;
    let currentCandidates = [];
    let currentMatchStart = -1;

    const hidePopup = () => {
        popup.style.display = 'none';
        currentCandidates = [];
        currentMatchStart = -1;
    };

    const insertCandidate = (title) => {
        if (!title || currentMatchStart < 0) return;
        const val = textarea.value;
        const cursorPos = textarea.selectionStart;
        const before = val.slice(0, currentMatchStart);
        const after = val.slice(cursorPos);
        const inserted = `[[${title}]] `;
        textarea.value = before + inserted + after;
        const newCursorPos = before.length + inserted.length;
        textarea.setSelectionRange(newCursorPos, newCursorPos);
        hidePopup();
        textarea.focus();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const renderCandidates = () => {
        if (currentCandidates.length === 0) {
            hidePopup();
            return;
        }

        setHtml(popup, currentCandidates.map((c, i) => `
            <div class="wikilink-suggest-item ${i === selectedIndex ? 'is-selected' : ''}" data-idx="${i}" role="option" aria-selected="${i === selectedIndex}">
                <span class="suggest-item-icon">${c.icon}</span>
                <span class="suggest-item-text">${escapeHtml(c.title)}</span>
                <span class="suggest-item-sub">${escapeHtml(c.sub)}</span>
            </div>
        `).join(''));

        popup.querySelectorAll('.wikilink-suggest-item').forEach(item => {
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const idx = parseInt(item.dataset.idx, 10);
                if (currentCandidates[idx]) {
                    insertCandidate(currentCandidates[idx].title);
                }
            });
        });
    };

    const checkAutocomplete = () => {
        const cursorPos = textarea.selectionStart;
        const textBefore = textarea.value.slice(0, cursorPos);
        const match = textBefore.match(/\[\[([^[\]\n\r]*)$/);

        if (!match) {
            hidePopup();
            return;
        }

        currentMatchStart = cursorPos - match[0].length;
        const query = match[1].trim().toLowerCase();

        // Collect candidates from notes and weeklies
        const candidates = [];
        const seenTitles = new Set();

        (state.notesDatabase || []).forEach(n => {
            const title = (n.title || '').trim();
            if (!title || seenTitles.has(title.toLowerCase())) return;
            if (!query || title.toLowerCase().includes(query)) {
                seenTitles.add(title.toLowerCase());
                candidates.push({ icon: '📝', title, sub: '笔记' });
            }
        });

        (state.database || []).forEach(w => {
            const title = (w.title || '').trim();
            if (!title || seenTitles.has(title.toLowerCase())) return;
            if (!query || title.toLowerCase().includes(query)) {
                seenTitles.add(title.toLowerCase());
                candidates.push({ icon: '🌸', title, sub: '记忆' });
            }
        });

        // Add prompt to create new note if query doesn't match an existing one
        if (query && !seenTitles.has(query)) {
            candidates.push({
                icon: '➕',
                title: match[1].trim(),
                sub: '新建并链接'
            });
        }

        currentCandidates = candidates.slice(0, 6);
        if (currentCandidates.length === 0) {
            hidePopup();
            return;
        }

        selectedIndex = 0;
        renderCandidates();

        // Position popup anchored relative to the textarea
        const rect = textarea.getBoundingClientRect();
        const popupHeight = Math.min(220, currentCandidates.length * 38 + 12);
        let top = rect.bottom + window.scrollY + 6;
        
        // If overflowing bottom of window, flip to above textarea
        if (rect.bottom + popupHeight > window.innerHeight && rect.top > popupHeight) {
            top = rect.top + window.scrollY - popupHeight - 6;
        }

        const left = Math.max(12, Math.min(rect.left + window.scrollX, window.innerWidth - 300));
        popup.style.top = `${top}px`;
        popup.style.left = `${left}px`;
        popup.style.display = 'block';
    };

    textarea.addEventListener('input', checkAutocomplete);
    textarea.addEventListener('click', checkAutocomplete);
    textarea.addEventListener('keyup', (e) => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            checkAutocomplete();
        }
    });

    textarea.addEventListener('keydown', (e) => {
        if (popup.style.display === 'none') return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = (selectedIndex + 1) % currentCandidates.length;
            renderCandidates();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = (selectedIndex - 1 + currentCandidates.length) % currentCandidates.length;
            renderCandidates();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            if (currentCandidates[selectedIndex]) {
                e.preventDefault();
                insertCandidate(currentCandidates[selectedIndex].title);
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            hidePopup();
        }
    });

    textarea.addEventListener('blur', () => {
        // Delay hide to allow click event on popup items
        setTimeout(hidePopup, 200);
    });
}

/**
 * Initializes the Wikilinks engine and binds global delegated click handlers.
 */
export function initWikilinks() {
    // Global delegated click for [data-wikilink]
    document.addEventListener('click', (e) => {
        const pill = e.target.closest('[data-wikilink]');
        if (!pill) return;
        e.preventDefault();
        e.stopPropagation();
        const target = pill.getAttribute('data-wikilink');
        if (target) {
            navigateToWikilink(target);
        }
    });

    // Bind autocomplete to textareas
    setupWikilinkAutocomplete(document.getElementById('edit-note-content'));
    setupWikilinkAutocomplete(document.getElementById('edit-content'));
    setupWikilinkAutocomplete(document.getElementById('feed-input-text'));

    actions.navigateToWikilink = navigateToWikilink;
    actions.parseWikilinksToHtml = parseWikilinksToHtml;
    actions.renderBacklinksSection = renderBacklinksSection;
    actions.renderOutgoingLinksStrip = renderOutgoingLinksStrip;
}
