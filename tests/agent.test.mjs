import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AGENT_TOOLS,
    getAgentToolDefs,
    validateToolArgs,
    executeAgentTool
} from '../workers/src/ai-tools.js';
import { runAgent } from '../workers/src/ai-runtime.js';
import { needsRecordEvidence } from '../workers/src/ai.js';
import { createTestDb, seedUser, sqliteTest } from './fake-d1.mjs';

function toolCall(name, args, id = 'call_1') {
    return {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args || {}) }
    };
}

test('Agent tools - 注册表只暴露只读工具，Function Calling 定义不含执行句柄', () => {
    assert.equal(AGENT_TOOLS.length, 4);
    assert.ok(AGENT_TOOLS.every((tool) => tool.risk === 'read'));
    const defs = getAgentToolDefs();
    assert.equal(defs.length, 4);
    assert.ok(defs.every((item) => item.type === 'function' && item.function.name));
    assert.ok(defs.every((item) => !Object.prototype.hasOwnProperty.call(item.function, 'handler')));
    assert.deepEqual(defs.map((item) => item.function.name).sort(), [
        'get_garden_overview',
        'get_note',
        'list_recent_notes',
        'search_notes'
    ]);
});

test('Agent tools - 参数校验拒绝未知字段、缺必填、类型错误与越界', () => {
    const search = AGENT_TOOLS.find((tool) => tool.name === 'search_notes');
    const recent = AGENT_TOOLS.find((tool) => tool.name === 'list_recent_notes');

    assert.match(validateToolArgs(search, {}), /缺少参数：query/);
    assert.match(validateToolArgs(search, { query: 'AI', extra: 1 }), /未知参数/);
    assert.match(validateToolArgs(search, { query: 123 }), /必须是字符串/);
    assert.match(validateToolArgs(recent, { limit: 21 }), /超过最大值/);
    assert.match(validateToolArgs(recent, { types: ['不存在'] }), /不在允许范围/);
    assert.equal(validateToolArgs(search, { query: 'AI', days: 30, limit: 5 }), '');
});

test('Agent tools - 网关拒绝未注册工具、写工具与非法参数，不触碰数据库', async () => {
    const unknown = await executeAgentTool(null, 1, 'delete_everything', {});
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, 'UNKNOWN_TOOL');

    const forbidden = await executeAgentTool(null, 1, 'get_garden_overview', { extra: true });
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.error.code, 'INVALID_ARGUMENTS');

    const badJson = await executeAgentTool(null, 1, 'search_notes', '{bad');
    assert.equal(badJson.ok, false);
    assert.equal(badJson.error.code, 'INVALID_ARGUMENTS');
});

test('Agent 入口 - 记录类问题会要求真实证据，通用问题不误伤', () => {
    assert.equal(needsRecordEvidence('找出我最近记录的三个主要主题'), true);
    assert.equal(needsRecordEvidence('我收藏了什么'), true);
    assert.equal(needsRecordEvidence('我之前写了什么'), true);
    assert.equal(needsRecordEvidence('什么是复利'), false);
    assert.equal(needsRecordEvidence('帮我总结一下这篇文章'), false);
});

