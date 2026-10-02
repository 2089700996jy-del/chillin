import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Cloudflare Pages 的静态输出目录（见 build_config.destination_dir） */
const SITE = 'public';

/** 解析 sw.js 中的 ASSETS 字面量路径（忽略 `/js/x.js?v=${APP_V}` 这类模板项） */
function parseAssets(swSource) {
    const block = swSource.match(/const ASSETS = \[([\s\S]*?)\];/);
    assert.ok(block, 'sw.js must declare an ASSETS array');
    return [...block[1].matchAll(/'([^']+)'|`([^`]+)`/g)]
        .map((m) => m[1] ?? m[2])
        .filter((p) => !p.includes('${'));
}

test('PWA - every shipped module is precached, every precached asset exists', async () => {
    const sw = await fs.readFile(path.join(root, SITE, 'sw.js'), 'utf8');
    const assets = parseAssets(sw);
    assert.ok(assets.length >= 20, `ASSETS looks too small (${assets.length})`);

    // 1) 清单里的每个静态资源都必须真实存在（避免 404 让 install 反复重试）
    for (const asset of assets) {
        if (asset === '/') continue;
        const filePath = path.join(root, SITE, asset.replace(/^\//, ''));
        await assert.doesNotReject(fs.access(filePath), `precached asset missing on disk: ${asset}`);
    }

    // 2) js/ 下每个模块都必须在预缓存清单里（新增模块忘记登记会静默离线失效）
    const modules = (await fs.readdir(path.join(root, SITE, 'js'))).filter((f) => f.endsWith('.js'));
    for (const file of modules) {
        assert.ok(assets.includes(`/js/${file}`), `js/${file} is not listed in sw.js ASSETS (offline would break)`);
    }

    // 3) manifest 引用的图标也要存在
    const manifest = JSON.parse(await fs.readFile(path.join(root, SITE, 'manifest.json'), 'utf8'));
    for (const icon of manifest.icons || []) {
        const filePath = path.join(root, SITE, String(icon.src).replace(/^\//, ''));
        await assert.doesNotReject(fs.access(filePath), `manifest icon missing on disk: ${icon.src}`);
    }
});

test('PWA - module requests never fall back to index.html (offline white-screen guard)', async () => {
    const sw = await fs.readFile(path.join(root, SITE, 'sw.js'), 'utf8');

    // 模块分支：从 isModuleJs 判断开始，到导航分支注释为止
    const start = sw.indexOf('const isModuleJs');
    assert.notEqual(start, -1, 'sw.js must classify module requests');
    const end = sw.indexOf('// 2.', start);
    assert.notEqual(end, -1, 'sw.js must have a navigation branch after the module branch');
    const moduleBranch = sw.slice(start, end);

    assert.ok(moduleBranch.includes('ignoreSearch'), 'module fallback should hit the cache with ignoreSearch');
    assert.ok(
        !moduleBranch.includes('/index.html'),
        'module requests must never be answered with index.html (Uncaught SyntaxError on offline boot)'
    );

    // 导航分支仍然要回退 index.html（单页应用离线可用）
    assert.ok(sw.slice(end).includes("caches.match('/index.html')"), 'navigation requests should still fall back to index.html');
});
