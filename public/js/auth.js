/**
 * Auth & HTTP client: login/logout, apiRequest, push subscribe.
 * Sync side effects after login are loaded via dynamic import('./sync.js') to avoid cycles.
 */
import { showToast, urlBase64ToUint8Array, escapeHtml, confirmDialog, getAppThemeMode, setAppThemeMode } from './utils.js';
import { CLOUD_WORKER_BASE, resolveApiBase } from './config.js';
import { state } from './state.js';
import { setHtml } from './trusted-types.js';
import { downloadBackupZip, sendBackupByEmail, setBackupGuardSettings, updateBackupGuardUI } from './backup.js';
import { getStorageEstimate } from './db.js';

let hooks = {
    onRefresh: (_kind, _opts) => {},
};

export function bindApiHooks(partial) {
    hooks = { ...hooks, ...partial };
}

export function refresh(kind, opts) {
    if (typeof hooks.onRefresh === 'function') hooks.onRefresh(kind, opts);
}

let API_BASE = resolveApiBase();
export { API_BASE };

export function resolveAssetUrl(src) {
    if (src && API_BASE && (src.startsWith('/api/') || src.startsWith('/uploads/'))) {
        return API_BASE + src;
    }
    return src;
}

async function readErrorMessage(res) {
    try {
        const data = await res.clone().json();
        if (data && data.error) return String(data.error);
    } catch (_) {}
    try {
        const text = (await res.clone().text()).trim();
        if (text && text.length < 200 && !text.startsWith('<')) return text;
    } catch (_) {}
    if (res.status === 429) return '请求过于频繁，请稍后再试';
    if (res.status >= 500) return `服务暂时不可用 (${res.status})`;
    return `请求失败 (${res.status})`;
}

/** 登录/注册错误：区分密码错、限流、网络、服务异常 */
function formatAuthError(err, res, data) {
    if (!res && err) {
        if (err.name === 'AbortError') return '请求超时，请检查网络后重试';
        if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
            return '网络连接失败，请检查手机网络后重试';
        }
        return err.message || '登录失败';
    }
    const status = res ? res.status : 0;
    const serverMsg = (data && data.error) ? String(data.error) : '';
    if (status === 429) {
        const retry = (data && data.retryAfter)
            || (res && res.headers.get('Retry-After'))
            || null;
        const tip = serverMsg.includes('登录') ? serverMsg : '登录过于频繁，请稍后再试';
        if (retry) return `${tip}（约 ${retry} 秒）`;
        return tip;
    }
    if (status === 401) return '账号或密码错误';
    if (status === 403) return serverMsg || '暂无权限，请联系管理员';
    if (status === 400) return serverMsg || '请检查账号和密码格式';
    if (status >= 500) return '服务暂时不可用，请稍后重试';
    if (status === 0) return '网络连接失败，请检查手机网络后重试';
    return serverMsg || (err && err.message) || '登录失败';
}

export async function fetchWithFallback(path, options = {}) {
    const primaryUrl = `${API_BASE}${path}`;
    const workerUrl = `${CLOUD_WORKER_BASE}${path}`;
    const isAuth = path.startsWith('/api/auth/');
    // 会话可能是旧版 Bearer，也可能是 HttpOnly Cookie：跨域回退时同样要带凭据
    const opts = { credentials: 'include', ...options };

    const looksBad = (res) => {
        if (!res) return true;
        if (res.status >= 500) return true;
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        return ct.includes('text/html');
    };

    let primaryRes = null;
    let primaryErr = null;
    try {
        primaryRes = await fetch(primaryUrl, opts);
    } catch (err) {
        primaryErr = err;
    }

    if (primaryRes && !looksBad(primaryRes)) return primaryRes;

    if (isAuth || primaryErr || looksBad(primaryRes)) {
        try {
            return await fetch(workerUrl, opts);
        } catch (workerErr) {
            if (primaryRes) return primaryRes;
            throw primaryErr || workerErr;
        }
    }

    if (primaryRes) return primaryRes;
    throw primaryErr || new Error('网络连接失败');
}

async function parseJsonSafe(res) {
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) {
        throw new Error('服务返回异常页面，请刷新后重试');
    }
    try {
        return await res.json();
    } catch {
        throw new Error(await readErrorMessage(res) || '无法解析服务器响应');
    }
}

export function getLocalKey(key) {
    return state.authUser ? `${state.authUser.id}_${key}` : `default_${key}`;
}

const SYNC_CURSOR_RESOURCES = ['weeklies', 'notes', 'bookmarks', 'feeds'];

function clearSyncCursorsForUser(userId) {
    if (userId == null) return;
    for (const resource of SYNC_CURSOR_RESOURCES) {
        localStorage.removeItem(`${userId}_sync_${resource}`);
        localStorage.removeItem(`chillin_sync_${resource}`);
    }
}

export function checkAuth() {
    const authOverlay = document.getElementById('auth-overlay');
    const navUsername = document.getElementById('nav-username');
    if (!state.authToken && !state.cookieSession) {
        authOverlay?.classList.remove('hidden');
        document.body.classList.add('not-authenticated');
        return false;
    }
    authOverlay?.classList.add('hidden');
    document.body.classList.remove('not-authenticated');
    if (state.authUser && navUsername) navUsername.innerText = `Hi, ${state.authUser.username}`;
    return true;
}

