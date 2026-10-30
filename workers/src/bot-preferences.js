/**
 * Bot 交流偏好：独立于「关于我」的表达方式记忆。
 *
 * 与事实档案分开存（bot_preferences），只影响怎么说话，不把偏好当事实；
 * 微信里用户说「太官方了 / 太啰嗦了 / 不用安慰我」时，不直接改库，而是先落一条
 * bot_pending_actions 的 set_preference，回「确认」才写入，回「取消」什么都不动。
 * 所有删除只改 is_deleted = 1（软删），用户数据永不物理删除。
 */
import { jsonResponse, readJsonCapped, isValidRecordId } from './security.js';
import {
    readPendingAction, savePendingAction, clearPendingAction
} from './bot-memory.js';

export const PREF_MAX_ITEMS = 8;
export const PREF_MAX_CHARS = 800;
export const PREF_ITEM_MAX_CHARS = 240;
export const PREF_LABEL_MAX_CHARS = 24;
const PREF_LIST_LIMIT = 12;
const MAX_PREF_BODY_BYTES = 4096;

const PREF_PRESETS = {
    tone: '日常聊天',
    opinion: '表达观点',
    length: '回复长度',
    proactive: '主动建议',
    analysis: '回答方式',
    custom: '交流偏好'
};
const PREF_ALIASES = {
    tone: ['tone', '日常聊天', '聊天', '语气', '聊天风格', '说话方式', '表达方式'],
    opinion: ['opinion', '表达观点', '观点', '看法', '不同意见'],
    length: ['length', '回复长度', '长度', '篇幅', '简洁', '长短'],
    proactive: ['proactive', '主动建议', '建议', '方案', '主动'],
    analysis: ['analysis', '回答方式', '分析方式', '分析', '回答风格'],
    custom: ['custom', '交流偏好', '偏好', '自定义']
};
const PREF_ORDER = ['tone', 'opinion', 'length', 'proactive', 'analysis', 'custom'];

const LIST_RE = /^(?:我的|查看|看看)?\s*(?:交流)?偏好(?:列表)?[\s。！!～~]*$/i;
const DELETE_RE = /^(?:忘记|删掉|删除|移除)\s*(?:交流)?偏好\s*[:：#]?\s*([\s\S]+)$/i;
const DELETE_BARE_RE = /^(?:忘记|删掉|删除|移除)\s*(?:交流)?偏好[\s。！!～~]*$/i;
const SET_COLON_RE = /^(?:设置|设定|记下|新增|改)?\s*(?:交流)?偏好\s*[:：]\s*([\s\S]+)$/i;
const SET_SPACE_RE = /^(?:设置|设定|记下|新增|改)?\s*(?:交流)?偏好\s+([\s\S]+)$/i;
const SET_BARE_RE = /^(?:设置|设定|记下|新增|改)\s*(?:交流)?偏好[\s。！!～~]*$/i;
const CONFIRM_RE = /^(?:确认|确定|确认执行|确认修改|ok|yes)[\s。！!～~]*$/i;
const CANCEL_RE = /^(?:取消|算了|不要了|不删了|不改了|先不删|先不改|no)[\s。！!～~]*$/i;

function clip(text, max) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
}

function flat(text, max) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizePreferenceKey(value) {
    const raw = String(value == null ? '' : value).trim().toLowerCase();
    if (!raw) return null;
    for (const key of PREF_ORDER) {
        if (PREF_ALIASES[key].some(alias => alias.toLowerCase() === raw)) return key;
    }
    return null;
}

export function preferenceLabel(key, fallback) {
    return PREF_PRESETS[key] || clip(fallback, PREF_LABEL_MAX_CHARS) || '交流偏好';
}

/** 读当前用户的交流偏好（未软删，按写入顺序） */
export async function listPreferences(db, userId) {
    if (!db || !userId) return [];
    const rows = await db.prepare(
        'SELECT id, pref_key, label, content, source, created_at, updated_at FROM bot_preferences '
        + 'WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id ASC LIMIT ?2'
    ).bind(Number(userId), PREF_LIST_LIMIT).all();
    return (rows && rows.results) || [];
}

