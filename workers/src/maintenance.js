/**
 * 定时任务编排：网关只保留一行 async scheduled，具体任务在这里分组。
 *
 * 两条 cron（见 wrangler.toml）：
 * - '* * * * *'  微信 ClawBot：先看要不要主动关怀（每天至多一次，绝大多数分钟只做几次廉价判断），
 *               再长轮询一次调用内在 55s 预算里持续拉取新消息并按指令回复
 *               （服务端约 18s 无消息即返回，只拉一轮会让每分钟空转 42s）
 * - '13 * * * *' 每小时维护：UGC 扫描、Session 清理、限流窗口清理、R2 备份保留、审计日志保留
 *
 * 两次触发共用一个 scheduled 入口，靠 event.cron 分流——否则每分钟一次的触发
 * 会把按小时设计的维护任务带着跑 60 遍。
 */

import { scanAndAudit, cleanupAuditLogs } from './audit.js';
import { cleanExpiredSessions } from './auth.js';
import { cleanupRateLimits } from './security-network.js';
import { pruneOldBackups } from './garden-media.js';
import { pollClawAccounts } from './bot-claw.js';
import { runOutreachChecks } from './bot-outreach.js';

/** 每分钟触发的那条 cron 表达式，与 wrangler.toml 保持一致 */
export const CLAW_CRON = '* * * * *';

export async function runHourlyMaintenance(env) {
    const tasks = [
        ['audit scan', async () => {
            const r = await scanAndAudit(env.DB);
            console.log('[audit] scheduled scan: scanned=' + r.scanned + ' quarantined=' + r.quarantined);
        }],
        ['session cleanup', async () => {
            const removed = await cleanExpiredSessions(env.DB);
            console.log('[session] scheduled cleanup: removed=' + removed);
        }],
        ['rate-limit cleanup', async () => {
            const removed = await cleanupRateLimits(env.DB);
            console.log('[rate-limit] scheduled cleanup: removed=' + removed);
        }],
        ['r2 backup retention', async () => {
            const r = await pruneOldBackups(env);
            console.log('[r2] backup retention: scanned=' + r.scanned + ' deleted=' + r.deleted);
        }],
        ['audit retention', async () => {
            const r = await cleanupAuditLogs(env.DB);
            console.log('[audit] retention cleanup: logs=' + r.auditLogs + ' quarantine=' + r.quarantine);
        }]
    ];
    for (const [label, task] of tasks) {
        try { await task(); } catch (err) { console.error('[scheduled] ' + label + ' failed:', err); }
    }
}

/** pollOptions 透传给 pollClawAccounts，仅单测用来收紧时间预算 */
export async function runScheduled(env, event, pollOptions) {
    if (event && event.cron === CLAW_CRON) {
        try { await runOutreachChecks(env, env.DB, undefined, pollOptions); }
        catch (err) { console.error('[scheduled] bot outreach failed:', err); }
        try { await pollClawAccounts(env, env.DB, undefined, pollOptions); }
        catch (err) { console.error('[scheduled] bot poll failed:', err); }
        return;
    }
    await runHourlyMaintenance(env);
}
