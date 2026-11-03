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
    requestAppendDraft,
    decideApproval,
    deleteGoal,
    updateGoal,
    cancelGoal,
    handleAgentGoalApi
} from '../workers/src/agent-goals.js';
import {
    startGoal,
    continueGoal,
    pauseGoal,
    retryTask,
    runNextTask
} from '../workers/src/agent-executor.js';
import { maybeRunAgentCommand } from '../workers/src/bot-garden.js';
import { requestAgentProposal } from '../workers/src/agent-approvals.js';
import { checkpointAfterTask } from '../workers/src/agent-checkpoint.js';
import { runWebTool, safePublicUrl, isPrivateOrReservedIp, verifyHostDns } from '../workers/src/agent-web.js';
import { buildBotReply } from '../workers/src/bot-commands.js';
import { nextReadyTask, formatGoal } from '../workers/src/agent-store.js';
import { claimDueAgentRun, runAutoResume } from '../workers/src/agent-scheduler.js';

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

sqliteTest('Agent goals - 后台 cron 在页面关闭后每次只推进一个任务', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await makeGoal(db);
    await planGoal(db, goalId);

    const first = await startGoal({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('第一段产出') });
    assert.equal(first.tasks[0].status, 'completed');
    assert.equal(first.tasks[1].status, 'pending');
    assert.equal(first.run.status, 'queued');

    const queued = await db.prepare('SELECT * FROM agent_runs WHERE goal_id = ?1 ORDER BY id DESC LIMIT 1')
        .bind(goalId).first();
    assert.equal(queued.status, 'queued');
    assert.ok(queued.next_run_at, '任务完成后必须留下后台续跑时间');
    assert.equal(queued.lease_until, null);

    await db.prepare("UPDATE agent_runs SET next_run_at = datetime('now', '+8 hours', '-1 seconds') WHERE id = ?1")
        .bind(queued.id).run();
    const auto = await runAutoResume({ DB: db }, { agentRunner: okRunner('第二段产出') });
    assert.equal(auto.processed, 1);
    let snap = await getGoalDetail(db, 1, goalId);
    assert.equal(snap.tasks[1].status, 'completed');
    assert.equal(snap.tasks[2].status, 'pending');
    assert.equal(snap.run.status, 'queued');
    assert.equal(snap.run.trigger, 'auto');

    await db.prepare("UPDATE agent_runs SET next_run_at = datetime('now', '+8 hours', '-1 seconds') WHERE id = ?1")
        .bind(queued.id).run();
    await runAutoResume({ DB: db }, { agentRunner: okRunner('第三段产出') });
    snap = await getGoalDetail(db, 1, goalId);
    assert.equal(snap.goal.status, 'completed');
    assert.equal(snap.run.status, 'completed');
    assert.equal(snap.steps.length, 3);
});

sqliteTest('Agent goals - 后台认领带租约，暂停的目标不会被 cron 抢跑', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await makeGoal(db);
    await planGoal(db, goalId);
    await startGoal({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('第一段') });

    await db.prepare("UPDATE agent_runs SET next_run_at = datetime('now', '+8 hours', '-1 seconds') WHERE goal_id = ?1")
        .bind(goalId).run();
    const claimed = await claimDueAgentRun(db);
    assert.ok(claimed, '到期的 queued run 应被认领');
    assert.equal(claimed.status, 'running');
    assert.ok(claimed.lease_until, '认领后必须持有租约');
    assert.equal(await claimDueAgentRun(db), null, '同一时刻不能重复认领');

    await pauseGoal(db, 1, goalId);
    await db.prepare("UPDATE agent_runs SET lease_until = datetime('now', '+8 hours', '-1 seconds') WHERE id = ?1")
        .bind(claimed.id).run();
    assert.equal(await claimDueAgentRun(db), null, '暂停的目标即使租约过期也不能被后台带走');
});

sqliteTest('Agent goals - 租约过期后的运行会被下一分钟回收，不重复步骤', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await makeGoal(db);
    await planGoal(db, goalId);
    let snap = await startGoal({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('第一段') });
    const second = snap.tasks[1];
    const run = await db.prepare('SELECT * FROM agent_runs WHERE goal_id = ?1 ORDER BY id DESC LIMIT 1')
        .bind(goalId).first();

    // 模拟第二个任务开始后进程崩溃：任务停在 running，租约已经过期。
    await db.prepare(
        "UPDATE agent_tasks SET status = 'running', started_at = datetime('now', '+8 hours', '-5 minutes'), updated_at = datetime('now', '+8 hours', '-5 minutes') WHERE id = ?1"
    ).bind(second.id).run();
    await db.prepare(
        "UPDATE agent_runs SET status = 'running', current_task_id = ?1, lease_until = datetime('now', '+8 hours', '-1 seconds'), next_run_at = NULL WHERE id = ?2"
    ).bind(second.id, run.id).run();

    const auto = await runAutoResume({ DB: db }, { agentRunner: okRunner('恢复后的第二段') });
    assert.equal(auto.processed, 1);
    snap = await getGoalDetail(db, 1, goalId);
    assert.equal(snap.tasks[1].status, 'completed');
    assert.equal(snap.tasks[1].output_md, '恢复后的第二段');
    assert.equal(snap.steps.length, 2);
});

