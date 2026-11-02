/**
 * Agent 目标与任务面板。
 *
 * 交互原则：创建目标 → 生成计划 → 用户确认后开始 → 每次只推进一个任务；
 * 页面关闭后状态留在 D1，重开可从列表继续。审批只用于“保存为笔记草稿”。
 */
import { apiRequest } from './api.js';
import { escapeHtml, showToast, markdownToHtml, confirmDialog } from './utils.js';
import { setHtml } from './trusted-types.js';

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
let form = null;
let titleInput = null;
let descInput = null;
let currentGoalId = null;
let autoToken = 0;
let busy = false;

function label(status) {
    return STATUS_LABELS[status] || status || '未知';
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

function renderTask(task) {
    const deps = task.depends_on && task.depends_on.length
        ? '<span class="agent-task-deps">依赖第 ' + task.depends_on.map((n) => Number(n) + 1).join('、') + ' 步</span>'
        : '';
    const output = task.output_md
        ? '<details class="agent-task-output"><summary>查看产出</summary><div class="agent-markdown">' + markdownToHtml(task.output_md) + '</div></details>'
        : '';
    const error = task.error ? '<div class="agent-task-error">' + escapeHtml(task.error) + '</div>' : '';
    const retry = (task.status === 'failed' || task.status === 'blocked')
        ? '<button type="button" class="btn-text agent-task-retry" data-task-retry="' + task.id + '">重试</button>'
        : '';
    return '<li class="agent-task agent-task-' + escapeHtml(task.status) + '">' +
        '<div class="agent-task-head"><span class="agent-task-seq">' + (task.seq + 1) + '</span>' +
        '<div class="agent-task-main"><strong>' + escapeHtml(task.title) + '</strong>' +
        (task.description ? '<p>' + escapeHtml(task.description) + '</p>' : '') +
        '<div class="agent-task-meta"><span class="agent-status agent-status-' + escapeHtml(task.status) + '">' + label(task.status) + '</span>' +
        (task.attempts ? '<span>已尝试 ' + task.attempts + '/' + task.max_attempts + '</span>' : '') + deps + '</div></div>' +
        retry + '</div>' + error + output + '</li>';
}

function renderSteps(steps) {
    if (!steps || !steps.length) return '';
    return '<section class="agent-goal-section"><h4>执行记录</h4><ol class="agent-steps">' + steps.slice(-8).map((step) => {
        const reply = step.output && step.output.reply ? String(step.output.reply) : '';
        return '<li class="agent-step agent-step-' + escapeHtml(step.status) + '"><span class="agent-step-dot"></span>' +
            '<div><div class="agent-step-title">第 ' + step.seq + ' 步 · ' + label(step.status) +
            (step.duration_ms ? ' · ' + Math.round(step.duration_ms / 1000) + 's' : '') + '</div>' +
            (step.error ? '<div class="agent-step-error">' + escapeHtml(step.error) + '</div>' : '') +
            (reply ? '<div class="agent-step-preview">' + escapeHtml(reply.slice(0, 160)) + '</div>' : '') +
            '</div></li>';
    }).join('') + '</ol></section>';
}

function renderApprovals(approvals) {
    const pending = (approvals || []).filter((item) => item.status === 'pending');
    if (!pending.length) return '';
    return '<section class="agent-goal-section"><h4>待审批</h4>' + pending.map((item) => {
        const title = item.payload && item.payload.title ? item.payload.title : '保存为笔记草稿';
        return '<div class="agent-approval"><div><strong>' + escapeHtml(title) + '</strong>' +
            '<p>把目标结果保存为一条笔记草稿。同意后只写一次。</p></div>' +
            '<div class="agent-approval-actions">' +
            '<button type="button" class="btn-text" data-approval-id="' + item.id + '" data-decision="reject">拒绝</button>' +
            '<button type="button" class="btn-primary" data-approval-id="' + item.id + '" data-decision="approve">同意并保存</button>' +
            '</div></div>';
    }).join('') + '</section>';
}

function renderDetail(data) {
    if (!data || !data.goal) return;
    const goal = data.goal;
    const progress = goal.progress || { total: 0, completed: 0, failed: 0 };
    const tasks = data.tasks || [];
    const actions = [];
    if (['draft', 'planned', 'failed'].includes(goal.status)) actions.push(actionButton('plan', goal.status === 'failed' ? '重新规划' : '生成计划', { primary: goal.status !== 'planned' }));
    if (goal.status === 'planned') actions.push(actionButton('start', '开始执行', { primary: true }));
    if (goal.status === 'active') {
        actions.push(actionButton('continue', '继续执行', { primary: true }));
        actions.push(actionButton('pause', '暂停'));
    }
    if (goal.status === 'paused') actions.push(actionButton('continue', '恢复并继续', { primary: true }));
    if (['active', 'paused', 'planned'].includes(goal.status)) actions.push(actionButton('complete', '标记完成'));
    if (goal.status === 'completed' && goal.result_md) actions.push(actionButton('save-draft', '保存为笔记草稿', { primary: true }));

    const result = goal.result_md
        ? '<section class="agent-goal-section"><h4>目标结果</h4><div class="agent-goal-result agent-markdown">' + markdownToHtml(goal.result_md) + '</div></section>'
        : '';
    const error = goal.error ? '<div class="agent-goal-error">' + escapeHtml(goal.error) + '</div>' : '';

    setHtml(detailPane,
        '<div class="agent-goal-detail-head">' +
        '<button type="button" class="btn-text agent-goal-back" data-agent-back>← 返回</button>' +
        '<button type="button" class="btn-text text-danger agent-goal-delete" data-goal-action="delete">删除</button>' +
        '</div>' +
        '<div class="agent-goal-title-row"><div><h3>' + escapeHtml(goal.title) + '</h3>' +
        (goal.description ? '<p class="agent-goal-description">' + escapeHtml(goal.description) + '</p>' : '') + '</div>' +
        '<span class="agent-status agent-status-' + escapeHtml(goal.status) + '">' + label(goal.status) + '</span></div>' +
        progressBar(progress) + error +
        '<div class="agent-goal-actions">' + actions.join('') + '</div>' +
        '<section class="agent-goal-section"><h4>计划</h4>' +
        (tasks.length ? '<ol class="agent-task-list">' + tasks.map(renderTask).join('') + '</ol>' : '<p class="agent-goals-empty">还没有计划。点“生成计划”让 AI 拆成可执行步骤。</p>') +
        '</section>' + result + renderApprovals(data.approvals) + renderSteps(data.steps) +
        '<p class="agent-goal-footnote">进度已保存；关闭页面后后台仍会每分钟继续推进一个任务，重新打开即可查看。</p>'
    );
    listPane.hidden = true;
    detailPane.hidden = false;
}

function renderList(goals) {
    if (!goals || !goals.length) {
        setHtml(listEl, '<p class="agent-goals-empty">还没有目标。写下你想完成的一件事，AI 会先给出计划。</p>');
        return;
    }
    setHtml(listEl, goals.map((goal) => {
        const p = goal.progress || {};
        return '<button type="button" class="agent-goal-item" data-agent-goal="' + goal.id + '">' +
            '<div class="agent-goal-item-head"><strong>' + escapeHtml(goal.title) + '</strong>' +
            '<span class="agent-status agent-status-' + escapeHtml(goal.status) + '">' + label(goal.status) + '</span></div>' +
            (goal.description ? '<p>' + escapeHtml(goal.description) + '</p>' : '') +
            '<div class="agent-goal-item-meta"><span>' + Number(p.completed || 0) + '/' + Number(p.total || 0) + ' 步</span>' +
            '<span>' + escapeHtml(goal.updated_at || '') + '</span></div>' +
            '</button>';
    }).join(''));
}

async function refreshList() {
    const res = await apiRequest('/api/agent/goals', { timeout: 30000 });
    renderList(res.goals || []);
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
}

async function postGoal(path, timeout = 65000) {
    return apiRequest(path, { method: 'POST', timeout });
}

async function runAction(action) {
    const goalId = currentGoalId;
    if (!goalId) return;
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
        } else if (action === 'pause') {
            data = await postGoal('/api/agent/goals/' + goalId + '/pause', 30000);
        } else if (action === 'complete') {
            data = await postGoal('/api/agent/goals/' + goalId + '/complete', 30000);
        } else if (action === 'save-draft') {
            await postGoal('/api/agent/goals/' + goalId + '/save-draft', 30000);
            showToast('已发起保存审批，请在下方确认', 'success');
            data = await apiRequest('/api/agent/goals/' + goalId, { timeout: 30000 });
            renderDetail(data);
            return;
        } else {
            return;
        }
        renderDetail(data);
        void refreshList().catch(() => {});

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
            void refreshList().catch(() => {});
        }
    } catch (err) {
        showToast(err.message || '目标操作失败', 'error');
        if (currentGoalId) {
            try { await openGoal(currentGoalId); } catch (_) {}
        }
    } finally {
        if (token === autoToken) busy = false;
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

async function decideApproval(approvalId, decision) {
    if (!currentGoalId || busy) return;
    busy = true;
    try {
        await apiRequest('/api/agent/approvals/' + approvalId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision }),
            timeout: 30000
        });
        showToast(decision === 'approve' ? '已保存为笔记草稿' : '已拒绝保存', 'success');
        await openGoal(currentGoalId);
    } catch (err) {
        showToast(err.message || '审批失败', 'error');
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
        if (!title) return;
        try {
            const data = await apiRequest('/api/agent/goals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, description: descInput.value.trim() }),
                timeout: 30000
            });
            titleInput.value = '';
            descInput.value = '';
            currentGoalId = data.goal.id;
            renderDetail(data);
            void refreshList().catch(() => {});
            showToast('目标已创建，点“生成计划”继续', 'success');
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
        const approval = target.closest('[data-approval-id]');
        if (approval) {
            await decideApproval(approval.getAttribute('data-approval-id'), approval.getAttribute('data-decision'));
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
}

export function initAgentGoals() {
    modal = document.getElementById('agent-goals-modal');
    if (!modal) return;
    listPane = document.getElementById('agent-goals-list-pane');
    detailPane = document.getElementById('agent-goals-detail-pane');
    listEl = document.getElementById('agent-goals-list');
    form = document.getElementById('agent-goal-form');
    titleInput = document.getElementById('agent-goal-title');
    descInput = document.getElementById('agent-goal-desc');
    if (!listPane || !detailPane || !listEl || !form || !titleInput || !descInput) return;
    bindEvents();
}
