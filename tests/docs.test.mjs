import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 文档一致性门禁（规则见 .agents/rules/engineering-workflow.md §5）。
 *
 * 背景：README / 规约 / 报告里的「数字类事实」曾长期漂移——写着「外链自动抓取标题」「D1 是唯一
 * 数据源」「19 个迁移」「27 个模块」，而代码里早已不是这样。人眼审不出来，所以交给机器：
 * 这些数字必须等于磁盘上的真实数量，对不上就让 npm test 红灯。
 *
 * 失败时请改文档，不要改这里的数字。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const listDir = (dir, filter) => fs.readdirSync(path.join(root, dir)).filter(filter);

const readme = read('README.md');
const version = JSON.parse(read('package.json')).version;
const reportPath = 'docs/Chillin数字花园_产品全景与工程架构分析报告.md';

const jsModules = listDir('public/js', (f) => f.endsWith('.js'));
const workerModules = listDir('workers/src', (f) => f.endsWith('.js'));
const migrations = listDir('migrations', (f) => /^\d{4}_.+\.sql$/.test(f)).sort();
const suites = listDir('tests', (f) => f.endsWith('.test.mjs'));

test('Docs - README 的模块数量与磁盘一致', () => {
    const pwa = readme.match(/(\d+) 个 `js\/` 模块/);
    const tree = readme.match(/js\/\s+(\d+) 个 ES 模块/);
    const workers = readme.match(/workers\/src\/\s+(\d+) 个领域模块/);
    assert.ok(pwa && tree && workers, 'README 应写明 js/ 与 workers/src/ 的模块数量');

    assert.equal(Number(pwa[1]), jsModules.length, 'README 说 js/ 有 ' + pwa[1] + ' 个模块，实际 ' + jsModules.length + ' 个——请同步文档');
    assert.equal(Number(tree[1]), jsModules.length, 'README 目录结构里的 js/ 模块数 (' + tree[1] + ') 与实际 (' + jsModules.length + ') 不符');
    assert.equal(Number(workers[1]), workerModules.length, 'README 说 workers/src/ 有 ' + workers[1] + ' 个模块，实际 ' + workerModules.length + ' 个——请同步文档');
});

test('Docs - README 的迁移数量与范围与 migrations/ 一致', () => {
    const last = migrations[migrations.length - 1].slice(0, 4);
    const tech = readme.match(/(\d+) 个迁移 0001–(\d{4})/);
    const tree = readme.match(/D1 迁移 0001–(\d{4})/);
    assert.ok(tech && tree, 'README 应写明迁移数量与范围');

    assert.equal(Number(tech[1]), migrations.length, 'README 说 ' + tech[1] + ' 个迁移，实际 ' + migrations.length + ' 个');
    assert.equal(tech[2], last, 'README 的迁移范围结尾是 ' + tech[2] + '，最新迁移是 ' + last);
    assert.equal(tree[1], last, 'README 目录结构里的迁移范围结尾是 ' + tree[1] + '，最新迁移是 ' + last);
});

test('Docs - README 测试布局表覆盖全部测试套件', () => {
    const listed = new Set([...readme.matchAll(/tests\/([a-z0-9-]+)\.test\.mjs/g)].map((m) => m[1]));
    assert.equal(listed.size, suites.length, 'README 测试布局表列了 ' + listed.size + ' 个套件，实际有 ' + suites.length + ' 个');
    for (const file of suites) {
        const name = file.replace(/\.test\.mjs$/, '');
        assert.ok(listed.has(name), 'README 测试布局表缺少 tests/' + file + '——请同步文档');
    }
});

test('Docs - 架构规约的模块表覆盖全部 Worker 模块', () => {
    const arch = read('.agents/rules/architecture.md');
    for (const file of workerModules) {
        assert.ok(arch.includes('workers/src/' + file), '.agents/rules/architecture.md 的领域模块表缺少 workers/src/' + file + '——请同步文档');
    }
});

test('Docs - 各文档版本号与 package.json 完全一致', () => {
    const versionJs = read('public/js/version.js').match(/APP_VERSION\s*=\s*'([\d.]+)'/);
    const sw = read('public/sw.js').match(/APP_V\s*=\s*'([\d.]+)'/);
    const progress = read('PROGRESS.md').match(/当前前端\/Worker：\*\*v([\d.]+)\*\*/);
    const report = read(reportPath).match(/报告版本\*\*：v([\d.]+)/);
    assert.ok(versionJs && sw && progress && report, '各文档应写明版本号');

    for (const [label, value] of [
        ['public/js/version.js', versionJs[1]],
        ['public/sw.js', sw[1]],
        ['PROGRESS.md', progress[1]],
        ['架构报告', report[1]],
    ]) {
        assert.equal(value, version, label + ' 的版本 ' + value + ' 与 package.json 的 ' + version + ' 不一致——请同步文档');
    }
});

test('Docs - 架构报告的套件数与用例数与 tests/ 一致', () => {
    // 用例数按「测试文件里的静态调用点」统计；若将来出现循环动态生成的用例，这里会报错提醒人工核对。
    const staticCases = suites.reduce((sum, file) => {
        const text = fs.readFileSync(path.join(root, 'tests', file), 'utf8');
        return sum + (text.match(/^\s*(?:test|integration)\s*\(/gm) || []).length;
    }, 0);

    const prose = read(reportPath).match(/(\d+) 个测试套件/);
    const heading = read(reportPath).match(/(\d+) 套件 \/ (\d+) 用例/);
    assert.ok(prose, '架构报告应写明测试套件数量');
    assert.ok(heading, '架构报告的小节标题应写明「N 套件 / M 用例」');

    assert.equal(Number(prose[1]), suites.length, '架构报告说 ' + prose[1] + ' 个测试套件，实际 ' + suites.length + ' 个——请同步文档');
    assert.equal(Number(heading[1]), suites.length, '架构报告标题说 ' + heading[1] + ' 套件，实际 ' + suites.length + ' 套——请同步文档');
    assert.equal(Number(heading[2]), staticCases, '架构报告标题说 ' + heading[2] + ' 用例，实际 ' + staticCases + ' 个——请同步文档');
});

test('Docs - README 技术栈写明 D1 + R2 双存储', () => {
    assert.match(readme, /Cloudflare R2/, 'README 技术栈必须写明 R2');
    assert.match(readme, /chillin-media/, 'README 必须写明 R2 桶名');
    assert.doesNotMatch(readme, /D1 是唯一的数据源|外链自动抓取/, 'README 不应再保留已被移除的能力或存储表述');
});