export function logout(opts = {}) {
    const uid = state.authUser?.id;
    if (state.authToken || state.cookieSession) {
        apiRequest('/api/auth/logout', { method: 'POST' }).catch(() => {});
    }
    state.authToken = '';
    state.cookieSession = false;
    state.authUser = null;
    localStorage.removeItem('chillin_token');
    localStorage.removeItem('chillin_user');
    clearSyncCursorsForUser(uid);
    try { localStorage.removeItem(PUSH_SYNC_FAILED_KEY); } catch (_) {}
    checkAuth();
    if (opts.silent) return;
    if (opts.reason === 'expired') {
        showToast('登录已过期，请重新登录', 'warn');
    } else {
        showToast('已退出登录', 'info');
    }
}

async function doLogin() {
    const username = document.getElementById('auth-username')?.value.trim() || '';
    const password = document.getElementById('auth-password')?.value.trim() || '';
    const btnAuthSubmit = document.getElementById('btn-auth-submit');
    const authErrorMsg = document.getElementById('auth-error-msg');
    if (authErrorMsg) authErrorMsg.style.display = 'none';
    if (!username || !password) {
        if (authErrorMsg) {
            authErrorMsg.innerText = '请输入账号和密码';
            authErrorMsg.style.display = 'block';
        }
        return;
    }

    if (btnAuthSubmit) {
        btnAuthSubmit.disabled = true;
        btnAuthSubmit.innerText = state.isRegisterMode ? '注册中...' : '登录中...';
    }

    try {
        const endpoint = state.isRegisterMode ? '/api/auth/register' : '/api/auth/login';
        if (state.isRegisterMode) {
            if (username.length < 3 || username.length > 32) throw new Error('账号长度需为 3–32 位');
            if (password.length < 8) throw new Error('密码至少 8 位');
            if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
                throw new Error('密码需同时包含字母和数字');
            }
        }
        const res = await fetchWithFallback(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        let data = null;
        try {
            data = await parseJsonSafe(res);
        } catch (parseErr) {
            throw Object.assign(parseErr, { _authRes: res, _authData: null });
        }
        if (!res.ok) {
            const msg = formatAuthError(null, res, data);
            throw Object.assign(new Error(msg), { _authRes: res, _authData: data });
        }
        if (!data.token) throw new Error('登录响应异常，请刷新后重试');

        state.authToken = data.token;
        state.authUser = { id: data.userId, username: data.username };
        // 新后端用 HttpOnly Cookie 维持会话：不再把令牌写进 localStorage（XSS 无法窃取）。
        // 若后端仍是旧版（响应无 session 标记），保留 Bearer 持久化，保证零停机共存。
        state.cookieSession = data.session === 'cookie';
        if (state.cookieSession) {
            localStorage.removeItem('chillin_token');
        } else {
            localStorage.setItem('chillin_token', state.authToken);
        }
        localStorage.setItem('chillin_user', JSON.stringify(state.authUser));

        checkAuth();
        try { window.dispatchEvent(new CustomEvent('chillin:auth-ready')); } catch (_) {}
        const sync = await import('./sync.js');
        try { sync.loadLocalData(); } catch (_) {}
        Promise.resolve()
            .then(() => sync.syncFromApi())
            .catch((e) => console.warn('[login] sync after login failed', e));
        try { sync.checkAndMergeGuestData(); } catch (_) {}
        // 推送权限改为用户在「账号与安全」里主动点击「开启通知」时申请，避免登录即弹窗被永久拒绝
    } catch (err) {
        const errorMsg = formatAuthError(err, err._authRes, err._authData);
        if (authErrorMsg) {
            authErrorMsg.innerText = errorMsg;
            authErrorMsg.style.display = 'block';
        }
        showToast(errorMsg, 'error');
    } finally {
        if (btnAuthSubmit) {
            btnAuthSubmit.disabled = false;
            btnAuthSubmit.innerText = state.isRegisterMode ? '注册并进入' : '登录';
        }
    }
}

if (typeof window !== 'undefined') {
    window._chillinLogin = doLogin;
}

