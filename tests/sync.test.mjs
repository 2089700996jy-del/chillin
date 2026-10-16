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

const { mergeDataLists, toUpdatedTs, getIncrementalSyncCursor, makePushedTimestampMap, clearPushedDirtyFlags } = await import('../public/js/sync.js');

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

