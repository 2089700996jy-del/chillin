import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
// 注意：listDir 刻意**非递归**——docs/archive/ 里的冻结历史不参与任何门禁（既不校验链接可解析，
// 也不校验反引号路径存在），否则归档会随着代码演进反复变红，逼人改写历史记录。

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

    const progress = read('PROGRESS.md').match(/`migrations\/0001`–`(\d{4})`/);
    assert.ok(progress, 'PROGRESS 应写明迁移范围');
    assert.equal(progress[1], last, 'PROGRESS 的迁移范围结尾是 ' + progress[1] + '，最新迁移是 ' + last + '——请同步文档');
});

test('Docs - 架构报告正文的行数承诺与用例数与磁盘一致', () => {
    const report = read(reportPath);

    // 报告正文对网关行数的承诺必须是「当前真实行数的上界」——只允许收缩，不允许悄悄变胖。
    // 原来写着 260 行而实际已 292 行，人眼审不出来。
    const claimed = report.match(/严格保持在 (\d+) 行内/);
    const actual = read('workers/api.js').split('\n').length;
    assert.ok(claimed, '架构报告应写明 workers/api.js 的行数承诺');
    assert.ok(actual <= Number(claimed[1]), `workers/api.js 实际 ${actual} 行，已超过报告承诺的 ${claimed[1]} 行——请同步文档`);
    assert.ok(Number(claimed[1]) <= 300, '报告承诺的行数 ' + claimed[1] + ' 已越过 AGENTS.md 的 300 行红线');

    // 正文明细里的用例数必须与标题一致（标题已对着 tests/ 校验，这里堵住正文漏改）
    const body = report.match(/\*\*(\d+) 个严密测试用例\*\*/);
    const heading = report.match(/(\d+) 套件 \/ (\d+) 用例/);
    assert.ok(body && heading, '架构报告应写明测试用例数');
    assert.equal(Number(body[1]), Number(heading[2]), '报告正文明细说 ' + body[1] + ' 个用例，标题说 ' + heading[2] + ' 个——请同步文档');
});

test('Docs - 备份与恢复命令可用（快照只留 .sql.gz，恢复走脚本）', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.scripts.backup, 'package.json 应提供 backup 脚本');
    assert.ok(pkg.scripts.restore, 'package.json 应提供 restore 脚本');
    assert.ok(fs.existsSync(path.join(root, 'scripts', 'restore-d1.mjs')), 'restore-d1.mjs 缺失');

    // 旧文档让人直接执行 backups/*.sql，而备份脚本导出后就把裸 .sql 删了——命令必然找不到文件
    assert.match(readme, /npm run restore/, 'README 必须给出可执行的恢复命令');
    assert.doesNotMatch(readme, /backups\/chillin-d1-<时间戳>\.sql(?!\.gz)/, 'README 不应再让人直接执行已被删除的裸 .sql');
});

