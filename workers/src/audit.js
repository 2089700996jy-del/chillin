/**
 * UGC Audit & Compliance Scanning Module
 * Scans user generated content for violations, backups to ugc_quarantine, and logs actions.
 */

export const UGC_VIOLATION_RE = /加微|加微信|微信号|扫码加|刷单|代发|代购|网赚|兼职日结|返利|引流|微商|传销|贷款办卡|代开发票|博彩|赌博|色情|裸聊|黄播|外围/i;

export function ugcHasViolation(row, cols) {
    for (const col of cols) {
        let v = row[col];
        if (v == null) continue;
        if (typeof v === 'string' && v.trim().startsWith('[')) {
            try { v = JSON.parse(v).map(x => (x && (x.content || x.title || x.text)) || '').join(' '); } catch {}
        }
        if (typeof v === 'string' && UGC_VIOLATION_RE.test(v)) return true;
    }
    return false;
}

export async function scanAndAudit(db, userId = null) {
    const results = { scanned: 0, quarantined: 0, removed: 0, alerts: [] };
    const tables = [
        { name: 'notes', cols: ['title', 'content', 'annotations'] },
        { name: 'quick_feeds', cols: ['content', 'summary', 'tags', 'media_url'] },
        { name: 'bookmarks', cols: ['title', 'url', 'description'] },
        { name: 'weeklies', cols: ['title', 'summary', 'content', 'annotations'] }
    ];

    for (const t of tables) {
        const rows = userId
            ? await db.prepare(`SELECT * FROM ${t.name} WHERE user_id = ?1`).bind(userId).all()
            : await db.prepare(`SELECT * FROM ${t.name}`).all();
        for (const row of (rows.results || [])) {
            results.scanned++;
            if (ugcHasViolation(row, t.cols)) {
                const snippet = String(row[t.cols[0]] || '').slice(0, 100);
                const ownerId = row.user_id != null ? row.user_id : (userId || null);
                // 先写入隔离区，保留完整 payload，便于误报恢复
                try {
                    await db.prepare(
                        `INSERT INTO ugc_quarantine (table_name, record_id, user_id, payload, snippet, reason)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
                    ).bind(
                        t.name,
                        String(row.id),
                        ownerId,
                        JSON.stringify(row),
                        snippet,
                        'ugc_keyword_match'
                    ).run();
                } catch (err) {
                    console.error('[audit] quarantine insert failed:', err);
                    // 隔离失败则跳过删除，避免不可恢复丢数据
                    continue;
                }

                if (userId) {
                    await db.prepare(`DELETE FROM ${t.name} WHERE id = ?1 AND user_id = ?2`).bind(row.id, userId).run();
                } else {
                    await db.prepare(`DELETE FROM ${t.name} WHERE id = ?1`).bind(row.id).run();
                }
                await db.prepare(
                    `INSERT INTO audit_log (table_name, record_id, snippet, action, created_at) VALUES (?1, ?2, ?3, 'quarantined', datetime('now', '+8 hours'))`
                ).bind(t.name, String(row.id), snippet).run();
                results.quarantined++;
                results.removed++;
                results.alerts.push({ table: t.name, id: row.id, snippet, action: 'quarantined' });
            }
        }
    }
    return results;
}
