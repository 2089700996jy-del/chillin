/**
 * Chillin 全量备份与资产导出引擎 (Backup & Export Engine)
 * 纯原生零构建规范：生成跨平台标准 PKZIP 包（Markdown + Netscape HTML + JSON），
 * 支持本地一键极速下载与 Cloudflare Worker Resend 邮件直发。
 */
import { state } from './state.js';
import { showToast } from './utils.js';
import { apiRequest } from './api.js';

function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
        }
        table[n] = c;
    }
    return table;
}
const crcTable = makeCrcTable();

export function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** 纯原生 PKZIP 打包（Stored 格式，零外部依赖，100% 兼容 Windows/macOS/iOS/Android/Linux） */
export function createZip(files) {
    const textEncoder = new TextEncoder();
    const parts = [];
    const centralEntries = [];
    let offset = 0;

    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (const file of files) {
        const nameBytes = textEncoder.encode(file.name);
        const dataBytes = typeof file.data === 'string' ? textEncoder.encode(file.data) : file.data;
        const crc = crc32(dataBytes);
        const size = dataBytes.length;

        // Local file header: 30 bytes + name length
        const localHeader = new Uint8Array(30 + nameBytes.length);
        const view = new DataView(localHeader.buffer);

        view.setUint32(0, 0x04034b50, true); // Local file header signature
        view.setUint16(4, 20, true);         // Version needed
        view.setUint16(6, 0x0800, true);     // General purpose flag: bit 11 UTF-8
        view.setUint16(8, 0, true);          // Compression method: 0 (Stored)
        view.setUint16(10, dosTime, true);
        view.setUint16(12, dosDate, true);
        view.setUint32(14, crc, true);
        view.setUint32(18, size, true);       // Compressed size
        view.setUint32(22, size, true);       // Uncompressed size
        view.setUint16(26, nameBytes.length, true);
        view.setUint16(28, 0, true);         // Extra field length
        localHeader.set(nameBytes, 30);

        parts.push(localHeader, dataBytes);

        // Central directory entry: 46 bytes + name length
        const centralEntry = new Uint8Array(46 + nameBytes.length);
        const cView = new DataView(centralEntry.buffer);

        cView.setUint32(0, 0x02014b50, true); // Central directory header signature
        cView.setUint16(4, 20, true);         // Version made by
        cView.setUint16(6, 20, true);         // Version needed
        cView.setUint16(8, 0x0800, true);     // Flags: UTF-8
        cView.setUint16(10, 0, true);         // Compression: 0
        cView.setUint16(12, dosTime, true);
        cView.setUint16(14, dosDate, true);
        cView.setUint32(16, crc, true);
        cView.setUint32(20, size, true);
        cView.setUint32(24, size, true);
        cView.setUint16(28, nameBytes.length, true);
        cView.setUint16(30, 0, true);        // Extra length
        cView.setUint16(32, 0, true);        // Comment length
        cView.setUint16(34, 0, true);        // Disk number
        cView.setUint16(36, 0, true);        // Internal attributes
        cView.setUint32(38, 0, true);        // External attributes
        cView.setUint32(42, offset, true);   // Relative offset of local header
        centralEntry.set(nameBytes, 46);

        centralEntries.push(centralEntry);
        offset += localHeader.length + dataBytes.length;
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const ce of centralEntries) {
        parts.push(ce);
        centralSize += ce.length;
    }

    // End of central directory record (22 bytes)
    const eocd = new Uint8Array(22);
    const eView = new DataView(eocd.buffer);
    eView.setUint32(0, 0x06054b50, true);
    eView.setUint16(4, 0, true);
    eView.setUint16(6, 0, true);
    eView.setUint16(8, files.length, true);
    eView.setUint16(10, files.length, true);
    eView.setUint32(12, centralSize, true);
    eView.setUint32(16, centralStart, true);
    eView.setUint16(20, 0, true);
    parts.push(eocd);

    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLength);
    let pos = 0;
    for (const p of parts) {
        result.set(p, pos);
        pos += p.length;
    }
    return result;
}

function sanitizeFilename(name) {
    return String(name || 'untitled')
        .replace(/[\\/:*?\x22<>|]/g, '_')
        .trim()
        .slice(0, 60) || 'untitled';
}

