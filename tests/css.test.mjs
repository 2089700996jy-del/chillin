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
const IMPORTANT_BASELINE = 296;

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