sqliteTest('Agent goals - 审批收件箱跨目标聚合、按用户隔离且不返回全文', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedUser(db, 2);

    async function completedGoal(title, output) {
        const goalId = await createGoal(db, 1, { title }).then((s) => s.goal.id);
        await generatePlan(db, 1, goalId, {
            planModel: async () => JSON.stringify({ tasks: [{ title: '唯一任务', description: '产出', depends_on: [] }] })
        });
        await startGoal({ env: {}, db, userId: 1, goalId, agentRunner: okRunner(output) });
        return goalId;
    }

    const firstGoal = await completedGoal('收件箱目标一', '第一条可保存正文');
    const secondGoal = await completedGoal('收件箱目标二', '第二条可保存正文');
    const first = await requestSaveDraft(db, 1, firstGoal);
    const second = await requestSaveDraft(db, 1, secondGoal);

    let request = new Request('https://chillin.test/api/agent/approvals');
    let response = await handleAgentGoalApi(request, {}, new URL(request.url), db, 1);
    assert.equal(response.status, 200);
    let body = await response.json();
    assert.equal(body.pending_count, 2);
    assert.equal(body.approvals.length, 2);
    assert.deepEqual(new Set(body.approvals.map((item) => item.goal_id)), new Set([firstGoal, secondGoal]));
    assert.ok(body.approvals.every((item) => item.goal_title));
    assert.ok(body.approvals.every((item) => item.payload.preview));
    assert.equal(Object.hasOwn(body.approvals[0].payload, 'content'), false, '收件箱不能返回完整正文');
    const firstItem = body.approvals.find((item) => item.goal_id === firstGoal);
    assert.match(firstItem.payload.preview, /第一条可保存正文/);

    request = new Request('https://chillin.test/api/agent/approvals');
    response = await handleAgentGoalApi(request, {}, new URL(request.url), db, 2);
    body = await response.json();
    assert.equal(body.pending_count, 0);
    assert.equal(body.approvals.length, 0);

    await decideApproval(db, 1, first.approval.id, { decision: 'approve' });
    request = new Request('https://chillin.test/api/agent/approvals');
    response = await handleAgentGoalApi(request, {}, new URL(request.url), db, 1);
    body = await response.json();
    assert.equal(body.pending_count, 1);
    assert.equal(body.approvals[0].goal_id, secondGoal);

    await decideApproval(db, 1, second.approval.id, { decision: 'reject' });
    request = new Request('https://chillin.test/api/agent/approvals');
    response = await handleAgentGoalApi(request, {}, new URL(request.url), db, 1);
    body = await response.json();
    assert.equal(body.pending_count, 0);

    // 过期审批不再出现在收件箱和目标详情里，避免点开后才报 410。
    const expiredGoal = await completedGoal('过期审批目标', '过期正文');
    const expired = await requestSaveDraft(db, 1, expiredGoal);
    await db.prepare("UPDATE agent_approvals SET expires_at = datetime('now', '+8 hours', '-1 minute') WHERE id = ?1")
        .bind(expired.approval.id).run();
    request = new Request('https://chillin.test/api/agent/approvals');
    response = await handleAgentGoalApi(request, {}, new URL(request.url), db, 1);
    body = await response.json();
    assert.equal(body.pending_count, 0);
    const expiredDetail = await getGoalDetail(db, 1, expiredGoal);
    assert.equal(expiredDetail.approvals.length, 0);

    // 过期记录不能让“再次保存”永远拿回旧审批；应自动作废旧记录并新建一条。
    const renewed = await requestSaveDraft(db, 1, expiredGoal);
    assert.notEqual(renewed.approval.id, expired.approval.id);
    assert.equal(renewed.approval.status, 'pending');
});

sqliteTest('Agent goals - Bot 用同一套目标函数建计划、排队、查看与暂停，不阻塞执行', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await makeGoal(db, 1);
    await planGoal(db, goalId);

    let reply = await maybeRunAgentCommand({}, db, 1, '我的目标');
    assert.match(reply, new RegExp('#' + goalId));
    assert.match(reply, /把最近的 AI 笔记/);

    const routed = await buildBotReply({}, db, 1, '我的目标');
    assert.match(routed, new RegExp('#' + goalId));

    reply = await maybeRunAgentCommand({}, db, 1, '开始 ' + goalId);
    assert.match(reply, /已排队/);
    const run = await db.prepare('SELECT * FROM agent_runs WHERE goal_id = ?1 AND user_id = 1').bind(goalId).first();
    assert.equal(run.status, 'queued');
    assert.equal(run.trigger, 'bot');
    const tasks = await db.prepare('SELECT * FROM agent_tasks WHERE goal_id = ?1 ORDER BY seq').bind(goalId).all();
    assert.equal(tasks.results[0].status, 'pending', 'Bot 只排队，不能在请求里执行任务');

    reply = await maybeRunAgentCommand({}, db, 1, '看目标 ' + goalId);
    assert.match(reply, /待开始|进行中/);
    assert.match(reply, /1\.\s*\[待执行\]/);

    reply = await maybeRunAgentCommand({}, db, 1, '审批');
    assert.match(reply, /没有待审批/);

    reply = await maybeRunAgentCommand({}, db, 1, '暂停 ' + goalId);
    assert.match(reply, /已暂停/);
    const goal = await db.prepare('SELECT * FROM agent_goals WHERE id = ?1').bind(goalId).first();
    assert.equal(goal.status, 'paused');

    assert.equal(await maybeRunAgentCommand({}, db, 1, '今天天气如何'), null);
});

sqliteTest('Agent goals - Bot 审批命令复用收件箱，同意后只写一条笔记', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await createGoal(db, 1, { title: 'Bot 审批保存' }).then((s) => s.goal.id);
    await db.prepare(
        "UPDATE agent_goals SET status = 'completed', result_md = '## 结果\n可保存正文' WHERE id = ?1 AND user_id = 1"
    ).bind(goalId).run();
    const approval = (await requestSaveDraft(db, 1, goalId)).approval;

    let reply = await maybeRunAgentCommand({}, db, 1, '审批');
    assert.match(reply, new RegExp('#' + approval.id));
    assert.match(reply, /保存为/);

    reply = await maybeRunAgentCommand({}, db, 1, '同意 ' + approval.id);
    assert.match(reply, /已保存为笔记/);
    const notes = await db.prepare('SELECT * FROM notes WHERE user_id = 1 AND is_deleted = 0').all();
    assert.equal(notes.results.length, 1);
    assert.match(notes.results[0].content, /可保存正文/);

    reply = await maybeRunAgentCommand({}, db, 1, '审批');
    assert.match(reply, /没有待审批/);
});

