/**
 * 微信多图编排：一条消息多张图、连续图片批次、深度看图问答。
 *
 * 和 bot-media.js 的分工：
 *   bot-media 只管「拿到图」——识别 item、下载、解密、魔数嗅探、写 R2；
 *   本模块只管「怎么理解、怎么回、怎么暂存」——快速/深度两种模式、多图合并、待存批次。
 *
 * 默认快速识图：一张图一句短描述；多图逐张并行看，回信只等最慢的一张。
 * 用户带问题（表格/图表/截图/共同问题/对比/关系）时才走深度看图，把所有图一起交给模型。
 * 所有图片仍只暂存：回「记录」才写进随手记，未确认前绝不落业务表。
 */

import { extractClawImageItems, downloadClawImage, storeClawImage, sniffImageMagic } from './bot-media.js';
import { analyzeClawImages, describeClawImageContent, isDeepVisionQuestion } from './bot-vision.js';
import {
    saveChatTurn, savePendingMedia, readPendingMedia, parsePendingImageBatch,
    PENDING_CONFIRM_HINT, PENDING_IMAGE_BATCH_MAX_ITEMS
} from './bot-memory.js';

const MAX_CAPTION_CHARS = 2000;
const MAX_IMAGES = PENDING_IMAGE_BATCH_MAX_ITEMS;
const DEFAULT_CONTENT = '来自微信的图片';
const MAX_BATCH_CONTENT_CHARS = 2400;

function clip(text, max) {
    const s = String(text == null ? '' : text).trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
}

