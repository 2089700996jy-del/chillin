/**
 * Agent 目标 API：目标 CRUD、计划生成、审批，以及执行器路由。
 *
 * 计划由模型生成，但服务端负责校验任务数、依赖顺序和 JSON 形状；
 * 模型不能直接改任务状态，只能产出计划/任务结果。
 */
import { jsonResponse, readTextCapped } from './security.js';
import { callCustomLlmWithMessages } from './llm.js';
import {
    AgentError,
    MAX_TASKS,
    cleanText,
    cleanMultiline,
    getGoalRow,
    getSnapshot,
    listGoals,
    listApprovalInbox,
    touchGoal
} from './agent-store.js';
import {
    startGoal,
    continueGoal,
    pauseGoal,
    completeGoal,
    retryTask
} from './agent-executor.js';
import { requestSaveDraft, requestAppendDraft, decideApproval } from './agent-approvals.js';
import { replanRemaining } from './agent-checkpoint.js';
import { loadPreferencePrompt } from './bot-preferences.js';
export { requestSaveDraft, requestAppendDraft, decideApproval, planPrompt };

const MAX_BODY_BYTES = 64 * 1024;

function fallbackPlan(goal) {
    const topic = cleanText(goal.description || goal.title, 120);
    return [
        {
            title: '梳理目标相关记录',
            description: `围绕“${topic}”检索用户花园里的相关记录，找出能支撑目标的事实与证据。`,
            depends_on: []
        },
        {
            title: '提炼主线与证据',
            description: '把上一步的记录按主题归并，保留关键引用；证据不足的主题不要硬凑。',
            depends_on: [0]
        },
        {
            title: '形成下一步行动',
            description: '基于已整理的主线，给出具体、可执行的下一步；不要声称已经写入任何数据。',
            depends_on: [1]
        }
    ];
}

function extractJson(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : raw;
    try {
        return JSON.parse(candidate);
    } catch (_) {}
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            return JSON.parse(candidate.slice(start, end + 1));
        } catch (_) {}
    }
    return null;
}

export function normalizePlan(value, goal) {
    const rawTasks = Array.isArray(value) ? value : (value && Array.isArray(value.tasks) ? value.tasks : null);
    if (!rawTasks || rawTasks.length === 0) {
        return { tasks: fallbackPlan(goal), fallback: true };
    }
    const tasks = [];
    for (let i = 0; i < rawTasks.length && tasks.length < MAX_TASKS; i += 1) {
        const item = rawTasks[i] || {};
        const title = cleanText(item.title, 80);
        if (!title) continue;
        const rawDeps = Array.isArray(item.depends_on) ? item.depends_on : [];
        const deps = [...new Set(rawDeps.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < tasks.length))].slice(0, 3);
        tasks.push({
            title,
            description: cleanText(item.description, 500),
            depends_on: deps
        });
    }
    if (tasks.length === 0) return { tasks: fallbackPlan(goal), fallback: true };
    return { tasks, fallback: false };
}

function planPrompt(goal, userPreferences = '') {
    const prefBlock = userPreferences
        ? '\n用户个人偏好与风格约束：\n' + userPreferences + '\n拆解任务时须严格贴合用户的偏好与习惯（如回复长度、语气要求等）。'
        : '';
    return [
        { role: 'system', content: '你是任务规划器。只输出 JSON，不要输出 Markdown 代码块以外的解释。' },
        {
            role: 'user',
            content: [
                '把用户目标拆成 3–6 个有依赖顺序的执行任务。',
                '每个任务必须是一个可独立完成的动作，不是空泛的阶段名。',
                '任务数量最多 8 个；depends_on 只能引用前面任务的下标（从 0 开始）。',
                '先判断目标是否涉及用户自己的花园记录：只有明确提到「我的记录 / 笔记 / 花园 / 之前记过 / 我的偏好」等，才规划花园检索；外部新闻、事实、资料直接用 web_search/fetch_url。',
                '如果目标要求通过 Bot/微信发送，最后一步必须是“创建 send_bot_message 审批”，不能直接发送；写入/发送只能走 propose_write 审批。' + prefBlock,
                '',
                '输出格式：',
                '{"tasks":[{"title":"任务标题","description":"具体做什么、产出什么","depends_on":[]}]}',
                '',
                `用户目标：${goal.title}`,
                `目标说明：${goal.description || '无'}`
            ].join('\n')
        }
    ];
}

