// Instagram Reels via the "Instagram API with Instagram Login" (Business or Creator accounts, no Facebook Page needed).
// This API only takes a public video_url (direct uploads need Facebook Login), so each video is shared by a one-time link.
import { config, redirectUri } from '../config.js';
import { request, withQuery, sleep } from '../http.js';
import { saveTokens, expiresIn, expiresSoon } from '../db.js';
import { mediaShare } from '../media-share.js';

const GRAPH = 'https://graph.instagram.com';
const v = () => config.meta.version;

export default {
  id: 'instagram',
  label: 'Instagram',
  configured: () => !!(config.meta.igAppId && config.meta.igAppSecret),

  authUrl: (state) => withQuery('https://www.instagram.com/oauth/authorize', {
    client_id: config.meta.igAppId,
    redirect_uri: redirectUri('instagram'),
    response_type: 'code',
    scope: 'instagram_business_basic,instagram_business_content_publish',
    state,
  }),

  async connect(code) {
    const { data: short } = await request('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      form: {
        client_id: config.meta.igAppId, client_secret: config.meta.igAppSecret,
        grant_type: 'authorization_code', redirect_uri: redirectUri('instagram'), code,
      },
    });
    const { data: long } = await request(withQuery(`${GRAPH}/access_token`, {
      grant_type: 'ig_exchange_token', client_secret: config.meta.igAppSecret, access_token: short.access_token,
    }));
    return [await accountFromToken(long.access_token, long.expires_in)];
  },

  // A token generated in the Meta dashboard (Instagram > API setup > Generate token) is already long-lived,
  // so connecting this way needs no redirect URL or HTTPS.
  connectWithToken: async (token) => [await accountFromToken(token.trim(), 60 * 86400)],

  async publish(account, { caption, video }) {
    const token = await freshToken(account);
    const igId = account.external_id;

    const link = await mediaShare.share(video.path);
    let creationId;
    try {
      const { data: container } = await request(`${GRAPH}/${v()}/${igId}/media`, {
        method: 'POST',
        form: { media_type: 'REELS', video_url: link.url, caption, access_token: token },
      });

      // Instagram downloads and transcodes the video before it can be published.
      for (let i = 0; ; i++) {
        const { data: s } = await request(withQuery(`${GRAPH}/${v()}/${container.id}`, {
          fields: 'status_code,status', access_token: token,
        }));
        if (s.status_code === 'FINISHED') break;
        if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Instagram processing failed: ${s.status || s.status_code}`);
        if (i * config.publishPollMs > 15 * 60_000) throw new Error('Instagram processing timed out after 15 minutes');
        await sleep(config.publishPollMs);
      }
      creationId = container.id;
    } finally {
      link.release();
    }

    const { data: published } = await request(`${GRAPH}/${v()}/${igId}/media_publish`, {
      method: 'POST',
      form: { creation_id: creationId, access_token: token },
    });
    return published.id;
  },
};

async function accountFromToken(token, expiresInSeconds) {
  const { data: me } = await request(withQuery(`${GRAPH}/${v()}/me`, {
    fields: 'user_id,username,name,profile_picture_url', access_token: token,
  }));
  return {
    platform: 'instagram',
    externalId: me.user_id ?? me.id,
    name: me.name || me.username,
    handle: me.username,
    avatar: me.profile_picture_url,
    accessToken: token,
    tokenExpiresAt: expiresIn(expiresInSeconds),
  };
}

// Long-lived tokens last 60 days; refresh once fewer than 10 remain. Each successful post keeps it alive.
async function freshToken(account) {
  if (!expiresSoon(account.token_expires_at, 10 * 86400)) return account.access_token;
  const { data } = await request(withQuery(`${GRAPH}/refresh_access_token`, {
    grant_type: 'ig_refresh_token', access_token: account.access_token,
  }));
  saveTokens(account.id, { accessToken: data.access_token, tokenExpiresAt: expiresIn(data.expires_in) });
  return data.access_token;
}