function fileIdFromSrc(src) {
    const m = /\/api\/file\/([^/?#]+)/.exec(String(src || ''));
    return m ? m[1] : '';
}

function uniqueCaption(caption, prior) {
    const next = String(caption || '').trim();
    const old = String(prior || '').trim();
    if (!next) return old;
    if (!old || next === old) return next;
    return old + '\n' + next;
}

function buildBatchContent(caption, items) {
    const cap = String(caption || '').trim();
    if (items.length === 1) {
        return [cap, items[0].desc].filter(Boolean).join('\n\n') || DEFAULT_CONTENT;
    }
    const lines = items.map((item, i) => '第' + (i + 1) + '张：' + (item.desc || '这次没看清'));
    return clip([cap, lines.join('\n')].filter(Boolean).join('\n\n'), MAX_BATCH_CONTENT_CHARS);
}

function mergeBatch(prior, current, caption) {
    const seen = new Set();
    const items = [];
    for (const item of [...(prior.items || []), ...current]) {
        if (!item || !item.url) continue;
        const key = item.fileId || item.url;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
    }
    return {
        caption: uniqueCaption(caption, prior.caption),
        items: items.slice(-MAX_IMAGES)
    };
}

function looksImageFollowUp(text) {
    const s = String(text || '').trim();
    if (!s || s.length > 500) return false;
    if (!/(这几张|这两张|这些图|这张图|那几张|那张图|上一张|两张|前面|刚才|截图|图片|照片|图里|图中|表格|图表)/.test(s)) return false;
    return /[?？]|什么|为什么|怎么|如何|哪里|共同|问题|分析|解释|对比|区别|关系|总结|表格|图表|数据|呢|吗/.test(s);
}

/** 从已上传的 /api/file 地址找回图片字节：优先进 R2，旧数据回退 D1 BLOB。 */
export async function loadStoredImage(env, db, userId, fileId) {
    if (!db || !userId || !fileId) return null;
    try {
        const row = await db.prepare('SELECT mime_type, r2_key, data FROM files WHERE id = ?1 AND user_id = ?2')
            .bind(String(fileId), Number(userId)).first();
        if (!row) return null;
        let bytes = null;
        if (row.r2_key && env && env.MEDIA && typeof env.MEDIA.get === 'function') {
            const obj = await env.MEDIA.get(row.r2_key);
            if (obj && typeof obj.arrayBuffer === 'function') bytes = new Uint8Array(await obj.arrayBuffer());
        }
        if (!bytes && row.data != null) {
            const raw = row.data;
            bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        }
        if (!bytes || !bytes.byteLength) return null;
        const mime = sniffImageMagic(bytes) || String(row.mime_type || '');
        return mime ? { bytes, mime } : null;
    } catch (err) {
        console.warn('[bot-image] 取回已存图片失败: ' + (err && err.message));
        return null;
    }
}

/** 统一解析「这批图」：优先 media_urls，旧行只有 media_url 时退化成单张。 */
export async function readPendingImages(db, userId) {
    const pending = await readPendingMedia(db, userId);
    if (!pending || pending.summary) return null;
    let batch = parsePendingImageBatch(pending.media_urls);
    if (!batch.items.length && pending.media_url) {
        batch = {
            caption: '',
            items: [{ url: pending.media_url, fileId: fileIdFromSrc(pending.media_url), mime: '', desc: clip(pending.content, 1200) }]
        };
    }
    return batch.items.length ? batch : null;
}

/** 快速多图的回信：逐张编号；单图保持原来「一句话 + 记录提示」的口气。 */
function fastReply(descs) {
    const clean = descs.map(d => String(d || '').trim()).filter(Boolean);
    if (!clean.length) return '图片我收好了，这次没能看清里面是什么。' + PENDING_CONFIRM_HINT;
    if (clean.length === 1) return clean[0] + PENDING_CONFIRM_HINT;
    return '收到 ' + clean.length + ' 张：\n\n' + clean.map((d, i) => (i + 1) + '. ' + d).join('\n') + PENDING_CONFIRM_HINT;
}

/**
 * 图片消息入口。返回给用户的回复；没有图片 item 时返回空串（调用方按普通消息继续）。
 * 多图/连续图都先合进同一个待存批次；未确认前只进 R2 与 bot_pending_media。
 */
export async function handleClawImageMessage(env, db, userId, msg, caption, fetchImpl = fetch) {
    const allItems = extractClawImageItems(msg);
    if (!allItems.length) return '';
    const imageItems = allItems.slice(0, MAX_IMAGES);
    const skipped = allItems.length - imageItems.length;
    const text = clip(caption, MAX_CAPTION_CHARS);
    const downloads = await Promise.all(imageItems.map(async (item) => {
        try { return await downloadClawImage(item, fetchImpl); } catch (err) { return { ok: false, note: 'exception' }; }
    }));
    const usable = downloads
        .map((download, index) => ({ download, index }))
        .filter(entry => entry.download && entry.download.ok);
    if (!usable.length) {
        console.warn('[bot-media] 图片下载失败 count=' + imageItems.length + ' notes=' + downloads.map(d => d && d.note).join(','));
        return imageItems.length > 1
            ? '这几张图我暂时拿不到原图，你换个方式再发一次试试？'
            : '这张图我暂时拿不到原图，你换个方式再发一次试试？';
    }
    const prior = await readPendingImages(db, userId);
    const priorBatch = prior || { caption: '', items: [] };
    const deep = isDeepVisionQuestion(text);
    const refersToBatch = /(这几张|这些图|刚才|前面|上面|几张|上一张|连起来)/.test(text);
    let analysisImages = usable.map(entry => ({ bytes: entry.download.bytes, mime: entry.download.mime }));
    if (deep && refersToBatch && priorBatch.items.length) {
        const old = await Promise.all(priorBatch.items.map(item => loadStoredImage(env, db, userId, item.fileId)));
        const loaded = old.filter(Boolean);
        if (loaded.length) analysisImages = [...loaded, ...analysisImages].slice(-MAX_IMAGES);
    }

    // 存图与看图并行：回信只等较慢的那个；看图失败只是没有描述，绝不阻塞暂存。
    const [stored, analysis] = await Promise.all([
        Promise.all(usable.map(entry => storeClawImage(env, db, userId, entry.download.bytes, entry.download.mime))),
        deep
            ? analyzeClawImages(env, analysisImages, { mode: 'deep', question: text, fetchImpl })
            : Promise.all(usable.map(entry => describeClawImageContent(env, entry.download.bytes, entry.download.mime, fetchImpl)))
    ]);
    const unread = imageItems.length - usable.length;
    const current = [];
    let deepDescAssigned = false;
    usable.forEach((entry, i) => {
        const src = stored[i];
        if (!src) return;
        let desc = '';
        if (deep) {
            if (!deepDescAssigned && analysis) { desc = String(analysis); deepDescAssigned = true; }
        } else {
            desc = String((analysis && analysis[i]) || '');
        }
        current.push({
            url: src,
            fileId: fileIdFromSrc(src),
            mime: entry.download.mime,
            desc
        });
    });
    if (!current.length) return '图片收到了，但没存住，稍后再发一次试试？';
    const batch = mergeBatch(priorBatch, current, text);
    const content = buildBatchContent(batch.caption, batch.items);
    const saved = await savePendingMedia(db, userId, batch.items[0].url, content, null, batch);
    if (!saved) return '图片收到了，但没能暂存，稍后再发一次试试？';

    let reply = deep
        ? (analysis
            ? String(analysis) + PENDING_CONFIRM_HINT
            : '我仔细看了这几张，这次没能看清关键内容。' + PENDING_CONFIRM_HINT)
        : fastReply(analysis);
    const notes = [];
    if (skipped) notes.push('一条消息最多看 ' + MAX_IMAGES + ' 张，后面 ' + skipped + ' 张没看');
    if (unread) notes.push('有 ' + unread + ' 张没拿到原图');
    if (notes.length) reply += '\n\n（' + notes.join('；') + '）';
    console.log('[bot-image] 已暂存 userId=' + userId + ' current=' + current.length
        + ' total=' + batch.items.length + ' deep=' + deep + ' descLen=' + String(analysis || '').length);
    await saveChatTurn(db, userId, 'user', text ? '[图片] ' + text : '[图片]');
    await saveChatTurn(db, userId, 'assistant', reply);
    return reply;
}

/**
 * 连续图片后的文字追问：「这几张截图里面有什么共同的问题？」
 * 只有有待存图片、且问句确实指向图片时才拦截；否则返回 null，交给普通聊天/RAG。
 */
export async function maybeClawImageFollowUp(env, db, userId, text, fetchImpl = fetch) {
    const question = String(text || '').trim();
    if (!looksImageFollowUp(question)) return null;
    const batch = await readPendingImages(db, userId);
    if (!batch) return null;
    const loaded = (await Promise.all(batch.items.map(item => loadStoredImage(env, db, userId, item.fileId))))
        .filter(Boolean);
    if (!loaded.length) return null;
    const answer = await analyzeClawImages(env, loaded, { mode: 'deep', question, fetchImpl });
    if (!answer) return '这几张图我暂时没看清。你可以把问题说得更具体，或者再发一次图。';
    return answer + PENDING_CONFIRM_HINT;
}
