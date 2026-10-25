/**
 * 健康打卡（v2.5.155，小米运动健康接入的 A 方案）：把微信里的一句话解析成「一天一行」的自述健康数据。
 *
 * 设计立场：
 *   1. **只认确定性的显式格式**——不猜意图、不落库。用户没说「健康：」这句就还给聊天
 *      （与 bot-commands 的「默认无副作用」底线一致）；只有显式指令词或冒号才进写入通道，
 *      而且解析不出任何数值时只回一条格式说明，绝不存一整句聊天正文。
 *   2. **一天一行、UPSERT 合并**：早上说睡眠、晚上说步数，两次都落在同一天那一行上，
 *      只覆盖这次说到的字段（COALESCE(excluded.x, 原值)），没说到的保持原样。
 *   3. **时间口径东八区**：date 由 +8 小时推算，绝不用 SQLite 的 date('now')（那是 UTC，
 *      东八区夜里 8 点之后会把「今天」算成昨天）。created_at / updated_at 同全库规则。
 *   4. **只读不写回**：source 列现在只会是 'manual'。将来若真走通小米云对云（B 方案），
 *      机器观测写 'mi_health'，与自述数据同表共存、可区分，但绝不调用小米的写入接口。
 *
 * 与 bot-reminders.js 一样自带一份东八区工具：领域模块不反向依赖 bot-commands，
 * 也避免静态 import 形成环。解析函数一律纯同步，方便离线用例逐条覆盖。
 */

/** 汇总窗口：微信里刷 30 天没意义，一周刚刚好 */
export const HEALTH_REPORT_DAYS = 7;
/** 合理范围：超出按「没听懂」处理，宁可少记也不往库里塞一串荒谬数字 */
export const HEALTH_RANGES = {
    steps: [0, 200000],
    sleepMin: [0, 1440],
    activeMin: [0, 1440],
    restingHr: [30, 220],
    weightKg: [20, 300]
};

/** 显式指令但一个数值都没解析出来时的回执：把格式摊开给他，别让他猜我为什么没记 */
export const HEALTH_FORMAT_HINT = '这句里我没读到任何健康数值，所以什么都没记。可以这样发：\n'
    + '「健康：昨晚睡了 6 小时 20 分，8500 步」\n'
    + '「健康：今天走了 12000 步，中高强度 45 分钟，静息心率 62」\n'
    + '「健康：体重 68.5 公斤」\n'
    + '能认的字段：步数、睡眠时长、中高强度运动分钟、静息心率、体重；'
    + '日期默认今天，也可以写「今天 / 昨天 / 昨晚 / 前天」。';

/** 光杆要汇总（纯指令，不带数值） */
const HEALTH_REPORT_RE = /^(?:我的健康|健康数据|健康报告|健康情况|健康汇总|健康|health|\/health)$/i;
/** 显式指令词：解析不出数值也要给格式说明（这几条不会被误当成普通聊天） */
const HEALTH_STRONG_WRITE_RE = /^(?:请|帮我|麻烦(?:你)?|帮)?\s*(?:健康打卡|健康记录|记录健康|记健康)\s*[:：，,]?\s*([^]+)$/i;
/** 「健康：…」——冒号是显式信号（光写「健康最重要」不该被劫持） */
const HEALTH_COLON_WRITE_RE = /^(?:请|帮我|麻烦(?:你)?|帮)?\s*健康\s*[:：]\s*([^]+)$/i;
/** 「健康 8500 步」——没冒号，只有真的解析出数值才算打卡（宁可漏记，不可错记） */
const HEALTH_RELAXED_WRITE_RE = /^(?:请|帮我|麻烦(?:你)?|帮)?\s*(?:健康打卡|健康记录|记录健康|记健康|健康)\s+([^]+)$/i;

