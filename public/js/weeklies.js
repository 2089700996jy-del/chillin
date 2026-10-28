/** Weeklies gallery, article view, editor, and annotations. */
import {
    escapeHtml,
    extractImageMatches,
    annotationItemHtml,
    sanitizeHtml,
    markdownToHtml,
    getChineseDate,
    getChineseDateTime,
    getIsoDate,
    formatChineseDate,
    parseIsoDate,
    skeletonListHtml,
    isSyncingNow,
    confirmDialog,
    mountDateFilter,
    filterItemsByYearMonth,
    decodeCssEscapedId,
} from './utils.js';
import { state } from './state.js';
import { ui } from './ui.js';
import { actions } from './actions.js';
import {
    resolveAssetUrl,
    getLocalKey,
    saveDatabase,
    apiSyncWeekly,
    stampLocalUpdate,
    addDeletedId,
} from './api.js';
import { setHtml } from './trusted-types.js';

export function initWeeklies() {
    const galleryContainer = document.getElementById('gallery-container');
    const filterBtns = document.querySelectorAll('.filter-btn');
    const weeklyLoadMoreContainer = document.getElementById('weekly-load-more-container');
    const weeklyFilter = mountDateFilter(document.getElementById('weekly-date-filter'), {
        getDate: (item) => item && item.date,
        unit: '篇',
        onChange: () => {
            weeklyVisibleCount = WEEKLY_PAGE_SIZE;
            renderCards();
        },
    });
    const articleCategory = document.getElementById('article-category');
    const articleDate = document.getElementById('article-date');
    const articleTitle = document.getElementById('article-title');
    const articleCoverContainer = document.getElementById('article-cover-container');
    const articleBody = document.getElementById('article-body');
    const btnEditArticle = document.getElementById('btn-edit-article');
    const btnDeleteArticle = document.getElementById('btn-delete-article');
    const editorForm = document.getElementById('editor-form');
    const btnCancelEdit = document.getElementById('btn-cancel-edit');
    const editorPageTitle = document.getElementById('editor-page-title');

let currentWeeklyAnnotations = [];

// 周记画廊也按批渲染：首屏 60 条，滚到底自动续载；筛选切换时从头开始。
const WEEKLY_PAGE_SIZE = 60;
let weeklyVisibleCount = WEEKLY_PAGE_SIZE;
let weeklyCategoryFilter = 'all';
let weeklyLoadMoreObserver = null;

const loadMoreWeeklies = () => {
    if (weeklyLoadMoreObserver) {
        weeklyLoadMoreObserver.disconnect();
        weeklyLoadMoreObserver = null;
    }
    if (weeklyVisibleCount >= state.database.length) return;
    weeklyVisibleCount += WEEKLY_PAGE_SIZE;
    renderCards();
};

const observeWeeklyLoadMore = (el) => {
    if (typeof IntersectionObserver !== 'function') return;
    el.classList.add('list-load-more--auto');
    weeklyLoadMoreObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreWeeklies();
    }, { rootMargin: '600px 0px' });
    weeklyLoadMoreObserver.observe(el);
};

const renderWeeklyAnnotationsList = () => {
    const timeline = document.getElementById('weekly-annotations-timeline');
    setHtml(timeline, '');
    if (!currentWeeklyAnnotations || currentWeeklyAnnotations.length === 0) {
        setHtml(timeline, '<div style="font-size: 13px; color: var(--text-color-light); text-align: center; padding: 20px 0;">暂无追加说明，在下方写下第一条吧</div>');
        return;
    }
    currentWeeklyAnnotations.forEach(ann => {
        const item = document.createElement('div');
        item.className = 'annotation-item';
        setHtml(item, annotationItemHtml(ann));
        
        item.querySelector('.btn-delete-annotation').addEventListener('click', async () => {
            if (await confirmDialog("确定要删除这条追加说明吗？")) {
                currentWeeklyAnnotations = currentWeeklyAnnotations.filter(a => a.id !== ann.id);
                const article = state.database.find(d => d.id === ui.currentArticleId);
                if (article) {
                    article.annotations = currentWeeklyAnnotations;
                    saveDatabase();
                    apiSyncWeekly(article, 'PUT');
                    renderCards();
                }
                renderWeeklyAnnotationsList();
            }
        });
        
        timeline.appendChild(item);
    });
};