sqliteTest('Agent goals - 追加笔记审批校验归属、只追加一次且不覆盖原文', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedUser(db, 2);

    const ownNote = await db.prepare(
        `INSERT INTO notes (title, content, date, user_id, annotations, is_deleted, created_at, updated_at)
         VALUES ('目标笔记', '原文第一段', date('now', '+8 hours'), 1, '[]', 0, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
         RETURNING id`
    ).first();
    const otherNote = await db.prepare(
        `INSERT INTO notes (title, content, date, user_id, annotations, is_deleted, created_at, updated_at)
         VALUES ('别人的笔记', '不能碰', date('now', '+8 hours'), 2, '[]', 0, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
         RETURNING id`
    ).first();

    const goalId = await createGoal(db, 1, { title: '追加目标' }).then((s) => s.goal.id);
    await generatePlan(db, 1, goalId, {
        planModel: async () => JSON.stringify({ tasks: [{ title: '唯一任务', description: '产出', depends_on: [] }] })
    });
    await startGoal({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('追加正文') });

    await assert.rejects(
        requestAppendDraft(db, 1, goalId, { note_id: otherNote.id }),
        (err) => err && err.code === 'NOTE_NOT_FOUND'
    );

    const requested = await requestAppendDraft(db, 1, goalId, { note_id: ownNote.id });
    assert.equal(requested.approval.action_type, 'append_note');
    assert.equal(requested.approval.payload.note_id, ownNote.id);
    assert.equal(requested.approval.payload.note_title, '目标笔记');

    const request = new Request('https://chillin.test/api/agent/approvals');
    const response = await handleAgentGoalApi(request, {}, new URL(request.url), db, 1);
    const inbox = await response.json();
    assert.equal(inbox.pending_count, 1);
    assert.equal(inbox.approvals[0].action_type, 'append_note');
    assert.equal(inbox.approvals[0].payload.note_title, '目标笔记');
    assert.equal(Object.hasOwn(inbox.approvals[0].payload, 'content'), false);

    const decided = await decideApproval(db, 1, requested.approval.id, { decision: 'approve' });
    assert.equal(decided.approval.status, 'approved');
    assert.equal(decided.approval.result.appended, true);
    let note = await db.prepare('SELECT content FROM notes WHERE id = ?1').bind(ownNote.id).first();
    assert.ok(note.content.startsWith('原文第一段'));
    assert.match(note.content, /追加正文/);
    const afterApprove = note.content;

    const again = await decideApproval(db, 1, requested.approval.id, { decision: 'approve' });
    assert.equal(again.already_decided, true);
    note = await db.prepare('SELECT content FROM notes WHERE id = ?1').bind(ownNote.id).first();
    assert.equal(note.content, afterApprove, '重复审批不能追加第二次');

    const other = await db.prepare('SELECT content FROM notes WHERE id = ?1').bind(otherNote.id).first();
    assert.equal(other.content, '不能碰');
});

sqliteTest('Agent checkpoint - BLOCKED 结果会暂停目标并把任务标记为 blocked', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await createGoal(db, 1, { title: '阻塞识别目标' }).then((s) => s.goal.id);
    await generatePlan(db, 1, goalId, {
        planModel: async () => JSON.stringify({ tasks: [{ title: '一', depends_on: [] }, { title: '二', depends_on: [0] }] })
    });
    const snapshot = await runNextTask({
        env: {}, db, userId: 1, goalId,
        agentRunner: okRunner('## 结论\n\n**阻塞（BLOCKED）**：没有联网工具，无法完成。')
    });
    assert.equal(snapshot.goal.status, 'paused');
    const task = await db.prepare('SELECT * FROM agent_tasks WHERE goal_id = ?1 AND seq = 0').bind(goalId).first();
    assert.equal(task.status, 'blocked');
    const run = await db.prepare('SELECT * FROM agent_runs WHERE goal_id = ?1 ORDER BY id DESC LIMIT 1').bind(goalId).first();
    assert.equal(run.status, 'paused');
    await assert.rejects(
        continueGoal({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('不应执行') }),
        (err) => err && err.code === 'GOAL_BLOCKED'
    );
});

sqliteTest('Agent goals - 要求 Bot 发送但没有发送审批时不能标记完成', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await createGoal(db, 1, { title: '今天的三条新闻通过bot发送给我' }).then((s) => s.goal.id);
    await generatePlan(db, 1, goalId, {
        planModel: async () => JSON.stringify({ tasks: [{ title: '写好消息正文', depends_on: [] }] })
    });
    const paused = await runNextTask({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('这是草稿正文') });
    assert.equal(paused.goal.status, 'paused');
    const autoApproval = await db.prepare("SELECT * FROM agent_approvals WHERE goal_id = ?1 AND action_type = 'send_bot_message' AND status = 'pending'").bind(goalId).first();
    assert.ok(autoApproval, '要求 Bot 发送时必须自动创建发送审批');

    const proposal = await requestAgentProposal(db, 1, goalId, 1, {
        action: 'send_bot_message', content: '今天的三条新闻'
    });
    await db.prepare(
        "INSERT INTO bot_claw_accounts (user_id,status,bot_token,baseurl,ilink_bot_id,ilink_user_id,is_deleted) VALUES (1,'bound','token','https://ilinkai.weixin.qq.com','bot','user',0)"
    ).run();
    await decideApproval(db, 1, proposal.approval.id, { decision: 'approve' }, { sendBot: async () => {} });
    const done = await continueGoal({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('已发送') });
    assert.equal(done.goal.status, 'completed');
});

