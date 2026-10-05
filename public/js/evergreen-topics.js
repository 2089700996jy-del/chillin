/**
 * Chillin Evergreen Topic Shelves (常青专栏与主题归集).
 * Aggregates user-defined hashtags, wikilinks, and topics across Feeds, Notes, and Weeklies.
 * Strictly adheres to Konsta iOS HIG: calm editorial typography, accurate bilingual word count,
 * zero AI chatbot/dashboard aesthetic.
 */
import { escapeHtml, showToast } from './utils.js';
import { state } from './state.js';
import { actions } from './actions.js';
import { setHtml } from './trusted-types.js';

const IGNORED_TOPIC_NAMES = new Set([
    '随手记', '备忘录', '周记', 'default', '未分类', '全部', 'all',
    '心绪', '平静', '充能', '疲惫', '续命', '灵感_sys',
    '时光胶囊', '回响', '轻启发', 'undefined', 'null'
]);

/**
 * 校验话题是否为有效的人文/知识主题（过滤系统占位符、单一 Emoji 表情及空标签）
 * @param {string} rawName 
 * @returns {boolean}
 */
export function isValidTopic(rawName) {
    if (!rawName) return false;
    const clean = String(rawName).trim().replace(/^#/, '');
    if (clean.length < 2) return false;
    // 排除纯 Emoji 表情或符号（必须包含至少一个中文字符或英文字符/数字）
    if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(clean)) return false;
    if (IGNORED_TOPIC_NAMES.has(clean.toLowerCase())) return false;
    return true;
}

/**
 * 精准中英文混合字数统计（符合 Word / Pages / Notion 标准）
 * - 中文字符、日韩文字按字统计（1 字符 = 1 字）
 * - 英文单词、数字按词统计（1 连续词 = 1 字）
 * - 剥离 HTML 标签、Markdown 标记、超链接与空格
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
    if (!text) return 0;
    const clean = String(text)
        .replace(/<[^>]+>/g, ' ')
        .replace(/https?:\/\/[^\s]+/g, ' ')
        .replace(/!\[.*?\]\(.*?\)/g, ' ')
        .replace(/\[.*?\]\(.*?\)/g, ' ')
        .trim();
    if (!clean) return 0;
    const cjk = clean.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || [];
    const nonCjk = clean.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ');
    const enWords = nonCjk.match(/[a-zA-Z0-9_\-]+/g) || [];
    return cjk.length + enWords.length;
}

/**
 * 统计单条花园实体的真实全文字数
 */
export function getItemWordCount(item, type) {
    if (!item) return 0;
    let total = 0;
    if (type === 'feed') {
        total += countWords(item.content);
        if (item.summary) {
            try {
                const s = typeof item.summary === 'object' ? item.summary : JSON.parse(item.summary);
                if (s && s.title) total += countWords(s.title);
                if (s && s.description) total += countWords(s.description);
            } catch {
                if (typeof item.summary === 'string' && !item.summary.startsWith('{')) {
                    total += countWords(item.summary);
                }
            }
        }
    } else if (type === 'note') {
        total += countWords(item.title) + countWords(item.content);
        if (Array.isArray(item.annotations)) {
            item.annotations.forEach(a => { if (a && a.content) total += countWords(a.content); });
        }
    } else if (type === 'weekly') {
        total += countWords(item.title) + countWords(item.summary) + countWords(item.content);
        if (item.weeklyData && typeof item.weeklyData === 'object') {
            const wd = item.weeklyData;
            if (wd.podcast) total += countWords(wd.podcast);
            if (wd.work?.desc) total += countWords(wd.work.desc);
            if (wd.music?.lyric) total += countWords(wd.music.lyric);
            if (wd.life?.caption) total += countWords(wd.life.caption);
            if (Array.isArray(wd.media)) {
                wd.media.forEach(m => { if (m?.desc) total += countWords(m.desc); });
            }
        }
    }
    return total;
}

export function formatWordsText(words) {
    if (words >= 10000) return `${(words / 10000).toFixed(1)}万字`;
    if (words >= 1000) return `${(words / 1000).toFixed(1)}k字`;
    return `${words}字`;
}

/**
 * 聚合全库有效主题，计算真实篇数、精准字数与跨度
 * @returns {Array<Object>} 排序后的专栏主题列表
 */
