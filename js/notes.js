import {
    escapeHtml,
    autoResizeTextarea,
    getChineseDate,
    getChineseDateTime,
} from './utils.js';
import { state } from './state.js';
import { ui } from './ui.js';
import { actions } from './actions.js';
import {
    getLocalKey,
    saveNotesDatabase,
    apiSyncNote,
    stampLocalUpdate,
    addDeletedId,
} from './api.js';

export function initNotes() {
    const notesListContainer = document.getElementById('notes-list-container');
    const editNoteTitle = document.getElementById('edit-note-title');
    const editNoteContent = document.getElementById('edit-note-content');
    const editNoteId = document.getElementById('edit-note-id');
    const btnSaveNote = document.getElementById('btn-save-note');
    const btnDeleteNote = document.getElementById('btn-delete-note');
    const noteEditorDate = document.getElementById('note-editor-date');

    editNoteContent.addEventListener('input', () => autoResizeTextarea(editNoteContent));

let currentNoteAnnotations = [];

const renderAnnotationsList = () => {
    const timeline = document.getElementById('annotations-timeline');
    timeline.innerHTML = '';
    if (!currentNoteAnnotations || currentNoteAnnotations.length === 0) {
        timeline.innerHTML = '<div style="font-size: 13px; color: var(--text-color-light); text-align: center; padding: 20px 0;">暂无批注，在下方写下第一条吧</div>';
        return;
    }
    currentNoteAnnotations.forEach(ann => {
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
            if (confirm("确定要删除这条批注吗？")) {
                currentNoteAnnotations = currentNoteAnnotations.filter(a => a.id !== ann.id);
                const note = state.notesDatabase.find(n => n.id === ui.currentNoteId);
                if (note) {
                    note.annotations = currentNoteAnnotations;
                    saveNotesDatabase();
                    apiSyncNote(note, 'PUT');
                    renderNotes();
                }
                renderAnnotationsList();
            }
        });
        
        timeline.appendChild(item);
    });
};

const renderNotes = () => {
    notesListContainer.innerHTML = '';
    const sortedNotes = [...state.notesDatabase].sort((a, b) => b.id - a.id);
    if (sortedNotes.length === 0) {
        notesListContainer.innerHTML = `
            <div class="list-empty">
                <div class="list-empty-icon">📝</div>
                <div class="list-empty-title">还没有笔记</div>
                <div class="list-empty-sub">点右下角「+」捕捉一闪而过的想法</div>
            </div>
        `;
        return;
    }
    sortedNotes.forEach(note => {
        const el = document.createElement('div');
        el.className = 'note-item';
        el.setAttribute('data-note-id', String(note.id));
        const previewText = note.content ? escapeHtml(note.content.substring(0, 30)).replace(/\n/g, ' ') + '...' : '无正文内容';
        
        // 如果笔记有批注，显示批注数量气泡
        const annCount = note.annotations && note.annotations.length > 0 ? ` <span class="note-ann-badge">💬 ${note.annotations.length}</span>` : '';
        
        el.innerHTML = `<div class="note-item-content"><div class="note-item-title">${escapeHtml(note.title || '无标题笔记')}${annCount}</div><div class="note-item-preview">${previewText}</div></div><div class="note-item-date">${escapeHtml(note.date)}</div>`;
        el.addEventListener('click', () => openNoteEditor(note.id));
        notesListContainer.appendChild(el);
    });
};

const hasUnsavedNoteChanges = () => {
    const titleVal = (editNoteTitle.value || '').trim();
    const contentVal = (editNoteContent.value || '').trim();
    const idStr = editNoteId.value;
    if (idStr) {
        const note = state.notesDatabase.find(n => String(n.id) === String(idStr));
        if (!note) return titleVal !== '' || contentVal !== '';
        return titleVal !== (note.title || '').trim() || contentVal !== (note.content || '').trim();
    }
    return titleVal !== '' || contentVal !== '';
};

const saveNoteDraft = () => {
    const draft = {
        id: editNoteId.value || '',
        title: editNoteTitle.value || '',
        content: editNoteContent.value || '',
        timestamp: Date.now()
    };
    localStorage.setItem(getLocalKey('noteDraft'), JSON.stringify(draft));
};

const restoreNoteDraft = () => {
    const draftStr = localStorage.getItem(getLocalKey('noteDraft'));
    if (!draftStr) return;
    try {
        const draft = JSON.parse(draftStr);
        editNoteTitle.value = draft.title || '';
        editNoteContent.value = draft.content || '';
        autoResizeTextarea(editNoteContent);
        document.getElementById('note-draft-tip').style.display = 'none';
    } catch (e) {
        console.error('Failed to restore note draft', e);
    }
};

const discardNoteDraft = () => {
    localStorage.removeItem(getLocalKey('noteDraft'));
    const tip = document.getElementById('note-draft-tip');
    if (tip) tip.style.display = 'none';
};

