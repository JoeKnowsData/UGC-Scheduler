// YouTube Shorts via the YouTube Data API v3. A vertical video of 3 minutes or less is treated as a Short automatically.
import { config, redirectUri } from '../config.js';
import { request, withQuery } from '../http.js';
import { saveTokens, expiresIn, expiresSoon } from '../db.js';

export default {
  id: 'youtube',
  label: 'YouTube',
  configured: () => !!(config.google.clientId && config.google.clientSecret),

  authUrl: (state) => withQuery('https://accounts.google.com/o/oauth2/v2/auth', {
    client_id: config.google.clientId,
    redirect_uri: redirectUri('youtube'),
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    access_type: 'offline',
    prompt: 'consent select_account',
    state,
  }),

  async connect(code) {
    const { data: tok } = await request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      form: {
        client_id: config.google.clientId, client_secret: config.google.clientSecret,
        grant_type: 'authorization_code', redirect_uri: redirectUri('youtube'), code,
      },
    });
    const { data: ch } = await request(withQuery('https://www.googleapis.com/youtube/v3/channels', { part: 'snippet', mine: 'true' }), {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    const c = ch.items?.[0];
    if (!c) throw new Error('This Google account has no YouTube channel');
    return [{
      platform: 'youtube',
      externalId: c.id,
      name: c.snippet.title,
      handle: c.snippet.customUrl,
      avatar: c.snippet.thumbnails?.default?.url,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      tokenExpiresAt: expiresIn(tok.expires_in),
    }];
  },

  async publish(account, { caption, video }) {
    const token = await freshToken(account);
    const { title, description } = titleAndDescription(caption);

    const { headers } = await request(withQuery('https://www.googleapis.com/upload/youtube/v3/videos', {
      uploadType: 'resumable', part: 'snippet,status',
    }), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Upload-Content-Length': String(video.size),
        'X-Upload-Content-Type': video.mime,
      },
      json: {
        snippet: { title, description, categoryId: '22' },
        status: { privacyStatus: config.google.privacy, selfDeclaredMadeForKids: false },
      },
    });
    const { data } = await request(headers.get('location'), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': video.mime },
      body: video.bytes(),
    });
    return data.id;
  },
};

// The first line of the caption becomes the title (max 100 chars); the whole caption is the description.
export function titleAndDescription(caption) {
  const clean = (s) => s.replace(/[<>]/g, '');
  const firstLine = clean(caption).split('\n').map((l) => l.trim()).find(Boolean) || 'New Short';
  const title = firstLine.length > 100 ? `${firstLine.slice(0, 97).trimEnd()}...` : firstLine;
  return { title, description: clean(caption).slice(0, 5000) };
}

async function freshToken(account) {
  if (!expiresSoon(account.token_expires_at, 120)) return account.access_token;
  if (!account.refresh_token) throw new Error('YouTube login expired; reconnect the channel');
  const { data } = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    form: {
      client_id: config.google.clientId, client_secret: config.google.clientSecret,
      grant_type: 'refresh_token', refresh_token: account.refresh_token,
    },
  });
  saveTokens(account.id, { accessToken: data.access_token, refreshToken: data.refresh_token, tokenExpiresAt: expiresIn(data.expires_in) });
  return data.access_token;
}
