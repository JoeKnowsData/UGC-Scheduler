// TikTok via the Content Posting API (direct post, or upload to the creator's inbox).
import { config, redirectUri } from '../config.js';
import { request, withQuery, sleep } from '../http.js';
import { saveTokens, expiresIn, expiresSoon } from '../db.js';

const API = 'https://open.tiktokapis.com';
const MB = 1024 * 1024;

export default {
  id: 'tiktok',
  label: 'TikTok',
  configured: () => !!(config.tiktok.clientKey && config.tiktok.clientSecret),

  authUrl: (state) => withQuery('https://www.tiktok.com/v2/auth/authorize/', {
    client_key: config.tiktok.clientKey,
    redirect_uri: redirectUri('tiktok'),
    response_type: 'code',
    scope: 'user.info.basic,video.publish,video.upload',
    state,
    // Always show TikTok's login/permission page, so another account can be picked instead of the last one.
    disable_auto_auth: 1,
  }),

  async connect(code) {
    const { data: tok } = await request(`${API}/v2/oauth/token/`, {
      method: 'POST',
      form: {
        client_key: config.tiktok.clientKey, client_secret: config.tiktok.clientSecret,
        grant_type: 'authorization_code', redirect_uri: redirectUri('tiktok'), code,
      },
    });
    if (tok.error) throw new Error(`TikTok login failed: ${tok.error_description || tok.error}`);
    const { data: info } = await request(withQuery(`${API}/v2/user/info/`, { fields: 'open_id,display_name,avatar_url' }), {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    const u = info.data.user;
    return [{
      platform: 'tiktok',
      externalId: u.open_id || tok.open_id,
      name: u.display_name,
      handle: 'TikTok',
      avatar: u.avatar_url,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      tokenExpiresAt: expiresIn(tok.expires_in),
    }];
  },

  // What the posting screen must show before a direct post (TikTok's Content Sharing Guidelines).
  async creatorInfo(account) {
    const token = await freshToken(account);
    const c = await tiktok(`${API}/v2/post/publish/creator_info/query/`, { Authorization: `Bearer ${token}` }, {});
    return {
      nickname: c.creator_nickname, username: c.creator_username, avatar: c.creator_avatar_url,
      privacyOptions: c.privacy_level_options || [],
      commentDisabled: !!c.comment_disabled, duetDisabled: !!c.duet_disabled, stitchDisabled: !!c.stitch_disabled,
      maxDurationSec: c.max_video_post_duration_sec,
    };
  },

  // options: the choices made on the posting screen (privacy, interactions, content disclosure).
  // Posts created before that screen existed have none and fall back to TIKTOK_PRIVACY with everything allowed.
  async publish(account, { caption, video, options }) {
    const token = await freshToken(account);
    const auth = { Authorization: `Bearer ${token}` };
    const chunks = chunkPlan(video.size);
    const source_info = { source: 'FILE_UPLOAD', video_size: video.size, chunk_size: chunks.chunkSize, total_chunk_count: chunks.count };

    let init;
    if (config.tiktok.mode === 'inbox') {
      init = await tiktok(`${API}/v2/post/publish/inbox/video/init/`, auth, { source_info });
    } else {
      const creator = await tiktok(`${API}/v2/post/publish/creator_info/query/`, auth, {});
      const o = options || { privacy: config.tiktok.privacy, comment: true, duet: true, stitch: true };
      if (!creator.privacy_level_options?.includes(o.privacy)) {
        throw new Error(`TikTok does not allow privacy "${o.privacy}" for this account (allowed: ${creator.privacy_level_options?.join(', ')})`);
      }
      init = await tiktok(`${API}/v2/post/publish/video/init/`, auth, {
        post_info: {
          title: caption.slice(0, 2200),
          privacy_level: o.privacy,
          disable_comment: !o.comment || !!creator.comment_disabled,
          disable_duet: !o.duet || !!creator.duet_disabled,
          disable_stitch: !o.stitch || !!creator.stitch_disabled,
          brand_organic_toggle: !!o.yourBrand,
          brand_content_toggle: !!o.brandedContent,
        },
        source_info,
      });
    }

    const bytes = video.bytes();
    for (const { start, end } of chunks.ranges) {
      await request(init.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': video.mime, 'Content-Range': `bytes ${start}-${end}/${video.size}` },
        body: bytes.subarray(start, end + 1),
      });
    }

    const done = config.tiktok.mode === 'inbox' ? 'SEND_TO_USER_INBOX' : 'PUBLISH_COMPLETE';
    for (let i = 0; i * config.publishPollMs < 10 * 60_000; i++) {
      const s = await tiktok(`${API}/v2/post/publish/status/fetch/`, auth, { publish_id: init.publish_id });
      if (s.status === done) return init.publish_id;
      if (s.status === 'FAILED') throw new Error(`TikTok rejected the video: ${s.fail_reason}`);
      await sleep(config.publishPollMs);
    }
    // Uploaded fine but TikTok is still processing; it will finish on their side.
    return init.publish_id;
  },
};

// TikTok wants 5-64MB chunks; a file of 64MB or less goes up in one piece. The last chunk absorbs the remainder.
export function chunkPlan(size) {
  if (size <= 64 * MB) return { chunkSize: size, count: 1, ranges: [{ start: 0, end: size - 1 }] };
  const chunkSize = 10 * MB;
  const count = Math.floor(size / chunkSize);
  const ranges = Array.from({ length: count }, (_, i) => ({
    start: i * chunkSize,
    end: i === count - 1 ? size - 1 : (i + 1) * chunkSize - 1,
  }));
  return { chunkSize, count, ranges };
}

// TikTok replies 200 with {error: {code: "ok"}} on success and a non-"ok" code otherwise.
async function tiktok(url, auth, json) {
  const { data } = await request(url, { method: 'POST', headers: auth, json });
  if (data.error && data.error.code !== 'ok') throw new Error(`TikTok: ${data.error.message || data.error.code}`);
  return data.data;
}

// Access tokens last 24 hours; the refresh token lasts a year.
async function freshToken(account) {
  if (!expiresSoon(account.token_expires_at, 300)) return account.access_token;
  const { data } = await request(`${API}/v2/oauth/token/`, {
    method: 'POST',
    form: {
      client_key: config.tiktok.clientKey, client_secret: config.tiktok.clientSecret,
      grant_type: 'refresh_token', refresh_token: account.refresh_token,
    },
  });
  if (data.error) throw new Error(`TikTok login expired; reconnect the account (${data.error_description || data.error})`);
  saveTokens(account.id, { accessToken: data.access_token, refreshToken: data.refresh_token, tokenExpiresAt: expiresIn(data.expires_in) });
  return data.access_token;
}
