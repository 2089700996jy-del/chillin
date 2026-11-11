/**
 * Super-Agent 目标协同执行引擎（Router + 独立并发 Worker 架构）：
 *
 * 架构设计：
 * - Router 负责任务 DAG 依赖分析与动态调度，挑出所有就绪分支（最多 MAX_CONCURRENT_WORKERS 个并发槽位）；
 * - Worker 作为独立执行单元并行工作，各自挂载隔离的上下文、工具追踪和步骤日志（记录 worker_id）；
 * - 每次调度通过 Promise.all 驱动独立 Worker 并行执行，大幅缩短多分支任务在长程目标中的耗时；
 * - 失败隔离与检查点兜底：单一 Worker 失败按 max_attempts 自动重试；支持受阻暂停与动态 replan。
 */
import { runAgent } from './ai-runtime.js';
import { executeAgentTool } from './ai-tools.js';
import { checkpointAfterTask, blockCompletionIfNeeded, budgetExceeded, addBudgetUsage, failForBudget } from './agent-checkpoint.js';
import { WEB_AGENT_TOOLS, runWebTool } from './agent-web.js';
import { runProposalTool, notifyAgentUser, notificationText, PROPOSE_WRITE_TOOL, PROPOSE_CHOICE_TOOL, PROPOSE_WRITE_INSTRUCTIONS } from './agent-approvals.js';
import { loadPreferencePrompt } from './bot-preferences.js';
import {
    AgentError,
    getGoalRow,
    listTasks,
    getActiveRunRow,
    getRunRow,
    getSnapshot,
    nextReadyTask,
    allReadyTasks,
    allTasksCompleted,
    touchGoal,
    cleanMultiline
} from './agent-store.js';
import {
    taskPrompt,
    parseSleepDirective,
    finalResult,
    startGoal,
    continueGoal,
    pauseGoal,
    completeGoal,
    retryTask
} from './agent-lifecycle.js';

export {
    taskPrompt,
    parseSleepDirective,
    finalResult,
    startGoal,
    continueGoal,
    pauseGoal,
    completeGoal,
    retryTask
};

const TASK_TIMEOUT_MS = 50000;
const LIVE_TASK_GRACE_MS = 120000;
const TASK_LEASE_SQL = "datetime('now', '+8 hours', '+180 seconds')";
const TASK_STARTED_AT_SQL = "datetime('now', '+8 hours')";
const MAX_CONCURRENT_WORKERS = 3;

function timestampMs(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return 0;
    return Date.parse(/[zZ]$|[+-]\d{2}:\d{2}$/.test(text) ? text : text.replace(' ', 'T') + '+08:00');
}

function isLiveRunningTask(task) {
    const at = timestampMs(task && (task.updated_at || task.started_at));
    return at > 0 && Date.now() - at < LIVE_TASK_GRACE_MS;
}

function withTimeout(promise, ms, message) {
    let timer = null;
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), Math.max(1, Number(ms) || 1)); })
    ]).finally(() => { if (timer) clearTimeout(timer); });
}


async function nextStepSeq(db, runId) {
    const row = await db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM agent_steps WHERE run_id = ?1'
    ).bind(runId).first();
    return Number((row && row.seq) || 1);
}

async function createRun(db, userId, goalId, trigger) {
    const row = await db.prepare(
        `INSERT INTO agent_runs (goal_id, user_id, trigger, status, started_at, updated_at)
         VALUES (?1, ?2, ?3, 'running', datetime('now', '+8 hours'), datetime('now', '+8 hours'))
         RETURNING *`
    ).bind(goalId, userId, trigger || 'manual').first();
    await touchGoal(db, userId, goalId, { last_run_id: row.id, error: '' });
    return row;
}

async function ensureRun(db, userId, goalId, trigger) {
    const active = await getActiveRunRow(db, userId, goalId);
    if (active) {
        if (active.status === 'paused') {
            await db.prepare(
                "UPDATE agent_runs SET status = 'running', updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2"
            ).bind(active.id, userId).run();
            return getRunRow(db, userId, goalId, active.id);
        }
        return active;
    }
    return createRun(db, userId, goalId, trigger);
}

