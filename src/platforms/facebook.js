// Facebook Page Reels via the Graph API video_reels endpoint.
import { config, redirectUri } from '../config.js';
import { request, withQuery } from '../http.js';

const GRAPH = 'https://graph.facebook.com';
const v = () => config.meta.version;

export default {
  id: 'facebook',
  label: 'Facebook Page',
  configured: () => !!(config.meta.fbAppId && config.meta.fbAppSecret),

  authUrl: (state) => withQuery(`https://www.facebook.com/${v()}/dialog/oauth`, {
    client_id: config.meta.fbAppId,
    redirect_uri: redirectUri('facebook'),
    scope: 'pages_show_list,pages_read_engagement,pages_manage_posts,business_management',
    state,
  }),

  // One login returns every Page you manage; each Page becomes its own account.
  async connect(code) {
    const { data: short } = await request(withQuery(`${GRAPH}/${v()}/oauth/access_token`, {
      client_id: config.meta.fbAppId, client_secret: config.meta.fbAppSecret,
      redirect_uri: redirectUri('facebook'), code,
    }));
    // Page tokens fetched with a long-lived user token do not expire.
    const { data: long } = await request(withQuery(`${GRAPH}/${v()}/oauth/access_token`, {
      grant_type: 'fb_exchange_token', client_id: config.meta.fbAppId, client_secret: config.meta.fbAppSecret,
      fb_exchange_token: short.access_token,
    }));
    return pagesFor(long.access_token);
  },

  // A user token from the Graph API Explorer, extended to 60 days in the Access Token Debugger.
  // Page tokens fetched with it never expire, so this needs no app secret or redirect URL.
  async connectWithToken(token) {
    token = token.trim();
    const { data: dbg } = await request(withQuery(`${GRAPH}/${v()}/debug_token`, { input_token: token, access_token: token }))
      .catch(() => ({ data: {} }));
    const info = dbg.data || {};
    if (info.type === 'USER' && info.expires_at && info.expires_at * 1000 - Date.now() < 2 * 86400e3) {
      throw new Error('this key expires within hours. Extend it first in the Access Token Debugger, then paste the extended key');
    }
    if (info.type === 'PAGE') throw new Error('that is a Page key; paste the User key instead (it adds all your Pages at once)');
    const pages = await pagesFor(token);
    if (!pages.length) throw new Error('no Pages found. Make sure the key has pages_show_list and you picked your Pages when generating it');
    return pages;
  },

  async publish(account, { caption, video }) {
    const pageId = account.external_id;
    const token = account.access_token;

    const { data: start } = await request(`${GRAPH}/${v()}/${pageId}/video_reels`, {
      method: 'POST', form: { upload_phase: 'start', access_token: token },
    });
    await request(start.upload_url || `https://rupload.facebook.com/video-upload/${v()}/${start.video_id}`, {
      method: 'POST',
      headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(video.size) },
      body: video.bytes(),
    });
    await request(`${GRAPH}/${v()}/${pageId}/video_reels`, {
      method: 'POST',
      form: { upload_phase: 'finish', video_id: start.video_id, video_state: 'PUBLISHED', description: caption, access_token: token },
    });
    return start.video_id;
  },
};

async function pagesFor(userToken) {
  const { data: pages } = await request(withQuery(`${GRAPH}/${v()}/me/accounts`, {
    fields: 'id,name,access_token,picture{url}', limit: 100, access_token: userToken,
  }));
  return (pages.data || []).map((p) => ({
    platform: 'facebook',
    externalId: p.id,
    name: p.name,
    handle: 'Facebook Page',
    avatar: p.picture?.data?.url,
    accessToken: p.access_token,
  }));
}
