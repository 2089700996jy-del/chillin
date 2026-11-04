/**
 * Agent 目标与任务面板。
 *
 * 交互原则：创建目标 → 生成计划 → 用户确认后开始 → 每次只推进一个任务；
 * 页面关闭后状态留在 D1，重开可从列表继续。审批只用于“保存为笔记草稿”。
 */
import { apiRequest } from './api.js';
import { escapeHtml, showToast, markdownToHtml, confirmDialog } from './utils.js';
import { setHtml } from './trusted-types.js';
import { actions } from './actions.js';

const STATUS_LABELS = {
    draft: '草稿',
    planned: '待开始',
    active: '进行中',
    paused: '已暂停',
    waiting_approval: '待审批',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    pending: '待执行',
    ready: '就绪',
    running: '执行中',
    blocked: '受阻',
    skipped: '已跳过'
};

let modal = null;
let listPane = null;
let detailPane = null;
let listEl = null;
let inboxEl = null;
let badgeEl = null;
let badgeTimer = null;
let form = null;
let titleInput = null;
let descInput = null;
let autoSendInput = null;
let currentGoalId = null;
let latestGoalResult = '';
let latestGoalsList = [];
let latestInboxData = null;
let autoToken = 0;
let busy = false;
let lastClickKey = '';
let lastClickAt = 0;

function isRapidClick(key, windowMs = 800) {
    const now = Date.now();
    if (key === lastClickKey && now - lastClickAt < windowMs) return true;
    lastClickKey = key;
    lastClickAt = now;
    return false;
}

function label(status) {
    return STATUS_LABELS[status] || status || '未知';
}

function updatePendingBadge(count) {
    if (!badgeEl) return;
    const n = Math.max(0, Number(count) || 0);
    badgeEl.textContent = n > 99 ? '99+' : String(n);
    badgeEl.hidden = n === 0;
}

function progressBar(progress) {
    const total = Math.max(1, Number(progress && progress.total || 0));
    const done = Number(progress && progress.completed || 0);
    const pct = Math.min(100, Math.round((done / total) * 100));
    return '<div class="agent-goal-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '">' +
        '<div class="agent-goal-progress-track"><span style="width:' + pct + '%"></span></div>' +
        '<span class="agent-goal-progress-text">' + done + '/' + total + ' 步</span></div>';
}

function actionButton(action, text, opts = {}) {
    const cls = opts.primary ? 'btn-primary' : (opts.danger ? 'btn-text text-danger' : 'btn-secondary');
    return '<button type="button" class="' + cls + ' agent-goal-action" data-goal-action="' + action + '">' + escapeHtml(text) + '</button>';
}

function formatDuration(startedAt, finishedAt) {
    if (!startedAt) return '';
    const start = new Date(startedAt).getTime();
    const finish = finishedAt ? new Date(finishedAt).getTime() : Date.now();
    if (isNaN(start) || isNaN(finish) || finish < start) return '';
    const sec = (finish - start) / 1000;
    if (sec < 60) return sec.toFixed(1) + 's';
    const min = Math.floor(sec / 60);
    const remainSec = Math.round(sec % 60);
    return min + 'm ' + remainSec + 's';
}

function renderBudget(budget) {
    if (!budget) return '';
    const usedTools = Number(budget.used_tool_calls || 0);
    const maxTools = Number(budget.max_tool_calls || 48);
    const usedSec = Math.round(Number(budget.used_ms || 0) / 1000);
    const maxMin = Number(budget.max_minutes || 30);
    const toolPercent = Math.min(100, Math.round((usedTools / maxTools) * 100));
    const isExhausted = usedTools >= maxTools || (usedSec >= maxMin * 60);

    return '<div class="agent-budget-card' + (isExhausted ? ' budget-exhausted' : '') + '">' +
        '<div class="agent-budget-head">' +
        '<span>⚡ 目标运行预算与资源消耗</span>' +
        (isExhausted ? '<span class="agent-budget-badge exhausted">预算耗尽</span>' : '<span class="agent-budget-badge">配额充足</span>') +
        '</div>' +
        '<div class="agent-budget-grid">' +
        '<div class="agent-budget-item">' +
        '<span class="budget-item-label">工具调用配额</span>' +
        '<span class="budget-item-val"><strong>' + usedTools + '</strong> / ' + maxTools + ' 次</span>' +
        '<div class="budget-bar"><div class="budget-bar-fill" style="width: ' + toolPercent + '%;"></div></div>' +
        '</div>' +
        '<div class="agent-budget-item">' +
        '<span class="budget-item-label">累积执行耗时</span>' +
        '<span class="budget-item-val"><strong>' + usedSec + 's</strong> / ' + maxMin + ' 分钟</span>' +
        '</div>' +
        '</div>' +
        '</div>';
}

