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

const { mergeDataLists, toUpdatedTs } = await import('../public/js/sync.js');

test('Sync - toUpdatedTs converts various date formats accurately', () => {
    const tsIso = toUpdatedTs('2026-09-23T10:00:00+08:00');
    assert.ok(tsIso > 0);

    const tsSql = toUpdatedTs('2026-09-23 10:00:00');
    assert.ok(tsSql > 0);

    const tsInvalid = toUpdatedTs('');
    assert.equal(tsInvalid, 0);
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

