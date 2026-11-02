import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createTestDb,
    seedUser,
    sqliteTest
} from './fake-d1.mjs';
import {
    normalizePlan,
    createGoal,
    generatePlan,
    getGoalDetail,
    listGoalSummaries,
    requestSaveDraft,
    decideApproval,
    deleteGoal,
    handleAgentGoalApi
} from '../workers/src/agent-goals.js';
import {
    startGoal,
    continueGoal,
    pauseGoal,
    retryTask,
    runNextTask
} from '../workers/src/agent-executor.js';
import { nextReadyTask, formatGoal } from '../workers/src/agent-store.js';

const TASK_PLAN = JSON.stringify({
    tasks: [
        { title: '收集证据', description: '检索相关记录', depends_on: [] },
        { title: '提炼主线', description: '归并主题', depends_on: [0] },
        { title: '形成行动', description: '给出下一步', depends_on: [1] }
    ]
});

async function makeGoal(db, userId = 1) {
    const snapshot = await createGoal(db, userId, {
        title: '把最近的 AI 笔记整理成提纲',
        description: '只用真实记录，最后给出三条下一步行动'
    });
    return snapshot.goal.id;
}

async function planGoal(db, goalId, modelText = TASK_PLAN) {
    return generatePlan(db, 1, goalId, { planModel: async () => modelText });
}

function okRunner(reply = '任务产出') {
    return async () => ({
        reply,
        sources: [{ type: '笔记', id: 1, title: 'AI 工具', snippet: '想做一个工具' }],
        toolTrace: [{ type: 'tool', name: 'list_recent_notes', ok: true, count: 1 }],
        stopReason: 'final'
    });
}

test('Agent goals - 计划校验只保留前序依赖并限制任务数', () => {
    const plan = normalizePlan({
        tasks: [
            { title: '一', depends_on: [1, 99] },
            { title: '二', depends_on: [0, 0, 99] },
            { title: '', depends_on: [] },
            { title: '三', depends_on: [1] }
        ]
    }, { title: '测试' });
    assert.equal(plan.fallback, false);
    assert.equal(plan.tasks.length, 3);
    assert.deepEqual(plan.tasks[0].depends_on, []);
    assert.deepEqual(plan.tasks[1].depends_on, [0]);
    assert.deepEqual(plan.tasks[2].depends_on, [1]);

    const many = normalizePlan({
        tasks: Array.from({ length: 10 }, (_, i) => ({ title: '任务 ' + i, depends_on: [] }))
    }, { title: '测试' });
    assert.equal(many.tasks.length, 8);

    const fallback = normalizePlan(null, { title: '整理笔记', description: '最近三十天' });
    assert.equal(fallback.fallback, true);
    assert.equal(fallback.tasks.length, 3);
    assert.deepEqual(fallback.tasks[1].depends_on, [0]);
});

test('Agent goals - 任务依赖只在前置任务完成后就绪', () => {
    const tasks = [
        { seq: 0, status: 'pending', depends_on: [] },
        { seq: 1, status: 'pending', depends_on: [0] },
        { seq: 2, status: 'completed', depends_on: [] }
    ];
    assert.equal(nextReadyTask(tasks).seq, 0);
    tasks[0].status = 'completed';
    assert.equal(nextReadyTask(tasks).seq, 1);
    tasks[1].status = 'pending';
    tasks[0].status = 'failed';
    assert.equal(nextReadyTask(tasks), null);
});

test('Agent goals - 目标进度按任务状态汇总', () => {
    const goal = formatGoal({ id: 1, title: 'x', status: 'active' }, [
        { status: 'completed' },
        { status: 'failed' },
        { status: 'pending' }
    ]);
    assert.deepEqual(goal.progress, { total: 3, completed: 1, failed: 1, pending: 1, running: 0 });
});

