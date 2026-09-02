/**
 * Public API facade — re-exports auth + sync so existing `from './api.js'` imports stay unchanged.
 */
export {
    bindApiHooks,
    API_BASE,
    resolveAssetUrl,
    fetchWithFallback,
    getLocalKey,
    checkAuth,
    logout,
    initAuthUI,
    apiRequest,
    registerPushNotification,
} from './auth.js';

export {
    addDeletedId,
    stampLocalUpdate,
    setSyncStatus,
    loadLocalData,
    syncFromApi,
    saveDatabase,
    saveNotesDatabase,
    saveBookmarksDatabase,
    saveFeedsDatabase,
    apiSyncWeekly,
    apiSyncNote,
    apiSyncBookmark,
    apiSyncFeed,
    checkAndMergeGuestData,
    startAutoSyncEngine,
} from './sync.js';
