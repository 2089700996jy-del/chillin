/**
 * 微信 ClawBot 接入层：扫码登录状态机与应用内配置 API。
 * 负责二维码获取、轮询扫码状态、节点重定向切换、绑定/解绑与账户元数据持久化。
 */
import { jsonResponse } from './security.js';
import {
    ilinkBase,
    ilinkRedirectBase,
    requestClawQrcode,
    queryClawQrcode
} from './bot-claw.js';

/** 服务端只把 90 秒当展示上限；真实有效期以 get_qrcode_status 为准 */
export const QR_TTL_SECONDS = 90;

/** 状态提示：服务端给前端一句能直接展示的话，避免各端各猜一套 */
export const QR_STATUS_TEXT = {
    wait: '等待扫码。',
    scaned: '已扫码，请在手机上确认。',
    scaned_but_redirect: '已扫码，正在切换微信节点…',
    binded_redirect: '这个微信已经绑定过其他 ClawBot 实例，请先在原实例解绑后再试。',
    need_verifycode: '微信要求输入手机上的配对码；当前应用内暂不支持，请重新生成二维码或换一个微信。',
    verify_code_blocked: '配对码错误次数过多，请稍后重新生成二维码。',
    expired: '二维码已过期，请重新生成。'
};

// ─────────────────────────── D1 账号与游标读写 ───────────────────────────

export async function readAccount(db, userId) {
    return await db.prepare('SELECT * FROM bot_claw_accounts WHERE user_id = ?1 AND is_deleted = 0')
        .bind(userId).first();
}

export async function upsertQrcode(db, userId, qrcode) {
    await db.prepare(
        'INSERT INTO bot_claw_accounts (user_id, status, qrcode, qr_expires_at, created_at, updated_at) '
        + "VALUES (?1, 'pending', ?2, datetime('now', '+8 hours', '+" + QR_TTL_SECONDS + " seconds'), "
        + "datetime('now', '+8 hours'), datetime('now', '+8 hours')) "
        + "ON CONFLICT(user_id) DO UPDATE SET status = 'pending', qrcode = ?2, "
        + "qr_expires_at = datetime('now', '+8 hours', '+" + QR_TTL_SECONDS + " seconds'), "
        + "baseurl = 'https://ilinkai.weixin.qq.com', bot_token = '', cursor = '', ilink_bot_id = '', ilink_user_id = '', bound_at_ms = 0, "
        + "is_deleted = 0, last_error = '', updated_at = datetime('now', '+8 hours')"
    ).bind(userId, qrcode).run();
}

export async function markBound(db, userId, info) {
    await db.prepare(
        "UPDATE bot_claw_accounts SET status = 'bound', bot_token = ?2, baseurl = ?3, ilink_bot_id = ?4, "
        + "ilink_user_id = ?5, qrcode = '', qr_expires_at = NULL, cursor = '', bound_at_ms = ?6, "
        + "last_error = '', updated_at = datetime('now', '+8 hours') "
        + 'WHERE user_id = ?1 AND is_deleted = 0'
    ).bind(userId, info.botToken, ilinkBase(info.baseurl), info.ilinkBotId, info.ilinkUserId, Date.now()).run();
}

export async function markUnBound(db, userId) {
    await db.prepare(
        "UPDATE bot_claw_accounts SET status = 'unbound', bot_token = '', cursor = '', qrcode = '', "
        + "qr_expires_at = NULL, ilink_bot_id = '', ilink_user_id = '', bound_at_ms = 0, last_error = '', "
        + "is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE user_id = ?1 AND is_deleted = 0"
    ).bind(userId).run();
}

export async function saveCursor(db, id, cursor) {
    await db.prepare("UPDATE bot_claw_accounts SET cursor = ?2, last_poll_at = datetime('now', '+8 hours') WHERE id = ?1")
        .bind(id, cursor).run();
}

export async function markAccountError(db, id, message) {
    await db.prepare("UPDATE bot_claw_accounts SET last_error = ?2, last_poll_at = datetime('now', '+8 hours') WHERE id = ?1")
        .bind(id, String(message || '').slice(0, 200)).run();
}

export async function markAccountSuccess(db, id) {
    await db.prepare("UPDATE bot_claw_accounts SET last_error = '', last_poll_at = datetime('now', '+8 hours') WHERE id = ?1")
        .bind(id).run();
}

export function publicStatus(row) {
    if (!row) return { bound: false, status: 'none' };
    return {
        bound: String(row.status) === 'bound' && !!row.bot_token,
        status: String(row.status || 'none'),
        qrcode: String(row.qrcode || ''),
        expiresAt: row.qr_expires_at || '',
        ilinkBotId: String(row.ilink_bot_id || ''),
        ilinkUserId: String(row.ilink_user_id || ''),
        lastPollAt: row.last_poll_at || '',
        lastError: String(row.last_error || '')
    };
}

