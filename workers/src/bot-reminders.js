/**
 * 待办与定点提醒（v2.5.143）：用户开口授权的一次性提醒。
 *
 * 和 bot-outreach 的关系必须分清——两件事共用「发一条消息」这一个动作，但语义相反：
 *   bot-outreach 是**系统**想说话：每天至多一次、限 10:00–22:30、距上次说话 ≥30 分钟、0.65 概率闸门；
 *   bot-reminders 是**用户**叫我说话：到点就得说，不受日限/时窗/静默期约束。
 * 所以分表（bot_reminders / bot_outreach）、分开关（outreach_enabled / 无）、分审计。
 * 否则用户一句「别主动找我」会把他的提醒一起关掉——那是他的东西，不是系统的兴致。
 *
 * 状态机：pending --到点--> fired --追问--> done；超过 2 小时未送标 missed；「取消提醒 N」标 cancelled。
 * 规则优先、猜错要看得见。解析绝对时刻写回执，幂等抢占 claim 成 fired 再发。正文不进日志。
 */

import { checkRateLimitShared } from './security.js';
import { saveChatTurn } from './bot-memory.js';

/** 东八区视角的日期 / 小时 / 当天零点。独立实现以切断与 bot-claw / bot-outreach 的循环依赖。 */
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
export const REMINDER_TICK_BATCH = 20;
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
const POLITE_PREFIX_RE = /^(?:帮我|麻烦(?:你)?|请|给我|麻烦|一下|下|还要|还得|要|去|再|\s|[，,。：:、;；\-—])+/;

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

const NON_REMINDER_TARGET_RE = /(?:收藏|书签|提示词|目标|任务|偏好|档案|关注|订单|预约|订阅|会员)/;
const CANCEL_FILLER_RE = /(?:早上的|晚上的|上午的|下午的|今天的|明天的|后天的|刚才的|刚刚的|刚才|刚刚|那条|那个|这条|这个|提醒|一下|下|的|吧|呀|呢|了)/g;
const DEICTIC_RECENT_RE = /^(?:刚才|刚刚|上一条|最后一条|这条|这个|那条|那个|它)(?:提醒)?$/;
const CANCEL_ALL_RE = /^(?:全部|所有|全都|全部提醒|所有提醒)$/;

export function parseCancelReminder(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;

    // 1. 显式「取消提醒 / 删除提醒 ...」（含光杆「取消提醒」）
    const explicit = /^(?:请|帮我|麻烦(?:你)?|帮)?\s*(?:取消提醒|删除提醒|取消这条提醒|删掉提醒)\s*[:：]?\s*([\s\S]{0,60}?)[\s。！!～~]*$/.exec(raw);
    if (explicit) {
        return { arg: String(explicit[1] || '').trim() };
    }

    // 2. 自然口语「取消早上的8点的那个 / 删掉手帕纸那个 / 取消刚才那个」（绝不拦截光杆「取消」与非提醒资产）
    const natural = /^(?:请|帮我|麻烦(?:你)?|帮)?\s*(?:取消|删掉|删除|撤回|撤销|作废|去掉)(?:掉)?\s*(?:一下|下)?\s*([\s\S]{1,60}?)[\s。！!～~]*$/.exec(raw);
    if (natural) {
        const arg = String(natural[1] || '').trim();
        if (arg && !(NON_REMINDER_TARGET_RE.test(arg) && !arg.includes('提醒'))) {
            return { arg };
        }
    }

    // 3. 「不用提醒我洗保温杯了 / 手帕纸不用提醒了 / 别提醒我了」
    const noNeedPrefix = /^(?:算了[，,\s]*)?(?:不用|不需要|别|不要)(?:再)?提醒(?:我|一下|下)?(?:了)?\s*([\s\S]{0,60}?)[\s。！!～~]*$/.exec(raw);
    if (noNeedPrefix) {
        const arg = String(noNeedPrefix[1] || '').trim();
        if (!NON_REMINDER_TARGET_RE.test(arg)) {
            return { arg: arg || '刚才' };
        }
    }
    const noNeedSuffix = /^([\s\S]{1,60}?)(?:不用|不需要|别|不要)(?:再)?提醒(?:我|一下|下)?了[\s。！!～~]*$/.exec(raw);
    if (noNeedSuffix) {
        const arg = String(noNeedSuffix[1] || '').trim();
        if (arg && !NON_REMINDER_TARGET_RE.test(arg)) {
            return { arg };
        }
    }

    return null;
}

