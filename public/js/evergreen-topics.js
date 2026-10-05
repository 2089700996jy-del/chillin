/**
 * Chillin Evergreen Topic Shelves (常青主题资产台).
 * Aggregates hashtags, wikilinks, and categories across Feeds, Notes, and Weeklies
 * into curated topic assets with tangible growth stages:
 * - 🌱 萌芽 (Budding Spark, 1-4 entries)
 * - 🌿 抽枝 (Branching Topic, 5-9 entries)
 * - 🌳 常青 (Evergreen Asset, 10+ entries)
 *
 * Implements Konsta iOS Inset Grouped design, zero-build native ESM.
 */
import { escapeHtml, showToast } from './utils.js';
import { state } from './state.js';
import { actions } from './actions.js';
import { setHtml } from './trusted-types.js';

export const STAGES = {
    EVERGREEN: { id: 'evergreen', label: '常青', icon: '🌳', minCount: 10, badgeClass: 'stage-evergreen' },
    BRANCHING: { id: 'branching', label: '抽枝', icon: '🌿', minCount: 5, badgeClass: 'stage-branching' },
    BUDDING: { id: 'budding', label: '萌芽', icon: '🌱', minCount: 1, badgeClass: 'stage-budding' }
};

export function getStage(count) {
    if (count >= STAGES.EVERGREEN.minCount) return STAGES.EVERGREEN;
    if (count >= STAGES.BRANCHING.minCount) return STAGES.BRANCHING;
    return STAGES.BUDDING;
}

/**
 * 聚合全库思考碎片，生成常青主题资产
 * @returns {Array<Object>} 排序后的常青主题列表
 */
