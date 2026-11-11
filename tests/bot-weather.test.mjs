import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDb, seedUser, sqliteTest } from './fake-d1.mjs';
import {
    base64UrlEncode, pemToDer, getQWeatherToken, lookupCity,
    analyzeWeatherData, formatWeatherMessage, runMorningWeatherCare,
    maybeWeatherAnswer, isWeatherQuery
} from '../workers/src/bot-weather.js';

const integration = sqliteTest;

// 生成一套合法的测试用 Ed25519 私钥/公钥
const testKeyPair = crypto.generateKeyPairSync('ed25519');
const testPrivateKeyPem = testKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' });

function mockWeatherEnv(overrides = {}) {
    return {
        QWEATHER_KEY_ID: 'test-kid-123',
        QWEATHER_PROJECT_ID: 'test-project-456',
        QWEATHER_PRIVATE_KEY: testPrivateKeyPem,
        QWEATHER_API_HOST: 'devapi.qweather.com',
        ...overrides
    };
}

function mockFetch(responses) {
    const calls = [];
    const impl = async (urlStr, init = {}) => {
        calls.push({ url: urlStr, init });
        for (const [pattern, res] of Object.entries(responses)) {
            if (urlStr.includes(pattern)) {
                return new Response(JSON.stringify(res), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }
        return new Response('{"code":"404"}', { status: 404 });
    };
    return { impl, calls };
}

test('base64UrlEncode 与 pemToDer 编码转换正确', () => {
    const raw = 'Hello World?&=+';
    const b64 = base64UrlEncode(raw);
    assert.ok(!b64.includes('+'));
    assert.ok(!b64.includes('/'));
    assert.ok(!b64.includes('='));

    const der = pemToDer(testPrivateKeyPem);
    assert.ok(der instanceof Uint8Array);
    assert.ok(der.length > 30);
});

test('Ed25519 JWT 生成并支持内存缓存', async () => {
    const env = mockWeatherEnv();
    const tokenObj = await getQWeatherToken(env);
    assert.equal(tokenObj.type, 'bearer');
    assert.ok(tokenObj.token.startsWith('eyJ'));
    const parts = tokenObj.token.split('.');
    assert.equal(parts.length, 3);

    // 验证 header 包含 EdDSA 和 kid
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    assert.equal(header.alg, 'EdDSA');
    assert.equal(header.kid, 'test-kid-123');

    // 验证 payload 包含 sub
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    assert.equal(payload.sub, 'test-project-456');

    // 二次获取走缓存
    const cached = await getQWeatherToken(env);
    assert.equal(cached.token, tokenObj.token);
});

test('支持传统 API Key 降级认证', async () => {
    const env = { QWEATHER_KEY: 'legacy-api-key-32chars' };
    const auth = await getQWeatherToken(env);
    assert.equal(auth.type, 'key');
    assert.equal(auth.token, 'legacy-api-key-32chars');
});

test('analyzeWeatherData 精准提取最高温、最低温出现时刻及降雨区间', () => {
    const raw = {
        hourly: [
            { fxTime: '2026-11-11T05:00+08:00', temp: '16', precip: '0.0', text: '多云' },
            { fxTime: '2026-11-11T08:00+08:00', temp: '19', precip: '0.0', text: '阴' },
            { fxTime: '2026-11-11T14:00+08:00', temp: '26', precip: '0.0', text: '多云' },
            { fxTime: '2026-11-11T16:00+08:00', temp: '24', precip: '3.5', text: '中雨' },
            { fxTime: '2026-11-11T18:00+08:00', temp: '22', precip: '1.2', text: '小雨' }
        ],
        daily: [
            { fxDate: '2026-11-11', tempMax: '26', tempMin: '16', textDay: '多云转小雨', uvIndex: '2' }
        ],
        warning: [],
        indices: [{ type: '5', level: '2', category: '弱' }]
    };

    const yesterday = { temp_max: 31, temp_min: 20 }; // 昨天 31℃，今天 26℃，大跌 5℃
    const a = analyzeWeatherData(raw, yesterday);

    assert.equal(a.maxTemp, 26);
    assert.equal(a.maxTime, '14:00');
    assert.equal(a.minTemp, 16);
    assert.equal(a.minTime, '05:00');
    assert.equal(a.hasRain, true);
    assert.match(a.rainSummary, /16:00～18:00/);
    assert.equal(a.diffMax, -5); // 较昨日暴跌 5℃
    assert.equal(a.hasHugeChange, true);
    assert.equal(a.diurnalRange, 10); // 昼夜温差 10℃
    assert.equal(a.hasBigDiurnal, true);
    assert.equal(a.shouldNotify, true);

    const msg = formatWeatherMessage('福州', a, true);
    assert.match(msg, /最高温 26℃ 预计出现在 14:00/);
    assert.match(msg, /最低温 16℃ 预计出现在 05:00/);
    assert.match(msg, /暴跌了 5℃/);
    assert.match(msg, /昼夜温差达 10℃/);
    assert.match(msg, /16:00～18:00.*出门记得备好雨具/);
});

test('8:00 晨报门禁判定：天气平稳舒适时保持静默（shouldNotify = false）', () => {
    const raw = {
        hourly: [
            { fxTime: '2026-11-11T05:00+08:00', temp: '20', precip: '0.0', text: '多云' },
            { fxTime: '2026-11-11T14:00+08:00', temp: '25', precip: '0.0', text: '晴' }
        ],
        daily: [
            { fxDate: '2026-11-11', tempMax: '25', tempMin: '20', textDay: '晴', uvIndex: '2' }
        ],
        warning: [],
        indices: [{ type: '5', level: '2', category: '弱' }]
    };
    // 昨天 24℃，今天 25℃，温差 1℃（< 3℃），昼夜温差 5℃（< 8℃），无雨无预警
    const yesterday = { temp_max: 24, temp_min: 19 };
    const a = analyzeWeatherData(raw, yesterday);

    assert.equal(a.hasRain, false);
    assert.equal(a.hasWarning, false);
    assert.equal(a.hasBigChange, false);
    assert.equal(a.hasBigDiurnal, false);
    assert.equal(a.hasStrongUv, false);
    assert.equal(a.shouldNotify, false, '舒适天气必须保持静默，不发推送');
});

test('isWeatherQuery 准确识别天气意图', () => {
    assert.equal(isWeatherQuery('今天天气怎么样'), true);
    assert.equal(isWeatherQuery('福州会下雨吗'), true);
    assert.equal(isWeatherQuery('外面几度'), true);
    assert.equal(isWeatherQuery('明天冷不冷'), true);
    assert.equal(isWeatherQuery('下午出门要带伞吗'), true);
    assert.equal(isWeatherQuery('今天写完周记'), false);
    assert.equal(isWeatherQuery(''), false);
});

integration('runMorningWeatherCare 在平稳天气下记录数据并保持静默', async () => {
    const db = await createTestDb();
    await seedUser(db, 1);
    await db.prepare(
        "INSERT INTO bot_claw_accounts (user_id, status, bot_token, baseurl, ilink_bot_id, ilink_user_id, cursor, bound_at_ms, is_deleted, outreach_enabled) VALUES (1, 'bound', 'token', 'https://ilink', 'bot', 'user', '', 0, 0, 1)"
    ).run();

    const fetcher = mockFetch({
        '/v2/city/lookup': { code: '200', location: [{ id: '101230101', name: '福州', adm1: '福建省' }] },
        '/weather/24h': { code: '200', hourly: [{ fxTime: '2026-11-11T14:00+08:00', temp: '22', precip: '0.0', text: '多云' }] },
        '/weather/3d': { code: '200', daily: [{ fxDate: '2026-11-11', tempMax: '22', tempMin: '18', textDay: '多云', uvIndex: '2' }] },
        '/weather/warning/now': { code: '200', warning: [] },
        '/indices/1d': { code: '200', daily: [] }
    });

    const env = mockWeatherEnv();
    const res = await runMorningWeatherCare(env, db, fetcher.impl, { nowMs: Date.parse('2026-11-11T08:00:00+08:00') });
    assert.equal(res.checked, 1);
    assert.equal(res.silent, 1);
    assert.equal(res.notified, 0);

    const row = await db.prepare('SELECT * FROM bot_weather_daily WHERE user_id = 1').first();
    assert.equal(row.city, '福州');
    assert.equal(row.notified, 0);
});

integration('runMorningWeatherCare 在降雨或大温差时向微信发送晨报', async () => {
    const db = await createTestDb();
    await seedUser(db, 1);
    await db.prepare(
        "INSERT INTO bot_claw_accounts (user_id, status, bot_token, baseurl, ilink_bot_id, ilink_user_id, cursor, bound_at_ms, is_deleted, outreach_enabled) VALUES (1, 'bound', 'token', 'https://ilink', 'bot', 'user', '', 0, 0, 1)"
    ).run();

    // 昨天记录：最高 30℃
    await db.prepare(
        "INSERT INTO bot_weather_daily (user_id, city, date, temp_max, temp_min, notified) VALUES (1, '福州', '2026-11-10', 30, 20, 0)"
    ).run();

    const fetcher = mockFetch({
        '/v2/city/lookup': { code: '200', location: [{ id: '101230101', name: '福州', adm1: '福建省' }] },
        '/weather/24h': {
            code: '200',
            hourly: [
                { fxTime: '2026-11-11T05:00+08:00', temp: '15', precip: '0.0', text: '阴' },
                { fxTime: '2026-11-11T14:00+08:00', temp: '22', precip: '4.0', text: '中雨' }
            ]
        },
        '/weather/3d': { code: '200', daily: [{ fxDate: '2026-11-11', tempMax: '22', tempMin: '15', textDay: '中雨', uvIndex: '1' }] },
        '/weather/warning/now': { code: '200', warning: [] },
        '/indices/1d': { code: '200', daily: [] },
        '/ilink/bot/sendmessage': { ret: 0 }
    });

    const env = mockWeatherEnv();
    const res = await runMorningWeatherCare(env, db, fetcher.impl, { nowMs: Date.parse('2026-11-11T08:00:00+08:00') });
    assert.equal(res.checked, 1);
    assert.equal(res.notified, 1);

    const turns = await db.prepare('SELECT role, content FROM bot_chat_turns WHERE user_id = 1').all();
    assert.equal(turns.results.length, 1);
    assert.match(turns.results[0].content, /暴跌了 8℃/);
    assert.match(turns.results[0].content, /中雨.*出门记得备好雨具/);

    const row = await db.prepare("SELECT * FROM bot_weather_daily WHERE user_id = 1 AND date = '2026-11-11'").first();
    assert.equal(row.notified, 1);
});

integration('maybeWeatherAnswer 白天随手查天气秒回', async () => {
    const db = await createTestDb();
    await seedUser(db, 1);
    const fetcher = mockFetch({
        '/v2/city/lookup': { code: '200', location: [{ id: '101230101', name: '福州', adm1: '福建省' }] },
        '/weather/24h': { code: '200', hourly: [{ fxTime: '2026-11-11T14:00+08:00', temp: '23', precip: '0.0', text: '多云' }] },
        '/weather/3d': { code: '200', daily: [{ fxDate: '2026-11-11', tempMax: '23', tempMin: '17', textDay: '多云', uvIndex: '2' }] },
        '/weather/warning/now': { code: '200', warning: [] },
        '/indices/1d': { code: '200', daily: [] }
    });

    const env = mockWeatherEnv();
    const reply = await maybeWeatherAnswer(env, db, 1, '今天福州天气怎么样', fetcher.impl);
    assert.match(reply, /【福州天气】今天多云/);
    assert.match(reply, /17～23℃/);
});
