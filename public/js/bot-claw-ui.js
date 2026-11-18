/**
 * WeChat Bot Claw UI & Polling module.
 * Manages in-app QR code binding, unbinding, polling, countdown, and outreach toggling.
 */
import { apiRequest } from './auth.js';
import { showToast, confirmDialog } from './utils.js';

let botOutreachBusy = false;

function renderBotOutreach(state) {
    const btn = document.getElementById('btn-bot-outreach');
    const hint = document.getElementById('bot-outreach-hint');
    if (!btn || !hint) return;
    const bound = !!(state && state.bound);
    const enabled = !!(state && state.enabled);
    btn.disabled = !bound;
    btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    btn.classList.toggle('is-on', bound && enabled);
    btn.textContent = !bound ? '未绑定微信' : (enabled ? '已开启' : '已关闭');
    if (!bound) {
        hint.textContent = '绑定微信 ClawBot 后，它才能在没人说话时偶尔想起你的一条旧记录。';
    } else if (enabled) {
        const extra = state.lastSentAt ? '（最近主动送达：' + state.lastSentAt.slice(0, 16) + '）' : '';
        hint.textContent = '每天最多一次，10:00–22:30 之间；刚聊完的 30 分钟内不会打扰，之后翻到 3 天前旧记录时才可能开口。' + extra;
    } else {
        hint.textContent = '已关闭，它不会再主动开口。在微信里说「可以主动找我」也能恢复。';
    }
}

export async function loadBotOutreach() {
    const btn = document.getElementById('btn-bot-outreach');
    const hint = document.getElementById('bot-outreach-hint');
    if (!btn || !hint) return;
    hint.textContent = '正在读取状态…';
    try {
        renderBotOutreach(await apiRequest('/api/bot/outreach'));
    } catch (e) {
        btn.disabled = true;
        hint.textContent = '状态读取失败，请稍后重试';
    }
}

export async function toggleBotOutreach() {
    if (botOutreachBusy) return;
    const btn = document.getElementById('btn-bot-outreach');
    const hint = document.getElementById('bot-outreach-hint');
    botOutreachBusy = true;
    if (btn) btn.disabled = true;
    try {
        const current = await apiRequest('/api/bot/outreach');
        const next = !(current && current.enabled);
        renderBotOutreach(await apiRequest('/api/bot/outreach', { method: 'POST', body: JSON.stringify({ enabled: next }) }));
        showToast(next ? '已开启主动关怀' : '已关闭主动关怀', 'success');
    } catch (e) {
        if (hint) hint.textContent = '设置失败，请稍后重试';
        showToast('设置失败：' + (e && e.message ? e.message : e), 'warn');
    } finally {
        botOutreachBusy = false;
        if (btn) btn.disabled = false;
    }
}

// ── 微信 ClawBot：应用内扫码绑定 / 解绑 ──
// 二维码由 Worker 向 iLink 申请（浏览器不接触 bot_token），这里只负责展示、轮询确认与解绑。
const CLAW_POLL_INTERVAL_MS = 1000;
const CLAW_CHECK_EVERY_MS = 2000;
const CLAW_QR_MIN_TTL_SECONDS = 30;
const CLAW_SCAN_MAX_MS = 5 * 60 * 1000;
let clawPollTimer = 0;
let clawCheckInFlight = false;
let clawLastCheckAt = 0;
let clawExpiresAt = 0;
let clawScanStartedAt = 0;
let clawBusy = false;

function clawEls() {
    return {
        title: document.getElementById('bot-claw-title'),
        hint: document.getElementById('bot-claw-hint'),
        bind: document.getElementById('btn-bot-claw-bind'),
        unbind: document.getElementById('btn-bot-claw-unbind'),
        qr: document.getElementById('bot-claw-qr'),
        img: document.getElementById('bot-claw-qr-img'),
        open: document.getElementById('btn-bot-claw-open'),
        qrHint: document.getElementById('bot-claw-qr-hint'),
        qrNote: document.getElementById('bot-claw-qr-note'),
        cancel: document.getElementById('btn-bot-claw-cancel')
    };
}