function renderGlobalSuperDeck(goals, inboxData = null) {
    if (!goals || !goals.length) return '';
    const runningWorkers = goals.reduce((s, g) => s + Number(g.progress && g.progress.running || 0), 0);
    const activeGoals = goals.filter((g) => g.status === 'active').length;
    const queuedGoals = goals.filter((g) => ['planned', 'draft'].includes(g.status)).length;
    const inboxApprovals = (inboxData && Array.isArray(inboxData.approvals)) ? inboxData.approvals : [];
    const approvalGoalIds = new Set(inboxApprovals.map((a) => a.goal_id));
    const waitingApprovalGoals = Math.max(
        goals.filter((g) => g.status === 'waiting_approval').length,
        approvalGoalIds.size
    );

    const latestGoal = [...goals].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0];
    const latestTime = latestGoal && latestGoal.updated_at ? latestGoal.updated_at.slice(11, 19) : '';

    const isRunning = runningWorkers > 0;
    const badgeText = isRunning
        ? '🟢 多目标集群运行中 (' + runningWorkers + ' 个 Worker 推进中)'
        : (activeGoals > 0
            ? '⚡ 调度队列就绪 (' + activeGoals + ' 目标待命巡检)'
            : (waitingApprovalGoals > 0
                ? '🔔 存在待审批目标 (' + waitingApprovalGoals + ' 目标等待确认)'
                : '💤 Super-Agent 待命就绪'));

    return '<section class="agent-global-deck">' +
        '<div class="global-deck-head">' +
        '<div class="global-deck-title-wrap">' +
        '<span class="global-deck-badge">' + escapeHtml(badgeText) + '</span>' +
        '<span class="global-deck-sub">全局调度矩阵 · 单目标并发上限 3 Worker</span>' +
        '</div>' +
        (latestTime ? '<span class="global-deck-time">最近活跃 ' + escapeHtml(latestTime) + '</span>' : '') +
        '</div>' +
        '<div class="global-deck-stats">' +
        '<div class="global-stat-card">' +
        '<span class="global-stat-num">' + runningWorkers + '</span>' +
        '<span class="global-stat-label">运行 Worker</span>' +
        '</div>' +
        '<div class="global-stat-card">' +
        '<span class="global-stat-num">' + activeGoals + '</span>' +
        '<span class="global-stat-label">调度中目标</span>' +
        '</div>' +
        '<div class="global-stat-card">' +
        '<span class="global-stat-num">' + queuedGoals + '</span>' +
        '<span class="global-stat-label">排队待启动</span>' +
        '</div>' +
        '<div class="global-stat-card' + (waitingApprovalGoals > 0 ? ' text-warn' : '') + '">' +
        '<span class="global-stat-num">' + waitingApprovalGoals + '</span>' +
        '<span class="global-stat-label">待审批目标</span>' +
        '</div>' +
        '<div class="global-stat-card">' +
        '<span class="global-stat-num">3<small>并发</small></span>' +
        '<span class="global-stat-label">单目标上限</span>' +
        '</div>' +
        '</div>' +
        '</section>';
}

function renderSuperDeck(goal, tasks, steps, run) {
    if (!tasks || !tasks.length) return '';
    const total = tasks.length;
    const completed = tasks.filter((t) => t.status === 'completed').length;
    const runningTasks = tasks.filter((t) => t.status === 'running');
    const runningCount = runningTasks.length;
    const failedCount = tasks.filter((t) => t.status === 'failed').length;
    const blockedCount = tasks.filter((t) => t.status === 'blocked').length;
    const completedSeq = new Set(tasks.filter((t) => t.status === 'completed').map((t) => Number(t.seq)));
    const readyTasks = tasks.filter((t) => ['pending', 'ready'].includes(t.status) && (t.depends_on || []).every((d) => completedSeq.has(Number(d))));
    const readyCount = readyTasks.length;
    const waitingCount = Math.max(0, total - completed - runningCount - failedCount - blockedCount - readyCount);

    const runSeq = run && run.id ? 'Run #' + run.id : '';
    const latestTime = (run && run.updated_at ? run.updated_at : (goal.updated_at || '')).slice(11, 19);

    const slots = [1, 2, 3].map((slotNum) => {
        const slotTitle = '并发槽位 ' + slotNum;
        const workerTag = 'Worker-' + slotNum;
        if (slotNum <= runningCount) {
            const runTask = runningTasks[slotNum - 1];
            return {
                name: slotTitle + ' (动态指派)',
                status: 'running',
                desc: '执行中: ' + (runTask ? runTask.title : '推进中')
            };
        }
        const readyIdx = slotNum - runningCount - 1;
        if (goal.status === 'active' && readyIdx >= 0 && readyIdx < readyCount) {
            const rTask = readyTasks[readyIdx];
            return {
                name: slotTitle + ' (队列调度)',
                status: 'ready',
                desc: '队列就绪: ' + (rTask ? rTask.title : '待派发')
            };
        }
        const workerSteps = (steps || []).filter((s) => {
            const inW = s.input && s.input.worker_id;
            const outW = s.output && s.output.worker_id;
            return inW === workerTag || outW === workerTag;
        });
        const latestStep = workerSteps.length ? workerSteps[workerSteps.length - 1] : null;
        if (latestStep && latestStep.status === 'completed') {
            const matchingTask = tasks.find((t) => t.id === latestStep.task_id);
            const title = matchingTask ? matchingTask.title : (latestStep.input && latestStep.input.title) || '';
            return {
                name: slotTitle + ' (就绪备用)',
                status: 'completed',
                desc: '上次产出: ' + (title || '已交付')
            };
        }
        return {
            name: slotTitle + ' (待命空闲)',
            status: 'idle',
            desc: '待命空闲 (Idle)'
        };
    });

    const isRunning = runningCount > 0;
    const badgeText = isRunning
        ? '⚡ Router 正在并发执行 (' + runningCount + ' 活跃 Worker)'
        : (goal.status === 'completed'
            ? '✨ 协同链路全量达成'
            : (goal.status === 'active' ? '🟢 Router 调度待命 (准备派发就绪任务)' : '💤 Router 协同待命'));

    return '<section class="agent-super-deck">' +
        '<div class="super-deck-head">' +
        '<div class="super-deck-title-wrap">' +
        '<span class="super-deck-badge">' + escapeHtml(badgeText) + '</span>' +
        '<span class="super-deck-sub">Router 统一协调 · 3 槽位并发 Worker 矩阵</span>' +
        '</div>' +
        '<div class="super-deck-metrics">' +
        '<span>并发槽位: <strong>' + runningCount + '/3</strong></span>' +
        '<span>待办就绪: <strong>' + readyCount + '</strong>' + (waitingCount > 0 ? ' (前序等待 ' + waitingCount + ')' : '') + '</span>' +
        '<span>任务状态: <strong>' + completed + '</strong> 达成' + (failedCount + blockedCount > 0 ? ' · <strong>' + (failedCount + blockedCount) + '</strong> 异常' : '') + '</span>' +
        (runSeq || latestTime ? '<span>批次时间: <strong>' + (runSeq ? runSeq + ' · ' : '') + (latestTime || '-') + '</strong></span>' : '') +
        '</div>' +
        '</div>' +
        '<div class="super-deck-slots">' +
        slots.map((s) => '<div class="super-slot super-slot-' + s.status + '">' +
            '<div class="super-slot-tag"><span class="super-slot-dot"></span>' + escapeHtml(s.name) + '</div>' +
            '<div class="super-slot-desc" title="' + escapeHtml(s.desc) + '">' + escapeHtml(s.desc) + '</div>' +
            '</div>').join('') +
        '</div>' +
        '</section>';
}

