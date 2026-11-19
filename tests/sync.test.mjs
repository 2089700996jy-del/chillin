import test from 'node:test';
import assert from 'node:assert/strict';

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
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => []
    };
}

const { mergeDataLists, toUpdatedTs, getIncrementalSyncCursor, makePushedTimestampMap, clearPushedDirtyFlags, syncSignature, processApiSyncResult, getSyncConflicts } = await import('../public/js/sync.js');

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



