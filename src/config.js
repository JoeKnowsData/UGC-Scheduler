import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const baseUrl = (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, '');

export const config = {
  root,
  port: Number(env.PORT || 3000),
  baseUrl,
  dataDir: env.DATA_DIR || path.join(root, 'data'),
  appPassword: env.APP_PASSWORD || '',
  // Public HTTPS address that reaches this app, if it has one. Otherwise Instagram videos go out through a temporary cloudflared tunnel.
  publicUrl: (env.PUBLIC_URL || (/^https:\/\/(?!localhost)/.test(baseUrl) ? baseUrl : '')).replace(/\/$/, ''),
  cloudflaredPath: env.CLOUDFLARED_PATH || '',
  dryRun: env.DRY_RUN === '1',
  pollSeconds: Number(env.POLL_SECONDS || 20),
  // How often to check a platform's processing status after an upload
  publishPollMs: Number(env.PUBLISH_POLL_MS || 5000),
  meta: {
    version: env.META_API_VERSION || 'v23.0',
    fbAppId: env.FB_APP_ID, fbAppSecret: env.FB_APP_SECRET,
    igAppId: env.IG_APP_ID, igAppSecret: env.IG_APP_SECRET,
  },
  google: {
    clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET,
    privacy: env.YOUTUBE_PRIVACY || 'public',
  },
  tiktok: {
    clientKey: env.TIKTOK_CLIENT_KEY, clientSecret: env.TIKTOK_CLIENT_SECRET,
    mode: env.TIKTOK_MODE === 'inbox' ? 'inbox' : 'direct',
    privacy: env.TIKTOK_PRIVACY || 'SELF_ONLY',
  },
};

// A platform that refuses localhost (TikTok) can redirect to a public page instead, e.g. TIKTOK_REDIRECT_URI,
// which forwards the browser on to BASE_URL/auth/<platform>/callback with the same query string.
export const redirectUri = (platform) =>
  env[`${platform.toUpperCase()}_REDIRECT_URI`] || `${config.baseUrl}/auth/${platform}/callback`;
