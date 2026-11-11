/**
 * 定时任务编排：网关只保留一行 async scheduled，具体任务在这里分组。
 *
 * 两条 cron（见 wrangler.toml）：
 * - '* * * * *'  微信 ClawBot 与 Agent 调度：先处理用户自己设的定点提醒（到点必达，单轮最多 5 条），
 *               再看要不要主动关怀（每天至多一次，绝大多数分钟只做几次廉价判断），
 *               然后长轮询（55s 预算内持续拉取）与 Agent 后台续跑并行并发执行
 *               （避免长轮询串行耗尽 55s 导致 Agent 调度饥饿与超时被强杀）。
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
import { runReminderChecks } from './bot-reminders.js';
import { runAutoResume } from './agent-scheduler.js';

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

/** pollOptions 透传给 pollClawAccounts；ctx 用于把重活交给 waitUntil */
export async function runScheduled(env, event, pollOptions, ctx) {
    if (event && event.cron === CLAW_CRON) {
        // 用户自己设的提醒优先：他授权过的打扰，不参与主动关怀的日限/时窗/静默期
        try { await runReminderChecks(env, env.DB, undefined, pollOptions); }
        catch (err) { console.error('[scheduled] bot reminders failed:', err); }
        try { await runOutreachChecks(env, env.DB, undefined, pollOptions); }
        catch (err) { console.error('[scheduled] bot outreach failed:', err); }
        const opts = Object.assign({}, pollOptions);
        if (!opts.defer && ctx && typeof ctx.waitUntil === 'function') opts.defer = (task) => ctx.waitUntil(task);

        // 并发执行：ClawBot 长轮询（最大 55s）与 Agent 后台续跑（最大 45s）必须并行，
        // 避免长轮询串行阻塞整整 55 秒导致 Agent 任务在第 55 秒才启动、耗尽 cron 窗口而陷入永久调度饥饿。
        await Promise.allSettled([
            (async () => {
                try { await pollClawAccounts(env, env.DB, undefined, opts); }
                catch (err) { console.error('[scheduled] bot poll failed:', err); }
            })(),
            (async () => {
                try {
                    const r = await runAutoResume(env, pollOptions);
                    if (r && r.processed) console.log('[scheduled] agent auto resume: processed=' + r.processed + ' failed=' + r.failed);
                } catch (err) { console.error('[scheduled] agent auto resume failed:', err); }
            })()
        ]);
        return;
    }
    await runHourlyMaintenance(env);
}
