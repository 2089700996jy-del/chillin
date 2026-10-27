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

const { countWords, isValidTopic, getItemWordCount, aggregateTopics, openTopicsDirectorySheet, openTopicDetailSheet, parseTopicDateToTs } = await import('../public/js/evergreen-topics.js');
const { state } = await import('../public/js/state.js');

test('Evergreen Topics - countWords accurately counts mixed Chinese characters and English words', () => {
    // Chinese text
    assert.equal(countWords('今天天气真好'), 6);
    // English words
    assert.equal(countWords('Hello world deepseek'), 3);
    // Mixed Chinese + English + Numbers
    assert.equal(countWords('今天测试了 DeepSeek 的 API 接口，耗时 25 毫秒'), 15);
    // Strip HTML and URLs
    assert.equal(countWords('<p>分享链接 https://example.com/test 很棒</p>'), 6);
    // Empty text
    assert.equal(countWords(''), 0);
    assert.equal(countWords(null), 0);
});

test('Evergreen Topics - isValidTopic rejects emojis and system tags', () => {
    assert.equal(isValidTopic('🌸'), false, 'single emoji should be rejected');
    assert.equal(isValidTopic('🌿'), false);
    assert.equal(isValidTopic('随手记'), false, 'catch-all system tag should be rejected');
    assert.equal(isValidTopic('#随手记'), false);
    assert.equal(isValidTopic('未分类'), false);
    assert.equal(isValidTopic('a'), false, 'single char should be rejected');

    assert.equal(isValidTopic('认知模型'), true);
    assert.equal(isValidTopic('#投资哲学'), true);
    assert.equal(isValidTopic('Web3'), true);
});

test('Evergreen Topics - aggregateTopics accurately calculates words across feeds, notes and weeklies', () => {
    state.feedsDatabase = [
        { id: 101, content: '今天阅读了 #认知模型 相关的书籍', tags: ['认知模型'], created_at: '2026-10-01 10:00' },
        { id: 102, content: '关于 #认知模型 的第二点思考', tags: [], created_at: '2026-10-02 12:00' }
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
    assert.ok(topic.wordCount > 40, `wordCount should be > 40, got ${topic.wordCount}`);
    assert.ok(topic.timespanDays >= 1);

    // Ensure system tag "随手记" is not created as a topic
    assert.equal(topics.some(t => t.name === '随手记'), false, '随手记 must not be in topics');
});

test('Evergreen Topics - Directory Sheet & Back navigation lifecycle', () => {
    assert.equal(typeof openTopicsDirectorySheet, 'function');
    assert.equal(typeof openTopicDetailSheet, 'function');

    const modalClasses = new Set();
    const mockModal = {
        classList: {
            add: (c) => modalClasses.add(c),
            remove: (c) => modalClasses.delete(c),
            contains: (c) => modalClasses.has(c)
        }
    };
    const mockSubtitle = { textContent: '' };
    const mockList = { innerHTML: '' };
    const mockSearch = { value: '' };

    const originalGetElementById = globalThis.document.getElementById;
    globalThis.document.getElementById = (id) => {
        if (id === 'topics-directory-modal') return mockModal;
        if (id === 'topics-directory-subtitle') return mockSubtitle;
        if (id === 'topics-directory-list') return mockList;
        if (id === 'topics-directory-search') return mockSearch;
        return null;
    };

    try {
        // Open without filter
        openTopicsDirectorySheet();
        assert.ok(mockModal.classList.contains('show'), 'modal should have show class');
        assert.ok(mockSubtitle.textContent.includes('专栏'), 'subtitle should display topic summary');
        assert.ok(mockList.innerHTML.includes('k-directory-row'), 'list should render directory rows');
        assert.ok(mockList.innerHTML.includes('认知模型'), 'list should include topic name');

        // Open with filter that matches
        openTopicsDirectorySheet('认知');
        assert.ok(mockSubtitle.textContent.includes('找到 1 个专栏'), 'filtered count should be 1');
        assert.ok(mockList.innerHTML.includes('认知模型'));

        // Open with non-matching filter
        openTopicsDirectorySheet('不存在的专栏XYZ');
        assert.ok(mockList.innerHTML.includes('未找到与 “不存在的专栏XYZ” 相关的专栏'));
    } finally {
        globalThis.document.getElementById = originalGetElementById;
    }
});

test('Evergreen Topics - parseTopicDateToTs correctly parses Chinese date formats', () => {
    const ts = parseTopicDateToTs('2023年10月23日');
    assert.equal(isNaN(ts), false, 'Chinese date must not return NaN');
    // 解析结果固定落在东八区零点（2023-10-22T16:00Z）。CI 跑在 UTC，
    // 直接 getDate() 会退回 22 日；先平移到东八区再用 UTC 取值，断言的是「日历日」。
    const d = new Date(ts + 8 * 3600 * 1000);
    assert.equal(d.getUTCFullYear(), 2023);
    assert.equal(d.getUTCMonth(), 9); // October is month 9 (0-indexed)
    assert.equal(d.getUTCDate(), 23);
});

test('Evergreen Topics - aggregateTopics correctly calculates timespanDays with Chinese dates', () => {
    state.feedsDatabase = [];
    state.notesDatabase = [
        { id: 401, title: '早期笔记 [[哲学思考]]', content: '内容一', date: '2023年10月01日' },
        { id: 402, title: '近期笔记 [[哲学思考]]', content: '内容二', date: '2023年10月11日' }
    ];
    state.database = [];

    const topics = aggregateTopics();
    const topic = topics.find(t => t.name === '哲学思考');
    assert.ok(topic, 'Topic "哲学思考" should exist');
    assert.equal(topic.totalCount, 2);
    assert.equal(topic.timespanDays, 10, 'Timespan should be 10 days between Oct 1 and Oct 11');
});

