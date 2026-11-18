/** Shared UI navigation state (mutable). */
export const ui = {
    currentWeeklyId: null,
    get currentArticleId() {
        return this.currentWeeklyId;
    },
    set currentArticleId(val) {
        this.currentWeeklyId = val;
    },
    currentNoteId: null,
    currentActiveNavView: 'home',
    historyNavLock: false,
    aiModalInHistory: false,
};
