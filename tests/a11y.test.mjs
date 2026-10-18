import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 静态页面可访问性门禁。
 *
 * 背景：public/index.html 曾有 35 个表单控件只有 placeholder、没有 aria-label /
 * label[for]——读屏用户听到的是「编辑框」而不是「本周标题」。placeholder 不能替代
 * 可访问名称：它不是标签，且一旦输入就消失。这里把规则固化成测试，避免下次加表单又漏。
 *
 * 只校验静态外壳；JS 动态渲染的卡片在各自模块里保证语义。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

const controls = [...html.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map((m) => m[0]);
const labelFor = new Set([...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
const labelledby = new Set([...html.matchAll(/aria-labelledby="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));

test('A11y - 每个可见表单控件都有可访问名称（aria-label / aria-labelledby / label[for]）', () => {
    const missing = controls.filter((raw) => {
        if (/type="hidden"/.test(raw)) return false;
        if (/\baria-label=/.test(raw)) return false;
        const id = (raw.match(/\bid="([^"]+)"/) || [])[1] || '';
        return !(id && (labelFor.has(id) || labelledby.has(id)));
    });
    assert.equal(missing.length, 0, '以下控件缺少可访问名称（placeholder 不算数）：\n' + missing.map((c) => '  ' + c.trim().slice(0, 100)).join('\n'));
});

test('A11y - index.html 不存在重复 id', () => {
    const seen = new Map();
    for (const m of html.matchAll(/\bid="([^"]+)"/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    const dups = [...seen.entries()].filter(([, n]) => n > 1);
    assert.equal(dups.length, 0, '重复 id 会让 label[for] / aria-labelledby 指向错误元素：' + dups.map(([id, n]) => id + '×' + n).join(', '));
});

test('A11y - 所有 img 都带 alt 属性（纯装饰图用 alt=""）', () => {
    const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    const missing = imgs.filter((raw) => !/\balt=/.test(raw));
    assert.equal(missing.length, 0, '以下 img 缺少 alt：' + missing.map((t) => t.slice(0, 80)).join(' | '));
});

test('A11y - 批注项渲染出带可访问名称的删除按钮，且内容经过转义', async () => {
    const { annotationItemHtml } = await import('../public/js/utils.js');
    const html = annotationItemHtml({ id: 'a1', date: '2026-10-18', content: '<img src=x onerror=alert(1)>' });

    assert.match(html, /<button[^>]*>删除<\/button>/, '删除按钮必须有可见文本作为可访问名称');
    assert.match(html, /class="btn-delete-annotation"/, '删除按钮的类名是交互绑定的锚点，不能改名');
    assert.match(html, /class="annotation-time">2026-10-18</, '日期应渲染在时间位');
    assert.doesNotMatch(html, /<img/, '批注内容里的标签必须被转义，不能原样注入');
    assert.match(html, /&lt;img/, '转义后应以实体形式出现');
});