async function finishGoal(db, userId, goalId, runId, tasks, status = 'completed', error = '', env = null, goalTitle = '') {
    const result = finalResult(tasks);
    const completedAt = "datetime('now', '+8 hours')";
    await db.prepare(
        `UPDATE agent_goals SET status = ?1, result_md = ?2, error = ?3, last_run_id = ?4,
            completed_at = ${completedAt}, updated_at = ${completedAt}
         WHERE id = ?5 AND user_id = ?6 AND COALESCE(is_deleted, 0) = 0`
    ).bind(status, result, error, runId, goalId, userId).run();
    await db.prepare(
        `UPDATE agent_runs SET status = ?1, result_md = ?2, error = ?3, current_task_id = NULL,
            lease_until = NULL, next_run_at = NULL,
            finished_at = ${completedAt}, updated_at = ${completedAt}
         WHERE id = ?4 AND user_id = ?5`
    ).bind(status === 'completed' ? 'completed' : 'failed', result, error, runId, userId).run();
    await notifyAgentUser(env, db, userId, {
        title: status === 'completed' ? '目标完成' : '目标失败',
        body: '「' + notificationText(goalTitle, 60) + '」' + (status === 'completed' ? '已完成，去查看结果。' : '执行失败，去查看原因。'),
        tag: 'agent-goal-' + goalId
    }).catch(() => {});
}

async function markTaskFailure(db, userId, goalId, runId, task, stepId, attempts, error, durationMs, holdStatus = '') {
    const maxAttempts = Number(task.max_attempts || 3);
    const exhausted = attempts >= maxAttempts;
    const nextStatus = exhausted ? 'failed' : 'pending';
    await db.prepare(
        `UPDATE agent_tasks SET status = ?1, attempts = ?2, error = ?3, finished_at = datetime('now', '+8 hours'),
            updated_at = datetime('now', '+8 hours') WHERE id = ?4 AND user_id = ?5`
    ).bind(nextStatus, attempts, error, task.id, userId).run();
    await db.prepare(
        `UPDATE agent_steps SET status = 'failed', output_json = ?1, error = ?2, duration_ms = ?3
         WHERE id = ?4 AND user_id = ?5`
    ).bind(JSON.stringify({ attempts, max_attempts: maxAttempts }), error, durationMs, stepId, userId).run();

    // 任务执行期间用户可能已经点了暂停/取消。此时只记录事实，不能把目标重新推回 active。
    if (holdStatus) {
        await db.prepare(
            `UPDATE agent_runs SET status = ?1, error = ?2, current_task_id = NULL,
                lease_until = NULL, next_run_at = NULL, updated_at = datetime('now', '+8 hours')
             WHERE id = ?3 AND user_id = ?4`
        ).bind(
            holdStatus === 'cancelled' ? 'cancelled' : (holdStatus === 'completed' ? 'completed' : 'paused'),
            error,
            runId,
            userId
        ).run();
        if (holdStatus !== 'deleted') {
            await touchGoal(db, userId, goalId, { error, last_run_id: runId });
        }
        return exhausted;
    }
    if (exhausted) {
        await db.prepare(
            `UPDATE agent_runs SET status = 'failed', error = ?1, current_task_id = NULL, lease_until = NULL, next_run_at = NULL, finished_at = datetime('now', '+8 hours'), updated_at = datetime('now', '+8 hours') WHERE id = ?2 AND user_id = ?3`
        ).bind(error, runId, userId).run();
        await touchGoal(db, userId, goalId, { status: 'failed', error, last_run_id: runId });
    } else {
        await db.prepare(
            `UPDATE agent_runs SET status = 'queued', error = ?1, current_task_id = NULL, lease_until = NULL, next_run_at = datetime('now', '+8 hours', '+120 seconds'), updated_at = datetime('now', '+8 hours') WHERE id = ?2 AND user_id = ?3`
        ).bind(error, runId, userId).run();
        await touchGoal(db, userId, goalId, { status: 'active', error: '', last_run_id: runId });
    }
    return exhausted;
}

/**
 * 推进一个任务。调用方负责把 goal 置为 active；本函数不做入口状态校验。
 * @returns {Promise<object>} 目标快照
 */
