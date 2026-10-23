import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * style.css 卫生门禁（9600+ 行样式此前完全没有测试覆盖）。
 *
 * 只做「静态可证明」的检查，不碰视觉：死动画、重复声明、空块、静默失效的 var()、
 * 以及 !important 的棘轮。视觉回归需要真浏览器截图，不在这里假装能测。
 *
 * 注意：:root 里有一批当前未被 var() 引用的令牌（--ios-label、--card-shadow、
 * --space-1/5/6、--radius-sm、--dur-fast/--dur-base、--ease-spring、--focus-ring-color）。
 * 它们是**有意预留**的令牌阶梯（见 :root 注释），不是死代码——不要按「未引用」删掉。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

// 基线：这里只许变小，不许变大
const IMPORTANT_BASELINE = 230;

test('CSS - 每个 @keyframes 都被 animation 引用（无死动画）', () => {
    const defs = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    const animations = [...css.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)].map((m) => m[1]).join(' ');
    const dead = defs.filter((name) => !new RegExp('(^|[\\s,])' + name + '($|[\\s,;])').test(animations));
    assert.equal(dead.length, 0, '以下 @keyframes 定义了却没有任何规则使用：' + dead.join(', '));
});

test('CSS - 规则块内没有完全重复的声明', () => {
    const dups = [];
    for (const block of css.matchAll(/\{([^{}]*)\}/g)) {
        const seen = new Set();
        for (const raw of block[1].split(';')) {
            const decl = raw.trim();
            if (!decl) continue;
            if (seen.has(decl)) dups.push(decl);
            seen.add(decl);
        }
    }
    assert.equal(dups.length, 0, '同一规则块里重复写了相同声明：' + dups.slice(0, 5).join(' | '));
});

test('CSS - 没有空规则块且花括号平衡', () => {
    const empty = [...css.matchAll(/([^{}]+)\{\s*\}/g)].map((m) => m[1].trim());
    assert.equal(empty.length, 0, '空规则块（多半是删样式时的残留）：' + empty.slice(0, 5).join(' | '));
    assert.equal(
        (css.match(/\{/g) || []).length,
        (css.match(/\}/g) || []).length,
        '花括号不配对，样式表已经损坏'
    );
});

test('CSS - var() 引用的自定义属性必须已定义或带 fallback', () => {
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const broken = [];
    for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
        if (!defined.has(m[1]) && !m[2]) broken.push(m[1]);
    }
    assert.equal(broken.length, 0, '这些变量既没定义也没有 fallback，会静默失效：' + [...new Set(broken)].join(', '));
});

test('CSS - !important 数量不再增长（基线棘轮）', () => {
    const count = (css.match(/!important/g) || []).length;
    assert.ok(
        count <= IMPORTANT_BASELINE,
        `!important 从基线 ${IMPORTANT_BASELINE} 涨到 ${count}——先想想能不能靠更具体的选择器解决；确有必要时请更新 tests/css.test.mjs 里的基线并说明原因`
    );
});

// 裸 hex 棘轮：v2.5.144 令牌化批次把它从 501 降到 126（阈值=同值出现 >=3 次才建令牌），
// 剩余的是长尾一次性色值，不强行合并。
const HEX_BASELINE = 126;

test('CSS - 裸 hex 数量不再增长（基线棘轮）', () => {
    const count = (css.replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-fA-F]{3,8}\b/g) || []).length;
    assert.ok(
        count <= HEX_BASELINE,
        `裸 hex 从基线 ${HEX_BASELINE} 涨到 ${count}——请优先复用 :root 令牌（--white / --ios-blue / --ios-grouped-bg …），确有必要时请更新 tests/css.test.mjs 里的基线并说明原因`
    );
});

test('CSS - 首屏柔光渐变只在亮色主题，深色/护眼显式关闭', () => {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const bodyBlock = clean.match(/(^|\n)body\s*\{([^}]*)\}/);
    assert.ok(bodyBlock && /radial-gradient/.test(bodyBlock[2]), '亮色主题 body 缺少首屏柔光渐变（hero 光晕）');
    const blocks = [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    for (const theme of ['body.dark-reader-body', 'body.eyecare-reader-body']) {
        const resets = blocks.filter((m) => m[1].split(',').some((s) => s.trim() === theme || s.trim() === 'html.' + theme + ' body') && /background-image/.test(m[2]));
        assert.ok(resets.some((m) => /background-image:\s*none/.test(m[2])), theme + ' 必须显式 background-image: none，否则亮色 hero 光晕会在深底上发脏蓝');
    }
});