/** 睡眠：小时 + 可选分钟（「6 小时 20 分」/「7 小时」/「睡了 45 分钟」） */
const SLEEP_HM_RE = /(?:睡(?:了|着)?|睡眠(?:时长)?)[^0-9]{0,4}([0-9]+(?:\.[0-9]+)?)\s*(?:个)?\s*小时(?:\s*([0-9]+)\s*分(?:钟)?)?/;
const SLEEP_MIN_RE = /(?:睡(?:了|着)?|睡眠(?:时长)?)[^0-9]{0,4}([0-9]+)\s*分(?:钟)?/;
/** 步数：「8500 步」或「步数 8500」（带千分位也认） */
const STEPS_RE = /([0-9][0-9,]*)\s*步/;
const STEPS_LABEL_RE = /步数\s*[:：]?\s*([0-9][0-9,]*)/;
/** 中高强度：分钟优先，其次小时 */
const ACTIVE_MIN_RE = /(?:中高强度|高强度|运动|锻炼|活动|健身|跑步|快走|散步|跑(?:了|步)?)[^0-9]{0,4}([0-9]+)\s*分(?:钟)?/;
const ACTIVE_HOUR_RE = /(?:中高强度|高强度|运动|锻炼|活动|健身)[^0-9]{0,4}([0-9]+(?:\.[0-9]+)?)\s*(?:个)?\s*小时/;
/** 心率：「静息心率 62」或「62 次/分」「62bpm」 */
const HR_RE = /(?:静息心率|心率|脉搏)\s*[:：]?\s*([0-9]{2,3})/;
const HR_BPM_RE = /([0-9]{2,3})\s*(?:次\s*\/\s*分|bpm)/i;
/** 体重：「体重 68.5 公斤」（斤自动折半成公斤） */
const WEIGHT_RE = /(?:体重|重量)\s*[:：]?\s*([0-9]{2,3}(?:\.[0-9]+)?)\s*(kg|KG|公斤|千克|斤)?/;

/** 东八区自然日 YYYY-MM-DD（不用 SQLite 的 date('now')，那是 UTC） */
export function east8Ymd(nowMs) {
    const ms = Number.isFinite(nowMs) ? nowMs : Date.now();
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 自然日平移（用 UTC 零点做算术，避开夏令时与本地时区） */
export function shiftYmd(ymd, days) {
    const base = Date.parse(String(ymd) + 'T00:00:00Z');
    if (!Number.isFinite(base)) return String(ymd);
    return new Date(base + days * 86400000).toISOString().slice(0, 10);
}

/** 展示用日期：今天 / 昨天 / 前天 / 10月18日 */
export function formatHealthDate(ymd, nowMs) {
    const today = east8Ymd(nowMs);
    if (ymd === today) return '今天';
    if (ymd === shiftYmd(today, -1)) return '昨天';
    if (ymd === shiftYmd(today, -2)) return '前天';
    const s = String(ymd);
    return Number(s.slice(5, 7)) + '月' + Number(s.slice(8, 10)) + '日';
}

/** 390 → 「6 小时 30 分」；45 → 「45 分钟」 */
export function formatMinutes(total) {
    const n = Math.max(0, Math.round(Number(total) || 0));
    const h = Math.floor(n / 60);
    const m = n % 60;
    if (!h) return m + ' 分钟';
    return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
}

/** 句子里提到的日期词；没提就是今天（不提「明后天」——健康数据只能是过去或现在） */
export function resolveHealthDate(text, nowMs) {
    const raw = String(text == null ? '' : text);
    const today = east8Ymd(nowMs);
    if (/前天/.test(raw)) return shiftYmd(today, -2);
    if (/昨天|昨晚|昨日|昨儿/.test(raw)) return shiftYmd(today, -1);
    return today;
}

/**
 * 把一句话解析成结构化字段。返回 null = 一个字段都没读到（调用方据此决定「还给聊天」）。
 * 越界的数值不静默丢弃，而是记进 rejected 让回执点名——用户明明说了数字，得让他知道我没记。
 */
export function parseHealthEntry(text, nowMs) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;

    const fields = {};
    const rejected = [];
    const accept = (key, value, label, integer) => {
        if (value == null || !Number.isFinite(value)) return;
        const range = HEALTH_RANGES[key];
        if (value < range[0] || value > range[1]) {
            rejected.push(label + ' ' + value);
            return;
        }
        fields[key] = integer ? Math.round(value) : Math.round(value * 10) / 10;
    };

    const sleepHm = SLEEP_HM_RE.exec(raw);
    if (sleepHm) {
        const mins = sleepHm[2] ? Number(sleepHm[2]) : 0;
        accept('sleepMin', Number(sleepHm[1]) * 60 + mins, '睡眠', true);
    } else {
        const sleepM = SLEEP_MIN_RE.exec(raw);
        if (sleepM) accept('sleepMin', Number(sleepM[1]), '睡眠', true);
    }

    const steps = STEPS_RE.exec(raw) || STEPS_LABEL_RE.exec(raw);
    if (steps) accept('steps', Number(String(steps[1]).replace(/,/g, '')), '步数', true);

    const activeM = ACTIVE_MIN_RE.exec(raw);
    const activeH = activeM ? null : ACTIVE_HOUR_RE.exec(raw);
    if (activeM) accept('activeMin', Number(activeM[1]), '运动时长', true);
    else if (activeH) accept('activeMin', Number(activeH[1]) * 60, '运动时长', true);

    const hr = HR_RE.exec(raw) || HR_BPM_RE.exec(raw);
    if (hr) accept('restingHr', Number(hr[1]), '心率', true);

    const weight = WEIGHT_RE.exec(raw);
    if (weight) {
        const unit = weight[2] || 'kg';
        accept('weightKg', unit === '斤' ? Number(weight[1]) / 2 : Number(weight[1]), '体重', false);
    }

    if (!Object.keys(fields).length && !rejected.length) return null;
    return { date: resolveHealthDate(raw, nowMs), fields, rejected };
}