async function findPreferenceByKey(db, userId, key) {
    if (!db || !userId || !key) return null;
    return db.prepare(
        'SELECT id, pref_key, label, content, source FROM bot_preferences WHERE user_id = ?1 AND pref_key = ?2 AND is_deleted = 0 ORDER BY id DESC LIMIT 1'
    ).bind(Number(userId), key).first();
}

/** 写一条偏好：同一类别覆盖旧值（软删旧行）由 UI/指令统一走这里 */
export async function savePreference(db, userId, input) {
    const key = normalizePreferenceKey(input && input.key) || 'custom';
    const content = clip(input && input.content, PREF_ITEM_MAX_CHARS);
    if (!content) return { ok: false, reason: 'empty' };
    const label = preferenceLabel(key, input && input.label);
    const source = input && input.source === 'feedback' ? 'feedback' : (input && input.source === 'user' ? 'user' : 'explicit');
    try {
        const existing = await findPreferenceByKey(db, userId, key);
        if (existing) {
            await db.prepare(
                "UPDATE bot_preferences SET label = ?1, content = ?2, source = ?3, updated_at = datetime('now', '+8 hours') "
                + 'WHERE id = ?4 AND user_id = ?5 AND is_deleted = 0'
            ).bind(label, content, source, existing.id, Number(userId)).run();
            return { ok: true, id: existing.id, updated: true, label, content };
        }
        const items = await listPreferences(db, userId);
        if (items.length >= PREF_MAX_ITEMS) return { ok: false, reason: 'full' };
        const res = await db.prepare(
            'INSERT INTO bot_preferences (user_id, pref_key, label, content, source, is_deleted) VALUES (?1, ?2, ?3, ?4, ?5, 0)'
        ).bind(Number(userId), key, label, content, source).run();
        return { ok: true, id: (res && res.meta && res.meta.last_row_id) || 0, updated: false, label, content };
    } catch (err) {
        console.error('[preferences] 写入交流偏好失败: ' + (err && err.message));
        return { ok: false, reason: 'error' };
    }
}

/** 应用内按 id 改内容（类别不改，避免一条偏好变成另一类） */
export async function updatePreferenceById(db, userId, id, content, label) {
    const rid = Number(id);
    const body = String(content == null ? '' : content).trim();
    if (!db || !userId || !isValidRecordId(rid) || !body) return { ok: false, reason: 'invalid' };
    const current = await db.prepare(
        'SELECT label FROM bot_preferences WHERE id = ?1 AND user_id = ?2 AND is_deleted = 0'
    ).bind(rid, Number(userId)).first();
    if (!current) return { ok: false, reason: 'not_found' };
    const nextLabel = label ? preferenceLabel(null, label) : current.label;
    const res = await db.prepare(
        "UPDATE bot_preferences SET content = ?1, label = ?2, updated_at = datetime('now', '+8 hours') "
        + 'WHERE id = ?3 AND user_id = ?4 AND is_deleted = 0'
    ).bind(clip(body, PREF_ITEM_MAX_CHARS), nextLabel, rid, Number(userId)).run();
    return { ok: ((res && res.meta && res.meta.changes) || 0) > 0 };
}

export async function forgetPreferenceById(db, userId, id) {
    const rid = Number(id);
    if (!db || !userId || !isValidRecordId(rid)) return { removed: 0 };
    const res = await db.prepare(
        "UPDATE bot_preferences SET is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2 AND is_deleted = 0"
    ).bind(rid, Number(userId)).run();
    return { removed: (res && res.meta && res.meta.changes) || 0 };
}

export async function clearPreferences(db, userId) {
    if (!db || !userId) return { removed: 0 };
    const res = await db.prepare(
        "UPDATE bot_preferences SET is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE user_id = ?1 AND is_deleted = 0"
    ).bind(Number(userId)).run();
    return { removed: (res && res.meta && res.meta.changes) || 0 };
}

