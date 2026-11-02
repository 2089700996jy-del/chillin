/**
 * Bot 管家写入：把显式的「收藏：…」「提示词：…」落进对应花园资源。
 *
 * 只认确定性指令，不靠模型猜意图；格式不对就明确告诉用户怎么发，
 * 宁可少记，也不能把普通聊天误写成收藏或提示词。
 */
import { handlePostFeed, handlePostBookmark, handlePostPrompt } from './garden-resources.js';
import { readPendingMedia, clearPendingMedia, parsePendingImageBatch } from './bot-memory.js';
import { buildManualLinkCard } from './bot-links.js';
import { checkRateLimitShared } from './security.js';
import { createGoal, generatePlan, getGoalDetail, listGoalSummaries, decideApproval } from './agent-goals.js';
import { pauseGoal } from './agent-executor.js';
import { queueGoal } from './agent-scheduler.js';
import { AgentError, listApprovalInbox } from './agent-store.js';

export const MAX_FEED_CHARS = 4000;
export const MAX_BOOKMARK_TITLE_CHARS = 120;
export const MAX_BOOKMARK_DESC_CHARS = 500;
export const MAX_BOOKMARK_URL_CHARS = 2000;
export const MAX_PROMPT_TITLE_CHARS = 120;
export const MAX_PROMPT_CONTENT_CHARS = 4000;

const CMD_PREFIX = '(?:请|帮我|麻烦(?:你)?|帮)?\s*';
const BOOKMARK_CATEGORIES = {
    '网站': '🌐 网站',
    '工具': '🛠️ 工具',
    '店铺': '🛒 店铺',
    '电影': '🎬 电影',
    '书籍': '📖 书籍',
    '书': '📖 书籍',
    '音乐': '🎵 音乐'
};
const TYPE_EMOJI = {
    '🌐': '🌐 网站',
    '🛠️': '🛠️ 工具',
    '🛒': '🛒 店铺',
    '🎬': '🎬 电影',
    '📖': '📖 书籍',
    '🎵': '🎵 音乐'
};

export function normalizeBookmarkType(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (BOOKMARK_CATEGORIES[raw]) return BOOKMARK_CATEGORIES[raw];
    for (const [emoji, type] of Object.entries(TYPE_EMOJI)) {
        if (raw === type || raw.startsWith(emoji)) return type;
    }
    return null;
}

export const BOOKMARK_RE = new RegExp(
    '^' + CMD_PREFIX + '(?:(?:收藏|记录收藏|存收藏|保存收藏|存进收藏|\/bookmark)[ \t]*[:：][ \t]*|(?:收藏一下|记录收藏一下|存一下收藏)[ \t]+)([\\s\\S]+)$',
    'i'
);
export const PROMPT_RE = new RegExp(
    '^' + CMD_PREFIX + '(?:(?:提示词|记录提示词|存提示词|保存提示词|新建提示词|添加提示词|\/prompt)[ \t]*[:：][ \t]*|(?:记录|保存|新建|添加)(?:一个|一条)?提示词[ \t]+)([\\s\\S]+)$',
    'i'
);
export const BOOKMARK_BARE_RE = new RegExp(
    '^' + CMD_PREFIX + '(?:收藏|收藏一下|记录收藏|记录收藏一下|存收藏|存一下收藏|保存收藏|存进收藏|\/bookmark)[\\s:：。！!？?～~]*$',
    'i'
);
export const PROMPT_BARE_RE = new RegExp(
    '^' + CMD_PREFIX + '(?:提示词|记录提示词|存提示词|保存提示词|新建提示词|添加提示词|\/prompt)[\\s:：。！!？?～~]*$',
    'i'
);

export const BOOKMARK_FORMAT_HINT = '收藏需要一个链接。发「收藏：<标题> <链接>」，比如「收藏：Figma https://figma.com」；只发链接也可以。';
export const PROMPT_FORMAT_HINT = '提示词需要标题和正文。发「提示词：<标题> | <正文>」，前面可加分类，比如「提示词：[开发/代码] 代码审查 | 请审查以下代码」。';
export const BOOKMARK_BARE_REPLY = '要收藏哪个链接？发「收藏：<标题> <链接>」，比如「收藏：Figma https://figma.com」。';
export const PROMPT_BARE_REPLY = '要记哪条提示词？发「提示词：<标题> | <正文>」；需要分类就写「[项目/场景]」。';