export function initAuthUI() {
    const btnLogout = document.getElementById('btn-logout');
    const btnAuthSwitch = document.getElementById('btn-auth-switch');
    const authSwitchText = document.getElementById('auth-switch-text');
    const authErrorMsg = document.getElementById('auth-error-msg');

    btnLogout?.addEventListener('click', logout);
    document.getElementById('btn-logout-all')?.addEventListener('click', logoutAllDevices);

    // 账号与安全入口（用户名）与弹层内交互
    document.getElementById('btn-open-security')?.addEventListener('click', openSecurityModal);
    const navUsername = document.getElementById('nav-username');
    navUsername?.addEventListener('click', openSecurityModal);
    navUsername?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSecurityModal(); }
    });
    document.getElementById('session-list')?.addEventListener('click', (e) => {
        const btn = e.target instanceof Element ? e.target.closest('.session-revoke') : null;
        if (btn && btn.dataset.sessionId) revokeSession(btn.dataset.sessionId);
    });
    document.getElementById('btn-security-logout-all')?.addEventListener('click', logoutAllDevices);

    // 「关于我」档案：查看 / 新增 / 编辑 / 遗忘（与微信端共用同一份记忆）
    document.getElementById('bot-profile-list')?.addEventListener('click', onBotProfileListClick);
    document.getElementById('btn-bot-profile-add')?.addEventListener('click', addBotProfileFromInput);
    document.getElementById('bot-profile-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addBotProfileFromInput(); }
    });
    document.getElementById('btn-bot-profile-clear')?.addEventListener('click', clearBotProfileAll);

    // Bot 交流偏好：独立于事实档案的表达方式设置
    document.getElementById('bot-preference-list')?.addEventListener('click', onBotPreferenceListClick);
    document.getElementById('btn-bot-preference-add')?.addEventListener('click', addBotPreferenceFromInput);
    document.getElementById('bot-preference-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addBotPreferenceFromInput(); }
    });
    document.getElementById('btn-bot-preference-clear')?.addEventListener('click', clearBotPreferencesAll);

    document.getElementById('btn-bot-outreach')?.addEventListener('click', toggleBotOutreach);

    // 微信 ClawBot：扫码绑定 / 取消 / 解绑；弹层一关就停轮询，别让定时器在后台空转
    document.getElementById('btn-bot-claw-bind')?.addEventListener('click', startBotClawBind);
    document.getElementById('btn-bot-claw-cancel')?.addEventListener('click', cancelBotClawScan);
    document.getElementById('btn-bot-claw-unbind')?.addEventListener('click', unbindBotClaw);
    const securityModal = document.getElementById('account-security-modal');
    if (securityModal && typeof MutationObserver === 'function') {
        new MutationObserver(() => {
            if (!securityModal.classList.contains('show')) stopBotClawPolling();
        }).observe(securityModal, { attributes: true, attributeFilter: ['class'] });
    }

    // 外观主题：跟随系统 / 浅色 / 深色（批次 A 应用级主题）
    document.getElementById('app-theme-control')?.addEventListener('click', onAppThemeControlClick);
    document.getElementById('btn-enable-push')?.addEventListener('click', registerPushNotification);
    document.getElementById('btn-test-push')?.addEventListener('click', sendTestNotification);

    // 全量资产备份与导出交互
    document.getElementById('btn-backup-download')?.addEventListener('click', () => {
        downloadBackupZip();
    });
    document.getElementById('btn-backup-email')?.addEventListener('click', async () => {
        const input = document.getElementById('backup-email-input');
        const email = input?.value?.trim();
        if (!email) {
            showToast('请输入接收邮箱地址', 'warn');
            input?.focus();
            return;
        }
        await sendBackupByEmail(email);
    });
    document.getElementById('btn-change-password')?.addEventListener('click', changePassword);
    // 改密区顺便支持回车提交，移动端少一次点击
    for (const id of ['pwd-current', 'pwd-new', 'pwd-confirm']) {
        document.getElementById(id)?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                changePassword();
            }
        });
    }
    document.getElementById('backup-guard-segmented')?.addEventListener('click', (e) => {
        const btn = e.target instanceof Element ? e.target.closest('[data-days]') : null;
        if (!btn) return;
        const days = parseInt(btn.getAttribute('data-days'), 10);
        setBackupGuardSettings(days);
        const daysLabel = days === 0 ? '已关闭定期备份提醒' : `备份守护周期已设置为 ${days} 天`;
        showToast(daysLabel, 'ok');
    });

    const btnTogglePassword = document.getElementById('btn-toggle-password');
    const authPasswordInput = document.getElementById('auth-password');
    if (btnTogglePassword && authPasswordInput) {
        btnTogglePassword.addEventListener('click', (e) => {
            e.preventDefault();
            const isPassword = authPasswordInput.type === 'password';
            authPasswordInput.type = isPassword ? 'text' : 'password';
            const eyeOff = btnTogglePassword.querySelector('.eye-off');
            const eyeOn = btnTogglePassword.querySelector('.eye-on');
            if (eyeOff && eyeOn) {
                eyeOff.style.display = isPassword ? 'none' : 'block';
                eyeOn.style.display = isPassword ? 'block' : 'none';
            }
            btnTogglePassword.setAttribute('aria-label', isPassword ? '隐藏密码' : '显示密码');
        });
    }

    const authTabLogin = document.getElementById('auth-tab-login');
    const authTabRegister = document.getElementById('auth-tab-register');
    const authSubdesc = document.getElementById('auth-subdesc');

    const updateAuthMode = (isRegister) => {
        state.isRegisterMode = isRegister;
        if (authTabLogin && authTabRegister) {
            authTabLogin.classList.toggle('active', !isRegister);
            authTabLogin.setAttribute('aria-selected', !isRegister);
            authTabRegister.classList.toggle('active', isRegister);
            authTabRegister.setAttribute('aria-selected', isRegister);
        }
        const submitLabel = document.querySelector('.auth-btn-label') || document.querySelector('.auth-btn');
        if (isRegister) {
            if (submitLabel) submitLabel.innerText = '注册新账户';
            if (authSubdesc) authSubdesc.innerText = '注册后即可跨设备同步随手记、笔记与阅读进度。';
            if (authSwitchText) authSwitchText.innerText = '已有账号？';
            if (btnAuthSwitch) btnAuthSwitch.innerText = '直接登录';
        } else {
            if (submitLabel) submitLabel.innerText = '登录';
            if (authSubdesc) authSubdesc.innerText = '首次使用请切换至「注册」以创建账户。';
            if (authSwitchText) authSwitchText.innerText = '还没有账号？';
            if (btnAuthSwitch) btnAuthSwitch.innerText = '立即注册';
        }
        if (authErrorMsg) authErrorMsg.style.display = 'none';
    };

    authTabLogin?.addEventListener('click', () => updateAuthMode(false));
    authTabRegister?.addEventListener('click', () => updateAuthMode(true));
    btnAuthSwitch?.addEventListener('click', () => updateAuthMode(!state.isRegisterMode));

    window._chillinLogin = doLogin;
    document.getElementById('btn-auth-submit')?.addEventListener('click', doLogin);
    document.getElementById('auth-password')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doLogin();
    });
    document.getElementById('auth-username')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('auth-password')?.focus();
    });
}

