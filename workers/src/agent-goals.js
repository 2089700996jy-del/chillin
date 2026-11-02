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
    formatApproval,
    touchGoal
} from './agent-store.js';
import {
    startGoal,
    continueGoal,
    pauseGoal,
    completeGoal,
    retryTask,
    notifyAgentUser
} from './agent-executor.js';

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

function planPrompt(goal) {
    return [
        { role: 'system', content: '你是任务规划器。只输出 JSON，不要输出 Markdown 代码块以外的解释。' },
        {
            role: 'user',
            content: [
                '把用户目标拆成 3–6 个有依赖顺序的执行任务。',
                '每个任务必须是一个可独立完成的动作，不是空泛的阶段名。',
                '任务数量最多 8 个；depends_on 只能引用前面任务的下标（从 0 开始）。',
                '只做用户花园内可完成的整理、检索、提炼、写作任务；不要规划发消息、改数据、联网提交等副作用动作。',
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
        raw = await planModel(options.env || {}, planPrompt({ title: goal.title, description: goal.description }));
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
    const row = await db.prepare(
        `INSERT INTO agent_goals (user_id, title, description, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'draft', datetime('now', '+8 hours'), datetime('now', '+8 hours'))
         RETURNING *`
    ).bind(userId, title, description).first();
    return getSnapshot(db, userId, row.id);
}

export async function updateGoal(db, userId, goalId, payload = {}) {
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    if (['active', 'paused', 'waiting_approval'].includes(goal.status)) {
        throw new AgentError(409, '执行中的目标不能修改，请先暂停', 'GOAL_RUNNING');
    }
    if (['completed', 'cancelled'].includes(goal.status)) throw new AgentError(409, '已结束的目标不能修改', 'GOAL_CLOSED');
    const title = payload.title == null ? goal.title : cleanText(payload.title, 80);
    const description = payload.description == null ? goal.description : cleanMultiline(payload.description, 4000);
    if (!title) throw new AgentError(400, '目标标题不能为空', 'GOAL_TITLE_REQUIRED');
    await db.prepare('DELETE FROM agent_tasks WHERE goal_id = ?1 AND user_id = ?2').bind(goalId, userId).run();
    await db.prepare(
        `UPDATE agent_goals SET title = ?1, description = ?2, status = 'draft', plan_version = 0,
            result_md = '', error = '', completed_at = NULL, updated_at = datetime('now', '+8 hours')
         WHERE id = ?3 AND user_id = ?4`
    ).bind(title, description, goalId, userId).run();
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

export async function requestSaveDraft(db, userId, goalId, env = null) {
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    const result = cleanMultiline(goal.result_md, 30000);
    if (!result) throw new AgentError(409, '目标还没有可保存的结果', 'GOAL_NO_RESULT');
    // 过期但仍占着 pending 的记录会挡住新审批；先标记过期，再查现有记录。
    await db.prepare(
        `UPDATE agent_approvals SET status = 'expired', decided_at = datetime('now', '+8 hours')
         WHERE goal_id = ?1 AND user_id = ?2 AND action_type = 'save_note' AND status = 'pending'
           AND expires_at IS NOT NULL AND expires_at <= datetime('now', '+8 hours')`
    ).bind(goalId, userId).run();
    const existing = await db.prepare(
        `SELECT * FROM agent_approvals
         WHERE goal_id = ?1 AND user_id = ?2 AND action_type = 'save_note' AND status = 'pending'
         ORDER BY id DESC LIMIT 1`
    ).bind(goalId, userId).first();
    if (existing) return { approval: formatApproval(existing) };
    const payload = {
        title: cleanText(goal.title, 80),
        content: result
    };
    let row;
    try {
        row = await db.prepare(
            `INSERT INTO agent_approvals (goal_id, user_id, action_type, status, payload_json, expires_at)
             VALUES (?1, ?2, 'save_note', 'pending', ?3, datetime('now', '+8 hours', '+1 day'))
             RETURNING *`
        ).bind(goalId, userId, JSON.stringify(payload)).first();
    } catch (err) {
        // 并发点击可能同时走到这里；唯一索引只留一条 pending，另一条返回已存在的那条。
        const pending = await db.prepare(
            `SELECT * FROM agent_approvals
             WHERE goal_id = ?1 AND user_id = ?2 AND action_type = 'save_note' AND status = 'pending'
             ORDER BY id DESC LIMIT 1`
        ).bind(goalId, userId).first();
        if (pending) return { approval: formatApproval(pending) };
        throw err;
    }
    await notifyAgentUser(env, db, userId, {
        title: '待审批',
        body: '把「' + cleanText(goal.title, 40) + '」保存为新笔记',
        tag: 'agent-approval-' + goalId
    }).catch(() => {});
    return { approval: formatApproval(row) };
}

export async function requestAppendDraft(db, userId, goalId, payload = {}, env = null) {
    const noteId = Number(payload && payload.note_id);
    if (!Number.isInteger(noteId) || noteId <= 0) {
        throw new AgentError(400, 'note_id 无效', 'INVALID_NOTE_ID');
    }
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    const result = cleanMultiline(goal.result_md, 30000);
    if (!result) throw new AgentError(409, '目标还没有可追加的结果', 'GOAL_NO_RESULT');
    const note = await db.prepare(
        'SELECT id, title FROM notes WHERE id = ?1 AND user_id = ?2 AND IFNULL(is_deleted, 0) = 0'
    ).bind(noteId, userId).first();
    if (!note) throw new AgentError(404, '笔记不存在或已删除', 'NOTE_NOT_FOUND');

    await db.prepare(
        `UPDATE agent_approvals SET status = 'expired', decided_at = datetime('now', '+8 hours')
         WHERE goal_id = ?1 AND user_id = ?2 AND action_type = 'append_note' AND status = 'pending'
           AND expires_at IS NOT NULL AND expires_at <= datetime('now', '+8 hours')`
    ).bind(goalId, userId).run();
    const existing = await db.prepare(
        `SELECT * FROM agent_approvals
         WHERE goal_id = ?1 AND user_id = ?2 AND action_type = 'append_note' AND status = 'pending'
         ORDER BY id DESC LIMIT 1`
    ).bind(goalId, userId).first();
    if (existing) return { approval: formatApproval(existing) };

    const body = {
        title: cleanText(goal.title, 80),
        note_id: noteId,
        note_title: cleanText(note.title, 80) || '未命名笔记',
        content: result
    };
    try {
        const row = await db.prepare(
            `INSERT INTO agent_approvals (goal_id, user_id, action_type, status, payload_json, expires_at)
             VALUES (?1, ?2, 'append_note', 'pending', ?3, datetime('now', '+8 hours', '+1 day'))
             RETURNING *`
        ).bind(goalId, userId, JSON.stringify(body)).first();
        await notifyAgentUser(env, db, userId, {
            title: '待审批',
            body: '把「' + cleanText(goal.title, 40) + '」追加到「' + (body.note_title || '未命名笔记') + '」',
            tag: 'agent-approval-' + goalId
        });
        return { approval: formatApproval(row) };
    } catch (err) {
        const pending = await db.prepare(
            `SELECT * FROM agent_approvals
             WHERE goal_id = ?1 AND user_id = ?2 AND action_type = 'append_note' AND status = 'pending'
             ORDER BY id DESC LIMIT 1`
        ).bind(goalId, userId).first();
        if (pending) return { approval: formatApproval(pending) };
        throw err;
    }
}

export async function decideApproval(db, userId, approvalId, payload = {}) {
    const decision = payload.decision === 'approve' ? 'approve' : (payload.decision === 'reject' ? 'reject' : '');
    if (!decision) throw new AgentError(400, 'decision 必须是 approve 或 reject', 'INVALID_DECISION');
    const row = await db.prepare(
        'SELECT * FROM agent_approvals WHERE id = ?1 AND user_id = ?2'
    ).bind(approvalId, userId).first();
    if (!row) throw new AgentError(404, '审批不存在', 'APPROVAL_NOT_FOUND');
    if (row.status !== 'pending') {
        return { approval: formatApproval(row), already_decided: true };
    }
    const expired = await db.prepare(
        "SELECT CASE WHEN datetime('now', '+8 hours') > expires_at THEN 1 ELSE 0 END AS expired FROM agent_approvals WHERE id = ?1"
    ).bind(approvalId).first();
    if (expired && Number(expired.expired) === 1) {
        await db.prepare(
            "UPDATE agent_approvals SET status = 'expired', decided_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2 AND status = 'pending'"
        ).bind(approvalId, userId).run();
        throw new AgentError(410, '审批已过期，请重新发起', 'APPROVAL_EXPIRED');
    }

    // 先原子占位，再产生副作用：两个并发的“同意”只有一个能进入写笔记分支。
    const claim = await db.prepare(
        `UPDATE agent_approvals SET status = 'processing'
         WHERE id = ?1 AND user_id = ?2 AND status = 'pending'`
    ).bind(approvalId, userId).run();
    if (!claim.meta || Number(claim.meta.changes) === 0) {
        const current = await db.prepare('SELECT * FROM agent_approvals WHERE id = ?1 AND user_id = ?2')
            .bind(approvalId, userId).first();
        return { approval: formatApproval(current), already_decided: true };
    }

    let result = {};
    const status = decision === 'approve' ? 'approved' : 'rejected';
    try {
        if (decision === 'approve' && row.action_type === 'save_note') {
            const body = JSON.parse(row.payload_json || '{}');
            const title = cleanText(body.title, 80) || '目标草稿';
            const content = cleanMultiline(body.content, 30000);
            if (!content) throw new AgentError(409, '审批内容为空', 'APPROVAL_EMPTY');
            const note = await db.prepare(
                `INSERT INTO notes (title, content, date, user_id, annotations, is_deleted, created_at, updated_at)
                 VALUES (?1, ?2, date('now', '+8 hours'), ?3, '[]', 0, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
                 RETURNING id`
            ).bind(title, content, userId).first();
            result = { note_id: Number(note.id) };
        } else if (decision === 'approve' && row.action_type === 'append_note') {
            const body = JSON.parse(row.payload_json || '{}');
            const noteId = Number(body.note_id);
            const content = cleanMultiline(body.content, 30000);
            if (!Number.isInteger(noteId) || noteId <= 0) throw new AgentError(409, '审批目标笔记无效', 'INVALID_NOTE_ID');
            if (!content) throw new AgentError(409, '审批内容为空', 'APPROVAL_EMPTY');
            // 原子追加：不覆盖原文，也不把用户刚编辑的内容读出来再写回。
            const appended = await db.prepare(
                `UPDATE notes SET content = CASE
                    WHEN TRIM(COALESCE(content, '')) = '' THEN ?1
                    ELSE content || char(10) || char(10) || ?1 END,
                    updated_at = datetime('now', '+8 hours')
                 WHERE id = ?2 AND user_id = ?3 AND IFNULL(is_deleted, 0) = 0`
            ).bind(content, noteId, userId).run();
            if (!appended.meta || Number(appended.meta.changes) === 0) {
                throw new AgentError(404, '目标笔记不存在或已删除', 'NOTE_NOT_FOUND');
            }
            result = { note_id: noteId, appended: true };
        }
        await db.prepare(
            `UPDATE agent_approvals SET status = ?1, result_json = ?2, decision_note = ?3,
                decided_at = datetime('now', '+8 hours') WHERE id = ?4 AND user_id = ?5 AND status = 'processing'`
        ).bind(status, JSON.stringify(result), cleanText(payload.note, 300), approvalId, userId).run();
    } catch (err) {
        // 副作用失败时把占位退回 pending，用户仍可重试；不会留下“已同意但没有笔记”的假状态。
        await db.prepare(
            `UPDATE agent_approvals SET status = 'pending' WHERE id = ?1 AND user_id = ?2 AND status = 'processing'`
        ).bind(approvalId, userId).run();
        throw err;
    }
    const updated = await db.prepare('SELECT * FROM agent_approvals WHERE id = ?1 AND user_id = ?2')
        .bind(approvalId, userId).first();
    return { approval: formatApproval(updated) };
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
