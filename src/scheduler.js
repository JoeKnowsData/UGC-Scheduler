import fs from 'node:fs';
import path from 'node:path';
import { db, videoDir } from './db.js';
import { platforms } from './platforms/index.js';
import { config } from './config.js';

const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4' };

export function videoFor(post) {
  const file = path.join(videoDir, post.video_file);
  return {
    path: file,
    size: fs.statSync(file).size,
    mime: MIME[path.extname(post.video_name).toLowerCase()] || 'video/mp4',
    bytes: () => fs.readFileSync(file),
  };
}

// Publishes one post to all of its pending targets. Each account succeeds or fails on its own.
export async function publishPost(postId) {
  const claimed = db.prepare(`UPDATE posts SET status = 'publishing' WHERE id = ? AND status = 'scheduled'`).run(postId);
  if (!claimed.changes) return;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  const targets = db.prepare(`
    SELECT t.id AS target_id, a.* FROM post_targets t JOIN accounts a ON a.id = t.account_id
    WHERE t.post_id = ? AND t.status = 'pending'`).all(postId);

  await Promise.all(targets.map(async (account) => {
    db.prepare(`UPDATE post_targets SET status = 'publishing', error = NULL WHERE id = ?`).run(account.target_id);
    try {
      const options = account.platform === 'tiktok' && post.tiktok_options ? JSON.parse(post.tiktok_options) : undefined;
      const remoteId = await platforms[account.platform].publish(account, { caption: post.caption, video: videoFor(post), options });
      db.prepare(`UPDATE post_targets SET status = 'published', remote_id = ?, published_at = ? WHERE id = ?`)
        .run(String(remoteId ?? ''), new Date().toISOString(), account.target_id);
    } catch (err) {
      console.error(`[post ${postId}] ${account.platform}/${account.name}: ${err.message}`);
      db.prepare(`UPDATE post_targets SET status = 'failed', error = ? WHERE id = ?`).run(err.message, account.target_id);
    }
  }));
  settle(postId);
}

function settle(postId) {
  const rows = db.prepare('SELECT status FROM post_targets WHERE post_id = ?').all(postId).map((r) => r.status);
  const ok = rows.filter((s) => s === 'published').length;
  const status = ok === rows.length ? 'published' : ok === 0 ? 'failed' : 'partial';
  db.prepare('UPDATE posts SET status = ? WHERE id = ?').run(status, postId);
}

export async function runDue() {
  const due = db.prepare(`SELECT id FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at`)
    .all(new Date().toISOString());
  // Posts run side by side; the status claim in publishPost stops a post from being picked up twice.
  await Promise.all(due.map(({ id }) => publishPost(id)));
}

export function startScheduler() {
  // A restart mid-upload leaves targets stuck in "publishing"; mark them failed so they can be retried.
  db.prepare(`UPDATE post_targets SET status = 'failed', error = 'Interrupted by a restart; press Retry'
    WHERE status = 'publishing'`).run();
  for (const { id } of db.prepare(`SELECT id FROM posts WHERE status = 'publishing'`).all()) settle(id);

  const tick = () => runDue().catch((err) => console.error('scheduler error', err));
  tick();
  return setInterval(tick, config.pollSeconds * 1000);
}