function renderDeliverableCard(goal, tasks) {
    if (!goal || !goal.result_md) return '';
    const completedTasks = (tasks || []).filter((t) => t.status === 'completed').length;
    const totalTasks = (tasks || []).length;
    const budget = goal.budget || {};
    const usedTools = Number(budget.used_tool_calls || 0);
    const usedSec = Math.round(Number(budget.used_ms || 0) / 1000);

    return '<section class="agent-deliverable-card">' +
        '<div class="agent-deliverable-head">' +
        '<div class="agent-deliverable-badge-wrap">' +
        '<span class="agent-deliverable-badge">🎉 全景成果交付草稿 (Staging Deliverable)</span>' +
        (goal.completed_at ? '<span class="agent-deliverable-time">完成于 ' + escapeHtml(goal.completed_at.slice(11, 19)) + '</span>' : '') +
        '</div>' +
        '<div class="agent-deliverable-stats">' +
        '<span>✅ 任务达成: <strong>' + completedTasks + '/' + totalTasks + '</strong></span>' +
        '<span>⚡ 工具调用: <strong>' + usedTools + '</strong> 次</span>' +
        '<span>⏱ 累计耗时: <strong>' + usedSec + 's</strong></span>' +
        '</div>' +
        '</div>' +
        '<div class="agent-deliverable-body agent-markdown">' +
        markdownToHtml(goal.result_md) +
        '</div>' +
        '<div class="agent-deliverable-actions">' +
        '<button type="button" class="btn-primary agent-goal-action" data-goal-action="save-draft">📥 一键批准并保存为新笔记</button>' +
        '<button type="button" class="btn-secondary agent-goal-action" data-goal-action="append-draft">📎 追加到已有笔记</button>' +
        '<button type="button" class="btn-text agent-deliverable-copy" data-copy-result>📋 复制成果 Markdown</button>' +
        '</div>' +
        '</section>';
}

function renderTask(task) {
    const deps = task.depends_on && task.depends_on.length
        ? '<span class="agent-task-deps">依赖第 ' + task.depends_on.map((n) => Number(n) + 1).join('、') + ' 步</span>'
        : '';
    const duration = formatDuration(task.started_at, task.finished_at);
    const durationHtml = duration ? '<span class="agent-task-duration">⏱ 耗时 ' + duration + '</span>' : '';
    const attemptsHtml = task.attempts
        ? '<span class="agent-task-attempts' + (task.status === 'failed' || task.status === 'blocked' ? ' text-warn' : '') + '">🔄 已尝试 ' + task.attempts + '/' + task.max_attempts + ' 次</span>'
        : '';
    const output = task.output_md
        ? '<details class="agent-task-output"><summary>查看产出</summary><div class="agent-markdown">' + markdownToHtml(task.output_md) + '</div></details>'
        : '';
    const error = task.error
        ? '<div class="agent-task-error"><span class="agent-error-tag">失败原因</span>' + escapeHtml(task.error) + '</div>'
        : '';
    const retry = (task.status === 'failed' || task.status === 'blocked')
        ? '<button type="button" class="btn-text agent-task-retry" data-task-retry="' + task.id + '">重试</button>'
        : '';
    return '<li class="agent-task agent-task-' + escapeHtml(task.status) + '">' +
        '<div class="agent-task-head"><span class="agent-task-seq">' + (task.seq + 1) + '</span>' +
        '<div class="agent-task-main"><strong>' + escapeHtml(task.title) + '</strong>' +
        (task.description ? '<p>' + escapeHtml(task.description) + '</p>' : '') +
        '<div class="agent-task-meta"><span class="agent-status agent-status-' + escapeHtml(task.status) + '">' + label(task.status) + '</span>' +
        attemptsHtml + durationHtml + deps + '</div></div>' +
        retry + '</div>' + error + output + '</li>';
}