const GARDEN_EDIT_GUARD_RE = /^(?:修改|改|编辑|更新)(?:收藏|书签|提示词|偏好|档案)/;
const CORRECTION_CUE_RE = /(?:说错了|打错了|搞错了|写错了|记错了|不对|不是|更正|其实是|应该是|重设|重来)/;
const BARE_IS_TIME_RE = /^是\s*(?:今天|今日|今晚|今夜|今早|明天|明日|明早|明晚|明儿|后天|大后天|凌晨|早上|早晨|清晨|上午|中午|下午|傍晚|晚上|夜里|\d{1,2}|[零〇一壹二两三四五六七八九十])/;

/**
 * 识别修改提醒时间或纠偏（「是晚上8点我说错了」「把早上8点那个改成晚上8点」「改到20:30」「推迟半小时」）。
 * allowConversationalCorrection 为 true 时允许不带「改」字的纯纠偏语句（「是晚上8点我说错了」）。
 */
export function parseRescheduleReminder(text, nowMs, options = {}) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw || GARDEN_EDIT_GUARD_RE.test(raw)) return null;

    // 1. 相对延后/推迟（无「到」字，如「推迟半小时」「延后1小时」）
    const relShift = /^(?:把([\s\S]{0,30}?))?(?:提醒)?(?:时间)?(?:推迟|延后|往后延|延)\s*(\d{1,3}|[零〇一壹二两三四五六七八九十]+|半(?:个)?)\s*(分钟|分|小时)[\s。！!～~]*$/.exec(raw);
    if (relShift) {
        const num = relShift[2].startsWith('半') ? 0.5 : cnNumber(relShift[2]);
        if (num !== null && num > 0) {
            const unit = relShift[3] === '小时' ? 3600000 : 60000;
            const deltaMs = Math.round(num * unit);
            if (deltaMs >= REMINDER_MIN_LEAD_MS && deltaMs <= REMINDER_MAX_LEAD_MS) {
                return {
                    matched: true,
                    ok: true,
                    targetArg: String(relShift[1] || '').trim(),
                    deltaMs,
                    newFireAtMs: null
                };
            }
        }
    }

    // 2. 显式改期（「把…改成/改到/换到/推迟到/延后到/提前到/修改提醒…为 <新时间>」）
    const explicit = /^(?:(?:请|帮我|麻烦(?:你)?|帮)?\s*)?(?:把([\s\S]{0,35}?))?(?:提醒)?(?:时间)?(?:改[成到为]|换[成到为]|调[成到为]|挪到|推迟到|延后到|提前到|设为|改为)\s*([\s\S]{1,40}?)[\s。！!～~]*$/.exec(raw);
    if (explicit) {
        const targetArg = String(explicit[1] || '').trim();
        const newTimeStr = String(explicit[2] || '').trim();
        if (targetArg && NON_REMINDER_TARGET_RE.test(targetArg) && !targetArg.includes('提醒')) return null;
        const newFireAtMs = parseReminderTime(newTimeStr, nowMs);
        if (newFireAtMs) {
            return { matched: true, ok: true, targetArg, deltaMs: 0, newFireAtMs };
        }
        return { matched: true, ok: false, reply: '想改到几点？比如「改到晚上8点」或「改到 20:30」。' };
    }

    const explicitId = /^(?:修改|改)提醒\s*(#?\d+)\s*(?:时间)?(?:为|到|成)?\s*([\s\S]{1,40}?)[\s。！!～~]*$/.exec(raw);
    if (explicitId) {
        const newFireAtMs = parseReminderTime(explicitId[2], nowMs);
        if (newFireAtMs) {
            return { matched: true, ok: true, targetArg: explicitId[1], deltaMs: 0, newFireAtMs };
        }
        return { matched: true, ok: false, reply: '想改到几点？比如「改提醒 #11 到 20:00」。' };
    }

    // 3. 上下文纠偏（「是晚上8点我说错了」「不对，是20:00」「不是早上的，是晚上8点」）
    const hasExplicitReminderHint = raw.includes('提醒') || /(?:那个|那条)/.test(raw);
    if ((options.allowConversationalCorrection || hasExplicitReminderHint)
        && (CORRECTION_CUE_RE.test(raw) || BARE_IS_TIME_RE.test(raw))) {
        // 「不是A，是B」优先取后半句作为新时间，前半句作为目标提示
        const contrast = /^(?:(?:不对|我说错了|打错了|搞错了|写错了|记错了)[，,\s]*)?(?:不是([\s\S]{1,25}?)[，,\s]+)?(?:其实是|应该是|而是|是)\s*([\s\S]{1,35}?)(?:[，,\s]*(?:我说错了|打错了|搞错了|写错了|记错了))?[\s。！!～~]*$/.exec(raw);
        const candidateStr = contrast ? contrast[2] : raw;
        const newFireAtMs = parseReminderTime(candidateStr, nowMs) || parseReminderTime(raw, nowMs);
        if (newFireAtMs) {
            return {
                matched: true,
                ok: true,
                targetArg: contrast && contrast[1] ? contrast[1].trim() : '',
                deltaMs: 0,
                newFireAtMs
            };
        }
    }

    return null;
}

