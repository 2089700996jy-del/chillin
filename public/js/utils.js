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
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
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

