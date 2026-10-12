import { config } from '../config.js';
import { sleep } from '../http.js';
import instagram from './instagram.js';
import facebook from './facebook.js';
import youtube from './youtube.js';
import tiktok from './tiktok.js';

const real = { instagram, facebook, youtube, tiktok };

// DRY_RUN=1 swaps every platform for a fake that "connects" a demo account and pretends to publish.
const fake = (p) => ({
  ...p,
  configured: () => true,
  authUrl: (state) => `/auth/${p.id}/callback?code=demo&state=${state}`,
  connectWithToken: p.connectWithToken && (async () => [{ platform: p.id, externalId: `demo-tok-${Date.now()}`, name: `Demo ${p.label}`, handle: '@pasted', accessToken: 'demo' }]),
  connect: async () => [{ platform: p.id, externalId: `demo-${p.id}-${Date.now()}`, name: `Demo ${p.label}`, handle: '@demo', accessToken: 'demo' }],
  publish: async () => { await sleep(1500); return `dry-run-${Date.now()}`; },
  creatorInfo: p.creatorInfo && (async () => ({
    nickname: 'Demo TikTok', username: 'demo', privacyOptions: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
    commentDisabled: false, duetDisabled: false, stitchDisabled: true, maxDurationSec: 600,
  })),
});

export const platforms = Object.fromEntries(
  Object.entries(real).map(([id, p]) => [id, config.dryRun ? fake(p) : p]),
);
