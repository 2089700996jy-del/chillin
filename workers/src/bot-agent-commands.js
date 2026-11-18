/**
 * Bot 目标 Agent CLI：在微信端建目标、查进度、排队继续、暂停、重规划与受控审批。
 * 复用网页端同一套 Agent 领域函数，只做参数适配与格式化输出，不复制底层执行逻辑。
 */
import { checkRateLimitShared } from './security.js';
import { createGoal, generatePlan, getGoalDetail, listGoalSummaries, decideApproval, replanGoal } from './agent-goals.js';
import { pauseGoal } from './agent-executor.js';
import { queueGoal } from './agent-scheduler.js';
import { AgentError, listApprovalInbox } from './agent-store.js';

export const GOAL_STATUS_CN = {
    draft: '草稿', planned: '待开始', active: '进行中', paused: '已暂停',
    waiting_approval: '待审批', completed: '已完成', failed: '失败', cancelled: '已取消'
};

export const TASK_STATUS_CN = {
    pending: '待执行', ready: '就绪', running: '执行中', waiting_approval: '待审批',
    completed: '已完成', failed: '失败', skipped: '跳过', blocked: '阻塞'
};

function clip(value, max = 60) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function goalLine(goal) {
    const p = goal.progress || {};
    return '#' + goal.id + ' ' + clip(goal.title, 30) + ' · ' + (GOAL_STATUS_CN[goal.status] || goal.status)
        + ' · ' + Number(p.completed || 0) + '/' + Number(p.total || 0);
}

/**
 * 创建新目标并生成计划（「目标：标题\n说明」）
 */
export async function runAgentCommand(env, db, userId, raw) {
    const limit = await checkRateLimitShared(db, 'bot-goal:' + userId, 5, 10 * 60 * 1000);
    if (!limit.ok) return '建目标有点频繁，先缓 ' + (limit.retryAfter || 60) + ' 秒再试。';
    const lines = String(raw || '').split(/\r?\n/);
    const title = (lines.shift() || '').trim();
    if (!title) return '目标标题不能为空。格式：「目标：标题」';
    const description = lines.join('\n').trim();
    const created = await createGoal(db, userId, { title, description });
    const goalId = created.goal.id;
    let planned;
    try {
        planned = await generatePlan(db, userId, goalId, { env });
    } catch (err) {
        return '目标 #' + goalId + ' 已创建，但生成计划失败：' + clip(err && err.message, 80)
            + '。回复「看目标 ' + goalId + '」查看。';
    }
    const tasks = planned.tasks || [];
    const list = tasks.map((task, index) => (index + 1) + '. ' + clip(task.title, 36)).join('\n');
    return '目标 #' + goalId + ' 已创建，计划 ' + tasks.length + ' 步'
        + (planned.plan_fallback ? '（模型计划不可用，已用保底计划）' : '') + '：\n' + list
        + '\n\n回复「开始 ' + goalId + '」排队执行。';
}

/**
 * 查看目标列表（「我的目标」/「目标列表」）
 */
export async function runAgentList(db, userId) {
    const goals = await listGoalSummaries(db, userId);
    if (!goals.length) return '还没有目标。发「目标：标题」创建一个。';
    return '最近的 ' + Math.min(goals.length, 8) + ' 个目标：\n'
        + goals.slice(0, 8).map(goalLine).join('\n')
        + '\n\n回复「看目标 编号」查看详情。';
}

/**
 * 查看目标详情（「看目标 1」）
 */
export async function runAgentDetail(db, userId, goalId) {
    const snap = await getGoalDetail(db, userId, goalId);
    const goal = snap.goal;
    const tasks = snap.tasks || [];
    const p = goal.progress || {};
    const lines = [
        '#' + goal.id + ' ' + clip(goal.title, 40),
        '状态：' + (GOAL_STATUS_CN[goal.status] || goal.status) + ' · 进度 ' + Number(p.completed || 0) + '/' + Number(p.total || 0)
    ];
    if (goal.description) lines.push('说明：' + clip(goal.description, 120));
    tasks.slice(0, 8).forEach((task) => {
        lines.push((task.seq + 1) + '. [' + (TASK_STATUS_CN[task.status] || task.status) + '] ' + clip(task.title, 30));
    });
    if (tasks.length > 8) lines.push('…还有 ' + (tasks.length - 8) + ' 个任务');
    if (goal.error) lines.push('错误：' + clip(goal.error, 120));
    if (goal.result_md) lines.push('结果：' + clip(goal.result_md, 180));
    if (['planned', 'active', 'paused'].includes(goal.status)) {
        lines.push('回复「开始 ' + goal.id + '」或「暂停 ' + goal.id + '」。');
    }
    return lines.join('\n');
}

/**
 * 开始 / 继续目标（「开始 1」）
 */
export async function runAgentResume(db, userId, goalId) {
    const id = Number(goalId);
    const result = await queueGoal(db, userId, id, 'bot');
    if (!result.queued) return '目标 #' + id + ' 正在执行，稍后看结果就行。';
    return '目标 #' + id + ' 已排队 ✅ 下一分钟后台会推进一个任务，回复「看目标 ' + id + '」查看。';
}

/**
 * 暂停目标（「暂停 1」）
 */
