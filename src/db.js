import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.join(config.dataDir, 'videos'), { recursive: true });
export const videoDir = path.join(config.dataDir, 'videos');
export const db = new DatabaseSync(process.env.DB_PATH || path.join(config.dataDir, 'scheduler.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL,
    external_id TEXT NOT NULL,
    name TEXT NOT NULL,
    handle TEXT,
    avatar TEXT,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (platform, external_id)
  );
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY,
    caption TEXT NOT NULL DEFAULT '',
    video_file TEXT NOT NULL,
    video_name TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS post_targets (
    id INTEGER PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    remote_id TEXT,
    error TEXT,
    published_at TEXT
  );
`);

// Added after the first release: TikTok posting-screen choices as JSON.
if (!db.prepare('PRAGMA table_info(posts)').all().some((c) => c.name === 'tiktok_options')) {
  db.exec('ALTER TABLE posts ADD COLUMN tiktok_options TEXT');
}

export function upsertAccount(a) {
  db.prepare(`
    INSERT INTO accounts (platform, external_id, name, handle, avatar, access_token, refresh_token, token_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (platform, external_id) DO UPDATE SET
      name = excluded.name, handle = excluded.handle, avatar = excluded.avatar,
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, accounts.refresh_token),
      token_expires_at = excluded.token_expires_at
  `).run(a.platform, String(a.externalId), a.name, a.handle ?? null, a.avatar ?? null,
    a.accessToken ?? null, a.refreshToken ?? null, a.tokenExpiresAt ?? null);
}

export function saveTokens(accountId, { accessToken, refreshToken, tokenExpiresAt }) {
  db.prepare(`UPDATE accounts SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_expires_at = ? WHERE id = ?`)
    .run(accessToken, refreshToken ?? null, tokenExpiresAt ?? null, accountId);
}

export const expiresIn = (seconds) => (seconds ? new Date(Date.now() + Number(seconds) * 1000).toISOString() : null);
export const expiresSoon = (iso, seconds) => !!iso && Date.parse(iso) - Date.now() < seconds * 1000;