sqliteTest('Agent goals - 勾选自动发送后，完成后自动创建并同意发送审批', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await db.prepare(
        "INSERT INTO bot_claw_accounts (user_id,status,bot_token,baseurl,ilink_bot_id,ilink_user_id,is_deleted) VALUES (1,'bound','token','https://ilinkai.weixin.qq.com','bot','user',0)"
    ).run();
    const goalId = await createGoal(db, 1, { title: '自动发送目标，结果发给bot', auto_send: true }).then((s) => s.goal.id);
    await generatePlan(db, 1, goalId, {
        planModel: async () => JSON.stringify({ tasks: [{ title: '写结论', depends_on: [] }] })
    });
    let sent = '';
    const done = await runNextTask({
        env: {}, db, userId: 1, goalId,
        agentRunner: okRunner('自动发送正文'),
        sendBot: async (text) => { sent = text; }
    });
    assert.equal(done.goal.status, 'completed');
    assert.equal(sent, '自动发送正文');
    const approval = await db.prepare("SELECT * FROM agent_approvals WHERE goal_id = ?1 AND action_type = 'send_bot_message'").bind(goalId).first();
    assert.equal(approval.status, 'approved');
    assert.equal(JSON.parse(approval.result_json).sent, true);
});

sqliteTest('Agent web tools - 只读搜索与抓取，拒绝私网地址', async () => {
    const search = await runWebTool(
        { LLM_API_KEY: 'test' },
        'web_search',
        { query: '今天 AI 新闻' },
        {
            fetchImpl: async () => new Response(JSON.stringify({
                data: [{ title: 'AI 新闻', url: 'https://example.com/ai', summary: '今日事件', site_name: '示例', rerank_score: 1 }]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
    );
    assert.equal(search.ok, true);
    assert.equal(search.data.results[0].title, 'AI 新闻');
    assert.equal(search.data.results[0].url, 'https://example.com/ai');

    // SSRF 防护测试：拒绝 http、IPv4 裸字面量、私网网段与元数据服务
    const blockedUrls = [
        'http://127.0.0.1/secret',
        'https://127.0.0.1/secret',
        'https://10.0.0.1/private',
        'https://192.168.1.1/admin',
        'https://172.16.0.1/conf',
        'https://169.254.169.254/latest/meta-data',
        'https://127.0.0.1.nip.io/foo',
        'https://metadata.google.internal/computeMetadata'
    ];
    for (const badUrl of blockedUrls) {
        assert.equal(safePublicUrl(badUrl), '', `safePublicUrl 必须拒绝 ${badUrl}`);
        const bad = await runWebTool({}, 'fetch_url', { url: badUrl });
        assert.equal(bad.ok, false);
        assert.equal(bad.error.code, 'INVALID_URL');
    }

    // SSRF 重定向拦截：跟随 302 重定向到私有网段必须被切断并拒绝
    const redirectSsrf = await runWebTool({}, 'fetch_url', { url: 'https://example.com/redirect-ssrf' }, {
        fetchImpl: async (url) => {
            if (url === 'https://example.com/redirect-ssrf') {
                return {
                    status: 302,
                    headers: new Headers({ location: 'https://169.254.169.254/latest/meta-data' })
                };
            }
            return { ok: true, status: 200, text: async () => 'SHOULD_NOT_LEAK' };
        }
    });
    assert.equal(redirectSsrf.ok, false);
    assert.equal(redirectSsrf.error.code, 'INVALID_URL');
    assert.match(redirectSsrf.error.message, /重定向目标地址不安全/);

    // 合法安全重定向：允许相对路径安全重定向并获取正文
    const safeRedirectPage = await runWebTool({}, 'fetch_url', { url: 'https://example.com/old-page' }, {
        fetchImpl: async (url) => {
            if (url === 'https://example.com/old-page') {
                return {
                    status: 301,
                    headers: new Headers({ location: '/new-page' })
                };
            }
            return { ok: true, status: 200, text: async () => 'Redirected new page body' };
        }
    });
    assert.equal(safeRedirectPage.ok, true);
    assert.match(safeRedirectPage.data.content, /Redirected new page body/);

    const page = await runWebTool({}, 'fetch_url', { url: 'https://example.com/page' }, {
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'Example page body' })
    });
    assert.equal(page.ok, true);
    assert.match(page.data.content, /Example page body/);

    // DNS Rebinding 深度检查：测试私网 IP 判定与域名解析拦截
    assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('10.254.1.1'), true);
    assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
    assert.equal(isPrivateOrReservedIp('192.168.1.1'), true);
    assert.equal(isPrivateOrReservedIp('172.20.0.1'), true);
    assert.equal(isPrivateOrReservedIp('100.80.0.1'), true);
    assert.equal(isPrivateOrReservedIp('::1'), true);
    assert.equal(isPrivateOrReservedIp('fe80::1'), true);
    assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);

    // DNS 解析到私网 IP 时拦截
    const rebindBad = await runWebTool({}, 'fetch_url', { url: 'https://attacker-rebind.com/test' }, {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'PWNED' })
    });
    assert.equal(rebindBad.ok, false);
    assert.equal(rebindBad.error.code, 'INVALID_URL');
    assert.match(rebindBad.error.message, /域名解析为私有地址/);

    // 响应体大小限制：Content-Length 超限前置拦截
    const bodyTooLarge = await runWebTool({}, 'fetch_url', { url: 'https://example.com/large-file' }, {
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-length': String(10 * 1024 * 1024) }),
            text: async () => 'TOO_LARGE'
        })
    });
    assert.equal(bodyTooLarge.ok, false);
    assert.equal(bodyTooLarge.error.code, 'BODY_TOO_LARGE');

    // 第三方读取服务安全边界：配置私网 LINK_READER_URL 拒绝请求
    const readerInject = await runWebTool({
        LINK_READER_API_KEY: 'test-key',
        LINK_READER_URL: 'https://127.0.0.1:443/read'
    }, 'fetch_url', { url: 'https://example.com/blocked' }, {
        fetchImpl: async () => { throw new Error('HTTP 403'); }
    });
    assert.equal(readerInject.ok, false);
    assert.match(readerInject.error.message, /读取服务/);
});

