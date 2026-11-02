/**
 * 任务后检查点与剩余任务重规划。
 *
 * 设计边界：
 * - 只在当前任务完成、且仍有未完成任务时询问一次；
 * - 最多 3 个计划版本（初始 1 + 两次重规划），防止无限重写计划；
 * - 重规划只删除未完成任务，已完成结果永不丢；
 * - 模型失败/输出不合法时继续原计划，不阻塞主流程。
 */
import { callCustomLlm } from './llm.js';
import { getGoalRow, listTasks, cleanText, cleanMultiline, touchGoal } from './agent-store.js';
import { notifyAgentUser, notificationText, requestAgentProposal } from './agent-approvals.js';

export function budgetExceeded(goal) {
    const maxCalls = Number(goal.max_tool_calls || 48);
    const maxMs = Number(goal.max_minutes || 30) * 60000;
    return Number(goal.used_tool_calls || 0) >= maxCalls || Number(goal.used_ms || 0) >= maxMs;
}

export async function addBudgetUsage(db, userId, goalId, toolCalls, durationMs) {
    const sql = `UPDATE agent_goals SET used_tool_calls = used_tool_calls + ?1, used_ms = used_ms + ?2, updated_at = datetime('now', '+8 hours') WHERE id = ?3 AND user_id = ?4`;
    await db.prepare(sql).bind(Math.max(0, Number(toolCalls) || 0), Math.max(0, Number(durationMs) || 0), goalId, userId).run();
}

export async function failForBudget(db, userId, goalId, goal, env) {
    const message = '目标预算已用完（工具 ' + Number(goal.used_tool_calls || 0) + '/' + Number(goal.max_tool_calls || 48) + '，用时 ' + Math.round(Number(goal.used_ms || 0) / 6000) / 10 + '/' + Number(goal.max_minutes || 30) + ' 分钟）';
    await db.prepare(
        `UPDATE agent_goals SET status = 'failed', error = ?1, completed_at = datetime('now', '+8 hours'),
            updated_at = datetime('now', '+8 hours') WHERE id = ?2 AND user_id = ?3`
    ).bind(message, goalId, userId).run();
    await db.prepare(
        `UPDATE agent_runs SET status = 'failed', error = ?1, current_task_id = NULL, lease_until = NULL,
            next_run_at = NULL, finished_at = datetime('now', '+8 hours'), updated_at = datetime('now', '+8 hours')
         WHERE goal_id = ?2 AND user_id = ?3 AND status IN ('queued', 'running', 'waiting_approval', 'paused')`
    ).bind(message, goalId, userId).run();
    await notifyAgentUser(env, db, userId, { title: '目标预算用完', body: '「' + notificationText(goal.title, 60) + '」' + message + '，去查看。', tag: 'agent-goal-' + goalId }).catch(() => {});
    return message;
}


const MAX_PLANS = 3;
const MAX_TASKS = 8;
const MAX_NEW_TASKS = 4;
const CHECKPOINT_TIMEOUT_MS = 15000;
const BLOCKED_RE = /(?:BLOCKED|阻塞|无法完成|未能完成|缺少[^\n]{0,20}(?:工具|来源|数据)|没有[^\n]{0,20}(?:工具|来源|数据))/i;

function parseJson(text) {
    const raw = String(text || '').trim().replace(/^\u0060\u0060\u0060(?:json)?/i, '').replace(/\u0060\u0060\u0060$/, '').trim();
    try { return JSON.parse(raw); } catch (_) { /* 继续尝试截取 */ }
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
}

function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CHECKPOINT_TIMEOUT')), ms); })
    ]).finally(() => clearTimeout(timer));
}

function normalizeTasks(raw, max) {
    const list = raw && Array.isArray(raw.tasks) ? raw.tasks : [];
    const tasks = [];
    for (let i = 0; i < list.length && tasks.length < max; i += 1) {
        const item = list[i];
        if (!item || typeof item !== 'object') continue;
        const title = cleanText(item.title, 80);
        if (!title) continue;
        const deps = Array.isArray(item.depends_on)
            ? item.depends_on.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < i)
            : [];
        tasks.push({
            title,
            description: cleanMultiline(item.description, 500),
            depends_on: [...new Set(deps)]
        });
    }
    return tasks;
}