test('CSS - 禁止 transition: all（只允许显式属性列表）', () => {
    const all = [...css.matchAll(/transition:\s*all[^;}]*/g)].map((m) => m[0].replace(/\s+/g, ' ').trim());
    assert.equal(
        all.length,
        0,
        'transition: all 会让任何属性变化都触发动画（含 width/height 等布局属性，触发重排）：请写显式的属性列表，例如 transition: transform, opacity, background-color, color, border-color, box-shadow 0.2s ease。命中：' + all.slice(0, 3).join(' | ')
    );
    const props = [...css.matchAll(/transition-property\s*:\s*([^;}]+)/g)].filter((m) => /(^|[\s,])all([\s,]|$)/.test(m[1]));
    assert.equal(props.length, 0, 'transition-property 里同样不许出现 all：' + props.slice(0, 3).map((m) => m[1].trim()).join(' | '));
});

test('CSS - 遮罩层必须是层级令牌，禁止再次出现裸 z-index ≥ 1000', () => {
    const bare = [...css.matchAll(/z-index\s*:\s*(\d+)/g)].filter((m) => Number(m[1]) >= 1000).map((m) => m[0]);
    assert.equal(
        bare.length,
        0,
        '顶层层级一律走 :root 的 --z-nav/--z-modal/--z-toast/--z-auth/--z-alert 令牌（否则图标 X 会盖住确认弹窗这类顺序错误会重新出现）：' + bare.slice(0, 5).join(' | ')
    );
    for (const token of ['--z-nav', '--z-modal', '--z-toast', '--z-auth', '--z-alert']) {
        assert.ok(new RegExp(token + '\\s*:\\s*\\d+').test(css), '缺少层级令牌 ' + token);
    }
});

const BACKDROP_BASELINE = 41;

test('CSS - 单个组件的定义块数不再增长（.mobile-bottom-nav 反例）', () => {
    // .mobile-bottom-nav 曾散落在 11 个规则块里（顶层 + @media + html.ios-pwa + 深色/护眼），
    // 每一层都靠 !important 抢优先级。已合并为 10 块，这里只许变小，不许再往上加。
    const blocks = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => m[1].split(',').some((s) => s.trim().endsWith('.mobile-bottom-nav')));
    assert.ok(
        blocks.length <= NAV_BLOCKS_BASELINE,
        `.mobile-bottom-nav 的定义块从 ${NAV_BLOCKS_BASELINE} 涨到 ${blocks.length}——同一组件的覆写层越叠越多，请把新属性并进最贴近的那一层（改完用真浏览器对比 computed style，见 .agents/rules/ui-style.md 的「模糊层与层级纪律」）`
    );
    assert.ok(css.includes('  .mobile-bottom-nav {'), '@media (max-width: 768px) 里的基础定义不见了——移动端底栏会直接消失');
});

const NAV_BLOCKS_BASELINE = 10;

test('CSS - backdrop-filter 数量不再增长，只允许悬浮表面使用', () => {
    const count = (css.match(/(?:-webkit-)?backdrop-filter\s*:/g) || []).length;
    assert.ok(
        count <= BACKDROP_BASELINE,
        `backdrop-filter 从基线 ${BACKDROP_BASELINE} 涨到 ${count}——模糊层在中低端安卓上很贵。只允许导航栏、底栏、弹层遮罩、命令面板这类"浮在内容之上"的表面使用；先想清楚背后是否有可模糊的内容，并在高对比条纹页面上截图确认视觉差异，确有必要时再更新基线并说明原因`
    );
    const blocks = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const blurred = (selector) => blocks.some((m) => m[1].split(',').some((s) => s.trim() === selector) && /(?:-webkit-)?backdrop-filter\s*:/.test(m[2]));
    for (const selector of ['.super-navbar', '.reader-nav-bottom', '.modal-overlay#image-preview-modal', '.confirm-dialog-overlay', '.wikilink-autocomplete-popup']) {
        assert.ok(blurred(selector), selector + ' 的磨砂是经过对比验证的固定栏/浮层效果，不要当作冗余删掉');
    }
});

