import test from 'node:test';
import assert from 'node:assert/strict';

// Node.js test environment mock for browser globals
if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
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
if (typeof globalThis.location === 'undefined') {
    globalThis.location = { hostname: 'localhost', origin: 'http://localhost', protocol: 'http:' };
}
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {}
    };
}

const { getStage, STAGES, aggregateTopics } = await import('../public/js/evergreen-topics.js');
const { state } = await import('../public/js/state.js');

test('Evergreen Topics - getStage calculates stages based on entry thresholds', () => {
    assert.equal(getStage(1).id, STAGES.BUDDING.id);
    assert.equal(getStage(4).id, STAGES.BUDDING.id);
    assert.equal(getStage(5).id, STAGES.BRANCHING.id);
    assert.equal(getStage(9).id, STAGES.BRANCHING.id);
    assert.equal(getStage(10).id, STAGES.EVERGREEN.id);
    assert.equal(getStage(99).id, STAGES.EVERGREEN.id);
});

test('Evergreen Topics - aggregateTopics aggregates across feeds, notes and weeklies', () => {
    // Setup test state
    state.feedsDatabase = [
        { id: 101, content: '今天探讨了 #认知模型 的核心应用', tags: ['认知模型'], created_at: '2026-10-01 10:00' },
        { id: 102, content: '双重视角思考 #认知模型', tags: [], created_at: '2026-10-02 12:00' }
    ];
    state.notesDatabase = [
        { id: 201, title: '查理芒格与 [[认知模型]]', content: '多元思维模型是人生的基础工具箱', date: '2026-10-03 14:00' }
    ];
    state.database = [
        { id: 301, title: '周记：十月第一周思考', content: '本周深入阅读了相关理论', tags: ['认知模型'], date: '2026-10-05 18:00' }
    ];

    const topics = aggregateTopics();
    const topic = topics.find(t => t.name === '认知模型');

    assert.ok(topic, 'Topic "认知模型" should be extracted');
    assert.equal(topic.feeds.length, 2);
    assert.equal(topic.notes.length, 1);
    assert.equal(topic.weeklies.length, 1);
    assert.equal(topic.totalCount, 4);
    assert.equal(topic.stage.id, 'budding');
    assert.ok(topic.characterCount > 50);
    assert.ok(topic.timespanDays >= 1);
});

test('Evergreen Topics - promotes topic to evergreen stage when count >= 10', () => {
    const feeds = [];
    for (let i = 0; i < 11; i++) {
        feeds.push({
            id: 1000 + i,
            content: `记录第 ${i} 条 #投资 思考碎片，关注长期价值`,
            tags: ['投资'],
            created_at: `2026-09-${String(i + 1).padStart(2, '0')} 10:00`
        });
    }
    state.feedsDatabase = feeds;
    state.notesDatabase = [];
    state.database = [];

    const topics = aggregateTopics();
    const topic = topics.find(t => t.name === '投资');

    assert.ok(topic);
    assert.equal(topic.totalCount, 11);
    assert.equal(topic.stage.id, 'evergreen');
    assert.equal(topic.stage.label, '常青');
    assert.equal(topic.stage.icon, '🌳');
});