export function stopBotClawPolling() {
    if (clawPollTimer) { clearInterval(clawPollTimer); clawPollTimer = 0; }
    clawCheckInFlight = false;
    clawLastCheckAt = 0;
}

export function pauseBotClawPolling() {
    if (clawPollTimer) { clearInterval(clawPollTimer); clawPollTimer = 0; }
    clawCheckInFlight = false;
}

export function isBotClawWaitingForScan() {
    const els = clawEls();
    return Boolean(clawExpiresAt && (!els.qr || !els.qr.hidden));
}

export function handleBotClawVisibilityChange() {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
        if (clawPollTimer) {
            pauseBotClawPolling();
        }
        return;
    }
    if (document.visibilityState === 'visible') {
        if (!isBotClawWaitingForScan()) return;
        const now = Date.now();
        if (clawScanStartedAt && (now - clawScanStartedAt > CLAW_SCAN_MAX_MS)) {
            failBotClawQr('扫码超时', '长时间没有收到微信确认，请重新生成二维码。');
            return;
        }
        if (now >= clawExpiresAt) {
            expireBotClawQr('二维码已过期，请重新生成。');
            return;
        }
        paintBotClawCountdown();
        startBotClawPolling();
        clawLastCheckAt = now;
        pollBotClawOnce();
    }
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', handleBotClawVisibilityChange);
}

function hideBotClawQr() {
    const els = clawEls();
    if (els.qr) els.qr.hidden = true;
    if (els.img) { els.img.onerror = null; els.img.removeAttribute('src'); }
    if (els.open) { els.open.hidden = true; els.open.removeAttribute('href'); }
    if (els.cancel) els.cancel.hidden = true;
    if (els.qrNote) { els.qrNote.hidden = true; els.qrNote.textContent = ''; }
    clawExpiresAt = 0;
    clawScanStartedAt = 0;
}

function paintBotClawCountdown() {
    const els = clawEls();
    if (!clawExpiresAt || !els.qrHint) return 0;
    const left = Math.max(0, Math.ceil((clawExpiresAt - Date.now()) / 1000));
    els.qrHint.textContent = left > 0
        ? '请用微信扫码，二维码约 ' + left + ' 秒后失效（以微信状态为准）。'
        : '二维码进入刷新窗口，正在向微信确认状态…';
    return left;
}

function failBotClawQr(title, message) {
    stopBotClawPolling();
    hideBotClawQr();
    const els = clawEls();
    if (els.title) els.title.textContent = title || '绑定未完成';
    if (els.hint) els.hint.textContent = message || '请重新生成二维码。';
    if (els.bind) {
        els.bind.hidden = false;
        els.bind.disabled = false;
        els.bind.textContent = '重新生成二维码';
    }
    if (els.unbind) els.unbind.hidden = true;
}

function expireBotClawQr(message) {
    failBotClawQr('二维码已过期', message || '二维码已过期，请重新生成。');
}

export function renderBotClawStatus(state) {
    const els = clawEls();
    if (!els.title) return;
    const bound = !!(state && state.bound);
    const pending = !bound && !!(state && state.status === 'pending' && state.qrcode);
    if (els.unbind) els.unbind.hidden = !bound;
    if (els.bind) {
        els.bind.hidden = bound;
        els.bind.disabled = false;
    }
    if (bound) {
        if (els.title) els.title.textContent = '已绑定微信';
        if (els.hint) {
            let hint = '最近收信 ' + (state.lastPollAt || '等待首次收信');
            if (state.lastError) hint += '；通道正在自动重试';
            els.hint.textContent = hint;
        }
        if (els.bind) els.bind.textContent = '绑定微信';
        return;
    }
    if (state && state.status === 'error') {
        if (els.title) els.title.textContent = '绑定未完成';
        if (els.hint) els.hint.textContent = state.lastError || '请重新生成二维码后再试。';
        if (els.bind) els.bind.textContent = '重新生成二维码';
        return;
    }
    if (pending) {
        if (els.title) els.title.textContent = '等待扫码';
        if (els.hint) els.hint.textContent = '上一次二维码已失效或页面已关闭，重新生成后再扫。';
        if (els.bind) els.bind.textContent = '重新生成二维码';
        return;
    }
    if (els.title) els.title.textContent = '未绑定微信';
    if (els.hint) els.hint.textContent = '绑定后可以在微信里直接记笔记、问问题、设提醒，也能收到主动关怀。';
    if (els.bind) els.bind.textContent = '绑定微信';
}

