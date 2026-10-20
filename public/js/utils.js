import { setHtml } from './trusted-types.js';
/** Shared pure helpers for Chillin (no app state). */

export function generateUniqueId() {
    return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

/**
 * 确保记录带有客户端 id。
 * 服务端以客户端 id 为准做 INSERT OR REPLACE；若缺 id，服务端会另赋一个，
 * 客户端无从得知，下次同步便可能出现重复记录或永不复位的同步失败的脏标记。
 */
export function ensureLocalId(item) {
    if (!item) return item;
    if (item.id == null || item.id === '') item.id = generateUniqueId();
    return item;
}

/**
 * 挑选需要推送的脏数据：补全缺失 id、跳过已删除（墓碑）。
 * 此前缺 id 的本地改动会被直接过滤掉，属于静默丢数据。
 */
export function selectDirtyItems(list, deletedIds) {
    const deleted = deletedIds instanceof Set ? deletedIds : new Set((deletedIds || []).map(String));
    return (list || [])
        .filter((item) => item && item._dirty && !deleted.has(String(item.id)))
        .map((item) => ensureLocalId(item));
}

export function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) {
        console.log(`[Toast ${type}] ${msg}`);
        return;
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warn' ? '⚠️' : 'ℹ️';
    setHtml(toast, `<span>${icon}</span> <span>${escapeHtml(msg)}</span>`);
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.25s ease';
        setTimeout(() => toast.remove(), 250);
    }, 3000);
}

export function urlBase64ToUint8Array(base64String) {
    if (!base64String || typeof base64String !== 'string') return new Uint8Array(0);
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const atobFn = typeof window !== 'undefined' && window.atob ? window.atob.bind(window) : atob;
    const rawData = atobFn(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

function resolveAssetUrlHelper(src) {
    if (!src || typeof src !== 'string') return '';
    if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
        return src;
    }
    const apiBase = (typeof CHILLIN_API_URL !== 'undefined' ? CHILLIN_API_URL : '').replace(/\/+$/, '');
    if (src.startsWith('/')) {
        return apiBase ? `${apiBase}${src}` : src;
    }
    return apiBase ? `${apiBase}/${src}` : `/${src}`;
}

/**
 * 从 Markdown/HTML 混排文本里按出现顺序抽取图片，供编辑器下方的图链预览使用。
 * notes.js 与 weeklies.js 曾各写一份逐字相同的解析循环，这里收敛为纯函数。
 */
export function extractImageMatches(text) {
    const val = text || '';
    const matches = [];
    const mdImgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let match;
    while ((match = mdImgRegex.exec(val)) !== null) {
        matches.push({ raw: match[0], alt: match[1] || '配图', url: match[2].trim() });
    }
    const htmlImgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    while ((match = htmlImgRegex.exec(val)) !== null) {
        matches.push({ raw: match[0], alt: '配图', url: match[1].trim() });
    }
    return matches;
}

/**
 * 批注项（notes 的「批注」与 weeklies 的「追加说明」）的 DOM 片段。
 * 两个模块此前各写了一份逐字相同的模板，只有删除回调的逻辑不同；
 * 这里只收敛模板（输出逐字保持），交互仍在各自模块里。
 */
export function annotationItemHtml(ann) {
    return `
            <div class="annotation-dot"></div>
            <div class="annotation-content-box">
                <div class="annotation-meta">
                    <span class="annotation-time">${escapeHtml(ann.date)}</span>
                    <button type="button" class="btn-delete-annotation" data-id="${ann.id}">删除</button>
                </div>
                <div class="annotation-text">${escapeHtml(ann.content)}</div>
            </div>
        `;
}

/** Markdown → safe HTML (escape first, then light formatting). */
export function markdownToHtml(text) {
    if (!text) return '';
    const lines = escapeHtml(text).split('\n');
    let html = '';
    let inUl = false, inOl = false;
    const closeLists = () => {
        if (inUl) { html += '</ul>'; inUl = false; }
        if (inOl) { html += '</ol>'; inOl = false; }
    };
    const inline = (s) => s
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => {
            const cleanAlt = (alt || '').trim() || '图片';
            const cleanSrc = (src || '').trim();
            const resolved = resolveAssetUrlHelper(cleanSrc);
            return `<span class="article-img-wrap"><img src="${resolved}" alt="${cleanAlt}" class="article-body-img" loading="lazy" decoding="async"></span>`;
        })
        .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)]+)\)/g, (m, text, url) => {
            return `<a href="${url.trim()}" target="_blank" rel="noopener noreferrer" class="article-inline-link">${text}</a>`;
        })
        .replace(/\[\[([^[\]|\n\r]+)(?:\|([^[\]|\n\r]+))?\]\]/g, (m, target, alias) => {
            const cleanTarget = (target || '').trim();
            const cleanLabel = (alias || target || '').trim();
            if (!cleanTarget) return m;
            return `<span class="wikilink-pill" data-wikilink="${cleanTarget}" role="button" tabindex="0"><span class="wikilink-icon">🔗</span><span class="wikilink-label">${cleanLabel}</span></span>`;
        })
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    for (const raw of lines) {
        const line = raw.replace(/[ \t]+$/, '');
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
            closeLists();
            const lv = h[1].length;
            html += `<h${lv}>${inline(h[2])}</h${lv}>`;
            continue;
        }
        const ul = line.match(/^\s*[-*]\s+(.*)$/);
        if (ul) {
            if (!inUl) { closeLists(); html += '<ul>'; inUl = true; }
            html += `<li>${inline(ul[1])}</li>`;
            continue;
        }
        const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ol) {
            if (!inOl) { closeLists(); html += '<ol>'; inOl = true; }
            html += `<li>${inline(ol[1])}</li>`;
            continue;
        }
        if (line.trim() === '') { closeLists(); continue; }
        closeLists();
        html += `<p>${inline(line)}</p>`;
    }
    closeLists();
    return html;
}