/** 从口语查询中拆出「时段/日期/时刻」过滤条件与剩余关键词 */
function extractTimeAndKeywordFilter(raw) {
    const s = String(raw == null ? '' : raw).trim();
    let period = null;
    if (/凌晨|早上|早晨|清晨|上午|今早|明早/.test(s)) period = 'morning';
    else if (/中午/.test(s)) period = 'noon';
    else if (/下午|傍晚|晚上|夜里|今晚|明晚/.test(s)) period = 'evening';

    const dayOffset = dayWordOffset(s);

    let hour = null;
    let minute = null;
    let m = /(\d{1,2}|[零〇一壹二两三四五六七八九十]{1,3})\s*[点時时]\s*(\d{1,2}|半|一刻)?\s*分?/.exec(s);
    if (m) {
        hour = cnNumber(m[1]);
        if (m[2] === '半') minute = 30;
        else if (m[2] === '一刻') minute = 15;
        else if (m[2]) minute = Number(m[2]);
    } else {
        m = /(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(s);
        if (m) {
            hour = Number(m[1]);
            minute = Number(m[2]);
        }
    }
    if (hour !== null && (!Number.isFinite(hour) || hour > 23)) hour = null;
    if (minute !== null && (!Number.isFinite(minute) || minute > 59)) minute = null;

    let expectedHours = null;
    if (hour !== null) {
        if (period === 'morning') expectedHours = [hour === 12 ? 0 : hour];
        else if (period === 'noon' || period === 'evening') expectedHours = [hour < 12 ? hour + 12 : hour];
        else expectedHours = (hour >= 1 && hour <= 12) ? [hour, hour === 12 ? 0 : hour + 12] : [hour];
    }

    const keyword = s
        .replace(TIME_TOKEN_RE, ' ')
        .replace(CANCEL_FILLER_RE, ' ')
        .replace(/[\s，,。：:、;；\-—]+/g, ' ')
        .trim();

    return {
        isDeicticRecent: DEICTIC_RECENT_RE.test(s) || (!keyword && hour === null && period === null && dayOffset === null && /(?:刚才|刚刚|那条|那个|这条|这个)/.test(s)),
        period,
        dayOffset,
        expectedHours,
        expectedMinute: minute,
        keyword
    };
}

function rowMatchesTimeFilter(row, filter, nowMs) {
    const parts = east8Parts(row.fire_at_ms);
    if (filter.dayOffset !== null) {
        const expectedYmd = addDays(east8Parts(nowMs).ymd, filter.dayOffset);
        if (parts.ymd !== expectedYmd) return false;
    }
    if (filter.expectedHours) {
        if (!filter.expectedHours.includes(parts.hour)) return false;
        const rowMin = parts.minuteOfDay % 60;
        if (filter.expectedMinute !== null && rowMin !== filter.expectedMinute) return false;
    } else if (filter.period) {
        if (filter.period === 'morning' && parts.hour >= 12) return false;
        if (filter.period === 'noon' && (parts.hour < 11 || parts.hour > 14)) return false;
        if (filter.period === 'evening' && parts.hour < 12) return false;
    }
    return true;
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
    return '⏰ 提醒你：' + text + '\n\n做完了回「完成」；今天不做了回「还没」。';
}

export function reminderBatchFiredText(rows) {
    const items = rows.map((r, i) => (i + 1) + '. ' + r.text).join('\n');
    return '⏰ 到点了，提醒你这 ' + rows.length + ' 件事：\n\n' + items + '\n\n做完了回「完成」（或「完成 关键词」）；今天不做了回「还没」。';
}

export function reminderAskText(text) {
    return '刚才提醒的「' + text + '」做得怎么样了？回「完成」标为完成，回「还没」我就不催了。';
}

export function reminderBatchAskText(rows) {
    const items = rows.map((r, i) => (i + 1) + '. ' + r.text).join('\n');
    return '刚才提醒的这 ' + rows.length + ' 件事做得怎么样了？\n\n' + items + '\n\n都做完了回「完成」，不想催了回「还没」。';
}

async function loadBoundAccount(db, userId) {
    const row = await db.prepare("SELECT id, user_id, bot_token, baseurl, ilink_bot_id, ilink_user_id, last_context_token FROM bot_claw_accounts WHERE user_id = ?1 AND is_deleted = 0 AND status = 'bound' ORDER BY id DESC LIMIT 1")
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
    const dup = await db.prepare("SELECT id, text, fire_at_ms FROM bot_reminders WHERE user_id = ?1 AND is_deleted = 0 AND status = 'pending' AND text = ?2 AND ABS(fire_at_ms - ?3) <= 60000 LIMIT 1")
        .bind(userId, body, fire).first();
    if (dup) {
        return { ok: true, id: dup.id, text: dup.text, fireAtMs: dup.fire_at_ms, duplicated: true,
            reply: '这条提醒已经在排队了 🙂\n> ' + formatReminderTime(dup.fire_at_ms, now) + ' — ' + dup.text };
    }
    const account = await loadBoundAccount(db, userId);
    if (!account) return { ok: false, reply: '我这边还没有绑定的微信通道，设了也送不到——去花园「设置 → 微信 Bot」扫码绑定后再发一次。' };
    const follow = normalizeFollowUpMs(followUpMs) || followUpMsForText(body);
    const res = await db.prepare("INSERT INTO bot_reminders (user_id, account_id, text, fire_at_ms, follow_up_ms, status, is_deleted) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0)")
        .bind(userId, account.id, body, fire, follow).run();
    return { ok: true, id: (res && res.meta && res.meta.last_row_id) || 0, text: body, fireAtMs: fire,
        reply: '已记下 ✅\n> ' + formatReminderTime(fire, now) + ' — ' + body + '\n\n到点我会在微信里叫你；要改时间或取消，直接跟我说就行。' };
}
/** 设提醒：限流 → 上限 → 通道 → 落库，回执里一定写清「我理解的时间」 */
export async function runRemind(db, userId, parsed, nowMs) {
    if (!parsed || !parsed.matched) return null;
    if (!parsed.ok) return parsed.reply;
    const created = await createReminderAt(db, userId, parsed.text, parsed.fireAtMs, nowMs, parsed.followUpMs);
    return created.reply;
}

/** 「我的提醒」：只列还没到点的待提醒（已提醒过的不在列表里堆砌） */
export async function listReminders(db, userId, nowMs) {
    const now = Number(nowMs) || Date.now();
    const res = await db.prepare("SELECT id, text, fire_at_ms, status FROM bot_reminders WHERE user_id = ?1 AND is_deleted = 0 AND status = 'pending' ORDER BY fire_at_ms ASC, id ASC LIMIT 20")
        .bind(userId).all();
    const list = (res && res.results) || [];
    if (!list.length) return '现在没有待提醒的事。发「提醒我 20:00 给电动牙刷充电」这种格式我就记下——到点真的会在微信里叫你。';
    const lines = ['**我的提醒**（' + list.length + ' 条）'];
    list.forEach((r, i) => {
        lines.push((i + 1) + '. ' + formatReminderTime(r.fire_at_ms, now) + ' — ' + r.text + ' (#' + r.id + ')');
    });
    lines.push('');
    lines.push('想改时间或取消直接说就行（如「取消早上的8点那个」「把手帕纸改到晚上8点」）。');
    return lines.join('\n');
}

/** 按 #ID / 列表序号 / 最近 / 时段时刻 / 关键词匹配活跃提醒 */
async function matchActiveReminders(db, userId, rawKey, nowMs, { statuses = ['pending', 'fired'] } = {}) {
    const key = String(rawKey == null ? '' : rawKey).trim();
    const inSql = statuses.map((s) => "'" + s + "'").join(', ');

    const hashMatch = key.match(/^#(\d+)$/);
    if (hashMatch) {
        const id = Number(hashMatch[1]);
        const row = await db.prepare(`SELECT id, text, fire_at_ms, status FROM bot_reminders WHERE id = ?1 AND user_id = ?2 AND is_deleted = 0 AND status IN (${inSql})`)
            .bind(id, userId).first();
        return { kind: 'id', key, matches: row ? [row] : [], notFoundMsg: '没找到编号为 #' + id + ' 的提醒。' };
    }

    if (/^\d{1,2}$/.test(key)) {
        // 序号始终按「我的提醒」展示的 pending 顺序对齐
        const pendingRes = await db.prepare("SELECT id, text, fire_at_ms, status FROM bot_reminders WHERE user_id = ?1 AND is_deleted = 0 AND status = 'pending' ORDER BY fire_at_ms ASC, id ASC LIMIT 20")
            .bind(userId).all();
        const pendingList = (pendingRes && pendingRes.results) || [];
        let row = pendingList[Number(key) - 1] || null;
        if (!row) {
            row = await db.prepare(`SELECT id, text, fire_at_ms, status FROM bot_reminders WHERE id = ?1 AND user_id = ?2 AND is_deleted = 0 AND status IN (${inSql})`)
                .bind(Number(key), userId).first() || null;
        }
        return { kind: 'index', key, matches: row ? [row] : [], notFoundMsg: '没有第 ' + key + ' 条待提醒，发「我的提醒」看看现在的编号。' };
    }

    if (/^\d+$/.test(key)) {
        const row = await db.prepare(`SELECT id, text, fire_at_ms, status FROM bot_reminders WHERE id = ?1 AND user_id = ?2 AND is_deleted = 0 AND status IN (${inSql})`)
            .bind(Number(key), userId).first();
        return { kind: 'id', key, matches: row ? [row] : [], notFoundMsg: '没找到编号为 #' + key + ' 的提醒。' };
    }

    const allRes = await db.prepare(`SELECT id, text, fire_at_ms, status, created_at FROM bot_reminders WHERE user_id = ?1 AND is_deleted = 0 AND status IN (${inSql}) ORDER BY fire_at_ms ASC, id ASC LIMIT 50`)
        .bind(userId).all();
    const all = (allRes && allRes.results) || [];
    if (!all.length) return { kind: 'natural', key, matches: [], notFoundMsg: '现在没有待处理或待提醒的事项。' };

    const filter = extractTimeAndKeywordFilter(key);
    if (filter.isDeicticRecent) {
        // 「刚才/上一条/这个」按 id 倒序取最新创建的一条（优先 pending）
        const pendingSorted = all.filter((r) => r.status === 'pending').sort((a, b) => b.id - a.id);
        const latest = pendingSorted[0] || all.slice().sort((a, b) => b.id - a.id)[0];
        return { kind: 'recent', key, matches: latest ? [latest] : [], notFoundMsg: '没有找到刚才那条提醒。' };
    }

    const hasTimeFilter = filter.dayOffset !== null || filter.expectedHours !== null || filter.period !== null;
    let candidates = all.filter((row) => {
        if (hasTimeFilter && !rowMatchesTimeFilter(row, filter, nowMs)) return false;
        if (filter.keyword && !String(row.text || '').toLowerCase().includes(filter.keyword.toLowerCase())) return false;
        return hasTimeFilter || Boolean(filter.keyword);
    });

    // 「8点」没写明分钟时，如果恰好有 08:00 优先命中整点；否则放宽到同小时任意分钟
    if (!candidates.length && filter.expectedHours && filter.expectedMinute === null) {
        candidates = all.filter((row) => {
            const parts = east8Parts(row.fire_at_ms);
            if (!filter.expectedHours.includes(parts.hour)) return false;
            if (filter.keyword && !String(row.text || '').toLowerCase().includes(filter.keyword.toLowerCase())) return false;
            return true;
        });
    }

    // 如果既有 pending 又有旧 fired 同时命中，优先动 pending（除非只有 fired 命中）
    const pendingHits = candidates.filter((r) => r.status === 'pending');
    if (pendingHits.length) candidates = pendingHits;

    return {
        kind: 'natural',
        key,
        matches: candidates,
        notFoundMsg: filter.keyword
            ? ('没找到待提醒里含「' + filter.keyword + '」的事，发「我的提醒」看看。')
            : '没找到匹配这个时间的待提醒，直接说事项关键词或发「我的提醒」看看。'
    };
}

/** 修改或顺延某条待提醒的时间（「是晚上8点我说错了」「把早上8点那个改成晚上8点」「推迟半小时」） */
export async function rescheduleReminder(db, userId, parsed, nowMs) {
    if (!parsed || !parsed.matched) return null;
    if (!parsed.ok) return parsed.reply;
    const now = Number(nowMs) || Date.now();

    let target = null;
    if (parsed.targetArg) {
        const res = await matchActiveReminders(db, userId, parsed.targetArg, now, { statuses: ['pending'] });
        if (!res.matches.length) return res.notFoundMsg;
        if (res.matches.length > 1) {
            const lines = res.matches.slice(0, 5).map((r, i) => (i + 1) + '. ' + formatReminderTime(r.fire_at_ms, now) + ' — ' + r.text + ' (#' + r.id + ')');
            return '找到 ' + res.matches.length + ' 条匹配的提醒，说清改哪一条：\n\n' + lines.join('\n') + '\n\n比如「把 #' + res.matches[0].id + ' 改到晚上8点」。';
        }
        target = res.matches[0];
    } else {
        target = await db.prepare("SELECT id, text, fire_at_ms, status FROM bot_reminders WHERE user_id = ?1 AND is_deleted = 0 AND status = 'pending' ORDER BY id DESC LIMIT 1")
            .bind(userId).first();
        if (!target) return '现在没有待提醒的事可以改。';
    }

    const newFireAtMs = parsed.deltaMs > 0
        ? Math.max(now + REMINDER_MIN_LEAD_MS, Number(target.fire_at_ms) + parsed.deltaMs)
        : Number(parsed.newFireAtMs);
    if (!Number.isFinite(newFireAtMs) || newFireAtMs <= now + REMINDER_MIN_LEAD_MS || newFireAtMs > now + REMINDER_MAX_LEAD_MS) {
        return '改后的时间要在未来 1 分钟到 1 年之间。';
    }

    const upd = await db.prepare("UPDATE bot_reminders SET fire_at_ms = ?1, updated_at = datetime('now', '+8 hours') WHERE id = ?2 AND user_id = ?3 AND status = 'pending'")
        .bind(newFireAtMs, target.id, userId).run();
    if (Number((upd && upd.meta && upd.meta.changes) || 0) !== 1) {
        return '这条提醒刚刚已经触发或被取消了，发「我的提醒」看看最新的。';
    }
    return '好，改好了 ✅\n> ' + formatReminderTime(newFireAtMs, now) + ' — ' + target.text;
}

/** 「取消提醒 N / #ID / 时间 / 关键词 / 刚才那个」：pending 或刚提醒过的 fired 均可取消并停止追问，一律软删 */
export async function cancelReminder(db, userId, arg, nowMs) {
    const now = Number(nowMs) || Date.now();
    const key = String(arg == null ? '' : arg).trim();
    if (!key) return '取消哪条？直接跟我说时间或事情就行（如「取消早上8点那个」或「取消洗保温杯」）。';

    if (CANCEL_ALL_RE.test(key)) {
        const res = await db.prepare("UPDATE bot_reminders SET status = 'cancelled', follow_up_retry_at_ms = 0, is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE user_id = ?1 AND is_deleted = 0 AND status IN ('pending', 'fired')")
            .bind(userId).run();
        const n = Number((res && res.meta && res.meta.changes) || 0);
        return n > 0 ? ('好，已取消全部 ' + n + ' 条提醒。') : '现在没有待取消的提醒。';
    }

    const matched = await matchActiveReminders(db, userId, key, now, { statuses: ['pending', 'fired'] });
    if (!matched.matches.length) return matched.notFoundMsg;
    if (matched.matches.length > 1) {
        const lines = matched.matches.slice(0, 6).map((r, i) => (i + 1) + '. ' + formatReminderTime(r.fire_at_ms, now) + ' — ' + r.text + ' (#' + r.id + ')');
        return '有 ' + matched.matches.length + ' 条都符合「' + key + '」：\n\n' + lines.join('\n') + '\n\n告诉我要取消哪条（如「取消 #' + matched.matches[0].id + '」或加上事情关键词）。';
    }

    const target = matched.matches[0];
    const upd = await db.prepare("UPDATE bot_reminders SET status = 'cancelled', follow_up_retry_at_ms = 0, is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2 AND status IN ('pending', 'fired')")
        .bind(target.id, userId).run();
    if (Number((upd && upd.meta && upd.meta.changes) || 0) !== 1) {
        return '这条刚刚变了（可能已被取消或核销），发「我的提醒」看看最新的。';
    }
    return '好，取消了：' + formatReminderTime(target.fire_at_ms, now) + ' — ' + target.text + '。';
}

/** 12 小时内刚提醒过、还没回「完成」的列表（同批次同时间触发的会一起返回） */
export async function recentFiredReminders(db, userId, nowMs) {
    const now = Number(nowMs) || Date.now();
    const res = await db.prepare("SELECT id, text, fired_at_ms FROM bot_reminders WHERE user_id = ?1 AND is_deleted = 0 AND status = 'fired' AND fired_at_ms >= ?2 ORDER BY fired_at_ms DESC, id DESC LIMIT 20")
        .bind(userId, now - REMINDER_DONE_WINDOW_MS).all();
    return (res && res.results) || [];
}

/** 12 小时内刚提醒过、还没回「完成」的那条（「完成/还没」兼容单条调用） */
export async function recentFiredReminder(db, userId, nowMs) {
    const list = await recentFiredReminders(db, userId, nowMs);
    return list[0] || null;
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

    // 自动归档超过 12 小时且已提醒过的旧条目，防止长期滞留数据库
    await db.prepare("UPDATE bot_reminders SET status = 'done', follow_up_status = CASE WHEN follow_up_status IN ('pending', 'sending') THEN 'failed' ELSE follow_up_status END, follow_up_retry_at_ms = 0, updated_at = datetime('now', '+8 hours') WHERE is_deleted = 0 AND status = 'fired' AND fired_at_ms > 0 AND fired_at_ms < ?1")
        .bind(now - REMINDER_DONE_WINDOW_MS).run();

    const dueRes = await db.prepare("SELECT id, user_id, text, fire_at_ms, follow_up_ms, follow_up_attempts FROM bot_reminders WHERE is_deleted = 0 AND status = 'pending' AND fire_at_ms <= ?1 AND (follow_up_retry_at_ms = 0 OR follow_up_retry_at_ms <= ?1) AND follow_up_attempts < ?2 ORDER BY fire_at_ms ASC, id ASC LIMIT ?3")
        .bind(now, REMINDER_FOLLOW_UP_MAX_ATTEMPTS, limit).all();
    const due = (dueRes && dueRes.results) || [];
    summary.due = due.length;

    const dueByUser = new Map();
    for (const row of due) {
        if (Number(row.follow_up_attempts || 0) >= REMINDER_FOLLOW_UP_MAX_ATTEMPTS) {
            await db.prepare("UPDATE bot_reminders SET status = 'missed', follow_up_status = 'failed', updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND status = 'pending'")
                .bind(row.id).run();
            summary.missed++;
            continue;
        }
        if (now - Number(row.fire_at_ms || 0) > stale) {
            await db.prepare("UPDATE bot_reminders SET status = 'missed', updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND status = 'pending'")
                .bind(row.id).run();
            summary.missed++;
            continue;
        }
        if (!dueByUser.has(row.user_id)) dueByUser.set(row.user_id, []);
        dueByUser.get(row.user_id).push(row);
    }

    for (const [userId, userRows] of dueByUser.entries()) {
        const account = await loadBoundAccount(db, userId);
        if (!account) {
            for (const row of userRows) {
                await db.prepare("UPDATE bot_reminders SET status = 'missed', updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND status = 'pending'")
                    .bind(row.id).run();
                summary.missed++;
            }
            continue;
        }

        const claimed = [];
        for (const row of userRows) {
            const followUpMs = normalizeFollowUpMs(row.follow_up_ms) || followUpMsForText(row.text);
            const followUpAt = now + followUpMs;
            const claim = await db.prepare("UPDATE bot_reminders SET status = 'fired', fired_at_ms = ?1, follow_up_at_ms = ?2, follow_up_ms = ?3, follow_up_status = 'pending', follow_up_attempts = 0, follow_up_retry_at_ms = ?2, updated_at = datetime('now', '+8 hours') WHERE id = ?4 AND status = 'pending'")
                .bind(now, followUpAt, followUpMs, row.id).run();
            if (Number((claim && claim.meta && claim.meta.changes) || 0) === 1) {
                claimed.push(row);
            }
        }
        if (!claimed.length) continue;

        const firedText = claimed.length === 1
            ? reminderFiredText(claimed[0].text)
            : reminderBatchFiredText(claimed);
        try {
            const send = await loadSender();
            await send({
                token: account.bot_token,
                baseurl: account.baseurl,
                botId: account.ilink_bot_id,
                toUserId: account.ilink_user_id,
                contextToken: account.last_context_token || '',
                text: firedText,
                fetchImpl
            });
            summary.sent += claimed.length;
            await saveTurnSafe(db, userId, firedText);
            console.log('[reminder] 已送达 ids=' + claimed.map((r) => r.id).join(',') + ' user=' + userId);
        } catch (err) {
            for (const row of claimed) {
                const nextAttempt = Number(row.follow_up_attempts || 0) + 1;
                if (nextAttempt >= REMINDER_FOLLOW_UP_MAX_ATTEMPTS) {
                    await db.prepare("UPDATE bot_reminders SET status = 'missed', follow_up_status = 'failed', follow_up_attempts = ?1, updated_at = datetime('now', '+8 hours') WHERE id = ?2 AND status = 'fired'")
                        .bind(nextAttempt, row.id).run();
                    console.error('[reminder] 发送达到最大重试上限 id=' + row.id + ' attempt=' + nextAttempt + ': 标记为 missed');
                } else {
                    const retryAt = now + followUpBackoffMs(nextAttempt);
                    await db.prepare("UPDATE bot_reminders SET status = 'pending', fired_at_ms = 0, follow_up_at_ms = 0, follow_up_status = 'none', follow_up_attempts = ?1, follow_up_retry_at_ms = ?2, updated_at = datetime('now', '+8 hours') WHERE id = ?3 AND status = 'fired'")
                        .bind(nextAttempt, retryAt, row.id).run();
                    console.error('[reminder] 发送失败 id=' + row.id + ' attempt=' + nextAttempt + ': ' + (err && err.message));
                }
                summary.failed++;
            }
        }
    }

    const askRes = await db.prepare("SELECT id, user_id, text, follow_up_attempts FROM bot_reminders WHERE is_deleted = 0 AND status = 'fired' AND follow_up_status IN ('pending', 'sending') AND follow_up_retry_at_ms > 0 AND follow_up_retry_at_ms <= ?1 ORDER BY follow_up_retry_at_ms ASC, id ASC LIMIT ?2")
        .bind(now, limit).all();
    const askByUser = new Map();
    for (const row of ((askRes && askRes.results) || [])) {
        const attempts = Number(row.follow_up_attempts || 0);
        if (attempts >= REMINDER_FOLLOW_UP_MAX_ATTEMPTS) {
            await scheduleFollowUpRetry(db, row.id, attempts, now, 'max_attempts');
            summary.failed++;
            continue;
        }
        if (!askByUser.has(row.user_id)) askByUser.set(row.user_id, []);
        askByUser.get(row.user_id).push(row);
    }

    for (const [userId, askRows] of askByUser.entries()) {
        let account = null;
        try {
            account = await loadBoundAccount(db, userId);
        } catch (err) {
            for (const row of askRows) {
                await scheduleFollowUpRetry(db, row.id, Number(row.follow_up_attempts || 0) + 1, now, 'account_read_failed');
                summary.failed++;
                console.error('[reminder] 追问读账号失败 id=' + row.id + ': ' + (err && err.message));
            }
            continue;
        }
        if (!account) {
            for (const row of askRows) {
                await scheduleFollowUpRetry(db, row.id, Number(row.follow_up_attempts || 0) + 1, now, 'no_account');
                summary.failed++;
            }
            continue;
        }

        const claimed = [];
        for (const row of askRows) {
            const nextAttempt = Number(row.follow_up_attempts || 0) + 1;
            const claim = await db.prepare("UPDATE bot_reminders SET follow_up_status = 'sending', follow_up_attempts = ?1, follow_up_retry_at_ms = ?2, updated_at = datetime('now', '+8 hours') WHERE id = ?3 AND status = 'fired' AND follow_up_status IN ('pending', 'sending') AND follow_up_retry_at_ms <= ?4")
                .bind(nextAttempt, now + REMINDER_FOLLOW_UP_LEASE_MS, row.id, now).run();
            if (Number((claim && claim.meta && claim.meta.changes) || 0) === 1) {
                claimed.push({ row, nextAttempt });
            }
        }
        if (!claimed.length) continue;

        const askText = claimed.length === 1
            ? reminderAskText(claimed[0].row.text)
            : reminderBatchAskText(claimed.map((c) => c.row));
        try {
            const send = await loadSender();
            await send({
                token: account.bot_token,
                baseurl: account.baseurl,
                botId: account.ilink_bot_id,
                toUserId: account.ilink_user_id,
                contextToken: account.last_context_token || '',
                text: askText,
                fetchImpl
            });
            for (const { row } of claimed) {
                await db.prepare("UPDATE bot_reminders SET follow_up_status = 'sent', follow_up_sent = 1, follow_up_retry_at_ms = 0, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND status = 'fired'")
                    .bind(row.id).run();
                summary.asked++;
            }
            await saveTurnSafe(db, userId, askText);
        } catch (err) {
            for (const { row, nextAttempt } of claimed) {
                await scheduleFollowUpRetry(db, row.id, nextAttempt, now, 'send_failed');
                summary.failed++;
                console.error('[reminder] 追问失败 id=' + row.id + ': ' + (err && err.message));
            }
        }
    }
    return summary;
}