const renderCards = (filter = weeklyCategoryFilter) => {
    if (filter !== weeklyCategoryFilter) weeklyVisibleCount = WEEKLY_PAGE_SIZE;
    weeklyCategoryFilter = filter;
    setHtml(galleryContainer, '');
    if (weeklyLoadMoreContainer) setHtml(weeklyLoadMoreContainer, '');
    if (weeklyLoadMoreObserver) {
        weeklyLoadMoreObserver.disconnect();
        weeklyLoadMoreObserver = null;
    }
    weeklyFilter?.update(state.database);
    const range = weeklyFilter?.getValue() || { year: 'all', month: 'all' };
    const filteredDB = filterItemsByYearMonth(state.database, (item) => item && item.date, range.year, range.month)
        .filter(item => filter === 'all' || item.category === filter)
        .sort((a, b) => b.id - a.id);
    const sortedDB = filteredDB.slice(0, weeklyVisibleCount);
    let rendered = 0;
    sortedDB.forEach(item => {

        const card = document.createElement('div');
        card.className = "notion-collection-card";
        card.dataset.id = item.id;
        let coverHtml = item.cover ? `<img src="${escapeHtml(resolveAssetUrl(item.cover))}" alt="Cover" class="notion-collection-card__cover" loading="lazy" decoding="async">` : '';
        
        const annCount = item.annotations && item.annotations.length > 0 ? ` <span class="note-ann-badge">💬 ${item.annotations.length}</span>` : '';
        
        setHtml(card, `${coverHtml}<div class="notion-collection-card__content"><div class="card-title">${escapeHtml(item.title)}${annCount}</div><div class="card-summary">${escapeHtml(item.summary)}</div><div class="card-date">${escapeHtml(item.date)}</div></div>`);
        card.addEventListener('click', () => openArticle(item));
        galleryContainer.appendChild(card);
        rendered += 1;
    });
    if (rendered === 0) {
        if (isSyncingNow()) {
            setHtml(galleryContainer, skeletonListHtml(3));
            return;
        }
        if (weeklyFilter?.isActive()) {
            setHtml(galleryContainer, `
                <div class="list-empty">
                    <div class="list-empty-icon">🗓️</div>
                    <div class="list-empty-title">这个时间段还没有周记</div>
                    <div class="list-empty-sub">换一年/月看看，或点上方「清除筛选」。</div>
                </div>
            `);
            return;
        }
        setHtml(galleryContainer, `
            <div class="list-empty">
                <div class="list-empty-icon">🌱</div>
                <div class="list-empty-title">还没有记忆切片</div>
                <div class="list-empty-sub">点右下角「+」写下第一篇周记吧</div>
            </div>
        `);
    }

    if (weeklyLoadMoreContainer && filteredDB.length > sortedDB.length) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'list-load-more';
        more.textContent = '加载更多（还有 ' + (filteredDB.length - sortedDB.length) + ' 篇）';
        more.addEventListener('click', loadMoreWeeklies);
        weeklyLoadMoreContainer.appendChild(more);
        observeWeeklyLoadMore(more);
    }
};

const generateWeeklyWidgetsHtml = (data) => {
    if (!data) return '';
    let html = '';
    if (data.music && data.music.title) html += `<h2>🎵 本周循环</h2><div class="widget-music"><div class="widget-music-disk"></div><div class="widget-music-info"><div class="widget-music-title">${escapeHtml(data.music.title)}</div><div class="widget-music-artist">${escapeHtml(data.music.artist)}</div>${data.music.lyric ? `<div class="widget-music-lyric">"${escapeHtml(data.music.lyric)}"</div>` : ''}</div></div>`;
    if (data.media && data.media.length > 0 && data.media[0].title) html += `<h2>🎬 影音书影</h2><div class="widget-media">${data.media.map(m => `<div class="widget-media-item"><div class="widget-media-icon">${escapeHtml(m.icon || '🎬')}</div><div class="widget-media-content"><div class="widget-media-title">${escapeHtml(m.title)}</div><div class="widget-media-desc">${escapeHtml(m.desc)}</div></div></div>`).join('')}</div>`;
    if (data.life && data.life.image) html += `<h2>🍳 烟火日常</h2><div class="widget-polaroid"><img src="${escapeHtml(resolveAssetUrl(data.life.image))}" alt="Life Snapshot" loading="lazy" decoding="async"><div class="widget-polaroid-caption">${escapeHtml(data.life.caption)}</div></div>`;
    if (data.podcast) html += `<h2>🎙️ 播客新知</h2><div class="widget-callout"><div class="widget-callout-icon">💡</div><div class="widget-callout-text">${escapeHtml(data.podcast)}</div></div>`;
    if (data.work && data.work.title) html += `<h2>💻 工作切片</h2><div class="widget-work"><div class="widget-work-title">${escapeHtml(data.work.title)}</div><div class="widget-work-desc">${escapeHtml(data.work.desc)}</div></div>`;
    return html;
};

