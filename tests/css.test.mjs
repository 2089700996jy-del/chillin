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
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public', 'manifest.json'), 'utf8'));

// 基线：这里只许变小，不许变大
// v2.5.154：底栏选中态改实心字形时删掉 3 处——.mobile-tab-item.active 的 color !important
// 会永久压死阅读器夜间/护眼那两条更具体的选择器，:active .tab-icon 的 transform/transition
// 两条 !important 也已被全局 scale(0.95) 的按下反馈取代。
// v2.5.160：+1 —— 输入框的键盘焦点环必须 !important 才能压过各模块自带的
// :focus{outline:none}（auth/搜索/编辑器各写了一套），否则 Tab 到输入框时看不见焦点。
const IMPORTANT_BASELINE = 227;

test('CSS - theme-color / manifest 与页面底色一致（iOS 状态栏不出现色带）', () => {
    const bg = (css.match(/--ios-bg:\s*(#[0-9A-Fa-f]{6})/) || [])[1];
    assert.ok(bg, 'style.css 应定义 --ios-bg');
    const meta = (indexHtml.match(/<meta name="theme-color" content="(#[0-9A-Fa-f]{6})"/) || [])[1];
    assert.equal(meta && meta.toUpperCase(), bg.toUpperCase(), 'index.html 的 theme-color 必须等于 --ios-bg（原先 #F2F2F7 与页面 #F8F9FA 有色差）');
    assert.equal(manifest.theme_color.toUpperCase(), bg.toUpperCase(), 'manifest.theme_color 必须等于 --ios-bg');
    assert.equal(manifest.background_color.toUpperCase(), bg.toUpperCase(), 'manifest.background_color 必须等于 --ios-bg');
    assert.match(indexHtml, /dark \? '#0f1115' : '#F8F9FA'/, 'head 内联脚本的浅色 theme-color 也要同步');
  });

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
// v2.5.160：+1 —— 深色主按钮的强调文字色 #4A9EFF（浅色层新增的 --danger-color / --danger-fill
// 与 --accent-text 复用/替换了原有 hex，净增 1）。
const HEX_BASELINE = 127;

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
    // 每一层都靠 !important 抢优先级。已合并为 9 块（v2.5.174 移除 iOS PWA 的重复 padding 层），这里只许变小，不许再往上加。
    const blocks = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => m[1].split(',').some((s) => s.trim().endsWith('.mobile-bottom-nav')));
    assert.ok(
        blocks.length <= NAV_BLOCKS_BASELINE,
        `.mobile-bottom-nav 的定义块从 ${NAV_BLOCKS_BASELINE} 涨到 ${blocks.length}——同一组件的覆写层越叠越多，请把新属性并进最贴近的那一层（改完用真浏览器对比 computed style，见 .agents/rules/ui-style.md 的「模糊层与层级纪律」）`
    );
    assert.ok(css.includes('  .mobile-bottom-nav {'), '@media (max-width: 768px) 里的基础定义不见了——移动端底栏会直接消失');
});

const NAV_BLOCKS_BASELINE = 9;

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

