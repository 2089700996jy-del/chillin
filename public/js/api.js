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
    restoreCookieSession,
    logoutAllDevices,
    refreshSession,
    openSecurityModal,
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
    savePromptsDatabase,
    saveFeedsDatabase,
    apiSyncWeekly,
    apiSyncNote,
    apiSyncBookmark,
    apiSyncPrompt,
    apiSyncFeed,
    checkAndMergeGuestData,
    startAutoSyncEngine,
} from './sync.js';

export {
    openDatabase,
    idbGet,
    idbSet,
    idbDel,
    migrateFromLocalStorage,
} from './db.js';

export {
    createZip,
    buildBackupFiles,
    generateBackupZipBlob,
    downloadBackupZip,
    sendBackupByEmail,
} from './backup.js';