/**
 * 指令判别：返回 { matched, kind, entry?, error? }。
 * 关键在最后一档——没有显式指令词与冒号时（「健康最重要了」），
 * 只有真的解析出数值才认成打卡，否则 matched:false 原样交给聊天。
 */
export function parseHealthCommand(text, nowMs) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return { matched: false };
    if (HEALTH_REPORT_RE.test(raw)) return { matched: true, kind: 'report' };

    const strong = HEALTH_STRONG_WRITE_RE.exec(raw);
    if (strong) return writeResult(strong[1], nowMs);
    const colon = HEALTH_COLON_WRITE_RE.exec(raw);
    if (colon) return writeResult(colon[1], nowMs);
    const relaxed = HEALTH_RELAXED_WRITE_RE.exec(raw);
    if (relaxed) {
        const entry = parseHealthEntry(relaxed[1], nowMs);
        if (entry) return { matched: true, kind: 'write', entry };
    }
    return { matched: false };
}

function writeResult(body, nowMs) {
    const entry = parseHealthEntry(body, nowMs);
    if (!entry) return { matched: true, kind: 'write', error: HEALTH_FORMAT_HINT };
    return { matched: true, kind: 'write', entry };
}

/** 写一天：UPSERT 合并，null 值不覆盖已有字段 */
export async function saveHealthDaily(db, userId, entry) {
    const f = (entry && entry.fields) || {};
    const pick = (key) => (f[key] == null ? null : f[key]);
    await db.prepare(
        "INSERT INTO health_daily (user_id, date, steps, sleep_min, active_min, resting_hr, weight_kg, source, is_deleted) "
        + "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'manual', 0) "
        + "ON CONFLICT(user_id, date) DO UPDATE SET "
        + "steps = COALESCE(excluded.steps, health_daily.steps), "
        + "sleep_min = COALESCE(excluded.sleep_min, health_daily.sleep_min), "
        + "active_min = COALESCE(excluded.active_min, health_daily.active_min), "
        + "resting_hr = COALESCE(excluded.resting_hr, health_daily.resting_hr), "
        + "weight_kg = COALESCE(excluded.weight_kg, health_daily.weight_kg), "
        + "is_deleted = 0, "
        + "updated_at = datetime('now', '+8 hours')"
    ).bind(userId, entry.date, pick('steps'), pick('sleepMin'), pick('activeMin'), pick('restingHr'), pick('weightKg')).run();
    return getHealthDay(db, userId, entry.date);
}

export async function getHealthDay(db, userId, date) {
    return db.prepare(
        'SELECT date, steps, sleep_min, active_min, resting_hr, weight_kg, source, updated_at '
        + 'FROM health_daily WHERE user_id = ?1 AND date = ?2 AND is_deleted = 0'
    ).bind(userId, date).first();
}

/** 最近 days 天（含今天）的自述健康记录，按日期升序 */
export async function getHealthRange(db, userId, days, nowMs) {
    const span = Math.max(1, Math.floor(Number(days) || HEALTH_REPORT_DAYS));
    const to = east8Ymd(nowMs);
    const from = shiftYmd(to, -(span - 1));
    const res = await db.prepare(
        'SELECT date, steps, sleep_min, active_min, resting_hr, weight_kg, source, updated_at '
        + 'FROM health_daily WHERE user_id = ?1 AND is_deleted = 0 AND date >= ?2 AND date <= ?3 '
        + 'ORDER BY date ASC'
    ).bind(userId, from, to).all();
    return (res && res.results) || [];
}

