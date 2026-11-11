/**
 * 全量数据备份邮件直发 (Resend API)
 * 将全量 ZIP 压缩包经由 Resend 邮件发送至用户邮箱，带频控与白名单校验。
 */
import { jsonResponse, readJsonCapped, checkRateLimitShared, rateLimitedResponse } from './security.js';

// 备份邮件带着 base64 的全量 ZIP，上限放宽到 12MB，但仍要有硬顶
export const MAX_BACKUP_BODY_BYTES = 12 * 1024 * 1024;
// 备份邮件会触发真实的第三方发信：每人每小时 3 封，避免账号被盗后被当发信机
export const BACKUP_EMAIL_MAX_PER_HOUR = 3;
export const MAX_BACKUP_FILENAME_LENGTH = 120;

/** 收件人白名单：配置 BACKUP_EMAIL_ALLOWLIST（逗号分隔）后只允许发给这些地址 */
export function isBackupRecipientAllowed(email, env) {
    const list = String((env && env.BACKUP_EMAIL_ALLOWLIST) || '')
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    return list.length === 0 || list.includes(String(email).trim().toLowerCase());
}

/** 文件名来自请求体：去掉路径分隔符与控制字符，并限制长度 */
export function sanitizeBackupFilename(raw) {
    const cleaned = String(raw || '')
        .trim()
        .slice(0, MAX_BACKUP_FILENAME_LENGTH)
        .replace(/[\\/\r\n"<>|?*:]+/g, '_');
    return cleaned || 'chillin-backup.zip';
}

/** 邮件 HTML 里的文件名来自请求体，必须转义后再拼进模板 */
export function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

export async function handleBackupEmail(request, env, userId, db) {
    if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401);

    const limit = await checkRateLimitShared(db, `backup-email:${userId}`, BACKUP_EMAIL_MAX_PER_HOUR, 60 * 60 * 1000);
    if (!limit.ok) return rateLimitedResponse(limit.retryAfter, '备份邮件发送过于频繁，请稍后再试');

    const parsed = await readJsonCapped(request, MAX_BACKUP_BODY_BYTES);
    if (!parsed.ok) {
        return jsonResponse({ error: parsed.status === 413 ? '备份文件过大，最大支持 12MB' : 'Invalid JSON body' }, parsed.status);
    }
    const body = parsed.value;

    const { email, filename, zipBase64 } = body || {};
    if (!email || typeof email !== 'string' || !email.includes('@') || email.length > 254) {
        return jsonResponse({ error: 'Invalid email address' }, 400);
    }
    if (!isBackupRecipientAllowed(email, env)) {
        return jsonResponse({ error: '该邮箱不在备份收件人白名单内' }, 403);
    }
    if (!zipBase64 || typeof zipBase64 !== 'string') {
        return jsonResponse({ error: 'Missing zip payload' }, 400);
    }
    const safeFilename = sanitizeBackupFilename(filename);

    const resendKey = env.RESEND_API_KEY;
    if (!resendKey) {
        return jsonResponse({
            success: false,
            code: 'NO_RESEND_KEY',
            message: '未配置 RESEND_API_KEY 环境变量，无法发送邮件'
        }, 200);
    }

    try {
        const fromAddress = env.RESEND_FROM || 'Chillin Garden <onboarding@resend.dev>';
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${resendKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: fromAddress,
                to: [email],
                subject: `[Chillin] 你的个人数字花园全量备份 (${new Date().toLocaleDateString('zh-CN')})`,
                html: `
                    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1c1c1e;">
                        <h2 style="font-size: 20px; font-weight: 700; color: #000; margin-bottom: 12px;">🌿 Chillin 数字花园全量备份</h2>
                        <p style="font-size: 15px; line-height: 1.6; color: #3c3c43;">你好！这是你在 Chillin 数字花园生成的全量数据归档压缩包。</p>
                        <div style="background: #f2f2f7; border-radius: 12px; padding: 16px; margin: 20px 0; font-size: 14px; line-height: 1.6;">
                            <div>📦 <strong>包含内容：</strong></div>
                            <ul style="margin: 8px 0 0 20px; padding: 0;">
                                <li><strong>notes/</strong>：所有笔记的独立 Markdown 文件（含 Frontmatter 元数据）</li>
                                <li><strong>weeklies/</strong>：所有周刊长文的独立 Markdown 文件</li>
                                <li><strong>feeds/feeds.md</strong>：随手记完整时间线归档</li>
                                <li><strong>bookmarks/</strong>：标准 Netscape HTML 书签（可直接导入任意浏览器）</li>
                                <li><strong>chillin-full-backup.json</strong>：客户端全量结构化数据（供一键恢复还原）</li>
                                <li><strong>chillin-server-backup.json</strong>：服务端导出（阅读进度、云端书库元数据、健康打卡、微信助手档案）</li>
                                <li><strong>README.md</strong>：备份范围与「哪些内容不在包里」的说明</li>
                            </ul>
                        </div>
                        <p style="font-size: 13px; color: #8e8e93; margin-top: 24px;">附件已携带压缩包文件：${escapeHtml(safeFilename)}<br/>Chillin · 个人离线优先数字花园</p>
                    </div>
                `,
                attachments: [
                    {
                        filename: safeFilename,
                        content: zipBase64
                    }
                ]
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error('[resend] email sending failed:', res.status, errText);
            return jsonResponse({
                success: false,
                code: 'RESEND_ERROR',
                message: `Resend 服务返回错误 (${res.status})`
            }, 200);
        }

        const data = await res.json();
        return jsonResponse({ success: true, id: data.id }, 200);
    } catch (err) {
        console.error('[resend] fetch exception:', err);
        return jsonResponse({
            success: false,
            code: 'FETCH_ERROR',
            message: err?.message || '邮件发送异常'
        }, 500);
    }
}