/** DOMPurify when available; otherwise escape to plain text. */
export function sanitizeHtml(html) {
    if (typeof window.DOMPurify !== 'undefined' && window.DOMPurify.sanitize) {
        return window.DOMPurify.sanitize(String(html || ''));
    }
    return escapeHtml(html);
}

export function autoResizeTextarea(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

export function getChineseDate() {
    const date = new Date();
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function getChineseDateTime() {
    const date = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function getIsoDate(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatChineseDate(str) {
    if (!str) return getChineseDate();
    const s = String(str).trim();
    const m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (m) {
        return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
    }
    return s;
}

export function parseIsoDate(str) {
    if (!str) return '';
    const s = String(str).trim();
    const mIso = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (mIso) return `${mIso[1]}-${String(mIso[2]).padStart(2, '0')}-${String(mIso[3]).padStart(2, '0')}`;
    const mZh = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
    if (mZh) return `${mZh[1]}-${String(mZh[2]).padStart(2, '0')}-${String(mZh[3]).padStart(2, '0')}`;
    const mDot = s.match(/\b(\d{4})[./](\d{1,2})[./](\d{1,2})\b/);
    if (mDot) return `${mDot[1]}-${String(mDot[2]).padStart(2, '0')}-${String(mDot[3]).padStart(2, '0')}`;
    return '';
}

export function getEast8Time() {
    const d = new Date();
    // 强制转换为东八区时间，不论用户当前所处时区
    const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
    const east8 = new Date(utc + (3600000 * 8));
    const pad = n => String(n).padStart(2, '0');
    return `${east8.getFullYear()}-${pad(east8.getMonth()+1)}-${pad(east8.getDate())} ${pad(east8.getHours())}:${pad(east8.getMinutes())}:${pad(east8.getSeconds())}`;
}
/**
 * 首屏同步中的骨架屏占位 HTML。
 * 弱网首同步时替代"暂无内容"空态，避免用户误判为空白 / 无数据。
 */
export function skeletonListHtml(count = 3) {
    return new Array(count).fill(0).map(() => `
        <div class="skeleton-card" aria-hidden="true">
            <div class="skeleton-line skeleton-line--title"></div>
            <div class="skeleton-line"></div>
            <div class="skeleton-line skeleton-line--short"></div>
        </div>
    `).join('');
}

/** 是否正处于同步中（同步指示灯点亮时展示骨架屏） */

/**
 * 应用内确认弹窗（Promise<boolean>），替代原生 confirm：
 * 原生弹窗会打断键盘/读屏流，也无法主题化。
 */
export function confirmDialog(message, opts = {}) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-dialog-modal');
        const text = document.getElementById('confirm-dialog-message');
        const okBtn = document.getElementById('confirm-dialog-ok');
        const cancelBtn = document.getElementById('confirm-dialog-cancel');
        if (!modal || !text || !okBtn || !cancelBtn) {
            // 兜底：DOM 缺失时退回原生（保证功能不中断）
            resolve(window.confirm(message));
            return;
        }
        text.textContent = message;
        okBtn.textContent = opts.confirmText || '确定';
        cancelBtn.textContent = opts.cancelText || '取消';
        okBtn.classList.toggle('text-danger', opts.danger !== false);

        const finish = (value) => {
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            modal.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onKeydown, true);
            modal.classList.remove('show');
            resolve(value);
        };
        const onOk = () => finish(true);
        const onCancel = () => finish(false);
        const onBackdrop = (e) => { if (e.target === modal) finish(false); };
        const onKeydown = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        modal.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKeydown, true);
        modal.classList.add('show');
        setTimeout(() => okBtn.focus(), 30);
    });
}

export function isSyncingNow() {
    return typeof document !== 'undefined' && document.body.classList.contains('is-syncing');
}

// ── 应用级主题（批次 A）：跟随系统 / 手动浅色 / 手动深色 ──
// <head> 的内联预绘脚本已经先落过一次 data-theme（避免深色偏好用户首帧闪白），
// 这里负责后续读写：持久化偏好、同步 <meta name="theme-color">、跟随系统外观切换。
const APP_THEME_KEY = 'chillin_theme';
const APP_THEME_COLOR = { dark: '#0f1115', light: '#F2F2F7' };

export function getAppThemeMode() {
    try {
        const saved = localStorage.getItem(APP_THEME_KEY);
        return saved === 'light' || saved === 'dark' ? saved : 'auto';
    } catch (_) {
        return 'auto';
    }
}

function prefersDarkScheme() {
    return typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : false;
}

/** 把模式（auto/light/dark）落到 <html data-theme> 与 theme-color 上，返回实际生效的主题。 */
export function applyAppTheme(mode = getAppThemeMode()) {
    const effective = mode === 'dark' || (mode !== 'light' && prefersDarkScheme()) ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', effective);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', APP_THEME_COLOR[effective]);
    return effective;
}

export function setAppThemeMode(mode) {
    const next = mode === 'light' || mode === 'dark' ? mode : 'auto';
    try {
        if (next === 'auto') localStorage.removeItem(APP_THEME_KEY);
        else localStorage.setItem(APP_THEME_KEY, next);
    } catch (_) { /* 隐私模式下写不进去，本次会话内仍然生效 */ }
    return applyAppTheme(next);
}

/** 启动时调用一次；只有「跟随系统」时才响应系统外观切换。 */
export function initAppTheme() {
    const effective = applyAppTheme();
    if (typeof window !== 'undefined' && window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => { if (getAppThemeMode() === 'auto') applyAppTheme('auto'); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
    }
    return effective;
}