function renderSteps(steps) {
    if (!steps || !steps.length) return '';
    const totalDuration = steps.reduce((sum, s) => sum + (Number(s.duration_ms) || 0), 0);
    const totalSec = (totalDuration / 1000).toFixed(1);

    return '<section class="agent-goal-section">' +
        '<h4>执行日志与工具追踪 (' + steps.length + ' 步 · 累积 ' + totalSec + 's)</h4>' +
        '<ol class="agent-steps">' + steps.map((step) => {
            const reply = step.output && step.output.reply ? String(step.output.reply) : '';
            const toolTrace = Array.isArray(step.output && step.output.tool_trace) ? step.output.tool_trace : [];
            const duration = step.duration_ms ? (Number(step.duration_ms) / 1000).toFixed(1) + 's' : '';
            const workerId = (step.input && step.input.worker_id) || (step.output && step.output.worker_id) || '';
            const workerBadge = workerId ? '<span class="agent-step-worker-badge">🤖 ' + escapeHtml(workerId) + '</span>' : '';
            const toolBadge = step.tool_name ? '<span class="agent-step-tool-badge">🔧 ' + escapeHtml(step.tool_name) + '</span>' : '';

            let traceHtml = '';
            if (toolTrace.length) {
                traceHtml = '<div class="agent-step-tool-trace">' +
                    '<span class="tool-trace-label">工具调用 (' + toolTrace.length + ' 次):</span> ' +
                    toolTrace.map((t) => '<code class="agent-trace-pill">' + escapeHtml(t.tool || t.name || 'tool') + '</code>').join(' ') +
                    '</div>';
            }

            let errorHtml = '';
            if (step.error) {
                errorHtml = '<div class="agent-step-error"><span class="agent-error-tag">步骤报错</span>' + escapeHtml(step.error) + '</div>';
            }

            let inputHtml = '';
            if (step.input && Object.keys(step.input).length) {
                const summary = step.input.title || step.input.query || step.input.url || '';
                if (summary) {
                    inputHtml = '<div class="agent-step-input-summary">入参: ' + escapeHtml(String(summary).slice(0, 80)) + '</div>';
                }
            }

            return '<li class="agent-step agent-step-' + escapeHtml(step.status) + '">' +
                '<span class="agent-step-dot"></span>' +
                '<div class="agent-step-body">' +
                '<div class="agent-step-title">' +
                '<span>第 ' + step.seq + ' 步 · ' + label(step.status) + '</span>' +
                workerBadge +
                toolBadge +
                (duration ? '<span class="agent-step-duration">⏱ ' + duration + '</span>' : '') +
                (step.created_at ? '<span class="agent-step-time">' + escapeHtml(step.created_at.slice(11, 19)) + '</span>' : '') +
                '</div>' +
                inputHtml +
                errorHtml +
                traceHtml +
                (reply ? '<div class="agent-step-preview">' + escapeHtml(reply.slice(0, 160)) + '</div>' : '') +
                '</div>' +
                '</li>';
        }).join('') +
        '</ol></section>';
}

function approvalCopy(item) {
    const payload = item.payload || {};
    const append = item.action_type === 'append_note';
    const send = item.action_type === 'send_bot_message';
    const choice = item.action_type === 'choose_option';
    if (choice) {
        return {
            title: '【请你拍板】' + (payload.question || '请选择方案'),
            description: payload.context || payload.description || 'Agent 在执行中需要你做出决策，请从下方选择最佳方案：',
            approveText: '确认选择',
            options: Array.isArray(payload.options) ? payload.options : []
        };
    }
    return {
        title: send ? '通过微信 Bot 发送' : (append ? '追加到「' + (payload.note_title || '未命名笔记') + '」' : (payload.title || '保存为笔记草稿')),
        description: send
            ? '把这条消息发送到你已绑定的微信 Bot。同意后只发送一次。'
            : (append
                ? '把目标结果追加到这篇笔记末尾，不覆盖原文。同意后只写一次。'
                : '把目标结果保存为一条笔记草稿。同意后只写一次。'),
        approveText: send ? '同意并发送' : (append ? '同意并追加' : '同意并保存'),
        options: []
    };
}

function renderApprovals(approvals) {
    const pending = (approvals || []).filter((item) => item.status === 'pending');
    if (!pending.length) return '';
    return '<section class="agent-goal-section"><h4>待审批</h4>' + pending.map((item) => {
        const copy = approvalCopy(item);
        const isChoice = item.action_type === 'choose_option';
        let actionsHtml = '';
        if (isChoice && copy.options.length) {
            actionsHtml = '<div class="agent-choice-options">' +
                copy.options.map((opt, idx) =>
                    '<button type="button" class="btn-secondary agent-choice-btn" data-approval-id="' + item.id + '" data-decision="approve" data-choice-index="' + idx + '" data-action-type="choose_option">' +
                    (idx + 1) + '. ' + escapeHtml(opt) + '</button>'
                ).join('') +
                '<button type="button" class="btn-text text-danger" data-approval-id="' + item.id + '" data-decision="reject" data-action-type="choose_option">拒绝所有方案</button>' +
                '</div>';
        } else {
            actionsHtml = '<div class="agent-approval-actions">' +
                '<button type="button" class="btn-text" data-approval-id="' + item.id + '" data-decision="reject" data-action-type="' + escapeHtml(item.action_type || 'save_note') + '">拒绝</button>' +
                '<button type="button" class="btn-primary" data-approval-id="' + item.id + '" data-decision="approve" data-action-type="' + escapeHtml(item.action_type || 'save_note') + '">' + escapeHtml(copy.approveText) + '</button>' +
                '</div>';
        }
        return '<div class="agent-approval"><div><strong>' + escapeHtml(copy.title) + '</strong>' +
            '<p>' + escapeHtml(copy.description) + '</p></div>' +
            actionsHtml + '</div>';
    }).join('') + '</section>';
}