const openArticle = (item, opts = {}) => {
    ui.currentArticleId = item.id;
    if (articleCategory) articleCategory.innerText = '';
    articleDate.innerText = item.date;
    articleTitle.innerText = item.title;
    const contentStr = item.content || '';
    let finalHtml = '';
    const hasHtmlTags = /<[a-z][\s\S]*>/i.test(contentStr);
    if (hasHtmlTags) {
        // 若包含现有 HTML 标签但含有 Markdown 图片 ![]()，将 ![]() 转换为安全 img 标签
        finalHtml = contentStr.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => {
            const resolvedSrc = resolveAssetUrl(src.trim());
            const cleanAlt = (alt || '').trim() || '图片';
            return `<div class="article-img-wrap"><img src="${escapeHtml(resolvedSrc)}" alt="${escapeHtml(cleanAlt)}" class="article-body-img" loading="lazy" decoding="async"></div>`;
        });
    } else {
        finalHtml = markdownToHtml(contentStr);
    }
    if (item.weeklyData) finalHtml += generateWeeklyWidgetsHtml(item.weeklyData);
    if (actions.parseWikilinksToHtml) finalHtml = actions.parseWikilinksToHtml(finalHtml, true);
    setHtml(articleBody, sanitizeHtml(finalHtml));
    setHtml(articleCoverContainer, item.cover ? `<img src="${escapeHtml(resolveAssetUrl(item.cover))}" alt="Cover" loading="lazy" decoding="async">` : '');
    
    // 渲染反向引用 (Backlinks)
    actions.renderBacklinksSection?.(document.getElementById('weekly-backlinks-section'), item.title, item.id, 'weekly');

    // 加载记忆片段的追加批注
    document.getElementById('new-weekly-annotation-content').value = '';
    currentWeeklyAnnotations = item.annotations || [];
    renderWeeklyAnnotationsList();
    
    actions.switchView('article', opts);
};