sqliteTest('Agent proposals - 发 Bot 消息也走审批，未绑定或发送失败不产生假结果', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await createGoal(db, 1, { title: 'Bot 发送目标' }).then((s) => s.goal.id);
    const proposal = await requestAgentProposal(db, 1, goalId, 9, {
        action: 'send_bot_message', content: '今天没有新的 AI 事件。'
    });
    assert.equal(proposal.approval.action_type, 'send_bot_message');
    assert.equal(proposal.approval.payload.channel, 'bot');
    await assert.rejects(
        decideApproval(db, 1, proposal.approval.id, { decision: 'approve' }),
        (err) => err && err.code === 'BOT_NOT_BOUND'
    );
    const stillPending = await db.prepare('SELECT status FROM agent_approvals WHERE id = ?1').bind(proposal.approval.id).first();
    assert.equal(stillPending.status, 'pending', '未绑定 Bot 时审批退回 pending，不能假装已发送');

    await db.prepare(
        "INSERT INTO bot_claw_accounts (user_id,status,bot_token,baseurl,ilink_bot_id,ilink_user_id,is_deleted) VALUES (1,'bound','token','https://ilinkai.weixin.qq.com','bot','user',0)"
    ).run();
    let sentText = '';
    const sent = await decideApproval(db, 1, proposal.approval.id, { decision: 'approve' }, {
        sendBot: async (text) => { sentText = text; }
    });
    assert.equal(sent.approval.result.sent, true);
    assert.equal(sentText, '今天没有新的 AI 事件。');
});

sqliteTest('Agent checkpoint - 结果不足时只重规划未完成任务', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await createGoal(db, 1, { title: '检查点目标' }).then((s) => s.goal.id);
    await generatePlan(db, 1, goalId, {
        planModel: async () => JSON.stringify({
            tasks: [
                { title: '已完成', description: '完成', depends_on: [] },
                { title: '原剩余一', description: '剩余', depends_on: [0] },
                { title: '原剩余二', description: '剩余', depends_on: [1] }
            ]
        })
    });
    await db.prepare(
        "UPDATE agent_tasks SET status = 'completed', output_md = '已有结果' WHERE goal_id = ?1 AND user_id = 1 AND seq = 0"
    ).bind(goalId).run();
    const tasks = await db.prepare('SELECT * FROM agent_tasks WHERE goal_id = ?1 ORDER BY seq').bind(goalId).all();
    const completedTask = tasks.results.find((task) => task.seq === 0);

    const checkpoint = await checkpointAfterTask({
        env: { LLM_API_KEY: 'test' },
        db,
        userId: 1,
        goalId,
        task: completedTask,
        output: '结果不足',
        checkpointModel: async () => '{"action":"replan","reason":"缺少证据"}',
        planModel: async () => JSON.stringify({
            tasks: [
                { title: '补充证据', description: '补证据', depends_on: [] },
                { title: '重写结论', description: '再总结', depends_on: [0] }
            ]
        })
    });
    assert.equal(checkpoint.action, 'replan');
    const after = await db.prepare('SELECT * FROM agent_tasks WHERE goal_id = ?1 ORDER BY seq').bind(goalId).all();
    const rows = after.results;
    assert.equal(rows[0].status, 'completed', '已完成任务必须保留');
    assert.equal(rows[0].output_md, '已有结果');
    assert.equal(rows.filter((task) => task.status === 'pending').length, 2);
    assert.equal(rows[1].title, '补充证据');
    assert.deepEqual(JSON.parse(rows[2].depends_on), [1], '新任务依赖要映射到新 seq');
    const goal = await db.prepare('SELECT * FROM agent_goals WHERE id = ?1').bind(goalId).first();
    assert.equal(goal.status, 'active');
    assert.equal(goal.plan_version, 2);

    const second = await checkpointAfterTask({
        env: { LLM_API_KEY: 'test' }, db, userId: 1, goalId, task: rows[0], output: '还是不足',
        checkpointModel: async () => '{"action":"replan","reason":"再试"}',
        planModel: async () => '{"tasks":[{"title":"最后一步","depends_on":[]}]}'
    });
    assert.equal(second.action, 'replan');
    await db.prepare("UPDATE agent_goals SET plan_version = 3 WHERE id = ?1").bind(goalId).run();
    const limited = await checkpointAfterTask({
        env: { LLM_API_KEY: 'test' }, db, userId: 1, goalId, task: rows[0], output: '不足',
        checkpointModel: async () => '{"action":"replan","reason":"继续"}',
        planModel: async () => '{"tasks":[{"title":"不应生成"}]}'
    });
    assert.equal(limited.action, 'continue', '计划版本达到上限后不再重规划');
});

