import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Architecture - the Worker gateway stays a thin router (300-line red line)', async () => {
    const source = await fs.readFile(path.join(root, 'workers', 'api.js'), 'utf8');
    const lines = source.split('\n').length;

    assert.ok(
        lines <= 300,
        `workers/api.js is ${lines} lines - AGENTS.md caps the gateway at 300. Move domain logic into workers/src/.`
    );

    // 网关只应编排，不应直接实现领域逻辑：确认各子域模块都被引用
    for (const mod of ['security', 'auth', 'garden', 'ai', 'audit']) {
        assert.ok(
            source.includes(`./src/${mod}.js`),
            `workers/api.js should route through ./src/${mod}.js`
        );
    }
});

test('Architecture - domain modules stay out of the gateway entry file', async () => {
    const source = await fs.readFile(path.join(root, 'workers', 'api.js'), 'utf8');
    // 网关里不应出现 SQL 或 LLM 供应商细节（按代码库的大写 SQL 约定匹配，避免误伤注释散文）
    assert.ok(!/\bINSERT INTO\b|\bDELETE FROM\b|\bUPDATE\s+\w+\s+SET\b|\bSELECT\b[\s\S]{0,80}?\bFROM\b/.test(source), 'gateway must not contain SQL statements');
    assert.ok(!/deepseek|api\.deepseek/i.test(source), 'gateway must not talk to the LLM provider directly');
});

test('Architecture - the gateway exposes a public health probe', async () => {
    const source = await fs.readFile(path.join(root, 'workers', 'api.js'), 'utf8');
    assert.match(source, /\/api\/health/, 'expected a /api/health route');
    // 健康检查必须留在鉴权闸门之前，且不泄露业务数据
    const healthIndex = source.indexOf("'/api/health'");
    const gateIndex = source.indexOf('鉴权闸门');
    assert.ok(healthIndex !== -1 && gateIndex !== -1 && healthIndex < gateIndex, 'health must be a public route');
    assert.ok(!/health[\s\S]{0,400}?FROM (weeklies|notes|quick_feeds|users)/.test(source), 'health must not query business tables');
});
