import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedUser, sqliteTest } from './fake-d1.mjs';
import { handleSyncBatch } from '../workers/src/garden-sync.js';
const integration = sqliteTest;

// Node.js test environment mock for browser globals
if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
}
if (typeof globalThis.location === 'undefined') {
    globalThis.location = { hostname: 'localhost', origin: 'http://localhost' };
}
if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => store.get(k) || null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear()
    };
}
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        body: { classList: { toggle: () => { }, remove: () => { }, add: () => { } } },
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => []
    };
}

const {
    mergeDataLists,
    toUpdatedTs,
    getIncrementalSyncCursor,
    makePushedTimestampMap,
    clearPushedDirtyFlags,
    syncSignature,
    processApiSyncResult,
    getSyncConflicts,
    loadLocalData,
    stampLocalUpdate,
    processNoteBase64Images,
    getPendingDeletedItems,
    addPendingDeletedItem,
    removePendingDeletedItem
} = await import('../public/js/sync.js');
const { getLocalKey } = await import('../public/js/auth.js');
const { getEast8Time } = await import('../public/js/utils.js');

test('Sync - toUpdatedTs converts various date formats accurately', () => {
    const tsIso = toUpdatedTs('2026-09-23T10:00:00+08:00');
    assert.ok(tsIso > 0);

    const tsSql = toUpdatedTs('2026-09-23 10:00:00');
    assert.ok(tsSql > 0);

    const tsInvalid = toUpdatedTs('');
    assert.equal(tsInvalid, 0);
});

test('Sync - incremental cursor overlaps one second to catch same-second writes', () => {
    const cursor = '2026-10-16 12:00:05';
    const overlap = getIncrementalSyncCursor(cursor);
    assert.equal(toUpdatedTs(overlap), toUpdatedTs(cursor) - 1000);
    assert.equal(getIncrementalSyncCursor('invalid'), 'invalid');
});
test('Sync - mergeDataLists applies Last-Write-Wins and merges unique items', () => {
    const local = [
        { id: 1, title: '本地新周记', updated_at: '2026-09-23 12:00:00', _dirty: true },
        { id: 2, title: '本地旧笔记', updated_at: '2026-09-23 10:00:00' }
    ];

    const cloud = [
        { id: 2, title: '云端较新笔记', updated_at: '2026-09-23 11:00:00' },
        { id: 3, title: '云端新增提示词', updated_at: '2026-09-23 11:30:00' }
    ];

    const merged = mergeDataLists(local, cloud);

    assert.equal(merged.length, 3);
    const item1 = merged.find(i => i.id === 1);
    const item2 = merged.find(i => i.id === 2);
    const item3 = merged.find(i => i.id === 3);

    assert.equal(item1.title, '本地新周记');
    assert.equal(item2.title, '云端较新笔记', 'Cloud item with newer timestamp should win');
    assert.equal(item3.title, '云端新增提示词');
});

test('Sync - syncSignature ignores sync noise and is stable across key order', () => {
    const a = { id: 1, title: '同一篇', content: '正文', annotations: [{ id: 'x', note: '批注' }], _dirty: true, updated_at: '2026-10-30 09:00:00' };
    const b = { id: 1, title: '同一篇', content: '正文', annotations: [{ note: '批注', id: 'x' }], _dirty: false, updated_at: '2026-10-31 09:00:00' };
    assert.equal(syncSignature('notes', a), syncSignature('notes', b));
    assert.notEqual(syncSignature('notes', a), syncSignature('notes', { ...b, content: '改过的正文' }));
});

test('Sync - local dirty edit wins over changed cloud row and is recorded as a conflict', () => {
    localStorage.clear();
    localStorage.setItem('default_gardenSyncedIds', JSON.stringify(['9001']));
    const local = [{ id: 9001, title: '本地版本', content: '本地正文', updated_at: '2026-10-30 09:00:00', _dirty: true }];
    const cloud = [{ id: 9001, title: '云端版本', content: '云端正文', updated_at: '2026-10-30 10:00:00' }];

    const result = processApiSyncResult(local, cloud, false, 'notes');
    assert.equal(result.conflicts, 1);
    assert.equal(result.needsUpload, false, '冲突项不能自动上传覆盖云端');
    assert.equal(result.merged.find((item) => item.id === 9001).title, '本地版本');
    const conflicts = getSyncConflicts();
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].cloud.title, '云端版本');
    assert.equal(conflicts[0].local.title, '本地版本');
    localStorage.clear();
});

test('Sync - local edit survives a cloud tombstone instead of being silently dropped', () => {
    localStorage.clear();
    localStorage.setItem('default_gardenSyncedIds', JSON.stringify(['9101']));
    const local = [{ id: 9101, title: '离线写的正文', content: '不能丢', updated_at: '2026-10-30 09:00:00', _dirty: true }];
    const cloud = [{ id: 9101, title: '云端已删', content: '', updated_at: '2026-10-30 10:00:00', is_deleted: true }];

    const result = processApiSyncResult(local, cloud, false, 'notes');
    assert.equal(result.conflicts, 1);
    assert.equal(result.needsUpload, false);
    assert.equal(result.merged.find((item) => item.id === 9101).content, '不能丢');
    assert.equal(getSyncConflicts()[0].cloud.is_deleted, true);
    localStorage.clear();
});

test('Sync - mergeDataLists protectKeys keeps the local version instead of silently replacing it', () => {
    const local = [{ id: 7, title: '本地草稿', updated_at: '2026-10-30 09:00:00', _dirty: true }];
    const cloud = [{ id: 7, title: '云端新版', updated_at: '2026-10-30 10:00:00' }];
    const merged = mergeDataLists(local, cloud, { protectKeys: new Set(['7']) });
    assert.equal(merged.find((item) => item.id === 7).title, '本地草稿');
});