export async function apiRequest(path, options = {}) {
    const timeoutMs = options.timeout || 25000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };
        if (state.authToken) {
            headers['Authorization'] = `Bearer ${state.authToken}`;
        }

        const res = await fetchWithFallback(path, {
            ...options,
            signal: controller.signal,
            headers
        });

        if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/register' && path !== '/api/auth/logout') {
            if (!options._isRetry) {
                await new Promise(r => setTimeout(r, 300));
                return await apiRequest(path, { ...options, _isRetry: true });
            }
            logout({ reason: 'expired' });
            throw new Error('未登录或登录状态已过期，请重新登录');
        }
        if (!res.ok) {
            let detail = '';
            try {
                const errBody = await res.json();
                detail = errBody && errBody.error ? String(errBody.error) : '';
            } catch (_) {}
            throw new Error(detail || `接口请求异常 (${res.status})`);
        }
        return res.json();
    } catch (err) {
        if (err.name === 'AbortError' || (err.message && (err.message.includes('aborted') || err.message.includes('signal')))) {
            throw new Error('网络请求超时，请检查网络后重试');
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * 用服务端 HttpOnly Cookie 恢复会话（刷新后 localStorage 里已没有令牌的情况）。
 * 旧后端不认 Cookie 时会静默失败，不影响原有 Bearer 流程。
 */
export async function restoreCookieSession() {
    if (state.authToken) return false;
    try {
        const res = await fetchWithFallback('/api/auth/me', {
            method: 'GET',
            headers: { Accept: 'application/json' }
        });
        if (!res.ok) {
            if (res.status === 401 && (state.authUser || state.cookieSession)) {
                logout({ reason: 'expired', silent: false });
            }
            return false;
        }
        const user = await res.json();
        if (!user || !user.id) {
            if (state.authUser || state.cookieSession) {
                logout({ reason: 'expired', silent: false });
            }
            return false;
        }
        state.cookieSession = true;
        state.authUser = { id: user.id, username: user.username };
        localStorage.setItem('chillin_user', JSON.stringify(state.authUser));
        return true;
    } catch {
        // 离线/弱网超时：保留乐观会话状态，允许在无网环境下继续使用本地离线数据
        return false;
    }
}

/** 退出所有设备：吊销该账号在服务端的全部会话 */
export async function logoutAllDevices() {
    if (!(await confirmDialog('将退出所有设备上的登录状态，是否继续？'))) return;
    try {
        await apiRequest('/api/auth/logout-all', { method: 'POST' });
    } catch (_) {}
    logout({ silent: true });
    showToast('已退出所有设备', 'info');
}


/** 修改密码：校验一致性后提交，成功后清空输入并刷新设备列表 */
async function changePassword() {
    const currentEl = document.getElementById('pwd-current');
    const newEl = document.getElementById('pwd-new');
    const confirmEl = document.getElementById('pwd-confirm');
    const btn = document.getElementById('btn-change-password');
    const currentPassword = currentEl?.value || '';
    const newPassword = newEl?.value || '';
    const confirmPassword = confirmEl?.value || '';

    if (!currentPassword) {
        showToast('请输入当前密码', 'warn');
        currentEl?.focus();
        return;
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
        showToast('新密码需为 8–128 位', 'warn');
        newEl?.focus();
        return;
    }
    if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
        showToast('新密码需同时包含字母和数字', 'warn');
        newEl?.focus();
        return;
    }
    if (newPassword !== confirmPassword) {
        showToast('两次输入的新密码不一致', 'warn');
        confirmEl?.focus();
        return;
    }
    if (newPassword === currentPassword) {
        showToast('新密码不能与当前密码相同', 'warn');
        newEl?.focus();
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = '更新中…';
    }
    try {
        const res = await apiRequest('/api/auth/password', {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword })
        });
        if (res && res.success) {
            for (const el of [currentEl, newEl, confirmEl]) {
                if (el) el.value = '';
            }
            showToast(res.revokedSessions > 0
                ? `密码已更新，已在 ${res.revokedSessions} 台其它设备上退出登录`
                : '密码已更新', 'ok');
            try {
                renderSessions(await apiRequest('/api/auth/sessions'));
            } catch (_) { /* 设备列表刷新失败不影响改密结果 */ }
        }
    } catch (err) {
        showToast(err?.message || '修改密码失败，请稍后再试', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '更新密码';
        }
    }
}

/** 滑动续期：启动时静默换新令牌（Cookie 模式），避免固定 7 天到期被强制登出 */
export async function refreshSession() {
    if (!state.authToken && !state.cookieSession) return false;
    try {
        const res = await apiRequest('/api/auth/refresh', { method: 'POST' });
        return !!(res && res.success);
    } catch (_) {
        return false;
    }
}

