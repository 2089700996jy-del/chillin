#!/usr/bin/env node
/**
 * 从 git 提交历史生成 CHANGELOG.md（按 Conventional Commits 分组）。
 *
 * 用法：npm run changelog
 * 说明：文件整体重新生成，请勿手工编辑。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SECTIONS = [
    ['feat', '✨ 新功能'],
    ['fix', '🐛 缺陷修复'],
    ['perf', '⚡ 性能优化'],
    ['refactor', '♻️ 重构'],
    ['security', '🔒 安全加固'],
    ['test', '🧪 测试'],
    ['ci', '🤖 持续集成'],
    ['build', '📦 构建'],
    ['docs', '📝 文档'],
    ['style', '🎨 样式'],
    ['chore', '🔧 杂务'],
    ['revert', '⏪ 回滚'],
    ['other', '📎 其他'],
];

const raw = execSync('git log --no-merges --date=short --pretty=format:%ad%x1f%s', { encoding: 'utf8' });
const byDate = new Map();

for (const line of raw.split('\n').filter(Boolean)) {
    const [date, subject] = line.split('\x1f');
    const match = subject.match(/^([a-z]+)(\(([^)]*)\))?: (.+)$/);
    const type = match && SECTIONS.some(([t]) => t === match[1]) ? match[1] : 'other';
    const scope = match && match[3] ? `**${match[3]}**: ` : '';
    const text = match ? match[4] : subject;
    if (!byDate.has(date)) byDate.set(date, new Map());
    const day = byDate.get(date);
    if (!day.has(type)) day.set(type, []);
    day.get(type).push(scope + text);
}

const dates = [...byDate.keys()].sort().reverse();
const out = [
    '# 更新日志 (CHANGELOG)',
    '',
    '> 本文件由 `npm run changelog` 从 git 提交历史自动生成，请勿手工编辑。',
    `> 生成时间：${new Date().toISOString()} · 提交数：${[...byDate.values()].reduce((n, day) => n + [...day.values()].reduce((m, list) => m + list.length, 0), 0)}`,
    '',
];

for (const date of dates) {
    out.push(`## ${date}`, '');
    const day = byDate.get(date);
    for (const [type, title] of SECTIONS) {
        const items = day.get(type);
        if (!items || items.length === 0) continue;
        out.push(`### ${title}`, '');
        for (const item of items) out.push(`- ${item}`);
        out.push('');
    }
}

const target = path.join(root, 'CHANGELOG.md');
fs.writeFileSync(target, out.join('\n'), 'utf8');
console.log(`[changelog] wrote ${path.relative(root, target)} (${dates.length} days, ${out.length} lines)`);
