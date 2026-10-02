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

try {
    run('单元测试（必须 0 失败）', 'npm test');
    run('边缘预打包演练（必须 Exit 0）', 'npx wrangler deploy --dry-run');

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

    if (!message || !CONVENTIONAL.test(message)) {
        console.error('\n✖ 必须提供符合 Conventional Commits 的 --message，例如：');
        console.error('   npm run ship -- --message "fix(sync): 修复游标回退" --push');
        process.exit(1);
    }

    run('暂存改动', 'git add -A');
    const staged = execSync('git diff --cached --name-only').toString().trim();
    if (!staged) {
        console.log('\n没有需要提交的改动。');
        process.exit(0);
    }
    console.log(`\n  即将提交 ${staged.split('\n').length} 个文件`);

    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });

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