/** 生成全量结构化备份文件列表 */
export function buildBackupFiles() {
    const files = [];
    const timestamp = new Date().toISOString().slice(0, 10);

    // 1. 笔记（独立 Markdown 文件，含标准 Frontmatter）
    const notes = state.notesDatabase || [];
    notes.forEach((note) => {
        const title = sanitizeFilename(note.title || `note-${note.id}`);
        const content = [
            '---',
            `id: ${note.id}`,
            `title: "${(note.title || '').replace(/"/g, '\\"')}"`,
            `date: "${note.date || timestamp}"`,
            note.updated_at ? `updated_at: "${note.updated_at}"` : null,
            note.tags && note.tags.length ? `tags: ${JSON.stringify(note.tags)}` : null,
            '---',
            '',
            `# ${note.title || '无标题笔记'}`,
            '',
            note.content || ''
        ].filter(Boolean).join('\n');
        files.push({ name: `notes/${note.id}-${title}.md`, data: content });
    });

    // 2. 周刊（独立 Markdown 文件）
    const weeklies = state.database || [];
    weeklies.forEach((w) => {
        const title = sanitizeFilename(w.title || `weekly-${w.id}`);
        const content = [
            '---',
            `id: ${w.id}`,
            `title: "${(w.title || '').replace(/"/g, '\\"')}"`,
            `date: "${w.date || timestamp}"`,
            w.summary ? `summary: "${w.summary.replace(/"/g, '\\"')}"` : null,
            w.tags && w.tags.length ? `tags: ${JSON.stringify(w.tags)}` : null,
            '---',
            '',
            `# ${w.title || '无标题周刊'}`,
            '',
            w.content || w.summary || ''
        ].filter(Boolean).join('\n');
        files.push({ name: `weeklies/${w.id}-${title}.md`, data: content });
    });

    // 3. 随手记（时间线 Markdown 汇总）
    const feeds = state.feedsDatabase || [];
    const feedsMd = [
        `# 随手记时间线归档 (${feeds.length} 条记录)`,
        `导出时间：${new Date().toLocaleString('zh-CN')}`,
        '',
        ...feeds.map((f) => {
            const time = f.created_at || f.updated_at || '';
            const tags = f.tags && f.tags.length ? ` [${f.tags.join(', ')}]` : '';
            return `### ${time}${tags}\n\n${f.content || ''}\n\n---`;
        })
    ].join('\n');
    files.push({ name: 'feeds/feeds.md', data: feedsMd });

    // 4. 书签收藏（Markdown 列表 + 标准 Netscape Bookmark HTML）
    const bookmarks = state.bookmarksDatabase || [];
    const bmRows = bookmarks.map((b) => `- [${b.title || b.url}](${b.url}) - ${b.desc || b.description || ''}`);
    files.push({ name: 'bookmarks/bookmarks.md', data: `# 书签收藏\n\n${bmRows.join('\n')}\n` });

    const bmHtml = [
        '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
        '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
        '<TITLE>Bookmarks</TITLE>',
        '<H1>Bookmarks</H1>',
        '<DL><p>',
        ...bookmarks.map((b) => `<DT><A HREF="${b.url || '#'}">${b.title || b.url || '未命名书签'}</A>`),
        '</DL><p>'
    ].join('\n');
    files.push({ name: 'bookmarks/bookmarks.html', data: bmHtml });

    // 5. 提示词库
    const prompts = state.promptsDatabase || [];
    const promptsMd = [
        '# 提示词库归档',
        '',
        ...prompts.map((p) => `### ${p.title || '未命名'} (${p.project || '默认'}/${p.scene || '通用'})\n\n${p.content || ''}\n\n---`)
    ].join('\n');
    files.push({ name: 'prompts/prompts.md', data: promptsMd });

    // 6. 全量原始 JSON 数据（支持一键恢复还原）
    const fullJson = JSON.stringify({
        version: 'chillin-backup-v1',
        exported_at: new Date().toISOString(),
        user: state.authUser?.username || 'anonymous',
        notes: state.notesDatabase,
        weeklies: state.database,
        feeds: state.feedsDatabase,
        bookmarks: state.bookmarksDatabase,
        prompts: state.promptsDatabase,
        echoCards: state.echoCardsDatabase
    }, null, 2);
    files.push({ name: 'chillin-full-backup.json', data: fullJson });

    return files;
}

