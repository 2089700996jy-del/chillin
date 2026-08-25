/** Shared pure helpers for Chillin (no app state). */

export function generateUniqueId() {
    return Date.now() * 1000 + Math.floor(Math.random() * 1000);
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
    toast.innerHTML = `<span>${icon}</span> <span>${escapeHtml(msg)}</span>`;
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
