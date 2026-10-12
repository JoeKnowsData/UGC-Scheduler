import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { db, videoDir, upsertAccount } = await import('../src/db.js');
const { platforms } = await import('../src/platforms/index.js');
const { runDue } = await import('../src/scheduler.js');

upsertAccount({ platform: 'instagram', externalId: 'ig1', name: 'IG', accessToken: 't' });
upsertAccount({ platform: 'tiktok', externalId: 'tt1', name: 'TT', accessToken: 't' });
const ids = db.prepare('SELECT id FROM accounts ORDER BY id').all().map((r) => r.id);

function makePost(when) {
  fs.writeFileSync(path.join(videoDir, 'v.mp4'), 'video');
  const { lastInsertRowid } = db.prepare('INSERT INTO posts (caption, video_file, video_name, scheduled_at) VALUES (?, ?, ?, ?)')
    .run('cap', 'v.mp4', 'clip.mp4', when.toISOString());
  for (const a of ids) db.prepare('INSERT INTO post_targets (post_id, account_id) VALUES (?, ?)').run(lastInsertRowid, a);
  return Number(lastInsertRowid);
}

test('only due posts publish, and one failing account does not block the other', async () => {
  const seen = [];
  platforms.instagram.publish = async (acct, { caption, video }) => { seen.push(['ig', caption, video.size]); return 'ig-remote'; };
  platforms.tiktok.publish = async () => { throw new Error('TikTok: nope'); };

  const due = makePost(new Date(Date.now() - 1000));
  const later = makePost(new Date(Date.now() + 3600e3));
  await runDue();

  assert.deepEqual(seen, [['ig', 'cap', 5]]);
  assert.equal(db.prepare('SELECT status FROM posts WHERE id = ?').get(due).status, 'partial');
  assert.equal(db.prepare('SELECT status FROM posts WHERE id = ?').get(later).status, 'scheduled');
  const t = db.prepare('SELECT a.platform, t.status, t.error, t.remote_id FROM post_targets t JOIN accounts a ON a.id = t.account_id WHERE post_id = ? ORDER BY a.id').all(due);
  assert.deepEqual(t.map((r) => [r.platform, r.status]), [['instagram', 'published'], ['tiktok', 'failed']]);
  assert.equal(t[1].error, 'TikTok: nope');

  // Running again does not re-post.
  await runDue();
  assert.equal(seen.length, 1);
});
