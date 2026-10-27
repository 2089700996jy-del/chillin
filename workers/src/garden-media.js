/**
 * Garden Media Module
 * 图片上传与带令牌校验的下发。
 * 二进制统一放 R2（D1 只留元数据），未绑定 R2 时回退到旧的 D1 BLOB 存储。
 */
import {
    jsonResponse,
    applySecurityHeaders,
    checkRateLimitShared,
    rateLimitedResponse,
    timingSafeEqualStr,
    sniffImageMime
} from './security.js';

const MAX_SIZE = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
// URL 里的访问令牌 30 天有效。图片会长期留在笔记正文里，过期后不删图：
// 所有者本人登录仍可看，只有被转发的裸链接会失效。
export const MEDIA_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** R2 对象键：按用户分目录，便于日后按用户整目录清理 */
function mediaObjectKey(userId, fileId) {
    return `uploads/${userId}/${fileId}`;
}

export async function handleUpload(request, env, db, userId) {
    const uploadLimit = await checkRateLimitShared(db, `upload:${userId}`, 60, 10 * 60 * 1000);
    if (!uploadLimit.ok) return rateLimitedResponse(uploadLimit.retryAfter);

    // 快速拒绝：先看声明的 Content-Length（multipart 额外留 64KB 边界开销），
    // 避免把超大请求整体读入内存后再判长度。
    const declaredLength = Number(request.headers.get('Content-Length') || 0);
    if (declaredLength && declaredLength > MAX_SIZE + 64 * 1024) {
        return jsonResponse({ error: '文件过大，最大支持 5MB' }, 413);
    }

    try {
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) return jsonResponse({ error: 'No file uploaded' }, 400);

        // File.size 在读取内容前即可用：超限文件不再复制进内存
        if (typeof file.size === 'number' && file.size > MAX_SIZE) {
            return jsonResponse({ error: '文件过大，最大支持 5MB' }, 413);
        }

        const arrayBuffer = await file.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_SIZE) {
            return jsonResponse({ error: '文件过大，最大支持 5MB' }, 413);
        }
        const sniffed = sniffImageMime(new Uint8Array(arrayBuffer));
        const claimed = (file.type || '').toLowerCase();
        if (!sniffed || !ALLOWED_MIME.has(sniffed)) {
            return jsonResponse({ error: '仅支持 JPEG / PNG / GIF / WEBP 图片' }, 400);
        }
        if (claimed && claimed !== 'application/octet-stream' && claimed !== sniffed) {
            return jsonResponse({ error: '文件类型与内容不匹配' }, 400);
        }

        const id = crypto.randomUUID();
        const accessToken = crypto.randomUUID();
        const tokenExpiresAt = Date.now() + MEDIA_TOKEN_TTL_MS;
        const r2Key = mediaObjectKey(userId, id);

        if (env && env.MEDIA) {
            // 二进制进 R2，D1 只写入可检索的元数据
            await env.MEDIA.put(r2Key, arrayBuffer, {
                httpMetadata: { contentType: sniffed, cacheControl: 'private, max-age=86400' }
            });
            await db.prepare("INSERT INTO files (id, mime_type, r2_key, size, access_token, token_expires_at, user_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now', '+8 hours'))")
                .bind(id, sniffed, r2Key, arrayBuffer.byteLength, accessToken, tokenExpiresAt, userId).run();
        } else {
            // 兜底：尚未绑定 R2 的部署仍按老办法写 D1（0020 之后 data 列可空）
            await db.prepare("INSERT INTO files (id, mime_type, data, access_token, token_expires_at, user_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', '+8 hours'))")
                .bind(id, sniffed, new Uint8Array(arrayBuffer), accessToken, tokenExpiresAt, userId).run();
        }

        return jsonResponse([{ src: `/api/file/${id}?t=${accessToken}` }], 201);
    } catch (err) {
        console.error('[upload] error:', err);
        return jsonResponse({ error: '上传失败' }, 500);
    }
}