test('Docs - 自有文档的本地链接都能解析（无死链、无绝对 file:// 路径）', () => {
    // 背景：README / 规约 / 技能文档里曾有 54 个 file:///d:/7/chillin/... 绝对链接——
    // 换台机器或换个盘符就全部失效，而评审时没人会去点。这里把「链接能打开」变成门禁。
    const docs = [
        'README.md',
        'AGENTS.md',
        'PROGRESS.md',
        ...listDir('docs', (f) => f.endsWith('.md')).map((f) => 'docs/' + f),
        ...listDir('.agents/rules', (f) => f.endsWith('.md')).map((f) => '.agents/rules/' + f),
        ...listDir('.agents/skills', () => true)
            .map((dir) => '.agents/skills/' + dir + '/SKILL.md')
            .filter((rel) => fs.existsSync(path.join(root, rel)))
    ];

    const dead = [];
    for (const rel of docs) {
        const dir = path.dirname(path.join(root, rel));
        // 代码块里的示例不是链接，先剔除以免误报
        const text = read(rel).replace(/```[\s\S]*?```/g, '');
        for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
            const target = m[1];
            if (/^(https?:|mailto:|#|tel:)/.test(target)) continue;
            if (/^file:\/\//i.test(target)) {
                dead.push(rel + ' → ' + target + '（绝对路径不可移植，请改成相对路径）');
                continue;
            }
            const clean = decodeURIComponent(target.split('#')[0]);
            if (clean && !fs.existsSync(path.resolve(dir, clean))) dead.push(rel + ' → ' + target);
        }
    }
    assert.equal(dead.length, 0, '以下本地链接指向不存在的文件：\n' + dead.map((d) => '  ' + d).join('\n'));
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

test('Docs - 版本联动脚本覆盖全部版本锚点（bump 后不产生文档漂移）', () => {
    // 背景：bump-version.mjs 曾漏写架构报告，而本文件断言「报告版本 == package.json」，
    // 于是 npm run ship --bump patch 会推送一个「下一轮 CI 必红」的提交。
    // 这里用 --dry-run 实跑脚本（不改任何文件），断言它写入的文件集合覆盖 docs.test 会校验的每个锚点。
    const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'bump-version.mjs'), '--dry-run', 'patch'], { encoding: 'utf8' });
    const written = new Set([...out.matchAll(/\[dry-run\] would write (.+)/g)].map((m) => m[1].trim()));
    const anchors = ['package.json', 'public/version.json', 'public/js/version.js', 'public/sw.js', 'public/index.html', 'workers/api.js', reportPath];
    for (const rel of anchors) {
        assert.ok(written.has(rel), 'bump-version.mjs 未更新版本锚点 ' + rel + '——bump 之后 docs.test 会变红');
    }
});