function renderDetail(data) {
    if (!data || !data.goal) return;
    const goal = data.goal;
    latestGoalResult = goal.result_md || '';
    const progress = goal.progress || { total: 0, completed: 0, failed: 0 };
    const tasks = data.tasks || [];
    const hasBlocked = tasks.some((task) => task.status === 'blocked');
    const actions = [];
    if (['draft', 'planned', 'failed'].includes(goal.status)) actions.push(actionButton('plan', goal.status === 'failed' ? '重新规划' : '生成计划', { primary: goal.status !== 'planned' }));
    if (goal.status === 'failed' && hasBlocked) actions.push(actionButton('replan', '重新规划剩余', { primary: true }));
    if (goal.status === 'planned') actions.push(actionButton('start', '开始执行', { primary: true }));
    if (goal.status === 'active') {
        actions.push(actionButton('continue', '继续执行', { primary: true }));
        actions.push(actionButton('pause', '暂停'));
    }
    if (goal.status === 'paused') actions.push(hasBlocked ? actionButton('replan', '重新规划剩余', { primary: true }) : actionButton('continue', '恢复并继续', { primary: true }));
    if (['active', 'paused', 'planned'].includes(goal.status)) actions.push(actionButton('complete', '标记完成'));
    if (['draft', 'planned', 'failed', 'paused'].includes(goal.status)) actions.push(actionButton('edit', '编辑目标'));
    if (!['completed', 'cancelled'].includes(goal.status)) actions.push(actionButton('cancel', '取消目标'));
    if (goal.status === 'completed' && goal.result_md) {
        actions.push(actionButton('save-draft', '保存为笔记草稿', { primary: true }));
        actions.push(actionButton('append-draft', '追加到已有笔记'));
    }

    const editPanel = ['draft', 'planned', 'failed', 'paused'].includes(goal.status)
        ? '<div class="agent-edit-panel" id="agent-edit-panel" hidden>' +
        '<p class="agent-edit-hint">保存后会重置计划为草稿，需要重新生成计划。</p>' +
        '<input type="text" id="agent-edit-title" class="agent-goal-title-input" maxlength="80" value="' + escapeHtml(goal.title) + '" aria-label="目标标题">' +
        '<textarea id="agent-edit-desc" class="agent-goal-desc-input" maxlength="4000" rows="2" aria-label="目标说明">' + escapeHtml(goal.description || '') + '</textarea>' +
        '<div class="agent-edit-actions">' +
        '<button type="button" class="btn-text" data-edit-cancel>取消</button>' +
        '<button type="button" class="btn-primary" data-edit-submit>保存并重置计划</button>' +
        '</div></div>'
        : '';
    const appendPanel = goal.status === 'completed' && goal.result_md
        ? '<div class="agent-append-panel" id="agent-append-panel" hidden>' +
        '<p class="agent-append-hint">选择一篇笔记，创建审批；同意后只把目标结果追加到末尾，不覆盖原文。</p>' +
        '<select id="agent-append-note" class="agent-append-select" aria-label="选择要追加的笔记"><option value="">加载中…</option></select>' +
        '<div class="agent-append-actions">' +
        '<button type="button" class="btn-text" data-append-cancel>取消</button>' +
        '<button type="button" class="btn-primary" data-append-submit>创建追加审批</button>' +
        '</div></div>'
        : '';
    const result = goal.result_md
        ? (goal.status === 'completed'
            ? renderDeliverableCard(goal, tasks)
            : '<section class="agent-goal-section"><h4>阶段目标结果</h4><div class="agent-goal-result agent-markdown">' + markdownToHtml(goal.result_md) + '</div></section>')
        : '';
    const error = goal.error
        ? '<div class="agent-goal-error"><strong>⚠️ 中断原因：</strong>' + escapeHtml(goal.error) +
        (hasBlocked ? '<p class="agent-goal-error-tip">检测到任务执行受阻，可点击下方“重新规划剩余”调整后续策略，保留已完成阶段性结果。</p>' : '') +
        '</div>'
        : '';

    setHtml(detailPane,
        '<div class="agent-goal-detail-head">' +
        '<button type="button" class="btn-text agent-goal-back" data-agent-back>← 返回</button>' +
        '<button type="button" class="btn-text text-danger agent-goal-delete" data-goal-action="delete">删除</button>' +
        '</div>' +
        '<div class="agent-goal-title-row"><div><h3>' + escapeHtml(goal.title) + '</h3>' +
        (goal.description ? '<p class="agent-goal-description">' + escapeHtml(goal.description) + '</p>' : '') + '</div>' +
        '<span class="agent-status agent-status-' + escapeHtml(goal.status) + '">' + label(goal.status) + '</span></div>' +
        progressBar(progress) + error + renderBudget(goal.budget) +
        '<div class="agent-goal-actions">' + actions.join('') + '</div>' + editPanel + appendPanel +
        renderSuperDeck(goal, tasks, data.steps, data.run) +
        '<section class="agent-goal-section"><h4>计划</h4>' +
        (tasks.length ? '<ol class="agent-task-list">' + tasks.map(renderTask).join('') + '</ol>' : '<p class="agent-goals-empty">还没有计划。点“生成计划”让 AI 拆成可执行步骤。</p>') +
        '</section>' + result + renderApprovals(data.approvals) + renderSteps(data.steps) +
        '<p class="agent-goal-footnote">进度已实时保存；关闭页面后后台调度器每分钟最高并发派发 3 个 Worker 推进任务，重新打开即可查看最新进展。</p>'
    );
    listPane.hidden = true;
    detailPane.hidden = false;
}

function renderList(goals, inboxData = latestInboxData) {
    if (!goals || !goals.length) {
        setHtml(listEl, '<p class="agent-goals-empty">还没有目标。写下你想完成的一件事，AI 会先给出计划。</p>');
        return;
    }
    const globalDeckHtml = renderGlobalSuperDeck(goals, inboxData);
    const itemsHtml = goals.map((goal) => {
        const p = goal.progress || {};
        return '<button type="button" class="agent-goal-item" data-agent-goal="' + goal.id + '">' +
            '<div class="agent-goal-item-head"><strong>' + escapeHtml(goal.title) + '</strong>' +
            '<span class="agent-status agent-status-' + escapeHtml(goal.status) + '">' + label(goal.status) + '</span></div>' +
            (goal.description ? '<p>' + escapeHtml(goal.description) + '</p>' : '') +
            '<div class="agent-goal-item-meta"><span>' + Number(p.completed || 0) + '/' + Number(p.total || 0) + ' 步' + (Number(p.running || 0) > 0 ? ' · ⚡ ' + p.running + ' 运行中' : '') + '</span>' +
            '<span>' + escapeHtml(goal.updated_at || '') + '</span></div>' +
            '</button>';
    }).join('');
    setHtml(listEl, globalDeckHtml + '<div class="agent-goals-stream">' + itemsHtml + '</div>');
}

