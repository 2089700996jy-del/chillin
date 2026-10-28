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
    // 让读屏能听到提示：错误用 alert（打断），其余走容器里的 polite live region
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-atomic', 'true');
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

// ── 时间轴筛选：周记 / 随手记共用的年、月过滤 ──
// 纯前端过滤，断网时仍然可用；不改变同步口径，也不把本地数据裁成服务器第一页。
export function parseYearMonth(value) {
    const match = /^(\d{4})-(\d{2})/.exec(String(value || '').trim());
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!Number.isInteger(year) || year < 1970 || year > 9999) return null;
    if (!Number.isInteger(month) || month < 1 || month > 12) return null;
    return { year: String(year), month: String(month).padStart(2, '0') };
}

/** CSS.escape 会把纯数字 id 写成 \34 这种转义串；搜索跳转解析选择器时要还原成真实 id。 */
export function decodeCssEscapedId(value) {
    return String(value || '')
        .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/\\(.)/g, '$1');
}

export function filterItemsByYearMonth(items, getDate, year = 'all', month = 'all') {
    const list = Array.isArray(items) ? items : [];
    // 月份必须依附年份：UI 在「全部年份」时禁用月份，纯函数也保持同一语义，避免跨年混筛。
    if (year === 'all' && month !== 'all') return [];
    if (year === 'all' && month === 'all') return list.slice();
    return list.filter((item) => {
        const parts = parseYearMonth(typeof getDate === 'function' ? getDate(item) : '');
        if (!parts) return false;
        if (year !== 'all' && parts.year !== String(year)) return false;
        if (month !== 'all' && parts.month !== String(month).padStart(2, '0')) return false;
        return true;
    });
}

/**
 * 把「全部年份 / 全部月份」下拉接到一个列表上。
 * update() 只重建计数与选项，不触发 onChange；用户改选时才调用 onChange。
 */
export function mountDateFilter(root, opts = {}) {
    if (!root) return null;
    const yearEl = root.querySelector('[data-date-year]');
    const monthEl = root.querySelector('[data-date-month]');
    const resetEl = root.querySelector('[data-date-reset]');
    const countEl = root.querySelector('[data-date-count]');
    if (!yearEl || !monthEl) return null;
    const readDate = typeof opts.getDate === 'function' ? opts.getDate : () => '';
    const unit = opts.unit === '篇' ? '篇' : '条';
    let items = [];
    let value = { year: 'all', month: 'all' };

    const yearCounts = () => {
        const map = new Map();
        for (const item of items) {
            const parts = parseYearMonth(readDate(item));
            if (!parts) continue;
            map.set(parts.year, (map.get(parts.year) || 0) + 1);
        }
        return map;
    };

    const monthCounts = (year) => {
        const map = new Map();
        for (const item of items) {
            const parts = parseYearMonth(readDate(item));
            if (!parts || parts.year !== year) continue;
            map.set(parts.month, (map.get(parts.month) || 0) + 1);
        }
        return map;
    };

    const option = (valueText, text) => {
        const el = document.createElement('option');
        el.value = valueText;
        el.textContent = text;
        return el;
    };

    const paint = () => {
        const years = yearCounts();
        if (years.size === 0) {
            root.hidden = true;
            return;
        }
        root.hidden = false;
        if (value.year !== 'all' && !years.has(value.year)) value = { year: 'all', month: 'all' };

        yearEl.replaceChildren(option('all', '全部年份'));
        [...years.keys()].sort((a, b) => b.localeCompare(a)).forEach((year) => {
            yearEl.appendChild(option(year, year + '（' + years.get(year) + '）'));
        });
        yearEl.value = value.year;

        if (value.year === 'all') {
            value.month = 'all';
            monthEl.replaceChildren(option('all', '全部月份'));
            monthEl.disabled = true;
        } else {
            const months = monthCounts(value.year);
            if (value.month !== 'all' && !months.get(value.month)) value.month = 'all';
            monthEl.replaceChildren(option('all', '全部月份'));
            [...months.keys()].sort().forEach((month) => {
                monthEl.appendChild(option(month, month + ' 月（' + months.get(month) + '）'));
            });
            monthEl.value = value.month;
            monthEl.disabled = false;
        }

        if (resetEl) resetEl.hidden = value.year === 'all' && value.month === 'all';
        if (countEl) {
            const active = value.year !== 'all';
            const shown = active ? filterItemsByYearMonth(items, readDate, value.year, value.month).length : items.length;
            const nextText = active ? shown + ' / ' + items.length + ' ' + unit : items.length + ' ' + unit;
            if (countEl.textContent !== nextText) countEl.textContent = nextText;
        }
    };

    const emit = () => {
        if (typeof opts.onChange === 'function') opts.onChange({ ...value });
    };

    yearEl.addEventListener('change', () => {
        value = { year: yearEl.value || 'all', month: 'all' };
        paint();
        emit();
    });
    monthEl.addEventListener('change', () => {
        value = { year: value.year, month: monthEl.value || 'all' };
        paint();
        emit();
    });
    resetEl?.addEventListener('click', () => {
        value = { year: 'all', month: 'all' };
        paint();
        emit();
    });

    return {
        update(nextItems) {
            items = Array.isArray(nextItems) ? nextItems : [];
            paint();
        },
        getValue() { return { ...value }; },
        isActive() { return value.year !== 'all'; },
        reset() {
            value = { year: 'all', month: 'all' };
            paint();
        }
    };
}

// ── 应用级主题（批次 A）：跟随系统 / 手动浅色 / 手动深色 ──
// <head> 的内联预绘脚本已经先落过一次 data-theme（避免深色偏好用户首帧闪白），
// 这里负责后续读写：持久化偏好、同步 <meta name="theme-color">、跟随系统外观切换。
const APP_THEME_KEY = 'chillin_theme';
const APP_THEME_COLOR = { dark: '#0f1115', light: '#F8F9FA' };

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