export function aggregateTopics() {
    const topicMap = new Map();

    const getOrCreate = (name, type = 'tag') => {
        if (!isValidTopic(name)) return null;
        const cleanName = String(name).trim().replace(/^#/, '');
        const key = cleanName.toLowerCase();
        if (!topicMap.has(key)) {
            topicMap.set(key, {
                key,
                name: cleanName,
                type,
                feeds: [],
                notes: [],
                weeklies: [],
                totalCount: 0,
                wordCount: 0,
                timestamps: [],
                latestSnippet: '',
                latestDate: ''
            });
        }
        return topicMap.get(key);
    };

    // 1. 随手记 (Feeds)
    (state.feedsDatabase || []).forEach(feed => {
        if (!feed || feed.is_deleted) return;
        const matchedTopicKeys = new Set();
        if (Array.isArray(feed.tags)) {
            feed.tags.forEach(t => {
                const item = getOrCreate(t, 'tag');
                if (item) matchedTopicKeys.add(item.key);
            });
        }
        const content = String(feed.content || '');
        const hashMatches = content.match(/#([\w\u4e00-\u9fa5\-_]+)/g);
        if (hashMatches) {
            hashMatches.forEach(tagStr => {
                const item = getOrCreate(tagStr.slice(1), 'tag');
                if (item) matchedTopicKeys.add(item.key);
            });
        }

        if (matchedTopicKeys.size === 0) return;
        const feedWords = getItemWordCount(feed, 'feed');
        const ts = feed.created_at ? new Date(feed.created_at.replace(' ', 'T')).getTime() : Date.now();

        matchedTopicKeys.forEach(k => {
            const entry = topicMap.get(k);
            if (entry && !entry.feeds.some(f => f.id === feed.id)) {
                entry.feeds.push(feed);
                entry.wordCount += feedWords;
                if (!isNaN(ts)) entry.timestamps.push(ts);
                if (!entry.latestSnippet && content) {
                    entry.latestSnippet = content.replace(/<[^>]+>/g, '').slice(0, 60);
                    entry.latestDate = (feed.created_at || '').slice(0, 10);
                }
            }
        });
    });

    // 2. 备忘录 / 笔记 (Notes)
    (state.notesDatabase || []).forEach(note => {
        if (!note || note.is_deleted) return;
        const matchedTopicKeys = new Set();
        const content = String(note.content || '');
        const title = String(note.title || '');

        const hashMatches = (content + ' ' + title).match(/#([\w\u4e00-\u9fa5\-_]+)/g);
        if (hashMatches) {
            hashMatches.forEach(tagStr => {
                const item = getOrCreate(tagStr.slice(1), 'tag');
                if (item) matchedTopicKeys.add(item.key);
            });
        }

        const wikiMatches = (content + ' ' + title).match(/\[\[([^[\]|\n\r]+)(?:\|[^[\]|\n\r]+)?\]\]/g);
        if (wikiMatches) {
            wikiMatches.forEach(w => {
                const clean = w.replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0].trim();
                const item = getOrCreate(clean, 'wikilink');
                if (item) matchedTopicKeys.add(item.key);
            });
        }

        if (matchedTopicKeys.size === 0) return;
        const noteWords = getItemWordCount(note, 'note');
        const ts = note.date ? new Date(note.date.replace(' ', 'T')).getTime() : Date.now();

        matchedTopicKeys.forEach(k => {
            const entry = topicMap.get(k);
            if (entry && !entry.notes.some(n => n.id === note.id)) {
                entry.notes.push(note);
                entry.wordCount += noteWords;
                if (!isNaN(ts)) entry.timestamps.push(ts);
                if (!entry.latestSnippet && (title || content)) {
                    entry.latestSnippet = (title || content).replace(/<[^>]+>/g, '').slice(0, 60);
                    entry.latestDate = (note.date || '').slice(0, 10);
                }
            }
        });
    });

    // 3. 周记 (Weeklies)
    (state.database || []).forEach(weekly => {
        if (!weekly || weekly.is_deleted) return;
        const matchedTopicKeys = new Set();
        if (Array.isArray(weekly.tags)) {
            weekly.tags.forEach(t => {
                const item = getOrCreate(t, 'tag');
                if (item) matchedTopicKeys.add(item.key);
            });
        }

        if (matchedTopicKeys.size === 0) return;
        const weeklyWords = getItemWordCount(weekly, 'weekly');
        const ts = weekly.date ? new Date(weekly.date.replace(' ', 'T')).getTime() : Date.now();

        matchedTopicKeys.forEach(k => {
            const entry = topicMap.get(k);
            if (entry && !entry.weeklies.some(w => w.id === weekly.id)) {
                entry.weeklies.push(weekly);
                entry.wordCount += weeklyWords;
                if (!isNaN(ts)) entry.timestamps.push(ts);
                if (!entry.latestSnippet) {
                    entry.latestSnippet = (weekly.title || weekly.summary || '').replace(/<[^>]+>/g, '').slice(0, 60);
                    entry.latestDate = (weekly.date || '').slice(0, 10);
                }
            }
        });
    });

    // 汇总与排序
    const topics = Array.from(topicMap.values()).map(t => {
        t.totalCount = t.feeds.length + t.notes.length + t.weeklies.length;
        if (t.timestamps.length > 0) {
            const minTs = Math.min(...t.timestamps);
            const maxTs = Math.max(...t.timestamps);
            t.timespanDays = Math.max(1, Math.round((maxTs - minTs) / (86400 * 1000)));
        } else {
            t.timespanDays = 1;
        }
        return t;
    });

    // 按篇数降序排列，篇数相同按字数降序
    topics.sort((a, b) => {
        if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
        return b.wordCount - a.wordCount;
    });

    return topics;
}

let activeDetailTopic = null;

/**
 * 渲染随手记顶部的专栏货架（Konsta Inset Grouped 标准）
 */
export function renderTopicShelves() {
    const scrollContainer = document.getElementById('evergreen-shelves-scroll');
    const summaryBadge = document.getElementById('evergreen-shelves-summary');
    if (!scrollContainer) return;

    const topics = aggregateTopics();
    const totalEntries = topics.reduce((sum, t) => sum + t.totalCount, 0);

    if (summaryBadge) {
        if (topics.length === 0) {
            summaryBadge.textContent = '暂无归集';
        } else {
            summaryBadge.textContent = `${topics.length} 个主题 · ${totalEntries} 条沉淀`;
        }
    }

    if (topics.length === 0) {
        setHtml(scrollContainer, `
            <div class="k-shelf-empty">
                <span class="k-shelf-empty-icon">📁</span>
                <span class="k-shelf-empty-text">在随手记或笔记中键入 <b>#标签</b> 或 <b>[[双链]]</b>，此处将自动沉淀为思考专栏</span>
            </div>
        `);
        return;
    }

    setHtml(scrollContainer, topics.map(t => {
        const wordsFormatted = formatWordsText(t.wordCount);
        const prefix = t.type === 'wikilink' ? '🔗 ' : '# ';
        const isDeep = t.totalCount >= 8 || t.wordCount >= 2000;
        const tagBadge = isDeep ? '<span class="k-topic-tier-pill tier-deep">深度</span>' : '<span class="k-topic-tier-pill">专栏</span>';

        return `
            <div class="k-shelf-card" data-topic-key="${escapeHtml(t.key)}" role="button" tabindex="0" title="${escapeHtml(t.name)} · 轻按查看专栏内容">
                <div class="k-shelf-card-top">
                    ${tagBadge}
                    <span class="k-shelf-count-badge">${t.totalCount} 篇</span>
                </div>
                <div class="k-shelf-card-title">${prefix}${escapeHtml(t.name)}</div>
                <div class="k-shelf-card-snippet">“${escapeHtml(t.latestSnippet || '暂无文字摘要')}”</div>
                <div class="k-shelf-card-footer">
                    <span class="k-shelf-stat">共 ${wordsFormatted}</span>
                    <span class="k-shelf-dot-sep">·</span>
                    <span class="k-shelf-span">${t.timespanDays}天跨度</span>
                </div>
            </div>
        `;
    }).join(''));
}

/**
 * 打开所有常青专栏全览 Sheet (Apple HIG Directory Sheet)
 * @param {string} [filterText=''] 过滤关键词
 */
export function openTopicsDirectorySheet(filterText = '') {
    const modal = document.getElementById('topics-directory-modal');
    if (!modal) return;

    const topics = aggregateTopics();
    const totalEntries = topics.reduce((sum, t) => sum + t.totalCount, 0);

    const subtitleEl = document.getElementById('topics-directory-subtitle');
    const listEl = document.getElementById('topics-directory-list');
    const searchInput = document.getElementById('topics-directory-search');

    if (searchInput && filterText === '' && !modal.classList.contains('show')) {
        searchInput.value = '';
    }

    const cleanFilter = String(filterText || '').trim().toLowerCase();
    const filteredTopics = cleanFilter
        ? topics.filter(t => t.name.toLowerCase().includes(cleanFilter) || (t.latestSnippet && t.latestSnippet.toLowerCase().includes(cleanFilter)))
        : topics;

    if (subtitleEl) {
        if (cleanFilter) {
            subtitleEl.textContent = `找到 ${filteredTopics.length} 个专栏 (共 ${topics.length} 个) · 共 ${totalEntries} 条沉淀`;
        } else {
            subtitleEl.textContent = `${topics.length} 个专栏 · 共 ${totalEntries} 条沉淀`;
        }
    }

    if (listEl) {
        if (filteredTopics.length === 0) {
            setHtml(listEl, `
                <div class="k-shelf-empty" style="padding: 24px 16px; justify-content: center;">
                    <span class="k-shelf-empty-text">未找到与 “${escapeHtml(filterText)}” 相关的专栏</span>
                </div>
            `);
        } else {
            setHtml(listEl, filteredTopics.map(t => {
                const prefix = t.type === 'wikilink' ? '🔗 ' : '# ';
                const isDeep = t.totalCount >= 8 || t.wordCount >= 2000;
                const tagBadge = isDeep ? '<span class="k-topic-tier-pill tier-deep">深度</span>' : '';
                return `
                    <div class="k-directory-row" data-topic-key="${escapeHtml(t.key)}" role="button" tabindex="0">
                        <div class="k-directory-main">
                            <div class="k-directory-header">
                                <span class="k-directory-title">${prefix}${escapeHtml(t.name)}</span>
                                ${tagBadge}
                            </div>
                            <div class="k-directory-meta">
                                <span>${t.totalCount} 篇</span>
                                <span class="k-shelf-dot-sep">·</span>
                                <span>共 ${formatWordsText(t.wordCount)}</span>
                                <span class="k-shelf-dot-sep">·</span>
                                <span>跨越 ${t.timespanDays} 天</span>
                            </div>
                            ${t.latestSnippet ? `<div class="k-directory-snippet">“${escapeHtml(t.latestSnippet)}”</div>` : ''}
                        </div>
                        <div class="k-directory-arrow">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="9 18 15 12 9 6"></polyline>
                            </svg>
                        </div>
                    </div>
                `;
            }).join(''));
        }
    }

    modal.classList.add('show');
}

/**
 * 打开专栏详情 Sheet (Apple HIG Inset Grouped Sheet)
 * @param {string} topicKey 主题标识
 * @param {Object} [options] 导航选项
 * @param {boolean} [options.fromDirectory] 是否从所有专栏目录打开
 */
export function openTopicDetailSheet(topicKey, options = {}) {
    const modal = document.getElementById('topic-detail-modal');
    if (!modal) return;

    const topics = aggregateTopics();
    const topic = topics.find(t => t.key === topicKey.toLowerCase());
    if (!topic) return;

    activeDetailTopic = topic;

    const backBtn = document.getElementById('btn-topic-back-to-directory');
    if (backBtn) {
        backBtn.style.display = options.fromDirectory ? 'inline-flex' : 'none';
    }

    const titleEl = document.getElementById('topic-detail-title');
    const subtitleEl = document.getElementById('topic-detail-subtitle');
    const itemsList = document.getElementById('topic-detail-items-list');

    if (titleEl) {
        titleEl.textContent = topic.type === 'wikilink' ? `[[${topic.name}]]` : `#${topic.name}`;
    }
    if (subtitleEl) {
        subtitleEl.textContent = `${topic.totalCount} 条记录 · 共 ${formatWordsText(topic.wordCount)} · 跨越 ${topic.timespanDays} 天`;
    }

    if (itemsList) {
        const allItems = [
            ...topic.feeds.map(f => ({
                id: f.id,
                kind: '随手记',
                title: f.content.replace(/<[^>]+>/g, '').slice(0, 50) + (f.content.length > 50 ? '…' : ''),
                words: getItemWordCount(f, 'feed'),
                date: (f.created_at || '').slice(0, 10),
                raw: f
            })),
            ...topic.notes.map(n => ({
                id: n.id,
                kind: '备忘录',
                title: n.title || '无标题备忘录',
                words: getItemWordCount(n, 'note'),
                date: (n.date || '').slice(0, 10),
                raw: n
            })),
            ...topic.weeklies.map(w => ({
                id: w.id,
                kind: '周记',
                title: w.title || '无标题周记',
                words: getItemWordCount(w, 'weekly'),
                date: (w.date || '').slice(0, 10),
                raw: w
            }))
        ];

        allItems.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        setHtml(itemsList, allItems.map(item => `
            <div class="k-topic-item-row" data-kind="${item.kind}" data-id="${escapeHtml(String(item.id))}">
                <div class="k-topic-item-meta">
                    <span class="k-topic-item-kind">${item.kind}</span>
                    <span class="k-topic-item-info">${item.words} 字 · ${escapeHtml(item.date)}</span>
                </div>
                <div class="k-topic-item-title">${escapeHtml(item.title)}</div>
            </div>
        `).join(''));
    }

    modal.classList.add('show');
}

/**
 * 初始化常青主题交互
 */
export function initEvergreenTopics() {
    actions.renderTopicShelves = renderTopicShelves;
    actions.openTopicDetailSheet = openTopicDetailSheet;
    actions.openTopicsDirectorySheet = openTopicsDirectorySheet;

    renderTopicShelves();

    // 1. 货架卡片点击代理
    const scrollContainer = document.getElementById('evergreen-shelves-scroll');
    if (scrollContainer) {
        scrollContainer.addEventListener('click', (e) => {
            const card = e.target.closest('.k-shelf-card');
            if (card && card.dataset.topicKey) {
                openTopicDetailSheet(card.dataset.topicKey, { fromDirectory: false });
            }
        });
    }

    // 2. 货架顶部“全部”按钮 -> 打开专栏目录全览 Sheet
    document.getElementById('btn-view-all-topics')?.addEventListener('click', () => {
        const topics = aggregateTopics();
        if (topics.length > 0) {
            openTopicsDirectorySheet();
        } else {
            showToast('当前暂无主题，在随手记里写个 #标签 吧', 'info');
        }
    });

    // 3. 专栏目录实时搜索过滤
    const directorySearchInput = document.getElementById('topics-directory-search');
    if (directorySearchInput) {
        directorySearchInput.addEventListener('input', (e) => {
            openTopicsDirectorySheet(e.target.value);
        });
    }

    // 4. 专栏目录点击条目 -> 进入对应专栏详情 Sheet
    const directoryList = document.getElementById('topics-directory-list');
    if (directoryList) {
        directoryList.addEventListener('click', (e) => {
            const row = e.target.closest('.k-directory-row');
            if (row && row.dataset.topicKey) {
                const dirModal = document.getElementById('topics-directory-modal');
                if (dirModal) dirModal.classList.remove('show');
                openTopicDetailSheet(row.dataset.topicKey, { fromDirectory: true });
            }
        });
    }

    // 5. 详情页层级返回按钮 -> 回到专栏全览 Sheet
    document.getElementById('btn-topic-back-to-directory')?.addEventListener('click', () => {
        const detailModal = document.getElementById('topic-detail-modal');
        if (detailModal) detailModal.classList.remove('show');
        const searchVal = document.getElementById('topics-directory-search')?.value || '';
        openTopicsDirectorySheet(searchVal);
    });

    // 6. 详情 Sheet 中的条目点击跳转
    const itemsList = document.getElementById('topic-detail-items-list');
    if (itemsList) {
        itemsList.addEventListener('click', (e) => {
            const row = e.target.closest('.k-topic-item-row');
            if (!row) return;
            const kind = row.dataset.kind;
            const id = row.dataset.id;
            const modal = document.getElementById('topic-detail-modal');
            if (modal) modal.classList.remove('show');

            if (kind === '随手记') {
                if (typeof actions.switchView === 'function') actions.switchView('feeds');
                setTimeout(() => {
                    const targetEl = document.querySelector(`[data-feed-id="${id}"]`);
                    targetEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    targetEl?.classList.add('feed-highlight-pulse');
                    setTimeout(() => targetEl?.classList.remove('feed-highlight-pulse'), 1800);
                }, 150);
            } else if (kind === '备忘录') {
                if (typeof actions.openNoteEditor === 'function') {
                    const note = (state.notesDatabase || []).find(n => String(n.id) === id);
                    if (note) actions.openNoteEditor(note);
                }
            } else if (kind === '周记') {
                if (typeof actions.openArticle === 'function') {
                    const weekly = (state.database || []).find(w => String(w.id) === id);
                    if (weekly) actions.openArticle(weekly);
                }
            }
        });
    }

    // 7. 追加思绪按钮
    document.getElementById('btn-topic-append-thought')?.addEventListener('click', () => {
        if (!activeDetailTopic) return;
        const topicName = activeDetailTopic.name;
        const modal = document.getElementById('topic-detail-modal');
        if (modal) modal.classList.remove('show');

        if (typeof actions.switchView === 'function') actions.switchView('feeds');
        setTimeout(() => {
            const input = document.getElementById('feed-input-text');
            if (input) {
                input.value = `#${topicName} ` + input.value.replace(new RegExp(`#${topicName}\\s*`, 'g'), '');
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
            }
            showToast(`已为你填入 #${topicName}，开始记录吧`, 'ok');
        }, 150);
    });
}
