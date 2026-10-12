import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, fakeVideo, form } from './helpers.js';

const { default: instagram } = await import('../src/platforms/instagram.js');
const { mediaShare } = await import('../src/media-share.js');
const { default: facebook } = await import('../src/platforms/facebook.js');
const { default: youtube, titleAndDescription } = await import('../src/platforms/youtube.js');
const { default: tiktok, chunkPlan } = await import('../src/platforms/tiktok.js');

const future = new Date(Date.now() + 30 * 86400e3).toISOString();

test('instagram: connect exchanges for a long-lived token', async () => {
  mockFetch([
    ['POST', 'https://api.instagram.com/oauth/access_token', () => ({ access_token: 'short', user_id: 1 })],
    ['GET', 'https://graph.instagram.com/access_token', (c) => {
      assert.equal(c.url.searchParams.get('grant_type'), 'ig_exchange_token');
      return { access_token: 'long', expires_in: 5184000 };
    }],
    ['GET', 'https://graph.instagram.com/v23.0/me', () => ({ user_id: '1789', username: 'demo.creator', name: 'Demo' })],
  ]);
  const [a] = await instagram.connect('code');
  assert.equal(a.externalId, '1789');
  assert.equal(a.accessToken, 'long');
  assert.ok(a.tokenExpiresAt > new Date().toISOString());
});

test('instagram: publishes a reel from a one-time video link', async () => {
  let polls = 0;
  let released = false;
  mediaShare.share = async (file) => {
    assert.equal(file, '/tmp/clip.mp4');
    return { url: 'https://abc.trycloudflare.com/media/tok/video.mp4', release: () => { released = true; } };
  };
  const calls = mockFetch([
    ['POST', 'https://graph.instagram.com/v23.0/1789/media_publish', (c) => {
      assert.equal(form(c).creation_id, 'cont1');
      return { id: 'media99' };
    }],
    ['POST', 'https://graph.instagram.com/v23.0/1789/media', (c) => {
      const f = form(c);
      assert.equal(f.media_type, 'REELS');
      assert.equal(f.video_url, 'https://abc.trycloudflare.com/media/tok/video.mp4');
      assert.equal(f.caption, 'hello #ugc');
      assert.equal(f.upload_type, undefined);
      return { id: 'cont1' };
    }],
    ['GET', 'https://graph.instagram.com/v23.0/cont1', () => ({ status_code: ++polls < 3 ? 'IN_PROGRESS' : 'FINISHED' })],
  ]);
  const id = await instagram.publish({ id: 1, external_id: '1789', access_token: 'tok', token_expires_at: future },
    { caption: 'hello #ugc', video: fakeVideo() });
  assert.equal(id, 'media99');
  assert.equal(polls, 3);
  assert.ok(released, 'the one-time link is withdrawn after publishing');
  assert.equal(calls.at(-1).url.pathname, '/v23.0/1789/media_publish');
});

test('instagram: a processing error surfaces and withdraws the link', async () => {
  let released = false;
  mediaShare.share = async () => ({ url: 'https://x.test/v.mp4', release: () => { released = true; } });
  mockFetch([
    ['POST', 'https://graph.instagram.com/v23.0/1/media', () => ({ id: 'c' })],
    ['GET', 'https://graph.instagram.com/v23.0/c', () => ({ body: { status_code: 'ERROR', status: 'Error: aspect ratio' } })],
  ]);
  await assert.rejects(instagram.publish({ id: 1, external_id: '1', access_token: 't', token_expires_at: future },
    { caption: '', video: fakeVideo() }), /aspect ratio/);
  assert.ok(released, 'the link is withdrawn even when Instagram rejects the video');
});

test('facebook: connect returns one account per page', async () => {
  mockFetch([
    ['GET', /oauth\/access_token\?.*code=/, () => ({ access_token: 'short' })],
    ['GET', /oauth\/access_token\?.*fb_exchange_token/, () => ({ access_token: 'long' })],
    ['GET', 'https://graph.facebook.com/v23.0/me/accounts', () => ({
      data: [{ id: 'p1', name: 'Demo Page', access_token: 'pt1' }, { id: 'p2', name: 'Other', access_token: 'pt2' }],
    })],
  ]);
  const accts = await facebook.connect('code');
  assert.deepEqual(accts.map((a) => [a.externalId, a.accessToken]), [['p1', 'pt1'], ['p2', 'pt2']]);
});