export async function runNextTask(options) {
    const {
        env,
        db,
        userId,
        goalId,
        trigger = 'continue',
        agentRunner = runAgent,
        checkpointModel,
        planModel,
        sendBot
    } = options || {};

    const goalRow = await getGoalRow(db, userId, goalId);
    if (!goalRow) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    if (goalRow.status === 'paused') throw new AgentError(409, '目标已暂停，请先恢复', 'GOAL_PAUSED');
    if (goalRow.status === 'completed') throw new AgentError(409, '目标已经完成', 'GOAL_COMPLETED');
    if (goalRow.status === 'cancelled') throw new AgentError(409, '目标已取消', 'GOAL_CANCELLED');
    if (goalRow.status === 'failed') throw new AgentError(409, '目标已失败，请先重试失败任务或重新规划', 'GOAL_FAILED');
    if (goalRow.status === 'draft') throw new AgentError(409, '请先生成计划', 'GOAL_NO_PLAN');
    if (['active', 'planned'].includes(goalRow.status) && budgetExceeded(goalRow)) {
        await failForBudget(db, userId, goalId, goalRow, env);
        return snapshotFor(db, userId, goalId);
    }

    let tasks = await listTasks(db, userId, goalId);
    if (!tasks.length) throw new AgentError(409, '目标还没有任务', 'GOAL_NO_TASKS');
    if (tasks.some((item) => item.status === 'blocked')) {
        throw new AgentError(409, '有阻塞任务，请先重新规划剩余任务', 'GOAL_BLOCKED');
    }

    // 并发调用保护：另一个请求/cron 正在跑同一个任务时，不能把它当成“中断”重置。
    // 只有超过 120s 没有更新的 running 才可能是进程崩溃留下的，才允许回收。
    const running = tasks.filter((task) => task.status === 'running');
    if (running.some(isLiveRunningTask)) {
        return snapshotFor(db, userId, goalId);
    }
    if (running.length) {
        await db.prepare(
            `UPDATE agent_tasks SET status = 'pending', error = '上次执行中断，已重新排队',
                started_at = NULL, updated_at = datetime('now', '+8 hours')
             WHERE goal_id = ?1 AND user_id = ?2 AND status = 'running'`
        ).bind(goalId, userId).run();
        tasks = await listTasks(db, userId, goalId);
    }

    if (allTasksCompleted(tasks)) {
        const active = await getActiveRunRow(db, userId, goalId);
        const run = active || await getRunRow(db, userId, goalId);
        if (run) await finishGoal(db, userId, goalId, run.id, tasks, 'completed', '', env, goalRow.title);
        return snapshotFor(db, userId, goalId);
    }

    const readyTasks = allReadyTasks(tasks, MAX_CONCURRENT_WORKERS);
    if (!readyTasks.length) {
        const failed = tasks.find((item) => ['failed', 'blocked'].includes(item.status));
        const message = failed
            ? '有任务失败，依赖无法继续；请重试失败任务或重新规划'
            : '任务依赖未满足，暂时没有可执行任务';
        const active = await getActiveRunRow(db, userId, goalId);
        const run = active || await getRunRow(db, userId, goalId);
        if (run) await finishGoal(db, userId, goalId, run.id, tasks, 'failed', message, env, goalRow.title);
        return snapshotFor(db, userId, goalId);
    }

    // Router 阶段：原子认领并发就绪任务
    const claimedTasks = [];
    for (const t of readyTasks) {
        const claimed = await db.prepare(
            `UPDATE agent_tasks SET status = 'running', error = '', started_at = datetime('now', '+8 hours'),
                updated_at = datetime('now', '+8 hours')
             WHERE id = ?1 AND user_id = ?2 AND status IN ('pending', 'ready')`
        ).bind(t.id, userId).run();
        if (claimed.meta && Number(claimed.meta.changes) > 0) claimedTasks.push(t);
    }
    if (!claimedTasks.length) {
        return snapshotFor(db, userId, goalId);
    }

    const run = await ensureRun(db, userId, goalId, trigger);
    let nextSeq = await nextStepSeq(db, run.id);

    await db.prepare(
        `UPDATE agent_runs SET status = 'running', current_task_id = ?1, error = '',
            lease_until = ${TASK_LEASE_SQL}, next_run_at = NULL,
            updated_at = ${TASK_STARTED_AT_SQL} WHERE id = ?2 AND user_id = ?3`
    ).bind(claimedTasks[0].id, run.id, userId).run();
    await touchGoal(db, userId, goalId, { status: 'active', error: '', last_run_id: run.id });

    // Worker 阶段：Router 派发独立 Worker 并发推进
    const userPreferences = await loadPreferencePrompt(db, userId).catch(() => '');
    const executeWorker = async (task, idx) => {
        const workerId = `Worker-${idx + 1}`;
        const stepSeq = nextSeq + idx;
        const step = await db.prepare(
            `INSERT INTO agent_steps (run_id, goal_id, task_id, user_id, seq, step_type, status, input_json)
             VALUES (?1, ?2, ?3, ?4, ?5, 'task', 'running', ?6)
             RETURNING *`
        ).bind(run.id, goalId, task.id, userId, stepSeq, JSON.stringify({
            worker_id: workerId,
            title: task.title,
            description: task.description,
            depends_on: task.depends_on
        })).first();

        const started = Date.now();
        let result;
        let failure = '';
        try {
            result = await withTimeout(agentRunner({
                env,
                db,
                userId,
                question: taskPrompt(goalRow, task, tasks, userPreferences),
                history: [],
                extraTools: [PROPOSE_WRITE_TOOL, PROPOSE_CHOICE_TOOL, ...WEB_AGENT_TOOLS],
                extraInstructions: PROPOSE_WRITE_INSTRUCTIONS,
                executeTool: (toolDb, toolUserId, name, args) => {
                    if (name === 'web_search' || name === 'fetch_url') return runWebTool(env, name, args);
                    if (name === 'propose_write' || name === 'propose_choice') {
                        return runProposalTool(toolDb, toolUserId, goalId, task.id, args, env);
                    }
                    return executeAgentTool(toolDb, toolUserId, name, args);
                }
            }), TASK_TIMEOUT_MS, 'TASK_TIMEOUT');
            if (!result || typeof result.reply !== 'string' || !result.reply.trim()) {
                failure = (result && result.stopReason) ? `任务没有产出（${result.stopReason}）` : '任务没有产出';
            }
        } catch (err) {
            failure = err && err.message ? err.message : '任务执行失败';
        }
        return { task, step, result, failure, durationMs: Date.now() - started, workerId };
    };

    const outcomes = await Promise.all(claimedTasks.map((t, i) => executeWorker(t, i)));

    // Router 阶段：状态汇总、检查点触发与流转
    const latestGoal = await getGoalRow(db, userId, goalId);
    const latestStatus = latestGoal ? latestGoal.status : 'deleted';
    const holdStatus = ['paused', 'cancelled', 'completed', 'failed', 'waiting_approval'].includes(latestStatus) ? latestStatus : '';
    let hasExhausted = false;
    let anyFailed = false;
    const completedBatch = [];

    // Phase 1：原子提交所有并发 Worker 产出与执行用量（绝不在此阶段做 replan）
    for (const outcome of outcomes) {
        const { task, step, result, failure, durationMs, workerId } = outcome;
        if (failure) {
            anyFailed = true;
            const attempts = Number(task.attempts || 0) + 1;
            const exhausted = await markTaskFailure(db, userId, goalId, run.id, task, step.id, attempts, failure.slice(0, 300), durationMs, holdStatus);
            await addBudgetUsage(db, userId, goalId, 0, durationMs);
            if (exhausted && !holdStatus) hasExhausted = true;
        } else {
            const output = cleanMultiline(result.reply, 8000);
            await db.prepare(
                `UPDATE agent_tasks SET status = 'completed', output_md = ?1, error = '', finished_at = datetime('now', '+8 hours'),
                    updated_at = datetime('now', '+8 hours') WHERE id = ?2 AND user_id = ?3`
            ).bind(output, task.id, userId).run();
            await db.prepare(
                `UPDATE agent_steps SET status = 'completed', output_json = ?1, duration_ms = ?2
                 WHERE id = ?3 AND user_id = ?4`
            ).bind(JSON.stringify({
                worker_id: workerId,
                reply: output,
                sources: result.sources || [],
                tool_trace: result.toolTrace || [],
                stop_reason: result.stopReason || 'final'
            }), durationMs, step.id, userId).run();
            await addBudgetUsage(db, userId, goalId, Array.isArray(result.toolTrace) ? result.toolTrace.length : 0, durationMs);
            completedBatch.push({ task, output });
        }
    }

    if (hasExhausted) {
        await notifyAgentUser(env, db, userId, { title: '目标失败', body: '「' + notificationText(goalRow.title, 60) + '」重试次数已用完，去查看原因。', tag: 'agent-goal-' + goalId }).catch(() => {});
        return snapshotFor(db, userId, goalId);
    }

    // Phase 2：Router 级批次收敛决策，消除并发重规划竞争
    // 1. 阻塞检测：任何成功任务标记了受阻，即刻暂停目标
    for (const item of completedBatch) {
        if (/BLOCKED|blocked|受阻|无法继续/.test(item.output)) {
            await db.prepare("UPDATE agent_tasks SET status = 'blocked', updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2").bind(item.task.id, userId).run();
            await pauseGoal(db, userId, goalId);
            await notifyAgentUser(env, db, userId, { title: '目标已暂停', body: '「' + notificationText(goalRow.title, 60) + '」的任务结果标记为阻塞，去查看。', tag: 'agent-goal-' + goalId }).catch(() => {});
            return snapshotFor(db, userId, goalId);
        }
    }

    // 2. 检查点与重规划：只有当前批次全部 Worker 成功且无等待重试任务时，才对后续剩余任务做单次统一评估
    if (!anyFailed && !holdStatus && completedBatch.length > 0) {
        const remainingTasks = await listTasks(db, userId, goalId);
        const pendingRemaining = remainingTasks.filter((item) => ['pending', 'ready'].includes(item.status));
        if (pendingRemaining.length > 0 && !remainingTasks.some((t) => t.status === 'running')) {
            const lastCompleted = completedBatch[completedBatch.length - 1];
            const checkpoint = await checkpointAfterTask({
                env, db, userId, goalId, task: lastCompleted.task, output: lastCompleted.output, checkpointModel, planModel
            });
            if (checkpoint.action === 'blocked') {
                await db.prepare("UPDATE agent_tasks SET status = 'blocked', updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2").bind(lastCompleted.task.id, userId).run();
                await pauseGoal(db, userId, goalId);
                await notifyAgentUser(env, db, userId, { title: '目标已暂停', body: '「' + notificationText(goalRow.title, 60) + '」的任务结果标记为阻塞，去查看。', tag: 'agent-goal-' + goalId }).catch(() => {});
                return snapshotFor(db, userId, goalId);
            }
            if (checkpoint.action === 'replan') {
                console.log('[agent] replanned remaining goal=' + goalId + ' tasks=' + checkpoint.tasks);
            }
        }
    }

    const runStatus = holdStatus === 'cancelled' ? 'cancelled'
        : (holdStatus === 'failed' ? 'failed'
            : (holdStatus === 'completed' ? 'completed'
                : (holdStatus === 'waiting_approval' ? 'waiting_approval' : (holdStatus ? 'paused' : 'queued'))));
    const maxSleep = Math.max(0, ...completedBatch.map((item) => parseSleepDirective(item.output)));
    const nextRunAt = runStatus === 'queued'
        ? (maxSleep > 0 ? `datetime('now', '+8 hours', '+${maxSleep} seconds')` : "datetime('now', '+8 hours', '+10 seconds')")
        : 'NULL';
    await db.prepare(
        `UPDATE agent_runs SET status = ?1, current_task_id = NULL, error = '',
            lease_until = NULL, next_run_at = ${nextRunAt},
            updated_at = datetime('now', '+8 hours') WHERE id = ?2 AND user_id = ?3`
    ).bind(runStatus, run.id, userId).run();

    tasks = await listTasks(db, userId, goalId);
    if (allTasksCompleted(tasks) && ['active', 'planned', 'paused'].includes(latestStatus)) {
        if (await blockCompletionIfNeeded({ env, db, userId, goalId, goal: latestGoal || goalRow, tasks, deps: { sendBot } })) return snapshotFor(db, userId, goalId);
        await finishGoal(db, userId, goalId, run.id, tasks, 'completed', '', env, goalRow.title);
    } else if (holdStatus) {
        if (holdStatus !== 'deleted') {
            await touchGoal(db, userId, goalId, { last_run_id: run.id });
        }
    } else {
        await touchGoal(db, userId, goalId, { status: 'active', error: '', last_run_id: run.id });
    }
    return snapshotFor(db, userId, goalId);
}

function snapshotFor(db, userId, goalId) {
    return getSnapshot(db, userId, goalId);
}

// 目标生命周期（startGoal / continueGoal / pauseGoal / completeGoal / retryTask 等）
// 已下沉至 ./agent-lifecycle.js，在文件顶部已统一重导出。