test('CSS - 固定栏取色同源：--bg-rgb 与 --ios-bg 同值，底栏是悬浮胶囊 dock', () => {
    const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
    const pick = (source, name) => ((source.match(new RegExp(name + '\\s*:\\s*(#[0-9a-fA-F]{6})')) || [''])[1]);
    const lightBg = pick(css, '--ios-bg');
    const lightRgb = (css.match(/--bg-rgb:\s*([\d,\s]+);/) || [''])[1].replace(/\s+/g, ' ').trim();
    assert.ok(lightBg && lightRgb, '缺少 --ios-bg 或 --bg-rgb：固定栏（顶栏/底栏）取色必须由页面底色分量派生，否则会和 hero 光晕出现色阶断层');
    assert.equal(lightRgb, toRgb(lightBg), '--bg-rgb 与亮色 --ios-bg 不同步（' + lightRgb + ' vs ' + toRgb(lightBg) + '）：导航玻璃层/底栏会再次和页面底色出现色阶断层');
    const dark = (css.match(/:root\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/) || [''])[0];
    const darkBg = pick(dark, '--ios-bg');
    const darkRgb = (dark.match(/--bg-rgb:\s*([\d,\s]+);/) || [''])[1].replace(/\s+/g, ' ').trim();
    assert.ok(darkBg && darkRgb, '深色层缺少 --ios-bg 或 --bg-rgb');
    assert.equal(darkRgb, toRgb(darkBg), '--bg-rgb 与深色 --ios-bg 不同步：深色底栏会再次和页面底色出现色阶断层');
    // 静止态顶栏不铺不透明底色，页面 hero 光晕才能从固定栏后面透出来
    assert.match(css, /\.super-navbar\s*\{[^}]*background:\s*transparent/, '顶栏静止态必须 background: transparent，否则会挡住页面 hero 光晕、在栏底留下色阶断层');

    const navBlock = (css.match(/\.mobile-bottom-nav\s*\{([^}]*background:\s*var\(--nav-scrolled-bg\)[^}]*)\}/s) || ['', ''])[1];
    assert.ok(navBlock, '找不到移动端底栏基础规则（必须复用 --nav-scrolled-bg）');
    assert.match(navBlock, /left:\s*12px/, '底栏必须左右各留 12px，否则又变回横贯屏幕的一条板');
    assert.match(navBlock, /right:\s*12px/, '底栏右侧必须留 12px');
    assert.match(navBlock, /bottom:\s*calc\(8px \+ env\(safe-area-inset-bottom, 0px\)\)/, '底栏底部必须叠 safe-area 后留 8px，不能贴死手势条');
    assert.match(navBlock, /height:\s*62px/, '底栏高度必须是 62px 的胶囊，不是自动高度的通栏');
    assert.match(navBlock, /border-radius:\s*22px/, '底栏必须是 22px 圆角的悬浮胶囊');
    assert.match(navBlock, /border:\s*1px solid var\(--surface-hairline\)/, '胶囊边界必须是极细 hairline，不能画回 1px 硬分割线');
    assert.match(navBlock, /box-shadow:\s*var\(--card-shadow\)/, '悬浮胶囊必须用 --card-shadow 提供与卡片的同一套柔和层次');
    assert.ok(!/height:\s*auto/.test(navBlock), '底栏又退回 height: auto 的通栏了');
    assert.ok(!/border-top/.test(navBlock), '悬浮胶囊不再画顶边线（会被读成一条横板）');
    assert.match(navBlock, /backdrop-filter:\s*blur\(20px\)\s*saturate\(180%\)/, '底栏必须做 blur(20px) saturate(180%) 毛玻璃，否则内容滚到胶囊后时是一块死板、不够通透');
    assert.ok(!/\.mobile-bottom-nav[^{]*\{[^}]*box-shadow:\s*0 -1px 0/.test(css), '底栏不得再画 0 -1px 0 分割线（见 .agents/rules/ui-style.md §3.5）');
    assert.match(navBlock, /transition:\s*transform[^;]*opacity/, '底栏必须有 transform/opacity 过渡，滚动收起才平滑');
    const scrollHidden = (css.match(/\.mobile-bottom-nav\.scroll-hidden\s*\{([^}]*)\}/) || ['', ''])[1];
    assert.match(scrollHidden, /transform:\s*translateY\(calc\(100% \+ 20px\)\)/, '滚动收起必须平移出视口，不能瞬间消失');
    assert.match(scrollHidden, /opacity:\s*0/, '滚动收起必须淡出');
    assert.match(scrollHidden, /pointer-events:\s*none/, '滚动收起时不能拦截点击');
    assert.match(css, /\.mobile-tab-item\.active\s*\{[^}]*background:\s*rgba\(var\(--label-rgb\),\s*0\.06\)/, '选中项必须是浅色胶囊，不能只靠蓝色文字点亮整条底栏');
});

