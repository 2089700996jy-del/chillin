#!/usr/bin/env node
/**
 * 一键发布流水线：门禁 → 版本联动 → 提交 → 推送。
 *
 * 用法：
 *   npm run ship -- --message "fix(ui): 修正导航栏抖动"
 *   npm run ship -- --message "feat(x): ..." --bump patch
 *   npm run ship -- --message "docs: ..." --dry          # 只跑门禁，不提交
 *
 * 设计原则：宁可中断，也不发布未过门禁的代码。
 */
import { execSync } from 'node:child_process';

const argv = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};
const has = (name) => argv.includes(name);

const message = typeof flag('--message') === 'string' ? flag('--message') : '';
const bump = typeof flag('--bump') === 'string' ? flag('--bump') : null;
const push = has('--push');
const dry = has('--dry');

const CONVENTIONAL = /^(feat|fix|perf|refactor|docs|test|style|chore|ci|build|revert)(\([a-z0-9._-]+\))?: .+/;

function run(label, command) {
    console.log(`\n▶ ${label}\n  $ ${command}`);
    execSync(command, { stdio: 'inherit' });
}

/**
 * 远端 D1 迁移前置检查。
 *
 * 背景：migrations/0019_reader_progress.sql 曾入库 12 天却从未应用，而依赖它的
 * 接口已经随 Worker 上线，线上长期报 "no such table"（本地测试因为会执行全部
 * 迁移，永远测不出来）。"迁移必须早于 Worker 部署"这条纪律得由机器来守。
 *
 * 行为：只有在"确定存在待应用迁移"时才中断发布；无法判定（离线 / 缺少凭据 /
 * 输出格式变化）时仅告警放行，避免网络抖动卡死发布流程。
 */
function checkRemoteMigrations() {
    let out;
    try {
        out = execSync('npx wrangler d1 migrations list DB --remote 2>&1', { encoding: 'utf8' });
    } catch (err) {
        console.warn('\n⚠ 无法检查远端 D1 迁移（离线或缺少凭据），跳过此项：' + (err && err.message ? err.message : err));
        return;
    }
    const clean = out.replace(/\x1b\[[0-9;]*m/g, '');
    if (/No migrations to apply/i.test(clean)) {
        console.log('\n✔ 远端 D1 迁移已是最新');
        return;
    }
    const pending = [...new Set([...clean.matchAll(/(\d{4}_[a-z0-9_]+\.sql)/gi)].map((m) => m[1]))];
    if (pending.length === 0) {
        console.warn('\n⚠ 未能解析远端迁移状态输出，跳过此项检查。');
        return;
    }
    console.error('\n✖ 远端 D1 仍有未应用的迁移，已阻止发布：');
    for (const file of pending) console.error('   - ' + file);
    console.error('\n  请先执行：npx wrangler d1 migrations apply DB --remote\n');
    process.exit(1);
}

try {
    // 先校验提交信息：格式不合法就立刻中断，避免白白改写 CHANGELOG / 版本号留下脏工作区
    if (!message || !CONVENTIONAL.test(message)) {
        console.error('\n✖ 必须提供符合 Conventional Commits 的 --message，例如：');
        console.error('   npm run ship -- --message "fix(sync): 修复游标回退" --push');
        process.exit(1);
    }

    run('单元测试（必须 0 失败）', 'npm test');
    run('边缘预打包演练（必须 Exit 0）', 'npx wrangler deploy --dry-run');
    checkRemoteMigrations();

    if (dry) {
        console.log('\n[dry] 门禁通过，未做任何提交。');
        process.exit(0);
    }

    if (bump) {
        if (!['patch', 'minor', 'major'].includes(bump)) {
            throw new Error(`--bump 只接受 patch | minor | major，收到：${bump}`);
        }
        run(`版本联动（${bump}）`, `npm run bump:${bump}`);
    }

    // CHANGELOG 由 git 历史生成，必须与提交一起更新，否则必然漂移
    run('重新生成 CHANGELOG', 'npm run changelog');

    // 版本联动会改写 package.json / 架构报告等锚点，必须再跑一次门禁：
    // 否则「bump 之后文档版本对不上」的提交会被推上去，下一轮 CI 必红。
    if (bump) run('版本联动后复测（必须 0 失败）', 'npm test');

    run('暂存改动', 'git add -A');
    const staged = execSync('git diff --cached --name-only').toString().trim();
    if (!staged) {
        console.log('\n没有需要提交的改动。');
        process.exit(0);
    }
    console.log(`\n  即将提交 ${staged.split('\n').length} 个文件`);

    // 用 -F - 从 stdin 读提交信息：彻底避开 shell 插值（原写法只转义双引号，$() / 反引号仍会被执行）
    execSync('git commit -F -', { input: message, stdio: ['pipe', 'inherit', 'inherit'] });

    if (push) {
        run('推送到 GitHub（会触发 Pages 构建）', 'git push origin main');
        console.log('\n✔ 完成。提醒：若本次包含 Worker 改动，请先在本地执行 npx wrangler deploy。');
    } else {
        console.log('\n✔ 已提交（未推送）。加 --push 可一并推送。');
    }
} catch (err) {
    console.error('\n✖ 发布中断：' + (err && err.message ? err.message : err));
    process.exit(1);
}
