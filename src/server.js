import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { db, videoDir, upsertAccount } from './db.js';
import { platforms } from './platforms/index.js';
import { startScheduler, publishPost } from './scheduler.js';
import { tunnelGuard, serveSharedMedia } from './media-share.js';

export const app = express();
app.use(tunnelGuard);
// One-time video links for Instagram; open without the app password so Instagram can fetch them.
app.get('/media/:token/:name', serveSharedMedia);
app.use(express.json());

if (config.appPassword) {
  app.use((req, res, next) => {
    const [, b64] = (req.headers.authorization || '').split(' ');
    const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
    const ok = pass.length === config.appPassword.length && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(config.appPassword));
    if (ok) return next();
    res.set('WWW-Authenticate', 'Basic realm="UGC Scheduler"').status(401).send('Login required');
  });
}

app.use(express.static(path.join(config.root, 'public')));

// ---- Accounts & OAuth ----

const pendingStates = new Map(); // state -> { platform, expires }

app.get('/api/platforms', (req, res) => {
  res.json(Object.values(platforms).map((p) => ({ id: p.id, label: p.label, configured: p.configured() })));
});

app.get('/api/accounts', (req, res) => {
  res.json(db.prepare('SELECT id, platform, name, handle, avatar, token_expires_at FROM accounts ORDER BY platform, name').all());
});

// TikTok's posting screen needs the creator's current nickname, privacy options and interaction settings.
app.get('/api/accounts/:id/tiktok-info', async (req, res) => {
  const account = db.prepare(`SELECT * FROM accounts WHERE id = ? AND platform = 'tiktok'`).get(req.params.id);
  if (!account) return res.status(404).json({ error: 'TikTok account not found' });
  try {
    res.json(await platforms.tiktok.creatorInfo(account));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/accounts/:id', (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/accounts/token', async (req, res) => {
  const p = platforms[req.body.platform];
  if (!p?.connectWithToken) return res.status(400).json({ error: 'That platform cannot connect with a pasted token' });
  if (!req.body.token?.trim()) return res.status(400).json({ error: 'Paste a token first' });
  try {
    const accounts = await p.connectWithToken(req.body.token);
    accounts.forEach(upsertAccount);
    res.json({ connected: accounts.map((a) => a.handle || a.name) });
  } catch (err) {
    res.status(400).json({ error: `${p.label}: ${err.message}` });
  }
});

app.get('/auth/:platform/start', (req, res) => {
  const p = platforms[req.params.platform];
  if (!p?.configured()) return res.status(400).send(`${req.params.platform} is not set up; add its keys to .env`);
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { platform: p.id, expires: Date.now() + 10 * 60_000 });
  res.redirect(p.authUrl(state));
});

app.get('/auth/:platform/callback', async (req, res) => {
  const p = platforms[req.params.platform];
  const saved = pendingStates.get(req.query.state);
  pendingStates.delete(req.query.state);
  const back = (params) => res.redirect(`/?${new URLSearchParams(params)}`);
  if (!p || !saved || saved.platform !== p.id || saved.expires < Date.now()) return back({ error: 'Login expired or invalid, please try again' });
  if (req.query.error || !req.query.code) return back({ error: `${p.label}: ${req.query.error_description || req.query.error || 'no code returned'}` });
  try {
    const accounts = await p.connect(String(req.query.code));
    if (!accounts.length) return back({ error: `${p.label}: no accounts found on that login` });
    accounts.forEach(upsertAccount);
    back({ connected: `${accounts.length} ${p.label} account${accounts.length > 1 ? 's' : ''}` });
  } catch (err) {
    console.error(err);
    back({ error: `${p.label}: ${err.message}` });
  }
});

// ---- Posts ----

const upload = multer({
  storage: multer.diskStorage({
    destination: videoDir,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.(mp4|mov|m4v|webm)$/i.test(file.originalname)),
});

app.get('/api/posts', (req, res) => {
  // Upcoming posts first, soonest at the top; then history, newest first.
  const posts = db.prepare(`
    SELECT * FROM posts
    ORDER BY status IN ('scheduled','publishing') DESC,
      CASE WHEN status IN ('scheduled','publishing') THEN scheduled_at END ASC,
      scheduled_at DESC
    LIMIT 200`).all();
  const targets = db.prepare(`
    SELECT t.*, a.platform, a.name, a.handle, a.avatar FROM post_targets t JOIN accounts a ON a.id = t.account_id
    WHERE t.post_id = ?`);
  res.json(posts.map((p) => ({ ...p, targets: targets.all(p.id) })));
});

app.post('/api/posts', upload.single('video'), (req, res) => {
  const fail = (msg) => {
    if (req.file) fs.rmSync(req.file.path, { force: true });
    res.status(400).json({ error: msg });
  };
  if (!req.file) return fail('Choose an .mp4 or .mov video');
  const accountIds = [].concat(req.body.accountIds || []).flatMap((s) => String(s).split(',')).map(Number).filter(Boolean);
  if (!accountIds.length) return fail('Pick at least one account');
  const known = db.prepare(`SELECT id, platform FROM accounts WHERE id IN (${accountIds.map(() => '?').join(',')})`).all(...accountIds);
  if (known.length !== accountIds.length) return fail('One of the selected accounts no longer exists');

  let tiktokOptions = null;
  if (known.some((a) => a.platform === 'tiktok')) {
    try { tiktokOptions = JSON.parse(req.body.tiktok || 'null'); } catch {}
    const problem = tiktokProblem(tiktokOptions);
    if (problem) return fail(`TikTok: ${problem}`);
  }

  const now = req.body.postNow === '1';
  const when = now ? new Date() : new Date(req.body.scheduledAt);
  if (Number.isNaN(when.getTime())) return fail('Pick a date and time');
  if (!now && when.getTime() < Date.now() - 60_000) return fail('That time is in the past');

  const { lastInsertRowid: postId } = db.prepare('INSERT INTO posts (caption, video_file, video_name, scheduled_at, tiktok_options) VALUES (?, ?, ?, ?, ?)')
    .run(req.body.caption || '', req.file.filename, req.file.originalname, when.toISOString(), tiktokOptions && JSON.stringify(tiktokOptions));
  const addTarget = db.prepare('INSERT INTO post_targets (post_id, account_id) VALUES (?, ?)');
  for (const id of accountIds) addTarget.run(postId, id);

  if (now) publishPost(Number(postId)).catch((err) => console.error(err));
  res.json({ id: Number(postId) });
});

// The same rules the posting screen enforces, checked again here.
function tiktokProblem(o) {
  const privacies = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];
  if (!o || !privacies.includes(o.privacy)) return 'choose who can see the video';
  if (o.disclose && !o.yourBrand && !o.brandedContent) return 'say whether the video promotes your brand, a third party, or both';
  if (o.brandedContent && o.privacy === 'SELF_ONLY') return 'branded content cannot be private';
  return null;
}

app.patch('/api/posts/:id', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post || post.status !== 'scheduled') return res.status(400).json({ error: 'Only scheduled posts can be edited' });
  const when = req.body.scheduledAt ? new Date(req.body.scheduledAt) : new Date(post.scheduled_at);
  if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid time' });
  db.prepare('UPDATE posts SET caption = ?, scheduled_at = ? WHERE id = ?')
    .run(req.body.caption ?? post.caption, when.toISOString(), post.id);
  res.json({ ok: true });
});

