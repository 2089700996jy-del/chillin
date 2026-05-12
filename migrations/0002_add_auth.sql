-- Chillin Auth System Migration

-- 1. Create users table
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. Create sessions table
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- 3. Modify existing tables to include user_id
-- SQLite ALTER TABLE allows adding columns. 
-- We set DEFAULT 1 so existing records will belong to user_id = 1
ALTER TABLE weeklies ADD COLUMN user_id INTEGER DEFAULT 1;
ALTER TABLE notes ADD COLUMN user_id INTEGER DEFAULT 1;
ALTER TABLE bookmarks ADD COLUMN user_id INTEGER DEFAULT 1;

-- Note: We do not explicitly enforce FOREIGN KEY for user_id on existing tables 
-- via ALTER TABLE because SQLite's ALTER TABLE has limitations, but the application 
-- logic will handle the association and filtering.
