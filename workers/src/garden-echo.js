/**
 * Garden Echo & Audit
 * AI echo cards, periodic review, web-push notification and the UGC audit entry point.
 */
import webPush from 'web-push';
import {
    jsonResponse,
    checkRateLimitShared,
    rateLimitedResponse
} from './security.js';
import {
    scanAndAudit
} from './audit.js';
import {
    callCustomLlm,
    moderateText
} from './llm.js';

export async function handleEchoGenerate(request, env, ctx, db, userId) {
    const echoLimit = await checkRateLimitShared(db, `echo:${userId}`, 20, 10 * 60 * 1000);
    if (!echoLimit.ok) return rateLimitedResponse(echoLimit.retryAfter);

    const feeds = await db.prepare('SELECT * FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 12').bind(userId).all();
    if (!feeds.results || feeds.results.length === 0) {
        return jsonResponse({ error: '暂无足够的随手记生成回响卡片，请先多记录一些思考吧！' }, 400);
    }

    const notes = await db.prepare('SELECT title, content, date FROM notes WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 5').bind(userId).all();
    const contextText = [
        ...(feeds.results || []).map(f => `[随手记 ${f.created_at || ''}] ${f.content || ''}`),
        ...(notes.results || []).map(n => `[笔记 ${n.date || ''}] ${n.title}: ${(n.content || '').slice(0, 120)}`)
    ].join('\n');

    const systemPrompt = [
        '你是用户在数字花园 Chillin 中的 AI 记忆回响助手。',
        '请根据用户近期记录，生成一张「回响卡片」。',
        '必须只输出一个 JSON 对象，不要 markdown 代码块，不要额外解释。',
        '字段：title（不超过24字的标题）、topic（2-8字主题标签）、summary（80-160字摘要，温暖有条理，提炼共性与可继续的思考，不要逐条复读原文）。'
    ].join('');
    const userPrompt = `用户近期记录：\n${contextText}\n\n请生成回响卡片 JSON。`;

    let cardTitle = '';
    let topic = '灵感脉络';
    let summary = '';
    let reply = '';
    try {
        reply = await callCustomLlm(env, systemPrompt, userPrompt);
    } catch (err) {
        console.error('Echo LLM error:', err);
    }

    if (reply) {
        try {
            const cleaned = String(reply).replace(/```json/gi, '').replace(/```/g, '').trim();
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
            cardTitle = String(parsed.title || '').trim();
            topic = String(parsed.topic || topic).trim() || topic;
            summary = String(parsed.summary || '').trim();
        } catch {
            summary = String(reply).replace(/```/g, '').trim().slice(0, 200);
            cardTitle = '近期思维回响';
        }
    }

    if (!cardTitle || !summary) {
        const recentTexts = feeds.results.map(f => f.content).filter(Boolean).slice(0, 5).join('；');
        cardTitle = cardTitle || '近期思维回响与灵感梳理';
        summary = summary || `在最近的记录中，你关注了：${recentTexts.slice(0, 120)}… 建议把这些零碎灵感进一步写成笔记或周记。`;
        topic = topic || '本地摘要';
    }

    const moderatedTitle = moderateText(cardTitle, env);
    const moderatedTopic = moderateText(topic, env);
    const moderatedSummary = moderateText(summary, env);
    if (!moderatedTitle.ok || !moderatedTopic.ok || !moderatedSummary.ok) {
        return jsonResponse({ error: '内容不合规，已拒绝生成' }, 403);
    }

    const feedIds = JSON.stringify(feeds.results.map(f => f.id));
    const newCard = await db.prepare(
        `INSERT INTO echo_cards (user_id, title, summary, topic, related_feed_ids, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now', '+8 hours')) RETURNING *`
    ).bind(userId, moderatedTitle.text, moderatedSummary.text, moderatedTopic.text, feedIds).first();

    // 尝试发送推送通知
    ctx.waitUntil((async () => {
        try {
            const subs = await db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?1').bind(userId).all();
            if (subs && subs.results && subs.results.length > 0) {
                webPush.setVapidDetails('mailto:admin@chillin.local', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
                const payload = JSON.stringify({
                    title: '✨ AI 记忆回响已生成',
                    body: `探讨了关于 ${moderatedTopic.text} 的新灵感`,
                    url: '/'
                });
                const pushPromises = subs.results.map(async sub => {
                    try {
                        await webPush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
                    } catch (err) {
                        if (err.statusCode === 404 || err.statusCode === 410) {
                            await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(sub.endpoint).run();
                        }
                    }
                });
                await Promise.all(pushPromises);
            }
        } catch (err) {
            console.error('Failed to send push notifications:', err);
        }
    })());

    return jsonResponse(newCard, 201);
}

export async function handleGetEchoCards(db, userId) {
    const cards = await db.prepare('SELECT * FROM echo_cards WHERE user_id = ?1 ORDER BY id DESC').bind(userId).all();
    return jsonResponse(cards.results || [], 200);
}

export async function handleDeleteEchoCard(id, db, userId) {
    await db.prepare('DELETE FROM echo_cards WHERE id = ?1 AND user_id = ?2').bind(id, userId).run();
    return jsonResponse({ success: true }, 200);
}

export async function handleAiReview(env, db, userId) {
    const reviewLimit = await checkRateLimitShared(db, `review:${userId}`, 20, 10 * 60 * 1000);
    if (!reviewLimit.ok) return rateLimitedResponse(reviewLimit.retryAfter);

    const [feeds, notes, weeklies] = await Promise.all([
        db.prepare("SELECT content, created_at FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 AND created_at >= datetime('now', '-7 days') ORDER BY id DESC LIMIT 30").bind(userId).all(),
        db.prepare("SELECT title, content, date FROM notes WHERE user_id = ?1 AND is_deleted = 0 AND (created_at >= datetime('now', '-7 days') OR date >= datetime('now', '-7 days')) ORDER BY id DESC LIMIT 15").bind(userId).all(),
        db.prepare("SELECT title, summary, date FROM weeklies WHERE user_id = ?1 AND is_deleted = 0 AND (created_at >= datetime('now', '-7 days') OR date >= datetime('now', '-7 days')) ORDER BY id DESC LIMIT 5").bind(userId).all()
    ]);

    const contextText = [
        ...(feeds.results || []).map(f => `[随手记 ${f.created_at || ''}] ${f.content || ''}`),
        ...(notes.results || []).map(n => `[备忘录 ${n.date || ''}] ${n.title}: ${n.content || ''}`),
        ...(weeklies.results || []).map(w => `[周记 ${w.date || ''}] ${w.title}: ${w.summary || ''}`)
    ].join('\n');

    if (!contextText.trim()) {
        return jsonResponse({ reply: '这一周还没有新的记录，去随手记里写下点什么吧。' }, 200);
    }

    const systemPrompt = '你是用户在数字花园 Chillin 中的 AI 记忆回响助手。请基于用户近期的记录生成一份「本周回顾」，按时间线或主题梳理：做了什么、关注了什么、有哪些值得留意的想法。语气温暖、简炼、有条理。';
    const userPrompt = `用户近期记录：\n${contextText}\n\n请生成本周回顾。`;

    let reply = '';
    try {
        reply = await callCustomLlm(env, systemPrompt, userPrompt);
    } catch (err) {
        console.error('Review LLM error:', err);
    }
    if (!reply) {
        reply = '本周回顾（本地摘要）：\n\n' + contextText.split('\n').slice(0, 8).map(l => '• ' + l).join('\n');
    }

    const moderated = moderateText(reply, env);
    if (!moderated.ok) {
        return jsonResponse({ error: '内容不合规，已拒绝输出' }, 403);
    }
    return jsonResponse({ reply: moderated.text }, 200);
}

export async function handleAuditScan(db, userId) {
    const result = await scanAndAudit(db, userId);
    return jsonResponse(result, 200);
}