app.post('/api/posts/:id/retry', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post || !['failed', 'partial'].includes(post.status)) return res.status(400).json({ error: 'Nothing to retry' });
  db.prepare(`UPDATE post_targets SET status = 'pending', error = NULL WHERE post_id = ? AND status = 'failed'`).run(post.id);
  db.prepare(`UPDATE posts SET status = 'scheduled' WHERE id = ?`).run(post.id);
  publishPost(post.id).catch((err) => console.error(err));
  res.json({ ok: true });
});

app.delete('/api/posts/:id', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.json({ ok: true });
  if (post.status === 'publishing') return res.status(400).json({ error: 'It is uploading right now' });
  db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
  fs.rmSync(path.join(videoDir, post.video_file), { force: true });
  res.json({ ok: true });
});

app.get('/api/posts/:id/video', (req, res) => {
  const post = db.prepare('SELECT video_file FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.sendStatus(404);
  res.sendFile(path.join(videoDir, post.video_file));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  startScheduler();
  app.listen(config.port, () => {
    console.log(`UGC Scheduler on ${config.baseUrl}${config.dryRun ? ' (DRY RUN: nothing is really posted)' : ''}`);
    const off = Object.values(platforms).filter((p) => !p.configured()).map((p) => p.label);
    if (off.length) console.log(`Not set up yet: ${off.join(', ')} (add keys to .env)`);
  });
}
