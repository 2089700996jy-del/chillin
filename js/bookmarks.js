import {
    generateUniqueId,
    escapeHtml,
    showToast,
} from './utils.js';
import { state } from './state.js';
import { ui } from './ui.js';
import { actions } from './actions.js';
import {
    resolveAssetUrl,
    saveBookmarksDatabase,
    apiSyncBookmark,
    stampLocalUpdate,
    addDeletedId,
} from './api.js';

export function initBookmarks() {
    const bookmarkListContainer = document.getElementById('bookmark-list-container');
    const bookmarkEditorForm = document.getElementById('bookmark-editor-form');
    const btnCancelBookmark = document.getElementById('btn-cancel-bookmark');
    const editBookmarkId = document.getElementById('edit-bookmark-id');
    const editBookmarkType = document.getElementById('edit-bookmark-type');
    const editBookmarkTitle = document.getElementById('edit-bookmark-title');
    const editBookmarkUrl = document.getElementById('edit-bookmark-url');
    const editBookmarkDesc = document.getElementById('edit-bookmark-desc');
    const editBookmarkImage = document.getElementById('edit-bookmark-image');

    document.querySelectorAll('.cat-chip').forEach(chip => {
        chip.addEventListener('click', function() {
            document.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('active'));
            this.classList.add('active');
            editBookmarkType.value = this.dataset.val;
        });
    });

const renderBookmarks = () => {
    bookmarkListContainer.innerHTML = '';
    const sortedBookmarks = [...state.bookmarksDatabase].sort((a, b) => b.id - a.id);
    
    sortedBookmarks.forEach(bm => {
        if (ui.currentBookmarksSearchQuery) {
            const query = ui.currentBookmarksSearchQuery.toLowerCase();
            const titleMatch = (bm.title || '').toLowerCase().includes(query);
            const descText = bm.desc || bm.description || '';
            const descMatch = descText.toLowerCase().includes(query);
            const typeMatch = (bm.type || '').toLowerCase().includes(query);
            if (!titleMatch && !descMatch && !typeMatch) return;
        }
        const rawUrl = (bm.url || '').trim();
        const hasUrl = /^https?:\/\//i.test(rawUrl);
        const card = document.createElement(hasUrl ? 'a' : 'div');
        card.className = 'bookmark-card';
        card.setAttribute('data-bookmark-id', String(bm.id));
        if (hasUrl) { card.href = rawUrl; card.target = '_blank'; card.rel = 'noopener noreferrer'; }

        const hasImage = bm.image && bm.image.trim();
        const descDisplay = bm.desc || bm.description || '暂无描述...';
        card.innerHTML = `
            <div class="bookmark-card-inner">
                ${hasImage
                    ? '<img class="bookmark-card-image" src="' + escapeHtml(resolveAssetUrl(bm.image)) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
                    : '<div class="bookmark-card-image-placeholder">' + (bm.type || '🔖').split(' ')[0] + '</div>'}
                <div class="bookmark-card-type">${escapeHtml(bm.type)}</div>
                <div class="bookmark-card-title">${escapeHtml(bm.title)}</div>
                <div class="bookmark-card-desc">${escapeHtml(descDisplay)}</div>
                <button class="bookmark-card-delete" data-id="${escapeHtml(String(bm.id))}" title="删除收藏">×</button>
            </div>
        `;

        // If no URL but has image, click to view image in modal
        if (!hasUrl && hasImage) {
            card.style.cursor = 'zoom-in';
            card.addEventListener('click', (e) => {
                if (e.target.closest('.bookmark-card-delete')) return;
                document.getElementById('image-preview-img').src = resolveAssetUrl(bm.image);
                document.getElementById('image-preview-modal').classList.add('show');
            });
        }

        // 删除按钮
        const deleteBtn = card.querySelector('.bookmark-card-delete');
        deleteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if(confirm(`确定要移除对 "${bm.title}" 的收藏吗？`)) {
                const deletedId = bm.id;
                addDeletedId(deletedId);
                state.bookmarksDatabase = state.bookmarksDatabase.filter(b => b.id !== bm.id);
                saveBookmarksDatabase();
                apiSyncBookmark({id: deletedId}, 'DELETE');
                renderBookmarks();
                showToast('已移除收藏', 'info');
            }
        });

        bookmarkListContainer.appendChild(card);
    });
};

const openBookmarkEditor = () => {
    bookmarkEditorForm.reset();
    editBookmarkId.value = '';
    if (editBookmarkImage) editBookmarkImage.value = '';
    document.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('active'));
    const firstChip = document.querySelector('.cat-chip[data-val="🌐 网站"]');
    if (firstChip) { firstChip.classList.add('active'); editBookmarkType.value = '🌐 网站'; }
    actions.switchView('bookmark-editor');
};

btnCancelBookmark.addEventListener('click', () => actions.switchView('bookmarks'));

bookmarkEditorForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const descText = editBookmarkDesc.value.trim();
    const newBookmark = {
        id: generateUniqueId(),
        type: editBookmarkType.value,
        title: editBookmarkTitle.value.trim(),
        url: editBookmarkUrl.value.trim(),
        desc: descText,
        description: descText,
        image: (editBookmarkImage && editBookmarkImage.value || '').trim()
    };
    stampLocalUpdate(newBookmark);
    state.bookmarksDatabase.unshift(newBookmark);
    saveBookmarksDatabase();
    apiSyncBookmark(newBookmark, 'POST');
    renderBookmarks();
    actions.switchView('bookmarks');
    showToast('新增收藏成功', 'success');
});




    actions.renderBookmarks = renderBookmarks;
    actions.openBookmarkEditor = openBookmarkEditor;

    return { renderBookmarks, openBookmarkEditor };
}
