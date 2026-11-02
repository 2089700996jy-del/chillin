/**
 * Agent 审批与通知：保存/追加笔记的受控写入，以及 Agent 主动写入提案。
 *
 * 边界：
 * - 任何写入都必须先落一行 pending 审批，模型不能直接写 notes；
 * - 同一目标同一 action 只保留一条 pending；
 * - 同意时用原子 SQL 写一次，重复同意返回 already_decided；
 * - 跨用户、软删、过期都在这里收口。
 */
import webPush from 'web-push';
import {
    AgentError,
    cleanText,
    cleanMultiline,
    getGoalRow,
    formatApproval
} from './agent-store.js';

const MAX_APPROVAL_CONTENT = 30000;

export function notificationText(value, max = 120) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 目标完成/失败、审批创建时复用已有 Web Push 订阅；没有 VAPID 或订阅时静默跳过。 */
export async function notifyAgentUser(env, db, userId, payload = {}) {
    if (!env || !db || !userId) return { sent: 0 };
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { sent: 0 };
    const subs = await db.prepare(
        'SELECT id, device_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?1 ORDER BY id ASC'
    ).bind(userId).all();
    const all = subs && Array.isArray(subs.results) ? subs.results : [];
    const deviceRows = all.filter((row) => row.device_id);
    // 有设备标识时按设备各推一条；历史无标识的重复订阅只保留最新一条，避免一次事件推多条。
    const rows = deviceRows.length ? deviceRows : (all.length ? [all[all.length - 1]] : []);
    if (!rows.length) return { sent: 0 };
    webPush.setVapidDetails('mailto:admin@chillin.local', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    const body = JSON.stringify({
        title: notificationText(payload.title || 'Chillin', 40),
        body: notificationText(payload.body, 120),
        icon: '/icons/transparent.png',
        url: payload.url || '/',
        tag: notificationText(payload.tag || 'agent', 40)
    });
    let sent = 0;
    await Promise.all(rows.map(async (sub) => {
        try {
            await webPush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                body
            );
            sent += 1;
        } catch (err) {
            if (err && (err.statusCode === 404 || err.statusCode === 410)) {
                try { await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(sub.endpoint).run(); }
                catch (_) { /* 清理失败不影响主流程 */ }
            } else {
                console.error('[agent-notify] push failed:', err && err.message ? err.message : err);
            }
        }
    }));
    return { sent };
}

async function expireStale(db, userId, goalId, actionType) {
    await db.prepare(
        `UPDATE agent_approvals SET status = 'expired', decided_at = datetime('now', '+8 hours')
         WHERE goal_id = ?1 AND user_id = ?2 AND action_type = ?3 AND status = 'pending'
           AND expires_at IS NOT NULL AND expires_at <= datetime('now', '+8 hours')`
    ).bind(goalId, userId, actionType).run();
}

async function findPending(db, userId, goalId, actionType) {
    return db.prepare(
        `SELECT * FROM agent_approvals
         WHERE goal_id = ?1 AND user_id = ?2 AND action_type = ?3 AND status = 'pending'
         ORDER BY id DESC LIMIT 1`
    ).bind(goalId, userId, actionType).first();
}

async function createApproval(db, userId, goalId, actionType, body) {
    await expireStale(db, userId, goalId, actionType);
    const existing = await findPending(db, userId, goalId, actionType);
    if (existing) return { row: existing, created: false };
    try {
        const row = await db.prepare(
            `INSERT INTO agent_approvals (goal_id, user_id, action_type, status, payload_json, expires_at)
             VALUES (?1, ?2, ?3, 'pending', ?4, datetime('now', '+8 hours', '+1 day'))
             RETURNING *`
        ).bind(goalId, userId, actionType, JSON.stringify(body)).first();
        return { row, created: true };
    } catch (err) {
        // save_note 有唯一索引；并发创建时把另一条 pending 返回，保持幂等。
        const pending = await findPending(db, userId, goalId, actionType);
        if (pending) return { row: pending, created: false };
        throw err;
    }
}

async function notifyApproval(env, db, userId, goalId, text) {
    await notifyAgentUser(env, db, userId, {
        title: '待审批',
        body: text,
        tag: 'agent-approval-' + goalId
    }).catch(() => {});
}

