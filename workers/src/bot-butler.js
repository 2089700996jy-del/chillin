/**
 * Bot 管家管理：收藏 / 提示词的列表、编辑、删除。
 *
 * 所有改动都先写一条 bot_pending_actions，用户回「确认」才执行；
 * 删除只改 is_deleted = 1（软删），不做物理删除。确认动作 10 分钟过期。
 */
import {
    handlePostBookmark, handlePostPrompt, handleDeleteBookmark, handleDeletePrompt
} from './garden-resources.js';
import { normalizeBookmarkType } from './bot-garden.js';
import { readPendingAction, savePendingAction, clearPendingAction } from './bot-memory.js';

const LIST_LIMIT = 10;
const MAX_TITLE = 120;
const MAX_DESC = 500;
const MAX_PROMPT = 4000;
const CATEGORY_HINT = '网站 / 工具 / 店铺 / 电影 / 书籍 / 音乐';

export const LIST_BOOKMARKS_RE = /^(?:我的收藏|收藏列表|查看收藏|看看收藏|\/bookmarks?)[\s。！!～~]*$/i;
export const LIST_PROMPTS_RE = /^(?:我的提示词|提示词列表|查看提示词|看看提示词|\/prompts?)[\s。！!～~]*$/i;
const DELETE_BOOKMARK_RE = /^(?:删除|删掉|删|移除)(?:收藏|书签)\s*[:：#]?\s*(\d+)[\s。！!～~]*$/i;
const DELETE_PROMPT_RE = /^(?:删除|删掉|删|移除)提示词\s*[:：#]?\s*(\d+)[\s。！!～~]*$/i;
const EDIT_BOOKMARK_RE = /^(?:修改|改|编辑|更新)(?:收藏|书签)\s*[:：#]?\s*(\d+)\s+([\s\S]+)$/i;
const EDIT_PROMPT_RE = /^(?:修改|改|编辑|更新)提示词\s*[:：#]?\s*(\d+)\s+([\s\S]+)$/i;
const CONFIRM_RE = /^(?:确认|确定|确认执行|确认删除|确认修改|ok|yes)[\s。！!～~]*$/i;
const CANCEL_RE = /^(?:取消|算了|不要了|不删了|不改了|先不删|先不改|no)[\s。！!～~]*$/i;

const BOOKMARK_KEYS = {
    '标题': 'title', 'title': 'title',
    '链接': 'url', '网址': 'url', 'url': 'url',
    '描述': 'description', '说明': 'description', 'desc': 'description', 'description': 'description',
    '分类': 'type', '类型': 'type', 'type': 'type'
};
const PROMPT_KEYS = {
    '标题': 'title', 'title': 'title',
    '正文': 'content', '内容': 'content', 'content': 'content',
    '项目': 'project', 'project': 'project',
    '场景': 'scene', 'scene': 'scene',
    '描述': 'description', '说明': 'description', 'desc': 'description', 'description': 'description',
    '标签': 'tags', 'tag': 'tags', 'tags': 'tags',
    '置顶': 'is_pinned', 'pinned': 'is_pinned', 'is_pinned': 'is_pinned'
};

function flat(text, max) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
}

function loadBookmark(db, userId, id) {
    return db.prepare(
        'SELECT id, type, title, url, description FROM bookmarks WHERE id = ?1 AND user_id = ?2 AND is_deleted = 0'
    ).bind(id, userId).first();
}

function loadPrompt(db, userId, id) {
    return db.prepare(
        'SELECT id, title, project, scene, content, description, tags, is_pinned FROM prompts WHERE id = ?1 AND user_id = ?2 AND is_deleted = 0'
    ).bind(id, userId).first();
}

function validId(id) {
    const n = Number(id);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function validUrl(value) {
    let url = String(value || '').trim();
    if (/^www\./i.test(url)) url = 'https://' + url;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        return url.slice(0, 2000);
    } catch (_) {
        return null;
    }
}

function parseBool(value) {
    if (typeof value === 'boolean') return value;
    const s = String(value || '').trim().toLowerCase();
    if (['1', 'true', 'yes', '是', '置顶', '开'].includes(s)) return true;
    if (['0', 'false', 'no', '否', '取消置顶', '关', ''].includes(s)) return false;
    return null;
}

function splitSegments(body) {
    return String(body || '').split(/[|｜\n]/).map(s => s.trim()).filter(Boolean);
}

function splitKeyedSegments(body, allowed) {
    const keys = Object.keys(allowed)
        .sort((a, b) => b.length - a.length)
        .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
    const re = new RegExp('\\s*[|｜\\n]\\s*(?=(?:' + keys + ')\\s*[=＝:：])', 'i');
    return String(body || '').split(re).map(s => s.trim()).filter(Boolean);
}

function parseEditSegments(body, allowed) {
    const keySegments = splitKeyedSegments(body, allowed);
    const keyed = keySegments.map(seg => {
        const m = /^([^=＝:：]{1,10})\s*[=＝:：]\s*([\s\S]*)$/.exec(seg);
        return m ? { key: m[1].trim().toLowerCase(), value: m[2].trim() } : null;
    });
    if (keyed.every(Boolean)) {
        const fields = {};
        for (const item of keyed) {
            const field = allowed[item.key];
            if (!field) {
                return { ok: false, error: '不认识的字段「' + item.key + '」。可用：' + Object.keys(allowed).join(' / ') };
            }
            fields[field] = item.value;
        }
        return { ok: true, fields, mode: 'keyed' };
    }
    if (keyed.some(Boolean)) {
        return { ok: false, error: '编辑字段请统一写成「标题=... | 链接=...」这种形式。' };
    }
    const segments = splitSegments(body);
    if (!segments.length) return { ok: false, error: '没有看到要改的内容。' };
    const genericKeyed = segments.map(seg => /^([^=＝:：]{1,10})\s*[=＝:：]\s*([\s\S]*)$/.test(seg));
    if (genericKeyed.some(Boolean)) {
        return { ok: false, error: '编辑字段请统一写成「标题=... | 链接=...」这种形式。' };
    }
    return { ok: true, parts: segments, mode: 'positional' };
}

function applyBookmarkParts(fields, parts) {
    if (parts.length > 4) return { ok: false, error: '收藏最多改「标题 | 链接 | 描述 | 分类」四项。' };
    if (parts.length >= 1) fields.title = parts[0];
    if (parts.length >= 2) fields.url = parts[1];
    if (parts.length >= 3) fields.description = parts[2];
    if (parts.length >= 4) fields.type = parts[3];
    return { ok: true };
}

function applyPromptParts(fields, parts) {
    if (parts.length > 6) return { ok: false, error: '提示词最多改「标题 | 正文 | 项目 | 场景 | 描述 | 标签」六项。' };
    if (parts.length >= 1) fields.title = parts[0];
    if (parts.length >= 2) fields.content = parts[1];
    if (parts.length >= 3) fields.project = parts[2];
    if (parts.length >= 4) fields.scene = parts[3];
    if (parts.length >= 5) fields.description = parts[4];
    if (parts.length >= 6) fields.tags = parts[5];
    return { ok: true };
}

export async function runListBookmarks(db, userId) {
    const result = await db.prepare(
        'SELECT id, type, title, url, description FROM bookmarks WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT ' + LIST_LIMIT
    ).bind(userId).all();
    const rows = result.results || [];
    if (!rows.length) return '收藏还是空的。发「收藏：<标题> <链接>」就能存第一条。';
    const lines = ['你的收藏（最近 ' + rows.length + ' 条）：'];
    for (const row of rows) {
        lines.push('');
        lines.push('#' + row.id + ' ' + (row.type || '🌐 网站') + ' · ' + flat(row.title, 80));
        lines.push('  ' + flat(row.url, 100));
        if (row.description) lines.push('  ' + flat(row.description, 80));
    }
    lines.push('');
    lines.push('改：改收藏 <编号> 标题=... | 链接=...');
    lines.push('删：删收藏 <编号>（会先确认，再软删）');
    return lines.join('\n');
}

export async function runListPrompts(db, userId) {
    const result = await db.prepare(
        'SELECT id, title, project, scene, content, is_pinned FROM prompts WHERE user_id = ?1 AND is_deleted = 0 ORDER BY is_pinned DESC, id DESC LIMIT ' + LIST_LIMIT
    ).bind(userId).all();
    const rows = result.results || [];
    if (!rows.length) return '提示词库还是空的。发「提示词：<标题> | <正文>」就能存第一条。';
    const lines = ['你的提示词（最近 ' + rows.length + ' 条）：'];
    for (const row of rows) {
        lines.push('');
        lines.push('#' + row.id + (row.is_pinned ? ' 📌' : '') + ' [' + (row.project || '通用') + '/' + (row.scene || '开发') + '] ' + flat(row.title, 80));
        lines.push('  ' + flat(row.content, 100));
    }
    lines.push('');
    lines.push('改：改提示词 <编号> 标题=... | 正文=... | 场景=...');
    lines.push('删：删提示词 <编号>（会先确认，再软删）');
    return lines.join('\n');
}

async function stageDelete(db, userId, kind, id) {
    const targetId = validId(id);
    if (!targetId) return '编号要是正整数，发「我的收藏」或「我的提示词」看编号。';
    const row = kind === 'bookmark' ? await loadBookmark(db, userId, targetId) : await loadPrompt(db, userId, targetId);
    if (!row) return '没有找到这条' + (kind === 'bookmark' ? '收藏' : '提示词') + '，可能已经被删了。';
    const label = kind === 'bookmark' ? '收藏' : '提示词';
    await savePendingAction(
        db, userId,
        kind === 'bookmark' ? 'delete_bookmark' : 'delete_prompt',
        kind, targetId, { title: row.title }
    );
    return '找到' + label + ' #' + targetId + '「' + flat(row.title, 80) + '」。\n\n'
        + '确认删除？删除只是移出列表和搜索，不会物理清空。\n'
        + '回「确认」继续，回「取消」放弃。';
}

async function stageEditBookmark(db, userId, id, body) {
    const targetId = validId(id);
    if (!targetId) return '编号要是正整数，发「我的收藏」看编号。';
    const row = await loadBookmark(db, userId, targetId);
    if (!row) return '没有找到这条收藏，可能已经被删了。';
    const parsed = parseEditSegments(body, BOOKMARK_KEYS);
    if (!parsed.ok) return parsed.error;
    const fields = {
        type: row.type || '🌐 网站',
        title: row.title,
        url: row.url,
        description: row.description || ''
    };
    const applied = parsed.mode === 'keyed' ? null : applyBookmarkParts(fields, parsed.parts);
    if (applied && !applied.ok) return applied.error;
    if (parsed.mode === 'keyed') Object.assign(fields, parsed.fields);

    const title = flat(fields.title, MAX_TITLE);
    if (!title) return '标题不能为空。';
    const url = validUrl(fields.url);
    if (!url) return '链接必须是 http/https 地址，比如 https://example.com。';
    const type = normalizeBookmarkType(fields.type);
    if (!type) return '分类不认识。可用：' + CATEGORY_HINT + '。';
    const description = String(fields.description || '').trim().slice(0, MAX_DESC);

    if (title === row.title && url === row.url && description === (row.description || '') && type === row.type) {
        return '这次没有改动。发「我的收藏」看看当前内容。';
    }
    const proposed = { type, title, url, description };
    await savePendingAction(db, userId, 'update_bookmark', 'bookmark', targetId, proposed);
    return '找到收藏 #' + targetId + '「' + flat(row.title, 80) + '」。\n\n'
        + '改后：\n'
        + '标题：' + title + '\n'
        + '链接：' + flat(url, 120) + '\n'
        + '分类：' + type + '\n'
        + '描述：' + (description || '（空）') + '\n\n'
        + '确认修改？回「确认」继续，回「取消」放弃。';
}

async function stageEditPrompt(db, userId, id, body) {
    const targetId = validId(id);
    if (!targetId) return '编号要是正整数，发「我的提示词」看编号。';
    const row = await loadPrompt(db, userId, targetId);
    if (!row) return '没有找到这条提示词，可能已经被删了。';
    const parsed = parseEditSegments(body, PROMPT_KEYS);
    if (!parsed.ok) return parsed.error;
    const fields = {
        title: row.title,
        content: row.content || '',
        project: row.project || '通用',
        scene: row.scene || '开发',
        description: row.description || '',
        tags: row.tags || '',
        is_pinned: row.is_pinned ? 1 : 0
    };
    const applied = parsed.mode === 'keyed' ? null : applyPromptParts(fields, parsed.parts);
    if (applied && !applied.ok) return applied.error;
    if (parsed.mode === 'keyed') Object.assign(fields, parsed.fields);

    const title = flat(fields.title, MAX_TITLE);
    const promptContent = String(fields.content || '').trim();
    if (!title) return '标题不能为空。';
    if (!promptContent) return '正文不能为空。';
    if (promptContent.length > MAX_PROMPT) return '正文超过 ' + MAX_PROMPT + ' 字了，先拆成两条。';
    const project = String(fields.project || '通用').trim().slice(0, 30) || '通用';
    const scene = String(fields.scene || '开发').trim().slice(0, 30) || '开发';
    const description = String(fields.description || '').trim().slice(0, MAX_DESC);
    const tags = String(fields.tags || '').trim().slice(0, 200);
    let pinned = fields.is_pinned;
    if (typeof pinned !== 'boolean' && typeof pinned !== 'number') {
        pinned = parseBool(pinned);
        if (pinned === null) return '置顶只能写 1 / 0 / 置顶 / 取消置顶。';
    }
    pinned = pinned ? 1 : 0;

    if (title === row.title && promptContent === row.content && project === row.project
        && scene === row.scene && description === (row.description || '')
        && tags === (row.tags || '') && pinned === (row.is_pinned ? 1 : 0)) {
        return '这次没有改动。发「我的提示词」看看当前内容。';
    }
    const proposed = { title, content: promptContent, project, scene, description, tags, is_pinned: pinned };
    await savePendingAction(db, userId, 'update_prompt', 'prompt', targetId, proposed);
    return '找到提示词 #' + targetId + '「' + flat(row.title, 80) + '」。\n\n'
        + '改后：\n'
        + '标题：' + title + '\n'
        + '项目/场景：' + project + ' / ' + scene + '\n'
        + '正文：' + flat(promptContent, 160) + '\n'
        + (tags ? '标签：' + tags + '\n' : '')
        + '置顶：' + (pinned ? '是' : '否') + '\n\n'
        + '确认修改？回「确认」继续，回「取消」放弃。';
}

async function responseError(res) {
    try {
        const data = await res.json();
        return data && data.error ? '（' + data.error + '）' : '';
    } catch (_) {
        return '';
    }
}

async function confirmDelete(db, userId, pending) {
    const kind = pending.target_table === 'bookmark' ? 'bookmark' : 'prompt';
    const targetId = Number(pending.target_id);
    const row = kind === 'bookmark' ? await loadBookmark(db, userId, targetId) : await loadPrompt(db, userId, targetId);
    if (!row) {
        await clearPendingAction(db, userId);
        return '这条已经不在了，可能之前已经删过。';
    }
    if (kind === 'bookmark') await handleDeleteBookmark(targetId, db, userId);
    else await handleDeletePrompt(targetId, db, userId);
    await clearPendingAction(db, userId);
    return '已删除' + (kind === 'bookmark' ? '收藏' : '提示词') + ' #' + targetId + '「' + flat(row.title, 80) + '」。\n\n'
        + '只是软删：列表和搜索里不再出现，原始数据还在。';
}

async function confirmUpdate(db, userId, pending) {
    const payload = pending.payload || {};
    const isBookmark = pending.action === 'update_bookmark';
    const targetId = Number(pending.target_id);
    const row = isBookmark ? await loadBookmark(db, userId, targetId) : await loadPrompt(db, userId, targetId);
    if (!row) {
        await clearPendingAction(db, userId);
        return '这条已经不在了，可能之前已经删过，改不了。';
    }
    if (isBookmark) {
        const res = await handlePostBookmark(new Request('https://chillin.internal/api/bookmarks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: Number(pending.target_id),
                type: payload.type,
                title: payload.title,
                url: payload.url,
                description: payload.description
            })
        }), db, userId);
        if (!res.ok) {
            const err = await responseError(res);
            await clearPendingAction(db, userId);
            return '没改上' + err + '。可能这条已经被删了；发「我的收藏」看看。';
        }
        await clearPendingAction(db, userId);
        return '已更新收藏 #' + pending.target_id + '「' + flat(payload.title, 80) + '」。';
    }
    const res = await handlePostPrompt(new Request('https://chillin.internal/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id: Number(pending.target_id),
            title: payload.title,
            project: payload.project,
            scene: payload.scene,
            content: payload.content,
            description: payload.description,
            tags: payload.tags,
            is_pinned: payload.is_pinned
        })
    }), db, userId);
    if (!res.ok) {
        const err = await responseError(res);
        await clearPendingAction(db, userId);
        return '没改上' + err + '。可能这条已经被删了；发「我的提示词」看看。';
    }
    await clearPendingAction(db, userId);
    return '已更新提示词 #' + pending.target_id + '「' + flat(payload.title, 80) + '」。';
}

