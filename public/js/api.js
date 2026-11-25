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
    setSessionInitPromise,
    openSecurityModal,
} from './auth.js';

export {
    addDeletedId,
    removeDeletedId,
    isTombstoned,
    tombstoneKey,
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
    upgradeLocalMockItems,
    dataUriToBlob,
    uploadBase64Image,
    processWeeklyBase64Images,
    processNoteBase64Images,
} from './sync.js';

export {
    openDatabase,
    idbGet,
    idbSet,
    idbDel,
    migrateFromLocalStorage,
    readerDbPut,
    readerDbGet,
    readerDbGetAll,
    readerDbDelete,
} from './db.js';

export {
    createZip,
    buildBackupFiles,
    generateBackupZipBlob,
    downloadBackupZip,
    sendBackupByEmail,
    recordBackupSuccess,
    getLastBackupMeta,
    getBackupGuardSettings,
    setBackupGuardSettings,
    computeBackupGuardStatus,
    updateBackupGuardUI,
    checkAndSendBackupGuardNotification
} from './backup.js';