sqliteTest('Agent goals - 生成计划、逐任务执行、关闭后重开可继续且不重复', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await makeGoal(db);
    const planned = await planGoal(db, goalId);
    assert.equal(planned.goal.status, 'planned');
    assert.equal(planned.tasks.length, 3);
    assert.equal(planned.tasks[1].depends_on[0], 0);

    let snap = await startGoal({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('第一段产出') });
    assert.equal(snap.tasks[0].status, 'completed');
    assert.equal(snap.tasks[1].status, 'pending');
    assert.equal(snap.steps.length, 1);
    assert.equal(snap.goal.status, 'active');

    // 模拟关闭页面后重新读取：第一个任务的结果和步骤仍在，不重复执行
    const reopened = await getGoalDetail(db, 1, goalId);
    assert.equal(reopened.tasks[0].output_md, '第一段产出');
    assert.equal(reopened.steps.length, 1);

    snap = await continueGoal({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('第二段产出') });
    assert.equal(snap.tasks[0].attempts, 0);
    assert.equal(snap.tasks[1].status, 'completed');
    snap = await continueGoal({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('第三段产出') });
    assert.equal(snap.goal.status, 'completed');
    assert.equal(snap.goal.progress.completed, 3);
    assert.match(snap.goal.result_md, /第一段产出/);
    assert.match(snap.goal.result_md, /第三段产出/);
    assert.equal(snap.run.status, 'completed');
});

sqliteTest('Agent goals - 失败重试耗尽后目标失败，重试任务后可恢复', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await createGoal(db, 1, { title: '只做一件事' }).then((s) => s.goal.id);
    await generatePlan(db, 1, goalId, {
        planModel: async () => JSON.stringify({ tasks: [{ title: '唯一任务', description: '执行', depends_on: [] }] })
    });

    const fail = async () => ({ reply: '', stopReason: 'model_error' });
    let snap = await startGoal({ env: {}, db, userId: 1, goalId, agentRunner: fail });
    assert.equal(snap.tasks[0].status, 'pending');
    assert.equal(snap.tasks[0].attempts, 1);
    snap = await continueGoal({ env: {}, db, userId: 1, goalId, agentRunner: fail });
    assert.equal(snap.tasks[0].attempts, 2);
    snap = await continueGoal({ env: {}, db, userId: 1, goalId, agentRunner: fail });
    assert.equal(snap.tasks[0].status, 'failed');
    assert.equal(snap.goal.status, 'failed');
    assert.equal(snap.steps.length, 3);

    snap = await retryTask(db, 1, goalId, snap.tasks[0].id);
    assert.equal(snap.tasks[0].status, 'pending');
    assert.equal(snap.tasks[0].attempts, 0);
    snap = await continueGoal({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('重试成功') });
    assert.equal(snap.goal.status, 'completed');
    assert.match(snap.goal.result_md, /重试成功/);
});

sqliteTest('Agent goals - 暂停后拒绝自动推进，恢复后从断点继续', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await makeGoal(db);
    await planGoal(db, goalId);

    let snap = await startGoal({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('a') });
    snap = await pauseGoal(db, 1, goalId);
    assert.equal(snap.goal.status, 'paused');
    assert.equal(snap.run.status, 'paused');
    await assert.rejects(
        () => runNextTask({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('b') }),
        /已暂停/
    );

    snap = await continueGoal({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('b') });
    assert.equal(snap.tasks[0].status, 'completed');
    assert.equal(snap.tasks[1].status, 'completed');
});

sqliteTest('Agent goals - 保存结果必须审批，同意只写一次，拒绝不写', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await createGoal(db, 1, { title: '保存草稿测试' }).then((s) => s.goal.id);
    await generatePlan(db, 1, goalId, {
        planModel: async () => JSON.stringify({ tasks: [{ title: '完成任务', description: '产出', depends_on: [] }] })
    });
    await startGoal({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('可以保存的正文') });

    const pending = await requestSaveDraft(db, 1, goalId);
    assert.equal(pending.approval.status, 'pending');
    assert.equal(pending.approval.payload.content, '## 完成任务\n\n可以保存的正文');

    const approved = await decideApproval(db, 1, pending.approval.id, { decision: 'approve' });
    assert.equal(approved.approval.status, 'approved');
    assert.ok(approved.approval.result.note_id);
    const note = await db.prepare('SELECT * FROM notes WHERE id = ?1 AND user_id = ?2')
        .bind(approved.approval.result.note_id, 1).first();
    assert.match(note.content, /可以保存的正文/);

    const again = await decideApproval(db, 1, pending.approval.id, { decision: 'approve' });
    assert.equal(again.already_decided, true);
    const count = await db.prepare('SELECT COUNT(*) AS n FROM notes WHERE user_id = 1').first();
    assert.equal(Number(count.n), 1);

    const second = await requestSaveDraft(db, 1, goalId);
    assert.equal(second.approval.id !== pending.approval.id, true);
    const rejected = await decideApproval(db, 1, second.approval.id, { decision: 'reject' });
    assert.equal(rejected.approval.status, 'rejected');
    const countAfter = await db.prepare('SELECT COUNT(*) AS n FROM notes WHERE user_id = 1').first();
    assert.equal(Number(countAfter.n), 1);
});

