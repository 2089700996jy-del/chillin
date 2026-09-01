/**
 * Late-bound cross-module actions to avoid circular imports.
 * Each feature module assigns its exports onto this object during init.
 */
export const actions = {
    switchView: null,
    applyRoute: null,
    parseHashRoute: null,
    openArticle: null,
    openWeeklyEditor: null,
    openNoteEditor: null,
    openBookmarkEditor: null,
    handleExitWeeklyEditor: null,
    hasUnsavedChanges: null,
    hasUnsavedNoteChanges: null,
    saveNoteDraft: null,
    renderCards: null,
    renderNotes: null,
    renderBookmarks: null,
    renderFeeds: null,
    renderHeatmap: null,
    renderBookshelf: null,
    renderEchoCards: null,
    jumpToElement: null,
    clearReaderSession: null,
};