export async function generatePlan(db, userId, goalId, options = {}) {
    const { planModel = callCustomLlmWithMessages } = options;
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    if (['active', 'paused', 'waiting_approval'].includes(goal.status)) {
        throw new AgentError(409, '执行中的目标不能重新规划，请先暂停并结束当前运行', 'GOAL_RUNNING');
    }
    if (['completed', 'cancelled'].includes(goal.status)) throw new AgentError(409, '已结束的目标不需要重新规划', 'GOAL_CLOSED');

    let raw = '';
    try {
        const userPreferences = await loadPreferencePrompt(db, userId).catch(() => '');
        raw = await planModel(options.env || {}, planPrompt({ title: goal.title, description: goal.description }, userPreferences));
    } catch (err) {
        console.error('[agent-goals] plan model failed:', err && err.message ? err.message : err);
    }
    const plan = normalizePlan(extractJson(raw), { title: goal.title, description: goal.description });

    await db.prepare('DELETE FROM agent_tasks WHERE goal_id = ?1 AND user_id = ?2').bind(goalId, userId).run();
    const inserts = plan.tasks.map((task, index) => db.prepare(
        `INSERT INTO agent_tasks (goal_id, user_id, seq, title, description, depends_on, status, max_attempts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 3)`
    ).bind(goalId, userId, index, task.title, task.description, JSON.stringify(task.depends_on)));
    if (inserts.length) await db.batch(inserts);
    await touchGoal(db, userId, goalId, {
        status: 'planned',
        plan_version: Number(goal.plan_version || 0) + 1,
        result_md: '',
        error: '',
        completed_at: null
    });
    return { ...(await getSnapshot(db, userId, goalId)), plan_fallback: plan.fallback };
}

export async function createGoal(db, userId, payload = {}) {
    const title = cleanText(payload.title, 80);
    const description = cleanMultiline(payload.description, 4000);
    if (!title) throw new AgentError(400, '目标标题不能为空', 'GOAL_TITLE_REQUIRED');
    const autoSend =
        payload.auto_send === false ||
        Number(payload.auto_send) === 0 ||
        payload.auto_send === 'false' ||
        payload.auto_send === 0
            ? 0
            : 1;
    const row = await db.prepare(
        `INSERT INTO agent_goals (user_id, title, description, status, auto_send, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'draft', ?4, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
         RETURNING *`
    ).bind(userId, title, description, autoSend).first();
    return getSnapshot(db, userId, row.id);
}

export function coalesceGoalDescriptions(existing, addition) {
    const prev = String(existing || '').trim();
    const next = String(addition || '').trim();
    if (!prev) return next;
    if (!next || prev === next || prev.includes(next)) return prev;
    return (prev + '\n\n' + next).slice(0, 4000);
}

export async function updateGoal(db, userId, goalId, payload = {}) {
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    if (['active', 'waiting_approval'].includes(goal.status)) {
        throw new AgentError(409, '执行中的目标不能修改，请先暂停', 'GOAL_RUNNING');
    }
    if (['completed', 'cancelled'].includes(goal.status)) throw new AgentError(409, '已结束的目标不能修改', 'GOAL_CLOSED');
    const title = payload.title == null ? goal.title : cleanText(payload.title, 80);
    const description = payload.coalesce
        ? coalesceGoalDescriptions(goal.description, payload.description)
        : (payload.description == null ? goal.description : cleanMultiline(payload.description, 4000));
    if (!title) throw new AgentError(400, '目标标题不能为空', 'GOAL_TITLE_REQUIRED');
    const autoSend = payload.auto_send === undefined
        ? Number(goal.auto_send || 0)
        : (payload.auto_send === false || Number(payload.auto_send) === 0 || payload.auto_send === 'false' || payload.auto_send === 0 ? 0 : 1);
    await db.prepare('DELETE FROM agent_tasks WHERE goal_id = ?1 AND user_id = ?2').bind(goalId, userId).run();
    await db.prepare(
        `UPDATE agent_goals SET title = ?1, description = ?2, auto_send = ?5, status = 'draft', plan_version = 0,
            result_md = '', error = '', completed_at = NULL, updated_at = datetime('now', '+8 hours')
         WHERE id = ?3 AND user_id = ?4`
    ).bind(title, description, goalId, userId, autoSend).run();
    return getSnapshot(db, userId, goalId);
}