test('facebook: start, upload, finish a reel', async () => {
  const phases = [];
  mockFetch([
    ['POST', 'https://graph.facebook.com/v23.0/p1/video_reels', (c) => {
      const f = form(c);
      phases.push(f.upload_phase);
      if (f.upload_phase === 'start') return { video_id: 'v1', upload_url: 'https://rupload.facebook.com/video-upload/v23.0/v1' };
      assert.equal(f.video_state, 'PUBLISHED');
      assert.equal(f.description, 'cap');
      return { success: true };
    }],
    ['POST', 'https://rupload.facebook.com/video-upload/v23.0/v1', (c) => {
      assert.equal(c.headers.offset, '0');
      phases.push('upload');
      return { success: true };
    }],
  ]);
  const id = await facebook.publish({ external_id: 'p1', access_token: 'pt1' }, { caption: 'cap', video: fakeVideo() });
  assert.equal(id, 'v1');
  assert.deepEqual(phases, ['start', 'upload', 'finish']);
});

test('youtube: refreshes an expired token, then resumable upload', async () => {
  const calls = mockFetch([
    ['POST', 'https://oauth2.googleapis.com/token', (c) => {
      assert.equal(form(c).grant_type, 'refresh_token');
      return { access_token: 'newtok', expires_in: 3600 };
    }],
    ['POST', 'https://www.googleapis.com/upload/youtube/v3/videos', (c) => {
      const meta = JSON.parse(c.body);
      assert.equal(meta.snippet.title, 'My first line');
      assert.equal(meta.status.privacyStatus, 'public');
      assert.equal(c.headers.Authorization, 'Bearer newtok');
      return { body: {}, headers: { location: 'https://www.googleapis.com/upload/session/abc' } };
    }],
    ['PUT', 'https://www.googleapis.com/upload/session/abc', () => ({ id: 'yt123' })],
  ]);
  const id = await youtube.publish(
    { id: 999, access_token: 'old', refresh_token: 'r', token_expires_at: new Date(Date.now() - 1000).toISOString() },
    { caption: 'My first line\nmore text #shorts', video: fakeVideo() });
  assert.equal(id, 'yt123');
  assert.equal(calls.length, 3);
});

test('youtube: title comes from the first non-empty line, max 100 chars', () => {
  assert.equal(titleAndDescription('\n\n  Hi <there>\nrest').title, 'Hi there');
  assert.equal(titleAndDescription('x'.repeat(150)).title.length, 100);
  assert.equal(titleAndDescription('').title, 'New Short');
});

test('tiktok: chunk plan follows the 5-64MB rules', () => {
  const MB = 1024 * 1024;
  assert.deepEqual(chunkPlan(3 * MB).ranges, [{ start: 0, end: 3 * MB - 1 }]);
  const big = chunkPlan(95 * MB);
  assert.equal(big.count, 9);
  assert.equal(big.ranges.at(-1).end, 95 * MB - 1);
  assert.equal(big.ranges.at(-1).start, 80 * MB);
  for (let i = 1; i < big.ranges.length; i++) assert.equal(big.ranges[i].start, big.ranges[i - 1].end + 1);
});

