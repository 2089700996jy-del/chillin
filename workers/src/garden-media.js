/**
 * Garden Media Module
 * Image upload and authenticated file delivery.
 */
import {
    jsonResponse,
    applySecurityHeaders,
    checkRateLimitShared,
    rateLimitedResponse,
    timingSafeEqualStr,
    sniffImageMime
} from './security.js';

export async function handleUpload(request, db, userId) {
    const uploadLimit = await checkRateLimitShared(db, `upload:${userId}`, 60, 10 * 60 * 1000);
    if (!uploadLimit.ok) return rateLimitedResponse(uploadLimit.retryAfter);

    const MAX_SIZE = 5 * 1024 * 1024;
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
        const bytes = new Uint8Array(arrayBuffer);
        const sniffed = sniffImageMime(bytes);
        const claimed = (file.type || '').toLowerCase();
        const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
        if (!sniffed || !ALLOWED_MIME.has(sniffed)) {
            return jsonResponse({ error: '仅支持 JPEG / PNG / GIF / WEBP 图片' }, 400);
        }
        if (claimed && claimed !== 'application/octet-stream' && claimed !== sniffed) {
            return jsonResponse({ error: '文件类型与内容不匹配' }, 400);
        }
        const id = crypto.randomUUID();
        const accessToken = crypto.randomUUID();
        await db.prepare('INSERT INTO files (id, mime_type, data, access_token, user_id) VALUES (?1, ?2, ?3, ?4, ?5)')
            .bind(id, sniffed, arrayBuffer, accessToken, userId).run();

        return jsonResponse([{ src: `/api/file/${id}?t=${accessToken}` }], 201);
    } catch (err) {
        console.error('[upload] error:', err);
        return jsonResponse({ error: '上传失败' }, 500);
    }
}

export async function handleFileView(fileId, request, db, authenticate) {
    if (!fileId) return new Response('Not Found', { status: 404 });
    const row = await db.prepare('SELECT mime_type, data, access_token, user_id FROM files WHERE id = ?1').bind(fileId).first();
    if (!row) return new Response('Not Found', { status: 404 });

    const fileToken = new URL(request.url).searchParams.get('t') || '';
    if (row.access_token != null && row.access_token !== '') {
        if (!timingSafeEqualStr(row.access_token, fileToken)) {
            return new Response('Forbidden', { status: 403, headers: applySecurityHeaders(new Headers()) });
        }
    } else {
        const viewerId = await authenticate(request, db);
        if (!viewerId || row.user_id == null || Number(row.user_id) !== Number(viewerId)) {
            return new Response('Forbidden', { status: 403, headers: applySecurityHeaders(new Headers()) });
        }
        if (!fileToken) {
            const newToken = crypto.randomUUID().replace(/-/g, '');
            await db.prepare('UPDATE files SET access_token = ?1 WHERE id = ?2 AND access_token IS NULL')
                .bind(newToken, fileId).run();
        }
    }

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