sqliteTest('Agent checkpoint - 执行器完成一个任务后按检查点重规划，不标记目标完成', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await createGoal(db, 1, { title: '执行器检查点' }).then((s) => s.goal.id);
    await generatePlan(db, 1, goalId, {
        planModel: async () => JSON.stringify({
            tasks: [
                { title: '第一步', depends_on: [] },
                { title: '第二步', depends_on: [0] }
            ]
        })
    });
    const result = await runNextTask({
        env: { LLM_API_KEY: 'test' },
        db,
        userId: 1,
        goalId,
        agentRunner: okRunner('第一步结果'),
        checkpointModel: async () => '{"action":"replan","reason":"第一步结果不足"}',
        planModel: async () => '{"tasks":[{"title":"补充后继续","depends_on":[]}]}'
    });
    assert.equal(result.goal.status, 'active');
    const rows = await db.prepare('SELECT * FROM agent_tasks WHERE goal_id = ?1 ORDER BY seq').bind(goalId).all();
    assert.equal(rows.results[0].status, 'completed');
    assert.equal(rows.results[1].title, '补充后继续');
    assert.equal(rows.results[1].status, 'pending');
});

sqliteTest('Agent budget - 预算用完后不再执行任务，正常任务会累计用量', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const blockedId = await createGoal(db, 1, { title: '预算已满目标' }).then((s) => s.goal.id);
    await generatePlan(db, 1, blockedId, {
        planModel: async () => JSON.stringify({ tasks: [{ title: '不该执行', depends_on: [] }] })
    });
    await db.prepare(
        "UPDATE agent_goals SET max_tool_calls = 1, used_tool_calls = 1 WHERE id = ?1 AND user_id = 1"
    ).bind(blockedId).run();
    const blocked = await runNextTask({
        env: {}, db, userId: 1, goalId: blockedId,
        agentRunner: async () => { throw new Error('预算耗尽时不应调用模型'); }
    });
    assert.equal(blocked.goal.status, 'failed');
    assert.match(blocked.goal.error, /预算已用完/);
    const blockedTasks = await db.prepare('SELECT * FROM agent_tasks WHERE goal_id = ?1').bind(blockedId).all();
    assert.equal(blockedTasks.results[0].status, 'pending');

    const okId = await createGoal(db, 1, { title: '预算累计目标' }).then((s) => s.goal.id);
    await generatePlan(db, 1, okId, {
        planModel: async () => JSON.stringify({ tasks: [{ title: '执行一次', depends_on: [] }] })
    });
    const done = await runNextTask({
        env: {}, db, userId: 1, goalId: okId,
        agentRunner: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return {
                reply: '完成', sources: [],
                toolTrace: [{ name: 'list_recent_notes' }, { name: 'get_note' }],
                stopReason: 'final'
            };
        }
    });
    assert.equal(done.goal.status, 'completed');
    const used = await db.prepare('SELECT used_tool_calls, used_ms FROM agent_goals WHERE id = ?1').bind(okId).first();
    assert.equal(used.used_tool_calls, 2);
    assert.ok(used.used_ms > 0);
});