export async function cancelGoal(db, userId, goalId) {
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    if (goal.status === 'completed') throw new AgentError(409, '已完成的目标不能取消', 'GOAL_COMPLETED');
    if (goal.status === 'cancelled') return getSnapshot(db, userId, goalId);
    const now = "datetime('now', '+8 hours')";
    await db.prepare(
        `UPDATE agent_goals SET status = 'cancelled', error = '', completed_at = ${now}, updated_at = ${now}
         WHERE id = ?1 AND user_id = ?2 AND COALESCE(is_deleted, 0) = 0`
    ).bind(goalId, userId).run();
    await db.prepare(
        `UPDATE agent_runs SET status = 'cancelled', current_task_id = NULL, lease_until = NULL,
            next_run_at = NULL, updated_at = ${now}
         WHERE goal_id = ?1 AND user_id = ?2 AND status IN ('queued', 'running', 'waiting_approval', 'paused')`
    ).bind(goalId, userId).run();
    await db.prepare(
        `UPDATE agent_tasks SET status = 'skipped', updated_at = ${now}
         WHERE goal_id = ?1 AND user_id = ?2 AND status IN ('pending', 'ready')`
    ).bind(goalId, userId).run();
    return getSnapshot(db, userId, goalId);
}

export async function deleteGoal(db, userId, goalId) {
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    await db.prepare(
        `UPDATE agent_goals SET is_deleted = 1, updated_at = datetime('now', '+8 hours')
         WHERE id = ?1 AND user_id = ?2`
    ).bind(goalId, userId).run();
    return { deleted: true };
}

export async function listGoalSummaries(db, userId) {
    return listGoals(db, userId, 50);
}

export async function getGoalDetail(db, userId, goalId) {
    const snapshot = await getSnapshot(db, userId, goalId);
    if (!snapshot) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    return snapshot;
}

export async function replanGoal(db, userId, goalId, env = null) {
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    if (['completed', 'cancelled'].includes(goal.status)) throw new AgentError(409, '目标已经结束', 'GOAL_CLOSED');
    if (goal.status === 'active') throw new AgentError(409, '执行中的目标不能重新规划，请先暂停', 'GOAL_RUNNING');
    const result = await replanRemaining({ env, db, userId, goalId, reason: '用户手动重新规划剩余任务' });
    if (!result.replanned) throw new AgentError(409, '没有可重规划的剩余任务', 'GOAL_NO_REPLAN');
    return getSnapshot(db, userId, goalId);
}

async function readBody(request) {
    const raw = await readTextCapped(request, MAX_BODY_BYTES);
    if (!raw.ok) throw new AgentError(413, '请求内容过大', 'BODY_TOO_LARGE');
    try {
        return raw.text ? JSON.parse(raw.text) : {};
    } catch (_) {
        throw new AgentError(400, '请求 JSON 格式错误', 'INVALID_JSON');
    }
}

function idFrom(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new AgentError(400, '无效的 id', 'INVALID_ID');
    return id;
}