export async function handleFileView(fileId, request, env, db, authenticate) {
    if (!fileId) return new Response('Not Found', { status: 404 });
    const row = await db.prepare('SELECT mime_type, data, r2_key, access_token, token_expires_at, user_id FROM files WHERE id = ?1').bind(fileId).first();
    if (!row) return new Response('Not Found', { status: 404 });

    // 读图有两条路：① 有效的访问令牌（分享/外链/导出后仍可看）；② 文件所有者本人登录。
    // 令牌过期后不再给匿名访问，但本人登录仍能看——否则历史笔记里的图片会集体裂开。
    const fileToken = new URL(request.url).searchParams.get('t') || '';
    const tokenValid = row.access_token != null && row.access_token !== ''
        && timingSafeEqualStr(row.access_token, fileToken)
        && (row.token_expires_at == null || Number(row.token_expires_at) > Date.now());

    if (!tokenValid) {
        const viewerId = await authenticate(request, db);
        if (!viewerId || row.user_id == null || Number(row.user_id) !== Number(viewerId)) {
            return new Response('Forbidden', { status: 403, headers: applySecurityHeaders(new Headers()) });
        }
        if (!row.access_token) {
            const newToken = crypto.randomUUID().replace(/-/g, '');
            await db.prepare('UPDATE files SET access_token = ?1 WHERE id = ?2 AND access_token IS NULL')
                .bind(newToken, fileId).run();
        }
    }

    // 优先 R2：支持 Range（断点续传 / 图片分块预览），并回传 ETag 供浏览器协商缓存
    if (row.r2_key && env && env.MEDIA) {
        // 只有客户端明确要区间才当成分片：R2 读整对象时同样会回传 range 元信息，
        // 不额外判断的话普通 GET 会被错误地标成 206 Partial Content（线上实测）。
        const rangeHeader = request.headers.get('Range');
        const obj = await env.MEDIA.get(row.r2_key, rangeHeader ? { range: request.headers } : undefined);
        if (!obj || !obj.body) {
            return new Response('Not Found', { status: 404, headers: applySecurityHeaders(new Headers()) });
        }
        const headers = applySecurityHeaders(new Headers({
            'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || row.mime_type || 'application/octet-stream',
            'Cache-Control': 'private, max-age=86400',
            'X-Robots-Tag': 'noindex, nofollow, noarchive',
            'Content-Disposition': 'inline',
            'Accept-Ranges': 'bytes'
        }));
        if (obj.httpEtag) headers.set('ETag', obj.httpEtag);

        let status = 200;
        if (rangeHeader && obj.range) {
            // R2 只回了请求片段：必须补 206 与 Content-Range，否则浏览器会误判图片损坏
            const offset = obj.range.offset || 0;
            const length = obj.range.length == null ? obj.size - offset : obj.range.length;
            headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
            headers.set('Content-Length', String(length));
            status = 206;
        } else if (typeof obj.size === 'number') {
            headers.set('Content-Length', String(obj.size));
        }
        return new Response(request.method === 'HEAD' ? null : obj.body, { status, headers });
    }

    // 兼容路径：迁移脚本跑完之前的历史行仍存在 D1 BLOB 里
    let responseData = row.data;
    if (Array.isArray(responseData)) responseData = new Uint8Array(responseData);
    else if (responseData instanceof ArrayBuffer) responseData = new Uint8Array(responseData);

    return new Response(responseData, {
        status: 200,
        headers: applySecurityHeaders(new Headers({
            'Content-Type': row.mime_type || 'application/octet-stream',
            'Cache-Control': 'private, max-age=86400',
            'X-Robots-Tag': 'noindex, nofollow, noarchive',
            'Content-Disposition': 'inline'
        }))
    });
}

/**
 * 清理 R2 里过期的 D1 备份快照（由每小时定时任务调用）。
 * 规则：最新的 keep 份无论多旧都保留；其余超过 maxAgeMs 的删除。
 */
export async function pruneOldBackups(env, { prefix = 'backups/', maxAgeMs = 30 * 24 * 60 * 60 * 1000, keep = 3 } = {}) {
    if (!env || !env.MEDIA) return { scanned: 0, deleted: 0 };
    // R2 list 单次最多回 1000 个 key，且按 key 字典序（备份名带日期前缀 → 最旧的在第一页）。
    // 只读第一页会把 keep 用在最旧的几份上，必须翻完全部分页再按上传时间排序。
    const objects = [];
    let cursor;
    do {
        const listed = await env.MEDIA.list(cursor ? { prefix, cursor } : { prefix });
        objects.push(...(listed.objects || []));
        cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    objects.sort((a, b) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime());

    let deleted = 0;
    for (let i = 0; i < objects.length; i++) {
        if (i < keep) continue;
        const uploaded = new Date(objects[i].uploaded).getTime();
        if (Number.isFinite(uploaded) && Date.now() - uploaded > maxAgeMs) {
            await env.MEDIA.delete(objects[i].key);
            deleted++;
        }
    }
    return { scanned: objects.length, deleted };
}