test('Sync - clearPushedDirtyFlags preserves _dirty if modified in-flight during sync', () => {
    // 模拟上传快照：Item 1 和 Item 2 准备上传
    const itemsToPush = [
        { id: 1, title: '未改动的笔记', updated_at: '2026-10-06 14:00:00' },
        { id: 2, title: '网络传输中被改动的笔记', updated_at: '2026-10-06 14:00:00' }
    ];
    const pushedMap = makePushedTimestampMap(itemsToPush);

    // 本地状态：Item 1 保持原样，Item 2 在网络传输这几百毫秒内被用户再次编辑并更新了时间戳
    const localList = [
        { id: 1, title: '未改动的笔记', updated_at: '2026-10-06 14:00:00', _dirty: true },
        { id: 2, title: '用户在传输中修改了正文', updated_at: '2026-10-06 14:00:01', _dirty: true },
        { id: 3, title: '新创建的未推送笔记', updated_at: '2026-10-06 14:00:02', _dirty: true }
    ];

    const changed = clearPushedDirtyFlags(localList, pushedMap);
    assert.equal(changed, true);

    // Item 1 已经成功被服务端接收且本地未变动，脏标记被清除
    assert.equal(localList[0]._dirty, false);
    // Item 2 在传输中有更新的时间戳产生，脏标记必须安全保留，待下次同步推送最新版本
    assert.equal(localList[1]._dirty, true, 'in-flight newer modification must preserve _dirty=true');
    // Item 3 根本没有包含在上次推送中，脏标记必须保留
    assert.equal(localList[2]._dirty, true);
});

const { ensureLocalId, selectDirtyItems } = await import('../public/js/utils.js');

test('Sync - dirty selection stamps missing ids instead of silently dropping them', () => {
    const list = [
        { id: 1, _dirty: true },
        { title: '无 id 的本地新记录', _dirty: true },
        { id: 3, _dirty: false },
        { id: 4, _dirty: true }
    ];

    const picked = selectDirtyItems(list, new Set(['4']));

    assert.equal(picked.length, 2, 'only dirty, non-tombstoned items are pushed');
    assert.ok(Number.isSafeInteger(picked[1].id) && picked[1].id > 0, 'missing id is stamped');
    assert.equal(list[1].id, picked[1].id, 'the stamped id is written back to the original item');
    assert.ok(!picked.some((i) => i.id === 4), 'tombstoned item is excluded');
});

test('Sync - ensureLocalId keeps existing ids stable and never reuses one', () => {
    const kept = ensureLocalId({ id: 42 });
    assert.equal(kept.id, 42);

    const first = ensureLocalId({});
    const second = ensureLocalId({});
    assert.ok(Number.isSafeInteger(first.id) && first.id > 0);
    assert.notEqual(first.id, second.id, 'two id-less items must not collide');
});

const { idbSet, idbGet, idbGetBatch, getStorageEstimate } = await import('../public/js/db.js');

test('IDB - fallback to localStorage and batch reads', async () => {
    await idbSet('test_key_1', [{ id: 1, title: 'Item 1' }]);
    await idbSet('test_key_2', [{ id: 2, title: 'Item 2' }]);

    const single = await idbGet('test_key_1');
    assert.deepEqual(single, [{ id: 1, title: 'Item 1' }]);

    const batch = await idbGetBatch(['test_key_1', 'test_key_2', 'non_existent']);
    assert.deepEqual(batch['test_key_1'], [{ id: 1, title: 'Item 1' }]);
    assert.deepEqual(batch['test_key_2'], [{ id: 2, title: 'Item 2' }]);
    assert.equal(batch['non_existent'], null);

    // Entity Unification: state.weeklies and backward-compatible state.database getter/setter
    const { state } = await import('../public/js/state.js');
    assert.ok(Array.isArray(state.weeklies), 'state.weeklies should be an array');
    assert.equal(state.database, state.weeklies, 'state.database should return state.weeklies');
    const sample = [{ id: 8001, title: '周记测试' }];
    state.database = sample;
    assert.deepEqual(state.weeklies, sample, 'Setting state.database should update state.weeklies');
    state.weeklies = [{ id: 8002, title: '周记测试2' }];
    assert.deepEqual(state.database, state.weeklies, 'state.database should reflect state.weeklies');

    // Entity Unification: ui.currentWeeklyId and backward-compatible ui.currentArticleId getter/setter
    const { ui } = await import('../public/js/ui.js');
    ui.currentWeeklyId = 123;
    assert.equal(ui.currentArticleId, 123, 'ui.currentArticleId getter should return currentWeeklyId');
    ui.currentArticleId = 456;
    assert.equal(ui.currentWeeklyId, 456, 'ui.currentArticleId setter should update currentWeeklyId');
    assert.equal(ui.currentArticleId, 456);

    // Entity Unification: hydrateFromIndexedDb migrates legacy gardenData to gardenWeeklies
    const { hydrateFromIndexedDb, saveDatabase } = await import('../public/js/sync.js');
    const { idbDel } = await import('../public/js/db.js');
    const { getLocalKey } = await import('../public/js/auth.js');
    const weekliesKey = getLocalKey('gardenWeeklies');
    const dataKey = getLocalKey('gardenData');

    const legacyWeeklyData = [{ id: 9901, title: '历史周记存档', date: '2026-11-18' }];
    await idbDel(weekliesKey);
    await idbSet(dataKey, legacyWeeklyData);
    state.weeklies = [];

    await hydrateFromIndexedDb();

    const found = state.weeklies.find(w => w.id === 9901);
    assert.ok(found, 'state.weeklies should contain legacy data');
    assert.equal(found.title, '历史周记存档');

    const migrated = await idbGet(weekliesKey);
    assert.ok(Array.isArray(migrated), 'gardenWeeklies should be populated');
    assert.equal(migrated.find(w => w.id === 9901)?.title, '历史周记存档');

    state.weeklies.push({ id: 9902, title: '新周记' });
    saveDatabase();
    const updated = await idbGet(weekliesKey);
    assert.equal(updated.find(w => w.id === 9902)?.title, '新周记');

    // 验证高性能变更检测 hasResourceListChanged（取代全量 JSON.stringify）
    const { hasResourceListChanged } = await import('../public/js/sync.js');
    assert.equal(hasResourceListChanged([{ id: 1, updated_at: 't1' }], [{ id: 1, updated_at: 't1' }]), false);
    assert.equal(hasResourceListChanged([{ id: 1, updated_at: 't1' }], [{ id: 1, updated_at: 't2' }]), true);
    assert.equal(hasResourceListChanged([{ id: 1, updated_at: 't1' }], [{ id: 1, updated_at: 't1' }, { id: 2, updated_at: 't2' }]), true);
    assert.equal(hasResourceListChanged([{ id: 1, updated_at: 't1', _dirty: false }], [{ id: 1, updated_at: 't1', _dirty: true }]), true);

    await idbDel(dataKey);
    await idbDel(weekliesKey);
});