test('CSS - 灰度色值一律走 RGB 分量令牌（禁止再写回 rgba(60,60,67,α) 字面量）', () => {
    const label = (css.match(/rgba\(var\(--label-rgb\),/g) || []).length;
    const neutral = (css.match(/rgba\(var\(--neutral-rgb\),/g) || []).length;
    assert.ok(label >= 50, 'rgba(var(--label-rgb), α) 只剩 ' + label + ' 处——有人把灰度字面量写回来了，深色模式会再次出现看不清的二级文字（v2.5.160 把 5 处 placeholder 收敛到 --placeholder-color，下限从 60 调到 50）');
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

test('CSS - 长列表密度与滚动（A1 紧凑行 / B1 content-visibility / C1 回到顶部）', () => {
    // A1：紧凑行必须是「双类」选择器（0,2,0）——文件后部另有一条同优先级的
    // .feed-item-card { padding: 18px 20px }，只写单类会被它按「后来者胜」改回原密度，
    // 肉眼看是「紧凑样式没生效」，但静态检查完全发现不了。
    assert.match(css, /\.feed-item-card\.feed-item-card--compact\s*\{[^}]*padding:\s*10px\s+14px/,
        '紧凑行必须用 .feed-item-card.feed-item-card--compact（0,2,0）并给出更紧的内边距，否则会被后部的 .feed-item-card 覆写回原密度');
    // B1：屏外卡片不参与布局与绘制；占位高度必须按真实卡高给，否则滚动条会虚胖
    // （实测 160px 占位 → 列表从 10.3 屏变 12.9 屏；实测 510 条强制布局 103ms → 5.8ms）
    assert.match(css, /\.feed-item-card\s*\{[^}]*content-visibility:\s*auto/,
        '.feed-item-card 缺少 content-visibility: auto——长列表会为屏外卡片白白付出布局与绘制成本');
    assert.match(css, /\.feed-item-card\s*\{[^}]*contain-intrinsic-size:\s*auto\s+150px/,
        '.feed-item-card 的 contain-intrinsic-size 必须按真实卡高（auto 150px）给，估错会让滚动条虚胖');
    // 周记画廊刻意不做：>=768px 是 column-count: 2 的多列容器，多列里做尺寸 containment 有布局风险
    assert.ok(!/\.notion-collection-card\s*\{[^}]*content-visibility:\s*auto/.test(css),
        '不要给 .notion-collection-card 加 content-visibility——周记画廊在桌面是多列容器（column-count: 2），尺寸 containment 会破坏分列');
    // C1：回到顶部按钮默认 opacity + visibility 双关闭。只写 opacity 的话，
    // 一个「看不见」的按钮仍留在 Tab 序列与读屏里（用户 Tab 过去会停在空气上）。
    assert.match(css, /\.back-to-top\s*\{[^}]*opacity:\s*0/, '回到顶部按钮默认必须 opacity: 0');
    assert.match(css, /\.back-to-top\s*\{[^}]*visibility:\s*hidden/, '回到顶部按钮默认必须 visibility: hidden（只写 opacity 的话隐形按钮仍在键盘与读屏序列里）');
    assert.match(css, /\.back-to-top\.is-visible\s*\{[^}]*visibility:\s*visible/, '缺少 .back-to-top.is-visible 的显示态');
    assert.match(css, /\.back-to-top\.above-fab\s*\{[^}]*bottom:\s*calc\(134px\s*\+\s*env\(safe-area-inset-bottom/,
        '回到顶部按钮需要 .above-fab 上移一格，否则会和 FAB 圆钮叠在一起（两个 44px 圆钮同角）');
    // B2：自动续载后「加载更多」退化成一条低调提示条，但兜底按钮仍要能用（无 IntersectionObserver 的浏览器）
    assert.match(css, /\.list-load-more--auto\s*\{[^}]*background:\s*transparent/,
        '.list-load-more--auto 必须是一条低调提示条，否则滚到底会自动闪出一颗实体按钮');
});
test('CSS - 底栏选中态是实心字形而非缩放，且主题覆盖不再被 !important 压死', () => {
    // Konsta §2C：iOS 的 Tab 选中是 filled variant（实心字形 + tint），不是把描边图标放大。
    // 描边字形与实心字形同时存在于 DOM，靠 display 切换，这样 fill 能跟随 color 一起过渡。
    assert.match(css, /\.mobile-tab-item \.tab-svg-fill\s*\{[^}]*display:\s*none/,
        '实心字形默认必须 display: none，否则未选中的 Tab 会显示两份叠在一起的图标');
    assert.match(css, /\.mobile-tab-item\.active \.tab-svg-fill\s*\{[^}]*display:\s*block/,
        '选中态必须显示实心字形（.active .tab-svg-fill { display: block }）');
    assert.match(css, /\.mobile-tab-item\.active \.tab-svg-outline\s*\{[^}]*display:\s*none/,
        '选中态必须隐藏描边字形，否则实心与描边会重叠成毛边');
    assert.ok(!/\.mobile-tab-item\.active \.tab-icon\s*\{[^}]*transform/.test(css),
        '选中态不得再用 scale/translateY——那会和按下时的全局 scale(0.95) 叠加成「选中反而更小」的错觉（v2.5.154 已删）');
    // 选中色一旦带 !important，就会压死后面更具体的阅读器/深色覆盖（选择器再具体也没用）
    const activeColorBlocks = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => m[1].split(',').some((s) => /\.mobile-tab-item\.active$/.test(s.trim())));
    assert.ok(activeColorBlocks.length > 0, '找不到 .mobile-tab-item.active 的规则块');
    for (const m of activeColorBlocks) {
        assert.ok(!/!important/.test(m[2]), '底栏选中色又写上了 !important：' + m[1].trim() + '（会永久压死阅读器夜间/护眼底色）');
    }
    assert.match(css, /body\.dark-reader-body \.mobile-tab-item\.active\s*\{[^}]*color:\s*var\(--ios-blue-dark\)/,
        '夜间阅读器底栏选中色必须生效（--ios-blue-dark），v2.5.154 前它被 !important 压死过');
    assert.match(css, /body\.eyecare-reader-body \.mobile-tab-item\.active\s*\{[^}]*color:\s*var\(--garden-green\)/,
        '护眼阅读器底栏选中色必须生效（--garden-green）');
    assert.match(css, /:root\[data-theme="dark"\] \.mobile-tab-item\.active\s*\{[^}]*color:\s*var\(--ios-blue-dark\)/,
        '应用级深色主题的底栏选中色必须切到 #0A84FF（--ios-blue-dark）：#007AFF 在深色玻璃上对比度只有 4.70');
});

test('CSS - 关键文本/控件对比度达到 WCAG AA（亮/暗双主题）', () => {
    // 真浏览器审计（axe-core + Chrome，v2.5.160）把结论固化成静态门禁：
    // 任何一次令牌微调如果让下面这些组合跌破 4.5:1，这里会先失败，而不是等用户看不清。
    const tokenBlock = (re) => {
        const m = css.match(re);
        assert.ok(m, '缺少令牌块：' + re);
        const map = {};
        for (const line of m[1].split('\n')) {
            const kv = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/);
            if (kv) map[kv[1]] = kv[2].trim();
        }
        return map;
    };
    const light = tokenBlock(/:root\s*\{([\s\S]*?)\n\}/);
    const darkLayer = tokenBlock(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
    // 深色层只覆盖变化项，其余继承亮色令牌
    const dark = { ...light, ...darkLayer };

    const resolve = (value, tokens, depth = 0) => {
        if (depth > 6 || !value.includes('var(')) return value;
        return resolve(value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g,
            (_, name, fallback) => tokens[name] ?? fallback ?? ''), tokens, depth + 1);
    };
    const parse = (raw) => {
        const value = raw.trim();
        if (value.startsWith('#')) {
            const h = value.slice(1);
            const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
            return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)).concat(1);
        }
        const nums = value.match(/-?\d*\.?\d+/g);
        assert.ok(nums && nums.length >= 3, '无法解析颜色：' + raw);
        return [Number(nums[0]), Number(nums[1]), Number(nums[2]), nums.length > 3 ? Number(nums[3]) : 1];
    };
    const blend = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    const luminance = (rgb) => {
        const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
    };
    const contrast = (fgName, bgName, tokens) => {
        const fg = parse(resolve(tokens[fgName], tokens));
        const bg = parse(resolve(tokens[bgName], tokens));
        const solid = blend(fg, bg);
        const l1 = luminance(solid), l2 = luminance(bg);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    const pairs = [
        ['正文/页面', '--text-color', '--ios-bg'],
        ['正文/卡片', '--text-color', '--ios-card-bg'],
        ['次要文字/页面', '--ios-secondary-label', '--ios-bg'],
        ['次要文字/卡片', '--ios-secondary-label', '--ios-card-bg'],
        ['链接/页面', '--link-color', '--ios-bg'],
        ['链接/卡片', '--link-color', '--ios-card-bg'],
        ['底栏未选中/页面', '--tab-inactive', '--ios-bg'],
        ['主按钮白字/蓝底', '--white', '--ios-blue'],
        ['危险文字/卡片', '--danger-color', '--ios-card-bg'],
        ['危险按钮白字/红底', '--white', '--danger-fill'],
        ['占位文字/卡片', '--placeholder-color', '--ios-card-bg'],
        ['键盘焦点环/页面', '--focus-ring-color', '--ios-bg'],
    ];
    for (const [label, fg, bg] of pairs) {
        const ratio = contrast(fg, bg, light);
        // 焦点环属于「非文本 UI 组件」，WCAG 2.4.11 要求 3:1；其余文字组合要求 4.5:1
        const min = label.includes('焦点环') ? 3 : 4.5;
        assert.ok(ratio >= min, `亮色「${label}」只有 ${ratio.toFixed(2)}:1，低于 ${min}:1`);
    }

    const darkPairs = [
        ['正文/页面', '--text-color', '--ios-bg'],
        ['正文/卡片', '--text-color', '--ios-card-bg'],
        ['次要文字/页面', '--ios-secondary-label', '--ios-bg'],
        ['次要文字/卡片', '--ios-secondary-label', '--ios-card-bg'],
        ['强调文字/页面', '--accent-text', '--ios-bg'],
        ['强调文字/卡片', '--accent-text', '--ios-card-bg'],
        ['链接/页面', '--link-color', '--ios-bg'],
        ['底栏未选中/页面', '--tab-inactive', '--ios-bg'],
        ['主按钮白字/蓝底', '--white', '--ios-blue'],
        ['危险文字/卡片', '--danger-color', '--ios-card-bg'],
        ['危险按钮白字/红底', '--white', '--danger-fill'],
        ['键盘焦点环/页面', '--focus-ring-color', '--ios-bg'],
    ];
    for (const [label, fg, bg] of darkPairs) {
        const ratio = contrast(fg, bg, dark);
        const min = label.includes('焦点环') ? 3 : 4.5;
        assert.ok(ratio >= min, `深色「${label}」只有 ${ratio.toFixed(2)}:1，低于 ${min}:1`);
    }

    // 深色层必须真的覆盖这些角色，否则会回落到浅色值（登录页曾经整片黑字压在深底上）
    for (const name of ['--accent-text', '--danger-color', '--danger-fill', '--link-color', '--tab-inactive']) {
        assert.ok(dark[name], '深色层缺少 ' + name + ' 覆盖');
    }
});

test('CSS - 键盘焦点可见：全局 reset 只吞指针焦点，Tab 焦点有 2px 焦点环', () => {
    const resetAt = css.search(/:focus:not\(:focus-visible\)/);
    assert.ok(resetAt >= 0, '全局焦点 reset 必须写成 :focus:not(:focus-visible)，否则 Tab 焦点会被一起清掉');
    // 反例：裸 :focus 的 outline:none 会把键盘焦点也吞掉（v2.5.159 之前的写法）
    assert.ok(!/(^|\n)button:focus\s*,/.test(css), '不要再用裸 button:focus 清除轮廓——键盘用户会完全失去焦点位置');
    assert.ok(!/\n\.btn-primary:focus\s*,/.test(css), '不要再用裸 .btn-primary:focus 清除轮廓');

    const ringAt = css.search(/:focus-visible\s*\{\s*\n\s*outline:\s*2px solid var\(--focus-ring-color\)/);
    assert.ok(ringAt > resetAt, '全局 :focus-visible 焦点环必须存在，并且写在 reset 之后');
    assert.match(css, /input:focus-visible[\s\S]{0,500}outline:\s*2px solid var\(--focus-ring-color\)\s*!important/,
        '输入框需要单独的 :focus-visible 规则（模块自带的 :focus{outline:none} 优先级更高）');
    assert.match(css, /outline-offset:\s*2px/, '焦点环要留 2px offset，否则会贴在按钮边缘看不清');
});

test('CSS - 次级元信息颜色走主题令牌（整页审计的 5 处灰字）', () => {
    const block = (selector) => {
        const start = css.indexOf('\n' + selector + ' {');
        assert.ok(start >= 0, '缺少选择器 ' + selector);
        return css.slice(start, css.indexOf('}', start));
    };
    for (const selector of ['.note-item-date', '.feed-date', '.feed-tag-pill', '.k-topic-tier-pill', '.k-shelf-count-badge', '.k-shelf-card-snippet']) {
        assert.match(block(selector), /color:\s*var\(--text-color-light\)/, selector + ' 的次级文字必须走主题令牌，裸灰值在深色/夜间下会失去对比度');
    }
    assert.match(block('.feed-tag-pill'), /background:\s*rgba\(var\(--neutral-rgb\)/, 'feed 标签底色要跟随主题反转');
    for (const selector of ['.bookmark-card-type', '.bookmark-card-desc']) {
        assert.match(block(selector), /color:\s*rgba\(var\(--label-rgb\), 0\.85\)/, selector + ' 在卡片底色上只有 4.45:1，必须加深到 0.85');
    }
});