export async function runAgentPause(db, userId, goalId) {
    const id = Number(goalId);
    await pauseGoal(db, userId, id);
    return '目标 #' + id + ' 已暂停。回复「继续 ' + id + '」恢复。';
}

/**
 * 重新规划目标（「重新规划 1」）
 */
export async function runAgentReplan(env, db, userId, goalId) {
    const id = Number(goalId);
    const planned = await replanGoal(db, userId, id, env);
    return '目标 #' + planned.goal.id + ' 已重新规划剩余任务，回复「开始 ' + planned.goal.id + '」继续。';
}

/**
 * 查看待审批列表（「审批」/「待审批」）
 */
export async function runAgentApprovalList(db, userId) {
    const inbox = await listApprovalInbox(db, userId, 10);
    if (!inbox.pending_count) return '现在没有待审批的目标写入。';
    const lines = inbox.approvals.map((item) => {
        const payload = item.payload || {};
        let what = '保存为「' + (payload.title || '目标草稿') + '」';
        if (item.action_type === 'choose_option') {
            const opts = Array.isArray(payload.options) ? payload.options.map((o, idx) => (idx + 1) + '.' + clip(o, 12)).join(' ') : '';
            what = '拍板：' + clip(payload.question, 18) + (opts ? ' (' + opts + ')' : '');
        } else if (item.action_type === 'append_note') {
            what = '追加到「' + (payload.note_title || '未命名笔记') + '」';
        } else if (item.action_type === 'send_bot_message') {
            what = '通过 Bot 发送';
        }
        return '#' + item.id + ' ' + what + ' · 目标：' + clip(item.goal_title, 24);
    });
    return '待审批 ' + inbox.pending_count + ' 条（最多显示 10 条）：\n' + lines.join('\n')
        + '\n\n回复「同意 编号 [序号]」（如 同意 1 2）或「拒绝 编号」。';
}

/**
 * 处理审批决策（「同意 1」/「拒绝 1」/「选 1 2」）
 */
export async function runAgentApproval(db, userId, approvalId, optionArg = null, decision = 'approve') {
    const id = Number(approvalId);
    const payload = { decision };
    if (optionArg && decision === 'approve') {
        payload[/^\d+$/.test(optionArg) ? 'choice_index' : 'choice'] = /^\d+$/.test(optionArg) ? Number(optionArg) - 1 : optionArg;
    }
    const result = await decideApproval(db, userId, id, payload);
    const approval = result.approval || {};
    if (result.already_decided) return '这条审批已经处理过了。';
    if (decision === 'reject') return '已拒绝这条审批，没有写入任何内容。';
    if (approval.action_type === 'choose_option') {
        return '已拍板选定「' + (approval.result && approval.result.chosen_option || '已确认') + '」，Agent 正在继续推进 ✅';
    }
    if (approval.action_type === 'append_note') {
        return '已追加到「' + clip(approval.payload && approval.payload.note_title, 40) + '」✅';
    }
    if (approval.action_type === 'send_bot_message') return '已通过 Bot 发送 ✅';
    const noteId = approval.result && approval.result.note_id;
    return noteId ? '已保存为笔记 #' + noteId + ' ✅' : '已同意并写入 ✅';
}

/**
 * Bot 的目标命令分发器：只解析命令并调用已有 Agent 函数，不复制执行逻辑。
 * 返回 null 表示不是目标/审批命令，继续走普通 Bot 分流。
 */
export async function maybeRunAgentCommand(env, db, userId, text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    let match;
    try {
        if ((match = raw.match(/^(?:目标|goal)[:：]\s*([\s\S]+)$/i))) {
            return await runAgentCommand(env, db, userId, match[1]);
        }
        if (/^(?:我的目标|目标列表|goals?)$/i.test(raw)) {
            return await runAgentList(db, userId);
        }
        if ((match = raw.match(/^(?:看目标|目标详情|目标)\s*#?(\d+)$/i))) {
            return await runAgentDetail(db, userId, Number(match[1]));
        }
        if ((match = raw.match(/^(?:开始目标|开始|继续目标|继续)\s*#?(\d+)$/i))) {
            return await runAgentResume(db, userId, Number(match[1]));
        }
        if ((match = raw.match(/^(?:重新规划|重规划)\s*#?(\d+)$/i))) {
            return await runAgentReplan(env, db, userId, Number(match[1]));
        }
        if ((match = raw.match(/^(?:暂停目标|暂停)\s*#?(\d+)$/i))) {
            return await runAgentPause(db, userId, Number(match[1]));
        }
        if (/^(?:审批|待审批|approvals?)$/i.test(raw)) {
            return await runAgentApprovalList(db, userId);
        }
        if ((match = raw.match(/^(同意|拒绝|选)\s*#?(\d+)(?:\s+(\d+|[^\s]+))?$/))) {
            const decision = match[1] === '拒绝' ? 'reject' : 'approve';
            const approvalId = Number(match[2]);
            const optionArg = match[3] ? match[3].trim() : null;
            return await runAgentApproval(db, userId, approvalId, optionArg, decision);
        }
    } catch (err) {
        if (err instanceof AgentError) return '目标操作没完成：' + err.message;
        throw err;
    }
    return null;
}