sqliteTest('Agent goals - 目标按用户隔离，软删后列表不可见', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedUser(db, 2);
    const goalId = await makeGoal(db, 1);
    const other = await listGoalSummaries(db, 2);
    assert.equal(other.length, 0);
    await assert.rejects(() => getGoalDetail(db, 2, goalId), /目标不存在/);
    await assert.rejects(() => requestSaveDraft(db, 2, goalId), /目标不存在/);

    await deleteGoal(db, 1, goalId);
    const mine = await listGoalSummaries(db, 1);
    assert.equal(mine.length, 0);
    await assert.rejects(() => getGoalDetail(db, 1, goalId), /目标不存在/);
});

sqliteTest('Agent goals - HTTP 入口能创建目标并返回列表', async () => {
    const db = createTestDb();
    await seedUser(db, 1);

    const createReq = new Request('https://chillin.test/api/agent/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '接口创建的目标', description: '描述' })
    });
    const created = await handleAgentGoalApi(createReq, {}, new URL(createReq.url), db, 1);
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.goal.title, '接口创建的目标');

    const listReq = new Request('https://chillin.test/api/agent/goals', { method: 'GET' });
    const listed = await handleAgentGoalApi(listReq, {}, new URL(listReq.url), db, 1);
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.equal(listedBody.goals.length, 1);
});
sqliteTest('Agent goals - 并发继续只会认领一次任务，不产生重复步骤', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await createGoal(db, 1, { title: '并发认领' }).then((s) => s.goal.id);
    await generatePlan(db, 1, goalId, {
        planModel: async () => JSON.stringify({ tasks: [{ title: '唯一任务', description: '执行', depends_on: [] }] })
    });
    let calls = 0;
    const runner = async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { reply: '只应执行一次', stopReason: 'final' };
    };
    const results = await Promise.all([
        startGoal({ env: {}, db, userId: 1, goalId, agentRunner: runner }),
        startGoal({ env: {}, db, userId: 1, goalId, agentRunner: runner })
    ]);
    assert.equal(calls, 1);
    const snap = await getGoalDetail(db, 1, goalId);
    assert.equal(snap.goal.status, 'completed');
    assert.equal(snap.steps.length, 1);
    assert.equal(snap.tasks[0].status, 'completed');
    assert.ok(results.length === 2);
});

sqliteTest('Agent goals - 任务执行期间暂停不会被回写为进行中', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await makeGoal(db);
    await planGoal(db, goalId);
    let pausedInside = false;
    const runner = async () => {
        await pauseGoal(db, 1, goalId);
        pausedInside = true;
        return { reply: '暂停期间完成的第一段', stopReason: 'final' };
    };
    let snap = await startGoal({ env: {}, db, userId: 1, goalId, agentRunner: runner });
    assert.equal(pausedInside, true);
    assert.equal(snap.goal.status, 'paused');
    assert.equal(snap.run.status, 'paused');
    assert.equal(snap.tasks[0].status, 'completed');
    assert.equal(snap.tasks[1].status, 'pending');

    snap = await continueGoal({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('第二段') });
    assert.equal(snap.tasks[1].status, 'completed');
});

sqliteTest('Agent goals - 两个并发同意只写一条笔记', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await createGoal(db, 1, { title: '并发审批' }).then((s) => s.goal.id);
    await generatePlan(db, 1, goalId, {
        planModel: async () => JSON.stringify({ tasks: [{ title: '完成任务', description: '产出', depends_on: [] }] })
    });
    await startGoal({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('并发审批正文') });
    const pending = await requestSaveDraft(db, 1, goalId);
    const outcomes = await Promise.all([
        decideApproval(db, 1, pending.approval.id, { decision: 'approve' }),
        decideApproval(db, 1, pending.approval.id, { decision: 'approve' })
    ]);
    const count = await db.prepare('SELECT COUNT(*) AS n FROM notes WHERE user_id = 1').first();
    assert.equal(Number(count.n), 1);
    assert.equal(outcomes.filter((item) => item.approval.status === 'approved').length >= 1, true);
});