export async function handleAgentGoalApi(request, env, url, db, userId, deps = {}) {
    const path = url.pathname;
    const method = request.method;
    try {
        if (path === '/api/agent/goals' && method === 'GET') {
            return jsonResponse({ goals: await listGoalSummaries(db, userId) }, 200);
        }
        if (path === '/api/agent/goals' && method === 'POST') {
            return jsonResponse(await createGoal(db, userId, await readBody(request)), 201);
        }
        if (path === '/api/agent/approvals' && method === 'GET') {
            const limit = url.searchParams.get('limit');
            return jsonResponse(await listApprovalInbox(db, userId, limit), 200);
        }

        let match = path.match(/^\/api\/agent\/goals\/(\d+)$/);
        if (match) {
            const goalId = idFrom(match[1]);
            if (method === 'GET') return jsonResponse(await getGoalDetail(db, userId, goalId), 200);
            if (method === 'PATCH') return jsonResponse(await updateGoal(db, userId, goalId, await readBody(request)), 200);
            if (method === 'DELETE') return jsonResponse(await deleteGoal(db, userId, goalId), 200);
        }

        match = path.match(/^\/api\/agent\/goals\/(\d+)\/plan$/);
        if (match && method === 'POST') {
            const goalId = idFrom(match[1]);
            const result = await generatePlan(db, userId, goalId, { env, planModel: deps.planModel });
            return jsonResponse(result, 200);
        }

        match = path.match(/^\/api\/agent\/goals\/(\d+)\/replan$/);
        if (match && method === 'POST') {
            const goalId = idFrom(match[1]);
            return jsonResponse(await replanGoal(db, userId, goalId, env), 200);
        }

        match = path.match(/^\/api\/agent\/goals\/(\d+)\/start$/);
        if (match && method === 'POST') {
            const goalId = idFrom(match[1]);
            return jsonResponse(await startGoal({ env, db, userId, goalId, agentRunner: deps.agentRunner }), 200);
        }

        match = path.match(/^\/api\/agent\/goals\/(\d+)\/continue$/);
        if (match && method === 'POST') {
            const goalId = idFrom(match[1]);
            return jsonResponse(await continueGoal({ env, db, userId, goalId, agentRunner: deps.agentRunner }), 200);
        }

        match = path.match(/^\/api\/agent\/goals\/(\d+)\/pause$/);
        if (match && method === 'POST') {
            const goalId = idFrom(match[1]);
            return jsonResponse(await pauseGoal(db, userId, goalId), 200);
        }

        match = path.match(/^\/api\/agent\/goals\/(\d+)\/cancel$/);
        if (match && method === 'POST') {
            const goalId = idFrom(match[1]);
            return jsonResponse(await cancelGoal(db, userId, goalId), 200);
        }

        match = path.match(/^\/api\/agent\/goals\/(\d+)\/complete$/);
        if (match && method === 'POST') {
            const goalId = idFrom(match[1]);
            return jsonResponse(await completeGoal(db, userId, goalId), 200);
        }

        match = path.match(/^\/api\/agent\/goals\/(\d+)\/tasks\/(\d+)\/retry$/);
        if (match && method === 'POST') {
            const goalId = idFrom(match[1]);
            const taskId = idFrom(match[2]);
            return jsonResponse(await retryTask(db, userId, goalId, taskId), 200);
        }

        match = path.match(/^\/api\/agent\/goals\/(\d+)\/save-draft$/);
        if (match && method === 'POST') {
            const goalId = idFrom(match[1]);
            return jsonResponse(await requestSaveDraft(db, userId, goalId, env), 201);
        }

        match = path.match(/^\/api\/agent\/goals\/(\d+)\/append-draft$/);
        if (match && method === 'POST') {
            const goalId = idFrom(match[1]);
            return jsonResponse(await requestAppendDraft(db, userId, goalId, await readBody(request), env), 201);
        }

        match = path.match(/^\/api\/agent\/approvals\/(\d+)$/);
        if (match && method === 'POST') {
            const approvalId = idFrom(match[1]);
            return jsonResponse(await decideApproval(db, userId, approvalId, await readBody(request)), 200);
        }

        return jsonResponse({ error: '目标接口不存在' }, 404);
    } catch (err) {
        if (err instanceof AgentError) {
            return jsonResponse({ error: err.message, code: err.code }, err.status);
        }
        console.error('[agent-goals] unhandled:', err);
        return jsonResponse({ error: '目标服务内部错误' }, 500);
    }
}