const checkAndShowNoteDraftTip = (noteId) => {
    const tipBanner = document.getElementById('note-draft-tip');
    if (!tipBanner) return;
    const draftStr = localStorage.getItem(getLocalKey('noteDraft'));
    if (!draftStr) {
        tipBanner.style.display = 'none';
        return;
    }
    try {
        const draft = JSON.parse(draftStr);
        const currentIdStr = noteId != null && noteId !== '' ? String(noteId) : '';
        const draftIdStr = draft.id ? String(draft.id) : '';
        if (currentIdStr !== draftIdStr) {
            tipBanner.style.display = 'none';
            return;
        }
        const timeEl = document.getElementById('note-draft-time');
        if (timeEl && draft.timestamp) {
            timeEl.innerText = new Date(draft.timestamp).toLocaleString();
        }
        tipBanner.style.display = 'flex';
    } catch (e) {
        tipBanner.style.display = 'none';
    }
};

const openNoteEditor = (noteId = null, opts = {}) => {
    document.getElementById('new-annotation-content').value = '';
    if (noteId) {
        ui.currentNoteId = noteId; const note = state.notesDatabase.find(n => n.id === noteId || String(n.id) === String(noteId));
        if (note) { 
            editNoteId.value = note.id; 
            editNoteTitle.value = note.title; 
            editNoteContent.value = note.content; 
            noteEditorDate.innerText = note.date; 
            btnDeleteNote.style.display = 'inline-block'; 
            currentNoteAnnotations = note.annotations || [];
            renderAnnotationsList();
            document.getElementById('note-annotations-section').style.display = 'block';
        }
    } else {
        ui.currentNoteId = null; editNoteId.value = ''; editNoteTitle.value = ''; editNoteContent.value = ''; noteEditorDate.innerText = getChineseDate(); btnDeleteNote.style.display = 'none';
        currentNoteAnnotations = [];
        document.getElementById('note-annotations-section').style.display = 'none';
    }
    checkAndShowNoteDraftTip(noteId);
    actions.switchView('note-editor', opts);
    autoResizeTextarea(editNoteContent);
};

btnSaveNote.addEventListener('click', () => {
    const idStr = editNoteId.value; const isEdit = !!idStr; const titleVal = editNoteTitle.value.trim(); const contentVal = editNoteContent.value.trim();
    if (!titleVal && !contentVal) { discardNoteDraft(); actions.switchView('notes'); return; }
    const newNote = { 
        id: isEdit ? parseInt(idStr) : Date.now(), 
        title: titleVal || '无标题笔记', 
        content: contentVal, 
        date: isEdit ? state.notesDatabase.find(n => n.id === parseInt(idStr)).date : getChineseDate(),
        annotations: currentNoteAnnotations
    };
    stampLocalUpdate(newNote);
    if (isEdit) { const index = state.notesDatabase.findIndex(n => n.id === parseInt(idStr)); if(index !== -1) state.notesDatabase[index] = newNote; } else { state.notesDatabase.push(newNote); }
    discardNoteDraft();
    saveNotesDatabase(); apiSyncNote(newNote, isEdit ? 'PUT' : 'POST'); renderNotes(); actions.switchView('notes');
});

const persistNoteDraftIfNeeded = () => {
    if (hasUnsavedNoteChanges()) saveNoteDraft();
    else discardNoteDraft();
};
editNoteTitle.addEventListener('input', persistNoteDraftIfNeeded);
editNoteContent.addEventListener('input', persistNoteDraftIfNeeded);
document.getElementById('btn-restore-note-draft')?.addEventListener('click', restoreNoteDraft);
document.getElementById('btn-discard-note-draft')?.addEventListener('click', discardNoteDraft);

btnDeleteNote.addEventListener('click', () => {
    if(confirm("确定删除这条笔记吗？")) { 
        const deletedId = ui.currentNoteId; 
        addDeletedId(deletedId);
        state.notesDatabase = state.notesDatabase.filter(n => n.id !== ui.currentNoteId); 
        saveNotesDatabase(); 
        discardNoteDraft();
        apiSyncNote({id: deletedId}, 'DELETE'); 
        renderNotes(); 
        actions.switchView('notes'); 
    }
});

document.getElementById('btn-add-annotation').addEventListener('click', () => {
    const inputEl = document.getElementById('new-annotation-content');
    const text = inputEl.value.trim();
    if (!text) return;
    const newAnn = {
        id: Date.now(),
        content: text,
        date: getChineseDateTime()
    };
    currentNoteAnnotations.push(newAnn);
    inputEl.value = '';
    
    // 如果是已存笔记，立刻保存到数据库
    const note = state.notesDatabase.find(n => n.id === ui.currentNoteId);
    if (note) {
        note.annotations = currentNoteAnnotations;
        saveNotesDatabase();
        apiSyncNote(note, 'PUT');
        renderNotes();
    }
    renderAnnotationsList();
});



    actions.renderNotes = renderNotes;
    actions.openNoteEditor = openNoteEditor;
    actions.hasUnsavedNoteChanges = hasUnsavedNoteChanges;
    actions.saveNoteDraft = saveNoteDraft;

    return { renderNotes, openNoteEditor, hasUnsavedNoteChanges, saveNoteDraft };
}