// ==========================================
// 草稿保存与恢复逻辑 (Weekly Recap Drafts)
// ==========================================
const hasUnsavedChanges = () => {
    const editId = document.getElementById('edit-id').value;
    const currentCategory = document.getElementById('edit-category').value;
    const currentTitle = document.getElementById('edit-title').value;
    const currentSummary = document.getElementById('edit-summary').value;
    const currentCover = document.getElementById('edit-cover').value;
    const currentContent = document.getElementById('edit-content').value;
    const currentMusicTitle = document.getElementById('edit-music-title').value;
    const currentMusicArtist = document.getElementById('edit-music-artist').value;
    const currentMusicLyric = document.getElementById('edit-music-lyric').value;
    const currentMediaIcon = document.getElementById('edit-media-icon').value;
    const currentMediaTitle = document.getElementById('edit-media-title').value;
    const currentMediaDesc = document.getElementById('edit-media-desc').value;
    const currentLifeImage = document.getElementById('edit-life-image').value;
    const currentLifeCaption = document.getElementById('edit-life-caption').value;
    const currentPodcast = document.getElementById('edit-podcast').value;
    const currentWorkTitle = document.getElementById('edit-work-title').value;
    const currentWorkDesc = document.getElementById('edit-work-desc').value;

    if (editId) {
        // 编辑已有文章：与原始数据库文章对比
        const item = state.database.find(d => d.id === parseInt(editId));
        if (!item) return false;
        const originalMusic = item.weeklyData?.music || {};
        const originalMedia = (item.weeklyData?.media && item.weeklyData.media[0]) || {};
        const originalLife = item.weeklyData?.life || {};
        const originalPodcast = item.weeklyData?.podcast || '';
        const originalWork = item.weeklyData?.work || {};

        return currentCategory !== item.category ||
               currentTitle !== item.title ||
               currentSummary !== item.summary ||
               currentCover !== (item.cover || '') ||
               currentContent !== (item.content || '') ||
               currentMusicTitle !== (originalMusic.title || '') ||
               currentMusicArtist !== (originalMusic.artist || '') ||
               currentMusicLyric !== (originalMusic.lyric || '') ||
               currentMediaIcon !== (originalMedia.icon || '🎬') ||
               currentMediaTitle !== (originalMedia.title || '') ||
               currentMediaDesc !== (originalMedia.desc || '') ||
               currentLifeImage !== (originalLife.image || '') ||
               currentLifeCaption !== (originalLife.caption || '') ||
               currentPodcast !== originalPodcast ||
               currentWorkTitle !== (originalWork.title || '') ||
               currentWorkDesc !== (originalWork.desc || '');
    } else {
        // 新建文章：只要任一字段不为空即为有修改
        return currentTitle.trim() !== '' ||
               currentSummary.trim() !== '' ||
               currentCover.trim() !== '' ||
               currentContent.trim() !== '' ||
               currentMusicTitle.trim() !== '' ||
               currentMusicArtist.trim() !== '' ||
               currentMusicLyric.trim() !== '' ||
               currentMediaTitle.trim() !== '' ||
               currentMediaDesc.trim() !== '' ||
               currentLifeImage.trim() !== '' ||
               currentLifeCaption.trim() !== '' ||
               currentPodcast.trim() !== '' ||
               currentWorkTitle.trim() !== '' ||
               currentWorkDesc.trim() !== '';
    }
};

const saveWeeklyDraft = () => {
    const editId = document.getElementById('edit-id').value;
    const draft = {
        id: editId ? parseInt(editId) : '',
        category: document.getElementById('edit-category').value,
        title: document.getElementById('edit-title').value,
        summary: document.getElementById('edit-summary').value,
        cover: document.getElementById('edit-cover').value,
        content: document.getElementById('edit-content').value,
        date: document.getElementById('edit-date')?.value || getIsoDate(),
        musicTitle: document.getElementById('edit-music-title').value,
        musicArtist: document.getElementById('edit-music-artist').value,
        musicLyric: document.getElementById('edit-music-lyric').value,
        mediaIcon: document.getElementById('edit-media-icon').value,
        mediaTitle: document.getElementById('edit-media-title').value,
        mediaDesc: document.getElementById('edit-media-desc').value,
        lifeImage: document.getElementById('edit-life-image').value,
        lifeCaption: document.getElementById('edit-life-caption').value,
        podcast: document.getElementById('edit-podcast').value,
        workTitle: document.getElementById('edit-work-title').value,
        workDesc: document.getElementById('edit-work-desc').value,
        timestamp: Date.now()
    };
    localStorage.setItem(getLocalKey('weeklyDraft'), JSON.stringify(draft));
};

const restoreWeeklyDraft = () => {
    const draftStr = localStorage.getItem(getLocalKey('weeklyDraft'));
    if (!draftStr) return;
    try {
        const draft = JSON.parse(draftStr);
        document.getElementById('edit-category').value = draft.category || '🌸';
        document.getElementById('edit-title').value = draft.title || '';
        document.getElementById('edit-summary').value = draft.summary || '';
        if (draft.date) {
            const editDateEl = document.getElementById('edit-date');
            if (editDateEl) editDateEl.value = draft.date;
        }
        document.getElementById('edit-cover').value = draft.cover || '';
        document.getElementById('edit-content').value = draft.content || '';
        document.getElementById('edit-music-title').value = draft.musicTitle || '';
        document.getElementById('edit-music-artist').value = draft.musicArtist || '';
        document.getElementById('edit-music-lyric').value = draft.musicLyric || '';
        document.getElementById('edit-media-icon').value = draft.mediaIcon || '🎬';
        document.getElementById('edit-media-title').value = draft.mediaTitle || '';
        document.getElementById('edit-media-desc').value = draft.mediaDesc || '';
        document.getElementById('edit-life-image').value = draft.lifeImage || '';
        document.getElementById('edit-life-caption').value = draft.lifeCaption || '';
        document.getElementById('edit-podcast').value = draft.podcast || '';
        document.getElementById('edit-work-title').value = draft.workTitle || '';
        document.getElementById('edit-work-desc').value = draft.workDesc || '';
        
        // 刷新 iOS Inset Grouped UI 状态 (分类高亮、封面缩略图、微件折叠展开与计数)
        refreshEditorUI(true);

        // 隐藏横幅
        document.getElementById('weekly-draft-tip').style.display = 'none';
    } catch (e) {
        console.error('Failed to restore draft', e);
    }
};

