import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated data dir and fast polling, set before any app module loads.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugc-test-'));
Object.assign(process.env, {
  DATA_DIR: dir, PUBLISH_POLL_MS: '1', BASE_URL: 'https://sched.example.com',
  FB_APP_ID: 'fbid', FB_APP_SECRET: 'fbsecret', IG_APP_ID: 'igid', IG_APP_SECRET: 'igsecret',
  GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret',
  TIKTOK_CLIENT_KEY: 'tkey', TIKTOK_CLIENT_SECRET: 'tsecret',
});

// Replaces global fetch with [method, url prefix or regex, handler] routes and records every call.
// A handler returns the JSON body, or {body, status, headers} when it needs more control.
export function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const call = { method: init.method || 'GET', url: u, headers: init.headers || {}, body: init.body };
    calls.push(call);
    const route = routes.find(([m, p]) => m === call.method && (typeof p === 'string' ? u.href.startsWith(p) : p.test(u.href)));
    if (!route) throw new Error(`unmocked ${call.method} ${u.href}`);
    const out = await route[2](call);
    return new Response(JSON.stringify(out.body ?? out), { status: out.status ?? 200, headers: out.headers ?? {} });
  };
  return calls;
}

export function fakeVideo(size = 1000) {
  const buf = Buffer.alloc(size, 7);
  return { size, mime: 'video/mp4', path: '/tmp/clip.mp4', bytes: () => buf };
}

export const form = (call) => Object.fromEntries(new URLSearchParams(call.body.toString()));
