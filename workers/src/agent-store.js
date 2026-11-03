/**
 * Agent 目标系统的数据访问与格式化。
 *
 * 这里只做 D1 查询和行转换，不生成计划、不执行任务；所有查询都按 user_id 隔离。
 * 任务依赖存 JSON 数组（seq），执行器只按完成依赖挑选下一个任务。
 */

export const GOAL_STATUSES = ['draft', 'planned', 'active', 'paused', 'waiting_approval', 'completed', 'failed', 'cancelled'];
export const TASK_STATUSES = ['pending', 'ready', 'running', 'waiting_approval', 'completed', 'failed', 'skipped', 'blocked'];
export const RUN_STATUSES = ['queued', 'running', 'waiting_approval', 'paused', 'completed', 'failed', 'cancelled'];
export const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting_approval', 'paused'];
export const MAX_TASKS = 8;

export class AgentError extends Error {
    constructor(status, message, code = 'AGENT_ERROR') {
        super(message);
        this.name = 'AgentError';
        this.status = status;
        this.code = code;
    }
}

export function safeJson(text, fallback) {
    if (text == null || text === '') return fallback;
    if (typeof text === 'object') return text;
    try {
        const parsed = JSON.parse(text);
        return parsed == null ? fallback : parsed;
    } catch (_) {
        return fallback;
    }
}

export function cleanText(value, max = 500) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

export function cleanMultiline(value, max = 8000) {
    return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim().slice(0, max);
}

export function formatGoal(row, tasks = []) {
    if (!row) return null;
    const counts = { total: tasks.length, completed: 0, failed: 0, pending: 0, running: 0 };
    for (const task of tasks) {
        if (task.status === 'completed') counts.completed += 1;
        else if (task.status === 'failed' || task.status === 'blocked') counts.failed += 1;
        else if (task.status === 'running' || task.status === 'waiting_approval') counts.running += 1;
        else counts.pending += 1;
    }
    return {
        id: Number(row.id),
        title: row.title || '',
        description: row.description || '',
        status: row.status || 'draft',
        plan_version: Number(row.plan_version || 0),
        result_md: row.result_md || '',
        error: row.error || '',
        last_run_id: row.last_run_id == null ? null : Number(row.last_run_id),
        created_at: row.created_at || '',
        updated_at: row.updated_at || '',
        completed_at: row.completed_at || '',
        auto_send: Boolean(Number(row.auto_send || 0)),
        progress: counts,
        budget: {
            max_tool_calls: Number(row.max_tool_calls || 48),
            used_tool_calls: Number(row.used_tool_calls || 0),
            max_minutes: Number(row.max_minutes || 30),
            used_ms: Number(row.used_ms || 0)
        }
    };
}

export function formatTask(row) {
    return {
        id: Number(row.id),
        goal_id: Number(row.goal_id),
        seq: Number(row.seq),
        title: row.title || '',
        description: row.description || '',
        task_type: row.task_type || 'analysis',
        depends_on: safeJson(row.depends_on, []).map(Number).filter(Number.isFinite),
        status: row.status || 'pending',
        attempts: Number(row.attempts || 0),
        max_attempts: Number(row.max_attempts || 3),
        output_md: row.output_md || '',
        error: row.error || '',
        started_at: row.started_at || '',
        finished_at: row.finished_at || '',
        created_at: row.created_at || '',
        updated_at: row.updated_at || ''
    };
}

export function formatRun(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        goal_id: Number(row.goal_id),
        trigger: row.trigger || 'manual',
        status: row.status || 'queued',
        current_task_id: row.current_task_id == null ? null : Number(row.current_task_id),
        error: row.error || '',
        result_md: row.result_md || '',
        started_at: row.started_at || '',
        finished_at: row.finished_at || '',
        created_at: row.created_at || '',
        updated_at: row.updated_at || ''
    };
}

export function formatStep(row) {
    return {
        id: Number(row.id),
        run_id: Number(row.run_id),
        goal_id: Number(row.goal_id),
        task_id: row.task_id == null ? null : Number(row.task_id),
        seq: Number(row.seq),
        step_type: row.step_type || 'task',
        status: row.status || 'running',
        tool_name: row.tool_name || '',
        input: safeJson(row.input_json, {}),
        output: safeJson(row.output_json, {}),
        error: row.error || '',
        duration_ms: Number(row.duration_ms || 0),
        created_at: row.created_at || ''
    };
}

