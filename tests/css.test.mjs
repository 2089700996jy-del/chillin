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
const IMPORTANT_BASELINE = 300;

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
