/**
 * Auth & HTTP client: login/logout, apiRequest, push subscribe.
 * Sync side effects after login are loaded via dynamic import('./sync.js') to avoid cycles.
 */
import { showToast, urlBase64ToUint8Array } from './utils.js';
import { CLOUD_WORKER_BASE, resolveApiBase } from './config.js';
import { state } from './state.js';

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

    const looksBad = (res) => {
        if (!res) return true;
        if (res.status >= 500) return true;
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        return ct.includes('text/html');
    };

    let primaryRes = null;
    let primaryErr = null;
    try {
        primaryRes = await fetch(primaryUrl, options);
    } catch (err) {
        primaryErr = err;
    }

    if (primaryRes && !looksBad(primaryRes)) return primaryRes;

    if (isAuth || primaryErr || looksBad(primaryRes)) {
        try {
            return await fetch(workerUrl, options);
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
    if (!state.authToken) {
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
    if (state.authToken) {
        apiRequest('/api/auth/logout', { method: 'POST' }).catch(() => {});
    }
    state.authToken = '';
    state.authUser = null;
    localStorage.removeItem('chillin_token');
    localStorage.removeItem('chillin_user');
    clearSyncCursorsForUser(uid);
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
        localStorage.setItem('chillin_token', state.authToken);
        localStorage.setItem('chillin_user', JSON.stringify(state.authUser));

        checkAuth();
        showToast('登录成功，欢迎来到数字花园', 'success');
        const sync = await import('./sync.js');
        try { sync.loadLocalData(); } catch (_) {}
        Promise.resolve()
            .then(() => sync.syncFromApi())
            .catch((e) => console.warn('[login] sync after login failed', e));
        try { sync.checkAndMergeGuestData(); } catch (_) {}
        setTimeout(registerPushNotification, 2000);
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

    btnAuthSwitch?.addEventListener('click', () => {
        state.isRegisterMode = !state.isRegisterMode;
        if (state.isRegisterMode) {
            document.querySelector('.auth-btn').innerText = '注册并进入';
            if (authSwitchText) authSwitchText.innerText = '已有账号？';
            btnAuthSwitch.innerText = '直接登录';
        } else {
            document.querySelector('.auth-btn').innerText = '登录';
            if (authSwitchText) authSwitchText.innerText = '还没有账号？';
            btnAuthSwitch.innerText = '立即注册';
        }
        if (authErrorMsg) authErrorMsg.style.display = 'none';
    });

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

export async function registerPushNotification() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        const existingSub = await reg.pushManager.getSubscription();
        if (existingSub) {
            await sendSubscriptionToServer(existingSub);
            return;
        }

        const VAPID_PUBLIC_KEY = 'BBj8FZZ57_GfEm-HGPo9pXRA5jsd4FAzu-3bQJC7KjAoGp3TWlDGFt5D22JadZ6t5bw9u6NDNsy4Vgny9v3r2e0';
        const subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
        await sendSubscriptionToServer(subscription);
    } catch (e) {
        console.error('Push registration failed:', e);
    }
}

async function sendSubscriptionToServer(subscription) {
    try {
        await apiRequest('/api/push/subscribe', {
            method: 'POST',
            body: JSON.stringify(subscription)
        });
    } catch (e) {
        console.error('Failed to send subscription:', e);
    }
}
