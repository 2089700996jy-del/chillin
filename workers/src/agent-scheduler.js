/**
 * Agent 后台续跑调度器：关闭页面后，已开始的目标仍能按分钟推进一个任务。
 *
 * 只使用 0038 已有的 agent_runs.lease_until / next_run_at，不新增迁移：
 * - 任务完成后把 run 置回 queued，并写一个近未来的 next_run_at；
 * - 每分钟 cron 原子认领一条到期 run，只推进一个任务，避免一次 cron 把整目标跑完；
 * - 租约 180s 覆盖单任务 50s 超时；进程中断后租约过期，下一次 tick 会回收；
 * - 只认领 status='active' 且未软删的目标；暂停/审批/完成的目标不会被后台偷跑。
 */
import { runNextTask } from './agent-executor.js';
import { AgentError, getGoalRow, listTasks, getActiveRunRow, getSnapshot, touchGoal } from './agent-store.js';

/** 每次 cron 最多推进一个目标，给 Bot 长轮询留出预算，也避免重复烧模型 */
export const AUTO_RESUME_LIMIT = 1;
/** 单任务 50s 超时 + DB 余量；租约过期才允许另一个 Worker 回收（SQL 中的 180 与此同步） */
export const AUTO_LEASE_SECONDS = 180;
/** 失败重试的退避；比 cron 周期长，避免模型抖动时每分钟重试（SQL 中的 120 与此同步） */
export const AUTO_RETRY_DELAY_SECONDS = 120;

function capText(value, max = 300) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * 只排队、不执行：给 Bot 这类不能长时间阻塞的入口用。
 * 真正推进交给每分钟 cron 的 claimDueAgentRun，回复可以立即返回。
 */
export async function queueGoal(db, userId, goalId, trigger = 'bot') {
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    if (['completed', 'cancelled'].includes(goal.status)) {
        throw new AgentError(409, '目标已经结束', 'GOAL_CLOSED');
    }
    if (goal.status === 'failed') {
        throw new AgentError(409, '目标已失败，请先重试失败任务或重新规划', 'GOAL_FAILED');
    }
    if (goal.status === 'draft') throw new AgentError(409, '请先生成计划', 'GOAL_NO_PLAN');
    if (goal.status === 'waiting_approval') {
        throw new AgentError(409, '目标正在等待审批，请先处理审批', 'GOAL_WAITING_APPROVAL');
    }
    const tasks = await listTasks(db, userId, goalId);
    if (!tasks.length) throw new AgentError(409, '目标还没有任务', 'GOAL_NO_TASKS');
    if (tasks.some((item) => item.status === 'blocked')) {
        throw new AgentError(409, '有阻塞任务，请先重新规划剩余任务', 'GOAL_BLOCKED');
    }

    const active = await getActiveRunRow(db, userId, goalId);
    if (active && active.status === 'running') {
        return { queued: false, reason: 'running', snapshot: await getSnapshot(db, userId, goalId) };
    }
    if (active) {
        await db.prepare(
            `UPDATE agent_runs SET status = 'queued', trigger = ?1,
                next_run_at = datetime('now', '+8 hours', '-1 seconds'),
                lease_until = NULL, current_task_id = NULL, error = '',
                updated_at = datetime('now', '+8 hours')
             WHERE id = ?2 AND user_id = ?3`
        ).bind(trigger, active.id, userId).run();
        await touchGoal(db, userId, goalId, { status: 'active', error: '', last_run_id: active.id });
        return { queued: true, run_id: Number(active.id), snapshot: await getSnapshot(db, userId, goalId) };
    }

    const run = await db.prepare(
        `INSERT INTO agent_runs (goal_id, user_id, trigger, status, next_run_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'queued', datetime('now', '+8 hours', '-1 seconds'),
                 datetime('now', '+8 hours'), datetime('now', '+8 hours'))
         RETURNING *`
    ).bind(goalId, userId, trigger).first();
    await touchGoal(db, userId, goalId, { status: 'active', error: '', last_run_id: run.id });
    return { queued: true, run_id: Number(run.id), snapshot: await getSnapshot(db, userId, goalId) };
}

/**
 * 原子认领一条可运行的 run。
 * 同时覆盖两类：
 * 1. 正常排队且 next_run_at 已到期；
 * 2. 上一次执行崩溃、租约已过期的 running。
 */