/** 拼成注入提示词的偏好块；预算独立于「关于我」档案 */
export async function loadPreferencePrompt(db, userId) {
    const items = await listPreferences(db, userId);
    if (!items.length) return '';
    items.sort((a, b) => {
        const ai = PREF_ORDER.indexOf(a.pref_key);
        const bi = PREF_ORDER.indexOf(b.pref_key);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
    const lines = [];
    let used = 0;
    for (const it of items) {
        const line = '- ' + (it.label || preferenceLabel(it.pref_key)) + '：' + String(it.content || '');
        if (used + line.length > PREF_MAX_CHARS) break;
        used += line.length;
        lines.push(line);
    }
    return lines.join('\n');
}

function parseSetBody(body) {
    const text = String(body || '').trim();
    if (!text) return null;
    const colon = /^([^\s:：]{1,12})\s*[:：]\s*([\s\S]+)$/.exec(text);
    if (colon) {
        const key = normalizePreferenceKey(colon[1]);
        if (key) return { key, label: preferenceLabel(key), content: colon[2].trim() };
    }
    const space = /^([^\s]{1,12})\s+([\s\S]+)$/.exec(text);
    if (space) {
        const key = normalizePreferenceKey(space[1]);
        if (key) return { key, label: preferenceLabel(key), content: space[2].trim() };
    }
    return { key: 'custom', label: preferenceLabel('custom'), content: text };
}

/** 把日常反馈收敛成一条可确认的偏好；只认短句，避免误伤正常讨论 */
export function detectFeedbackPreference(text) {
    const raw = String(text || '').trim();
    if (!raw || raw.length > 100 || /[?？]$/.test(raw)) return null;
    const rules = [
        { re: /(?:不用|不要|别)(?:再)?(?:安慰|共情)|直接说.{0,6}(?:看法|意见)|直接给.{0,6}(?:看法|意见)/, key: 'opinion', content: '不用安慰或共情，直接表达看法' },
        { re: /太啰嗦|太长了|废话太多|说重点|简洁点|简短点|短一点|别绕/, key: 'length', content: '更简洁，少铺垫，直接说重点' },
        { re: /别每次.{0,8}(?:建议|方案)|不要每次.{0,8}(?:建议|方案)|(?:主动建议|建议).{0,4}(?:少|别|不要)/, key: 'proactive', content: '只在有价值时提建议，不要每次给方案' },
        { re: /这个分析不错|分析不错|以后.{0,8}这样回答|保持这种(?:回答|分析)|回答得不错/, key: 'analysis', content: '保持这种分析方式，不要退回套话或泛泛而谈' },
        { re: /太官方|太客套|客服腔|官腔|太像客服|太正式/, key: 'tone', content: '更自然，少一点官方/客服腔，不要过度共情' }
    ];
    for (const rule of rules) {
        if (rule.re.test(raw)) {
            return { key: rule.key, label: preferenceLabel(rule.key), content: rule.content, source: 'feedback' };
        }
    }
    return null;
}

async function stagePreference(db, userId, pref) {
    const content = clip(pref.content, PREF_ITEM_MAX_CHARS);
    if (!content) return '这条偏好没有内容，再说一次？';
    const label = preferenceLabel(pref.key, pref.label);
    await savePendingAction(db, userId, 'set_preference', 'preference', 0, {
        key: pref.key, label, content, source: pref.source || 'explicit'
    });
    return '我理解成一条「' + label + '」偏好：\n\n> ' + content
        + '\n\n要记下来就回「确认」；不想改就回「取消」。';
}

async function runListPreferences(db, userId) {
    const items = await listPreferences(db, userId);
    if (!items.length) {
        return '还没有设置交流偏好。\n\n可以直接说「偏好 日常聊天：更自然，不要过度共情」，'
            + '或者觉得我哪句不合适时说「太官方了 / 太啰嗦了」，我会先问你确认。';
    }
    const lines = items.map(it => '#' + it.id + ' ' + (it.label || preferenceLabel(it.pref_key)) + '：' + it.content);
    return '**你的交流偏好**（只影响表达方式，不改事实记忆）\n\n' + lines.join('\n')
        + '\n\n改：在设置里编辑，或发「偏好 <类别>：<内容>」；删：发「忘记偏好 <关键词>」。';
}

async function findDeleteMatches(db, userId, query) {
    const arg = String(query || '').trim();
    if (/^\d+$/.test(arg)) {
        const row = await db.prepare(
            'SELECT id, pref_key, label, content FROM bot_preferences WHERE id = ?1 AND user_id = ?2 AND is_deleted = 0'
        ).bind(Number(arg), Number(userId)).first();
        return row ? [row] : [];
    }
    const kw = arg.toLowerCase();
    const items = await listPreferences(db, userId);
    return items.filter(it => String(it.label || '').toLowerCase().includes(kw) || String(it.content || '').toLowerCase().includes(kw));
}

async function stageDeletePreference(db, userId, query) {
    const matches = await findDeleteMatches(db, userId, query);
    if (!matches.length) return '没有找到匹配「' + flat(query, 40) + '」的交流偏好。发「偏好」看看现有设置。';
    await savePendingAction(db, userId, 'delete_preference', 'preference', 0, { query: String(query || '').trim() });
    const preview = matches.slice(0, 3).map(it => '「' + (it.label || preferenceLabel(it.pref_key)) + '：' + flat(it.content, 60) + '」').join('、');
    return '要删掉 ' + matches.length + ' 条交流偏好：' + preview + '。\n\n回「确认」执行，回「取消」不动。';
}

async function confirmSetPreference(db, userId, pending) {
    const payload = pending.payload || {};
    const res = await savePreference(db, userId, payload);
    await clearPendingAction(db, userId);
    if (!res.ok) {
        if (res.reason === 'full') return '交流偏好最多 ' + PREF_MAX_ITEMS + ' 条，先发「忘记偏好 <关键词>」删一条再记。';
        return '这条偏好没记上（存储临时不可用），稍后再试一次。';
    }
    return '好，记下了「' + res.label + '：' + res.content + '」。以后聊天我会按这个来。';
}

async function confirmDeletePreference(db, userId, pending) {
    const query = (pending.payload && pending.payload.query) || '';
    const matches = await findDeleteMatches(db, userId, query);
    if (!matches.length) {
        await clearPendingAction(db, userId);
        return '这些偏好已经不在了，可能之前已经删过。';
    }
    for (const it of matches) await forgetPreferenceById(db, userId, it.id);
    await clearPendingAction(db, userId);
    return '已删掉 ' + matches.length + ' 条交流偏好；只是软删，原始数据还在。';
}

async function confirmPreferencePending(db, userId, pending) {
    if (pending.expired) {
        await clearPendingAction(db, userId);
        return String(pending.action) === 'delete_preference'
            ? '上次的删除确认已经过期了，重新发「忘记偏好 <关键词>」吧。'
            : '上次的偏好确认已经过期了，重新说一次或重新发「偏好：...」吧。';
    }
    if (pending.action === 'set_preference') return confirmSetPreference(db, userId, pending);
    if (pending.action === 'delete_preference') return confirmDeletePreference(db, userId, pending);
    return null;
}

/**
 * 交流偏好入口。注意调用顺序：它只接管自己的待确认动作，
 * 遇到收藏/提示词的 pending 时返回 null，交给 bot-butler。
 */
export async function maybePreferenceCommand(db, userId, text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    if (LIST_RE.test(raw)) return runListPreferences(db, userId);
    if (DELETE_BARE_RE.test(raw)) return '要删哪条交流偏好？发「忘记偏好 <关键词或编号>」，我会先问一次再删。';
    if (SET_BARE_RE.test(raw)) return '想设成什么？比如「偏好 日常聊天：更自然，不要过度共情」。';

    const wantsConfirm = CONFIRM_RE.test(raw);
    const wantsCancel = CANCEL_RE.test(raw);
    if (wantsConfirm || wantsCancel) {
        const pending = await readPendingAction(db, userId);
        if (!pending) return null;
        if (pending.action !== 'set_preference' && pending.action !== 'delete_preference') return null;
        if (wantsCancel) {
            await clearPendingAction(db, userId);
            return '好，这条交流偏好不动了。';
        }
        if (/^确认删除/i.test(raw) && pending.action !== 'delete_preference') {
            return '这次待确认的是偏好设定，不是删除。回「确认」记下，或回「取消」放弃。';
        }
        if (/^确认修改/i.test(raw) && pending.action === 'delete_preference') {
            return '这次待确认的是删除偏好，不是修改。回「确认」删除，或回「取消」放弃。';
        }
        return confirmPreferencePending(db, userId, pending);
    }

    const del = DELETE_RE.exec(raw);
    if (del) return stageDeletePreference(db, userId, del[1].trim());

    const set = SET_COLON_RE.exec(raw) || SET_SPACE_RE.exec(raw);
    if (set) {
        const parsed = parseSetBody(set[1]);
        if (!parsed) return '这条偏好没有内容，再说一次？';
        return stagePreference(db, userId, { ...parsed, source: 'explicit' });
    }

    const feedback = detectFeedbackPreference(raw);
    if (feedback) return stagePreference(db, userId, feedback);
    return null;
}

// ─────────────── 应用内交流偏好接口 ───────────────

export async function handleBotPreferencesApi(request, env, url, db, userId) {
    const path = url.pathname;
    try {
        if (path === '/api/bot/preferences' && request.method === 'GET') {
            const items = await listPreferences(db, userId);
            return jsonResponse({ items, maxItems: PREF_MAX_ITEMS, itemMaxChars: PREF_ITEM_MAX_CHARS }, 200);
        }
        if (path === '/api/bot/preferences' && request.method === 'POST') {
            const parsed = await readJsonCapped(request, MAX_PREF_BODY_BYTES);
            if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
            const payload = parsed.value || {};
            const key = normalizePreferenceKey(payload.key);
            if (payload.key != null && String(payload.key).trim() && !key) {
                return jsonResponse({ error: '不认识的偏好类别' }, 400);
            }
            const res = await savePreference(db, userId, {
                key: key || 'custom',
                label: payload.label,
                content: payload.content,
                source: 'user'
            });
            if (!res.ok) {
                if (res.reason === 'full') return jsonResponse({ error: '交流偏好最多 ' + PREF_MAX_ITEMS + ' 条，先删一条再记新的' }, 409);
                return jsonResponse({ error: '内容不能为空' }, 400);
            }
            return jsonResponse({ ok: true, id: res.id, updated: !!res.updated }, 200);
        }
        if (path === '/api/bot/preferences/clear' && request.method === 'POST') {
            return jsonResponse(await clearPreferences(db, userId), 200);
        }
        const one = path.match(/^\/api\/bot\/preferences\/(\d+)$/);
        if (one && request.method === 'PUT') {
            const parsed = await readJsonCapped(request, MAX_PREF_BODY_BYTES);
            if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
            const payload = parsed.value || {};
            const res = await updatePreferenceById(db, userId, one[1], payload.content, payload.label);
            if (!res.ok) {
                const status = res.reason === 'invalid' ? 400 : 404;
                return jsonResponse({ error: res.reason === 'invalid' ? '内容不能为空' : '这条偏好不存在' }, status);
            }
            return jsonResponse({ ok: true }, 200);
        }
        if (one && request.method === 'DELETE') {
            const res = await forgetPreferenceById(db, userId, one[1]);
            if (!res.removed) return jsonResponse({ error: '这条偏好不存在' }, 404);
            return jsonResponse({ ok: true, removed: res.removed }, 200);
        }
    } catch (err) {
        console.error('[preferences] 交流偏好接口失败: ' + (err && err.message));
        return jsonResponse({ error: '偏好服务暂时不可用，请稍后重试' }, 502);
    }
    return jsonResponse({ error: '接口不存在' }, 404);
}