/** 一天的展示行：今天：睡眠 6 小时 20 分 · 8500 步 · 中高强度 45 分钟 */
export function formatHealthDay(row, nowMs) {
    if (!row) return '';
    const parts = [];
    if (row.sleep_min != null) parts.push('睡眠 ' + formatMinutes(row.sleep_min));
    if (row.steps != null) parts.push(Number(row.steps) + ' 步');
    if (row.active_min != null) parts.push('中高强度 ' + Number(row.active_min) + ' 分钟');
    if (row.resting_hr != null) parts.push('静息心率 ' + Number(row.resting_hr));
    if (row.weight_kg != null) parts.push('体重 ' + Number(row.weight_kg) + ' 公斤');
    return formatHealthDate(row.date, nowMs) + '：' + (parts.length ? parts.join(' · ') : '（没有数值）');
}

/**
 * 汇总：只统计真的记过该字段的天。
 * 没记的那几天不按 0 计算——否则「只记了三天」会摊成一周的低均值，看起来像身体变差了。
 */
export function formatHealthSummary(rows, nowMs) {
    if (!rows.length) {
        return '最近 ' + HEALTH_REPORT_DAYS + ' 天还没有健康记录。想记就在微信里发一句，比如：\n'
            + '「健康：昨晚睡了 6 小时 20 分，8500 步」';
    }
    const lines = rows.map((row) => '- ' + formatHealthDay(row, nowMs));
    const tail = [];
    const steps = rows.filter((r) => r.steps != null);
    const sleeps = rows.filter((r) => r.sleep_min != null);
    if (steps.length) {
        const sum = steps.reduce((acc, r) => acc + Number(r.steps), 0);
        tail.push('步数日均 ' + Math.round(sum / steps.length) + '（' + steps.length + ' 天有记录）');
    }
    if (sleeps.length) {
        const sum = sleeps.reduce((acc, r) => acc + Number(r.sleep_min), 0);
        tail.push('睡眠日均 ' + formatMinutes(Math.round(sum / sleeps.length)) + '（' + sleeps.length + ' 天有记录）');
    }
    return '**健康打卡 · 最近 ' + HEALTH_REPORT_DAYS + ' 天**\n\n' + lines.join('\n')
        + (tail.length ? '\n\n' + tail.join(' · ') : '')
        + '\n\n（都是你自己说的，我只做记录。）';
}

/**
 * bot-commands 的接线口：不是健康指令就返回 null（原样交给聊天）。
 * 判别与执行都留在本模块，是为了让 bot-commands 守在 500 行红线内。
 */
export async function maybeRunHealthCommand(db, userId, text, nowMs) {
    const parsed = parseHealthCommand(text, nowMs);
    if (!parsed.matched) return null;
    return runHealthCommand(db, userId, parsed, nowMs);
}

/**
 * 指令执行：report 只看库；write 先落库再回执（回执里写清我理解到的每一个值，方便当场纠错）。
 * 不做频率限制：一天一行、重复只是覆盖，刷不爆库。
 */
export async function runHealthCommand(db, userId, parsed, nowMs) {
    if (!parsed || !parsed.matched) return null;
    if (parsed.kind === 'report') {
        const rows = await getHealthRange(db, userId, HEALTH_REPORT_DAYS, nowMs);
        return formatHealthSummary(rows, nowMs);
    }
    if (parsed.error) return parsed.error;

    const entry = parsed.entry;
    if (!entry || !Object.keys(entry.fields || {}).length) {
        const bad = (entry && entry.rejected) || [];
        return '这些数值不像真的，我没记：' + bad.join('、') + '。\n' + HEALTH_FORMAT_HINT;
    }
    const row = await saveHealthDaily(db, userId, entry);
    let reply = '记下了 ✅ ' + formatHealthDay(row, nowMs);
    if (entry.rejected.length) reply += '\n\n这些我没敢记（超出合理范围）：' + entry.rejected.join('、');
    reply += '\n\n发「健康」能看最近 ' + HEALTH_REPORT_DAYS + ' 天。';
    return reply;
}
