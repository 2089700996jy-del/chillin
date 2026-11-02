/**
 * Agent 目标执行器：一次只推进一个任务，任务结果写入 agent_tasks / agent_steps。
 *
 * 设计约束：
 * - 不把整个目标塞进一次 Worker 请求；每次 API 调用只跑一个任务，页面关闭后状态仍在；
 * - 任务依赖只按 seq 检查，先顺序执行，不做并行；
 * - 失败按 max_attempts 重试，耗尽后目标进入 failed，等待用户重试或改计划；
 * - 执行只调用阶段 1 的只读工具循环，不在这里写业务数据。
 */
import { runAgent } from './ai-runtime.js';
import {
    AgentError,
    getGoalRow,
    listTasks,
    getActiveRunRow,
    getRunRow,
    getSnapshot,
    nextReadyTask,
    allTasksCompleted,
    touchGoal,
    cleanMultiline
} from './agent-store.js';

const TASK_TIMEOUT_MS = 50000;

function withTimeout(promise, ms, message) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1, Number(ms) || 1));
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function taskPrompt(goal, task, tasks) {
    const bySeq = new Map(tasks.map((item) => [Number(item.seq), item]));
    const deps = (task.depends_on || [])
        .map((seq) => bySeq.get(Number(seq)))
        .filter((item) => item && item.status === 'completed')
        .map((item) => `【${item.title}】\n${item.output_md}`)
        .join('\n\n')
        .slice(-6000);

    return [
        '你正在执行一个长期目标中的一个任务。',
        `目标：${goal.title}`,
        goal.description ? `目标说明：${goal.description}` : '',
        `当前任务（第 ${task.seq + 1} 个）：${task.title}`,
        task.description ? `任务要求：${task.description}` : '',
        deps ? `已完成的前置结果：\n${deps}` : '',
        '只完成当前任务，不要提前做后续任务，也不要声称已经写入任何数据。',
        '直接输出可以交给下一个任务使用的 Markdown 结果。',
        '如果任务涉及用户的记录、主题、偏好或统计，必须先调用只读工具取真实数据，并保留 [类型#id] 引用；没有证据就说明不足，不要编造。',
        '如果信息不足以完成，明确写出缺什么，不要用空话填充。'
    ].filter(Boolean).join('\n');
}