function renderInbox(data) {
    if (!inboxEl) return;
    const approvals = (data && data.approvals) || [];
    if (!approvals.length) {
        inboxEl.hidden = true;
        setHtml(inboxEl, '');
        updatePendingBadge(0);
        return;
    }
    const total = Number(data.pending_count || approvals.length);
    const remaining = Math.max(0, total - approvals.length);
    setHtml(inboxEl,
        '<div class="agent-inbox-head"><strong>待审批</strong><span>' + total + ' 条</span></div>' +
        approvals.map((item) => {
            const payload = item.payload || {};
            const copy = approvalCopy(item);
            const isChoice = item.action_type === 'choose_option';
            let actionsHtml = '';
            if (isChoice && copy.options.length) {
                actionsHtml = '<div class="agent-choice-options">' +
                    copy.options.map((opt, idx) =>
                        '<button type="button" class="btn-secondary agent-choice-btn" data-approval-id="' + item.id + '" data-decision="approve" data-choice-index="' + idx + '" data-action-type="choose_option">' +
                        (idx + 1) + '. ' + escapeHtml(opt) + '</button>'
                    ).join('') +
                    '<button type="button" class="btn-text text-danger" data-approval-id="' + item.id + '" data-decision="reject" data-action-type="choose_option">拒绝所有方案</button>' +
                    '</div>';
            } else {
                actionsHtml = '<div class="agent-inbox-actions">' +
                    '<button type="button" class="btn-text" data-approval-id="' + item.id + '" data-decision="reject" data-action-type="' + escapeHtml(item.action_type || 'save_note') + '">拒绝</button>' +
                    '<button type="button" class="btn-primary" data-approval-id="' + item.id + '" data-decision="approve" data-action-type="' + escapeHtml(item.action_type || 'save_note') + '">' + escapeHtml(copy.approveText) + '</button>' +
                    '</div>';
            }
            return '<div class="agent-inbox-item">' +
                '<div class="agent-inbox-meta"><button type="button" class="btn-text agent-inbox-goal" data-inbox-goal="' + item.goal_id + '">' +
                escapeHtml(item.goal_title || '未命名目标') + '</button>' +
                '<span>' + escapeHtml(item.requested_at || '') + '</span></div>' +
                '<strong>' + escapeHtml(copy.title) + '</strong>' +
                (payload.preview ? '<p class="agent-inbox-preview">' + escapeHtml(payload.preview) + '</p>' : '') +
                actionsHtml + '</div>';
        }).join('') +
        (remaining ? '<p class="agent-inbox-more">还有 ' + remaining + ' 条，先处理上面的即可。</p>' : '')
    );
    inboxEl.hidden = false;
    updatePendingBadge(data.pending_count);
}

async function refreshInbox() {
    if (!inboxEl) return;
    const res = await apiRequest('/api/agent/approvals?limit=20', { timeout: 30000 });
    latestInboxData = res;
    renderInbox(res);
    if (latestGoalsList.length && listPane && !listPane.hidden) {
        renderList(latestGoalsList, latestInboxData);
    }
}

async function refreshList() {
    const res = await apiRequest('/api/agent/goals', { timeout: 30000 });
    latestGoalsList = res.goals || [];
    renderList(latestGoalsList, latestInboxData);
}

async function openGoal(goalId) {
    currentGoalId = goalId;
    const data = await apiRequest('/api/agent/goals/' + goalId, { timeout: 30000 });
    renderDetail(data);
}

function showList() {
    currentGoalId = null;
    autoToken += 1;
    busy = false;
    detailPane.hidden = true;
    listPane.hidden = false;
    refreshList().catch((err) => showToast(err.message || '目标列表加载失败', 'error'));
    refreshInbox().catch(() => { });
}

async function postGoal(path, timeout = 65000) {
    return apiRequest(path, { method: 'POST', timeout });
}

async function runAction(action) {
    const goalId = currentGoalId;
    if (!goalId) return;
    if (isRapidClick('goal:' + action + ':' + goalId)) return;
    // 暂停必须能在自动推进的请求飞行途中生效；其余动作仍串行，避免并发操作同一目标。
    if (busy && action !== 'pause') return;
    if (action === 'delete') {
        const ok = await confirmDialog('删除这个目标？执行记录和审批记录会保留在数据库中，但不再展示。', { confirmText: '删除', danger: true });
        if (!ok) return;
        try {
            await apiRequest('/api/agent/goals/' + goalId, { method: 'DELETE' });
            showToast('目标已删除', 'success');
            showList();
        } catch (err) {
            showToast(err.message || '删除失败', 'error');
        }
        return;
    }
    if (action === 'complete') {
        const ok = await confirmDialog('把目标标记为完成？未完成的任务不会继续执行。', { confirmText: '标记完成', danger: false });
        if (!ok) return;
    }
    if (action === 'cancel') {
        const ok = await confirmDialog('取消这个目标？未完成的任务会停止，但记录会保留。', { confirmText: '取消目标', danger: true });
        if (!ok) return;
    }
    if (action === 'edit') {
        toggleEditPanel();
        return;
    }
    if (action === 'append-draft') {
        await toggleAppendPanel();
        return;
    }

    const token = ++autoToken;
    busy = true;
    try {
        let data;
        if (action === 'plan') {
            data = await postGoal('/api/agent/goals/' + goalId + '/plan', 65000);
        } else if (action === 'start') {
            data = await postGoal('/api/agent/goals/' + goalId + '/start');
        } else if (action === 'continue') {
            data = await postGoal('/api/agent/goals/' + goalId + '/continue');
        } else if (action === 'replan') {
            data = await postGoal('/api/agent/goals/' + goalId + '/replan', 65000);
            showToast('剩余任务已重新规划，点“继续执行”继续', 'success');
        } else if (action === 'pause') {
            data = await postGoal('/api/agent/goals/' + goalId + '/pause', 30000);
        } else if (action === 'complete') {
            data = await postGoal('/api/agent/goals/' + goalId + '/complete', 30000);
        } else if (action === 'cancel') {
            data = await postGoal('/api/agent/goals/' + goalId + '/cancel', 30000);
        } else if (action === 'save-draft') {
            await postGoal('/api/agent/goals/' + goalId + '/save-draft', 30000);
            showToast('已发起保存审批，请在下方确认', 'success');
            data = await apiRequest('/api/agent/goals/' + goalId, { timeout: 30000 });
            renderDetail(data);
            void refreshInbox().catch(() => { });
            return;
        } else {
            return;
        }
        renderDetail(data);
        void refreshList().catch(() => { });

        // 后台 cron 可能已经接管下一个任务：此时 run 仍是 running，
        // 页面不要再用 continue 追着打（任务认领会互相让路，连发只会得到空快照）。
        const backendBusy = () => Boolean(data.run && ['running', 'waiting_approval'].includes(data.run.status));
        let guard = 0;
        while (token === autoToken && data.goal && data.goal.status === 'active' && data.can_continue && !backendBusy() && guard < 8) {
            guard += 1;
            await new Promise((resolve) => setTimeout(resolve, 450));
            if (token !== autoToken) break;
            data = await postGoal('/api/agent/goals/' + goalId + '/continue');
            renderDetail(data);
            void refreshList().catch(() => { });
        }
    } catch (err) {
        showToast(err.message || '目标操作失败', 'error');
        if (currentGoalId) {
            try { await openGoal(currentGoalId); } catch (_) { }
        }
    } finally {
        if (token === autoToken) busy = false;
    }
}

