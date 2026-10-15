import test from 'node:test';
import assert from 'node:assert/strict';
import { extractXiaoyuzhouMeta } from '../workers/src/link-enrich.js';
import { isResolvedLinkMeta, isUnresolvedLinkMeta } from '../public/js/utils.js';

const EPISODE = {
    title: 'vol.10 学习英语使我快乐',
    description: '本期我们分享了学习英语的困难与不靠谱的学习方法。',
    image: { picUrl: 'https://image.xyzcdn.net/ep.jpg' },
    podcast: { title: '谐星聊天会', image: { picUrl: 'https://image.xyzcdn.net/pod.jpg' } },
    media: { source: { url: 'http://media.xyzcdn.net/ep.m4a' } }
};
const NEXT_DATA_HTML = [
    '<!DOCTYPE html><html><head>',
    '<title>页面 title 兜底</title>',
    '<meta property="og:title" content="og 标题兜底" />',
    '</head><body>',
    '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ props: { pageProps: { episode: EPISODE } } }) + '</script>',
    '</body></html>'
].join('');

test('Link parse - extractXiaoyuzhouMeta 优先使用 __NEXT_DATA__（标题/封面/播客名/音频）', () => {
    const meta = extractXiaoyuzhouMeta(NEXT_DATA_HTML);
    assert.equal(meta.title, 'vol.10 学习英语使我快乐');
    assert.equal(meta.cover, 'https://image.xyzcdn.net/ep.jpg');
    assert.equal(meta.podcastTitle, '谐星聊天会');
    assert.equal(meta.audioUrl, 'http://media.xyzcdn.net/ep.m4a');
    assert.match(meta.description, /学习英语/);
});

test('Link parse - __NEXT_DATA__ 缺失/结构变化时退回 og: 标签', () => {
    const html = '<html><head>'
        + '<meta property="og:title" content="og 标题" />'
        + '<meta property="og:image" content="https://image.xyzcdn.net/og.jpg" />'
        + '<meta property="og:description" content="og 描述" />'
        + '</head><body></body></html>';
    const meta = extractXiaoyuzhouMeta(html);
    assert.equal(meta.title, 'og 标题');
    assert.equal(meta.cover, 'https://image.xyzcdn.net/og.jpg');
    assert.equal(meta.description, 'og 描述');
    assert.equal(meta.audioUrl, '');

    // 属性顺序颠倒（content 在前）也必须能解析
    assert.equal(extractXiaoyuzhouMeta('<meta content="反序标题" property="og:title">').title, '反序标题');
    // 只有 <title> 时也要能拿到标题
    assert.equal(extractXiaoyuzhouMeta('<html><head><title>仅 title 标签</title></head></html>').title, '仅 title 标签');
});

test('Link parse - extractXiaoyuzhouMeta 对空输入与损坏 JSON 返回空结构', () => {
    const empty = { title: '', description: '', cover: '', podcastTitle: '', audioUrl: '' };
    assert.deepEqual(extractXiaoyuzhouMeta(''), empty);
    assert.deepEqual(extractXiaoyuzhouMeta(null), empty);
    assert.deepEqual(extractXiaoyuzhouMeta(undefined), empty);
    const broken = '<script id="__NEXT_DATA__" type="application/json">{ 坏 json </script>';
    const meta = extractXiaoyuzhouMeta(broken);
    assert.equal(meta.title, '');
    assert.equal(meta.audioUrl, '');
});

test('Link parse - isResolvedLinkMeta 只认真实结果，占位/失败一律不算成功', () => {
    assert.equal(isResolvedLinkMeta(null), false);
    assert.equal(isResolvedLinkMeta({}), false);
    // Worker 明确说没解析成功时，即使带了字段也不算
    assert.equal(isResolvedLinkMeta({ resolved: false, title: '看着像标题', cover: 'https://img' }), false);
    // 占位标题（历史坏数据就是这样来的）
    assert.equal(isResolvedLinkMeta({ title: 'www.xiaoyuzhoufm.com' }), false);
    assert.equal(isResolvedLinkMeta({ title: 'xiaoyuzhoufm.com' }), false);
    assert.equal(isResolvedLinkMeta({ title: '小宇宙播客单集' }), false);
    // 标题就是 URL 本身
    assert.equal(isResolvedLinkMeta({ title: 'https://example.com/a', url: 'https://example.com/a' }), false);
    // 真实标题 / 仅有封面都算成功
    assert.equal(isResolvedLinkMeta({ title: 'vol.10 学习英语使我快乐' }), true);
    assert.equal(isResolvedLinkMeta({ title: '', cover: 'https://image.xyzcdn.net/og.jpg' }), true);
});

test('Link parse - isUnresolvedLinkMeta 决定何时该补解析', () => {
    const xyz = 'https://www.xiaoyuzhoufm.com/episode/5e280fa7418a84a0461f91a8';
    assert.equal(isUnresolvedLinkMeta(null, xyz), true);
    assert.equal(isUnresolvedLinkMeta({ title: 'www.xiaoyuzhoufm.com', cover: '' }, xyz), true);
    assert.equal(isUnresolvedLinkMeta({ title: '小宇宙播客单集' }, xyz), true);
    // 小宇宙：只有标题没有封面也继续补解析
    assert.equal(isUnresolvedLinkMeta({ title: 'vol.10 学习英语使我快乐' }, xyz), true);
    assert.equal(isUnresolvedLinkMeta({ title: 'vol.10 学习英语使我快乐', cover: 'https://img' }, xyz), false);
    // 通用链接：标题正常就不再反复请求
    assert.equal(isUnresolvedLinkMeta({ title: '某篇文章标题' }, 'https://example.com/a'), false);
    assert.equal(isUnresolvedLinkMeta({ title: '' }, 'https://example.com/a'), true);
});