export function aggregateTopics() {
    const topicMap = new Map();

    const getOrCreate = (name, type = 'tag') => {
        const cleanName = String(name || '').trim().replace(/^#/, '');
        if (!cleanName || cleanName.length > 30) return null;
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
                characterCount: 0,
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

        matchedTopicKeys.forEach(k => {
            const entry = topicMap.get(k);
            if (entry && !entry.feeds.some(f => f.id === feed.id)) {
                entry.feeds.push(feed);
                entry.characterCount += content.length;
                const ts = feed.created_at ? new Date(feed.created_at.replace(' ', 'T')).getTime() : Date.now();
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

        matchedTopicKeys.forEach(k => {
            const entry = topicMap.get(k);
            if (entry && !entry.notes.some(n => n.id === note.id)) {
                entry.notes.push(note);
                entry.characterCount += content.length + title.length;
                const ts = note.date ? new Date(note.date.replace(' ', 'T')).getTime() : Date.now();
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
        if (weekly.category) {
            const item = getOrCreate(weekly.category, 'topic');
            if (item) matchedTopicKeys.add(item.key);
        }

        matchedTopicKeys.forEach(k => {
            const entry = topicMap.get(k);
            if (entry && !entry.weeklies.some(w => w.id === weekly.id)) {
                entry.weeklies.push(weekly);
                const text = String(weekly.content || '') + String(weekly.title || '');
                entry.characterCount += text.length;
                const ts = weekly.date ? new Date(weekly.date.replace(' ', 'T')).getTime() : Date.now();
                if (!isNaN(ts)) entry.timestamps.push(ts);
                if (!entry.latestSnippet) {
                    entry.latestSnippet = (weekly.title || text).replace(/<[^>]+>/g, '').slice(0, 60);
                    entry.latestDate = (weekly.date || '').slice(0, 10);
                }
            }
        });
    });

    // 计算衍生指标
    const topics = Array.from(topicMap.values()).map(t => {
        t.totalCount = t.feeds.length + t.notes.length + t.weeklies.length;
        t.stage = getStage(t.totalCount);
        if (t.timestamps.length > 0) {
            const minTs = Math.min(...t.timestamps);
            const maxTs = Math.max(...t.timestamps);
            t.timespanDays = Math.max(1, Math.round((maxTs - minTs) / (86400 * 1000)));
        } else {
            t.timespanDays = 1;
        }
        return t;
    });

    // 排序：常青 > 抽枝 > 萌芽，同阶段按沉淀条数倒序
    topics.sort((a, b) => {
        const stageWeight = { evergreen: 3, branching: 2, budding: 1 };
        const diff = (stageWeight[b.stage.id] || 0) - (stageWeight[a.stage.id] || 0);
        if (diff !== 0) return diff;
        return b.totalCount - a.totalCount;
    });

    return topics;
}

let activeDetailTopic = null;

/**
 * 渲染随手记顶部的常青货架
 */
export function renderTopicShelves() {
    const scrollContainer = document.getElementById('evergreen-shelves-scroll');
    const summaryBadge = document.getElementById('evergreen-shelves-summary');
    if (!scrollContainer) return;

    const topics = aggregateTopics();

    if (summaryBadge) {
        const evergreenCount = topics.filter(t => t.stage.id === 'evergreen').length;
        if (topics.length === 0) {
            summaryBadge.textContent = '等待播种';
        } else if (evergreenCount > 0) {
            summaryBadge.textContent = `${evergreenCount} 棵常青树 · ${topics.length} 个主题`;
        } else {
            summaryBadge.textContent = `${topics.length} 个主题孕育中`;
        }
    }

    if (topics.length === 0) {
        setHtml(scrollContainer, `
            <div class="k-shelf-empty">
                <span class="k-shelf-empty-icon">🌱</span>
                <span class="k-shelf-empty-text">随手记中输入 <b>#标签</b> 或 <b>[[双链]]</b>，此处将自动凝炼为常青主题资产</span>
            </div>
        `);
        return;
    }

    setHtml(scrollContainer, topics.map(t => {
        const wordText = t.characterCount >= 1000 ? `${(t.characterCount / 1000).toFixed(1)}k` : `${t.characterCount}`;
        const prefix = t.type === 'wikilink' ? '🔗 ' : '# ';
        return `
            <div class="k-shelf-card" data-topic-key="${escapeHtml(t.key)}" role="button" tabindex="0" title="${escapeHtml(t.name)} · 轻按查看主题全貌">
                <div class="k-shelf-card-top">
                    <span class="k-topic-stage-chip ${t.stage.badgeClass}">
                        <span class="k-stage-icon">${t.stage.icon}</span>
                        <span>${t.stage.label}</span>
                    </span>
                    <span class="k-shelf-count-badge">${t.totalCount} 篇</span>
                </div>
                <div class="k-shelf-card-title">${prefix}${escapeHtml(t.name)}</div>
                <div class="k-shelf-card-snippet">“${escapeHtml(t.latestSnippet || '暂无文字摘要')}”</div>
                <div class="k-shelf-card-footer">
                    <span class="k-shelf-stat">约 ${wordText} 字</span>
                    <span class="k-shelf-dot-sep">·</span>
                    <span class="k-shelf-span">${t.timespanDays}天跨度</span>
                </div>
            </div>
        `;
    }).join(''));
}

/**
 * 打开特定主题的 Inset Grouped 详情 Sheet
 */
export function openTopicDetailSheet(topicKey) {
    const modal = document.getElementById('topic-detail-modal');
    if (!modal) return;

    const topics = aggregateTopics();
    const topic = topics.find(t => t.key === topicKey.toLowerCase());
    if (!topic) return;

    activeDetailTopic = topic;

    const stagePill = document.getElementById('topic-detail-stage-pill');
    const titleEl = document.getElementById('topic-detail-title');
    const metricCount = document.getElementById('topic-metric-count');
    const metricWords = document.getElementById('topic-metric-words');
    const metricSpan = document.getElementById('topic-metric-span');
    const itemsList = document.getElementById('topic-detail-items-list');

    if (stagePill) {
        stagePill.textContent = `${topic.stage.icon} ${topic.stage.label}资产`;
        stagePill.className = `k-topic-stage-pill ${topic.stage.badgeClass}`;
    }
    if (titleEl) {
        titleEl.textContent = topic.type === 'wikilink' ? `[[${topic.name}]]` : `#${topic.name}`;
    }
    if (metricCount) metricCount.textContent = String(topic.totalCount);
    if (metricWords) {
        metricWords.textContent = topic.characterCount >= 1000 ? `${(topic.characterCount / 1000).toFixed(1)}k` : String(topic.characterCount);
    }
    if (metricSpan) metricSpan.textContent = `${topic.timespanDays}天`;

    if (itemsList) {
        const allItems = [
            ...topic.feeds.map(f => ({
                id: f.id,
                kind: '随手记',
                title: f.content.replace(/<[^>]+>/g, '').slice(0, 40) + '…',
                date: (f.created_at || '').slice(0, 10),
                raw: f
            })),
            ...topic.notes.map(n => ({
                id: n.id,
                kind: '备忘录',
                title: n.title || '无标题笔记',
                date: (n.date || '').slice(0, 10),
                raw: n
            })),
            ...topic.weeklies.map(w => ({
                id: w.id,
                kind: '周记',
                title: w.title || '无标题周记',
                date: (w.date || '').slice(0, 10),
                raw: w
            }))
        ];

        allItems.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        setHtml(itemsList, allItems.map(item => `
            <div class="k-topic-item-row" data-kind="${item.kind}" data-id="${escapeHtml(String(item.id))}">
                <div class="k-topic-item-meta">
                    <span class="k-topic-item-kind">${item.kind}</span>
                    <span class="k-topic-item-date">${escapeHtml(item.date)}</span>
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

    renderTopicShelves();

    // 1. 货架卡片点击代理
    const scrollContainer = document.getElementById('evergreen-shelves-scroll');
    if (scrollContainer) {
        scrollContainer.addEventListener('click', (e) => {
            const card = e.target.closest('.k-shelf-card');
            if (card && card.dataset.topicKey) {
                openTopicDetailSheet(card.dataset.topicKey);
            }
        });
    }

    // 2. 货架顶部“全览”按钮
    document.getElementById('btn-view-all-topics')?.addEventListener('click', () => {
        const topics = aggregateTopics();
        if (topics.length > 0) {
            openTopicDetailSheet(topics[0].key);
        } else {
            showToast('当前暂无主题，试着在随手记里写个 #标签 吧', 'info');
        }
    });

    // 3. 详情 Sheet 中的条目点击
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

    // 4. 追加随想按钮
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