export async function markQrTerminalError(db, id, message) {
    await db.prepare("UPDATE bot_claw_accounts SET status = 'error', qrcode = '', qr_expires_at = NULL, last_error = ?2, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND status = 'pending'")
        .bind(id, String(message || '').slice(0, 200)).run();
}

export async function saveQrRedirect(db, id, baseurl) {
    await db.prepare("UPDATE bot_claw_accounts SET baseurl = ?2, last_error = '', updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND status = 'pending'")
        .bind(id, baseurl).run();
}

// ─────────────────────────── 扫码登录状态机 ───────────────────────────

/** 取一张新二维码并落库（旧二维码立即作废：企微/微信侧只认最新一次） */
export async function startClawLogin(env, db, userId, fetchImpl = fetch) {
    const qr = await requestClawQrcode(fetchImpl);
    await upsertQrcode(db, userId, qr.qrcode);
    return { qrcode: qr.qrcode, url: qr.url, ttlSeconds: QR_TTL_SECONDS, status: 'pending' };
}

/** 查询一次扫码状态；confirmed 时把凭证写入库 */
export async function checkClawLogin(env, db, userId, fetchImpl = fetch) {
    const row = await readAccount(db, userId);
    if (!row || !row.qrcode) return publicStatus(row);
    const state = await queryClawQrcode(String(row.qrcode), fetchImpl, row.baseurl);
    if (state.status === 'confirmed') {
        if (!state.botToken || !state.ilinkBotId) {
            await markAccountError(db, row.id, 'confirmed 响应缺少 bot_token/ilink_bot_id');
            return publicStatus(await readAccount(db, userId));
        }
        await markBound(db, userId, state);
        console.log('[bot-claw] 绑定成功 ilink_bot_id=' + state.ilinkBotId);
        return publicStatus(await readAccount(db, userId));
    }
    const status = state.status;
    if (status === 'scaned_but_redirect') {
        const redirectBase = ilinkRedirectBase(state.redirectHost);
        if (!redirectBase) {
            console.error('[bot-claw] 扫码重定向地址无效，继续当前节点 host=' + state.redirectHost);
            return Object.assign(publicStatus(row), { status, message: '已扫码，微信未返回可用的新节点，继续在当前节点确认…' });
        }
        await saveQrRedirect(db, row.id, redirectBase);
        return Object.assign(publicStatus(await readAccount(db, userId)), { status, message: QR_STATUS_TEXT[status] });
    }
    if (status === 'expired') {
        await db.prepare("UPDATE bot_claw_accounts SET qrcode = '', updated_at = datetime('now', '+8 hours') WHERE id = ?1")
            .bind(row.id).run();
        return Object.assign(publicStatus(row), { status, message: QR_STATUS_TEXT[status] });
    }
    if (!Object.prototype.hasOwnProperty.call(QR_STATUS_TEXT, status)) {
        const message = '微信返回了未知扫码状态（' + status + '），请重新生成二维码。';
        await markQrTerminalError(db, row.id, message);
        return Object.assign(publicStatus(await readAccount(db, userId)), { status: 'error', message });
    }
    if (status === 'binded_redirect' || status === 'need_verifycode' || status === 'verify_code_blocked') {
        await markQrTerminalError(db, row.id, QR_STATUS_TEXT[status]);
        return Object.assign(publicStatus(await readAccount(db, userId)), { status, message: QR_STATUS_TEXT[status] });
    }
    return Object.assign(publicStatus(row), { status, message: QR_STATUS_TEXT[status] });
}

export async function unbindClaw(db, userId) {
    await markUnBound(db, userId);
    return { bound: false, status: 'unbound' };
}

export async function handleClawApi(request, env, url, db, userId) {
    const path = url.pathname;
    try {
        if (path === '/api/bot/claw/status' && request.method === 'GET') {
            return jsonResponse(publicStatus(await readAccount(db, userId)), 200);
        }
        if (path === '/api/bot/claw/qrcode' && request.method === 'POST') {
            const current = await readAccount(db, userId);
            if (current && current.status === 'bound') {
                return jsonResponse({ error: '微信已绑定，请先解绑再重新绑定' }, 409);
            }
            return jsonResponse(await startClawLogin(env, db, userId), 200);
        }
        if (path === '/api/bot/claw/check' && request.method === 'POST') {
            return jsonResponse(await checkClawLogin(env, db, userId), 200);
        }
        if (path === '/api/bot/claw' && request.method === 'DELETE') {
            return jsonResponse(await unbindClaw(db, userId), 200);
        }
    } catch (err) {
        console.error('[bot-claw] api error: ' + (err && err.message));
        return jsonResponse({ error: '微信机器人服务暂时不可用，请稍后重试' }, 502);
    }
    return jsonResponse({ error: '接口不存在' }, 404);
}