sqliteTest('Agent evals - 10 个固定目标回归', async () => {
    const scenarios = [
        {
            name: '整理笔记',
            run: async (db) => {
                const goalId = await createGoal(db, 1, { title: '整理最近 AI 笔记' }).then((s) => s.goal.id);
                await generatePlan(db, 1, goalId, { planModel: async () => JSON.stringify({ tasks: [{ title: '收集', depends_on: [] }, { title: '提纲', depends_on: [0] }] }) });
                await runNextTask({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('收集完成') });
                const done = await runNextTask({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('提纲完成') });
                assert.equal(done.goal.status, 'completed');
                assert.match(done.goal.result_md, /收集完成/);
                assert.match(done.goal.result_md, /提纲完成/);
            }
        },
        {
            name: '主题引用',
            run: async (db) => {
                const goalId = await createGoal(db, 1, { title: '提炼三条主题' }).then((s) => s.goal.id);
                await generatePlan(db, 1, goalId, { planModel: async () => JSON.stringify({ tasks: [{ title: '主题', depends_on: [] }] }) });
                const done = await runNextTask({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('主题一 [笔记#1]') });
                assert.match(done.goal.result_md, /\[笔记#1\]/);
            }
        },
        {
            name: '保存提案',
            run: async (db) => {
                const goalId = await createGoal(db, 1, { title: '保存提案评测' }).then((s) => s.goal.id);
                await generatePlan(db, 1, goalId, { planModel: async () => JSON.stringify({ tasks: [{ title: '写结论', depends_on: [] }] }) });
                await runNextTask({
                    env: {}, db, userId: 1, goalId,
                    agentRunner: async (options) => {
                        const tool = await options.executeTool(db, 1, 'propose_write', { action: 'save_note', title: '评测笔记', content: '评测正文' });
                        assert.equal(tool.ok, true);
                        return { reply: '已创建待审批', sources: [], toolTrace: [{ name: 'propose_write' }], stopReason: 'final' };
                    }
                });
                const approval = await db.prepare("SELECT * FROM agent_approvals WHERE goal_id = ?1 AND action_type = 'save_note'").bind(goalId).first();
                assert.ok(approval);
                const notesBefore = await db.prepare('SELECT COUNT(*) AS n FROM notes WHERE user_id = 1').first();
                assert.equal(notesBefore.n, 0);
                await decideApproval(db, 1, approval.id, { decision: 'approve' });
                const notesAfter = await db.prepare('SELECT COUNT(*) AS n FROM notes WHERE user_id = 1').first();
                assert.equal(notesAfter.n, 1);
            }
        },
        {
            name: '追加提案',
            run: async (db) => {
                const note = await db.prepare(
                    "INSERT INTO notes (title, content, date, user_id, annotations, is_deleted, created_at, updated_at) VALUES ('评测目标', '原文', date('now', '+8 hours'), 1, '[]', 0, datetime('now', '+8 hours'), datetime('now', '+8 hours')) RETURNING id"
                ).first();
                const goalId = await createGoal(db, 1, { title: '追加提案评测' }).then((s) => s.goal.id);
                await generatePlan(db, 1, goalId, { planModel: async () => JSON.stringify({ tasks: [{ title: '追加', depends_on: [] }] }) });
                await runNextTask({
                    env: {}, db, userId: 1, goalId,
                    agentRunner: async (options) => {
                        const tool = await options.executeTool(db, 1, 'propose_write', { action: 'append_note', note_id: note.id, content: '追加正文' });
                        assert.equal(tool.ok, true);
                        return { reply: '已创建待审批', sources: [], toolTrace: [{ name: 'propose_write' }], stopReason: 'final' };
                    }
                });
                const approval = await db.prepare("SELECT * FROM agent_approvals WHERE goal_id = ?1 AND action_type = 'append_note'").bind(goalId).first();
                await decideApproval(db, 1, approval.id, { decision: 'approve' });
                const after = await db.prepare('SELECT content FROM notes WHERE id = ?1').bind(note.id).first();
                assert.match(after.content, /原文/);
                assert.match(after.content, /追加正文/);
            }
        },
        {
            name: '失败重试',
            run: async (db) => {
                const goalId = await createGoal(db, 1, { title: '失败重试评测' }).then((s) => s.goal.id);
                await generatePlan(db, 1, goalId, { planModel: async () => JSON.stringify({ tasks: [{ title: '重试', depends_on: [] }] }) });
                await runNextTask({ env: {}, db, userId: 1, goalId, agentRunner: async () => { throw new Error('第一次失败'); } });
                let goal = await db.prepare('SELECT * FROM agent_goals WHERE id = ?1').bind(goalId).first();
                assert.notEqual(goal.status, 'completed');
                const done = await runNextTask({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('重试成功') });
                assert.equal(done.goal.status, 'completed');
            }
        },
        {
            name: '暂停继续',
            run: async (db) => {
                const goalId = await createGoal(db, 1, { title: '暂停继续评测' }).then((s) => s.goal.id);
                await generatePlan(db, 1, goalId, { planModel: async () => JSON.stringify({ tasks: [{ title: '一', depends_on: [] }, { title: '二', depends_on: [0] }] }) });
                await runNextTask({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('一完成') });
                await pauseGoal(db, 1, goalId);
                const paused = await db.prepare('SELECT * FROM agent_goals WHERE id = ?1').bind(goalId).first();
                assert.equal(paused.status, 'paused');
            }
        },
        {
            name: '取消目标',
            run: async (db) => {
                const goalId = await createGoal(db, 1, { title: '取消评测' }).then((s) => s.goal.id);
                await generatePlan(db, 1, goalId, { planModel: async () => JSON.stringify({ tasks: [{ title: '待办', depends_on: [] }] }) });
                const cancelled = await cancelGoal(db, 1, goalId);
                assert.equal(cancelled.goal.status, 'cancelled');
                assert.equal(cancelled.tasks[0].status, 'skipped');
            }
        },
        {
            name: '检查点重规划',
            run: async (db) => {
                const goalId = await createGoal(db, 1, { title: '检查点评测' }).then((s) => s.goal.id);
                await generatePlan(db, 1, goalId, { planModel: async () => JSON.stringify({ tasks: [{ title: '先做', depends_on: [] }, { title: '后做', depends_on: [0] }] }) });
                const result = await runNextTask({
                    env: { LLM_API_KEY: 'test' }, db, userId: 1, goalId,
                    agentRunner: okRunner('结果不足'),
                    checkpointModel: async () => '{"action":"replan","reason":"缺证据"}',
                    planModel: async () => '{"tasks":[{"title":"补证据","depends_on":[]}]}'
                });
                assert.equal(result.goal.status, 'active');
                const rows = await db.prepare('SELECT * FROM agent_tasks WHERE goal_id = ?1 ORDER BY seq').bind(goalId).all();
                assert.equal(rows.results[0].status, 'completed');
                assert.equal(rows.results[1].title, '补证据');
            }
        },
        {
            name: '预算耗尽',
            run: async (db) => {
                const goalId = await createGoal(db, 1, { title: '预算评测' }).then((s) => s.goal.id);
                await generatePlan(db, 1, goalId, { planModel: async () => JSON.stringify({ tasks: [{ title: '不跑', depends_on: [] }] }) });
                await db.prepare('UPDATE agent_goals SET used_tool_calls = 48 WHERE id = ?1').bind(goalId).run();
                const result = await runNextTask({ env: {}, db, userId: 1, goalId, agentRunner: okRunner('不应执行') });
                assert.equal(result.goal.status, 'failed');
                assert.match(result.goal.error, /预算已用完/);
            }
        },
        {
            name: '跨用户隔离',
            run: async (db) => {
                await seedUser(db, 2);
                const goalId = await createGoal(db, 1, { title: '隔离评测' }).then((s) => s.goal.id);
                const others = await listGoalSummaries(db, 2);
                assert.equal(others.length, 0);
                await assert.rejects(getGoalDetail(db, 2, goalId), (err) => err && err.code === 'GOAL_NOT_FOUND');
            }
        }
    ];

    for (const scenario of scenarios) {
        const db = createTestDb();
        await seedUser(db, 1);
        try {
            await scenario.run(db);
        } catch (err) {
            err.message = '[' + scenario.name + '] ' + err.message;
            throw err;
        }
    }
});

sqliteTest('Agent goals - 暂停后可编辑目标，取消会停止剩余任务', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const goalId = await createGoal(db, 1, { title: '可编辑目标' }).then((s) => s.goal.id);
    await generatePlan(db, 1, goalId, {
        planModel: async () => JSON.stringify({ tasks: [{ title: '任务一', depends_on: [] }, { title: '任务二', depends_on: [0] }] })
    });
    await pauseGoal(db, 1, goalId);
    const edited = await updateGoal(db, 1, goalId, { title: '改过的目标', description: '新的说明' });
    assert.equal(edited.goal.status, 'draft');
    assert.equal(edited.goal.title, '改过的目标');
    assert.equal(edited.tasks.length, 0, '编辑后重置为草稿，等待重新规划');

    const cancelId = await createGoal(db, 1, { title: '要取消的目标' }).then((s) => s.goal.id);
    await generatePlan(db, 1, cancelId, {
        planModel: async () => JSON.stringify({ tasks: [{ title: '待执行任务', depends_on: [] }] })
    });
    const cancelled = await cancelGoal(db, 1, cancelId);
    assert.equal(cancelled.goal.status, 'cancelled');
    assert.equal(cancelled.tasks[0].status, 'skipped');
    await assert.rejects(cancelGoal(db, 1, cancelId + 999), (err) => err && err.code === 'GOAL_NOT_FOUND');
});

sqliteTest('Agent proposals - Agent 只能创建审批，同意后才写笔记且校验归属', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    await seedUser(db, 2);
    const ownNote = await db.prepare(
        `INSERT INTO notes (title, content, date, user_id, annotations, is_deleted, created_at, updated_at)
         VALUES ('Agent 目标笔记', '原文', date('now', '+8 hours'), 1, '[]', 0, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
         RETURNING id`
    ).first();
    const otherNote = await db.prepare(
        `INSERT INTO notes (title, content, date, user_id, annotations, is_deleted, created_at, updated_at)
         VALUES ('别人的笔记', '不能碰', date('now', '+8 hours'), 2, '[]', 0, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
         RETURNING id`
    ).first();
    const goalId = await createGoal(db, 1, { title: 'Agent 提案目标' }).then((s) => s.goal.id);

    await assert.rejects(
        requestAgentProposal(db, 1, goalId, 42, { action: 'append_note', note_id: otherNote.id, content: '越权' }),
        (err) => err && err.code === 'NOTE_NOT_FOUND'
    );

    const proposal = await requestAgentProposal(db, 1, goalId, 42, {
        action: 'append_note',
        note_id: ownNote.id,
        content: '## Agent 结果\n\n这是提案正文。'
    });
    assert.equal(proposal.created, true);
    assert.equal(proposal.approval.action_type, 'append_note');
    assert.equal(proposal.approval.status, 'pending');
    assert.equal(proposal.approval.payload.source, 'agent');
    assert.equal(proposal.approval.payload.task_id, 42);
    let note = await db.prepare('SELECT content FROM notes WHERE id = ?1').bind(ownNote.id).first();
    assert.equal(note.content, '原文', '提案阶段绝不能直接写库');

    const approved = await decideApproval(db, 1, proposal.approval.id, { decision: 'approve' });
    assert.equal(approved.approval.result.appended, true);
    note = await db.prepare('SELECT content FROM notes WHERE id = ?1').bind(ownNote.id).first();
    assert.match(note.content, /原文/);
    assert.match(note.content, /这是提案正文/);

    const save = await requestAgentProposal(db, 1, goalId, 42, {
        action: 'save_note',
        title: 'Agent 新笔记',
        content: '保存正文'
    });
    const saved = await decideApproval(db, 1, save.approval.id, { decision: 'approve' });
    const savedNote = await db.prepare('SELECT * FROM notes WHERE id = ?1 AND user_id = 1').bind(saved.approval.result.note_id).first();
    assert.equal(savedNote.title, 'Agent 新笔记');
    assert.equal(savedNote.content, '保存正文');
});