export async function loadBotClawStatus() {
    stopBotClawPolling();
    hideBotClawQr();
    const els = clawEls();
    if (!els.title) return;
    els.title.textContent = '正在读取绑定状态…';
    if (els.hint) els.hint.textContent = '绑定后可以在微信里直接记笔记、问问题、设提醒。';
    if (els.bind) { els.bind.hidden = false; els.bind.disabled = true; els.bind.textContent = '读取中…'; }
    if (els.unbind) els.unbind.hidden = true;
    try {
        renderBotClawStatus(await apiRequest('/api/bot/claw/status'));
    } catch (_) {
        els.title.textContent = '读取绑定状态失败';
        if (els.hint) els.hint.textContent = '请稍后重试。';
        if (els.bind) { els.bind.disabled = false; els.bind.textContent = '重试'; }
    }
}

export async function startBotClawBind() {
    if (clawBusy) return;
    stopBotClawPolling();
    hideBotClawQr();
    const els = clawEls();
    if (!els.title) return;
    clawBusy = true;
    if (els.bind) { els.bind.hidden = false; els.bind.disabled = true; els.bind.textContent = '生成中…'; }
    if (els.unbind) els.unbind.hidden = true;
    els.title.textContent = '正在生成二维码…';
    if (els.hint) els.hint.textContent = '二维码从微信侧实时申请，请稍候。';
    try {
        const qr = await apiRequest('/api/bot/claw/qrcode', { method: 'POST' });
        const src = String((qr && qr.url) || '');
        const rawUrl = String((qr && qr.rawUrl) || src);
        if (!/^(https:\/\/|data:image\/)/i.test(src)) throw new Error('二维码地址无效');
        const ttl = Math.max(CLAW_QR_MIN_TTL_SECONDS, Number(qr && qr.ttlSeconds) || 90);
        els.img.onerror = () => expireBotClawQr('二维码图片加载失败，请重新生成。');
        els.img.src = src;
        if (els.open) {
            els.open.href = rawUrl;
            els.open.hidden = !rawUrl || !/^https:\/\//i.test(rawUrl);
        }
        els.qr.hidden = false;
        els.cancel.hidden = false;
        els.qrNote.hidden = true;
        els.qrNote.textContent = '';
        els.bind.hidden = true;
        els.title.textContent = '等待扫码';
        els.hint.textContent = '用微信扫一扫，确认后自动完成绑定。';
        clawExpiresAt = Date.now() + ttl * 1000;
        clawScanStartedAt = Date.now();
        paintBotClawCountdown();
        startBotClawPolling();
    } catch (e) {
        els.title.textContent = '生成二维码失败';
        if (els.hint) els.hint.textContent = (e && e.message) ? e.message : '请稍后重试。';
        if (els.bind) { els.bind.hidden = false; els.bind.disabled = false; els.bind.textContent = '重试'; }
    } finally {
        clawBusy = false;
    }
}

export function cancelBotClawScan() {
    stopBotClawPolling();
    hideBotClawQr();
    const els = clawEls();
    if (els.title) els.title.textContent = '未完成绑定';
    if (els.hint) els.hint.textContent = '二维码已取消，需要时可重新生成。';
    if (els.bind) { els.bind.hidden = false; els.bind.disabled = false; els.bind.textContent = '绑定微信'; }
}