async function confirmPending(db, userId, pending, text) {
    if (!pending) return '现在没有等你确认的操作。';
    if (pending.expired) {
        await clearPendingAction(db, userId);
        return '上次的确认已经过期了，重新发一次「删收藏 <编号>」或「改收藏 <编号> ...」。';
    }
    if (/^确认修改/i.test(text) && !String(pending.action).startsWith('update_')) {
        return '这次待确认的是删除，不是修改。回「确认」删除，或回「取消」放弃。';
    }
    if (/^确认删除/i.test(text) && !String(pending.action).startsWith('delete_')) {
        return '这次待确认的是修改，不是删除。回「确认」修改，或回「取消」放弃。';
    }
    if (String(pending.action).startsWith('delete_')) return confirmDelete(db, userId, pending);
    if (String(pending.action).startsWith('update_')) return confirmUpdate(db, userId, pending);
    await clearPendingAction(db, userId);
    return '这条确认信息不完整，重新发一次操作吧。';
}

export async function maybeManageGarden(db, userId, text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (LIST_BOOKMARKS_RE.test(raw)) return runListBookmarks(db, userId);
    if (LIST_PROMPTS_RE.test(raw)) return runListPrompts(db, userId);

    if (CONFIRM_RE.test(raw)) {
        const pending = await readPendingAction(db, userId);
        return confirmPending(db, userId, pending, raw);
    }
    if (CANCEL_RE.test(raw)) {
        const pending = await readPendingAction(db, userId);
        if (!pending) return null;
        if (pending.expired) {
            await clearPendingAction(db, userId);
            return '之前那条确认已经过期了，不用取消了。';
        }
        await clearPendingAction(db, userId);
        return '好，取消了，什么都没动。';
    }

    const delBookmark = DELETE_BOOKMARK_RE.exec(raw);
    if (delBookmark) return stageDelete(db, userId, 'bookmark', delBookmark[1]);
    const delPrompt = DELETE_PROMPT_RE.exec(raw);
    if (delPrompt) return stageDelete(db, userId, 'prompt', delPrompt[1]);

    const editBookmark = EDIT_BOOKMARK_RE.exec(raw);
    if (editBookmark) return stageEditBookmark(db, userId, editBookmark[1], editBookmark[2]);
    const editPrompt = EDIT_PROMPT_RE.exec(raw);
    if (editPrompt) return stageEditPrompt(db, userId, editPrompt[1], editPrompt[2]);
    return null;
}