function checkpointPrompt(goal, task, output, pending) {
    return [
        '你是目标执行检查点，只判断“刚完成的任务结果是否足以继续”。',
        '目标：' + goal.title,
        goal.description ? '目标说明：' + goal.description : '',
        '当前任务：' + task.title,
        '任务结果：\n' + cleanMultiline(output, 4000),
        '剩余任务：' + pending.map((item) => item.title).join('、'),
        '只有在结果明显缺失、未完成当前任务要求、或与已有结果矛盾时才 replan；明确被工具/来源/权限卡住时选 blocked；不确定就 continue。',
        '只输出 JSON：{"action":"continue"}、{"action":"replan","reason":"..."} 或 {"action":"blocked","reason":"..."}。'
    ].filter(Boolean).join('\n');
}

function replanPrompt(goal, completed, pending, reason) {
    return [
        '为一个长期目标重写“剩余任务”，不要重做已完成任务。',
        '目标：' + goal.title,
        goal.description ? '目标说明：' + goal.description : '',
        '已完成任务与结果：\n' + completed.map((item) => '## ' + item.title + '\n' + cleanMultiline(item.output_md, 1200)).join('\n\n').slice(-6000),
        '原剩余任务：' + pending.map((item) => item.title).join('、'),
        '重规划原因：' + reason,
        '最多 4 个新任务，依赖只能引用新任务的前序下标；不要重复已完成的工作。',
        '只输出 JSON：{"tasks":[{"title":"...","description":"...","depends_on":[]}]}。'
    ].filter(Boolean).join('\n');
}

export async function replanRemaining({ env, db, userId, goalId, reason, planModel }) {
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) return { replanned: false };
    if (Number(goal.plan_version || 0) >= MAX_PLANS) return { replanned: false, reason: 'plan_limit' };
    const tasks = await listTasks(db, userId, goalId);
    const completed = tasks.filter((item) => item.status === 'completed');
    const pending = tasks.filter((item) => ['pending', 'ready', 'failed', 'skipped', 'blocked'].includes(item.status));
    if (!pending.length) return { replanned: false, reason: 'no_pending' };
    const room = MAX_TASKS - completed.length;
    if (room <= 0) return { replanned: false, reason: 'task_limit' };

    const model = planModel || ((e, system, user) => callCustomLlm(e, system, user));
    let raw = '';
    try {
        raw = await withTimeout(model(env, '你负责把长期目标拆成可执行的剩余任务，只输出 JSON。', replanPrompt(goal, completed, pending, reason)), CHECKPOINT_TIMEOUT_MS);
    } catch (err) {
        console.error('[agent-checkpoint] replan model failed:', err && err.message ? err.message : err);
    }
    let nextTasks = normalizeTasks(parseJson(raw), Math.min(MAX_NEW_TASKS, room));
    if (!nextTasks.length) {
        nextTasks = [{
            title: '补齐缺失信息后继续',
            description: '上一任务结果不足：' + cleanText(reason, 200),
            depends_on: []
        }];
    }

    await db.prepare(
        `DELETE FROM agent_tasks WHERE goal_id = ?1 AND user_id = ?2
         AND status IN ('pending', 'ready', 'failed', 'skipped', 'blocked')`
    ).bind(goalId, userId).run();
    const offset = completed.length ? Math.max(...completed.map((item) => Number(item.seq) || 0)) + 1 : 0;
    const inserts = nextTasks.map((task, index) => db.prepare(
        `INSERT INTO agent_tasks (goal_id, user_id, seq, title, description, depends_on, status, max_attempts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 3)`
    ).bind(
        goalId,
        userId,
        offset + index,
        task.title,
        task.description,
        JSON.stringify(task.depends_on.map((dep) => offset + dep))
    ));
    if (inserts.length) await db.batch(inserts);
    await touchGoal(db, userId, goalId, {
        status: 'active',
        plan_version: Number(goal.plan_version || 0) + 1,
        result_md: '',
        error: ''
    });
    return { replanned: true, tasks: nextTasks.length, plan_version: Number(goal.plan_version || 0) + 1 };
}

function goalWantsBotSend(goal, tasks) {
    const text = [goal.title, goal.description, ...(tasks || []).map((task) => task.title + ' ' + task.description)].join(' ');
    return /bot|微信|wechat/i.test(text) && /发送|发我|推送|发给/i.test(text);
}