const discardWeeklyDraft = () => {
    localStorage.removeItem(getLocalKey('weeklyDraft'));
    document.getElementById('weekly-draft-tip').style.display = 'none';
};

const checkAndShowWeeklyDraftTip = (editId) => {
    const draftStr = localStorage.getItem(getLocalKey('weeklyDraft'));
    const tipBanner = document.getElementById('weekly-draft-tip');
    if (!draftStr) {
        tipBanner.style.display = 'none';
        return;
    }
    try {
        const draft = JSON.parse(draftStr);
        const currentIdStr = editId ? String(editId) : '';
        const draftIdStr = draft.id ? String(draft.id) : '';
        
        if (currentIdStr === draftIdStr) {
            const draftDate = new Date(draft.timestamp);
            const timeText = draftDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            document.getElementById('weekly-draft-time').innerText = timeText;
            tipBanner.style.display = 'flex';
        } else {
            tipBanner.style.display = 'none';
        }
    } catch (e) {
        tipBanner.style.display = 'none';
    }
};

const handleExitWeeklyEditor = async (onConfirm) => {
    if (hasUnsavedChanges()) {
        if (await confirmDialog('确定要退出编辑吗？当前未保存的内容将作为草稿保存在本地，下次进入时可以恢复。')) {
            saveWeeklyDraft();
            onConfirm();
        }
    } else {
        discardWeeklyDraft();
        onConfirm();
    }
};

// --- iOS Inset Grouped Editor Helpers ---
const syncCategorySegmented = (catVal) => {
    const segmentedTabs = document.querySelectorAll('#weekly-category-segmented .ios-segmented-tab');
    segmentedTabs.forEach(tab => {
        const isMatch = tab.dataset.category === catVal;
        tab.classList.toggle('active', isMatch);
        tab.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });
};

const updateCoverPreview = () => {
    const coverVal = (document.getElementById('edit-cover')?.value || '').trim();
    const previewWrap = document.getElementById('edit-cover-preview');
    const previewImg = document.getElementById('edit-cover-preview-img');
    if (!previewWrap || !previewImg) return;
    if (coverVal) {
        previewImg.src = resolveAssetUrl(coverVal);
        previewWrap.style.display = 'block';
    } else {
        previewImg.src = '';
        previewWrap.style.display = 'none';
    }
};

const countFilledWidgets = () => {
    let count = 0;
    const hasMusic = (document.getElementById('edit-music-title')?.value || '').trim() !== '' ||
                     (document.getElementById('edit-music-artist')?.value || '').trim() !== '';
    const hasMedia = (document.getElementById('edit-media-title')?.value || '').trim() !== '';
    const hasLife = (document.getElementById('edit-life-image')?.value || '').trim() !== '';
    const hasPodcast = (document.getElementById('edit-podcast')?.value || '').trim() !== '';
    const hasWork = (document.getElementById('edit-work-title')?.value || '').trim() !== '' ||
                    (document.getElementById('edit-work-desc')?.value || '').trim() !== '';
    if (hasMusic) count++;
    if (hasMedia) count++;
    if (hasLife) count++;
    if (hasPodcast) count++;
    if (hasWork) count++;
    return count;
};

const updateWidgetBadgeAndState = (shouldAutoOpen = false) => {
    const badge = document.getElementById('weekly-widgets-badge');
    const accordion = document.getElementById('weekly-widgets-accordion');
    const count = countFilledWidgets();
    if (badge) {
        if (count > 0) {
            badge.textContent = `已填 ${count} 项`;
            badge.classList.add('has-filled');
            if (shouldAutoOpen && accordion) {
                accordion.open = true;
            }
        } else {
            badge.textContent = '选填 ▾';
            badge.classList.remove('has-filled');
            if (shouldAutoOpen && accordion) {
                accordion.open = false;
            }
        }
    }
};