export async function requestSaveDraft(db, userId, goalId, env = null) {
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    const result = cleanMultiline(goal.result_md, MAX_APPROVAL_CONTENT);
    if (!result) throw new AgentError(409, '目标还没有可保存的结果', 'GOAL_NO_RESULT');
    const body = { title: cleanText(goal.title, 80), content: result };
    const { row, created } = await createApproval(db, userId, goalId, 'save_note', body);
    if (created) {
        await notifyApproval(env, db, userId, goalId, '把「' + cleanText(goal.title, 40) + '」保存为新笔记');
    }
    return { approval: formatApproval(row) };
}

export async function requestAppendDraft(db, userId, goalId, payload = {}, env = null) {
    const noteId = Number(payload && payload.note_id);
    if (!Number.isInteger(noteId) || noteId <= 0) {
        throw new AgentError(400, 'note_id 无效', 'INVALID_NOTE_ID');
    }
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');
    const result = cleanMultiline(goal.result_md, MAX_APPROVAL_CONTENT);
    if (!result) throw new AgentError(409, '目标还没有可追加的结果', 'GOAL_NO_RESULT');
    const note = await db.prepare(
        'SELECT id, title FROM notes WHERE id = ?1 AND user_id = ?2 AND IFNULL(is_deleted, 0) = 0'
    ).bind(noteId, userId).first();
    if (!note) throw new AgentError(404, '笔记不存在或已删除', 'NOTE_NOT_FOUND');

    const body = {
        title: cleanText(goal.title, 80),
        note_id: noteId,
        note_title: cleanText(note.title, 80) || '未命名笔记',
        content: result
    };
    const { row, created } = await createApproval(db, userId, goalId, 'append_note', body);
    if (created) {
        await notifyApproval(env, db, userId, goalId, '把「' + cleanText(goal.title, 40) + '」追加到「' + body.note_title + '」');
    }
    return { approval: formatApproval(row) };
}

/**
 * Agent 在任务中主动提出的写入提案。与 requestSaveDraft 不同，内容来自当前任务，
 * 不要求目标已经有 result_md；但仍然只创建审批，不直接写 notes。
 */
export function validateProposalArgs(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return '参数必须是对象';
    const allowed = new Set(['action', 'title', 'note_id', 'content']);
    for (const key of Object.keys(args)) {
        if (!allowed.has(key)) return '未知参数：' + key;
    }
    if (!['save_note', 'append_note', 'send_bot_message'].includes(args.action)) return 'action 不支持';
    if (typeof args.content !== 'string' || !args.content.trim()) return 'content 不能为空';
    if (args.content.length > MAX_APPROVAL_CONTENT) return 'content 太长';
    if (args.action === 'append_note') {
        const noteId = Number(args.note_id);
        if (!Number.isInteger(noteId) || noteId <= 0) return '追加提案必须提供有效 note_id';
    }
    return '';
}

export async function runProposalTool(db, userId, goalId, taskId, args, env) {
    const validationError = validateProposalArgs(args);
    if (validationError) {
        return { ok: false, tool: 'propose_write', error: { code: 'INVALID_ARGUMENTS', message: validationError }, citations: [] };
    }
    try {
        const { approval, created } = await requestAgentProposal(db, userId, goalId, taskId, args, env);
        return {
            ok: true,
            tool: 'propose_write',
            data: {
                approval_id: approval.id,
                action: approval.action_type,
                status: approval.status,
                created: Boolean(created),
                title: approval.payload && approval.payload.title || '',
                note_title: approval.payload && approval.payload.note_title || ''
            },
            citations: []
        };
    } catch (err) {
        return {
            ok: false,
            tool: 'propose_write',
            error: { code: err && err.code || 'PROPOSAL_FAILED', message: err && err.message || '创建写入提案失败' },
            citations: []
        };
    }
}