function toggleEditPanel() {
    const panel = document.getElementById('agent-edit-panel');
    if (panel) panel.hidden = !panel.hidden;
}

async function saveGoalEdit() {
    if (!currentGoalId || busy) return;
    const title = (document.getElementById('agent-edit-title')?.value || '').trim();
    const description = (document.getElementById('agent-edit-desc')?.value || '').trim();
    if (!title) {
        showToast('目标标题不能为空', 'error');
        return;
    }
    busy = true;
    try {
        const data = await apiRequest('/api/agent/goals/' + currentGoalId, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, description }),
            timeout: 30000
        });
        renderDetail(data);
        void refreshList().catch(() => { });
        showToast('目标已更新，请重新生成计划', 'success');
    } catch (err) {
        showToast(err.message || '保存目标失败', 'error');
    } finally {
        busy = false;
    }
}

async function retryTask(taskId) {
    if (!currentGoalId || busy) return;
    busy = true;
    try {
        const data = await postGoal('/api/agent/goals/' + currentGoalId + '/tasks/' + taskId + '/retry', 30000);
        renderDetail(data);
        showToast('任务已重新排队，点“继续执行”即可', 'success');
    } catch (err) {
        showToast(err.message || '重试失败', 'error');
    } finally {
        busy = false;
    }
}

async function decideApproval(approvalId, decision, goalId = null, actionType = 'save_note', extraPayload = {}) {
    const choiceKey = extraPayload.choice_index !== undefined ? ':' + extraPayload.choice_index : '';
    if (busy || isRapidClick('approval:' + approvalId + ':' + decision + choiceKey)) return;
    busy = true;
    const targetGoalId = goalId || currentGoalId;
    try {
        await apiRequest('/api/agent/approvals/' + approvalId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision, ...extraPayload }),
            timeout: 30000
        });
        let approvedText = '已保存为笔记草稿';
        if (actionType === 'choose_option') {
            approvedText = decision === 'approve' ? '已确认方案，Agent 正在继续推进' : '已拒绝方案';
        } else if (actionType === 'append_note') {
            approvedText = '已追加到笔记';
        }
        showToast(decision === 'approve' ? approvedText : (actionType === 'choose_option' ? '已拒绝方案' : '已拒绝保存'), 'success');
        if (targetGoalId && currentGoalId === targetGoalId) {
            await openGoal(targetGoalId);
        } else {
            await refreshList().catch(() => { });
        }
        await refreshInbox().catch(() => { });
    } catch (err) {
        showToast(err.message || '审批失败', 'error');
    } finally {
        busy = false;
    }
}

async function loadAppendNotes() {
    const select = document.getElementById('agent-append-note');
    if (!select) return;
    try {
        const notes = await apiRequest('/api/notes', { timeout: 30000 });
        const list = (Array.isArray(notes) ? notes : []).slice(0, 50);
        if (!list.length) {
            setHtml(select, '<option value="">还没有笔记，先创建一篇</option>');
            return;
        }
        setHtml(select, list.map((note) => '<option value="' + Number(note.id) + '">' +
            escapeHtml((note.title || '无标题').slice(0, 60)) + ' · ' + escapeHtml(note.date || '') + '</option>').join(''));
    } catch (err) {
        setHtml(select, '<option value="">笔记加载失败</option>');
        showToast(err.message || '笔记列表加载失败', 'error');
    }
}

async function toggleAppendPanel() {
    const panel = document.getElementById('agent-append-panel');
    if (!panel) return;
    if (!panel.hidden) {
        panel.hidden = true;
        return;
    }
    panel.hidden = false;
    await loadAppendNotes();
}

async function submitAppendDraft() {
    if (!currentGoalId || busy) return;
    const select = document.getElementById('agent-append-note');
    const noteId = Number(select && select.value);
    if (!Number.isInteger(noteId) || noteId <= 0) {
        showToast('先选一篇要追加的笔记', 'error');
        return;
    }
    const goalId = currentGoalId;
    busy = true;
    try {
        await apiRequest('/api/agent/goals/' + goalId + '/append-draft', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note_id: noteId }),
            timeout: 30000
        });
        showToast('已创建追加审批，去收件箱同意后生效', 'success');
        const data = await apiRequest('/api/agent/goals/' + goalId, { timeout: 30000 });
        renderDetail(data);
        void refreshInbox().catch(() => { });
        void refreshList().catch(() => { });
    } catch (err) {
        showToast(err.message || '创建追加审批失败', 'error');
    } finally {
        busy = false;
    }
}