const updateContentImagePreview = () => {
    const textarea = document.getElementById('edit-content');
    const previewStrip = document.getElementById('edit-content-preview');
    if (!textarea || !previewStrip) return;

    const imgMatches = extractImageMatches(textarea.value);
    if (imgMatches.length === 0) {
        previewStrip.style.display = 'none';
        setHtml(previewStrip, '');
        return;
    }

    previewStrip.style.display = 'flex';
    const itemsHtml = imgMatches.map((img, index) => {
        const resolved = resolveAssetUrl(img.url);
        return `
            <div class="ios-content-preview-item" data-index="${index}" title="${escapeHtml(img.alt)}">
                <img src="${escapeHtml(resolved)}" alt="${escapeHtml(img.alt)}" loading="lazy" decoding="async">
                <span class="ios-content-preview-caption">${escapeHtml(img.alt || `图 ${index + 1}`)}</span>
                <button type="button" class="ios-content-preview-remove" data-raw="${escapeHtml(img.raw)}" title="从正文中移除此图片" aria-label="移除此图片">×</button>
            </div>
        `;
    }).join('');

    setHtml(previewStrip, `
        <div class="ios-content-preview-header">
            <span class="ios-content-preview-count">🖼️ 正文图片预览 (${imgMatches.length})</span>
            <span class="ios-content-preview-hint">轻按 × 可从正文移除</span>
        </div>
        <div class="ios-content-preview-list">
            ${itemsHtml}
        </div>
    `);

    previewStrip.querySelectorAll('.ios-content-preview-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const rawToRemove = btn.getAttribute('data-raw');
            if (rawToRemove) {
                textarea.value = textarea.value.replace(rawToRemove, '').replace(/\n\s*\n\s*\n/g, '\n\n');
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
                updateContentImagePreview();
            }
        });
    });
};

const refreshEditorUI = (shouldAutoOpenWidgets = false) => {
    const catVal = document.getElementById('edit-category')?.value || '🌸';
    syncCategorySegmented(catVal);
    updateCoverPreview();
    updateContentImagePreview();
    updateWidgetBadgeAndState(shouldAutoOpenWidgets);
};

const openWeeklyEditor = (editId = null, opts = {}) => {
    editorForm.reset();
    if (editId) {
        editorPageTitle.innerText = "编辑记忆";
        const item = state.database.find(d => d.id === editId || String(d.id) === String(editId));
        if (item) {
            document.getElementById('edit-id').value = item.id;
            document.getElementById('edit-category').value = item.category;
            document.getElementById('edit-title').value = item.title;
            document.getElementById('edit-summary').value = item.summary;
            const editDateEl = document.getElementById('edit-date');
            if (editDateEl) editDateEl.value = parseIsoDate(item.date) || getIsoDate();
            document.getElementById('edit-cover').value = item.cover || '';
            document.getElementById('edit-content').value = item.content || '';
            if (item.weeklyData) {
                if(item.weeklyData.music) { document.getElementById('edit-music-title').value = item.weeklyData.music.title || ''; document.getElementById('edit-music-artist').value = item.weeklyData.music.artist || ''; document.getElementById('edit-music-lyric').value = item.weeklyData.music.lyric || ''; }
                if(item.weeklyData.media && item.weeklyData.media.length > 0) { document.getElementById('edit-media-icon').value = item.weeklyData.media[0].icon || '🎬'; document.getElementById('edit-media-title').value = item.weeklyData.media[0].title || ''; document.getElementById('edit-media-desc').value = item.weeklyData.media[0].desc || ''; }
                if(item.weeklyData.life) { document.getElementById('edit-life-image').value = item.weeklyData.life.image || ''; document.getElementById('edit-life-caption').value = item.weeklyData.life.caption || ''; }
                if(item.weeklyData.podcast) document.getElementById('edit-podcast').value = item.weeklyData.podcast || '';
                if(item.weeklyData.work) { document.getElementById('edit-work-title').value = item.weeklyData.work.title || ''; document.getElementById('edit-work-desc').value = item.weeklyData.work.desc || ''; }
            }
        }
    } else {
        editorPageTitle.innerText = "新增记忆";
        document.getElementById('edit-id').value = '';
        const editDateEl = document.getElementById('edit-date');
        if (editDateEl) editDateEl.value = getIsoDate();
    }
    refreshEditorUI(Boolean(editId));
    checkAndShowWeeklyDraftTip(editId);
    actions.switchView('editor', opts);
};