export async function pollBotClawOnce() {
    if (clawCheckInFlight) return;
    clawCheckInFlight = true;
    try {
        const state = await apiRequest('/api/bot/claw/check', { method: 'POST' });
        if (state && state.bound) {
            stopBotClawPolling();
            hideBotClawQr();
            renderBotClawStatus(state);
            showToast('微信绑定成功', 'success');
            loadBotOutreach();
            return;
        }
        if (state && state.status === 'expired') {
            expireBotClawQr(state.message || '二维码已过期，请重新生成。');
            return;
        }
        const terminal = {
            binded_redirect: ['微信已绑定其他实例', state && state.message],
            need_verifycode: ['需要配对码', state && state.message],
            verify_code_blocked: ['配对码错误次数过多', state && state.message],
            error: ['绑定未完成', (state && (state.message || state.lastError)) || '请重新生成二维码后再试。']
        };
        if (state && terminal[state.status]) {
            failBotClawQr(terminal[state.status][0], terminal[state.status][1]);
            return;
        }
        const els = clawEls();
        if (els.qrNote) {
            if (state && state.status === 'scaned') {
                els.qrNote.hidden = false;
                els.qrNote.textContent = '已扫码，请在手机上确认。';
            } else if (state && state.status === 'scaned_but_redirect') {
                els.qrNote.hidden = false;
                els.qrNote.textContent = state.message || '已扫码，正在切换微信节点…';
            } else if (state && state.lastError) {
                els.qrNote.hidden = false;
                els.qrNote.textContent = '通道暂时不可用，正在重试…';
            }
        }
    } catch (_) {
        const els = clawEls();
        if (els.qrNote) {
            els.qrNote.hidden = false;
            els.qrNote.textContent = '检查扫码状态失败，正在重试…';
        }
    } finally {
        clawCheckInFlight = false;
    }
}

export function startBotClawPolling() {
    stopBotClawPolling();
    clawLastCheckAt = 0;
    clawPollTimer = setInterval(() => {
        if (!clawExpiresAt) return;
        paintBotClawCountdown();
        if (clawScanStartedAt && Date.now() - clawScanStartedAt > CLAW_SCAN_MAX_MS) {
            failBotClawQr('扫码超时', '长时间没有收到微信确认，请重新生成二维码。');
            return;
        }
        if (clawCheckInFlight || Date.now() - clawLastCheckAt < CLAW_CHECK_EVERY_MS) return;
        clawLastCheckAt = Date.now();
        pollBotClawOnce();
    }, CLAW_POLL_INTERVAL_MS);
}

export async function unbindBotClaw() {
    if (clawBusy) return;
    if (!(await confirmDialog('解绑微信 ClawBot？解绑后微信消息不会再同步到花园，可以随时重新扫码绑定。', { confirmText: '解绑' }))) return;
    stopBotClawPolling();
    hideBotClawQr();
    const els = clawEls();
    clawBusy = true;
    if (els.title) els.title.textContent = '正在解绑…';
    if (els.bind) els.bind.disabled = true;
    if (els.unbind) els.unbind.disabled = true;
    try {
        renderBotClawStatus(await apiRequest('/api/bot/claw', { method: 'DELETE' }));
        showToast('已解绑微信', 'success');
        loadBotOutreach();
    } catch (e) {
        if (els.title) els.title.textContent = '解绑失败';
        if (els.hint) els.hint.textContent = (e && e.message) ? e.message : '请稍后重试。';
    } finally {
        clawBusy = false;
        if (els.bind) els.bind.disabled = false;
        if (els.unbind) els.unbind.disabled = false;
    }
}

export function _setBotClawTestState(state = {}) {
    if ('clawExpiresAt' in state) clawExpiresAt = state.clawExpiresAt;
    if ('clawScanStartedAt' in state) clawScanStartedAt = state.clawScanStartedAt;
    if ('clawPollTimer' in state) clawPollTimer = state.clawPollTimer;
    if ('clawCheckInFlight' in state) clawCheckInFlight = state.clawCheckInFlight;
    if ('clawLastCheckAt' in state) clawLastCheckAt = state.clawLastCheckAt;
}

export function _getBotClawTestState() {
    return {
        clawExpiresAt,
        clawScanStartedAt,
        clawPollTimer,
        clawCheckInFlight,
        clawLastCheckAt
    };
}
