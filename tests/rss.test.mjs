import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRssOrAtom } from '../workers/src/garden-media.js';

test('RSS Podcast - parseRssOrAtom extracts channel, latest episode, artwork and audio enclosure', () => {
    const podcastRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title><![CDATA[声东击西]]></title>
    <description><![CDATA[这是一档探讨时代变迁与文化思潮的播客]]></description>
    <itunes:image href="http://assets.fireside.fm/cover.jpg"/>
    <item>
      <title><![CDATA[#406 从景山骑到三里屯]]></title>
      <description><![CDATA[<p>十年特别节目，一起上街骑车。<a href="https://example.com">详情</a></p>]]></description>
      <itunes:image href="http://assets.fireside.fm/ep406.jpg"/>
      <enclosure url="http://aphid.fireside.fm/episode406.mp3" length="50000000" type="audio/mpeg"/>
    </item>
  </channel>
</rss>`;

    const res = parseRssOrAtom(podcastRss);
    assert.ok(res !== null, 'RSS parser should return a parsed object');
    assert.equal(res.title, '#406 从景山骑到三里屯');
    assert.equal(res.siteName, '声东击西 · 播客');
    assert.equal(res.platform, '播客 (RSS)');
    assert.equal(res.icon, '🎙️');
    assert.equal(res.audioUrl, 'https://aphid.fireside.fm/episode406.mp3', 'Audio url should be upgraded to HTTPS');
    assert.equal(res.cover, 'https://assets.fireside.fm/ep406.jpg', 'Episode cover should take priority and be HTTPS');
    assert.ok(res.description.includes('十年特别节目，一起上街骑车'), 'Description should strip HTML tags');
    assert.ok(!res.description.includes('<p>'), 'Description should not contain HTML tags');
});

test('RSS Blog - parseRssOrAtom handles regular text RSS feeds without audio', () => {
    const blogRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>数字花园日志</title>
    <description>常青笔记与思维漫游</description>
    <image>
      <url>https://example.com/logo.png</url>
    </image>
    <item>
      <title>如何构建第二大脑</title>
      <description>关于知识管理与双链笔记的实践心得。</description>
    </item>
  </channel>
</rss>`;

    const res = parseRssOrAtom(blogRss);
    assert.ok(res !== null);
    assert.equal(res.title, '如何构建第二大脑');
    assert.equal(res.siteName, '数字花园日志 · 播客');
    assert.equal(res.platform, 'RSS 订阅');
    assert.equal(res.icon, '📰');
    assert.equal(res.audioUrl, '');
    assert.equal(res.cover, 'https://example.com/logo.png');
});

test('RSS Feed - parseRssOrAtom handles Atom XML feeds', () => {
    const atomXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>科技思考</title>
  <entry>
    <title>边缘计算与 Serverless 革命</title>
    <content type="html"><![CDATA[<p>Cloudflare Workers 重新定义了全栈开发。</p>]]></content>
  </entry>
</feed>`;

    const res = parseRssOrAtom(atomXml);
    assert.ok(res !== null);
    assert.equal(res.title, '边缘计算与 Serverless 革命');
    assert.ok(res.description.includes('Cloudflare Workers 重新定义了全栈开发。'));
});

test('RSS Guard - parseRssOrAtom rejects non-XML HTML content gracefully', () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>Some Webpage</title></head>
<body>Hello world</body>
</html>`;

    assert.equal(parseRssOrAtom(html), null);
    assert.equal(parseRssOrAtom(''), null);
    assert.equal(parseRssOrAtom(null), null);
});
