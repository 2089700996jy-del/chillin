/**
 * 测试用 D1 适配器：把 node:sqlite 的内存库包装成 Workers D1 的异步接口。
 *
 * 为什么值得存在：真正的 SQLite 会执行真实的 SQL 语义（约束、ON CONFLICT、RETURNING、
 * datetime() 等），因此这些用例能真正验证「代码与 migrations 是否一致」，
 * 而不是验证我们自己写的假 SQL 解析器。
 *
 * node:sqlite 需要 Node >= 22.5；更旧的 Node 上 sqliteAvailable 为 false，
 * 调用方应据此跳过（test.skip），CI 因此同时跑 Node 20 与 22。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let DatabaseSync = null;
try {
    ({ DatabaseSync } = await import('node:sqlite'));
} catch {
    DatabaseSync = null;
}

export const sqliteAvailable = Boolean(DatabaseSync);

class Statement {
    constructor(db, sql, args = []) {
        this.db = db;
        this.sql = sql;
        this.args = args;
    }

    bind(...args) {
        return new Statement(this.db, this.sql, args);
    }

    async first() {
        const row = this.db.prepare(this.sql).get(...this.args);
        return row === undefined ? null : row;
    }

    async all() {
        return { results: this.db.prepare(this.sql).all(...this.args) };
    }

    async run() {
        const info = this.db.prepare(this.sql).run(...this.args);
        return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    }
}

export class FakeD1 {
    constructor(db) {
        this.db = db;
    }

    prepare(sql) {
        return new Statement(this.db, sql);
    }

    /** 与 D1 一致的事务性批量执行 */
    async batch(statements) {
        const results = [];
        this.db.exec('BEGIN');
        try {
            for (const statement of statements) results.push(await statement.run());
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
        return results;
    }
}

/** 建一个内存库并把 migrations/ 全部按序执行——顺带验证迁移脚本本身可用 */
/** 部分表（如 quick_feeds）带 user_id 外键，测试前先落一个用户 */
export async function seedUser(db, id, username = `user${id}`) {
    await db.prepare('INSERT OR REPLACE INTO users (id, username, password_hash) VALUES (?1, ?2, ?3)')
        .bind(id, username, 'pbkdf2$1$00$00').run();
}

export function createTestDb() {
    if (!sqliteAvailable) throw new Error('node:sqlite is unavailable on this Node version');
    const db = new DatabaseSync(':memory:');
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
    }
    // 迁移里带有演示用的种子数据（id=1 的周记等）；测试需要确定性，先清空业务表
    for (const table of ['weeklies', 'notes', 'bookmarks', 'quick_feeds', 'prompts', 'echo_cards']) {
        db.exec(`DELETE FROM ${table}`);
    }
    return new FakeD1(db);
}