btnEditArticle.addEventListener('click', () => openWeeklyEditor(ui.currentArticleId));
btnCancelEdit.addEventListener('click', () => {
    handleExitWeeklyEditor(() => {
        const isNew = !document.getElementById('edit-id').value;
        actions.switchView(isNew ? 'home' : 'article');
    });
});

editorForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const idStr = document.getElementById('edit-id').value;
    const isEdit = !!idStr;
    const existingWeekly = isEdit ? state.database.find(d => String(d.id) === String(idStr)) : null;
    const pickedDateVal = document.getElementById('edit-date')?.value || '';
    const finalDate = pickedDateVal ? formatChineseDate(pickedDateVal) : (existingWeekly ? existingWeekly.date : getChineseDate());
    const newData = {
        id: isEdit ? parseInt(idStr) : Date.now(), 
        category: document.getElementById('edit-category').value, 
        title: document.getElementById('edit-title').value, 
        summary: document.getElementById('edit-summary').value, 
        cover: document.getElementById('edit-cover').value, 
        content: document.getElementById('edit-content').value,
        date: finalDate,
        annotations: existingWeekly?.annotations || [],
        weeklyData: {
            music: { title: document.getElementById('edit-music-title').value, artist: document.getElementById('edit-music-artist').value, lyric: document.getElementById('edit-music-lyric').value },
            media: [{ icon: document.getElementById('edit-media-icon').value, title: document.getElementById('edit-media-title').value, desc: document.getElementById('edit-media-desc').value }],
            life: { image: document.getElementById('edit-life-image').value, caption: document.getElementById('edit-life-caption').value },
            podcast: document.getElementById('edit-podcast').value,
            work: { title: document.getElementById('edit-work-title').value, desc: document.getElementById('edit-work-desc').value }
        }
    };
    if(!newData.weeklyData.music.title) delete newData.weeklyData.music; if(!newData.weeklyData.media[0].title) delete newData.weeklyData.media; if(!newData.weeklyData.life.image) delete newData.weeklyData.life; if(!newData.weeklyData.podcast) delete newData.weeklyData.podcast; if(!newData.weeklyData.work.title) delete newData.weeklyData.work; if(Object.keys(newData.weeklyData).length === 0) delete newData.weeklyData;
    stampLocalUpdate(newData);
    if (isEdit) { const index = state.database.findIndex(d => d.id === parseInt(idStr)); if(index !== -1) state.database[index] = newData; } else { state.database.push(newData); }
    discardWeeklyDraft();
    saveDatabase(); apiSyncWeekly(newData, isEdit ? 'PUT' : 'POST'); renderCards(); actions.switchView('home');
});

// 绑定草稿箱相关按钮与自动保存监听
document.getElementById('btn-restore-weekly-draft').addEventListener('click', restoreWeeklyDraft);
document.getElementById('btn-discard-weekly-draft').addEventListener('click', discardWeeklyDraft);
document.getElementById('btn-weekly-date-today')?.addEventListener('click', () => {
    const editDate = document.getElementById('edit-date');
    if (editDate) {
        editDate.value = getIsoDate();
        saveWeeklyDraft();
    }
});

editorForm.addEventListener('input', () => {
    updateWidgetBadgeAndState(false);
    if (hasUnsavedChanges()) {
        saveWeeklyDraft();
    } else {
        discardWeeklyDraft();
    }
});
editorForm.addEventListener('change', () => {
    updateWidgetBadgeAndState(false);
    if (hasUnsavedChanges()) {
        saveWeeklyDraft();
    } else {
        discardWeeklyDraft();
    }
});

// iOS 分类分段选择器交互绑定
document.querySelectorAll('#weekly-category-segmented .ios-segmented-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const cat = tab.dataset.category;
        const editCategory = document.getElementById('edit-category');
        if (editCategory) {
            editCategory.value = cat;
            syncCategorySegmented(cat);
            editCategory.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });
});