test('IDB - QuotaExceeded fallback saves slice snapshot without throwing', async () => {
    const originalSetItem = globalThis.localStorage.setItem;
    let thrownOnce = false;
    globalThis.localStorage.setItem = (k, v) => {
        if (!thrownOnce && k === 'quota_key') {
            thrownOnce = true;
            const err = new Error('Quota exceeded');
            err.name = 'QuotaExceededError';
            throw err;
        }
        return originalSetItem(k, v);
    };

    const bigArray = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, content: 'data' }));
    await idbSet('quota_key', bigArray);

    const cached = JSON.parse(globalThis.localStorage.getItem('quota_key'));
    assert.equal(cached.length, 30, 'should gracefully degrade to 30 items in localStorage');
    globalThis.localStorage.setItem = originalSetItem;
});

test('Storage - getStorageEstimate provides formatted stats and persist status', async () => {
    const est = await getStorageEstimate();
    assert.ok(typeof est.usageBytes === 'number');
    assert.ok(typeof est.usageFormatted === 'string');
    assert.ok(typeof est.percent === 'number');
    assert.equal(typeof est.isPersistent, 'boolean');
});

const { MOODS, getEligibleMemories, getSparkEffectiveDate, getTodayKey, computeDailyIndex, DAY_ROLLOVER_OFFSET_MS } = await import('../public/js/daily-spark.js');

test('Daily Spark - MOODS definitions are complete and structured', () => {
    assert.equal(MOODS.length, 5);
    const ids = MOODS.map(m => m.id);
    assert.deepEqual(ids, ['energy', 'calm', 'focus', 'tired', 'inspired']);
    for (const m of MOODS) {
        assert.ok(m.emoji && m.label && m.desc);
    }
});

test('Daily Spark - getEligibleMemories filters memories older than threshold', async () => {
    const { state } = await import('../public/js/state.js');
    const oldDate = new Date(Date.now() - 5 * 86400 * 1000).toISOString();
    state.notesDatabase = [
        { id: 999, title: '5天前的深思', content: '关于生活的节奏', date: oldDate, is_deleted: 0 }
    ];
    state.feedsDatabase = [
        { id: 888, content: 'https://www.bilibili.com/video/BV1xx411c7mD', created_at: oldDate, is_deleted: 0 },
        { id: 777, content: '今天在海边散步，看到夕阳把云朵染成了粉紫色，非常治愈。', created_at: oldDate, is_deleted: 0 }
    ];
    const memories = getEligibleMemories();
    const noteMem = memories.find(m => m.id === 999);
    assert.ok(noteMem);
    assert.equal(noteMem.typeName, '笔记');

    const podcastFeed = memories.find(m => m.id === 888);
    assert.ok(podcastFeed);
    // 应该智能识别为平台标签，而不是截断成残缺的 URL 前缀
    assert.equal(podcastFeed.title, '📺 Bilibili 视频');
    assert.notEqual(podcastFeed.title, 'https://www.bilibili.com');

    const textFeed = memories.find(m => m.id === 777);
    assert.ok(textFeed);
    // 普通长文随手记不应被截断24字当作伪标题导致重复
    assert.equal(textFeed.title, '');
});

test('Daily Spark - 04:00 AM day rollover shifts late-night entries into previous evening', () => {
    assert.equal(DAY_ROLLOVER_OFFSET_MS, 4 * 60 * 60 * 1000);

    // 凌晨 02:30 (依然归属前一天)
    const lateNightTime = new Date('2026-10-06T02:30:00');
    assert.equal(getTodayKey(lateNightTime), '2026-10-05');

    // 凌晨 03:59:59 (依然归属前一天)
    const almostFourAm = new Date('2026-10-06T03:59:59');
    assert.equal(getTodayKey(almostFourAm), '2026-10-05');

    // 凌晨 04:00:00 (正式跨入新的一天)
    const exactlyFourAm = new Date('2026-10-06T04:00:00');
    assert.equal(getTodayKey(exactlyFourAm), '2026-10-06');

    // 白天 14:00:00 (归属当天)
    const afternoonTime = new Date('2026-10-06T14:00:00');
    assert.equal(getTodayKey(afternoonTime), '2026-10-06');

    // 检验索引在 04:00 发生轮换
    const prevIdx = computeDailyIndex(almostFourAm);
    const newIdx = computeDailyIndex(exactlyFourAm);
    assert.equal((prevIdx + 1) % 36, newIdx);
});