function finalResult(tasks) {
    const parts = tasks
        .filter((task) => task.status === 'completed' && task.output_md)
        .sort((a, b) => a.seq - b.seq)
        .map((task) => `## ${task.title}\n\n${task.output_md}`);
    return cleanMultiline(parts.join('\n\n'), 30000);
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

async function finishGoal(db, userId, goalId, runId, tasks, status = 'completed', error = '') {
    const result = finalResult(tasks);
    const completedAt = "datetime('now', '+8 hours')";
    await db.prepare(
        `UPDATE agent_goals SET status = ?1, result_md = ?2, error = ?3, last_run_id = ?4,
            completed_at = ${completedAt}, updated_at = ${completedAt}
         WHERE id = ?5 AND user_id = ?6 AND COALESCE(is_deleted, 0) = 0`
    ).bind(status, result, error, runId, goalId, userId).run();
    await db.prepare(
        `UPDATE agent_runs SET status = ?1, result_md = ?2, error = ?3, current_task_id = NULL,
            finished_at = ${completedAt}, updated_at = ${completedAt}
         WHERE id = ?4 AND user_id = ?5`
    ).bind(status === 'completed' ? 'completed' : 'failed', result, error, runId, userId).run();
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
                updated_at = datetime('now', '+8 hours') WHERE id = ?3 AND user_id = ?4`
        ).bind(holdStatus === 'cancelled' ? 'cancelled' : 'paused', error, runId, userId).run();
        if (holdStatus !== 'deleted') {
            await touchGoal(db, userId, goalId, { error, last_run_id: runId });
        }
        return exhausted;
    }
    if (exhausted) {
        await db.prepare(
            `UPDATE agent_runs SET status = 'failed', error = ?1, current_task_id = NULL,
                finished_at = datetime('now', '+8 hours'), updated_at = datetime('now', '+8 hours')
             WHERE id = ?2 AND user_id = ?3`
        ).bind(error, runId, userId).run();
        await touchGoal(db, userId, goalId, { status: 'failed', error, last_run_id: runId });
    } else {
        await db.prepare(
            `UPDATE agent_runs SET status = 'queued', error = ?1, current_task_id = NULL,
                updated_at = datetime('now', '+8 hours') WHERE id = ?2 AND user_id = ?3`
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
        agentRunner = runAgent
    } = options || {};

    const goalRow = await getGoalRow(db, userId, goalId);
    if (!goalRow) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    if (goalRow.status === 'paused') throw new AgentError(409, '目标已暂停，请先恢复', 'GOAL_PAUSED');
    if (goalRow.status === 'completed') throw new AgentError(409, '目标已经完成', 'GOAL_COMPLETED');
    if (goalRow.status === 'cancelled') throw new AgentError(409, '目标已取消', 'GOAL_CANCELLED');
    if (goalRow.status === 'failed') throw new AgentError(409, '目标已失败，请先重试失败任务或重新规划', 'GOAL_FAILED');
    if (goalRow.status === 'draft') throw new AgentError(409, '请先生成计划', 'GOAL_NO_PLAN');

    let tasks = await listTasks(db, userId, goalId);
    if (!tasks.length) throw new AgentError(409, '目标还没有任务', 'GOAL_NO_TASKS');

    // 上一次执行中断：把遗留的 running 任务放回队列，而不是假装它成功了
    const interrupted = tasks.find((task) => task.status === 'running');
    if (interrupted) {
        await db.prepare(
            `UPDATE agent_tasks SET status = 'pending', error = '上次执行中断，已重新排队',
                started_at = NULL, updated_at = datetime('now', '+8 hours')
             WHERE id = ?1 AND user_id = ?2`
        ).bind(interrupted.id, userId).run();
        tasks = await listTasks(db, userId, goalId);
    }

    if (allTasksCompleted(tasks)) {
        const active = await getActiveRunRow(db, userId, goalId);
        const run = active || await getRunRow(db, userId, goalId);
        if (run) await finishGoal(db, userId, goalId, run.id, tasks, 'completed');
        return snapshotFor(db, userId, goalId);
    }

    const task = nextReadyTask(tasks);
    if (!task) {
        const failed = tasks.find((item) => ['failed', 'blocked'].includes(item.status));
        const message = failed
            ? '有任务失败，依赖无法继续；请重试失败任务或重新规划'
            : '任务依赖未满足，暂时没有可执行任务';
        const active = await getActiveRunRow(db, userId, goalId);
        const run = active || await getRunRow(db, userId, goalId);
        if (run) await finishGoal(db, userId, goalId, run.id, tasks, 'failed', message);
        return snapshotFor(db, userId, goalId);
    }

    const started = Date.now();

    // 原子认领：两个并发的 continue 只能有一个把任务从 pending 改成 running。
    // 后到的请求拿不到任务就直接返回当前快照，避免同一任务被跑两遍、产生重复步骤。
    const claimed = await db.prepare(
        `UPDATE agent_tasks SET status = 'running', error = '', started_at = datetime('now', '+8 hours'),
            updated_at = datetime('now', '+8 hours')
         WHERE id = ?1 AND user_id = ?2 AND status IN ('pending', 'ready')`
    ).bind(task.id, userId).run();
    if (!claimed.meta || Number(claimed.meta.changes) === 0) {
        return snapshotFor(db, userId, goalId);
    }

    const run = await ensureRun(db, userId, goalId, trigger);
    const stepSeq = await nextStepSeq(db, run.id);
    const step = await db.prepare(
        `INSERT INTO agent_steps (run_id, goal_id, task_id, user_id, seq, step_type, status, input_json)
         VALUES (?1, ?2, ?3, ?4, ?5, 'task', 'running', ?6)
         RETURNING *`
    ).bind(run.id, goalId, task.id, userId, stepSeq, JSON.stringify({
        title: task.title,
        description: task.description,
        depends_on: task.depends_on
    })).first();

    await db.prepare(
        `UPDATE agent_runs SET status = 'running', current_task_id = ?1, error = '',
            updated_at = datetime('now', '+8 hours') WHERE id = ?2 AND user_id = ?3`
    ).bind(task.id, run.id, userId).run();
    await touchGoal(db, userId, goalId, { status: 'active', error: '', last_run_id: run.id });

    let result;
    let failure = '';
    try {
        result = await withTimeout(agentRunner({
            env,
            db,
            userId,
            question: taskPrompt(goalRow, task, tasks),
            history: []
        }), TASK_TIMEOUT_MS, 'TASK_TIMEOUT');
        if (!result || typeof result.reply !== 'string' || !result.reply.trim()) {
            failure = (result && result.stopReason) ? `任务没有产出（${result.stopReason}）` : '任务没有产出';
        }
    } catch (err) {
        failure = err && err.message ? err.message : '任务执行失败';
    }

    const durationMs = Date.now() - started;
    const latestGoal = await getGoalRow(db, userId, goalId);
    const latestStatus = latestGoal ? latestGoal.status : 'deleted';
    const holdStatus = ['paused', 'cancelled', 'completed', 'failed'].includes(latestStatus) ? latestStatus : '';
    if (failure) {
        const attempts = Number(task.attempts || 0) + 1;
        await markTaskFailure(db, userId, goalId, run.id, task, step.id, attempts, failure.slice(0, 300), durationMs, holdStatus);
        return snapshotFor(db, userId, goalId);
    }

    const output = cleanMultiline(result.reply, 8000);
    await db.prepare(
        `UPDATE agent_tasks SET status = 'completed', output_md = ?1, error = '', finished_at = datetime('now', '+8 hours'),
            updated_at = datetime('now', '+8 hours') WHERE id = ?2 AND user_id = ?3`
    ).bind(output, task.id, userId).run();
    await db.prepare(
        `UPDATE agent_steps SET status = 'completed', output_json = ?1, duration_ms = ?2
         WHERE id = ?3 AND user_id = ?4`
    ).bind(JSON.stringify({
        reply: output,
        sources: result.sources || [],
        tool_trace: result.toolTrace || [],
        stop_reason: result.stopReason || 'final'
    }), durationMs, step.id, userId).run();
    const runStatus = holdStatus === 'cancelled' ? 'cancelled'
        : (holdStatus === 'failed' ? 'failed' : (holdStatus ? 'paused' : 'queued'));
    await db.prepare(
        `UPDATE agent_runs SET status = ?1, current_task_id = NULL, error = '',
            updated_at = datetime('now', '+8 hours') WHERE id = ?2 AND user_id = ?3`
    ).bind(runStatus, run.id, userId).run();

    tasks = await listTasks(db, userId, goalId);
    if (allTasksCompleted(tasks) && ['active', 'planned', 'paused'].includes(latestStatus)) {
        await finishGoal(db, userId, goalId, run.id, tasks, 'completed');
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

export async function startGoal(options) {
    const { db, userId, goalId } = options || {};
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    if (['completed', 'cancelled'].includes(goal.status)) throw new AgentError(409, '目标已经结束', 'GOAL_CLOSED');
    if (goal.status === 'failed') throw new AgentError(409, '目标已失败，请先重试失败任务或重新规划', 'GOAL_FAILED');
    const tasks = await listTasks(db, userId, goalId);
    if (!tasks.length) throw new AgentError(409, '请先生成计划', 'GOAL_NO_PLAN');
    await touchGoal(db, userId, goalId, { status: 'active', error: '' });
    return runNextTask({ ...options, trigger: options.trigger || 'manual' });
}

export async function continueGoal(options) {
    const { db, userId, goalId } = options || {};
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    const tasks = await listTasks(db, userId, goalId);
    if (!tasks.length) throw new AgentError(409, '请先生成计划', 'GOAL_NO_PLAN');
    if (goal.status === 'paused') {
        await touchGoal(db, userId, goalId, { status: 'active', error: '' });
    } else if (!['active', 'planned'].includes(goal.status)) {
        throw new AgentError(409, '当前目标不能继续执行', 'GOAL_NOT_CONTINUABLE');
    }
    return runNextTask({ ...options, trigger: options.trigger || 'resume' });
}

export async function pauseGoal(db, userId, goalId) {
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    if (['completed', 'cancelled'].includes(goal.status)) throw new AgentError(409, '目标已经结束', 'GOAL_CLOSED');
    await touchGoal(db, userId, goalId, { status: 'paused' });
    await db.prepare(
        `UPDATE agent_runs SET status = 'paused', updated_at = datetime('now', '+8 hours')
         WHERE goal_id = ?1 AND user_id = ?2 AND status IN ('queued', 'running', 'waiting_approval')`
    ).bind(goalId, userId).run();
    return snapshotFor(db, userId, goalId);
}

export async function completeGoal(db, userId, goalId) {
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    if (['completed', 'cancelled'].includes(goal.status)) throw new AgentError(409, '目标已经结束', 'GOAL_CLOSED');
    const tasks = await listTasks(db, userId, goalId);
    const run = await getActiveRunRow(db, userId, goalId) || await getRunRow(db, userId, goalId);
    const result = finalResult(tasks);
    await db.prepare(
        `UPDATE agent_goals SET status = 'completed', result_md = ?1, error = '', completed_at = datetime('now', '+8 hours'),
            updated_at = datetime('now', '+8 hours') WHERE id = ?2 AND user_id = ?3`
    ).bind(result, goalId, userId).run();
    if (run) {
        await db.prepare(
            `UPDATE agent_runs SET status = 'completed', result_md = ?1, current_task_id = NULL,
                finished_at = datetime('now', '+8 hours'), updated_at = datetime('now', '+8 hours')
             WHERE id = ?2 AND user_id = ?3`
        ).bind(result, run.id, userId).run();
    }
    return snapshotFor(db, userId, goalId);
}

export async function retryTask(db, userId, goalId, taskId) {
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    const row = await db.prepare(
        'SELECT * FROM agent_tasks WHERE id = ?1 AND goal_id = ?2 AND user_id = ?3'
    ).bind(taskId, goalId, userId).first();
    if (!row) throw new AgentError(404, '任务不存在', 'TASK_NOT_FOUND');
    if (!['failed', 'blocked'].includes(row.status)) throw new AgentError(409, '只有失败的任务可以重试', 'TASK_NOT_FAILED');
    await db.prepare(
        `UPDATE agent_tasks SET status = 'pending', attempts = 0, error = '', started_at = NULL, finished_at = NULL,
            updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2`
    ).bind(taskId, userId).run();
    await touchGoal(db, userId, goalId, { status: 'active', error: '' });
    return snapshotFor(db, userId, goalId);
}