export function formatApproval(row) {
    return {
        id: Number(row.id),
        goal_id: Number(row.goal_id),
        run_id: row.run_id == null ? null : Number(row.run_id),
        task_id: row.task_id == null ? null : Number(row.task_id),
        action_type: row.action_type || '',
        status: row.status || 'pending',
        payload: safeJson(row.payload_json, {}),
        result: safeJson(row.result_json, {}),
        decision_note: row.decision_note || '',
        requested_at: row.requested_at || '',
        decided_at: row.decided_at || '',
        expires_at: row.expires_at || ''
    };
}

export async function getGoalRow(db, userId, goalId, includeDeleted = false) {
    const sql = includeDeleted
        ? 'SELECT * FROM agent_goals WHERE id = ?1 AND user_id = ?2'
        : 'SELECT * FROM agent_goals WHERE id = ?1 AND user_id = ?2 AND COALESCE(is_deleted, 0) = 0';
    return db.prepare(sql).bind(goalId, userId).first();
}

export async function getTaskRow(db, userId, goalId, taskId) {
    return db.prepare(
        'SELECT * FROM agent_tasks WHERE id = ?1 AND goal_id = ?2 AND user_id = ?3'
    ).bind(taskId, goalId, userId).first();
}

export async function listGoalRows(db, userId, limit = 50) {
    const res = await db.prepare(
        `SELECT g.*,
            (SELECT COUNT(*) FROM agent_tasks t WHERE t.goal_id = g.id) AS total_tasks,
            (SELECT COUNT(*) FROM agent_tasks t WHERE t.goal_id = g.id AND t.status = 'completed') AS completed_tasks,
            (SELECT COUNT(*) FROM agent_tasks t WHERE t.goal_id = g.id AND t.status IN ('failed', 'blocked')) AS failed_tasks
         FROM agent_goals g
         WHERE g.user_id = ?1 AND COALESCE(g.is_deleted, 0) = 0
         ORDER BY g.updated_at DESC, g.id DESC
         LIMIT ?2`
    ).bind(userId, limit).all();
    return (res && res.results) || [];
}

export async function listGoals(db, userId, limit = 50) {
    const rows = await listGoalRows(db, userId, limit);
    return rows.map((row) => ({
        ...formatGoal(row, []),
        progress: {
            total: Number(row.total_tasks || 0),
            completed: Number(row.completed_tasks || 0),
            failed: Number(row.failed_tasks || 0),
            pending: Math.max(0, Number(row.total_tasks || 0) - Number(row.completed_tasks || 0) - Number(row.failed_tasks || 0)),
            running: 0
        }
    }));
}

export async function listTaskRows(db, userId, goalId) {
    const res = await db.prepare(
        'SELECT * FROM agent_tasks WHERE goal_id = ?1 AND user_id = ?2 ORDER BY seq ASC, id ASC'
    ).bind(goalId, userId).all();
    return (res && res.results) || [];
}

export async function listTasks(db, userId, goalId) {
    return (await listTaskRows(db, userId, goalId)).map(formatTask);
}

export async function getRunRow(db, userId, goalId, runId = null) {
    if (runId != null) {
        return db.prepare('SELECT * FROM agent_runs WHERE id = ?1 AND goal_id = ?2 AND user_id = ?3')
            .bind(runId, goalId, userId).first();
    }
    return db.prepare('SELECT * FROM agent_runs WHERE goal_id = ?1 AND user_id = ?2 ORDER BY id DESC LIMIT 1')
        .bind(goalId, userId).first();
}

export async function getActiveRunRow(db, userId, goalId) {
    return db.prepare(
        `SELECT * FROM agent_runs
         WHERE goal_id = ?1 AND user_id = ?2 AND status IN ('queued', 'running', 'waiting_approval', 'paused')
         ORDER BY id DESC LIMIT 1`
    ).bind(goalId, userId).first();
}

export async function listStepRows(db, userId, runId, limit = 40) {
    const res = await db.prepare(
        `SELECT * FROM agent_steps
         WHERE run_id = ?1 AND user_id = ?2
         ORDER BY seq DESC, id DESC LIMIT ?3`
    ).bind(runId, userId, limit).all();
    const rows = (res && res.results) || [];
    return rows.slice().reverse();
}

export async function listSteps(db, userId, runId, limit = 40) {
    return (await listStepRows(db, userId, runId, limit)).map(formatStep);
}