sqliteTest('Agent proposals - 任务执行器提供 propose_write，只产生审批不直接写库', async () => {
    const db = createTestDb();
    await seedUser(db, 1);
    const note = await db.prepare(
        `INSERT INTO notes (title, content, date, user_id, annotations, is_deleted, created_at, updated_at)
         VALUES ('任务目标笔记', '任务原文', date('now', '+8 hours'), 1, '[]', 0, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
         RETURNING id`
    ).first();
    const goalId = await createGoal(db, 1, { title: '任务提案目标' }).then((s) => s.goal.id);
    await generatePlan(db, 1, goalId, {
        planModel: async () => JSON.stringify({ tasks: [{ title: '唯一任务', description: '产出并提案', depends_on: [] }] })
    });

    let sawTool = false;
    const result = await runNextTask({
        env: {},
        db,
        userId: 1,
        goalId,
        agentRunner: async (options) => {
            const defs = options.extraTools || [];
            assert.ok(defs.some((tool) => tool.function.name === 'propose_write'));
            const toolResult = await options.executeTool(db, 1, 'propose_write', {
                action: 'append_note',
                note_id: note.id,
                content: '任务提案正文'
            });
            assert.equal(toolResult.ok, true);
            sawTool = true;
            return {
                reply: '已创建待审批，没有直接写入。',
                sources: [],
                toolTrace: [{ name: 'propose_write', ok: true }],
                stopReason: 'final'
            };
        }
    });
    assert.equal(sawTool, true);
    assert.equal(result.goal.status, 'completed');

    const approval = await db.prepare('SELECT * FROM agent_approvals WHERE goal_id = ?1 AND user_id = 1').bind(goalId).first();
    assert.equal(approval.action_type, 'append_note');
    assert.equal(JSON.parse(approval.payload_json).source, 'agent');
    assert.ok(JSON.parse(approval.payload_json).task_id > 0);
    const before = await db.prepare('SELECT content FROM notes WHERE id = ?1').bind(note.id).first();
    assert.equal(before.content, '任务原文', '任务结束也不能直接写库');

    await decideApproval(db, 1, approval.id, { decision: 'approve' });
    const after = await db.prepare('SELECT content FROM notes WHERE id = ?1').bind(note.id).first();
    assert.match(after.content, /任务提案正文/);
});