test('Sync - filterRealGuestItems filters unedited mock placeholders and preserves edited or new items', async () => {
    const { filterRealGuestItems } = await import('../public/js/sync.js');
    const guestNotes = [
        { id: 101, title: '下周购物清单', content: '默认占位内容' }, // 未修改模板
        { id: 102, title: '零碎灵感（已编辑）', content: '我的新灵感', _dirty: true }, // 编辑过的模板
        { id: 1760000000000, title: '新建的真实笔记', content: '自己的内容' } // 用户新创建项
    ];

    const filtered = filterRealGuestItems(guestNotes, [101, 102]);
    assert.equal(filtered.length, 2, 'Should keep edited mock item and new item, filtering out unedited mock item');
    assert.equal(filtered.some(i => i.id === 101), false, 'Unedited note 101 should be filtered out');
    assert.equal(filtered.some(i => i.id === 102), true, 'Edited note 102 with _dirty should be preserved');
    assert.equal(filtered.some(i => i.id === 1760000000000), true, 'User created item should be preserved');
});

test('Sync - 本地存档损坏时安全降级为空值（不再让裸 JSON.parse 中断离线同步）', async () => {
    const { readJsonValue } = await import('../public/js/sync.js');
    const originalLocalStorage = globalThis.localStorage;
    globalThis.localStorage = {
        getItem(key) {
            if (key === 'broken') return '{不是合法 JSON';
            if (key === 'ok') return '[{"id":1}]';
            return null;
        }
    };
    try {
        assert.equal(readJsonValue('broken'), null, '损坏的存档必须降级为 null 而不是抛异常');
        assert.equal(readJsonValue('missing'), null, '缺失的 key 必须返回 null');
        assert.deepEqual(readJsonValue('ok'), [{ id: 1 }], '合法存档应正常解析');
    } finally {
        globalThis.localStorage = originalLocalStorage;
    }
});

test('Sync - 离线脏数据具有微状态感知提示样式', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const css = await fs.readFile(path.join(process.cwd(), 'public', 'style.css'), 'utf8');
    assert.match(css, /\.sync-dirty-dot\s*\{/, 'style.css 应定义 .sync-dirty-dot 样式');
    assert.match(css, /var\(--ios-orange\)/, '未同步指示点应使用 --ios-orange 醒目标识');
});

test('Sync Keepalive - W3C 64KB 规范防御：大于 60KB/64KB 自动关闭 keepalive', async () => {
    const { isKeepalivePayloadSafe, KEEPALIVE_MAX_BYTES } = await import('../public/js/sync.js');
    assert.equal(KEEPALIVE_MAX_BYTES, 60 * 1024, '安全阈值应设为 60KB');

    // 1. 小型常规增量 Payload（< 60KB）：保持 keepalive: true 保活
    const smallPayload = JSON.stringify({ notes: [{ id: 1, title: '短笔记', content: '测试内容' }] });
    assert.equal(isKeepalivePayloadSafe(smallPayload), true, '小型增量请求必须允许 keepalive');

    // 2. 超大长笔记 Payload（> 64KB）：强制禁用 keepalive 避免浏览器报 TypeError: Failed to fetch
    const largeContent = 'a'.repeat(66 * 1024);
    const largePayload = JSON.stringify({ notes: [{ id: 2, title: '长笔记', content: largeContent }] });
    assert.equal(isKeepalivePayloadSafe(largePayload), false, '超出 60KB/64KB 必须关闭 keepalive');

    // 3. 空值容错
    assert.equal(isKeepalivePayloadSafe(''), true);
    assert.equal(isKeepalivePayloadSafe(null), true);
});

test('Sync - upgradeLocalMockItems 自动升级修改过的占位模版并清理冲突', async () => {
    const { upgradeLocalMockItems, processApiSyncResult, getSyncConflicts } = await import('../public/js/sync.js');
    const { state } = await import('../public/js/state.js');
    localStorage.clear();

    // 模拟用户将模版周记 id:1 改为了真实周记
    state.weeklies = [{ id: 1, title: '💰 转正', date: '2026年11月16日', _dirty: true }];
    const upgraded = upgradeLocalMockItems();
    assert.equal(upgraded, true, '应当检测并完成升级');
    assert.notEqual(state.weeklies[0].id, 1, '周记 ID 应当升级为全新唯一时间戳');
    assert.ok(state.weeklies[0].id > 1000, 'ID 应当为安全时间戳');
    assert.equal(state.weeklies[0]._dirty, true, '升级后应当保持 _dirty 为 true 以便批量同步上报');

    localStorage.clear();
    // 验证防误判：当云端仍为初始模版时，processApiSyncResult 绝不触发冲突
    const local = [{ id: 1, title: '💰 转正', _dirty: true, updated_at: '2026-11-16 12:00:00' }];
    const cloud = [{ id: 1, title: '2023-W42: 记忆切片', updated_at: '2023-10-22 10:00:00' }];
    const result = processApiSyncResult(local, cloud, false, 'weeklies');
    assert.equal(result.conflicts, 0, '云端初始模版绝不能与用户本地改动判定为冲突');
    assert.equal(result.needsUpload, true, '本地改动应当允许正常上传');
    localStorage.clear();
});

test('Sync - dataUriToBlob converts data URIs to Blobs', async () => {
    const { dataUriToBlob } = await import('../public/js/sync.js');
    const b64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const blob = dataUriToBlob(b64);
    assert.ok(blob);
    assert.equal(blob.type, 'image/png');
    assert.ok(blob.size > 0);

    // Mismatched declared mime vs magic bytes (JPEG magic bytes declared as png) -> should sniff to image/jpeg
    const jpegB64 = 'data:image/png;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
    const sniffedBlob = dataUriToBlob(jpegB64);
    assert.ok(sniffedBlob);
    assert.equal(sniffedBlob.type, 'image/jpeg');

    // Invalid base64 characters or malformed strings should safely return null and not throw
    assert.equal(dataUriToBlob('invalid-uri'), null);
    assert.equal(dataUriToBlob(null), null);
    assert.equal(dataUriToBlob('data:image/png;base64,invalid!!!character'), null);
});