test('Docs - restore 脚本对远端覆盖有 --yes 安全闸（缺参数/未确认都必须拒绝）', () => {
    // 背景：restore 默认目标是远端生产库，会覆盖现有数据。
    // 若这道闸失效，一条手滑的命令就能清掉生产库——所以用实跑脚本的方式把它钉住。
    const script = path.join(root, 'scripts', 'restore-d1.mjs');
    const run = (args) => {
        try {
            execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
            return { code: 0, out: '' };
        } catch (err) {
            return { code: err.status, out: String(err.stderr || '') + String(err.stdout || '') };
        }
    };

    const noArgs = run([]);
    assert.equal(noArgs.code, 1, '缺参数必须退出非 0');
    assert.match(noArgs.out, /用法：npm run restore/, '缺参数必须打印用法');

    // 不存在的快照：先撞「找不到快照」，同样必须退出 1
    const missing = run(['backups/chillin-d1-20260101-000000.sql.gz']);
    assert.equal(missing.code, 1, '快照不存在时必须退出非 0');
    assert.match(missing.out, /找不到快照/, '快照不存在必须明确报错');

    // 用一个仓库里真实存在的文件当「快照」参数：脚本只检查存在性，
    // 随后就该撞上 --yes 安全闸（校验顺序：无参数 → 文件缺失 → 未确认）
    const noYes = run(['package.json']);
    assert.equal(noYes.code, 1, '未确认时必须退出非 0');
    assert.match(noYes.out, /确认无误请追加 --yes/, '远端目标未加 --yes 必须拒绝执行');
    assert.ok(!/wrangler/.test(noYes.out), '安全闸必须在调用 wrangler 之前拦下，不能有任何执行痕迹');
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

test('Docs - PROGRESS.md 有体量预算（防止再膨胀成逐版本长散文）', () => {
    // 背景：PROGRESS.md 曾长到 649 行 / 109 KB，正文是一整部逐版本史，与自动生成的
    // CHANGELOG.md 职责重叠，也没人读得完。2026-10-22 精简为 88 行 / 7.8 KB，历史详情
    // 归档到 docs/archive/PROGRESS-历史详情.md（该目录刻意不在门禁范围内）。
    // 新版本只在「近期已完成」表里加一行；过程细节写进归档或 CHANGELOG。
    const text = read('PROGRESS.md');
    const lines = text.split('\n').length;
    const bytes = Buffer.byteLength(text, 'utf8');
    assert.ok(lines <= 220, 'PROGRESS.md 已 ' + lines + ' 行（预算 220）——请把历史详情搬去 docs/archive/ 或 CHANGELOG.md');
    assert.ok(bytes <= 20 * 1024, 'PROGRESS.md 已 ' + bytes + ' 字节（预算 20 KB）——请把历史详情搬去 docs/archive/ 或 CHANGELOG.md');
});

test('Docs - README 技术栈写明 D1 + R2 双存储', () => {
    assert.match(readme, /Cloudflare R2/, 'README 技术栈必须写明 R2');
    assert.match(readme, /chillin-media/, 'README 必须写明 R2 桶名');
    assert.doesNotMatch(readme, /D1 是唯一的数据源|外链自动抓取/, 'README 不应再保留已被移除的能力或存储表述');
});

test('Docs - 文档里提到的 npm 脚本都真实存在', () => {
    // 背景：README 曾让用户执行 npm run restore，但 package.json 里根本没有这个脚本，
    // 照着文档做只会看到 "Missing script"。命令与实现必须同源。
    const scripts = Object.keys(JSON.parse(read('package.json')).scripts || {});
    const docs = [
        'README.md',
        'AGENTS.md',
        'PROGRESS.md',
        'docs/Chillin数字花园_产品全景与工程架构分析报告.md'
    ];
    const missing = [];
    for (const rel of docs) {
        for (const m of read(rel).matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
            if (!scripts.includes(m[1])) missing.push(rel + ' → npm run ' + m[1]);
        }
    }
    assert.equal(missing.length, 0, '文档引用了不存在的 npm 脚本（照做会直接报 Missing script）：\n' + missing.join('\n'));
});

test('Docs - 行动文档里内联点名的文件路径必须存在', () => {
    // 链接有专门的门禁，但正文里 `workers/src/x.js` 这种反引号引用没人管：
    // security.js 拆成两个模块、echo.js 改名 echo-ai.js 之后，文档还在指向旧名字，
    // 新人（或 AI）照着去找会直接扑空。这里只检查「描述当下系统」的文档——
    // PROGRESS 是变更日志（必须能记录已删除的文件）、docs/ 与 LICENSE 同理，故排除。
    const actionDocs = [
        'README.md',
        'AGENTS.md',
        ...listDir('.agents/rules', (f) => f.endsWith('.md')).map((f) => '.agents/rules/' + f),
        ...listDir('.agents/skills', () => true)
            .map((dir) => '.agents/skills/' + dir + '/SKILL.md')
            .filter((rel) => fs.existsSync(path.join(root, rel)))
    ];
    // 排错指南里作为「假设的新文件」出现的名字，不指向真实文件
    const EXAMPLES = new Set(['public/js/foo.js']);

    const stale = [];
    for (const rel of actionDocs) {
        for (const m of read(rel).matchAll(/`([^`\n]+)`/g)) {
            let ref = m[1].trim();
            if (!/^(public|workers|tests|scripts|migrations|functions|\.agents)\//.test(ref)) continue;
            if (/[*<\$`]/.test(ref)) continue;                       // 通配与占位符
            if (EXAMPLES.has(ref)) continue;
            ref = ref.replace(/[:#](L?\d+(-L?\d+)?)$/, '');            // 去掉 :12 / #L12
            const isDir = ref.endsWith('/');
            const seg = ref.split('/').pop();
            if (!isDir && !seg.includes('.')) continue;                // migrations/0001 这类区间写法
            if (!fs.existsSync(path.join(root, ref))) stale.push(rel + ' → ' + ref);
        }
    }
    assert.equal(stale.length, 0, '以下文档引用的文件已不存在（多半是改名/拆分后忘了同步）：\n' + stale.join('\n'));
});

test('Docs - CI 工作流覆盖双 Node 版本与 Worker 打包', () => {
    const ci = read('.github/workflows/ci.yml');
    assert.match(ci, /pull_request/, '必须在 PR 上跑，不能只跑 main push');
    assert.match(ci, /node: \['20', '22'\]/, 'Node 20 与 22 的行为不同（SQLite 用例在 20 下跳过），矩阵必须两个都跑');
    assert.match(ci, /npm test/, 'CI 必须跑完整单测');
    assert.match(ci, /wrangler deploy --dry-run/, 'CI 必须验证 Worker 能打包');
    assert.match(ci, /public\/\$f/, 'CI 必须继续检查 Pages 发布目录的完整文件清单');
});
