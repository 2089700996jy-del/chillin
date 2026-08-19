import {
    escapeHtml,
    sanitizeHtml,
    getChineseDate,
    getChineseDateTime,
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

export function initWeeklies() {
    const galleryContainer = document.getElementById('gallery-container');
    const filterBtns = document.querySelectorAll('.filter-btn');
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

const renderWeeklyAnnotationsList = () => {
    const timeline = document.getElementById('weekly-annotations-timeline');
    timeline.innerHTML = '';
    if (!currentWeeklyAnnotations || currentWeeklyAnnotations.length === 0) {
        timeline.innerHTML = '<div style="font-size: 13px; color: var(--text-color-light); text-align: center; padding: 20px 0;">暂无追加说明，在下方写下第一条吧</div>';
        return;
    }
    currentWeeklyAnnotations.forEach(ann => {
        const item = document.createElement('div');
        item.className = 'annotation-item';
        item.innerHTML = `
            <div class="annotation-dot"></div>
            <div class="annotation-content-box">
                <div class="annotation-meta">
                    <span class="annotation-time">${escapeHtml(ann.date)}</span>
                    <button type="button" class="btn-delete-annotation" data-id="${ann.id}">删除</button>
                </div>
                <div class="annotation-text">${escapeHtml(ann.content)}</div>
            </div>
        `;
        
        item.querySelector('.btn-delete-annotation').addEventListener('click', () => {
            if (confirm("确定要删除这条批追记吗？")) {
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

const renderCards = (filter) => {
    if (!filter) {
        const activeBtn = document.querySelector('.filter-btn.active');
        filter = activeBtn ? activeBtn.dataset.filter : 'all';
    }
    galleryContainer.innerHTML = '';
    const sortedDB = [...state.database].sort((a, b) => b.id - a.id);
    sortedDB.forEach(item => {
        if (filter !== "all" && item.category !== filter) return;
        
        if (ui.currentHomeSearchQuery) {
            const query = ui.currentHomeSearchQuery.toLowerCase();
            const titleMatch = (item.title || '').toLowerCase().includes(query);
            const summaryMatch = (item.summary || '').toLowerCase().includes(query);
            const contentMatch = (item.content || '').toLowerCase().includes(query);
            if (!titleMatch && !summaryMatch && !contentMatch) return;
        }
        
        const card = document.createElement('div');
        card.className = "notion-collection-card";
        card.dataset.id = item.id;
        let coverHtml = item.cover ? `<img src="${escapeHtml(resolveAssetUrl(item.cover))}" alt="Cover" class="notion-collection-card__cover">` : '';
        
        const annCount = item.annotations && item.annotations.length > 0 ? ` <span class="note-ann-badge">💬 ${item.annotations.length}</span>` : '';
        
        card.innerHTML = `${coverHtml}<div class="notion-collection-card__content"><div class="card-property-category">${escapeHtml(item.category)}</div><div class="card-title">${escapeHtml(item.title)}${annCount}</div><div class="card-summary">${escapeHtml(item.summary)}</div><div class="card-date">${escapeHtml(item.date)}</div></div>`;
        card.addEventListener('click', () => openArticle(item));
        galleryContainer.appendChild(card);
    });
};

const generateWeeklyWidgetsHtml = (data) => {
    if (!data) return '';
    let html = '';
    if (data.music && data.music.title) html += `<h2>🎵 本周循环</h2><div class="widget-music"><div class="widget-music-disk"></div><div class="widget-music-info"><div class="widget-music-title">${escapeHtml(data.music.title)}</div><div class="widget-music-artist">${escapeHtml(data.music.artist)}</div>${data.music.lyric ? `<div class="widget-music-lyric">"${escapeHtml(data.music.lyric)}"</div>` : ''}</div></div>`;
    if (data.media && data.media.length > 0 && data.media[0].title) html += `<h2>🎬 影音书影</h2><div class="widget-media">${data.media.map(m => `<div class="widget-media-item"><div class="widget-media-icon">${escapeHtml(m.icon || '🎬')}</div><div class="widget-media-content"><div class="widget-media-title">${escapeHtml(m.title)}</div><div class="widget-media-desc">${escapeHtml(m.desc)}</div></div></div>`).join('')}</div>`;
    if (data.life && data.life.image) html += `<h2>🍳 烟火日常</h2><div class="widget-polaroid"><img src="${escapeHtml(resolveAssetUrl(data.life.image))}" alt="Life Snapshot"><div class="widget-polaroid-caption">${escapeHtml(data.life.caption)}</div></div>`;
    if (data.podcast) html += `<h2>🎙️ 播客新知</h2><div class="widget-callout"><div class="widget-callout-icon">💡</div><div class="widget-callout-text">${escapeHtml(data.podcast)}</div></div>`;
    if (data.work && data.work.title) html += `<h2>💻 工作切片</h2><div class="widget-work"><div class="widget-work-title">${escapeHtml(data.work.title)}</div><div class="widget-work-desc">${escapeHtml(data.work.desc)}</div></div>`;
    return html;
};

const openArticle = (item, opts = {}) => {
    ui.currentArticleId = item.id;
    articleCategory.innerText = item.category;
    articleDate.innerText = item.date;
    articleTitle.innerText = item.title;
    let finalHtml = item.content || '';
    if (item.weeklyData) finalHtml += generateWeeklyWidgetsHtml(item.weeklyData);
    articleBody.innerHTML = sanitizeHtml(finalHtml);
    articleCoverContainer.innerHTML = item.cover ? `<img src="${escapeHtml(resolveAssetUrl(item.cover))}" alt="Cover">` : '';
    
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

const handleExitWeeklyEditor = (onConfirm) => {
    if (hasUnsavedChanges()) {
        if (confirm('确定要退出编辑吗？当前未保存的内容将作为草稿保存在本地，下次进入时可以恢复。')) {
            saveWeeklyDraft();
            onConfirm();
        }
    } else {
        discardWeeklyDraft();
        onConfirm();
    }
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
    }
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
    const newData = {
        id: isEdit ? parseInt(idStr) : Date.now(), 
        category: document.getElementById('edit-category').value, 
        title: document.getElementById('edit-title').value, 
        summary: document.getElementById('edit-summary').value, 
        cover: document.getElementById('edit-cover').value, 
        content: document.getElementById('edit-content').value,
        date: isEdit ? state.database.find(d => d.id === parseInt(idStr)).date : getChineseDate(),
        annotations: isEdit ? (state.database.find(d => d.id === parseInt(idStr)).annotations || []) : [],
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
    saveDatabase(); apiSyncWeekly(newData, isEdit ? 'PUT' : 'POST'); renderCards(document.querySelector('.filter-btn.active').dataset.filter); actions.switchView('home');
});

// 绑定草稿箱相关按钮与自动保存监听
document.getElementById('btn-restore-weekly-draft').addEventListener('click', restoreWeeklyDraft);
document.getElementById('btn-discard-weekly-draft').addEventListener('click', discardWeeklyDraft);

editorForm.addEventListener('input', () => {
    if (hasUnsavedChanges()) {
        saveWeeklyDraft();
    } else {
        discardWeeklyDraft();
    }
});
editorForm.addEventListener('change', () => {
    if (hasUnsavedChanges()) {
        saveWeeklyDraft();
    } else {
        discardWeeklyDraft();
    }
});

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

btnDeleteArticle.addEventListener('click', () => {
    if(confirm("确定要永久删除这篇记忆吗？")) { 
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
    actions.openArticle = openArticle;
    actions.openWeeklyEditor = openWeeklyEditor;
    actions.handleExitWeeklyEditor = handleExitWeeklyEditor;
    actions.hasUnsavedChanges = hasUnsavedChanges;

    return { renderCards, openArticle, openWeeklyEditor, handleExitWeeklyEditor, hasUnsavedChanges };
}
