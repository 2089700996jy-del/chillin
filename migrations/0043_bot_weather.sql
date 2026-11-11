-- 天气每日记录（用于昨日温差比对与 8:00 晨间推送排重）
CREATE TABLE IF NOT EXISTS bot_weather_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    city TEXT NOT NULL,
    date TEXT NOT NULL,
    temp_max INTEGER NOT NULL,
    temp_min INTEGER NOT NULL,
    max_time TEXT DEFAULT '',
    min_time TEXT DEFAULT '',
    rain_summary TEXT DEFAULT '',
    uv_index INTEGER DEFAULT 0,
    warning_text TEXT DEFAULT '',
    notified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', '+8 hours')),
    UNIQUE(user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_bot_weather_user_date
ON bot_weather_daily(user_id, date DESC);

