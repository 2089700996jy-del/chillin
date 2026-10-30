/**
 * 待办与定点提醒（v2.5.143）：用户开口授权的一次性提醒。
 *
 * 和 bot-outreach 的关系必须分清——两件事共用「发一条消息」这一个动作，但语义相反：
 *   bot-outreach 是**系统**想说话：每天至多一次、限 10:00–22:30、距上次说话 ≥30 分钟、0.65 概率闸门；
 *   bot-reminders 是**用户**叫我说话：到点就得说，不受日限/时窗/静默期约束。
 * 所以分表（bot_reminders / bot_outreach）、分开关（outreach_enabled / 无）、分审计。
 * 否则用户一句「别主动找我」会把他的提醒一起关掉——那是他的东西，不是系统的兴致。
 *
 * 状态机（见 migrations/0029_bot_reminders.sql + 0033_bot_reminder_follow_up_state.sql）：
 *   pending --到点--> fired --10 分钟（充电等慢任务 2 小时）--> 追问 --> done（回「完成」）
 *   pending --超过 2 小时没送出去--> missed（不补发：凌晨补一句「该充电了」是伤害不是服务）
 *   pending --「取消提醒 N」--> cancelled + is_deleted = 1
 *   fired --追问发送失败--> pending（退避重试，次数耗尽后 failed）
 *   fired --回「还没」--> skipped（不再追问，仍可回「完成」）
 *
 * 时间解析的立场：规则优先、猜错要看得见。解析出来的绝对时刻一定写回执里（「今天 20:00」），
 * 用户看到不对可以立刻取消——比反问一轮省事，也比默默猜错安全。
 * 只在文本真的出现时刻/日期词时才认指令：「我今天提醒我自己要早睡」不是指令。
 *
 * 幂等：先把行 claim 成 fired 再发（UPDATE … WHERE status='pending' 后查 changes），
 * 发送失败退回 pending、下一分钟重试；重试窗口就是 2 小时的 stale 窗口。
 * 聊天正文永不进日志（AGENTS 规约）：这里只记 id 与错误。
 */

import { checkRateLimitShared } from './security.js';
import { saveChatTurn } from './bot-memory.js';

/**
 * 东八区视角的日期 / 小时 / 当天零点。与 bot-outreach.js:87 那份实现逐字一致，
 * 在本模块自带一份的理由是依赖方向：bot-outreach 静态依赖 bot-claw，bot-claw 静态依赖
 * bot-commands，而本模块必须被 bot-commands 静态引入（解析函数要在同步分支里立刻用）——
 * 若再静态回指 bot-outreach/bot-claw，四者就成了静态环。
 * 发送函数同理，等 cron 真要发的时候再 await import('./bot-claw.js')。
 */
function east8Parts(nowMs) {
    const shifted = Number(nowMs) + 8 * 3600 * 1000;
    const dayStartShifted = Math.floor(shifted / 86400000) * 86400000;
    const at = new Date(shifted);
    return {
        ymd: at.toISOString().slice(0, 10),
        hour: at.getUTCHours(),
        minuteOfDay: at.getUTCHours() * 60 + at.getUTCMinutes(),
        dayStartMs: dayStartShifted - 8 * 3600 * 1000
    };
}

/** 到点没送出去超过 2 小时就不再补发 */
export const REMINDER_STALE_MS = 2 * 60 * 60 * 1000;
/** 普通任务开口后 10 分钟追问；充电等慢任务用 2 小时 */
export const REMINDER_FOLLOW_UP_MS = 10 * 60 * 1000;
export const REMINDER_FOLLOW_UP_SLOW_MS = 2 * 60 * 60 * 1000;
/** 追问失败最多尝试 5 次，指数退避（1/2/4/8 分钟，封顶 10 分钟） */
export const REMINDER_FOLLOW_UP_MAX_ATTEMPTS = 5;
export const REMINDER_FOLLOW_UP_LEASE_MS = 5 * 60 * 1000;
const REMINDER_FOLLOW_UP_RETRY_BASE_MS = 60 * 1000;
const REMINDER_FOLLOW_UP_RETRY_MAX_MS = 10 * 60 * 1000;
const SLOW_TASK_RE = /充电|电池|电瓶|电动车|汽车|保养|炖|煮|烘焙|发酵|长途|出差|航班|火车/;