export async function claimDueAgentRun(db) {
    if (!db) return null;
    const candidate = await db.prepare(
        `SELECT r.id
         FROM agent_runs r
         JOIN agent_goals g ON g.id = r.goal_id AND g.user_id = r.user_id
         WHERE g.status = 'active'
           AND COALESCE(g.is_deleted, 0) = 0
           AND (
                (r.status = 'queued'
                 AND COALESCE(r.next_run_at, r.created_at) <= datetime('now', '+8 hours')
                 AND (r.lease_until IS NULL OR r.lease_until <= datetime('now', '+8 hours')))
                OR
                (r.status = 'running'
                 AND (r.lease_until IS NULL OR r.lease_until <= datetime('now', '+8 hours')))
           )
         ORDER BY COALESCE(r.next_run_at, r.created_at) ASC, r.id ASC
         LIMIT 1`
    ).first();
    if (!candidate) return null;

    const claimed = await db.prepare(
        `UPDATE agent_runs
         SET status = 'running',
             trigger = 'auto',
             lease_until = datetime('now', '+8 hours', '+180 seconds'),
             next_run_at = NULL,
             error = '',
             updated_at = datetime('now', '+8 hours')
         WHERE id = ?1
           AND (
                (status = 'queued'
                 AND COALESCE(next_run_at, created_at) <= datetime('now', '+8 hours')
                 AND (lease_until IS NULL OR lease_until <= datetime('now', '+8 hours')))
                OR
                (status = 'running'
                 AND (lease_until IS NULL OR lease_until <= datetime('now', '+8 hours')))
           )
           AND EXISTS (
                SELECT 1 FROM agent_goals g
                WHERE g.id = agent_runs.goal_id
                  AND g.user_id = agent_runs.user_id
                  AND g.status = 'active'
                  AND COALESCE(g.is_deleted, 0) = 0
           )`
    ).bind(candidate.id).run();
    if (!claimed.meta || Number(claimed.meta.changes) === 0) return null;
    return db.prepare('SELECT * FROM agent_runs WHERE id = ?1').bind(candidate.id).first();
}

async function requeueAfterCrash(db, run, error) {
    const message = capText(error && error.message ? error.message : error, 300);
    await db.prepare(
        `UPDATE agent_runs
         SET status = 'queued',
             lease_until = NULL,
             next_run_at = datetime('now', '+8 hours', '+120 seconds'),
             error = ?1,
             updated_at = datetime('now', '+8 hours')
         WHERE id = ?2 AND user_id = ?3 AND status = 'running'`
    ).bind(message, run.id, run.user_id).run();
}

/**
 * 推进最多 limit 个到期目标，每个目标只跑一个任务。
 * agentRunner 仅用于测试注入；生产不传，走真实只读 Agent 循环。
 */
export async function runAutoResume(env, options = {}) {
    const db = env && env.DB;
    if (!db) return { processed: 0, failed: 0, skipped: true };
    if (!env.LLM_API_KEY && !options.agentRunner) return { processed: 0, failed: 0, skipped: true };

    const limit = Math.max(1, Math.min(3, Number(options.limit || AUTO_RESUME_LIMIT)));
    let processed = 0;
    let failed = 0;
    for (let i = 0; i < limit; i += 1) {
        let run = null;
        try {
            run = await claimDueAgentRun(db);
        } catch (err) {
            console.error('[agent-auto] claim failed:', err && err.message ? err.message : err);
            break;
        }
        if (!run) break;
        processed += 1;
        try {
            await runNextTask({
                env,
                db,
                userId: Number(run.user_id),
                goalId: Number(run.goal_id),
                trigger: 'auto',
                agentRunner: options.agentRunner
            });
            console.log('[agent-auto] advanced goal=' + run.goal_id + ' run=' + run.id);
        } catch (err) {
            failed += 1;
            console.error('[agent-auto] run failed goal=' + run.goal_id + ':', err && err.message ? err.message : err);
            try { await requeueAfterCrash(db, run, err); }
            catch (releaseErr) {
                console.error('[agent-auto] release failed goal=' + run.goal_id + ':', releaseErr && releaseErr.message ? releaseErr.message : releaseErr);
            }
        }
    }
    return { processed, failed, skipped: false };
}