test('Sync - processWeeklyBase64Images extracts Base64 images and replaces with uploaded URLs', async () => {
    const { processWeeklyBase64Images } = await import('../public/js/sync.js');
    const { state } = await import('../public/js/state.js');

    const sampleB64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    // Mock global fetch for /api/upload
    const originalFetch = globalThis.fetch;
    let uploadCallCount = 0;
    globalThis.fetch = async (url, opts) => {
        if (String(url).includes('/api/upload')) {
            uploadCallCount++;
            return new Response(JSON.stringify([{ src: `/api/file/img-${uploadCallCount}?t=token123` }]), {
                status: 201,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return new Response('Not Found', { status: 404 });
    };

    try {
        const weekly = {
            id: 9999,
            title: '💰 转正',
            date: '2026年11月16日',
            cover: sampleB64,
            content: `最近感觉思考的还挺多大脑有点累\n\n![THE WORLD BENEATH MY SUN](${sampleB64})\n\n<img src="${sampleB64}" alt="map" />`,
            weeklyData: {
                life: {
                    image: sampleB64,
                    caption: '古地图插画'
                }
            }
        };

        const modified = await processWeeklyBase64Images(weekly);
        assert.equal(modified, true, 'Base64 图片应被处理并替换');
        assert.ok(!weekly.cover.startsWith('data:image/'), 'Cover 中的 Base64 应已被替换');
        assert.ok(weekly.cover.startsWith('/api/file/'), 'Cover 应为 /api/file/ 地址');
        assert.ok(!weekly.content.includes('data:image/'), 'Content 中的 Base64 应已被替换');
        assert.ok(weekly.content.includes('/api/file/'), 'Content 应引用 /api/file/ 地址');
        assert.ok(!weekly.weeklyData.life.image.startsWith('data:image/'), 'WeeklyData 中的 Base64 应已被替换');

        // Test multiline base64 in content (RFC 2045 line-wrapped base64)
        const multilineB64 = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk\n+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==`;
        const weeklyMultiline = {
            id: 9998,
            title: '多行 Base64 周记',
            content: `![map](${multilineB64})`
        };
        const modified2 = await processWeeklyBase64Images(weeklyMultiline);
        assert.equal(modified2, true);
        assert.ok(!weeklyMultiline.content.includes('data:image/'));
        assert.ok(weeklyMultiline.content.includes('/api/file/'));
        assert.ok(!weeklyMultiline.content.includes('+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), '不应留下未清理的截断 Base64 尾部');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Sync - hydrateFromIndexedDb unconditionally runs upgradeLocalMockItems even with identical lengths', async () => {
    const { hydrateFromIndexedDb, upgradeLocalMockItems } = await import('../public/js/sync.js');
    const { state } = await import('../public/js/state.js');
    const { getLocalKey } = await import('../public/js/auth.js');
    const { idbSet } = await import('../public/js/db.js');

    // 内存中周记为 1 条初始占位
    state.weeklies = [{ id: 1, title: '2023-W42: 记忆切片', date: '2023年10月22日', _dirty: false }];

    // IndexedDB 同样仅有 1 条，但已被用户在本地修改为「💰 转正」
    await idbSet(getLocalKey('gardenWeeklies'), [{ id: 1, title: '💰 转正', date: '2026年11月16日', _dirty: true }]);

    // 执行注水，长度保持为 1（beforeLen === afterLen），验证 upgradeLocalMockItems 仍必须无条件执行
    await hydrateFromIndexedDb();

    assert.equal(state.weeklies.length, 1);
    assert.equal(state.weeklies[0].title, '💰 转正');
    assert.notEqual(state.weeklies[0].id, 1, '即使长度未变，修改过的模版 ID 也必须完成升级为唯一时间戳');
    assert.ok(state.weeklies[0].id > 1000);
    assert.equal(state.weeklies[0]._dirty, true);
});

test('Sync - apiSyncWeekly accepts numeric/string ID and syncs item from state', async () => {
    const { apiSyncWeekly } = await import('../public/js/sync.js');
    const { state } = await import('../public/js/state.js');

    const testId = 888888;
    state.weeklies = [{
        id: testId,
        title: '测试周记',
        category: '🌸',
        summary: '摘要',
        date: '2026年11月16日',
        _dirty: true
    }];

    const originalFetch = globalThis.fetch;
    let batchPushed = false;
    globalThis.fetch = async (url, opts) => {
        if (String(url).includes('/api/sync/batch')) {
            batchPushed = true;
            return new Response(JSON.stringify({
                updated: [{ resource: 'weeklies', id: testId, updated_at: '2026-11-19 12:00:00' }],
                conflicts: []
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
        const res = await apiSyncWeekly(testId);
        assert.ok(batchPushed, '通过 ID 触发应顺利找到对象并向云端推送 batch');
        assert.equal(state.weeklies[0]._dirty, false, '同步成功后 _dirty 应被清理');

        // 测试直接对 mock ID 1 调用 apiSyncWeekly，应完成自愈升级并清理冲突/旧ID
        state.weeklies = [{
            id: 1,
            title: '💰 转正',
            category: '🌸',
            summary: '转正摘要',
            date: '2026年11月16日',
            _dirty: true
        }];
        let pushedWeeklyId = null;
        globalThis.fetch = async (url, opts) => {
            if (String(url).includes('/api/sync/batch')) {
                const body = JSON.parse(opts.body);
                pushedWeeklyId = body.weeklies[0].id;
                return new Response(JSON.stringify({
                    updated: [{ resource: 'weeklies', id: pushedWeeklyId, updated_at: '2026-11-19 12:00:00' }],
                    conflicts: []
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        };
        await apiSyncWeekly(1);
        assert.notEqual(pushedWeeklyId, 1, '推送的 ID 应已自动升级为时间戳 ID');
        assert.ok(pushedWeeklyId > 1000);
        assert.equal(state.weeklies[0]._dirty, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Sync - apiSyncWeekly accepts server ID remapping for mock ID 1', async () => {
    const { apiSyncWeekly } = await import('../public/js/sync.js');
    const { state } = await import('../public/js/state.js');

    const originalFetch = globalThis.fetch;
    const remappedServerId = 1732000000999;

    state.weeklies = [{
        id: 1,
        title: '已编辑转正周记',
        category: '🌸',
        summary: '摘要',
        date: '2026年11月16日',
        _dirty: true
    }];

    globalThis.fetch = async (url, opts) => {
        if (String(url).includes('/api/sync/batch')) {
            // 模拟服务端将 mock ID 1 重映射为新时间戳 ID
            return new Response(JSON.stringify({
                updated: [{ resource: 'weeklies', id: remappedServerId, updated_at: '2026-11-19 12:30:00' }],
                conflicts: []
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
        const item = state.weeklies[0];
        const res = await apiSyncWeekly(item, 'PUT', { force: true });
        assert.ok(res);
        assert.equal(item.id, remappedServerId, '客户端应当接受服务端重分配的 ID');
        assert.equal(item._dirty, false, '成功接收映射后 _dirty 应当为 false');
        assert.equal(item.updated_at, '2026-11-19 12:30:00');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Sync - apiSyncWeekly accepts server ID remapping even with multiple updated items', async () => {
    const { apiSyncWeekly } = await import('../public/js/sync.js');
    const { state } = await import('../public/js/state.js');

    const originalFetch = globalThis.fetch;
    const remappedServerId = 1732000000888;

    state.weeklies = [{
        id: 1,
        title: '多资源返回重映射',
        _dirty: true
    }];

    globalThis.fetch = async (url) => {
        if (String(url).includes('/api/sync/batch')) {
            return new Response(JSON.stringify({
                updated: [
                    { resource: 'notes', id: 101, updated_at: '2026-11-19 10:00:00' },
                    { resource: 'weeklies', id: remappedServerId, updated_at: '2026-11-19 12:35:00' }
                ],
                conflicts: []
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
        const item = state.weeklies[0];
        const res = await apiSyncWeekly(item, 'PUT', { force: true });
        assert.ok(res);
        assert.equal(item.id, remappedServerId);
        assert.equal(item._dirty, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ── 7处混沌缺陷修复回归验证 ──

test('Sync - [P0] loadLocalData does not overwrite full IndexedDB data before hydrateFromIndexedDb', async () => {
    const { state } = await import('../public/js/state.js');
    state.authUser = { id: 1, username: 'testuser' };
    const weekliesKey = getLocalKey('gardenWeeklies');

    const truncated = [
        { id: 1001, title: '周记1', date: '2026-11-01' },
        { id: 1002, title: '周记2', date: '2026-11-02' }
    ];
    localStorage.setItem(weekliesKey, JSON.stringify(truncated));

    let saveCalledDuringLoad = false;
    const origSetItem = localStorage.setItem;
    localStorage.setItem = (k, v) => {
        if (k === weekliesKey) {
            saveCalledDuringLoad = true;
        }
        return origSetItem(k, v);
    };

    try {
        loadLocalData();
        assert.equal(saveCalledDuringLoad, false, 'loadLocalData must NOT synchronously trigger saveDatabase before hydration');
    } finally {
        localStorage.setItem = origSetItem;
    }
});

test('Sync - [P0] getEast8Time has sub-second precision and clears _dirty safely using revisions', async () => {
    const t1 = getEast8Time();
    assert.match(t1, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/, 'getEast8Time should have millisecond precision');

    const item1 = { id: 2001, title: '初版', content: '内容1' };
    stampLocalUpdate(item1);
    assert.equal(item1._rev, 1);
    assert.equal(item1._dirty, true);

    const pushedMap = makePushedTimestampMap([item1]);

    stampLocalUpdate(item1);
    assert.equal(item1._rev, 2);
    assert.equal(item1._dirty, true);

    const changed = clearPushedDirtyFlags([item1], pushedMap);
    assert.equal(item1._dirty, true, 'in-flight secondary modification must keep _dirty=true');
    assert.equal(changed, false);

    const item2 = { id: 2002, title: '未改动', content: '内容2' };
    stampLocalUpdate(item2);
    const pushedMap2 = makePushedTimestampMap([item2]);
    const changed2 = clearPushedDirtyFlags([item2], pushedMap2);
    assert.equal(item2._dirty, false, 'unmodified item should clear _dirty');
    assert.equal(changed2, true);
});

integration('Sync - [P1] /api/sync/batch applies deleted tombstones to database', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    await db.prepare("INSERT INTO notes (id, user_id, title, content, date, is_deleted, created_at, updated_at) VALUES (3001, 1, '待删笔记', '正文', '2026-11-20', 0, datetime('now', '+8 hours'), datetime('now', '+8 hours'))").run();

    const batchBody = {
        weeklies: [],
        notes: [],
        bookmarks: [],
        feeds: [],
        prompts: [],
        deleted: [{ resource: 'notes', id: 3001 }]
    };

    const req = new Request('https://x/api/sync/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batchBody)
    });

    const res = await handleSyncBatch(req, db, 1);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.deleted));
    assert.equal(data.deleted.length, 1);
    assert.equal(data.deleted[0].id, 3001);

    const row = await db.prepare('SELECT is_deleted FROM notes WHERE id = 3001').first();
    assert.equal(row.is_deleted, 1, 'note 3001 must be soft-deleted in database');

    addPendingDeletedItem('notes', 3001);
    assert.ok(getPendingDeletedItems().some(d => d.resource === 'notes' && String(d.id) === '3001'));
    removePendingDeletedItem('notes', 3001);
    assert.ok(!getPendingDeletedItems().some(d => d.resource === 'notes' && String(d.id) === '3001'));
});

test('Sync - [P1] processNoteBase64Images extracts Base64 markdown/html images and replaces with URLs', async () => {
    const originalFetch = globalThis.fetch;
    const testDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    globalThis.fetch = async (url) => {
        if (String(url).includes('/api/upload')) {
            return new Response(JSON.stringify([{ src: 'https://example.com/uploaded-note-img.png' }]), {
                status: 201,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return new Response('{}', { status: 200 });
    };

    try {
        const note = {
            id: 4001,
            title: '带大图的笔记',
            content: `一段文字\n![截图](${testDataUri})\n<img src="${testDataUri}">\n结尾`
        };

        const modified = await processNoteBase64Images(note);
        assert.equal(modified, true);
        assert.ok(!note.content.includes('data:image/png;base64'));
        assert.ok(note.content.includes('https://example.com/uploaded-note-img.png'));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Sync - [P1] Note drafts are isolated by note ID and retain annotations', async () => {
    const { initNotes } = await import('../public/js/notes.js');

    const elMap = new Map();
    const mockElement = (id) => {
        if (!elMap.has(id)) {
            elMap.set(id, {
                id,
                value: '',
                innerText: '',
                style: {},
                dataset: {},
                addEventListener: () => { },
                classList: { add: () => { }, remove: () => { }, toggle: () => { } },
                querySelector: () => null,
                querySelectorAll: () => []
            });
        }
        return elMap.get(id);
    };

    const origGetElementById = globalThis.document.getElementById;
    globalThis.document.getElementById = (id) => mockElement(id);

    try {
        const noteApis = initNotes();
        assert.ok(noteApis.hasUnsavedNoteChanges);
        assert.ok(noteApis.saveNoteDraft);

        const editId = mockElement('edit-note-id');
        const editTitle = mockElement('edit-note-title');
        const editContent = mockElement('edit-note-content');

        editId.value = '101';
        editTitle.value = '笔记101标题';
        editContent.value = '笔记101草稿正文';
        noteApis.saveNoteDraft();

        const draft101Key = getLocalKey('noteDraft_101');
        const draft101Raw = localStorage.getItem(draft101Key);
        assert.ok(draft101Raw, 'draft for 101 must exist under noteDraft_101');
        const draft101 = JSON.parse(draft101Raw);
        assert.equal(draft101.title, '笔记101标题');

        editId.value = '102';
        editTitle.value = '笔记102标题';
        editContent.value = '笔记102正文';
        noteApis.saveNoteDraft();

        const draft101Check = JSON.parse(localStorage.getItem(draft101Key));
        assert.equal(draft101Check.title, '笔记101标题', 'draft 101 must not be trampled by draft 102');
    } finally {
        globalThis.document.getElementById = origGetElementById;
    }
});

integration('Sync - [P2] ON CONFLICT strictly preserves existing user_id and blocks ownership hijack', async () => {
    const db = createTestDb();
    await seedUser(db, 1, 'alice');
    await seedUser(db, 2, 'bob');

    await db.prepare("INSERT INTO notes (id, user_id, title, content, date, is_deleted, created_at, updated_at) VALUES (6001, 1, 'Alice 私密笔记', '机密正文', '2026-11-20', 0, datetime('now', '+8 hours'), datetime('now', '+8 hours'))").run();

    const hijackReq = new Request('https://x/api/sync/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            weeklies: [],
            notes: [{ id: 6001, title: '被 Bob 篡改后的标题', content: '篡改内容', date: '2026-11-20' }],
            bookmarks: [],
            feeds: [],
            prompts: []
        })
    });

    await handleSyncBatch(hijackReq, db, 2);

    const row = await db.prepare('SELECT user_id, title FROM notes WHERE id = 6001').first();
    assert.equal(row.user_id, 1, 'Ownership must NOT be hijacked to user 2');
    assert.equal(row.title, 'Alice 私密笔记', 'Content must NOT be overwritten by another user');
});

integration('Sync - [P2] Repeated push with identical content does not report false conflict', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    await db.prepare("INSERT INTO notes (id, user_id, title, content, date, is_deleted, created_at, updated_at) VALUES (7001, 1, '已写入笔记', '正文完全一致', '2026-11-20', 0, datetime('now', '+8 hours'), '2026-11-20 12:30:00')").run();

    const retryReq = new Request('https://x/api/sync/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            weeklies: [],
            notes: [{
                id: 7001,
                title: '已写入笔记',
                content: '正文完全一致',
                date: '2026-11-20',
                base_updated_at: '2026-11-20 12:00:00'
            }],
            bookmarks: [],
            feeds: [],
            prompts: []
        })
    });

    const res = await handleSyncBatch(retryReq, db, 1);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.conflicts.length, 0, 'Must NOT trigger false conflict on idempotent retry');
    assert.ok(data.updated.some(u => u.resource === 'notes' && u.id === 7001), 'Item should be acknowledged in updated list');
});

test('Sync - Router Guard intercepts view-note-editor on goBackOrHome and popstate', async () => {
    const fs = await import('fs');
    const routerSource = fs.readFileSync('public/js/router.js', 'utf8');

    assert.match(
        routerSource,
        /activeView\.id\s*===\s*['"]view-note-editor['"][\s\S]*?actions\.handleExitNoteEditor/,
        'goBackOrHome must delegate to actions.handleExitNoteEditor when activeView is view-note-editor'
    );

    assert.match(
        routerSource,
        /activeView\.id\s*===\s*['"]view-note-editor['"][\s\S]*?hasUnsavedNoteChanges/,
        'popstate must check hasUnsavedNoteChanges for view-note-editor and restore hash on cancel'
    );
});

test('Sync - 云端已复活数据自动清除本地旧墓碑并顺利合入（不再被旧软删除记录死锁）', async () => {
    const { processApiSyncResult, mergeDataLists, addDeletedId } = await import('../public/js/sync.js');

    const testId = 1795232163161557;
    // 模拟手机端之前拉取过云端软删除墓碑，本地记录了 deletedId
    addDeletedId(testId);

    const apiData = [{
        id: testId,
        title: '💰 转正',
        category: '🌸',
        summary: '摘要',
        content: '正文内容',
        is_deleted: 0,
        updated_at: '2026-11-23 10:31:19'
    }];

    const { merged } = processApiSyncResult([], apiData, true, 'weeklies');
    assert.equal(merged.length, 1, '云端存活数据必须合入');
    assert.equal(merged[0].id, testId);
    assert.equal(merged[0].title, '💰 转正');
});

test('Sync - [P1 对抗性测试] 跨资源同 ID 墓碑隔离：删除随手记 ID 12 绝不影响周记/笔记同 ID 12 的合并与同步', async () => {
    const {
        addDeletedId,
        removeDeletedId,
        isTombstoned,
        mergeDataLists,
        processApiSyncResult,
    } = await import('../public/js/sync.js');

    localStorage.clear();
    const targetId = 12;

    // 1. 用户删除了随手记 (feeds) 中的第 12 条记录
    addDeletedId(targetId, 'feeds');

    // 验证墓碑状态：feeds 处于墓碑中，而 weeklies 和 notes 绝不能被判定为墓碑
    assert.equal(isTombstoned(targetId, 'feeds'), true, '随手记 12 必须处于已删除墓碑状态');
    assert.equal(isTombstoned(targetId, 'weeklies'), false, '周记 12 绝不能被随手记墓碑污染');
    assert.equal(isTombstoned(targetId, 'notes'), false, '笔记 12 绝不能被随手记墓碑污染');
    assert.equal(isTombstoned(targetId, 'bookmarks'), false, '收藏 12 绝不能被随手记墓碑污染');
    assert.equal(isTombstoned(targetId, 'prompts'), false, '提示词 12 绝不能被随手记墓碑污染');

    // 2. 本地与云端分别存在 feeds(12), weeklies(12), notes(12)
    const localFeeds = [{ id: 12, content: '随手记内容 12', updated_at: '2026-11-24 10:00:00' }];
    const cloudFeeds = [{ id: 12, content: '随手记云端 12', updated_at: '2026-11-24 09:00:00' }];

    const localWeeklies = [{ id: 12, title: '周记标题 12', content: '周记正文 12', updated_at: '2026-11-24 10:00:00' }];
    const cloudWeeklies = [{ id: 12, title: '周记云端 12', content: '周记云端正文 12', updated_at: '2026-11-24 09:00:00' }];

    const localNotes = [{ id: 12, title: '笔记标题 12', content: '笔记正文 12', updated_at: '2026-11-24 10:00:00' }];
    const cloudNotes = [{ id: 12, title: '笔记云端 12', content: '笔记云端正文 12', updated_at: '2026-11-24 09:00:00' }];

    // 3. 执行 mergeDataLists
    const mergedFeeds = mergeDataLists(localFeeds, cloudFeeds, { resource: 'feeds' });
    const mergedWeeklies = mergeDataLists(localWeeklies, cloudWeeklies, { resource: 'weeklies' });
    const mergedNotes = mergeDataLists(localNotes, cloudNotes, { resource: 'notes' });

    // feeds 应该被墓碑过滤（已删除）
    assert.equal(mergedFeeds.length, 0, '随手记 12 已删除，merge 后必须为空');

    // weeklies 和 notes 拥有完全相同的 ID 12，但必须完整保留！
    assert.equal(mergedWeeklies.length, 1, '周记 12 绝不能被删除');
    assert.equal(mergedWeeklies[0].id, 12);
    assert.equal(mergedWeeklies[0].title, '周记标题 12');

    assert.equal(mergedNotes.length, 1, '笔记 12 绝不能被删除');
    assert.equal(mergedNotes[0].id, 12);
    assert.equal(mergedNotes[0].title, '笔记标题 12');

    // 4. 执行 processApiSyncResult：模拟增量下拉
    const syncResWeeklies = processApiSyncResult(localWeeklies, cloudWeeklies, true, 'weeklies');
    assert.equal(syncResWeeklies.merged.length, 1, '增量同步周记时，ID 12 不能被丢弃');
    assert.equal(syncResWeeklies.merged[0].id, 12);

    const syncResNotes = processApiSyncResult(localNotes, cloudNotes, true, 'notes');
    assert.equal(syncResNotes.merged.length, 1, '增量同步笔记时，ID 12 不能被丢弃');
    assert.equal(syncResNotes.merged[0].id, 12);

    // 5. 测试 removeDeletedId 针对性清除
    removeDeletedId(targetId, 'feeds');
    assert.equal(isTombstoned(targetId, 'feeds'), false, '清除 feeds 墓碑后应该不再处于墓碑状态');

    localStorage.clear();
});