function normalizeFollowUpMs(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.round(n), 60 * 1000), 24 * 3600 * 1000) : 0;
}

/** 任务语义决定追问间隔：慢任务给足时间，普通任务 10 分钟就问一次 */
export function followUpMsForText(text) {
    return SLOW_TASK_RE.test(String(text == null ? '' : text))
        ? REMINDER_FOLLOW_UP_SLOW_MS
        : REMINDER_FOLLOW_UP_MS;
}
/** 「完成」只认 12 小时内刚提醒过的那条 */
export const REMINDER_DONE_WINDOW_MS = 12 * 60 * 60 * 1000;
/** 一件事最多 200 字，提醒是短句不是备忘录 */
export const REMINDER_TEXT_MAX_CHARS = 200;
/** 同时待提醒的上限，防一次灌爆 */
export const REMINDER_MAX_ACTIVE = 20;
export const REMINDER_MIN_LEAD_MS = 60 * 1000;
export const REMINDER_MAX_LEAD_MS = 366 * 24 * 3600 * 1000;
/** 每分钟最多处理几条到期提醒（cron 预算内，剩下的下一分钟继续） */
export const REMINDER_TICK_BATCH = 5;
/** 每人每天最多设 30 条提醒 */
export const BOT_REMIND_LIMIT = { limit: 30, windowMs: 24 * 3600 * 1000 };

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 中文数字（一~二十四）：只处理 时/分 用得上的范围，其余返回 null */
export function cnNumber(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return Number(s);
    if (!/^[零〇一壹二两三四五六七八九十]+$/.test(s)) return null;
    if (s.length === 1) return CN_DIGITS[s];
    const at = s.indexOf('十');
    if (at < 0) return null;
    if (at === 0) return s.length === 1 ? 10 : 10 + (CN_DIGITS[s[1]] || 0);
    if (at === 1) return (CN_DIGITS[s[0]] || 0) * 10 + (s.length > 2 ? (CN_DIGITS[s[2]] || 0) : 0);
    return null;
}