test('CSS - 应用级深色主题层：RGB 令牌反转 + 五类主表面打底', () => {
    const dark = (css.match(/:root\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/) || [''])[0];
    assert.ok(dark, '缺少 :root[data-theme="dark"] 令牌层——深色模式必须走 data-theme 属性，不要靠 filter: invert 或 JS 内联样式');
    // 亮色基线：把「标签灰」「中性命灰」拆成 RGB 分量，深色只反转分量，alpha 语义完全不变
    assert.match(css, /--label-rgb:\s*60,\s*60,\s*67/, '亮色基线 --label-rgb 被改动，会连带影响全站 rgba(var(--label-rgb), α) 的二级文字与细边框');
    assert.match(css, /--neutral-rgb:\s*120,\s*120,\s*128/, '亮色基线 --neutral-rgb 被改动，会连带影响全站 rgba(var(--neutral-rgb), α) 的中性表面底色');
    assert.match(dark, /--label-rgb:\s*235,\s*235,\s*245/, '深色层必须把 --label-rgb 反转成浅色分量，否则二级文字在深底上几乎不可见');
    assert.match(dark, /--neutral-rgb:\s*255,\s*255,\s*255/, '深色层的 --neutral-rgb 必须是白色分量，否则中性表面会变成脏灰块');
    for (const token of ['--bg-color', '--card-bg', '--text-color', '--nav-bg', '--input-bg', '--hover-bg', '--hairline', '--segment-active-bg']) {
        assert.ok(new RegExp(token + '\\s*:').test(dark), '深色层缺少主表面令牌 ' + token + '（五类主表面：导航/底栏、卡片、文字、输入框与悬浮态）');
    }
    // 分段控件的选中胶囊必须比轨道更亮，否则深色下会出现「选中的比未选中的更暗」
    assert.match(dark, /--segment-active-bg:\s*rgba\(255,\s*255,\s*255,\s*0\.16\)/, '深色层必须把分段控件选中胶囊改为半透明白，否则选中态比轨道更暗');
});

test('CSS - 灰度色值一律走 RGB 分量令牌（禁止再写回 rgba(60,60,67,α) 字面量）', () => {
    const label = (css.match(/rgba\(var\(--label-rgb\),/g) || []).length;
    const neutral = (css.match(/rgba\(var\(--neutral-rgb\),/g) || []).length;
    assert.ok(label >= 60, 'rgba(var(--label-rgb), α) 只剩 ' + label + ' 处——有人把灰度字面量写回来了，深色模式会再次出现看不清的二级文字');
    assert.ok(neutral >= 60, 'rgba(var(--neutral-rgb), α) 只剩 ' + neutral + ' 处——中性表面会脱离主题切换');
    for (const literal of ['rgba(60, 60, 67,', 'rgba(120, 120, 128,']) {
        assert.ok(!css.includes(literal), '请用 rgba(var(--label-rgb), α) / rgba(var(--neutral-rgb), α) 代替字面量 ' + literal + '（见 .agents/rules/ui-style.md 的主题令牌纪律）');
    }
});
test('CSS - 深色下会失明的旧 Tailwind 色阶不得回归，链接色走 --link-color', () => {
    // 背景：v2.5.120 用户报「深色模式下的这些链接看不清」。根因是 .rich-link-title 写死 Tailwind slate
    // #0f172a ≈ rgb(15,23,42)，在深色卡片 #1a1d23 上对比度约 1.02:1，等于隐形；同一族的 #64748b/#475569/#94a3b8
    // 也都是浅色专用灰。它们不会跟随 data-theme 反转，必须换成令牌。
    const slate = css.match(/#(?:0f172a|1e293b|334155|475569|64748b|94a3b8)\b/gi) || [];
    assert.equal(slate.length, 0, '发现写死的 Tailwind slate 色阶 ' + slate.join(', ') + '——深色下会变成看不清的深字，请改用 var(--text-color) / var(--text-color-light) / rgba(var(--label-rgb), α) 分量令牌');
    const dark = (css.match(/:root\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/) || [''])[0];
    assert.match(css, /--link-color:\s*var\(--ios-blue\)/, '亮色基线缺少 --link-color 令牌（正文链接的统一入口）');
    assert.match(dark, /--link-color:\s*#0A84FF/, '深色层必须把链接色切成 #0A84FF（Apple 深色系统蓝），#007AFF 在深底上偏暗');
    assert.match(css, /\.rich-link-title\s*\{[^}]*color:\s*var\(--text-color\)/, '链接速览卡标题必须用 var(--text-color)，不要再写死深色字');
    assert.match(css, /\.feed-content-text a\s*\{[^}]*color:\s*var\(--link-color\)/, '随手记正文里的自动链接必须有 .feed-content-text a 规则（不要用 JS 内联 style，内联样式无法被深色层覆盖）');
});
