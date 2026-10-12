// Instagram (with Instagram Login) only accepts a public video_url, so while an Instagram post is
// processing we hand out a one-time, unguessable link to that one video. On a PC without a public
// address this opens a temporary Cloudflare quick tunnel that serves nothing but those links.
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { sleep } from './http.js';

const shares = new Map(); // token -> absolute file path
let tunnel = null; // { proc, url, users, stopTimer }

export const mediaShare = {
  async share(filePath) {
    const token = crypto.randomBytes(24).toString('hex');
    shares.set(token, filePath);
    let base;
    try { base = await publicBase(); } catch (err) { shares.delete(token); throw err; }
    let released = false;
    return {
      url: `${base}/media/${token}/video${path.extname(filePath).toLowerCase() || '.mp4'}`,
      release() {
        if (released) return;
        released = true;
        shares.delete(token);
        if (!config.publicUrl && tunnel && --tunnel.users === 0) scheduleStop();
      },
    };
  },
};

// GET /media/:token/:name
export function serveSharedMedia(req, res) {
  if (req.params.token === 'ping') return res.send('ok');
  const file = shares.get(req.params.token);
  if (!file) return res.sendStatus(404);
  res.sendFile(file);
}

// Requests that arrive through the tunnel may only fetch shared videos, never the app itself.
export function tunnelGuard(req, res, next) {
  const viaTunnel = req.headers['cf-connecting-ip'] || /\.trycloudflare\.com$/i.test(req.hostname || '');
  if (viaTunnel && !req.path.startsWith('/media/')) return res.sendStatus(404);
  next();
}

async function publicBase() {
  if (config.publicUrl) return config.publicUrl;
  if (tunnel?.url) {
    tunnel.users++;
    clearTimeout(tunnel.stopTimer);
    return tunnel.url;
  }
  // Assign before starting: startTunnel() stores the child process on `tunnel` synchronously.
  if (!tunnel) {
    tunnel = { users: 0 };
    tunnel.starting = startTunnel();
  }
  const current = tunnel;
  current.users++;
  try {
    current.url = await current.starting;
    return current.url;
  } catch (err) {
    current.proc?.kill();
    if (tunnel === current) tunnel = null;
    throw err;
  }
}

async function startTunnel() {
  const bin = cloudflaredPath();
  const log = []; // recent cloudflared output, for error messages
  let registered = false;
  const url = await new Promise((resolve, reject) => {
    const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${config.port}`], { windowsHide: true });
    tunnel.proc = proc;
    const timer = setTimeout(() => reject(new Error('Could not open a temporary link for Instagram within 30s')), 30_000);
    const onData = (buf) => {
      const text = String(buf);
      log.push(...text.split(/\r?\n/).filter(Boolean));
      log.splice(0, Math.max(0, log.length - 15));
      if (/Registered tunnel connection/i.test(text)) registered = true;
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(err.code === 'ENOENT'
        ? 'Instagram needs cloudflared to make a temporary video link; install it (winget install Cloudflare.cloudflared) or set CLOUDFLARED_PATH'
        : `cloudflared failed: ${err.message}`));
    });
    proc.on('exit', () => { if (tunnel?.proc === proc) tunnel = null; });
  });
  // A new quick tunnel can take a little while before it answers. Its hostname is brand new, so look it
  // up through public DNS: the PC's own resolver often caches the first "not found" for several minutes.
  let lastError = '';
  for (let i = 0; i < 45; i++) {
    try {
      if ((await pingViaPublicDns(`${url}/media/ping/x`)) === 200) return url;
      lastError = 'link answered but not with the app';
    } catch (err) { lastError = err.code || err.message; }
    await sleep(2000);
  }
  const detail = registered ? `tunnel connected but unreachable (${lastError})` : `tunnel never connected to Cloudflare (${lastError})`;
  console.error(`[media-share] cloudflared output:\n${log.join('\n')}`);
  if (!registered) throw new Error(`The temporary video link never came online: ${detail}`);
  // Connected but our own check can't reach it: Instagram's fetch may still work, so let it be the judge.
  console.warn(`[media-share] ${url}: ${detail}; trying Instagram anyway`);
  return url;
}

const publicResolver = new dns.Resolver();
publicResolver.setServers(['1.1.1.1', '8.8.8.8']);

function pingViaPublicDns(url) {
  const lookup = (host, opts, cb) => publicResolver.resolve4(host, (err, addrs) => {
    if (err) return cb(err);
    if (opts?.all) return cb(null, addrs.map((address) => ({ address, family: 4 })));
    cb(null, addrs[0], 4);
  });
  return new Promise((resolve, reject) => {
    const req = https.get(url, { lookup, timeout: 10_000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}

function scheduleStop() {
  clearTimeout(tunnel.stopTimer);
  tunnel.stopTimer = setTimeout(() => {
    if (tunnel && tunnel.users === 0) { tunnel.proc?.kill(); tunnel = null; }
  }, 60_000);
}

function cloudflaredPath() {
  const candidates = [
    config.cloudflaredPath,
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || 'cloudflared';
}
