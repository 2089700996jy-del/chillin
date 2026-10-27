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

test('A11y - 外观主题控件有可访问名称与三个可辨认选项，且首帧前已应用主题', () => {
    const control = (html.match(/<div[^>]*id="app-theme-control"[^>]*>[\s\S]*?<\/div>/) || [''])[0];
    assert.match(control, /role="group"/, '外观控件是一组互斥按钮，需要 role="group" 才能让读屏理解为同一组选项');
    assert.match(control, /aria-label="外观主题"/, '外观控件缺少 aria-label，读屏只会听到三个孤立的按钮名');
    const opts = [...control.matchAll(/data-app-theme="([^"]+)"[^>]*>([^<]+)</g)].map((m) => m[1] + ':' + m[2].trim());
    assert.deepEqual(opts, ['auto:跟随系统', 'light:浅色', 'dark:深色'], '三个选项的取值与文案是 auth.js markAppThemeControl 的锚点，不能改名');
    assert.match(html, /documentElement\.setAttribute\('data-theme'/, '首帧前必须在 head 内联脚本里落 data-theme，否则深色用户会先看到一帧白屏');
    assert.match(html, /chillin_theme/, 'head 内联脚本必须读同一个 localStorage 键，否则手动选择会在刷新后闪回系统主题');
});

test('A11y - 底部 Tab 栏有主导航名、选中项暴露 aria-current，FAB 有随视图更新的可访问名称', () => {
    const routerJs = fs.readFileSync(path.join(root, 'public/js/router.js'), 'utf8');
    const nav = (html.match(/<nav class="mobile-bottom-nav"[\s\S]*?<\/nav>/) || [''])[0];
    assert.match(nav, /aria-label="主导航"/, '底栏 <nav> 缺少 aria-label：读屏只会念出一串孤立链接');
    assert.equal((nav.match(/data-view="/g) || []).length, 5, '底栏应有 5 个主视图入口');
    assert.equal((nav.match(/aria-current="page"/g) || []).length, 1, '静态外壳里只允许一个 aria-current="page"，由 router 在切视图时转移');
    assert.match(nav, /class="mobile-tab-item active" data-view="home" aria-current="page"/, '首屏默认视图（home）必须同时带 active 与 aria-current');
    assert.equal((nav.match(/tab-svg-outline/g) || []).length, 5, '每个 Tab 都要有描边字形（未选中态）');
    assert.equal((nav.match(/tab-svg-fill/g) || []).length, 5, '每个 Tab 都要有配对的实心字形（选中态）');
    assert.match(html, /<button class="fab-btn" id="btn-create-new" aria-label="记录新片段">/, 'FAB 必须自带 aria-label：移动端 .fab-label 是 display:none，读屏只能念出「+」');
    assert.match(routerJs, /removeAttribute\('aria-current'\)/, 'router 切视图时必须清除上一个 aria-current，否则多个 Tab 会同时宣称是当前页');
    assert.match(routerJs, /setAttribute\('aria-current', 'page'\)/, 'router 必须给新的当前视图补上 aria-current');
    assert.match(routerJs, /fabBtn\.setAttribute\('aria-label'/, 'FAB 的 aria-label 必须随视图更新（fabLabel 是 display:none，CSS 改不了可访问名称）');
});

test('A11y - toast 容器是 polite live region，错误提示用 alert 角色', () => {
    const container = (html.match(/<div class="toast-container" id="toast-container"[^>]*>/) || [''])[0];
    assert.match(container, /aria-live="polite"/, 'toast 容器需要 live region，否则读屏用户听不到操作反馈');
    const utilsJs = fs.readFileSync(path.join(root, 'public/js/utils.js'), 'utf8');
    assert.match(utilsJs, /setAttribute\('role', type === 'error' \? 'alert' : 'status'\)/, '错误提示用 alert，其余用 status');
    assert.match(utilsJs, /aria-atomic/, '整条提示应作为一个整体播报');
});

test('A11y - 阅读器章节目录是可聚焦的滚动区域', () => {
    const sidebar = (html.match(/<div[^>]*id="sidebar-chapter-list"[^>]*>/) || [''])[0];
    assert.match(sidebar, /tabindex="0"/, '章节列表可滚动，键盘用户必须能聚焦它，否则 axe 报 scrollable-region-focusable');
    assert.match(sidebar, /aria-label="章节列表"/, '可聚焦的滚动区域需要可访问名称，读屏才知道这是目录');
});