test('tiktok: direct post with privacy check and status polling', async () => {
  let polls = 0;
  mockFetch([
    ['POST', 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/', () => ({
      data: { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] }, error: { code: 'ok' },
    })],
    ['POST', 'https://open.tiktokapis.com/v2/post/publish/video/init/', (c) => {
      const b = JSON.parse(c.body);
      assert.equal(b.post_info.privacy_level, 'SELF_ONLY');
      assert.equal(b.source_info.video_size, 1000);
      assert.equal(b.source_info.total_chunk_count, 1);
      return { data: { publish_id: 'pub1', upload_url: 'https://open-upload.tiktokapis.com/u/1' }, error: { code: 'ok' } };
    }],
    ['PUT', 'https://open-upload.tiktokapis.com/u/1', (c) => {
      assert.equal(c.headers['Content-Range'], 'bytes 0-999/1000');
      return {};
    }],
    ['POST', 'https://open.tiktokapis.com/v2/post/publish/status/fetch/', () => ({
      data: { status: ++polls < 2 ? 'PROCESSING_UPLOAD' : 'PUBLISH_COMPLETE' }, error: { code: 'ok' },
    })],
  ]);
  const id = await tiktok.publish({ access_token: 't', token_expires_at: future }, { caption: 'cap', video: fakeVideo() });
  assert.equal(id, 'pub1');
});

test('tiktok: posting-screen choices reach post_info, and creator-disabled interactions stay off', async () => {
  mockFetch([
    ['POST', 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/', () => ({
      data: { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], duet_disabled: true }, error: { code: 'ok' },
    })],
    ['POST', 'https://open.tiktokapis.com/v2/post/publish/video/init/', (c) => {
      const p = JSON.parse(c.body).post_info;
      assert.equal(p.privacy_level, 'PUBLIC_TO_EVERYONE');
      assert.equal(p.disable_comment, false);
      assert.equal(p.disable_duet, true); // asked for, but the creator has Duet off
      assert.equal(p.disable_stitch, true);
      assert.equal(p.brand_organic_toggle, true);
      assert.equal(p.brand_content_toggle, false);
      return { data: { publish_id: 'pub2', upload_url: 'https://open-upload.tiktokapis.com/u/2' }, error: { code: 'ok' } };
    }],
    ['PUT', 'https://open-upload.tiktokapis.com/u/2', () => ({})],
    ['POST', 'https://open.tiktokapis.com/v2/post/publish/status/fetch/', () => ({ data: { status: 'PUBLISH_COMPLETE' }, error: { code: 'ok' } })],
  ]);
  const options = { privacy: 'PUBLIC_TO_EVERYONE', comment: true, duet: true, stitch: false, disclose: true, yourBrand: true, brandedContent: false };
  assert.equal(await tiktok.publish({ access_token: 't', token_expires_at: future }, { caption: 'cap', video: fakeVideo(), options }), 'pub2');
});

test('tiktok: creator info for the posting screen', async () => {
  mockFetch([
    ['POST', 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/', () => ({
      data: { creator_nickname: 'Demo', creator_username: 'democreator', privacy_level_options: ['SELF_ONLY'], stitch_disabled: true, max_video_post_duration_sec: 600 },
      error: { code: 'ok' },
    })],
  ]);
  const info = await tiktok.creatorInfo({ access_token: 't', token_expires_at: future });
  assert.deepEqual(info.privacyOptions, ['SELF_ONLY']);
  assert.equal(info.nickname, 'Demo');
  assert.equal(info.stitchDisabled, true);
  assert.equal(info.commentDisabled, false);
  assert.equal(info.maxDurationSec, 600);
});

test('tiktok: API error codes become failures', async () => {
  mockFetch([
    ['POST', 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/', () => ({
      data: {}, error: { code: 'spam_risk_too_many_posts', message: 'Too many posts today' },
    })],
  ]);
  await assert.rejects(tiktok.publish({ access_token: 't', token_expires_at: future }, { caption: '', video: fakeVideo() }), /Too many posts/);
});

test('instagram: connect with a pasted dashboard token', async () => {
  mockFetch([
    ['GET', 'https://graph.instagram.com/v23.0/me', (c) => {
      assert.equal(c.url.searchParams.get('access_token'), 'IGAAtok');
      return { user_id: '42', username: 'demo_tiktok' };
    }],
  ]);
  const [a] = await instagram.connectWithToken('  IGAAtok\n');
  assert.equal(a.externalId, '42');
  assert.equal(a.accessToken, 'IGAAtok');
  assert.ok(a.tokenExpiresAt > new Date(Date.now() + 59 * 86400e3).toISOString());
});
