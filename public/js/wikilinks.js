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

function unescapeHtmlEntities(str) {
    if (!str) return '';
    return String(str)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&#39;/g, "'");
}

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
        const rawTarget = unescapeHtmlEntities((target || '').trim());
        const rawLabel = unescapeHtmlEntities((alias || target || '').trim());
        if (!rawTarget) return match;
        const cleanTarget = escapeHtml(rawTarget);
        const cleanLabel = escapeHtml(rawLabel);
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
    const plainText = String(content).replace(/<[^>]+>/g, ' ');
    const normalizedTarget = targetTitle.trim().toLowerCase();
    const regex = new RegExp(WIKILINK_REGEX.source, 'gi');
    let match;
    let snippetFound = '';

    while ((match = regex.exec(plainText)) !== null) {
        const t = (match[1] || '').trim().toLowerCase();
        if (t === normalizedTarget) {
            const start = Math.max(0, match.index - radius);
            const end = Math.min(plainText.length, match.index + match[0].length + radius);
            const prefix = start > 0 ? '…' : '';
            const suffix = end < plainText.length ? '…' : '';
            const rawSnippet = prefix + plainText.slice(start, end).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ') + suffix;
            
            // Safe escape and highlight target without $ special replacement issue
            const displayLabel = (match[2] || match[1] || '').trim();
            const escaped = escapeHtml(rawSnippet);
            const escapedTarget = escapeHtml(match[0]);
            const highlighted = `<mark>${escapeHtml(displayLabel || targetTitle)}</mark>`;
            snippetFound = escaped.replace(escapedTarget, () => highlighted);
            break;
        }
    }

    if (!snippetFound) {
        const clean = plainText.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
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
 * Renders an interactive local relationship topology graph using Canvas 2D.
 * Connects current item to incoming backlinks and outgoing wikilinks.
 */
export function renderLocalGraph(canvas, centerTitle, centerType, backlinks = [], outgoingTitles = []) {
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 320, height: 180 };
    const width = rect.width || canvas.parentElement?.clientWidth || 320;
    const height = 180;
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    if (canvas.style) {
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
    }
    ctx.scale(dpr, dpr);

    const isDark = typeof document !== 'undefined' && document.body && (
        document.body.classList.contains('dark') || document.body.classList.contains('dark-reader-body')
    );
    const cx = width / 2;
    const cy = height / 2;

    const nodeMap = new Map();
    for (const b of backlinks) {
        const key = b.type + ':' + b.id;
        if (!nodeMap.has(key)) {
            nodeMap.set(key, {
                id: b.id,
                title: b.title,
                type: b.type,
                dir: 'in',
                color: b.type === 'weekly' ? '#34C759' : (b.type === 'feed' ? '#FF9500' : '#007AFF')
            });
        }
    }
    for (const title of outgoingTitles) {
        const clean = String(title || '').trim();
        if (!clean || clean.toLowerCase() === centerTitle.toLowerCase()) continue;
        const key = 'out:' + clean.toLowerCase();
        if (!nodeMap.has(key)) {
            nodeMap.set(key, {
                id: null,
                title: clean,
                type: 'wikilink',
                dir: 'out',
                color: '#AF52DE'
            });
        }
    }

    const connectedNodes = Array.from(nodeMap.values());
    const box = canvas.closest ? canvas.closest('.wikilinks-graph-box') : null;
    if (connectedNodes.length === 0) {
        if (box) box.style.display = 'none';
        else canvas.style.display = 'none';
        return;
    }
    if (box) box.style.display = 'flex';
    canvas.style.display = 'block';

    const count = connectedNodes.length;
    const rx = Math.min(width * 0.38, 140);
    const ry = 58;

    connectedNodes.forEach((node, i) => {
        const angle = (2 * Math.PI / count) * i - Math.PI / 2;
        node.x = cx + rx * Math.cos(angle);
        node.y = cy + ry * Math.sin(angle);
        node.r = 11;
    });

    const centerNode = {
        x: cx,
        y: cy,
        r: 15,
        title: centerTitle,
        type: centerType,
        isCenter: true,
        color: '#0066CC'
    };

    let hoveredNode = null;

    function draw() {
        ctx.clearRect(0, 0, width, height);

        // Draw edges
        ctx.lineWidth = 1.2;
        for (const node of connectedNodes) {
            ctx.beginPath();
            ctx.moveTo(centerNode.x, centerNode.y);
            ctx.lineTo(node.x, node.y);
            if (hoveredNode && (hoveredNode === node || hoveredNode === centerNode)) {
                ctx.strokeStyle = isDark ? 'rgba(74, 158, 255, 0.65)' : 'rgba(0, 102, 204, 0.45)';
                ctx.lineWidth = 1.8;
            } else {
                ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.08)';
                ctx.lineWidth = 1.2;
            }
            ctx.stroke();
        }

        // Draw connected nodes
        for (const node of connectedNodes) {
            const isHover = hoveredNode === node;
            ctx.beginPath();
            ctx.arc(node.x, node.y, isHover ? node.r + 2 : node.r, 0, Math.PI * 2);
            ctx.fillStyle = node.color;
            ctx.fill();
            ctx.lineWidth = isHover ? 2.5 : 1.5;
            ctx.strokeStyle = isDark ? '#1C222C' : '#FFFFFF';
            ctx.stroke();

            // Label
            ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
            ctx.fillStyle = isDark ? '#A5AFBE' : '#677181';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const labelY = node.y + (node.y > cy ? 16 : -16);
            const shortText = node.title.length > 7 ? node.title.slice(0, 6) + '…' : node.title;
            ctx.fillText(shortText, node.x, labelY);
        }

        // Draw center node
        const isCenterHover = hoveredNode === centerNode;
        ctx.beginPath();
        ctx.arc(centerNode.x, centerNode.y, isCenterHover ? centerNode.r + 2 : centerNode.r, 0, Math.PI * 2);
        ctx.fillStyle = centerNode.color;
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = isDark ? '#1C222C' : '#FFFFFF';
        ctx.stroke();

        ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillStyle = isDark ? '#EEF1F6' : '#1B1F28';
        ctx.textAlign = 'center';
        ctx.fillText(centerNode.title.length > 8 ? centerNode.title.slice(0, 7) + '…' : centerNode.title, cx, cy + 22);

        // Tooltip if hover
        if (hoveredNode && !hoveredNode.isCenter) {
            const tipText = (hoveredNode.dir === 'in' ? '⬅ 被引用: ' : '➡ 正向链接: ') + hoveredNode.title;
            ctx.font = '11px -apple-system, sans-serif';
            const tw = ctx.measureText(tipText).width;
            const tx = Math.min(Math.max(hoveredNode.x, tw / 2 + 8), width - tw / 2 - 8);
            const ty = hoveredNode.y > cy ? hoveredNode.y - 20 : hoveredNode.y + 24;

            ctx.fillStyle = isDark ? 'rgba(20, 25, 34, 0.92)' : 'rgba(255, 255, 255, 0.95)';
            ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
                ctx.roundRect(tx - tw / 2 - 6, ty - 9, tw + 12, 18, 6);
            } else {
                ctx.rect(tx - tw / 2 - 6, ty - 9, tw + 12, 18);
            }
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = isDark ? '#EEF1F6' : '#1B1F28';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(tipText, tx, ty);
        }
    }

    draw();

    function getNodeAt(x, y) {
        if (Math.hypot(x - centerNode.x, y - centerNode.y) <= centerNode.r + 4) return centerNode;
        for (const node of connectedNodes) {
            if (Math.hypot(x - node.x, y - node.y) <= node.r + 4) return node;
        }
        return null;
    }

    if (canvas._cleanGraphListeners) canvas._cleanGraphListeners();

    const onMouseMove = (e) => {
        const cRect = canvas.getBoundingClientRect();
        const mx = e.clientX - cRect.left;
        const my = e.clientY - cRect.top;
        const hit = getNodeAt(mx, my);
        if (hit !== hoveredNode) {
            hoveredNode = hit;
            canvas.style.cursor = hit ? (hit.isCenter ? 'default' : 'pointer') : 'default';
            draw();
        }
    };

    const onMouseLeave = () => {
        if (hoveredNode) {
            hoveredNode = null;
            draw();
        }
    };

    const onClick = (e) => {
        const cRect = canvas.getBoundingClientRect();
        const mx = e.clientX - cRect.left;
        const my = e.clientY - cRect.top;
        const hit = getNodeAt(mx, my);
        if (!hit || hit.isCenter) return;

        if (hit.type === 'note' && hit.id) {
            actions.openNoteEditor?.(parseInt(hit.id, 10) || hit.id);
        } else if (hit.type === 'weekly' && hit.id) {
            const item = (state.database || []).find(d => String(d.id) === String(hit.id));
            if (item) actions.openArticle?.(item);
        } else if (hit.type === 'feed') {
            actions.switchView?.('feeds');
        } else if (hit.type === 'wikilink' || hit.dir === 'out') {
            navigateToWikilink(hit.title);
        }
    };

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('click', onClick);

    canvas._cleanGraphListeners = () => {
        canvas.removeEventListener('mousemove', onMouseMove);
        canvas.removeEventListener('mouseleave', onMouseLeave);
        canvas.removeEventListener('click', onClick);
    };
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
    let outgoingTitles = [];
    if (currentType === 'note') {
        const currentNote = (state.notesDatabase || []).find(n => String(n.id) === String(currentId));
        if (currentNote) outgoingTitles = extractWikilinks(currentNote.content);
    } else if (currentType === 'weekly') {
        const currentWeekly = (state.database || []).find(w => String(w.id) === String(currentId));
        if (currentWeekly) outgoingTitles = extractWikilinks((currentWeekly.content || '') + ' ' + (currentWeekly.summary || ''));
    }

    const countEl = containerEl.querySelector('[data-backlinks-count]') || containerEl.querySelector('#note-backlinks-count') || containerEl.querySelector('#weekly-backlinks-count');
    if (countEl) countEl.textContent = String(backlinks.length);

    const canvas = containerEl.querySelector('.wikilinks-local-graph');
    if (canvas) {
        renderLocalGraph(canvas, targetTitle, currentType, backlinks, outgoingTitles);
    }

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

    // Bind backlink jump click and keyboard activation
    const handleJump = (card) => {
        const bType = card.dataset.backlinkType;
        const bId = card.dataset.backlinkId;
        if (bType === 'note') {
            actions.openNoteEditor?.(parseInt(bId, 10) || bId);
        } else if (bType === 'weekly') {
            const item = (state.database || []).find(d => String(d.id) === String(bId));
            if (item) actions.openArticle?.(item);
        } else if (bType === 'feed') {
            actions.switchView?.('feeds');
        }
    };

    listEl.querySelectorAll('.backlink-card').forEach(card => {
        card.addEventListener('click', () => handleJump(card));
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleJump(card);
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
            const onSelect = (e) => {
                e.preventDefault();
                const idx = parseInt(item.dataset.idx, 10);
                if (currentCandidates[idx]) {
                    insertCandidate(currentCandidates[idx].title);
                }
            };
            item.addEventListener('mousedown', onSelect);
            item.addEventListener('pointerdown', onSelect);
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
        if (e.isComposing || e.keyCode === 229) return;

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

    // Keyboard activation (Enter key) on focused [data-wikilink]
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const pill = e.target.closest('[data-wikilink]');
            if (pill) {
                e.preventDefault();
                const target = pill.getAttribute('data-wikilink');
                if (target) {
                    navigateToWikilink(target);
                }
            }
        }
    });

    // Bind autocomplete to textareas
    setupWikilinkAutocomplete(document.getElementById('edit-note-content'));
    setupWikilinkAutocomplete(document.getElementById('edit-content'));
    setupWikilinkAutocomplete(document.getElementById('feed-input-text'));

    actions.navigateToWikilink = navigateToWikilink;
    actions.parseWikilinksToHtml = parseWikilinksToHtml;
    actions.renderBacklinksSection = renderBacklinksSection;
    actions.renderLocalGraph = renderLocalGraph;
    actions.renderOutgoingLinksStrip = renderOutgoingLinksStrip;
}
