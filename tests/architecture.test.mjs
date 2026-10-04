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
    for (const mod of ['security', 'auth', 'garden-shared', 'garden-media', 'garden-resources', 'garden-sync', 'garden-echo', 'ai', 'audit']) {
        assert.ok(
            source.includes(`./src/${mod}.js`),
            `workers/api.js should route through ./src/${mod}.js`
        );
    }
});

test('Architecture - no domain module grows past 500 lines', async () => {
    const dir = path.join(root, 'workers', 'src');
    for (const file of (await fs.readdir(dir)).filter((f) => f.endsWith('.js'))) {
        const text = await fs.readFile(path.join(dir, file), 'utf8');
        const count = text.split('\n').length;
        assert.ok(count <= 500, `workers/src/${file} is ${count} lines - split it before it becomes another 999-line garden.js`);
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

test('Architecture - frontend modules have valid imports and no undeclared function calls', async () => {
    const jsDir = path.join(root, 'public', 'js');
    const files = (await fs.readdir(jsDir)).filter((f) => f.endsWith('.js'));
    const allModulePaths = [...files.map((f) => path.join(jsDir, f)), path.join(root, 'public', 'app.js')];

    const allExports = new Set();
    for (const f of allModulePaths) {
        const content = await fs.readFile(f, 'utf8');
        for (const m of content.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var)\s+([a-zA-Z0-9_$]+)/g)) {
            allExports.add(m[1]);
        }
        for (const eb of content.matchAll(/export\s*\{([^}]+)\}/g)) {
            for (const item of eb[1].split(',')) {
                const name = item.trim().split(/\s+as\s+/)[0].trim();
                if (name) allExports.add(name);
            }
        }
    }

    for (const f of allModulePaths) {
        const rawContent = await fs.readFile(f, 'utf8');
        // Strip comments and string literals so words in prose/templates aren't mistaken for function calls
        const content = rawContent
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*/g, '')
            .replace(/'(?:\\.|[^'\\])*'/g, "''")
            .replace(/"(?:\\.|[^"\\])*"/g, '""');
        const rel = path.relative(root, f).replace(/\\/g, '/');
        for (const exp of allExports) {
            const callRegex = new RegExp(`\\b${exp}\\s*\\(`, 'g');
            let match;
            while ((match = callRegex.exec(content)) !== null) {
                const idx = match.index;
                if (idx > 0 && content[idx - 1] === '.') continue;
                const isImported = new RegExp(`import\\s*\\{[^}]*\\b${exp}\\b[^}]*\\}`).test(content);
                const isDynamicImported = new RegExp(`\\b${exp}\\b[^;\\n]*=\\s*(?:await\\s+)?import\\(`).test(content);
                const isDeclared = new RegExp(`(?:function|const|let|var)\\s+${exp}\\b`).test(content);
                assert.ok(
                    isImported || isDynamicImported || isDeclared,
                    `Frontend file ${rel} calls "${exp}()" without importing or declaring it!`
                );
            }
        }
    }
});