/**
 * 所有任务完成后、真正标记完成前的硬门槛：
 * 目标要求 Bot 发送时，必须有 pending/approved 的 send_bot_message 审批。
 * 没有则暂停目标并通知，不能把“只写了草稿”的目标标成完成。
 */
export async function blockCompletionIfNeeded({ env, db, userId, goalId, goal, tasks }) {
    if (!goalWantsBotSend(goal, tasks)) return false;
    const approval = await db.prepare(
        "SELECT status FROM agent_approvals WHERE goal_id = ?1 AND user_id = ?2 AND action_type = 'send_bot_message' AND status IN ('pending', 'approved') ORDER BY id DESC LIMIT 1"
    ).bind(goalId, userId).first();
    if (approval && approval.status === 'approved') return false;
    let message = approval ? '目标要求 Bot 发送，发送审批还在等待处理' : '';
    if (!approval) {
        const last = [...(tasks || [])].reverse().find((item) => item.status === 'completed' && item.output_md);
        const content = last ? last.output_md : '';
        if (content) {
            try {
                await requestAgentProposal(db, userId, goalId, last.id, { action: 'send_bot_message', content }, env);
                message = '目标要求 Bot 发送，已创建发送审批，请到收件箱确认';
            } catch (err) {
                message = '目标要求 Bot 发送，但创建发送审批失败：' + (err && err.message || 'unknown');
            }
        } else {
            message = '目标要求 Bot 发送，但还没有 send_bot_message 审批';
        }
    }
    await db.prepare(
        `UPDATE agent_goals SET status = 'paused', error = ?1, updated_at = datetime('now', '+8 hours')
         WHERE id = ?2 AND user_id = ?3 AND COALESCE(is_deleted, 0) = 0`
    ).bind(message, goalId, userId).run();
    await db.prepare(
        `UPDATE agent_runs SET status = 'paused', current_task_id = NULL, lease_until = NULL,
            next_run_at = NULL, updated_at = datetime('now', '+8 hours')
         WHERE goal_id = ?1 AND user_id = ?2 AND status IN ('queued', 'running', 'waiting_approval', 'paused')`
    ).bind(goalId, userId).run();
    await notifyAgentUser(env, db, userId, { title: '目标已暂停', body: '「' + notificationText(goal.title, 60) + '」' + message, tag: 'agent-goal-' + goalId }).catch(() => {});
    return true;
}

/**
 * 当前任务完成后调用；返回 action，调用方无需处理重规划细节。
 * 没有剩余任务、没有模型、计划版本已满或模型失败时都安全地 continue。
 */
export async function checkpointAfterTask({ env, db, userId, goalId, task, output, checkpointModel, planModel }) {
    if (!env || !db || !task) return { action: 'continue' };
    if (BLOCKED_RE.test(String(output || ''))) return { action: 'blocked', reason: '任务结果标记为阻塞' };
    const tasks = await listTasks(db, userId, goalId);
    const pending = tasks.filter((item) => ['pending', 'ready'].includes(item.status));
    if (!pending.length) return { action: 'continue' };
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal || Number(goal.plan_version || 0) >= MAX_PLANS) return { action: 'continue' };
    if (!env.LLM_API_KEY && !checkpointModel) return { action: 'continue' };

    const model = checkpointModel || ((e, system, user) => callCustomLlm(e, system, user));
    let decision = null;
    try {
        const raw = await withTimeout(
            model(env, '你是目标执行检查点，只输出 JSON。', checkpointPrompt(goal, task, output, pending)),
            CHECKPOINT_TIMEOUT_MS
        );
        decision = parseJson(raw);
    } catch (err) {
        console.error('[agent-checkpoint] assess failed:', err && err.message ? err.message : err);
    }
    if (!decision) return { action: 'continue' };
    if (decision.action === 'blocked') return { action: 'blocked', reason: cleanText(decision.reason, 300) || '检查点判定阻塞' };
    if (decision.action !== 'replan') return { action: 'continue' };
    const reason = cleanText(decision.reason, 300) || '当前结果不足';
    const result = await replanRemaining({ env, db, userId, goalId, reason, planModel });
    return result.replanned ? { action: 'replan', ...result } : { action: 'continue', reason: result.reason || 'replan_failed' };
}