export function parseBookmarkCommand(text) {
    const m = BOOKMARK_RE.exec(String(text || '').trim());
    const body = m ? m[1].trim() : '';
    return body || null;
}

export function parsePromptCommand(text) {
    const m = PROMPT_RE.exec(String(text || '').trim());
    const body = m ? m[1].trim() : '';
    return body || null;
}

function trimField(value) {
    return String(value || '')
        .replace(/^[\s|｜\-—:：,，.。!?！？;；、]+|[\s|｜\-—:：,，.。!?！？;；、]+$/g, '')
        .trim();
}

function stripUrlTail(value) {
    return String(value || '').replace(/[.,!?，。！？；;、：:'"“”‘’]+$/g, '');
}

function urlTitle(url) {
    try {
        const host = new URL(url).hostname.replace(/^www\./i, '');
        return host || '链接收藏';
    } catch (_) {
        return '链接收藏';
    }
}

function detectCategory(title) {
    const bracket = title.match(/^[\[【]\s*([^\]】]{1,12})\s*[\]】]\s*/);
    if (bracket) {
        const mapped = BOOKMARK_CATEGORIES[bracket[1].trim()];
        if (mapped) return { type: mapped, title: title.slice(bracket[0].length).trim() };
    }
    const emoji = title.match(/^(🌐|🛠️|🛒|🎬|📖|🎵)\s*/u);
    if (emoji) return { type: TYPE_EMOJI[emoji[1]], title: title.slice(emoji[0].length).trim() };
    return { type: '🌐 网站', title };
}

export function parseBookmarkFields(raw) {
    const content = String(raw || '').trim();
    if (!content) return { ok: false, error: BOOKMARK_FORMAT_HINT };

    const match = content.match(/https?:\/\/[^\s<>"'，。；;、）】》|｜]+/i)
        || content.match(/www\.[^\s<>"'，。；;、）】》|｜]+/i);
    if (!match) return { ok: false, error: BOOKMARK_FORMAT_HINT };

    let url = stripUrlTail(match[0]);
    if (/^www\./i.test(url)) url = 'https://' + url;
    if (url.length > MAX_BOOKMARK_URL_CHARS) {
        return { ok: false, error: '这个链接太长了，先在浏览器里缩短一下再发给我。' };
    }
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { ok: false, error: BOOKMARK_FORMAT_HINT };
        }
    } catch (_) {
        return { ok: false, error: BOOKMARK_FORMAT_HINT };
    }

    let before = trimField(content.slice(0, match.index));
    let after = trimField(content.slice(match.index + match[0].length));
    if (!before && after) {
        // 「收藏：<链接> <标题>」也认：链接后面第一段当标题，其余当备注。
        const parts = after.split(/[|｜]/).map(s => s.trim()).filter(Boolean);
        before = parts.shift() || '';
        after = parts.join(' | ');
    }

    let category = detectCategory(before);
    let title = category.title;
    const type = category.type;
    if (!title) title = urlTitle(url);
    if (!title) title = '链接收藏';
    if (title.length > MAX_BOOKMARK_TITLE_CHARS) {
        title = title.slice(0, MAX_BOOKMARK_TITLE_CHARS - 1) + '…';
    }
    const description = after.length > MAX_BOOKMARK_DESC_CHARS
        ? after.slice(0, MAX_BOOKMARK_DESC_CHARS - 1) + '…'
        : after;
    return { ok: true, type, title, url, description };
}

export function parsePromptFields(raw) {
    let body = String(raw || '').trim();
    if (!body) return { ok: false, error: PROMPT_FORMAT_HINT };

    let project = '通用';
    let scene = '开发';
    const prefix = body.match(/^[\[【]\s*([^\]】/／]{1,20})(?:\s*[/／]\s*([^\]】]{1,20}))?\s*[\]】]\s*/);
    if (prefix) {
        project = prefix[1].trim() || '通用';
        scene = (prefix[2] || '通用').trim() || '通用';
        body = body.slice(prefix[0].length).trim();
    }

    let sepIndex = -1;
    let sepLength = 0;
    const pipe = body.search(/[|｜]/);
    const newline = body.indexOf('\n');
    if (pipe >= 0 && (newline < 0 || pipe < newline)) {
        sepIndex = pipe;
        sepLength = 1;
    } else if (newline >= 0) {
        sepIndex = newline;
        sepLength = 1;
    } else if (body.indexOf('::') >= 0) {
        sepIndex = body.indexOf('::');
        sepLength = 2;
    }
    if (sepIndex < 0) return { ok: false, error: PROMPT_FORMAT_HINT };

    const title = body.slice(0, sepIndex).trim();
    const content = body.slice(sepIndex + sepLength).trim();
    if (!title || !content) return { ok: false, error: PROMPT_FORMAT_HINT };
    if (content.length > MAX_PROMPT_CONTENT_CHARS) {
        return { ok: false, error: '这条提示词正文超过 ' + MAX_PROMPT_CONTENT_CHARS + ' 字了，先拆成两条再发给我。' };
    }
    return {
        ok: true,
        title: title.length > MAX_PROMPT_TITLE_CHARS ? title.slice(0, MAX_PROMPT_TITLE_CHARS - 1) + '…' : title,
        project: project.slice(0, 30),
        scene: scene.slice(0, 30),
        content,
        description: '',
        tags: '',
        is_pinned: 0
    };
}

async function responseError(res) {
    try {
        const data = await res.json();
        return data && data.error ? '（' + data.error + '）' : '';
    } catch (_) {
        return '';
    }
}

function preview(text, max) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

export async function runBookmarkCommand(db, userId, raw) {
    const parsed = parseBookmarkFields(raw);
    if (!parsed.ok) return parsed.error;
    const res = await handlePostBookmark(new Request('https://chillin.internal/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            type: parsed.type,
            title: parsed.title,
            url: parsed.url,
            description: parsed.description
        })
    }), db, userId);
    if (!res.ok) {
        console.error('[bot] 存收藏失败 status=' + res.status);
        return '收藏没存上' + await responseError(res) + '，稍后再试一次？';
    }
    const desc = parsed.description ? '\n> ' + preview(parsed.description, 120) : '';
    return '已存入**收藏** ✅\n\n> ' + parsed.type + ' · ' + parsed.title + '\n> ' + parsed.url + desc;
}

