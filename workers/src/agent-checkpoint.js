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

const MAX_PLANS = 3;
const MAX_TASKS = 8;
const MAX_NEW_TASKS = 4;
const CHECKPOINT_TIMEOUT_MS = 15000;

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
        '只有在结果明显缺失、未完成当前任务要求、或与已有结果矛盾时才 replan；不确定就 continue。',
        '只输出 JSON：{"action":"continue"} 或 {"action":"replan","reason":"一句话原因"}。'
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

async function replanRemaining({ env, db, userId, goalId, reason, planModel }) {
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

/**
 * 当前任务完成后调用；返回 action，调用方无需处理重规划细节。
 * 没有剩余任务、没有模型、计划版本已满或模型失败时都安全地 continue。
 */
export async function checkpointAfterTask({ env, db, userId, goalId, task, output, checkpointModel, planModel }) {
    if (!env || !db || !task) return { action: 'continue' };
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
    if (!decision || decision.action !== 'replan') return { action: 'continue' };
    const reason = cleanText(decision.reason, 300) || '当前结果不足';
    const result = await replanRemaining({ env, db, userId, goalId, reason, planModel });
    return result.replanned ? { action: 'replan', ...result } : { action: 'continue', reason: result.reason || 'replan_failed' };
}