function bindEvents() {
    document.getElementById('btn-open-agent-goals')?.addEventListener('click', () => {
        modal.classList.add('show');
        showList();
    });
    document.getElementById('btn-close-agent-goals')?.addEventListener('click', () => {
        autoToken += 1;
        busy = false;
        modal.classList.remove('show');
    });
    modal.addEventListener('click', (event) => {
        if (event.target === modal) {
            autoToken += 1;
            busy = false;
            modal.classList.remove('show');
        }
    });
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const title = titleInput.value.trim();
        if (!title || isRapidClick('create-goal')) return;
        try {
            const data = await apiRequest('/api/agent/goals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, description: descInput.value.trim(), auto_send: Boolean(autoSendInput && autoSendInput.checked) }),
                timeout: 30000
            });
            titleInput.value = '';
            descInput.value = '';
            currentGoalId = data.goal.id;
            renderDetail(data);
            void refreshList().catch(() => { });
            try {
                const planned = await postGoal('/api/agent/goals/' + currentGoalId + '/plan', 65000);
                renderDetail(planned);
                showToast('计划已生成，开始执行', 'success');
                await runAction('start');
            } catch (planErr) {
                showToast('目标已创建，但自动规划失败：' + (planErr.message || '请手动重试'), 'error');
            }
        } catch (err) {
            showToast(err.message || '创建目标失败', 'error');
        }
    });
    detailPane.addEventListener('click', async (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        if (target.closest('[data-agent-back]')) {
            showList();
            return;
        }
        const copyBtn = target.closest('[data-copy-result]');
        if (copyBtn) {
            const content = latestGoalResult || '';
            if (content && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(content).then(() => {
                    showToast('成果 Markdown 已复制到剪贴板', 'success');
                }).catch(() => {
                    showToast('复制失败，请手动选取', 'error');
                });
            } else {
                showToast(content ? '当前环境不支持快捷复制' : '暂无成果可复制', 'error');
            }
            return;
        }
        const goalAction = target.closest('[data-goal-action]');
        if (goalAction) {
            await runAction(goalAction.getAttribute('data-goal-action'));
            return;
        }
        const taskRetry = target.closest('[data-task-retry]');
        if (taskRetry) {
            await retryTask(taskRetry.getAttribute('data-task-retry'));
            return;
        }
        if (target.closest('[data-edit-cancel]')) {
            const panel = document.getElementById('agent-edit-panel');
            if (panel) panel.hidden = true;
            return;
        }
        if (target.closest('[data-edit-submit]')) {
            await saveGoalEdit();
            return;
        }
        if (target.closest('[data-append-cancel]')) {
            const panel = document.getElementById('agent-append-panel');
            if (panel) panel.hidden = true;
            return;
        }
        if (target.closest('[data-append-submit]')) {
            await submitAppendDraft();
            return;
        }
        const approval = target.closest('[data-approval-id]');
        if (approval) {
            const extra = {};
            const choiceIdx = approval.getAttribute('data-choice-index');
            if (choiceIdx !== null && choiceIdx !== undefined && choiceIdx !== '') {
                extra.choice_index = Number(choiceIdx);
            }
            await decideApproval(
                approval.getAttribute('data-approval-id'),
                approval.getAttribute('data-decision'),
                null,
                approval.getAttribute('data-action-type') || 'save_note',
                extra
            );
        }
    });
    listEl.addEventListener('click', async (event) => {
        const target = event.target instanceof Element ? event.target.closest('[data-agent-goal]') : null;
        if (!target) return;
        try {
            await openGoal(target.getAttribute('data-agent-goal'));
        } catch (err) {
            showToast(err.message || '目标加载失败', 'error');
        }
    });
    inboxEl?.addEventListener('click', async (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const goalLink = target.closest('[data-inbox-goal]');
        if (goalLink) {
            try {
                await openGoal(goalLink.getAttribute('data-inbox-goal'));
            } catch (err) {
                showToast(err.message || '目标加载失败', 'error');
            }
            return;
        }
        const approval = target.closest('[data-approval-id]');
        if (approval) {
            const extra = {};
            const choiceIdx = approval.getAttribute('data-choice-index');
            if (choiceIdx !== null && choiceIdx !== undefined && choiceIdx !== '') {
                extra.choice_index = Number(choiceIdx);
            }
            await decideApproval(
                approval.getAttribute('data-approval-id'),
                approval.getAttribute('data-decision'),
                null,
                approval.getAttribute('data-action-type') || 'save_note',
                extra
            );
        }
    });
}

export function initAgentGoals() {
    modal = document.getElementById('agent-goals-modal');
    if (!modal) return;
    listPane = document.getElementById('agent-goals-list-pane');
    detailPane = document.getElementById('agent-goals-detail-pane');
    listEl = document.getElementById('agent-goals-list');
    inboxEl = document.getElementById('agent-approval-inbox');
    badgeEl = document.getElementById('agent-pending-badge');
    form = document.getElementById('agent-goal-form');
    titleInput = document.getElementById('agent-goal-title');
    descInput = document.getElementById('agent-goal-desc');
    autoSendInput = document.getElementById('agent-goal-auto-send');
    if (!listPane || !detailPane || !listEl || !form || !titleInput || !descInput) return;
    bindEvents();
    actions.refreshAgentInbox = refreshInbox;
    refreshInbox().catch(() => { });
    if (!badgeTimer) {
        badgeTimer = setInterval(() => {
            if (!document.hidden) refreshInbox().catch(() => { });
        }, 60000);
    }
}

export { renderSuperDeck, renderGlobalSuperDeck };