export async function runPromptCommand(db, userId, raw) {
    const parsed = parsePromptFields(raw);
    if (!parsed.ok) return parsed.error;
    const res = await handlePostPrompt(new Request('https://chillin.internal/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: parsed.title,
            project: parsed.project,
            scene: parsed.scene,
            content: parsed.content,
            description: parsed.description,
            tags: parsed.tags,
            is_pinned: parsed.is_pinned
        })
    }), db, userId);
    if (!res.ok) {
        console.error('[bot] 存提示词失败 status=' + res.status);
        return '提示词没存上' + await responseError(res) + '，稍后再试一次？';
    }
    return '已存入**提示词** ✅\n\n> [' + parsed.project + '/' + parsed.scene + '] ' + parsed.title
        + '\n> ' + preview(parsed.content, 160);
}
/** 存进随手记：复用既有 CRUD handler，等价于前端调 POST /api/feeds（带图或带卡片元数据时补齐 payload） */
export async function saveFeed(db, userId, content, mediaUrl, summary, type) {
    const payload = { content };
    if (mediaUrl) payload.media_url = mediaUrl;
    if (summary) payload.summary = summary;
    if (type) payload.type = type;
    else if (mediaUrl) payload.type = 'image';
    const res = await handlePostFeed(new Request('https://chillin.internal/api/feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }), db, userId);
    if (!res.ok) console.error('[bot] 存随手记失败 status=' + res.status);
    return res.ok;
}

export async function runRecord(db, userId, content) {
    const feed = content.slice(0, MAX_FEED_CHARS);
    // 用户自己写了标题（「记录：<标题> <链接>」）就顺手做成真卡片：抓不到元数据时的兜底路径，零出站
    const card = buildManualLinkCard(feed);
    const ok = card
        ? await saveFeed(db, userId, feed, '', JSON.stringify(card.meta), 'link')
        : await saveFeed(db, userId, feed);
    if (!ok) return '保存失败了，稍后再试一次？';
    const preview = feed.length > 160 ? feed.slice(0, 160) + '…' : feed;
    return '已存入**随手记** ✅\n\n> ' + preview.replace(/\n/g, '\n> ');
}

/**
 * 光杆「记录」：把暂存的内容（微信图片，或小宇宙链接速览）写进随手记。
 * 消息默认不落库，所以这条路径必须存在；没有待存内容时如实说明，
 * 而不是把「记录」当成闲聊丢给模型——那会让用户以为已经存好了。
 */
export async function runCommitPendingMedia(db, userId) {
    const pending = await readPendingMedia(db, userId);
    if (!pending) {
        return '这会儿没有等着存的东西——发完图或链接 1 小时内回我「记录」就行，超时我就放下了。要记文字直接发「记录：内容」。';
    }
    const isLink = !!pending.summary;
    const batch = isLink ? { caption: '', items: [] } : parsePendingImageBatch(pending.media_urls);
    if (!isLink && batch.items.length > 1) {
        let saved = 0;
        let first = '';
        for (const item of batch.items) {
            const body = [batch.caption, item.desc].filter(Boolean).join('\n\n') || '来自微信的图片';
            if (await saveFeed(db, userId, body.slice(0, MAX_FEED_CHARS), item.url, '', 'image')) {
                saved++;
                if (!first) first = body;
            }
        }
        if (!saved) return '保存失败了，稍后再试一次？';
        await clearPendingMedia(db, userId);
        const preview = first.length > 160 ? first.slice(0, 160) + '…' : first;
        return '已存入**随手记** ✅（' + saved + ' 张图各一条）\n\n> ' + preview.replace(/\n/g, '\n> ');
    }
    const content = String(pending.content).slice(0, MAX_FEED_CHARS);
    if (!(await saveFeed(db, userId, content, pending.media_url, pending.summary, isLink ? 'link' : 'image'))) {
        return '保存失败了，稍后再试一次？';
    }
    await clearPendingMedia(db, userId);
    const preview = content.length > 160 ? content.slice(0, 160) + '…' : content;
    return '已存入**随手记** ✅（' + (isLink ? '连链接卡片一起' : '连图一起') + '）\n\n> ' + preview.replace(/\n/g, '\n> ');
}

// ───────────────────────── Bot 里的目标 Agent 命令 ─────────────────────────

const GOAL_STATUS = {
    draft: '草稿', planned: '待开始', active: '进行中', paused: '已暂停',
    waiting_approval: '待审批', completed: '已完成', failed: '失败', cancelled: '已取消'
};
const TASK_STATUS = {
    pending: '待执行', ready: '就绪', running: '执行中', waiting_approval: '待审批',
    completed: '已完成', failed: '失败', skipped: '跳过', blocked: '阻塞'
};

function clip(value, max = 60) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function goalLine(goal) {
    const p = goal.progress || {};
    return '#' + goal.id + ' ' + clip(goal.title, 30) + ' · ' + (GOAL_STATUS[goal.status] || goal.status)
        + ' · ' + Number(p.completed || 0) + '/' + Number(p.total || 0);
}

async function createGoalFromBot(env, db, userId, raw) {
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

async function viewGoalFromBot(db, userId, goalId) {
    const snap = await getGoalDetail(db, userId, goalId);
    const goal = snap.goal;
    const tasks = snap.tasks || [];
    const p = goal.progress || {};
    const lines = [
        '#' + goal.id + ' ' + clip(goal.title, 40),
        '状态：' + (GOAL_STATUS[goal.status] || goal.status) + ' · 进度 ' + Number(p.completed || 0) + '/' + Number(p.total || 0)
    ];
    if (goal.description) lines.push('说明：' + clip(goal.description, 120));
    tasks.slice(0, 8).forEach((task) => {
        lines.push((task.seq + 1) + '. [' + (TASK_STATUS[task.status] || task.status) + '] ' + clip(task.title, 30));
    });
    if (tasks.length > 8) lines.push('…还有 ' + (tasks.length - 8) + ' 个任务');
    if (goal.error) lines.push('错误：' + clip(goal.error, 120));
    if (goal.result_md) lines.push('结果：' + clip(goal.result_md, 180));
    if (['planned', 'active', 'paused'].includes(goal.status)) {
        lines.push('回复「开始 ' + goal.id + '」或「暂停 ' + goal.id + '」。');
    }
    return lines.join('\n');
}

async function listApprovalsFromBot(db, userId) {
    const inbox = await listApprovalInbox(db, userId, 10);
    if (!inbox.pending_count) return '现在没有待审批的目标写入。';
    const lines = inbox.approvals.map((item) => {
        const payload = item.payload || {};
        const what = item.action_type === 'append_note'
            ? '追加到「' + (payload.note_title || '未命名笔记') + '」'
            : (item.action_type === 'send_bot_message' ? '通过 Bot 发送' : '保存为「' + (payload.title || '目标草稿') + '」');
        return '#' + item.id + ' ' + what + ' · 目标：' + clip(item.goal_title, 24);
    });
    return '待审批 ' + inbox.pending_count + ' 条（最多显示 10 条）：\n' + lines.join('\n')
        + '\n\n回复「同意 编号」或「拒绝 编号」。';
}

/**
 * Bot 的目标命令适配层：只解析命令并调用已有 Agent 函数，不复制执行逻辑。
 * 返回 null 表示不是目标/审批命令，继续走普通 Bot 分流。
 */
export async function maybeRunAgentCommand(env, db, userId, text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    let match;
    try {
        if ((match = raw.match(/^(?:目标|goal)[:：]\s*([\s\S]+)$/i))) {
            return await createGoalFromBot(env, db, userId, match[1]);
        }
        if (/^(?:我的目标|目标列表|goals?)$/i.test(raw)) {
            const goals = await listGoalSummaries(db, userId);
            if (!goals.length) return '还没有目标。发「目标：标题」创建一个。';
            return '最近的 ' + Math.min(goals.length, 8) + ' 个目标：\n'
                + goals.slice(0, 8).map(goalLine).join('\n')
                + '\n\n回复「看目标 编号」查看详情。';
        }
        if ((match = raw.match(/^(?:看目标|目标详情|目标)\s*#?(\d+)$/i))) {
            return await viewGoalFromBot(db, userId, Number(match[1]));
        }
        if ((match = raw.match(/^(?:开始目标|开始|继续目标|继续)\s*#?(\d+)$/i))) {
            const goalId = Number(match[1]);
            const result = await queueGoal(db, userId, goalId, 'bot');
            if (!result.queued) return '目标 #' + goalId + ' 正在执行，稍后看结果就行。';
            return '目标 #' + goalId + ' 已排队 ✅ 下一分钟后台会推进一个任务，回复「看目标 ' + goalId + '」查看。';
        }
        if ((match = raw.match(/^(?:暂停目标|暂停)\s*#?(\d+)$/i))) {
            const goalId = Number(match[1]);
            await pauseGoal(db, userId, goalId);
            return '目标 #' + goalId + ' 已暂停。回复「继续 ' + goalId + '」恢复。';
        }
        if (/^(?:审批|待审批|approvals?)$/i.test(raw)) return await listApprovalsFromBot(db, userId);
        if ((match = raw.match(/^(同意|拒绝)\s*#?(\d+)$/))) {
            const decision = match[1] === '同意' ? 'approve' : 'reject';
            const result = await decideApproval(db, userId, Number(match[2]), { decision });
            const approval = result.approval || {};
            if (result.already_decided) return '这条审批已经处理过了。';
            if (decision === 'reject') return '已拒绝这条审批，没有写入任何内容。';
            if (approval.action_type === 'append_note') {
                return '已追加到「' + clip(approval.payload && approval.payload.note_title, 40) + '」✅';
            }
            if (approval.action_type === 'send_bot_message') return '已通过 Bot 发送 ✅';
            const noteId = approval.result && approval.result.note_id;
            return noteId ? '已保存为笔记 #' + noteId + ' ✅' : '已同意并写入 ✅';
        }
    } catch (err) {
        if (err instanceof AgentError) return '目标操作没完成：' + err.message;
        throw err;
    }
    return null;
}
