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

/** 把 _headers 解析成 path → { header: value } */
function parseHeaders(source) {
    const blocks = new Map();
    let current = null;
    for (const raw of source.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('/')) {
            current = line;
            blocks.set(current, new Map());
            continue;
        }
        if (!current) continue;
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        blocks.get(current).set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
    }
    return blocks;
}

test('PWA - _headers 的缓存策略维持「版本探测不缓存 / 静态资源带 ETag 复验」的分工', async () => {
    // 背景：public/js/*.js 的文件名没有内容哈希。一旦有人给它加上
    // Cache-Control: max-age=31536000, immutable，改完代码的用户会一年都拿到旧文件，
    // 且 Service Worker 也救不回来；反过来把 //sw.js 缓存住则新版本永远推不出去。
    const source = await fs.readFile(path.join(root, SITE, '_headers'), 'utf8');
    const blocks = parseHeaders(source);
    const cacheControl = (p) => (blocks.get(p) || new Map()).get('cache-control') || '';

    for (const p of ['/sw.js', '/index.html', '/version.json', '/js/version.js']) {
        assert.match(
            cacheControl(p),
            /no-store/,
            p + ' 必须 no-store：它参与版本探测，被缓存住用户会一直停在旧版本'
        );
    }

    for (const p of ['/style.css', '/app.js', '/js/*']) {
        const value = cacheControl(p);
        assert.match(value, /no-cache/, p + ' 必须带 no-cache 走 ETag 复验');
        assert.doesNotMatch(
            value,
            /no-store/,
            p + ' 不应 no-store：连 304 都不给，复访要把 435KB JS + 217KB CSS 全量重下'
        );
        assert.doesNotMatch(
            value,
            /max-age|immutable/,
            p + ' 没有内容哈希，绝不能用 max-age/immutable，否则改完代码用户仍拿旧文件'
        );
    }

    assert.equal(
        (blocks.get('/js/*') || new Map()).get('cdn-cache-control'),
        'no-store',
        '边缘缓存也必须 no-store，避免 Pages CDN 与浏览器策略分叉'
    );
});

test('PWA - 运行时缓存写入挂在 waitUntil 上（响应不等缓存落盘，但写入不会被回收）', async () => {
    // 历史教训：fire-and-forget 的 cache.put 会被浏览器回收打断，用户下次离线发现这版没缓存住；
    // 而把 await cache.put 塞进 respondWith 的 promise 里，又让每次请求白等一次磁盘写入。
    const sw = await fs.readFile(path.join(root, SITE, 'sw.js'), 'utf8');
    const start = sw.indexOf('const networkThenCache');
    assert.notEqual(start, -1, 'sw.js 必须保留 networkThenCache 分支');
    const end = sw.indexOf('// 1.', start);
    assert.notEqual(end, -1, 'networkThenCache 之后必须紧跟模块分支');
    const branch = sw.slice(start, end);

    assert.match(branch, /const clone = res\.clone\(\)/, '写入前必须先 clone 响应体，原响应要还给页面');
    assert.match(
        branch,
        /e\.waitUntil\(\s*caches\.open\(CACHE_NAME\)\s*\.then\(\(cache\) => cache\.put\(e\.request, clone\)\)/,
        'cache.put 必须用 e.waitUntil 挂进 SW 生命周期'
    );
    assert.doesNotMatch(branch, /await\s+cache\.put/, '缓存写入不得再让 respondWith 的 promise 等它');
    assert.match(branch, /catch\(/, 'waitUntil 与写入失败都要吞掉异常，不能影响本次响应');
});


test('PWA - modulepreload 只预热 app.js 入口，且与 module script 同 URL', async () => {
    const html = await fs.readFile(path.join(root, SITE, 'index.html'), 'utf8');
    const links = [...html.matchAll(/<link\s+rel="modulepreload"\s+href="([^"]+)"/g)].map((m) => m[1]);
    const script = html.match(/<script\s+type="module"\s+src="([^"]*app\.js[^"]*)"/);
    assert.ok(script, 'index.html 必须有 app.js module script');
    assert.deepEqual(links, ['/' + script[1]], '只预热入口 app.js，且必须与 script src 完全同 URL（含 ?v）');

    const sw = await fs.readFile(path.join(root, SITE, 'sw.js'), 'utf8');
    const assets = parseAssets(sw);
    const appPath = '/' + script[1].replace(/\?.*$/, '');
    assert.ok(assets.includes(appPath), '入口 app.js 必须在 sw.js ASSETS 中');
    await assert.doesNotReject(fs.access(path.join(root, SITE, appPath.replace(/^\//, ''))), '入口 app.js 不存在');
    assert.equal(links.filter((href) => href.startsWith('/js/')).length, 0,
        '不再给 12 个业务模块加 modulepreload：实测会抢 CSS 带宽、拖慢 LCP');
});
