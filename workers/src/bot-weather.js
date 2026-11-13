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
import { listProfile, saveChatTurn } from './bot-memory.js';

let cachedJwt = null;
let cachedJwtExp = 0;
const weatherCache = new Map(); // city -> { data, exp }

/** Base64URL 编码（RFC 7515） */
export function base64UrlEncode(bytesOrStr) {
    const bytes = typeof bytesOrStr === 'string' ? new TextEncoder().encode(bytesOrStr) : (bytesOrStr instanceof Uint8Array ? bytesOrStr : new Uint8Array(bytesOrStr));
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PEM 格式私钥转 Uint8Array DER（兼容标准 PKCS#8 与 32 字节 Raw 裸私钥） */
export function pemToDer(pem) {
    const b64 = String(pem || '').replace(/-----[^\n]+-----|\s+/g, '');
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    if (buf.length === 32) {
        const full = new Uint8Array(48);
        full.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20], 0);
        full.set(buf, 16);
        return full;
    }
    return buf;
}

/** 生成和风天气 Ed25519 JWT 凭据（有效时长 1 小时，内存缓存 50 分钟） */
export async function getQWeatherToken(env, nowMs = Date.now()) {
    if (!env) return null;
    const keyId = env.QWEATHER_KEY_ID || env.KEY_ID || env['Key ID'] || env['凭据ID'] || env['凭据'] || env.QWEATHER_KID;
    const projectId = env.QWEATHER_PROJECT_ID || env.PROJECT_ID || env['Project ID'] || env['项目ID'] || env.QWEATHER_SUB || '45E5WDY7H8';
    const privKeyPem = env.QWEATHER_PRIVATE_KEY || env.PRIVATE_KEY || env['私钥'] || env.QWEATHER_PRIV_KEY || env.QWEATHER_SECRET;

    if (keyId && projectId && privKeyPem) {
        if (cachedJwt && nowMs < cachedJwtExp) return { type: 'bearer', token: cachedJwt };
        try {
            const der = pemToDer(privKeyPem);
            const key = await globalThis.crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
            const nowSec = Math.floor(nowMs / 1000);
            const header = { alg: 'EdDSA', kid: keyId };
            const iss = env.QWEATHER_DEVELOPER_ID || env.DEVELOPER_ID || env.QWEATHER_ISS || env['开发者ID'] || 'Q9838E560C';
            const payload = { sub: projectId, iat: nowSec - 30, exp: nowSec + 3600, iss };
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

let lastApiError = '';

/** 发起和风天气 API 请求 */
export async function fetchQWeather(env, urlStr, fetchImpl = fetch, nowMs = Date.now()) {
    const auth = await getQWeatherToken(env, nowMs);
    if (!auth) {
        lastApiError = '无有效认证凭据';
        return null;
    }
    const url = new URL(urlStr);
    const headers = { 'Accept-Encoding': 'gzip' };
    if (auth.type === 'bearer') headers['Authorization'] = 'Bearer ' + auth.token;
    else if (auth.type === 'key') headers['X-QW-Api-Key'] = auth.token;
    try {
        const res = await fetchImpl(url.toString(), { headers });
        if (!res.ok) {
            if (res.status === 401) { cachedJwt = null; cachedJwtExp = 0; }
            const body = await res.text().catch(() => '');
            let detail = '';
            try {
                const j = JSON.parse(body);
                detail = j.error ? (j.error.detail || j.error.title || '') : (j.detail || j.message || '');
            } catch (_) { detail = body; }
            lastApiError = `HTTP ${res.status}: ${detail || body}`.slice(0, 100);
            return null;
        }
        const data = await res.json();
        if (data && (data.code === '200' || data.code === 200)) return data;
        lastApiError = `Code ${data ? data.code : 'unknown'}`;
        return null;
    } catch (err) {
        lastApiError = '异常: ' + (err && err.message);
        console.error('[bot-weather] API 请求异常: ' + (err && err.message));
        return null;
    }
}

const DEFAULT_API_HOST = 'kn359j8pjc.re.qweatherapi.com';
const COMMON_CITIES = { '福州': '101230101', '厦门': '101230201', '泉州': '101230501', '漳州': '101230601', '北京': '101010100', '上海': '101020100', '广州': '101280101', '深圳': '101280601', '杭州': '101210101' };

/** 城市地理信息查询（Geo API + 常用城市直出） */
export async function lookupCity(env, cityName, fetchImpl = fetch, nowMs = Date.now()) {
    const raw = String(cityName || '').trim();
    if (!raw) return null;
    const cleanCity = raw.replace(/[省市县区旗]$/, '');
    if (COMMON_CITIES[cleanCity]) return { id: COMMON_CITIES[cleanCity], name: cleanCity, adm1: '', adm2: cleanCity };
    const host = env.QWEATHER_API_HOST || env.API_HOST || DEFAULT_API_HOST;
    const data = await fetchQWeather(env, `https://${host}/geo/v2/city/lookup?location=${encodeURIComponent(cleanCity)}&range=cn`, fetchImpl, nowMs);
    if (!data || !Array.isArray(data.location) || !data.location.length) return null;
    const loc = data.location[0];
    return { id: loc.id, name: loc.name, adm1: loc.adm1, adm2: loc.adm2 };
}

/** 完整抓取 24 小时预报、3 天预报、气象预警和生活指数 */
export async function fetchFullWeatherData(env, locationId, fetchImpl = fetch, nowMs = Date.now()) {
    const host = env.QWEATHER_API_HOST || env.API_HOST || DEFAULT_API_HOST;
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

    let maxTemp = -999, maxTime = '', minTemp = 999, minTime = '';
    const rainHours = [];

    for (const h of hourly) {
        const t = Number(h.temp);
        const hourStr = String(h.fxTime || '').slice(11, 16);
        if (Number.isFinite(t)) {
            if (t > maxTemp) { maxTemp = t; maxTime = hourStr; }
            if (t < minTemp) { minTemp = t; minTime = hourStr; }
        }
        const p = Number(h.precip || 0);
        if ((Number.isFinite(p) && p > 0) || /雨|雪/.test(h.text || '')) {
            rainHours.push({ hour: hourStr, precip: Number.isFinite(p) ? p : 0, text: h.text || '降水' });
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
    if (maxTemp === -999) { maxTemp = 20; maxTime = '白天'; }
    if (minTemp === 999) { minTemp = 15; minTime = '夜间'; }

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
    const hasRain = rainHours.length > 0, hasWarning = warnings.length > 0;
    const hasBigChange = Math.abs(diffMax) >= 3 || Math.abs(diffMin) >= 3;
    const hasHugeChange = Math.abs(diffMax) >= 5 || Math.abs(diffMin) >= 5;
    const hasBigDiurnal = diurnalRange >= 8, hasStrongUv = uvIndex >= 3;

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
    const lines = [isMorning ? `早！${cityName}今天${a.textDay}，气温 ${a.minTemp}～${a.maxTemp}℃：` : `【${cityName}天气】今天${a.textDay}，气温 ${a.minTemp}～${a.maxTemp}℃：`];
    lines.push(`- 最高温 ${a.maxTemp}℃ 预计出现在 ${a.maxTime}，最低温 ${a.minTemp}℃ 预计出现在 ${a.minTime}；`);

    if (a.hasHugeChange) {
        lines.push(`- 较昨日气温${a.diffMax >= 5 ? `升温了 ${a.diffMax}℃，注意及时减衣防热` : `暴跌了 ${Math.abs(a.diffMax)}℃，降温剧烈一定要多添一件外套！`}；`);
    } else if (a.hasBigChange) {
        lines.push(`- 较昨日${a.diffMax >= 3 ? `升温了 ${a.diffMax}℃` : `降温了 ${Math.abs(a.diffMax)}℃`}，体感温差明显；`);
    }

    if (a.hasBigDiurnal) lines.push(`- 昼夜温差达 ${a.diurnalRange}℃，早晚偏凉中午较热，建议洋葱式穿搭；`);
    if (a.hasRain) lines.push(`- 降雨提醒：预计 ${a.rainSummary}，出门记得备好雨具！`);
    else lines.push(`- 今天全天无雨，适合出行；`);
    if (a.hasWarning) lines.push(`- ⚠️ 气象预警生效中：${a.warnings.map(w => w.title || (w.type + w.level)).join('、')}，注意出行安全。`);
    if (a.hasStrongUv) lines.push(`- 紫外线偏强（${a.uvIndex}级 ${a.uvCategory}），户外活动注意防晒防紫外线。`);
    return lines.join('\n');
}

/** 东八区今日与昨日日期 */
export function east8Dates(nowMs = Date.now()) {
    const shifted = nowMs + 8 * 3600 * 1000;
    const today = new Date(shifted).toISOString().slice(0, 10);
    const yesterday = new Date(shifted - 86400000).toISOString().slice(0, 10);
    return { today, yesterday };
}

// 排除非地名通用词（避免将“市区/小区/社区/郊区/超市/县城”等生活通用词误判为城市）
export const GENERIC_CITY_WORDS = new Set(('市区,小区,社区,郊区,景区,校区,园区,厂区,矿区,林区,库区,港区,盲区,误区,灾区,战区,禁区,辖区,全区,片区,跨区,学区,站区,展区,牧区,商区,病区,工区,赛区,开发区,高新区,经开区,保税区,示范区,新区,超市,菜市,夜市,早市,黑市,股市,楼市,汇市,熊市,牛市,开市,闭市,休市,本市,全市,跨市,都市,省市,上市,市面,市中心,县城,全县,本县,跨县,邻县,外县').split(','));

const CITY_PREFIX_RE = /^(?:如果|要是|假如)?(?:我和朋友|我和家人|我们|咱们|我)?(?:今天|明天|后天|大后天|昨天|现在|目前|最近|这几天|随后|本周|周末|周[一二三四五六日天])?(?:帮我|麻烦|请问|请|告诉我)?(?:想|打算|准备)?(?:查一下|查下|查查|查询|搜一下|搜下|搜搜|搜索|看一下|看下|看看|瞧瞧|问一下|问下|问问|知道|了解)?(?:准备去|打算去|计划去|要去|想去|去趟|去|到了|到|在|回|飞往|飞|往|来到|来)?(?:这个|那个|哪个)?/;

const FAMOUS_CITIES_RE = /(?:北京|上海|天津|重庆|福州|厦门|泉州|漳州|莆田|宁德|南平|三明|龙岩|闽侯|连江|长乐|福清|平潭|晋江|石狮|南安|安溪|惠安|广州|深圳|珠海|佛山|东莞|中山|汕头|惠州|杭州|宁波|温州|嘉兴|湖州|绍兴|金华|衢州|舟山|台州|丽水|义乌|南京|无锡|徐州|常州|苏州|南通|连云港|淮安|盐城|扬州|镇江|泰州|宿迁|昆山|合肥|芜湖|蚌埠|黄山|南昌|九江|景德镇|赣州|济南|青岛|淄博|烟台|潍坊|威海|台北|新北|高雄|台中|香港|澳门|武汉|宜昌|襄阳|荆州|长沙|株洲|湘潭|岳阳|张家界|郑州|开封|洛阳|石家庄|唐山|秦皇岛|保定|雄安|太原|大同|呼和浩特|包头|鄂尔多斯|成都|绵阳|乐山|宜宾|贵阳|遵义|昆明|大理|丽江|西双版纳|拉萨|西安|咸阳|延安|汉中|宝鸡|兰州|敦煌|西宁|银川|乌鲁木齐|吐鲁番|喀什|哈尔滨|长春|吉林|延吉|沈阳|大连|南宁|桂林|北海|海口|三亚)/;

/** 从用户提问中解析出城市名（无城市或为通用名词时返回 null） */
export function extractCityFromText(text) {
    const rawText = String(text || '').trim();
    if (!rawText) return null;
    const famousMatch = rawText.match(FAMOUS_CITIES_RE);
    if (famousMatch) return famousMatch[0];

    const suffixMatches = rawText.match(/[^\s，,。！？?]{2,10}(?:新区|[市区县])/g);
    if (suffixMatches) {
        for (const raw of suffixMatches) {
            let candidate = raw.replace(CITY_PREFIX_RE, '').replace(/^[去到在回飞往看查问搜想]+/g, '');
            if (!candidate || GENERIC_CITY_WORDS.has(candidate)) continue;
            const clean = candidate.replace(/(?:新区|[市区县])$/, '');
            if (clean.length >= 2 && clean.length <= 6 && !GENERIC_CITY_WORDS.has(clean)) return clean;
        }
    }
    return null;
}

/** 获取常住城市（优先识别文本地名，次选用户档案常住地，默认福州） */
export async function resolveUserCity(db, userId, text = '') {
    const fromText = extractCityFromText(text);
    if (fromText) return fromText;
    if (db && userId) {
        try {
            const items = await listProfile(db, userId);
            for (const it of items) {
                const s = (it.label || '') + (it.content || '');
                const matchCity = s.match(/(?:现居|居住地|常住地|住址|地址|家在|位于|城市)[：:\s]*([^\s，,。]{2,8})/);
                if (matchCity) {
                    const parsed = extractCityFromText(matchCity[1]) || matchCity[1].replace(/(?:新区|[市区县])$/, '');
                    if (parsed && !GENERIC_CITY_WORDS.has(parsed)) return parsed;
                }
            }
        } catch (_) { /* audit-ignore: intentional-fallback 从用户画像读取城市失败默认降级到福州 */ }
    }
    return '福州';
}

/** 惰性确保 bot_weather_daily 表存在（即使远程尚未执行 migrations 也立即可用） */
async function ensureWeatherTable(db) {
    if (!db) return;
    try {
        await db.prepare('CREATE TABLE IF NOT EXISTS bot_weather_daily (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, city TEXT NOT NULL, date TEXT NOT NULL, temp_max INTEGER NOT NULL, temp_min INTEGER NOT NULL, max_time TEXT DEFAULT "", min_time TEXT DEFAULT "", rain_summary TEXT DEFAULT "", uv_index INTEGER DEFAULT 0, warning_text TEXT DEFAULT "", notified INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime("now", "+8 hours")), UNIQUE(user_id, date))').run();
    } catch (_) { /* audit-ignore: intentional-fallback 幂等创建天气日表失败忽略 */ }
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
        const res = await db.prepare("SELECT * FROM bot_claw_accounts WHERE is_deleted = 0 AND status = 'bound' AND outreach_enabled = 1 ORDER BY id LIMIT 5").all();
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

        // 读今日记录：若今日已发送过晨报，避免重复推送（幂等保证）
        let todayRow = null;
        try {
            todayRow = await db.prepare('SELECT notified FROM bot_weather_daily WHERE user_id = ?1 AND date = ?2').bind(acct.user_id, today).first();
        } catch (_) { /* audit-ignore: intentional-fallback 查询今日记录异常按未推送处理 */ }
        if (todayRow && todayRow.notified === 1) {
            summary.silent++;
            continue;
        }

        // 读昨日记录
        let yRow = null;
        try {
            yRow = await db.prepare('SELECT temp_max, temp_min FROM bot_weather_daily WHERE user_id = ?1 AND date = ?2').bind(acct.user_id, yesterday).first();
        } catch (_) { /* audit-ignore: intentional-fallback 查询昨日温差基准异常跳过温差对比 */ }

        // 抓取并分析今日
        const raw = await fetchFullWeatherData(env, cityInfo.id, fetchImpl, nowMs);
        const a = analyzeWeatherData(raw, yRow);

        // 写入今日基准记录
        await db.prepare(
            `INSERT INTO bot_weather_daily (user_id, city, date, temp_max, temp_min, max_time, min_time, rain_summary, uv_index, warning_text, notified)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0) ON CONFLICT(user_id, date) DO UPDATE SET
             temp_max = excluded.temp_max, temp_min = excluded.temp_min, max_time = excluded.max_time, min_time = excluded.min_time,
             rain_summary = excluded.rain_summary, uv_index = excluded.uv_index, warning_text = excluded.warning_text`
        ).bind(acct.user_id, city, today, a.maxTemp, a.minTemp, a.maxTime, a.minTime, a.rainSummary || '', a.uvIndex || 0, (a.warnings.map(w => w.title).join(';')) || '').run();

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

const WEATHER_QUERY_RE = /(?:天气|气温|温度|下雨|带伞|降温|升温|冷不冷|热不热|冷吗|热吗|多少度|几度|有雨吗|会下雨吗|晴天|阴天|刮风|防晒|紫外线)/;

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
            yRow = await db.prepare('SELECT temp_max, temp_min FROM bot_weather_daily WHERE user_id = ?1 AND date = ?2').bind(userId, yesterday).first();
        } catch (_) { /* audit-ignore: intentional-fallback 读取昨日温度对比基准异常降级跳过 */ }
    }

    const raw = await fetchFullWeatherData(env, cityInfo.id, fetchImpl, nowMs);
    const a = analyzeWeatherData(raw, yRow);
    const reply = formatWeatherMessage(city, a, false);

    if (weatherCache.size > 30) weatherCache.clear();
    weatherCache.set(cacheKey, { reply, exp: nowMs + 30 * 60 * 1000 });
    return reply;
}

/** 天气服务诊断工具：排查变量配置、密钥签名与 API 联通性 */
export async function diagnoseWeatherConfig(env, db, userId, fetchImpl = fetch, nowMs = Date.now()) {
    const keyId = env.QWEATHER_KEY_ID || env.KEY_ID || env['Key ID'] || env['凭据ID'] || env['凭据'] || env.QWEATHER_KID;
    const projectId = env.QWEATHER_PROJECT_ID || env.PROJECT_ID || env['Project ID'] || env['项目ID'] || env.QWEATHER_SUB || '45E5WDY7H8';
    const privKey = env.QWEATHER_PRIVATE_KEY || env.PRIVATE_KEY || env['私钥'] || env.QWEATHER_PRIV_KEY || env.QWEATHER_SECRET;
    const host = env.QWEATHER_API_HOST || env.API_HOST || DEFAULT_API_HOST;
    const iss = env.QWEATHER_DEVELOPER_ID || env.DEVELOPER_ID || env.QWEATHER_ISS || env['开发者ID'] || 'Q9838E560C';
    const apiKey = env.QWEATHER_KEY;

    const lines = ['【和风天气诊断报告】'];
    if (apiKey) {
        lines.push(`• 模式: 普通 API Key (尾号 ${String(apiKey).slice(-4)})`);
    } else {
        lines.push(`• 模式: Ed25519 JWT`);
        lines.push(`• Key ID: ${keyId ? `已配置 (尾号 ${String(keyId).slice(-4)})` : '❌ 未检测到'}`);
        lines.push(`• 凭据: Project ${String(projectId || '').slice(-4)}, 开发者 ${String(iss || '').slice(-4)}, 私钥长 ${String(privKey || '').length}`);
    }
    lines.push(`• API Host: ${host}`);

    if (!apiKey && (!keyId || !projectId || !privKey)) {
        lines.push('\n⚠️ 凭据不完整。请在 Cloudflare 环境变量中添加：\n1. 普通 API Key: QWEATHER_KEY\n2. 或 JWT: QWEATHER_KEY_ID、QWEATHER_PROJECT_ID 与 QWEATHER_PRIVATE_KEY');
        return lines.join('\n');
    }

    try {
        const tokenResult = await getQWeatherToken(env, nowMs);
        if (!tokenResult || !tokenResult.token) {
            lines.push('• 凭据签发: ❌ 签发失败（私钥格式可能无效）');
            return lines.join('\n');
        }
        lines.push(tokenResult.type === 'bearer' ? '• Ed25519 签名: ✅ 签发成功' : '• API Key: ✅ 准备就绪');

        const city = await resolveUserCity(db, userId);
        lines.push(`• 目标城市: ${city}`);
        const cityInfo = await lookupCity(env, city, fetchImpl, nowMs);
        if (!cityInfo) {
            lines.push(`• 城市解析: ❌ 无法查到 ${city} (${lastApiError || '请求失败'})`);
            return lines.join('\n');
        }
        lines.push(`• 城市解析: ✅ 成功 (Location ID: ${cityInfo.id})`);

        const raw = await fetchFullWeatherData(env, cityInfo.id, fetchImpl, nowMs);
        if (!raw.hourly.length && !raw.daily.length) {
            lines.push(`• 天气数据: ❌ 未拉取到预报 (${lastApiError || '返回为空'})`);
            if (tokenResult.type === 'bearer') {
                lines.push('• 凭据校验: Ed25519 Token 签发正常（已脱敏隐藏）');
            }
        } else {
            lines.push(`• 天气数据: ✅ 正常获取 (${raw.hourly.length} 小时预报, 气温 ${raw.daily[0]?.tempMin || ''}~${raw.daily[0]?.tempMax || ''}℃)`);
        }
    } catch (err) {
        lines.push(`• 异常信息: ${err && err.message}`);
    }
    return lines.join('\n');
}