export async function requestAgentProposal(db, userId, goalId, taskId, payload = {}, env = null) {
    const action = ['save_note', 'append_note', 'send_bot_message'].includes(payload.action) ? payload.action : '';
    if (!action) throw new AgentError(400, 'action 不支持', 'INVALID_PROPOSAL_ACTION');
    const content = cleanMultiline(payload.content, MAX_APPROVAL_CONTENT);
    if (!content) throw new AgentError(400, '提案内容不能为空', 'PROPOSAL_EMPTY');
    const goal = await getGoalRow(db, userId, goalId);
    if (!goal) throw new AgentError(404, '目标不存在', 'GOAL_NOT_FOUND');

    const body = {
        title: cleanText(payload.title, 80) || cleanText(goal.title, 80) || '目标结果',
        content,
        source: 'agent',
        task_id: Number(taskId) || 0
    };
    if (action === 'send_bot_message') {
        body.title = 'Bot 消息';
        body.channel = 'bot';
    }
    if (action === 'append_note') {
        const noteId = Number(payload.note_id);
        if (!Number.isInteger(noteId) || noteId <= 0) {
            throw new AgentError(400, '追加提案必须提供有效 note_id', 'INVALID_NOTE_ID');
        }
        const note = await db.prepare(
            'SELECT id, title FROM notes WHERE id = ?1 AND user_id = ?2 AND IFNULL(is_deleted, 0) = 0'
        ).bind(noteId, userId).first();
        if (!note) throw new AgentError(404, '笔记不存在或已删除', 'NOTE_NOT_FOUND');
        body.note_id = noteId;
        body.note_title = cleanText(note.title, 80) || '未命名笔记';
    }

    const { row, created } = await createApproval(db, userId, goalId, action, body);
    if (created) {
        const target = action === 'append_note'
            ? '追加到「' + body.note_title + '」'
            : (action === 'send_bot_message' ? '通过 Bot 发送一条消息' : '保存为新笔记「' + body.title + '」');
        await notifyApproval(env, db, userId, goalId, 'Agent 提案：' + target);
    }
    return { approval: formatApproval(row), created };
}

export async function decideApproval(db, userId, approvalId, payload = {}, deps = {}) {
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
            const content = cleanMultiline(body.content, MAX_APPROVAL_CONTENT);
            if (!content) throw new AgentError(409, '审批内容为空', 'APPROVAL_EMPTY');
            const note = await db.prepare(
                `INSERT INTO notes (title, content, date, user_id, annotations, is_deleted, created_at, updated_at)
                 VALUES (?1, ?2, date('now', '+8 hours'), ?3, '[]', 0, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
                 RETURNING id`
            ).bind(title, content, userId).first();
            result = { note_id: Number(note.id) };
        } else if (decision === 'approve' && row.action_type === 'send_bot_message') {
            const body = JSON.parse(row.payload_json || '{}');
            const content = cleanMultiline(body.content, 4000);
            if (!content) throw new AgentError(409, '审批内容为空', 'APPROVAL_EMPTY');
            const account = await db.prepare(
                "SELECT bot_token, baseurl, ilink_bot_id, ilink_user_id, last_context_token FROM bot_claw_accounts WHERE user_id = ?1 AND is_deleted = 0 AND status = 'bound' ORDER BY id DESC LIMIT 1"
            ).bind(userId).first();
            if (!account) throw new AgentError(409, '未绑定可用的微信 Bot', 'BOT_NOT_BOUND');
            if (deps.sendBot) {
                await deps.sendBot(content, account);
            } else {
                const { sendClawText } = await import('./bot-claw.js');
                await sendClawText({
                    token: account.bot_token,
                    baseurl: account.baseurl,
                    botId: account.ilink_bot_id,
                    toUserId: account.ilink_user_id,
                    contextToken: account.last_context_token || '',
                    text: content
                });
            }
            result = { sent: true, channel: 'bot' };
        } else if (decision === 'approve' && row.action_type === 'append_note') {
            const body = JSON.parse(row.payload_json || '{}');
            const noteId = Number(body.note_id);
            const content = cleanMultiline(body.content, MAX_APPROVAL_CONTENT);
            if (!Number.isInteger(noteId) || noteId <= 0) throw new AgentError(409, '审批目标笔记无效', 'INVALID_NOTE_ID');
            if (!content) throw new AgentError(409, '审批内容为空', 'APPROVAL_EMPTY');
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