export async function listApprovalRows(db, userId, goalId, limit = 20) {
    const res = await db.prepare(
        "SELECT * FROM agent_approvals WHERE goal_id = ?1 AND user_id = ?2 AND (expires_at IS NULL OR expires_at > datetime('now', '+8 hours')) ORDER BY id DESC LIMIT ?3"
    ).bind(goalId, userId, limit).all();
    return (res && res.results) || [];
}

export async function listApprovals(db, userId, goalId, limit = 20) {
    return (await listApprovalRows(db, userId, goalId, limit)).map(formatApproval);
}

/**
 * 跨目标的审批收件箱：只返回未过期、所属目标未删除的 pending，
 * 正文只给短预览，避免一次把多条 30k 草稿全部发给前端。
 */
export async function listApprovalInbox(db, userId, limit = 20) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const rows = await db.prepare(
        `SELECT a.*, g.title AS goal_title
         FROM agent_approvals a
         JOIN agent_goals g ON g.id = a.goal_id AND g.user_id = a.user_id
         WHERE a.user_id = ?1
           AND a.status = 'pending'
           AND COALESCE(g.is_deleted, 0) = 0
           AND (a.expires_at IS NULL OR a.expires_at > datetime('now', '+8 hours'))
         ORDER BY a.id DESC LIMIT ?2`
    ).bind(userId, safeLimit).all();
    const total = await db.prepare(
        `SELECT COUNT(*) AS n
         FROM agent_approvals a
         JOIN agent_goals g ON g.id = a.goal_id AND g.user_id = a.user_id
         WHERE a.user_id = ?1
           AND a.status = 'pending'
           AND COALESCE(g.is_deleted, 0) = 0
           AND (a.expires_at IS NULL OR a.expires_at > datetime('now', '+8 hours'))`
    ).bind(userId).first();
    const approvals = ((rows && rows.results) || []).map((row) => {
        const approval = formatApproval(row);
        const payload = approval.payload || {};
        return {
            ...approval,
            goal_title: cleanText(row.goal_title, 80),
            payload: {
                title: cleanText(payload.title, 80),
                preview: cleanText(payload.content, 180),
                content_length: String(payload.content || '').length,
                note_id: Number(payload.note_id) || 0,
                note_title: cleanText(payload.note_title, 80)
            }
        };
    });
    return { approvals, pending_count: Number((total && total.n) || 0) };
}

export async function getSnapshot(db, userId, goalId) {
    const goalRow = await getGoalRow(db, userId, goalId);
    if (!goalRow) return null;
    const taskRows = await listTaskRows(db, userId, goalId);
    const tasks = taskRows.map(formatTask);
    const runRow = await getRunRow(db, userId, goalId);
    const steps = runRow ? await listSteps(db, userId, runRow.id) : [];
    const approvals = await listApprovals(db, userId, goalId);
    return {
        goal: formatGoal(goalRow, tasks),
        tasks,
        run: formatRun(runRow),
        steps,
        approvals,
        can_continue: ['active', 'paused', 'planned'].includes(goalRow.status) && tasks.some((task) => task.status !== 'completed')
    };
}

export function dependenciesMet(task, bySeq) {
    return (task.depends_on || []).every((seq) => {
        const dep = bySeq.get(Number(seq));
        return dep && dep.status === 'completed';
    });
}

export function nextReadyTask(tasks) {
    const ready = allReadyTasks(tasks, 1);
    return ready[0] || null;
}

export function allReadyTasks(tasks, maxConcurrent = 3) {
    const bySeq = new Map(tasks.map((task) => [Number(task.seq), task]));
    return tasks
        .filter((task) => ['pending', 'ready'].includes(task.status))
        .filter((task) => dependenciesMet(task, bySeq))
        .sort((a, b) => a.seq - b.seq)
        .slice(0, maxConcurrent);
}

export function allTasksCompleted(tasks) {
    return tasks.length > 0 && tasks.every((task) => task.status === 'completed');
}

export async function touchGoal(db, userId, goalId, sets = {}) {
    const fields = [];
    const binds = [];
    let index = 1;
    for (const [key, value] of Object.entries(sets)) {
        fields.push(`${key} = ?${index}`);
        binds.push(value);
        index += 1;
    }
    fields.push("updated_at = datetime('now', '+8 hours')");
    binds.push(goalId, userId);
    await db.prepare(
        `UPDATE agent_goals SET ${fields.join(', ')} WHERE id = ?${index} AND user_id = ?${index + 1} AND COALESCE(is_deleted, 0) = 0`
    ).bind(...binds).run();
}