test('Agent runtime - 模型选工具、拿回真实引用后再组织回答', async () => {
    const events = [];
    let call = 0;
    const callModel = async (env, messages, tools) => {
        assert.equal(tools.length, 4, '每轮都要把只读工具定义交给模型');
        call += 1;
        if (call === 1) {
            return {
                role: 'assistant',
                content: '',
                tool_calls: [toolCall('list_recent_notes', { days: 30, limit: 5 })]
            };
        }
        return {
            role: 'assistant',
            content: '你最近主要在想 AI 工具和写作节奏。[笔记#1] [笔记#2] [笔记#999]'
        };
    };
    const executeTool = async (db, userId, name, args) => ({
        ok: true,
        tool: name,
        data: {
            items: [
                { type: '笔记', id: 1, title: 'AI 工具', date: '2026-10-20', excerpt: '想做一个工具' },
                { type: '笔记', id: 2, title: '写作节奏', date: '2026-10-21', excerpt: '最近写得慢' }
            ],
            count: 2
        },
        citations: [
            { type: '笔记', id: 1, title: 'AI 工具', date: '2026-10-20', snippet: '想做一个工具' },
            { type: '笔记', id: 2, title: '写作节奏', date: '2026-10-21', snippet: '最近写得慢' }
        ],
        truncated: false,
        duration_ms: 3
    });

    const result = await runAgent({
        env: {}, db: null, userId: 1,
        question: '找出我最近记录的三个主要主题',
        callModel, executeTool,
        onEvent: (event) => events.push(event)
    });

    assert.equal(result.stopReason, 'final');
    assert.equal(result.steps, 2);
    assert.equal(result.toolCalls, 1);
    assert.equal(result.toolTrace.length, 1);
    assert.equal(result.toolTrace[0].name, 'list_recent_notes');
    assert.equal(result.toolTrace[0].count, 2);
    assert.equal(events.length, 1);
    assert.deepEqual(result.sources.map((item) => item.type + '#' + item.id), ['笔记#1', '笔记#2']);
    assert.match(result.reply, /\[笔记#1\]/);
    assert.match(result.reply, /\[笔记#2\]/);
    assert.doesNotMatch(result.reply, /\[笔记#999\]/);
    assert.deepEqual(result.invalidCitations, ['[笔记#999]']);
});

test('Agent runtime - 完全重复的工具调用会停止并进入收口，不会无限循环', async () => {
    let calls = 0;
    const callModel = async (env, messages, tools) => {
        calls += 1;
        if (tools.length === 0) return { role: 'assistant', content: '我已经停止重复检索，先基于现有记录回答。' };
        return {
            role: 'assistant',
            content: '',
            tool_calls: [toolCall('get_garden_overview', {}, 'repeat')]
        };
    };
    const executeTool = async (db, userId, name) => ({
        ok: true,
        tool: name,
        data: { total: 3, types: [] },
        citations: [],
        truncated: false
    });

    const result = await runAgent({
        env: {}, db: null, userId: 1,
        question: '看看我的花园',
        callModel, executeTool
    });

    assert.equal(result.stopReason, 'repeated_tool');
    assert.equal(result.toolCalls, 2, '第三次相同调用不再执行');
    assert.equal(result.toolTrace.length, 3);
    assert.equal(result.toolTrace[2].ok, false);
    assert.equal(result.toolTrace[2].error, 'REPEATED_CALL');
    assert.match(result.reply, /停止重复检索/);
    assert.equal(calls, 4, '两次执行 + 第三次被拦 + 一次收口');
});

test('Agent runtime - 模型异常时返回 model_error，交给上层 RAG 降级', async () => {
    const result = await runAgent({
        env: {}, db: null, userId: 1,
        question: '最近在想什么',
        callModel: async () => { throw new Error('upstream down'); }
    });
    assert.equal(result.stopReason, 'model_error');
    assert.equal(result.reply, '');
    assert.equal(result.toolCalls, 0);
});

test('Agent runtime - 模型调用超时按 model_error 收口，等待上层 RAG 降级', async () => {
    const result = await runAgent({
        env: {}, db: null, userId: 1,
        question: '最近在想什么',
        callModel: () => new Promise(() => {}),
        modelTimeoutMs: 10,
        deadlineMs: 1000
    });
    assert.equal(result.stopReason, 'model_error');
    assert.equal(result.reply, '');
    assert.equal(result.toolCalls, 0);
});

test('Agent runtime - 不需要工具时不伪造来源', async () => {
    const result = await runAgent({
        env: {}, db: null, userId: 1,
        question: '什么是复利',
        callModel: async () => ({ role: 'assistant', content: '复利是利息继续产生利息。' })
    });
    assert.equal(result.stopReason, 'final');
    assert.equal(result.sources.length, 0);
    assert.equal(result.citationCount, 0);
    assert.match(result.reply, /复利/);
});

const integration = sqliteTest;

integration('Agent tools - 只读检索按用户隔离、带引用，list 支持最近时间窗', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedUser(db, 2);

    await db.prepare(`INSERT INTO notes (id, user_id, title, content, date, created_at, updated_at, is_deleted)
        VALUES (1, 1, 'AI 工具', '想做一个能调用工具的记忆助手', date('now', '+8 hours'), datetime('now', '+8 hours'), datetime('now', '+8 hours'), 0)`).run();
    await db.prepare(`INSERT INTO notes (id, user_id, title, content, date, created_at, updated_at, is_deleted)
        VALUES (2, 1, '旧笔记', '2020 年的旧记录，不该进入最近 30 天', '2020-01-01', '2020-01-01 12:00:00', '2020-01-01 12:00:00', 0)`).run();
    await db.prepare(`INSERT INTO notes (id, user_id, title, content, date, created_at, updated_at, is_deleted)
        VALUES (4, 2, '别人的笔记', '不应被用户 1 看到', date('now', '+8 hours'), datetime('now', '+8 hours'), datetime('now', '+8 hours'), 0)`).run();
    await db.prepare(`INSERT INTO notes (id, user_id, title, content, date, created_at, updated_at, is_deleted)
        VALUES (5, 1, '已删除笔记', '软删记录不该出现在任何工具结果里', date('now', '+8 hours'), datetime('now', '+8 hours'), datetime('now', '+8 hours'), 1)`).run();
    await db.prepare(`INSERT INTO quick_feeds (id, user_id, content, created_at, updated_at, is_deleted)
        VALUES (10, 1, '今天想到：写作需要留白', datetime('now', '+8 hours'), datetime('now', '+8 hours'), 0)`).run();

    const overview = await executeAgentTool(db, 1, 'get_garden_overview', {});
    assert.equal(overview.ok, true);
    assert.equal(overview.data.total, 3, '用户 1 只有两条笔记 + 一条随手记');
    assert.equal(overview.data.types.find((item) => item.type === '笔记').count, 2);

    const recent = await executeAgentTool(db, 1, 'list_recent_notes', { days: 30, limit: 10 });
    assert.equal(recent.ok, true);
    assert.ok(recent.citations.some((item) => item.type === '笔记' && item.id === 1));
    assert.ok(recent.citations.some((item) => item.type === '随手记' && item.id === 10));
    assert.ok(recent.citations.every((item) => item.snippet), '列表工具必须带回可展示的引用摘要');
    assert.ok(!recent.citations.some((item) => item.type === '笔记' && item.id === 2), '旧笔记应被时间窗排除');
    assert.ok(!recent.citations.some((item) => item.type === '笔记' && item.id === 4), '不能读到其他用户');
    assert.ok(!recent.citations.some((item) => item.type === '笔记' && item.id === 5), '软删记录必须被过滤');

    const search = await executeAgentTool(db, 1, 'search_notes', { query: 'AI', limit: 10 });
    assert.equal(search.ok, true);
    assert.ok(search.citations.some((item) => item.type === '笔记' && item.id === 1));
    assert.ok(search.citations.every((item) => item.snippet), '搜索工具必须带回可展示的引用摘要');
    assert.ok(!search.citations.some((item) => item.type === '笔记' && item.id === 2), '关键词必须命中');
    assert.ok(!search.citations.some((item) => item.type === '笔记' && item.id === 5), '搜索也不能命中软删记录');

    const note = await executeAgentTool(db, 1, 'get_note', { type: '笔记', id: 1 });
    assert.equal(note.ok, true);
    assert.equal(note.data.found, true);
    assert.match(note.data.item.body, /记忆助手/);
    assert.match(note.data.item.citation, /\[笔记#1\]/);

    const other = await executeAgentTool(db, 1, 'get_note', { type: '笔记', id: 4 });
    assert.equal(other.ok, true);
    assert.equal(other.data.found, false, '跨用户读取必须返回未找到');

    const deleted = await executeAgentTool(db, 1, 'get_note', { type: '笔记', id: 5 });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.data.found, false, '软删记录不能按 id 直读');
});