function addDays(ymd, days) {
    const ms = Date.parse(ymd + 'T00:00:00+08:00') + days * 86400000;
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function cstMs(ymd, hh, mm) {
    return Date.parse(ymd + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00+08:00');
}

function dayWordOffset(text) {
    if (/大后天/.test(text)) return 3;
    if (/后天/.test(text)) return 2;
    if (/明天|明日|明早|明晚|明儿/.test(text)) return 1;
    if (/今天|今日|今晚|今夜|今早/.test(text)) return 0;
    return null;
}

function periodAdjust(text, hour) {
    let h = hour;
    if (/凌晨|早上|早晨|清晨|上午/.test(text)) { if (h === 12) h = 0; return h; }
    if (/中午/.test(text)) return h < 12 ? h + 12 : h;
    if (/下午|傍晚|晚上|夜里|今晚|明晚/.test(text)) return h < 12 ? h + 12 : h;
    return h;
}

/** 「8点/8点30/8点半/20:00/半小时后/2小时后/明天早上8点」→ epoch ms；识别不了返回 null */
export function parseReminderTime(raw, nowMs) {
    const text = String(raw == null ? '' : raw);
    const now = Number(nowMs) || Date.now();
    const base = east8Parts(now);

    const rel = /(\d{1,3}|[零〇一壹二两三四五六七八九十]+)\s*(?:个)?\s*(分钟|分|小时)\s*(?:之?后|以后)/.exec(text);
    if (rel) {
        const n = cnNumber(rel[1]);
        if (n !== null) {
            const unit = rel[2] === '小时' ? 3600000 : 60000;
            const fire = now + n * unit;
            return fire > now + REMINDER_MIN_LEAD_MS && fire <= now + REMINDER_MAX_LEAD_MS ? fire : null;
        }
    }
    if (/(?:半(?:个)?小时|半小时)(?:之?后|以后)/.test(text)) return now + 30 * 60000;

    let hh = null;
    let mm = 0;
    let m = /(\d{1,2}|[零〇一壹二两三四五六七八九十]{1,3})\s*[点時时]\s*(\d{1,2}|半|一刻)?\s*分?/.exec(text);
    if (m) {
        hh = cnNumber(m[1]);
        mm = m[2] === '半' ? 30 : (m[2] === '一刻' ? 15 : (m[2] ? Number(m[2]) : 0));
    } else {
        m = /(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(text);
        if (m) { hh = Number(m[1]); mm = Number(m[2]); }
    }
    if (hh === null || !Number.isFinite(hh) || hh > 23 || !Number.isFinite(mm) || mm > 59) return null;

    const hour = periodAdjust(text, hh);
    const offset = dayWordOffset(text);
    let ymd = offset === null ? base.ymd : addDays(base.ymd, offset);
    let fire = cstMs(ymd, hour, mm);
    if (offset === null && fire <= now + REMINDER_MIN_LEAD_MS) {
        ymd = addDays(base.ymd, 1);
        fire = cstMs(ymd, hour, mm);
    }
    if (fire <= now + REMINDER_MIN_LEAD_MS || fire > now + REMINDER_MAX_LEAD_MS) return null;
    return fire;
}

/** 东八区展示：「今天 20:00」/「明天 08:00」/「10月26日 20:00」 */
export function formatReminderTime(ms, nowMs) {
    const now = Number(nowMs) || Date.now();
    const parts = east8Parts(ms);
    const today = east8Parts(now).ymd;
    const tomorrow = east8Parts(now + 86400000).ymd;
    const hm = String(parts.hour).padStart(2, '0') + ':' + String(parts.minuteOfDay % 60).padStart(2, '0');
    if (parts.ymd === today) return '今天 ' + hm;
    if (parts.ymd === tomorrow) return '明天 ' + hm;
    return Number(parts.ymd.slice(5, 7)) + '月' + Number(parts.ymd.slice(8, 10)) + '日 ' + hm;
}

const REMIND_TRIGGER_RE = /(?:记得|记着|到时候|到时|到点)?\s*(?:提醒我一下|提醒一下我|提醒下我|提醒我)/;
const DIRECTIVE_BEFORE_RE = /(?:记得|记着|到时候|到时|到点|等会|待会|一会儿|等下|帮我|麻烦|请)\s*$/;
/** 「提醒我妈吃药」这类第三人在后，不能当指令 */
const THIRD_PARTY_RE = /^(?:自己|妈|爸|爸|他|她|它|您|们|同学|同事|朋友|老公|老婆|孩子|儿子|女儿)/;

const TIME_TOKEN_RE = /(?:今天|今日|今晚|今夜|今早|明天|明日|明早|明晚|明儿|后天|大后天|凌晨|早上|早晨|清晨|上午|中午|下午|傍晚|晚上|夜里|等会|待会|一会儿|等下|到时候|到时|到点|记得|记着|\d{1,3}\s*(?:个)?\s*(?:小时|分钟|分)\s*(?:之?后|以后)|\d{1,2}\s*[点時时]\s*(?:\d{1,2}|半|一刻)?\s*分?|半(?:个)?小时|\d{1,2}\s*[:：]\s*\d{1,2})/g;
const TRIGGER_WORD_RE = /(?:提醒我一下|提醒一下我|提醒下我|提醒我)/g;
const POLITE_PREFIX_RE = /^(?:帮我|麻烦(?:你)?|请|给我|麻烦|一下|下|要|去|\s|[，,。：:、;；\-—])+/;

/** 从整句里剥掉时间词与触发词，留下「要提醒的事」 */
export function cleanReminderText(raw) {
    const out = String(raw == null ? '' : raw)
        .replace(TIME_TOKEN_RE, ' ')
        .replace(TRIGGER_WORD_RE, ' ')
        .replace(/[\s，,。：:、;；\-—]+/g, ' ')
        .trim()
        .replace(POLITE_PREFIX_RE, '')
        .trim();
    return out.slice(0, REMINDER_TEXT_MAX_CHARS);
}

/**
 * 识别「提醒我」指令。
 * 匹配条件必须够严，否则聊天里的「我今天提醒我自己要早睡」会变成一条提醒：
 *   - 句子以触发词开头（「提醒我 6:30 充电」）；或
 *   - 触发词前紧跟着指令词（记得/帮我/等会…）；或
 *   - 句子里真的有时刻/日期词（「等会6点30记得提醒我给电动牙刷充电」）。
 * 三者都没有 → 不是指令，交给对话模型。
 */
export function parseRemindCommand(raw, nowMs) {
    const text = String(raw == null ? '' : raw).trim();
    const m = REMIND_TRIGGER_RE.exec(text);
    if (!m) return { matched: false };
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    if (THIRD_PARTY_RE.test(after.trim())) return { matched: false };
    const atStart = before.replace(/^(?:请|帮我|麻烦(?:你)?|帮)\s*/, '').trim() === '';
    const directive = DIRECTIVE_BEFORE_RE.test(before);
    const combined = (before + ' ' + after).trim();
    const fireAtMs = parseReminderTime(combined, nowMs) || parseReminderTime(after, nowMs) || parseReminderTime(before, nowMs);
    if (!atStart && !directive && !fireAtMs) return { matched: false };
    const body = cleanReminderText(combined);
    if (!body) return { matched: true, ok: false, reply: '要提醒你做什么？发「提醒我 20:00 <事情>」，比如「提醒我 20:00 给电动牙刷充电」。' };
    if (!fireAtMs) return { matched: true, ok: false, reply: '要几点提醒你？发个时刻给我，比如「提醒我 20:00 充电」或「提醒我 明天早上8点 交电费」。' };
    return { matched: true, ok: true, text: body, fireAtMs };
}

export function isReminderList(text) {
    return /^(?:我的提醒|提醒列表|待办|待办事项|有哪些提醒|提醒有什么|\/reminders?)[\s。！!～~]*$/i.test(String(text == null ? '' : text).trim());
}

export function parseCancelReminder(text) {
    const m = /^(?:取消提醒|删除提醒|取消这条提醒|删掉提醒)\s*[:：]?\s*([\s\S]{0,40}?)[\s。！!～~]*$/.exec(String(text == null ? '' : text).trim());
    if (!m) return null;
    return { arg: String(m[1] || '').trim() };
}

const DONE_RE = /^(?:完成|完成了|做完了|做好了|搞定了|弄好了|办好了|搞好了|好了|搞定|done|\/done)[\s。！!～~👍✅]*$/i;
const NOT_YET_RE = /^(?:还没|还没有|还没做|还没完成|没做|没有|没呢|还没呢|晚点|待会再说|暂时没有|no|\/no)[\s。！!～~]*$/i;

export function parseDoneReply(text) {
    return DONE_RE.test(String(text == null ? '' : text).trim());
}

export function parseNotYetReply(text) {
    return NOT_YET_RE.test(String(text == null ? '' : text).trim());
}

/** 到点开口 / 追问的文本（模板，不经过模型——模型多一层就可能忘记说了什么） */
export function reminderFiredText(text) {
    return '⏰ 提醒你：' + text + '\n\n做完了回「完成」，我把它记进随手记；今天不做了回「还没」。';
}

export function reminderAskText(text) {
    return '刚才提醒的「' + text + '」做得怎么样了？回「完成」我记一笔，回「还没」我就不催了。';
}

async function loadBoundAccount(db, userId) {
    const row = await db.prepare("SELECT id, user_id, bot_token, baseurl, ilink_bot_id, ilink_user_id FROM bot_claw_accounts WHERE user_id = ?1 AND is_deleted = 0 AND status = 'bound' ORDER BY id DESC LIMIT 1")
        .bind(userId).first();
    return row || null;
}

/** 应用内线索转提醒与微信指令共用的落库入口；只做校验、限流、通道检查与写入。 */
export async function createReminderAt(db, userId, text, fireAtMs, nowMs, followUpMs) {
    const body = String(text == null ? '' : text).trim().slice(0, REMINDER_TEXT_MAX_CHARS);
    const now = Number(nowMs) || Date.now();
    const fire = Number(fireAtMs);
    if (!body) return { ok: false, reply: '要提醒你做什么？写一句具体的事。' };
    if (!Number.isFinite(fire) || fire <= now + REMINDER_MIN_LEAD_MS || fire > now + REMINDER_MAX_LEAD_MS) {
        return { ok: false, reply: '提醒时间要在未来 1 分钟到 1 年之间。' };
    }
    const limit = await checkRateLimitShared(db, 'bot-remind:' + userId, BOT_REMIND_LIMIT.limit, BOT_REMIND_LIMIT.windowMs);
    if (!limit.ok) return { ok: false, reply: '今天设的提醒有点多，缓 ' + Math.max(1, Math.ceil(Number(limit.retryAfter || 60) / 60)) + ' 分钟再发一次。' };
    const active = await db.prepare("SELECT COUNT(*) AS n FROM bot_reminders WHERE user_id = ?1 AND is_deleted = 0 AND status = 'pending'").bind(userId).first();
    if (Number((active && active.n) || 0) >= REMINDER_MAX_ACTIVE) {
        return { ok: false, reply: '待提醒的事已经攒到 ' + REMINDER_MAX_ACTIVE + ' 条了，先发「我的提醒」清理几条？' };
    }
    const account = await loadBoundAccount(db, userId);
    if (!account) return { ok: false, reply: '我这边还没有绑定的微信通道，设了也送不到——去花园「设置 → 微信 Bot」扫码绑定后再发一次。' };
    const follow = normalizeFollowUpMs(followUpMs) || followUpMsForText(body);
    const res = await db.prepare("INSERT INTO bot_reminders (user_id, account_id, text, fire_at_ms, follow_up_ms, status, is_deleted) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0)")
        .bind(userId, account.id, body, fire, follow).run();
    return { ok: true, id: (res && res.meta && res.meta.last_row_id) || 0, text: body, fireAtMs: fire,
        reply: '已记下 ✅\n> ' + formatReminderTime(fire, now) + ' — ' + body + '\n\n到点我会在微信里叫你；不想了就发「我的提醒」看编号，再发「取消提醒 <编号>」。' };
}
/** 设提醒：限流 → 上限 → 通道 → 落库，回执里一定写清「我理解的时间」 */
export async function runRemind(db, userId, parsed, nowMs) {
    if (!parsed || !parsed.matched) return null;
    if (!parsed.ok) return parsed.reply;
    const created = await createReminderAt(db, userId, parsed.text, parsed.fireAtMs, nowMs, parsed.followUpMs);
    return created.reply;
}

/** 「我的提醒」：待提醒 + 刚提醒过、还没回「完成」的 */
export async function listReminders(db, userId, nowMs) {
    const now = Number(nowMs) || Date.now();
    const res = await db.prepare("SELECT id, text, fire_at_ms, status FROM bot_reminders WHERE user_id = ?1 AND is_deleted = 0 AND status IN ('pending', 'fired') ORDER BY fire_at_ms ASC, id ASC LIMIT 20")
        .bind(userId).all();
    const list = (res && res.results) || [];
    if (!list.length) return '现在没有待提醒的事。发「提醒我 20:00 给电动牙刷充电」这种格式我就记下——到点真的会在微信里叫你。';
    const lines = ['**我的提醒**（' + list.length + ' 条）'];
    list.forEach((r, i) => {
        lines.push((i + 1) + '. ' + formatReminderTime(r.fire_at_ms, now) + ' — ' + r.text + (r.status === 'fired' ? '（刚提醒过）' : ''));
    });
    lines.push('');
    lines.push('取消哪条就发「取消提醒 <编号>」；做完了回「完成」，我会把它记进随手记。');
    return lines.join('\n');
}

/** 「取消提醒 N」或「取消提醒 关键词」：只动 pending，软删 */
export async function cancelReminder(db, userId, arg, nowMs) {
    const now = Number(nowMs) || Date.now();
    const key = String(arg == null ? '' : arg).trim();
    if (!key) return '取消哪条？先发「我的提醒」看编号，再发「取消提醒 1」。';
    let target = null;
    if (/^\d{1,2}$/.test(key)) {
        const res = await db.prepare("SELECT id, text, fire_at_ms FROM bot_reminders WHERE user_id = ?1 AND is_deleted = 0 AND status = 'pending' ORDER BY fire_at_ms ASC, id ASC LIMIT 20")
            .bind(userId).all();
        const list = (res && res.results) || [];
        target = list[Number(key) - 1] || null;
        if (!target) return '没有第 ' + key + ' 条待提醒，发「我的提醒」看看现在的编号。';
    } else {
        target = await db.prepare("SELECT id, text, fire_at_ms FROM bot_reminders WHERE user_id = ?1 AND is_deleted = 0 AND status = 'pending' AND text LIKE '%' || ?2 || '%' ORDER BY fire_at_ms ASC, id ASC LIMIT 1")
            .bind(userId, key).first() || null;
        if (!target) return '没找到待提醒里含「' + key + '」的事，发「我的提醒」看看。';
    }
    const upd = await db.prepare("UPDATE bot_reminders SET status = 'cancelled', is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2 AND status = 'pending'")
        .bind(target.id, userId).run();
    if (Number((upd && upd.meta && upd.meta.changes) || 0) !== 1) {
        return '这条刚刚变了（可能已经提醒过），发「我的提醒」看看最新的。';
    }
    return '好，取消了：' + formatReminderTime(target.fire_at_ms, now) + ' — ' + target.text + '。';
}

/** 12 小时内刚提醒过、还没回「完成」的那条（「完成/还没」都只对它生效） */
export async function recentFiredReminder(db, userId, nowMs) {
    const now = Number(nowMs) || Date.now();
    const row = await db.prepare("SELECT id, text, fired_at_ms FROM bot_reminders WHERE user_id = ?1 AND is_deleted = 0 AND status = 'fired' AND fired_at_ms >= ?2 ORDER BY fired_at_ms DESC, id DESC LIMIT 1")
        .bind(userId, now - REMINDER_DONE_WINDOW_MS).first();
    return row || null;
}

/** 幂等收尾：只有还是 fired 才能变 done */
export async function completeReminder(db, userId, row) {
    if (!row || !row.id) return false;
    const upd = await db.prepare("UPDATE bot_reminders SET status = 'done', follow_up_retry_at_ms = 0, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2 AND status = 'fired'")
        .bind(row.id, userId).run();
    return Number((upd && upd.meta && upd.meta.changes) || 0) === 1;
}

/** 用户回「还没」：停掉尚未发出的追问，但不结束这条提醒（之后仍可回「完成」） */
export async function skipReminderFollowUp(db, userId, row) {
    if (!row || !row.id) return false;
    const upd = await db.prepare("UPDATE bot_reminders SET follow_up_status = 'skipped', follow_up_retry_at_ms = 0, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2 AND status = 'fired' AND follow_up_status IN ('pending', 'sending')")
        .bind(row.id, userId).run();
    return Number((upd && upd.meta && upd.meta.changes) || 0) === 1;
}

async function saveTurnSafe(db, userId, text) {
    try { await saveChatTurn(db, userId, 'assistant', text); }
    catch (err) { console.error('[reminder] 写对话上下文失败: ' + (err && err.message)); }
}

function followUpBackoffMs(attempts) {
    const exp = Math.max(0, Number(attempts || 0) - 1);
    return Math.min(REMINDER_FOLLOW_UP_RETRY_MAX_MS, REMINDER_FOLLOW_UP_RETRY_BASE_MS * Math.pow(2, exp));
}

/** 失败后按次数退避；次数耗尽进入 failed，避免永远卡在 pending */
async function scheduleFollowUpRetry(db, id, attempts, now, reason) {
    const count = Math.max(0, Number(attempts || 0));
    if (count >= REMINDER_FOLLOW_UP_MAX_ATTEMPTS) {
        await db.prepare("UPDATE bot_reminders SET follow_up_status = 'failed', follow_up_retry_at_ms = 0, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND status = 'fired'")
            .bind(id).run();
        console.error('[reminder] 追问放弃 id=' + id + ' reason=' + reason);
        return 'failed';
    }
    const retryAt = Number(now) + followUpBackoffMs(count);
    await db.prepare("UPDATE bot_reminders SET follow_up_status = 'pending', follow_up_attempts = ?1, follow_up_retry_at_ms = ?2, updated_at = datetime('now', '+8 hours') WHERE id = ?3 AND status = 'fired'")
        .bind(count, retryAt, id).run();
    console.error('[reminder] 追问重试 id=' + id + ' attempt=' + count + ' reason=' + reason);
    return 'pending';
}

/**
 * 每分钟 cron 入口：先发到点的提醒，再发到期的追问（失败退避重试）。
 * options.nowMs / options.staleMs 供单测收紧时间；options.limit 控制单轮条数。
 */
export async function runReminderChecks(env, db, fetchImpl = fetch, options = {}) {
    const opts = options || {};
    const now = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const stale = Number.isFinite(opts.staleMs) ? opts.staleMs : REMINDER_STALE_MS;
    const limit = Number.isFinite(opts.limit) ? opts.limit : REMINDER_TICK_BATCH;
    const summary = { due: 0, sent: 0, asked: 0, missed: 0, failed: 0 };
    let sender = null;
    const loadSender = async () => {
        if (!sender) ({ sendClawText: sender } = await import('./bot-claw.js'));
        return sender;
    };

    const dueRes = await db.prepare("SELECT id, user_id, text, fire_at_ms, follow_up_ms FROM bot_reminders WHERE is_deleted = 0 AND status = 'pending' AND fire_at_ms <= ?1 ORDER BY fire_at_ms ASC, id ASC LIMIT ?2")
        .bind(now, limit).all();
    const due = (dueRes && dueRes.results) || [];
    summary.due = due.length;

    for (const row of due) {
        if (now - Number(row.fire_at_ms || 0) > stale) {
            await db.prepare("UPDATE bot_reminders SET status = 'missed', updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND status = 'pending'")
                .bind(row.id).run();
            summary.missed++;
            continue;
        }
        const account = await loadBoundAccount(db, row.user_id);
        if (!account) {
            await db.prepare("UPDATE bot_reminders SET status = 'missed', updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND status = 'pending'")
                .bind(row.id).run();
            summary.missed++;
            continue;
        }
        const followUpMs = normalizeFollowUpMs(row.follow_up_ms) || followUpMsForText(row.text);
        const followUpAt = now + followUpMs;
        const claim = await db.prepare("UPDATE bot_reminders SET status = 'fired', fired_at_ms = ?1, follow_up_at_ms = ?2, follow_up_ms = ?3, follow_up_status = 'pending', follow_up_attempts = 0, follow_up_retry_at_ms = ?2, updated_at = datetime('now', '+8 hours') WHERE id = ?4 AND status = 'pending'")
            .bind(now, followUpAt, followUpMs, row.id).run();
        if (Number((claim && claim.meta && claim.meta.changes) || 0) !== 1) continue;
        const firedText = reminderFiredText(row.text);
        try {
            const send = await loadSender();
            await send({
                token: account.bot_token,
                baseurl: account.baseurl,
                botId: account.ilink_bot_id,
                toUserId: account.ilink_user_id,
                contextToken: '',
                text: firedText,
                fetchImpl
            });
            summary.sent++;
            await saveTurnSafe(db, row.user_id, firedText);
            console.log('[reminder] 已送达 id=' + row.id + ' user=' + row.user_id);
        } catch (err) {
            await db.prepare("UPDATE bot_reminders SET status = 'pending', fired_at_ms = 0, follow_up_at_ms = 0, follow_up_status = 'none', follow_up_attempts = 0, follow_up_retry_at_ms = 0, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND status = 'fired'")
                .bind(row.id).run();
            summary.failed++;
            console.error('[reminder] 发送失败 id=' + row.id + ': ' + (err && err.message));
        }
    }

    const askRes = await db.prepare("SELECT id, user_id, text, follow_up_attempts FROM bot_reminders WHERE is_deleted = 0 AND status = 'fired' AND follow_up_status IN ('pending', 'sending') AND follow_up_retry_at_ms > 0 AND follow_up_retry_at_ms <= ?1 ORDER BY follow_up_retry_at_ms ASC, id ASC LIMIT ?2")
        .bind(now, limit).all();
    for (const row of ((askRes && askRes.results) || [])) {
        const attempts = Number(row.follow_up_attempts || 0);
        if (attempts >= REMINDER_FOLLOW_UP_MAX_ATTEMPTS) {
            await scheduleFollowUpRetry(db, row.id, attempts, now, 'max_attempts');
            summary.failed++;
            continue;
        }

        let account = null;
        try {
            account = await loadBoundAccount(db, row.user_id);
        } catch (err) {
            await scheduleFollowUpRetry(db, row.id, attempts + 1, now, 'account_read_failed');
            summary.failed++;
            console.error('[reminder] 追问读账号失败 id=' + row.id + ': ' + (err && err.message));
            continue;
        }
        if (!account) {
            await scheduleFollowUpRetry(db, row.id, attempts + 1, now, 'no_account');
            summary.failed++;
            continue;
        }

        const nextAttempt = attempts + 1;
        const claim = await db.prepare("UPDATE bot_reminders SET follow_up_status = 'sending', follow_up_attempts = ?1, follow_up_retry_at_ms = ?2, updated_at = datetime('now', '+8 hours') WHERE id = ?3 AND status = 'fired' AND follow_up_status IN ('pending', 'sending') AND follow_up_retry_at_ms <= ?4")
            .bind(nextAttempt, now + REMINDER_FOLLOW_UP_LEASE_MS, row.id, now).run();
        if (Number((claim && claim.meta && claim.meta.changes) || 0) !== 1) continue;

        const askText = reminderAskText(row.text);
        try {
            const send = await loadSender();
            await send({
                token: account.bot_token,
                baseurl: account.baseurl,
                botId: account.ilink_bot_id,
                toUserId: account.ilink_user_id,
                contextToken: '',
                text: askText,
                fetchImpl
            });
            await db.prepare("UPDATE bot_reminders SET follow_up_status = 'sent', follow_up_sent = 1, follow_up_retry_at_ms = 0, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND status = 'fired'")
                .bind(row.id).run();
            summary.asked++;
            await saveTurnSafe(db, row.user_id, askText);
        } catch (err) {
            await scheduleFollowUpRetry(db, row.id, nextAttempt, now, 'send_failed');
            summary.failed++;
            console.error('[reminder] 追问失败 id=' + row.id + ': ' + (err && err.message));
        }
    }
    return summary;
}