// 封面图实时预览与清空交互
const editCoverEl = document.getElementById('edit-cover');
if (editCoverEl) {
    editCoverEl.addEventListener('input', updateCoverPreview);
    editCoverEl.addEventListener('change', updateCoverPreview);
}
document.getElementById('btn-clear-cover')?.addEventListener('click', () => {
    if (editCoverEl) {
        editCoverEl.value = '';
        updateCoverPreview();
        editCoverEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
});

// 自由书写正文图片实时缩略图栏交互
const editContentEl = document.getElementById('edit-content');
if (editContentEl) {
    editContentEl.addEventListener('input', updateContentImagePreview);
    editContentEl.addEventListener('change', updateContentImagePreview);
}

window.addEventListener('beforeunload', (e) => {
    const activeView = document.querySelector('.view-section.active');
    if (activeView && activeView.id === 'view-editor' && hasUnsavedChanges()) {
        saveWeeklyDraft();
        e.preventDefault();
        e.returnValue = '';
    }
    if (activeView && activeView.id === 'view-note-editor' && actions.hasUnsavedNoteChanges()) {
        actions.saveNoteDraft();
        e.preventDefault();
        e.returnValue = '';
    }
});

btnDeleteArticle.addEventListener('click', async () => {
    if(await confirmDialog("确定要永久删除这篇记忆吗？")) { 
        const deletedId = ui.currentArticleId; 
        addDeletedId(deletedId);
        state.database = state.database.filter(d => d.id !== ui.currentArticleId); 
        saveDatabase(); 
        apiSyncWeekly({id: deletedId}, 'DELETE'); 
        renderCards(); 
        actions.switchView('home'); 
    }
});

document.getElementById('btn-add-weekly-annotation').addEventListener('click', () => {
    const inputEl = document.getElementById('new-weekly-annotation-content');
    const text = inputEl.value.trim();
    if (!text) return;
    const newAnn = {
        id: Date.now(),
        content: text,
        date: getChineseDateTime()
    };
    currentWeeklyAnnotations.push(newAnn);
    inputEl.value = '';
    
    const article = state.database.find(d => d.id === ui.currentArticleId);
    if (article) {
        article.annotations = currentWeeklyAnnotations;
        saveDatabase();
        apiSyncWeekly(article, 'PUT');
        renderCards();
    }
    renderWeeklyAnnotationsList();
});

filterBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        filterBtns.forEach(b => b.classList.remove('active')); e.target.classList.add('active'); renderCards(e.target.dataset.filter);
    });
});



    actions.renderCards = renderCards;
    actions.ensureWeeklyRendered = (selector) => {
        const matched = /data-id="([^"]+)"/.exec(String(selector || ''));
        if (!matched) return false;
        const target = state.database.find((item) => String(item.id) === decodeCssEscapedId(matched[1]));
        if (!target) return false;

        let changed = false;
        if (weeklyFilter?.isActive()) {
            const range = weeklyFilter.getValue();
            const stillVisible = filterItemsByYearMonth([target], (item) => item && item.date, range.year, range.month);
            if (!stillVisible.length) {
                weeklyFilter.reset();
                changed = true;
            }
        }
        if (weeklyCategoryFilter !== 'all' && target.category !== weeklyCategoryFilter) {
            weeklyCategoryFilter = 'all';
            changed = true;
        }

        const filtered = filterItemsByYearMonth(
            state.database,
            (item) => item && item.date,
            weeklyFilter?.getValue().year || 'all',
            weeklyFilter?.getValue().month || 'all'
        ).filter((item) => weeklyCategoryFilter === 'all' || item.category === weeklyCategoryFilter);
        const index = filtered.findIndex((item) => String(item.id) === String(target.id));
        if (index < 0) return false;
        if (index >= weeklyVisibleCount) {
            weeklyVisibleCount = Math.ceil((index + 1) / WEEKLY_PAGE_SIZE) * WEEKLY_PAGE_SIZE;
            changed = true;
        }
        if (!changed) return false;
        renderCards();
        return true;
    };
    actions.openArticle = openArticle;
    actions.openWeeklyEditor = openWeeklyEditor;
    actions.handleExitWeeklyEditor = handleExitWeeklyEditor;
    actions.hasUnsavedChanges = hasUnsavedChanges;

    return { renderCards, openArticle, openWeeklyEditor, handleExitWeeklyEditor, hasUnsavedChanges };
}
