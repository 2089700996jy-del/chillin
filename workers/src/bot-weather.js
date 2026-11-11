/**
 * 和风天气（QWeather）高精度天气服务与 8:00 晨报智能关怀 (bot-weather.js)
 *
 * 核心设计原则：
 *   1. 现代 Ed25519 JWT 认证 + 传统 API Key 双模兼容；
 *   2. 高精度逐小时解析：最高温几点出、最低温几点出、降雨起止时间与雨量（大中小）；
 *   3. 确定性昨日温差（≥3℃ 注意、≥5℃ 增减衣物）与昼夜温差（≥8℃ 洋葱穿搭）；
 *   4. 8:00 晨间关怀「无事不扰」原则：若天气舒适、无雨、无温差突变、无恶劣预警，完全静默；
 *   5. 白天随时问随时秒回，附带 30 分钟轻量级缓存。
 */

import { sendClawText } from './bot-claw.js';
import { listProfile } from './bot-memory.js';
import { saveChatTurn } from './bot-memory.js';

let cachedJwt = null;
let cachedJwtExp = 0;
const weatherCache = new Map(); // city -> { data, exp }

/** Base64URL 编码（RFC 7515） */
export function base64UrlEncode(bytesOrStr) {
    let binary = '';
    if (typeof bytesOrStr === 'string') {
        const bytes = new TextEncoder().encode(bytesOrStr);
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    } else {
        const bytes = bytesOrStr instanceof Uint8Array ? bytesOrStr : new Uint8Array(bytesOrStr);
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PEM 格式私钥转 Uint8Array DER */
export function pemToDer(pem) {
    const b64 = String(pem || '').replace(/-----[^\n]+-----|\s+/g, '');
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf;
}

/** 生成和风天气 Ed25519 JWT 凭据（有效时长 1 小时，内存缓存 50 分钟） */
export async function getQWeatherToken(env, nowMs = Date.now()) {
    if (!env) return null;
    const keyId = env.QWEATHER_KEY_ID;
    const projectId = env.QWEATHER_PROJECT_ID;
    const privKeyPem = env.QWEATHER_PRIVATE_KEY;

    if (keyId && projectId && privKeyPem) {
        if (cachedJwt && nowMs < cachedJwtExp) return { type: 'bearer', token: cachedJwt };
        try {
            const der = pemToDer(privKeyPem);
            const key = await globalThis.crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
            const nowSec = Math.floor(nowMs / 1000);
            const header = { alg: 'EdDSA', kid: keyId, typ: 'JWT' };
            const payload = { sub: projectId, iat: nowSec - 30, exp: nowSec + 3600 };
            const signingInput = base64UrlEncode(JSON.stringify(header)) + '.' + base64UrlEncode(JSON.stringify(payload));
            const sig = await globalThis.crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(signingInput));
            const token = signingInput + '.' + base64UrlEncode(sig);
            cachedJwt = token;
            cachedJwtExp = nowMs + 50 * 60 * 1000;
            return { type: 'bearer', token };
        } catch (err) {
            console.error('[bot-weather] Ed25519 JWT 签名生成失败: ' + (err && err.message));
        }
    }
    if (env.QWEATHER_KEY) return { type: 'key', token: env.QWEATHER_KEY };
    return null;
}

/** 发起和风天气 API 请求 */
export async function fetchQWeather(env, urlStr, fetchImpl = fetch, nowMs = Date.now()) {
    const auth = await getQWeatherToken(env, nowMs);
    if (!auth) return null;
    const url = new URL(urlStr);
    const headers = { 'Accept-Encoding': 'gzip' };
    if (auth.type === 'bearer') {
        headers['Authorization'] = 'Bearer ' + auth.token;
    } else if (auth.type === 'key') {
        url.searchParams.set('key', auth.token);
    }
    try {
        const res = await fetchImpl(url.toString(), { headers });
        if (!res.ok) return null;
        const data = await res.json();
        return (data && (data.code === '200' || data.code === 200)) ? data : null;
    } catch (err) {
        console.error('[bot-weather] API 请求异常: ' + (err && err.message));
        return null;
    }
}

/** 城市地理信息查询（Geo API） */
export async function lookupCity(env, cityName, fetchImpl = fetch, nowMs = Date.now()) {
    const raw = String(cityName || '').trim();
    if (!raw) return null;
    const cleanCity = raw.replace(/[省市县区旗州]$/, '');
    const url = 'https://geoapi.qweather.com/v2/city/lookup?location=' + encodeURIComponent(cleanCity);
    const data = await fetchQWeather(env, url, fetchImpl, nowMs);
    if (!data || !Array.isArray(data.location) || !data.location.length) return null;
    const loc = data.location[0];
    return { id: loc.id, name: loc.name, adm1: loc.adm1, adm2: loc.adm2 };
}

/** 完整抓取 24 小时预报、3 天预报、气象预警和生活指数 */
export async function fetchFullWeatherData(env, locationId, fetchImpl = fetch, nowMs = Date.now()) {
    const host = env.QWEATHER_API_HOST || 'devapi.qweather.com';
    const base = 'https://' + host + '/v7';
    const [h24, d3, warning, indices] = await Promise.all([
        fetchQWeather(env, base + '/weather/24h?location=' + locationId, fetchImpl, nowMs),
        fetchQWeather(env, base + '/weather/3d?location=' + locationId, fetchImpl, nowMs),
        fetchQWeather(env, base + '/weather/warning/now?location=' + locationId, fetchImpl, nowMs),
        fetchQWeather(env, base + '/indices/1d?type=3,5&location=' + locationId, fetchImpl, nowMs)
    ]);
    return {
        hourly: (h24 && Array.isArray(h24.hourly)) ? h24.hourly : [],
        daily: (d3 && Array.isArray(d3.daily)) ? d3.daily : [],
        warning: (warning && Array.isArray(warning.warning)) ? warning.warning : [],
        indices: (indices && Array.isArray(indices.daily)) ? indices.daily : []
    };
}

/** 智能气象与温差数学分析器 */
export function analyzeWeatherData(data, yesterday) {
    const hourly = data.hourly || [];
    const daily = data.daily || [];
    const today = daily[0] || {};

    let maxTemp = -999;
    let maxTime = '';
    let minTemp = 999;
    let minTime = '';
    const rainHours = [];

    for (const h of hourly) {
        const t = Number(h.temp);
        const hourStr = String(h.fxTime || '').slice(11, 16);
        if (t > maxTemp) { maxTemp = t; maxTime = hourStr; }
        if (t < minTemp) { minTemp = t; minTime = hourStr; }
        const p = Number(h.precip || 0);
        const isRain = p > 0 || /雨|雪/.test(h.text || '');
        if (isRain) {
            rainHours.push({ hour: hourStr, precip: p, text: h.text || '降水' });
        }
    }

    if (today.tempMax != null && (maxTemp === -999 || Number(today.tempMax) > maxTemp)) {
        maxTemp = Number(today.tempMax);
        if (!maxTime) maxTime = '白天';
    }
    if (today.tempMin != null && (minTemp === 999 || Number(today.tempMin) < minTemp)) {
        minTemp = Number(today.tempMin);
        if (!minTime) minTime = '夜间';
    }

    let rainSummary = '';
    let rainIntensity = '小雨';
    if (rainHours.length > 0) {
        const start = rainHours[0].hour;
        const end = rainHours[rainHours.length - 1].hour;
        const maxPrecip = Math.max(...rainHours.map(r => r.precip));
        if (maxPrecip >= 10 || rainHours.some(r => /大雨|暴雨/.test(r.text))) rainIntensity = '大到暴雨';
        else if (maxPrecip >= 3 || rainHours.some(r => /中雨/.test(r.text))) rainIntensity = '中雨';
        rainSummary = (start === end ? `${start} 前后` : `${start}～${end}`) + `有${rainIntensity}`;
    }

    const warnings = (data.warning || []).map(w => ({
        title: w.title || '',
        type: w.typeName || '',
        level: w.level || '',
        text: w.text || ''
    }));

    let uvIndex = Number(today.uvIndex || 0);
    let uvCategory = '';
    for (const ind of data.indices || []) {
        if (ind.type === '5') {
            uvIndex = Number(ind.level || uvIndex);
            uvCategory = ind.category || '';
        }
    }

    const diurnalRange = (maxTemp > -900 && minTemp < 900) ? (maxTemp - minTemp) : 0;
    const diffMax = yesterday ? (maxTemp - Number(yesterday.temp_max)) : 0;
    const diffMin = yesterday ? (minTemp - Number(yesterday.temp_min)) : 0;

    const hasRain = rainHours.length > 0;
    const hasWarning = warnings.length > 0;
    const hasBigChange = Math.abs(diffMax) >= 3 || Math.abs(diffMin) >= 3;
    const hasHugeChange = Math.abs(diffMax) >= 5 || Math.abs(diffMin) >= 5;
    const hasBigDiurnal = diurnalRange >= 8;
    const hasStrongUv = uvIndex >= 3;

    // 8:00 晨报门禁判定：有雨、有气象预警、较昨日温差≥3℃、昼夜温差≥8℃、紫外线强才触发
    const shouldNotify = hasRain || hasWarning || hasBigChange || hasBigDiurnal || hasStrongUv;

    return {
        maxTemp, maxTime, minTemp, minTime,
        textDay: today.textDay || (hourly[0] && hourly[0].text) || '多云',
        rainSummary, rainIntensity, hasRain,
        warnings, hasWarning,
        uvIndex, uvCategory, hasStrongUv,
        diurnalRange, hasBigDiurnal,
        diffMax, diffMin, hasBigChange, hasHugeChange,
        shouldNotify
    };
}

/** 格式化老友口吻的天气关怀晨报 */
export function formatWeatherMessage(cityName, a, isMorning = false) {
    const lines = [];
    if (isMorning) lines.push(`早！${cityName}今天${a.textDay}，气温 ${a.minTemp}～${a.maxTemp}℃：`);
    else lines.push(`【${cityName}天气】今天${a.textDay}，气温 ${a.minTemp}～${a.maxTemp}℃：`);

    lines.push(`- 最高温 ${a.maxTemp}℃ 预计出现在 ${a.maxTime}，最低温 ${a.minTemp}℃ 预计出现在 ${a.minTime}；`);

    if (a.hasHugeChange) {
        const trend = a.diffMax >= 5 ? `升温了 ${a.diffMax}℃，注意及时减衣防热` : `暴跌了 ${Math.abs(a.diffMax)}℃，降温剧烈一定要多添一件外套！`;
        lines.push(`- 较昨日气温${trend}；`);
    } else if (a.hasBigChange) {
        const trend = a.diffMax >= 3 ? `升温了 ${a.diffMax}℃` : `降温了 ${Math.abs(a.diffMax)}℃`;
        lines.push(`- 较昨日${trend}，体感温差明显；`);
    }

    if (a.hasBigDiurnal) {
        lines.push(`- 昼夜温差达 ${a.diurnalRange}℃，早晚偏凉中午较热，建议洋葱式穿搭；`);
    }

    if (a.hasRain) {
        lines.push(`- 降雨提醒：预计 ${a.rainSummary}，出门记得备好雨具！`);
    } else {
        lines.push(`- 今天全天无雨，适合出行；`);
    }

    if (a.hasWarning) {
        const warnTitles = a.warnings.map(w => w.title || (w.type + w.level)).join('、');
        lines.push(`- ⚠️ 气象预警生效中：${warnTitles}，注意出行安全。`);
    }

    if (a.hasStrongUv) {
        lines.push(`- 紫外线偏强（${a.uvIndex}级 ${a.uvCategory}），户外活动注意防晒防紫外线。`);
    }

    return lines.join('\n');
}

/** 东八区今日与昨日日期 */
export function east8Dates(nowMs = Date.now()) {
    const shifted = nowMs + 8 * 3600 * 1000;
    const today = new Date(shifted).toISOString().slice(0, 10);
    const yesterday = new Date(shifted - 86400000).toISOString().slice(0, 10);
    return { today, yesterday };
}

/** 获取常住城市（优先读用户档案常住地，默认福州） */
export async function resolveUserCity(db, userId, text = '') {
    const m = String(text || '').match(/(?:北京|上海|广州|深圳|福州|厦门|杭州|南京|成都|武汉|西安|重庆|长沙|天津|青岛|大连|沈阳|哈尔滨|苏州|无锡|常州|宁波|合肥|南昌|郑州|贵阳|昆明|海口|三亚|台北|香港|澳门|[^\s，,。！？?]{2,6}(?:市|区|县))/);
    if (m) return m[0].replace(/[市区县]$/, '');
    if (db && userId) {
        try {
            const items = await listProfile(db, userId);
            for (const it of items) {
                const s = (it.label || '') + (it.content || '');
                const matchCity = s.match(/(?:现居|常住地|家在|位于|城市)[：:\s]*([^\s，,。]{2,8})/);
                if (matchCity) return matchCity[1].replace(/[市区县]$/, '');
            }
        } catch (_) {}
    }
    return '福州';
}

/** 惰性确保 bot_weather_daily 表存在（即使远程尚未执行 migrations 也立即可用） */
async function ensureWeatherTable(db) {
    if (!db) return;
    try {
        await db.prepare(`CREATE TABLE IF NOT EXISTS bot_weather_daily (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            city TEXT NOT NULL,
            date TEXT NOT NULL,
            temp_max INTEGER NOT NULL,
            temp_min INTEGER NOT NULL,
            max_time TEXT DEFAULT '',
            min_time TEXT DEFAULT '',
            rain_summary TEXT DEFAULT '',
            uv_index INTEGER DEFAULT 0,
            warning_text TEXT DEFAULT '',
            notified INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now', '+8 hours')),
            UNIQUE(user_id, date)
        )`).run();
    } catch (_) {}
}

/** 每天早上 8:00 执行的智能晨报关怀 */
export async function runMorningWeatherCare(env, db, fetchImpl = fetch, options = {}) {
    const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
    if (!db || !env) return { state: 'no-env' };
    const auth = await getQWeatherToken(env, nowMs);
    if (!auth) return { state: 'no-auth' };
    await ensureWeatherTable(db);

    const { today, yesterday } = east8Dates(nowMs);
    let accounts = [];
    try {
        const res = await db.prepare(
            "SELECT * FROM bot_claw_accounts WHERE is_deleted = 0 AND status = 'bound' AND outreach_enabled = 1 ORDER BY id LIMIT 5"
        ).all();
        accounts = (res && res.results) || [];
    } catch (err) {
        return { state: 'error' };
    }

    const summary = { checked: 0, notified: 0, silent: 0 };
    for (const acct of accounts) {
        summary.checked++;
        const city = await resolveUserCity(db, acct.user_id);
        const cityInfo = await lookupCity(env, city, fetchImpl, nowMs);
        if (!cityInfo) continue;

        // 读昨日记录
        let yRow = null;
        try {
            yRow = await db.prepare(
                'SELECT temp_max, temp_min FROM bot_weather_daily WHERE user_id = ?1 AND date = ?2'
            ).bind(acct.user_id, yesterday).first();
        } catch (_) {}

        // 抓取并分析今日
        const raw = await fetchFullWeatherData(env, cityInfo.id, fetchImpl, nowMs);
        const a = analyzeWeatherData(raw, yRow);

        // 写入今日基准记录
        await db.prepare(
            `INSERT INTO bot_weather_daily (user_id, city, date, temp_max, temp_min, max_time, min_time, rain_summary, uv_index, warning_text, notified)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)
             ON CONFLICT(user_id, date) DO UPDATE SET
             temp_max = excluded.temp_max, temp_min = excluded.temp_min, max_time = excluded.max_time, min_time = excluded.min_time,
             rain_summary = excluded.rain_summary, uv_index = excluded.uv_index, warning_text = excluded.warning_text`
        ).bind(
            acct.user_id, city, today, a.maxTemp, a.minTemp, a.maxTime, a.minTime,
            a.rainSummary || '', a.uvIndex || 0, (a.warnings.map(w => w.title).join(';')) || ''
        ).run();

        // 门禁判定：无事不扰
        if (!a.shouldNotify) {
            summary.silent++;
            console.log(`[weather] 8:00 ${city} 天气平稳舒适，按准则保持静默 user=${acct.user_id}`);
            continue;
        }

        const msg = formatWeatherMessage(city, a, true);
        try {
            await sendClawText({
                token: acct.bot_token,
                baseurl: acct.baseurl,
                botId: acct.ilink_bot_id,
                toUserId: acct.ilink_user_id,
                contextToken: acct.last_context_token || '',
                text: msg,
                fetchImpl
            });
            await saveChatTurn(db, acct.user_id, 'assistant', msg);
            await db.prepare('UPDATE bot_weather_daily SET notified = 1 WHERE user_id = ?1 AND date = ?2').bind(acct.user_id, today).run();
            summary.notified++;
            console.log(`[weather] 8:00 已向 user=${acct.user_id} 发送天气关怀晨报`);
        } catch (err) {
            console.error(`[weather] 晨报推送失败 user=${acct.user_id}: ` + (err && err.message));
        }
    }
    return summary;
}

const WEATHER_QUERY_RE = /(?:天气|气温|温度|下雨|带伞|降温|升温|冷不冷|热不热|多少度|几度|有雨吗|会下雨吗|晴天|阴天|刮风)/;

export function isWeatherQuery(text) {
    const s = String(text || '').trim();
    if (!s || s.length > 50) return false;
    return WEATHER_QUERY_RE.test(s);
}

/** 白天用户主动询问天气时的秒级回答 */
export async function maybeWeatherAnswer(env, db, userId, text, fetchImpl = fetch, nowMs = Date.now()) {
    if (!isWeatherQuery(text)) return null;
    const auth = await getQWeatherToken(env, nowMs);
    if (!auth) return null;

    const city = await resolveUserCity(db, userId, text);
    const cacheKey = `${city}:${east8Dates(nowMs).today}`;
    const cached = weatherCache.get(cacheKey);
    if (cached && nowMs < cached.exp) return cached.reply;

    const cityInfo = await lookupCity(env, city, fetchImpl, nowMs);
    if (!cityInfo) return null;

    const { yesterday } = east8Dates(nowMs);
    let yRow = null;
    if (db && userId) {
        await ensureWeatherTable(db);
        try {
            yRow = await db.prepare(
                'SELECT temp_max, temp_min FROM bot_weather_daily WHERE user_id = ?1 AND date = ?2'
            ).bind(userId, yesterday).first();
        } catch (_) {}
    }

    const raw = await fetchFullWeatherData(env, cityInfo.id, fetchImpl, nowMs);
    const a = analyzeWeatherData(raw, yRow);
    const reply = formatWeatherMessage(city, a, false);

    weatherCache.set(cacheKey, { reply, exp: nowMs + 30 * 60 * 1000 });
    return reply;
}