/** 生成 ZIP Blob */
export function generateBackupZipBlob() {
    const files = buildBackupFiles();
    const zipBytes = createZip(files);
    return new Blob([zipBytes], { type: 'application/zip' });
}

/** 本地触发一键下载 */
export function downloadBackupZip() {
    try {
        const timestamp = new Date().toISOString().slice(0, 10);
        const filename = `chillin-backup-${timestamp}.zip`;
        const blob = generateBackupZipBlob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        recordBackupSuccess('download');
        showToast('备份包已生成并开始下载！', 'ok');
        return true;
    } catch (err) {
        console.error('[backup] download failed:', err);
        showToast('生成备份包失败：' + (err?.message || err), 'error');
        return false;
    }
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result;
            const base64 = result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/** 打包并调用后端通过 Resend API 发送邮件 */
export async function sendBackupByEmail(email) {
    if (!email || !email.includes('@')) {
        showToast('请输入有效的接收邮箱地址', 'warn');
        return false;
    }

    showToast('正在打包全量数据...', 'info');
    try {
        const timestamp = new Date().toISOString().slice(0, 10);
        const filename = `chillin-backup-${timestamp}.zip`;
        const blob = generateBackupZipBlob();
        const zipBase64 = await blobToBase64(blob);

        showToast('正在通过云端发送邮件...', 'info');
        const res = await apiRequest('/api/backup/email', {
            method: 'POST',
            body: JSON.stringify({
                email,
                filename,
                zipBase64
            })
        });

        if (res.success) {
            recordBackupSuccess('email');
            showToast(`备份已成功发送至 ${email}！`, 'ok');
            return true;
        } else if (res.code === 'NO_RESEND_KEY') {
            showToast('云端尚未配置 RESEND_API_KEY，已自动为您下载到本地！', 'warn');
            downloadBackupZip();
            return false;
        } else {
            showToast('发送邮件失败：' + (res.message || '未知错误') + '，已自动下载到本地', 'warn');
            downloadBackupZip();
            return false;
        }
    } catch (err) {
        console.error('[backup] email send failed:', err);
        showToast('邮件发送异常，已为您下载备份到本地：' + (err?.message || err), 'warn');
        downloadBackupZip();
        return false;
    }
}

export const STORAGE_KEY_LAST_BACKUP = 'chillin_last_backup_meta';
export const STORAGE_KEY_GUARD_INTERVAL = 'chillin_backup_guard_days';
export const STORAGE_KEY_LAST_GUARD_ALERT = 'chillin_last_backup_guard_alert';

/** 记录备份成功元数据并触发守护状态更新 */
export function recordBackupSuccess(method = 'download') {
    try {
        const meta = {
            timestamp: Date.now(),
            iso: new Date().toISOString(),
            method,
            notesCount: state.notesDatabase?.length || 0,
            weekliesCount: state.database?.length || 0,
            feedsCount: state.feedsDatabase?.length || 0,
            bookmarksCount: state.bookmarksDatabase?.length || 0
        };
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(STORAGE_KEY_LAST_BACKUP, JSON.stringify(meta));
        }
        updateBackupGuardUI();
        return meta;
    } catch (e) {
        console.warn('[backup] record backup success failed:', e);
        return null;
    }
}