function formatSessionTime(ms) {
    if (!ms) return '未知';
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return '未知';
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (sameDay(d, now)) return `今天 ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(d, yesterday)) return `昨天 ${time}`;
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 设备类型只用于装饰；不展示原始 IP，避免把设备列表变成一行难读的地址。 */
function sessionDeviceIcon(device) {
    const name = String(device || '').toLowerCase();
    if (/ipad|tablet|平板/.test(name)) {
        return '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>';
    }
    if (/iphone|android|ios|mobile|手机/.test(name)) {
        return '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>';
    }
    return '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>';
}

function renderSessions(list) {
    const container = document.getElementById('session-list');
    if (!container) return;
    const countEl = document.getElementById('session-count');
    if (countEl) countEl.textContent = Array.isArray(list) && list.length ? `${list.length} 台` : '';
    if (!Array.isArray(list) || list.length === 0) {
        setHtml(container, '<div class="session-empty">暂无可用的登录设备</div>');
        return;
    }
    setHtml(container, list.map((s) => `
        <div class="session-row${s.current ? ' is-current' : ''}">
            <span class="session-device-icon" aria-hidden="true">${sessionDeviceIcon(s.device)}</span>
            <div class="session-main">
                <div class="session-device"><span class="session-device-name">${escapeHtml(s.device)}</span>${s.current ? ' <span class="session-badge">当前设备</span>' : ''}</div>
                <div class="session-meta">最近活跃 ${formatSessionTime(s.lastSeenAt)}</div>
            </div>
            ${s.current ? '' : `<button type="button" class="btn-text text-danger session-revoke" data-session-id="${escapeHtml(s.id)}">退出</button>`}
        </div>
    `).join(''));
}

/** 打开「账号与安全」：登录设备、通知开关、全端退出 */
export async function openSecurityModal() {
    const modal = document.getElementById('account-security-modal');
    if (!modal) return;
    modal.classList.add('show');
    updateStorageDiagnostics();
    updatePushNotificationStatus();
    updateBackupGuardUI();
    loadBotProfile();
    loadBotPreferences();
    loadBotOutreach();
    loadBotClawStatus();
    markAppThemeControl();
    const container = document.getElementById('session-list');
    const countEl = document.getElementById('session-count');
    if (countEl) countEl.textContent = '';
    if (container) setHtml(container, '<div class="session-empty">正在读取登录设备…</div>');
    try {
        renderSessions(await apiRequest('/api/auth/sessions'));
    } catch (_) {
        if (container) setHtml(container, '<div class="session-empty">读取失败，请稍后重试</div>');
    }
}

const PUSH_SYNC_FAILED_KEY = 'chillin_push_sync_failed';
let pushServerState = (() => {
    try {
        return localStorage.getItem(PUSH_SYNC_FAILED_KEY) ? 'failed' : 'unknown';
    } catch (_) {
        return 'unknown';
    }
})();

function rememberPushServerState(next) {
    pushServerState = next;
    try {
        if (next === 'failed') localStorage.setItem(PUSH_SYNC_FAILED_KEY, '1');
        else localStorage.removeItem(PUSH_SYNC_FAILED_KEY);
    } catch (_) {}
}

/** 刷新系统推送通知状态指示与操作按钮 */
export function updatePushNotificationStatus() {
    const badge = document.getElementById('push-status-badge');
    const btnEnable = document.getElementById('btn-enable-push');
    const btnTest = document.getElementById('btn-test-push');
    const hint = document.getElementById('push-status-hint');
    if (!badge || !btnEnable || !btnTest) return;

    if (typeof window === 'undefined' || typeof Notification === 'undefined' || !('serviceWorker' in navigator)) {
        badge.textContent = '不受支持';
        badge.classList.remove('is-persisted');
        btnEnable.style.display = 'none';
        btnTest.style.display = 'none';
        if (hint) hint.textContent = '当前浏览器或运行环境不支持系统级通知';
        return;
    }

    const permission = Notification.permission;
    if (permission === 'granted') {
        if (pushServerState === 'failed') {
            badge.textContent = '待同步';
            badge.classList.remove('is-persisted');
            btnEnable.style.display = 'inline-block';
            btnEnable.textContent = '重试同步';
            btnEnable.disabled = false;
            btnTest.style.display = 'none';
            if (hint) hint.textContent = '本机通知已授权，但订阅尚未同步到服务器；点「重试同步」再试一次';
        } else {
            badge.textContent = '已开启';
            badge.classList.add('is-persisted');
            btnEnable.style.display = 'none';
            btnTest.style.display = 'inline-block';
            if (hint) hint.textContent = '设备通知已授权就绪，轻按「测试通知」可向系统通知中心发送测试消息';
        }
    } else if (permission === 'denied') {
        badge.textContent = '已拦截';
        badge.classList.remove('is-persisted');
        btnEnable.style.display = 'inline-block';
        btnEnable.textContent = '权限受限';
        btnEnable.disabled = true;
        btnTest.style.display = 'none';
        if (hint) hint.textContent = '通知权限已被浏览器拒绝，请在浏览器或手机系统设置中解除拦截';
    } else {
        badge.textContent = '未开启';
        badge.classList.remove('is-persisted');
        btnEnable.style.display = 'inline-block';
        btnEnable.textContent = '开启通知';
        btnEnable.disabled = false;
        btnTest.style.display = 'none';
        if (hint) hint.textContent = '开启后可在设备通知中心接收每日偶想提醒与周年记忆唤醒';
    }
}

/** 发送一条本地/系统级测试通知，让用户直观验证通知中心接收能力 */
export async function sendTestNotification() {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
        showToast('请先开启系统通知权限', 'warn');
        return;
    }
    const btnTest = document.getElementById('btn-test-push');
    if (btnTest) {
        btnTest.disabled = true;
        btnTest.textContent = '发送中…';
    }
    try {
        let sent = false;
        let lastError = null;
        const options = {
            body: '通知已就绪 · 在这里，随时安放思绪与时光回响',
            icon: '/icons/transparent.png',
            tag: 'chillin-test-' + Date.now(),
            renotify: true,
            vibrate: [100, 50, 100],
            data: { url: '/#/feeds' }
        };

        // 1. 优先尝试 Service Worker 通知通道（支持移动端/PWA/后台通知）
        if ('serviceWorker' in navigator) {
            try {
                // 优先直接获取当前 registration，无挂起延迟；若无则快速等待 ready
                let reg = await navigator.serviceWorker.getRegistration();
                if (!reg || typeof reg.showNotification !== 'function') {
                    reg = await Promise.race([
                        navigator.serviceWorker.ready,
                        new Promise((_, reject) => setTimeout(() => reject(new Error('等待 ServiceWorker 超时')), 4000))
                    ]);
                }
                if (reg && typeof reg.showNotification === 'function') {
                    await reg.showNotification('Chillin', options);
                    sent = true;
                }
            } catch (swErr) {
                lastError = swErr;
                console.warn('[Push] ServiceWorker showNotification fallback:', swErr);
            }
        }

        // 2. 桌面端原生 Notification 兜底（直接呼起系统通知横幅，无需等待 SW）
        if (!sent && typeof Notification !== 'undefined') {
            try {
                const n = new Notification('Chillin', options);
                n.onclick = () => { window.focus(); n.close(); };
                sent = true;
            } catch (nativeErr) {
                lastError = lastError || nativeErr;
                console.warn('[Push] Native Notification fallback failed:', nativeErr);
            }
        }

        if (sent) {
            showToast('🔔 测试通知已发出！若未弹出横幅，请下拉通知栏查看', 'ok');
        } else {
            showToast('通知发送受阻：' + (lastError?.message || '请检查系统免打扰或浏览器通知权限'), 'warn');
        }
    } catch (err) {
        showToast('发送测试通知失败：' + (err.message || err), 'error');
    } finally {
        if (btnTest) {
            btnTest.disabled = false;
            btnTest.textContent = '测试通知';
        }
    }
}

/** 更新本地存储与离线韧性诊断指标 */
export async function updateStorageDiagnostics() {
    const usageText = document.getElementById('storage-usage-text');
    const fillBar = document.getElementById('storage-progress-fill');
    const persistBadge = document.getElementById('storage-persist-badge');
    if (!usageText) return;

    try {
        const est = await getStorageEstimate();
        if (est.quotaBytes > 0) {
            usageText.textContent = `${est.usageFormatted} / ${est.quotaFormatted} (${est.percent}%)`;
            if (fillBar) fillBar.style.width = `${Math.max(est.percent, 1)}%`;
        } else {
            usageText.textContent = est.usageFormatted || '就绪';
            if (fillBar) fillBar.style.width = '2%';
        }

        if (persistBadge) {
            if (est.isPersistent) {
                persistBadge.textContent = '持久化已保障';
                persistBadge.classList.add('is-persisted');
            } else {
                persistBadge.textContent = '标准存储';
                persistBadge.classList.remove('is-persisted');
            }
        }
    } catch (e) {
        if (usageText) usageText.textContent = 'IndexedDB 就绪';
    }
}

async function revokeSession(sessionId) {
    if (!sessionId) return;
    if (!(await confirmDialog('退出该设备上的登录？'))) return;
    try {
        const res = await apiRequest(`/api/auth/sessions/${sessionId}`, { method: 'DELETE' });
        if (res && res.current) {
            logout({ silent: true });
            showToast('已退出当前设备', 'info');
            return;
        }
        showToast('已退出该设备', 'info');
        openSecurityModal();
    } catch (err) {
        showToast((err && err.message) || '退出失败，请稍后重试', 'error');
    }
}

export async function registerPushNotification() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        showToast('当前浏览器环境不支持系统通知推送', 'warn');
        return;
    }
    try {
        const reg = await navigator.serviceWorker.ready;
        const permission = await Notification.requestPermission();
        updatePushNotificationStatus();
        if (permission !== 'granted') {
            showToast('已取消或未授予系统通知权限', 'info');
            return;
        }

        const existingSub = await reg.pushManager.getSubscription();
        if (existingSub) {
            if (!(await syncPushSubscription(existingSub))) return;
            updatePushNotificationStatus();
            showToast('已成功开启设备推送通知！', 'ok');
            return;
        }

        const VAPID_PUBLIC_KEY = 'BBj8FZZ57_GfEm-HGPo9pXRA5jsd4FAzu-3bQJC7KjAoGp3TWlDGFt5D22JadZ6t5bw9u6NDNsy4Vgny9v3r2e0';
        const subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
        if (!(await syncPushSubscription(subscription))) return;
        updatePushNotificationStatus();
        showToast('已成功开启设备推送通知！', 'ok');
    } catch (e) {
        console.error('Push registration failed:', e);
        showToast('开启推送失败：' + (e?.message || e), 'warn');
    }
}

async function syncPushSubscription(subscription) {
    try {
        await sendSubscriptionToServer(subscription);
        rememberPushServerState('ok');
        return true;
    } catch (e) {
        console.error('Failed to sync subscription:', e);
        rememberPushServerState('failed');
        updatePushNotificationStatus();
        showToast('本机通知已授权，但订阅同步到服务器失败；请点「重试同步」', 'warn');
        return false;
    }
}

async function sendSubscriptionToServer(subscription) {
    await apiRequest('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify(subscription)
    });
}
/** 「关于我」档案条目：应用内查看 / 编辑 / 遗忘（与微信端共用同一份记忆） */
let editingProfileId = null;

function renderBotProfile(items) {
    const container = document.getElementById('bot-profile-list');
    if (!container) return;
    if (!Array.isArray(items) || items.length === 0) {
        setHtml(container, '<div class="session-empty">还没有关于你的记录。在微信里发「记住：…」，或在上面的输入框加一条。</div>');
        return;
    }
    setHtml(container, items.map((it) => {
        const id = escapeHtml(String(it.id));
        if (String(it.id) === String(editingProfileId)) {
            return '<div class="session-row">'
                + '<input type="text" class="session-edit-input" data-profile-edit="' + id + '" maxlength="240" value="' + escapeHtml(String(it.content || '')) + '" aria-label="编辑这条档案">'
                + '<button type="button" class="btn-text bot-profile-edit profile-save" data-profile-id="' + id + '">保存</button>'
                + '<button type="button" class="btn-text bot-profile-edit profile-cancel">取消</button>'
                + '</div>';
        }
        const label = it.label ? escapeHtml(String(it.label)) + ' · ' : '';
        const when = escapeHtml(String(it.created_at || '').slice(0, 16));
        return '<div class="session-row">'
            + '<div class="session-main">'
            + '<div class="bot-profile-content">' + escapeHtml(String(it.content || '')) + '</div>'
            + '<div class="session-meta">' + label + when + '</div>'
            + '</div>'
            + '<button type="button" class="btn-text bot-profile-edit profile-edit" data-profile-id="' + id + '">改</button>'
            + '<button type="button" class="btn-text bot-profile-forget profile-forget" data-profile-id="' + id + '">忘</button>'
            + '</div>';
    }).join(''));
}

async function loadBotProfile() {
    const container = document.getElementById('bot-profile-list');
    if (!container) return;
    setHtml(container, '<div class="session-empty">正在读取档案…</div>');
    try {
        const data = await apiRequest('/api/bot/profile');
        renderBotProfile(data && data.items);
    } catch (_) {
        setHtml(container, '<div class="session-empty">读取失败，请稍后重试</div>');
    }
}

async function addBotProfileFromInput() {
    const input = document.getElementById('bot-profile-input');
    const content = input ? String(input.value || '').trim() : '';
    if (!content) { showToast('先写一条内容再点「记住」', 'warn'); if (input) input.focus(); return; }
    try {
        const res = await apiRequest('/api/bot/profile', { method: 'POST', body: JSON.stringify({ content: content }) });
        if (input) input.value = '';
        showToast(res && res.duplicate ? '这条档案里已经有了' : '好，记住了', 'success');
        await loadBotProfile();
    } catch (e) {
        showToast('没记下来：' + (e && e.message ? e.message : e), 'warn');
    }
}

function onBotProfileListClick(e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const edit = target.closest('.profile-edit');
    if (edit && edit.dataset.profileId) { editingProfileId = edit.dataset.profileId; loadBotProfile(); return; }
    if (target.closest('.profile-cancel')) { editingProfileId = null; loadBotProfile(); return; }
    const save = target.closest('.profile-save');
    if (save && save.dataset.profileId) {
        const row = save.closest('.session-row');
        const field = row ? row.querySelector('[data-profile-edit]') : null;
        saveBotProfileItem(save.dataset.profileId, field ? field.value : '');
        return;
    }
    const forget = target.closest('.profile-forget');
    if (forget && forget.dataset.profileId) forgetBotProfileItem(forget.dataset.profileId);
}

async function saveBotProfileItem(id, content) {
    const body = String(content || '').trim();
    if (!body) { showToast('内容不能为空', 'warn'); return; }
    try {
        await apiRequest('/api/bot/profile/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ content: body }) });
        editingProfileId = null;
        showToast('已更新', 'success');
        await loadBotProfile();
    } catch (e) {
        showToast('更新失败：' + (e && e.message ? e.message : e), 'warn');
    }
}

async function forgetBotProfileItem(id) {
    if (!(await confirmDialog('忘掉这条关于你的记录？', { confirmText: '忘掉' }))) return;
    try {
        await apiRequest('/api/bot/profile/' + encodeURIComponent(id), { method: 'DELETE' });
        showToast('已忘掉', 'success');
        await loadBotProfile();
    } catch (e) {
        showToast('操作失败：' + (e && e.message ? e.message : e), 'warn');
    }
}

async function clearBotProfileAll() {
    if (!(await confirmDialog('清空整份「关于我」档案？', { confirmText: '清空' }))) return;
    try {
        const res = await apiRequest('/api/bot/profile/clear', { method: 'POST' });
        showToast(res && res.removed ? '已清空 ' + res.removed + ' 条' : '档案本来就是空的', 'success');
        await loadBotProfile();
    } catch (e) {
        showToast('操作失败：' + (e && e.message ? e.message : e), 'warn');
    }
}

/** Bot 交流偏好：应用内查看 / 新增 / 编辑 / 遗忘（独立于「关于我」事实档案） */
let editingPreferenceId = null;

function preferenceSourceLabel(source) {
    if (source === 'feedback') return '来自微信反馈';
    if (source === 'explicit') return '来自微信';
    return '手动设定';
}

function renderBotPreferences(items) {
    const container = document.getElementById('bot-preference-list');
    if (!container) return;
    if (!Array.isArray(items) || items.length === 0) {
        setHtml(container, '<div class="session-empty">还没有交流偏好。在微信里说「太官方了」「太啰嗦了」，或在上面的输入框加一条。</div>');
        return;
    }
    setHtml(container, items.map((it) => {
        const id = escapeHtml(String(it.id));
        const label = escapeHtml(String(it.label || '交流偏好'));
        if (String(it.id) === String(editingPreferenceId)) {
            return '<div class="session-row">'
                + '<input type="text" class="session-edit-input" data-preference-edit="' + id + '" maxlength="240" value="' + escapeHtml(String(it.content || '')) + '" aria-label="编辑这条交流偏好">'
                + '<button type="button" class="btn-text bot-profile-edit preference-save" data-preference-id="' + id + '">保存</button>'
                + '<button type="button" class="btn-text bot-profile-edit preference-cancel">取消</button>'
                + '</div>';
        }
        return '<div class="session-row">'
            + '<div class="session-main">'
            + '<div class="bot-profile-content">' + escapeHtml(String(it.content || '')) + '</div>'
            + '<div class="session-meta">' + label + ' · ' + preferenceSourceLabel(String(it.source || '')) + '</div>'
            + '</div>'
            + '<button type="button" class="btn-text bot-profile-edit preference-edit" data-preference-id="' + id + '">改</button>'
            + '<button type="button" class="btn-text bot-profile-forget preference-forget" data-preference-id="' + id + '">忘</button>'
            + '</div>';
    }).join(''));
}

async function loadBotPreferences() {
    const container = document.getElementById('bot-preference-list');
    if (!container) return;
    setHtml(container, '<div class="session-empty">正在读取交流偏好…</div>');
    try {
        const data = await apiRequest('/api/bot/preferences');
        renderBotPreferences(data && data.items);
    } catch (_) {
        setHtml(container, '<div class="session-empty">读取失败，请稍后重试</div>');
    }
}

async function addBotPreferenceFromInput() {
    const key = document.getElementById('bot-preference-key');
    const input = document.getElementById('bot-preference-input');
    const content = input ? String(input.value || '').trim() : '';
    if (!content) { showToast('先写一条偏好再点「设定」', 'warn'); if (input) input.focus(); return; }
    try {
        await apiRequest('/api/bot/preferences', {
            method: 'POST',
            body: JSON.stringify({ key: key ? key.value : 'custom', content: content })
        });
        if (input) input.value = '';
        editingPreferenceId = null;
        showToast('好，偏好已设定', 'success');
        await loadBotPreferences();
    } catch (e) {
        showToast('没设定成功：' + (e && e.message ? e.message : e), 'warn');
    }
}

function onBotPreferenceListClick(e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const edit = target.closest('.preference-edit');
    if (edit && edit.dataset.preferenceId) { editingPreferenceId = edit.dataset.preferenceId; loadBotPreferences(); return; }
    if (target.closest('.preference-cancel')) { editingPreferenceId = null; loadBotPreferences(); return; }
    const save = target.closest('.preference-save');
    if (save && save.dataset.preferenceId) {
        const row = save.closest('.session-row');
        const field = row ? row.querySelector('[data-preference-edit]') : null;
        saveBotPreferenceItem(save.dataset.preferenceId, field ? field.value : '');
        return;
    }
    const forget = target.closest('.preference-forget');
    if (forget && forget.dataset.preferenceId) forgetBotPreferenceItem(forget.dataset.preferenceId);
}

async function saveBotPreferenceItem(id, content) {
    const body = String(content || '').trim();
    if (!body) { showToast('内容不能为空', 'warn'); return; }
    try {
        await apiRequest('/api/bot/preferences/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ content: body }) });
        editingPreferenceId = null;
        showToast('已更新', 'success');
        await loadBotPreferences();
    } catch (e) {
        showToast('更新失败：' + (e && e.message ? e.message : e), 'warn');
    }
}

async function forgetBotPreferenceItem(id) {
    if (!(await confirmDialog('忘掉这条交流偏好？', { confirmText: '忘掉' }))) return;
    try {
        await apiRequest('/api/bot/preferences/' + encodeURIComponent(id), { method: 'DELETE' });
        showToast('已忘掉', 'success');
        await loadBotPreferences();
    } catch (e) {
        showToast('操作失败：' + (e && e.message ? e.message : e), 'warn');
    }
}

async function clearBotPreferencesAll() {
    if (!(await confirmDialog('清空全部交流偏好？', { confirmText: '清空' }))) return;
    try {
        const res = await apiRequest('/api/bot/preferences/clear', { method: 'POST' });
        showToast(res && res.removed ? '已清空 ' + res.removed + ' 条' : '偏好本来就是空的', 'success');
        await loadBotPreferences();
    } catch (e) {
        showToast('操作失败：' + (e && e.message ? e.message : e), 'warn');
    }
}

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
        hint.textContent = '每天最多一次，10:00–22:30 之间；刚聊完的 30 分钟内不会打扰，之后翻到 3 天前旧记录时才可能开口。';
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

async function toggleBotOutreach() {
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
        qrHint: document.getElementById('bot-claw-qr-hint'),
        qrNote: document.getElementById('bot-claw-qr-note'),
        cancel: document.getElementById('btn-bot-claw-cancel')
    };
}

function stopBotClawPolling() {
    if (clawPollTimer) { clearInterval(clawPollTimer); clawPollTimer = 0; }
    clawCheckInFlight = false;
    clawLastCheckAt = 0;
}

function hideBotClawQr() {
    const els = clawEls();
    if (els.qr) els.qr.hidden = true;
    if (els.img) { els.img.onerror = null; els.img.removeAttribute('src'); }
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

function renderBotClawStatus(state) {
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

async function loadBotClawStatus() {
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

async function startBotClawBind() {
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
        if (!/^(https:\/\/|data:image\/)/i.test(src)) throw new Error('二维码地址无效');
        const ttl = Math.max(CLAW_QR_MIN_TTL_SECONDS, Number(qr && qr.ttlSeconds) || 90);
        els.img.onerror = () => expireBotClawQr('二维码图片加载失败，请重新生成。');
        els.img.src = src;
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

function cancelBotClawScan() {
    stopBotClawPolling();
    hideBotClawQr();
    const els = clawEls();
    if (els.title) els.title.textContent = '未完成绑定';
    if (els.hint) els.hint.textContent = '二维码已取消，需要时可重新生成。';
    if (els.bind) { els.bind.hidden = false; els.bind.disabled = false; els.bind.textContent = '绑定微信'; }
}

async function pollBotClawOnce() {
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

function startBotClawPolling() {
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

async function unbindBotClaw() {
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

/** 把已保存的外观模式映射到「外观」分段控件的选中态（批次 A） */
function markAppThemeControl() {
    const mode = getAppThemeMode();
    document.querySelectorAll('#app-theme-control .segment-btn').forEach((btn) => {
        btn.classList.toggle('active', (btn.dataset.appTheme || 'auto') === mode);
    });
}

function onAppThemeControlClick(e) {
    const btn = e.target instanceof Element ? e.target.closest('.segment-btn[data-app-theme]') : null;
    if (!btn) return;
    setAppThemeMode(btn.dataset.appTheme);
    markAppThemeControl();
}