/** 获取上次备份元数据 */
export function getLastBackupMeta() {
    try {
        if (typeof localStorage === 'undefined') return null;
        const raw = localStorage.getItem(STORAGE_KEY_LAST_BACKUP);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

/** 获取备份守卫周期（天数，默认 14；0 表示关闭） */
export function getBackupGuardSettings() {
    try {
        if (typeof localStorage === 'undefined') return 14;
        const val = localStorage.getItem(STORAGE_KEY_GUARD_INTERVAL);
        if (val === null || val === undefined) return 14;
        const num = parseInt(val, 10);
        return isNaN(num) ? 14 : num;
    } catch {
        return 14;
    }
}

/** 设置备份守卫周期 */
export function setBackupGuardSettings(days) {
    try {
        const num = Math.max(0, parseInt(days, 10) || 0);
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(STORAGE_KEY_GUARD_INTERVAL, String(num));
        }
        updateBackupGuardUI();
        return num;
    } catch {
        return 14;
    }
}

function formatRelativeDays(timestamp, now = Date.now()) {
    const diff = Math.max(0, Math.floor((now - timestamp) / 86400000));
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    return `${diff} 天前`;
}

/** 计算当前备份守卫状态指标 */
export function computeBackupGuardStatus(now = Date.now()) {
    const meta = getLastBackupMeta();
    const interval = getBackupGuardSettings();

    if (interval === 0) {
        return {
            status: 'disabled',
            badgeClass: 'status-none',
            badgeText: '已关闭',
            hintText: meta ? `上次备份：${formatRelativeDays(meta.timestamp, now)}已归档` : '定期提醒已关闭',
            isOverdue: false,
            daysSince: meta ? Math.max(0, Math.floor((now - meta.timestamp) / 86400000)) : null,
            interval
        };
    }

    if (!meta || !meta.timestamp) {
        return {
            status: 'none',
            badgeClass: 'status-warn',
            badgeText: '建议备份',
            hintText: '未曾备份 · 建议生成首个全量副本',
            isOverdue: true,
            daysSince: null,
            interval
        };
    }

    const diffDays = Math.max(0, Math.floor((now - meta.timestamp) / 86400000));
    const isOverdue = diffDays >= interval;

    if (isOverdue) {
        return {
            status: 'overdue',
            badgeClass: 'status-warn',
            badgeText: '建议备份',
            hintText: `已有 ${diffDays} 天未备份 · 建议导出新副本`,
            isOverdue: true,
            daysSince: diffDays,
            interval
        };
    }

    return {
        status: 'protected',
        badgeClass: 'status-ok',
        badgeText: '已守护',
        hintText: diffDays === 0 ? '今天已生成最新副本' : (diffDays === 1 ? '昨天已生成最新副本' : `上次备份：${diffDays} 天前`),
        isOverdue: false,
        daysSince: diffDays,
        interval
    };
}

/** 刷新账号与安全弹窗中的备份守卫 UI 状态 */
export function updateBackupGuardUI() {
    if (typeof document === 'undefined') return;
    const badge = document.getElementById('backup-guard-badge');
    const hint = document.getElementById('backup-guard-time-hint');
    const segmented = document.getElementById('backup-guard-segmented');

    const stateInfo = computeBackupGuardStatus();

    if (badge) {
        badge.className = `backup-guard-badge ${stateInfo.badgeClass}`;
        badge.textContent = stateInfo.badgeText;
    }
    if (hint) {
        hint.textContent = stateInfo.hintText;
    }
    if (segmented) {
        const btns = segmented.querySelectorAll('[data-days]');
        btns.forEach(btn => {
            const days = parseInt(btn.getAttribute('data-days'), 10);
            if (days === stateInfo.interval) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }
}

/** 检查并适时触发系统级 Web Push 备份守卫提醒（防频扰：至少间隔 3 天） */
export async function checkAndSendBackupGuardNotification(force = false) {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return false;
    if (Notification.permission !== 'granted') return false;

    const statusInfo = computeBackupGuardStatus();
    if (!statusInfo.isOverdue || statusInfo.status === 'disabled') return false;

    // 频控检查：3 天内最多提醒一次
    const lastAlert = parseInt(localStorage.getItem(STORAGE_KEY_LAST_GUARD_ALERT) || '0', 10);
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    if (!force && (Date.now() - lastAlert < threeDaysMs)) {
        return false;
    }

    try {
        let reg = null;
        if ('serviceWorker' in navigator) {
            reg = await navigator.serviceWorker.getRegistration();
            if (!reg) reg = await navigator.serviceWorker.ready;
        }

        const bodyText = statusInfo.daysSince === null
            ? '花园尚未生成全量本地副本，点击前往归档'
            : `备份守护 · 花园已有 ${statusInfo.daysSince} 天未导出全量副本，点击前往归档`;

        const options = {
            body: bodyText,
            icon: '/icons/transparent.png',
            tag: 'chillin-backup-guard',
            renotify: true,
            vibrate: [80, 40, 80],
            data: { url: '/#/settings?focus=backup' }
        };

        if (reg && typeof reg.showNotification === 'function') {
            await reg.showNotification('Chillin', options);
        } else {
            const n = new Notification('Chillin', options);
            n.onclick = () => { window.focus(); n.close(); };
        }

        localStorage.setItem(STORAGE_KEY_LAST_GUARD_ALERT, String(Date.now()));
        return true;
    } catch (err) {
        console.warn('[backup] guard push notification failed:', err);
        return false;
    }
}
