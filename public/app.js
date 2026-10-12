const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PF = { instagram: 'IG', facebook: 'FB', youtube: 'YT', tiktok: 'TT' };

let accounts = [];

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function flash(msg, kind = 'ok') {
  const el = $('#flash');
  el.textContent = msg; el.className = kind; el.hidden = false;
  clearTimeout(flash.t); flash.t = setTimeout(() => (el.hidden = true), 6000);
}

// ---- Tabs ----
function showTab(name) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== name));
  if (name === 'queue') loadPosts();
}
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---- Accounts ----
const avatar = (a) => a.avatar ? `<img src="${esc(a.avatar)}" alt="" referrerpolicy="no-referrer">` : '<span class="avatar"></span>';

async function loadAccounts() {
  accounts = await api('/api/accounts');
  $('#account-picker').innerHTML = accounts.length ? accounts.map((a) => `
    <label class="acct">
      <input type="checkbox" name="accountIds" value="${a.id}">
      ${avatar(a)}
      <span class="who"><div>${esc(a.name)}</div><small><span class="pf ${a.platform}">${PF[a.platform]}</span> ${esc(a.handle || '')}</small></span>
    </label>`).join('') : '<p class="hint">No accounts yet. Connect them on the Accounts tab.</p>';

  $('#account-list').innerHTML = accounts.length ? accounts.map((a) => `
    <div class="acct">
      ${avatar(a)}
      <span class="who"><div>${esc(a.name)}</div><small><span class="pf ${a.platform}">${PF[a.platform]}</span> ${esc(a.handle || '')}</small></span>
      <button class="link" data-reconnect="${a.platform}">Reconnect</button>
      <button class="link" data-remove="${a.id}">Remove</button>
    </div>`).join('') : '<p class="hint">Nothing connected yet.</p>';
}

async function loadPlatforms() {
  const list = await api('/api/platforms');
  $('#connect-buttons').innerHTML = list.map((p) => `
    <a class="${p.id}${p.configured ? '' : ' off'}" href="/auth/${p.id}/start" title="${p.configured ? '' : 'Add this platform\'s keys to .env first'}">+ ${esc(p.label)}</a>`).join('');
}

$('#account-list').addEventListener('click', async (e) => {
  if (e.target.dataset.reconnect) location.href = `/auth/${e.target.dataset.reconnect}/start`;
  if (e.target.dataset.remove && confirm('Remove this account? Its scheduled posts to it are dropped.')) {
    await api(`/api/accounts/${e.target.dataset.remove}`, { method: 'DELETE' });
    loadAccounts();
  }
});

$('#token-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { connected } = await api('/api/accounts/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: e.target.elements.platform.value, token: e.target.elements.token.value }),
    });
    e.target.reset();
    flash(`Connected ${connected.join(', ')}`);
    loadAccounts();
  } catch (err) { flash(err.message, 'bad'); }
});

$('#select-all').addEventListener('click', () => {
  const boxes = [...document.querySelectorAll('#account-picker input')];
  const all = boxes.every((b) => b.checked);
  boxes.forEach((b) => (b.checked = !all));
  $('#select-all').textContent = all ? 'Select all' : 'Select none';
});

// ---- Compose ----
const form = $('#post-form');
const fileInput = form.elements.video;

form.elements.caption.addEventListener('input', (e) => ($('#caption-count').textContent = e.target.value.length));
$('#tz').textContent = `Your time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;

function defaultTime() {
  const d = new Date(Date.now() + 60 * 60_000);
  d.setMinutes(0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
form.elements.when.value = defaultTime();

let videoSecs = null;

function showFile() {
  const f = fileInput.files[0];
  const v = $('#preview');
  if (!f) { v.hidden = true; videoSecs = null; updateTikTok(); $('#drop-text').textContent = 'Choose or drop a vertical video (.mp4 or .mov)'; return; }
  v.src = URL.createObjectURL(f); v.hidden = false;
  v.onloadedmetadata = () => {
    const secs = Math.round(v.duration);
    videoSecs = secs;
    updateTikTok();
    const vertical = v.videoHeight > v.videoWidth;
    $('#drop-text').textContent = `${f.name} · ${(f.size / 1048576).toFixed(1)} MB · ${secs}s${vertical ? '' : ' · not vertical, it may not count as a Reel/Short'}${secs > 90 ? ' · Facebook Reels max 90s, YouTube Shorts max 3 min' : ''}`;
  };
}
fileInput.addEventListener('change', showFile);
const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  if (e.dataTransfer.files.length) { fileInput.files = e.dataTransfer.files; showFile(); }
});

// ---- TikTok posting screen (required by TikTok's Content Sharing Guidelines) ----
const PRIVACY = { PUBLIC_TO_EVERYONE: 'Everyone', MUTUAL_FOLLOW_FRIENDS: 'Friends', FOLLOWER_OF_CREATOR: 'Followers', SELF_ONLY: 'Only me' };
const MUSIC = '<a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener">Music Usage Confirmation</a>';
const BC_POLICY = '<a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noopener">Branded Content Policy</a>';
const tt = { infos: {}, loading: new Set() }; // account id -> creator info (or { error })
const el = (name) => form.elements[name];

const selectedTikTok = () => [...form.querySelectorAll('input[name=accountIds]:checked')]
  .map((b) => accounts.find((a) => String(a.id) === b.value)).filter((a) => a?.platform === 'tiktok');

async function loadTikTokInfo(a) {
  if (tt.infos[a.id] || tt.loading.has(a.id)) return;
  tt.loading.add(a.id);
  try { tt.infos[a.id] = await api(`/api/accounts/${a.id}/tiktok-info`); }
  catch (err) { tt.infos[a.id] = { error: err.message }; }
  tt.loading.delete(a.id);
  updateTikTok();
}

function updateTikTok() {
  const sel = selectedTikTok();
  $('#tiktok-panel').hidden = !sel.length;
  if (!sel.length) return;
  sel.forEach(loadTikTokInfo);
  const infos = sel.map((a) => tt.infos[a.id]).filter(Boolean);
  const ready = infos.filter((i) => !i.error);

  $('#tt-creator').innerHTML = sel.map((a) => {
    const i = tt.infos[a.id];
    if (!i) return `Posting to ${esc(a.name)}…`;
    if (i.error) return `<span class="warn">${esc(a.name)}: ${esc(i.error)}</span>`;
    return `Posting to <b>${esc(i.nickname || a.name)}</b>${i.username ? ` (@${esc(i.username)})` : ''}`;
  }).join('<br>');

  // Privacy: only levels every selected account allows, and nothing chosen by default.
  const privacy = el('tt_privacy');
  const allowed = ready.length ? Object.keys(PRIVACY).filter((p) => ready.every((i) => i.privacyOptions.includes(p))) : [];
  const keep = privacy.value;
  privacy.innerHTML = '<option value="">Select…</option>' + allowed.map((p) => `<option value="${p}">${PRIVACY[p]}</option>`).join('');
  privacy.value = allowed.includes(keep) ? keep : '';

  // Interactions are off until the user turns them on, and greyed out where the creator has disabled them.
  for (const [box, key] of [['tt_comment', 'commentDisabled'], ['tt_duet', 'duetDisabled'], ['tt_stitch', 'stitchDisabled']]) {
    const off = ready.some((i) => i[key]);
    el(box).disabled = off;
    if (off) el(box).checked = false;
  }

  // Content disclosure: branded content can't be private, and at least one option must be picked.
  const disclose = el('tt_disclose').checked;
  $('#tt-disclose').hidden = !disclose;
  const branded = el('tt_branded');
  const onlyMe = [...privacy.options].find((o) => o.value === 'SELF_ONLY');
  branded.disabled = privacy.value === 'SELF_ONLY';
  if (branded.disabled) branded.checked = false;
  branded.closest('label').title = branded.disabled ? 'Branded content visibility cannot be set to private.' : '';
  if (onlyMe) {
    onlyMe.disabled = disclose && branded.checked;
    onlyMe.textContent = onlyMe.disabled ? 'Only me (not allowed for branded content)' : 'Only me';
  }
  const yours = el('tt_yourbrand').checked;
  $('#tt-label').innerHTML = !disclose ? '' : branded.checked
    ? "Your video will be labeled as 'Paid partnership'."
    : yours ? "Your video will be labeled as 'Promotional content'."
    : '<span class="warn">You need to indicate if your content promotes yourself, a third party, or both.</span>';
  $('#tt-consent').innerHTML = `By posting, you agree to TikTok's ${disclose && branded.checked ? `${BC_POLICY} and ` : ''}${MUSIC}.`;

  const max = Math.min(...ready.map((i) => i.maxDurationSec).filter(Boolean));
  if (videoSecs && Number.isFinite(max) && videoSecs > max) {
    $('#tt-creator').insertAdjacentHTML('beforeend', `<br><span class="warn">This video is ${videoSecs}s; TikTok allows up to ${max}s for this account.</span>`);
  }
}

form.addEventListener('change', (e) => {
  if (e.target.name === 'accountIds' || e.target.name?.startsWith('tt_')) updateTikTok();
});
$('#select-all').addEventListener('click', updateTikTok);

function tiktokChoices() {
  const o = {
    privacy: el('tt_privacy').value,
    comment: el('tt_comment').checked, duet: el('tt_duet').checked, stitch: el('tt_stitch').checked,
    disclose: el('tt_disclose').checked,
  };
  o.yourBrand = o.disclose && el('tt_yourbrand').checked;
  o.brandedContent = o.disclose && el('tt_branded').checked;
  if (!o.privacy) return { error: 'TikTok: choose who can see this video' };
  if (o.disclose && !o.yourBrand && !o.brandedContent) return { error: 'TikTok: say whether the video promotes yourself, a third party, or both' };
  const sel = selectedTikTok();
  if (sel.some((a) => !tt.infos[a.id] || tt.infos[a.id].error)) return { error: 'TikTok: account info has not loaded; check the TikTok box above' };
  const max = Math.min(...sel.map((a) => tt.infos[a.id].maxDurationSec).filter(Boolean));
  if (videoSecs && Number.isFinite(max) && videoSecs > max) return { error: `TikTok: this video is longer than the ${max}s allowed` };
  return { options: o };
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const now = e.submitter?.value === 'now';
  const ids = [...form.querySelectorAll('input[name=accountIds]:checked')].map((b) => b.value);
  if (!ids.length) return flash('Pick at least one account', 'bad');
  if (!fileInput.files[0]) return flash('Choose a video', 'bad');
  const toTikTok = selectedTikTok().length > 0;
  const ttc = toTikTok ? tiktokChoices() : {};
  if (ttc.error) return flash(ttc.error, 'bad');
  const when = new Date(form.elements.when.value);
  if (!now && (Number.isNaN(when.getTime()) || when < new Date())) return flash('Pick a time in the future', 'bad');

  const body = new FormData();
  body.append('caption', form.elements.caption.value);
  body.append('accountIds', ids.join(','));
  body.append(now ? 'postNow' : 'scheduledAt', now ? '1' : when.toISOString());
  if (toTikTok) body.append('tiktok', JSON.stringify(ttc.options));
  body.append('video', fileInput.files[0]);

  // XHR rather than fetch so we can show upload progress for big videos.
  const xhr = new XMLHttpRequest();
  const bar = $('#progress');
  bar.hidden = false;
  form.querySelectorAll('button[type=submit]').forEach((b) => (b.disabled = true));
  xhr.upload.onprogress = (ev) => ($('div', bar).style.width = `${(ev.loaded / ev.total) * 100}%`);
  xhr.onloadend = () => {
    bar.hidden = true; $('div', bar).style.width = 0;
    form.querySelectorAll('button[type=submit]').forEach((b) => (b.disabled = false));
    const res = JSON.parse(xhr.responseText || '{}');
    if (xhr.status !== 200) return flash(res.error || 'Upload failed', 'bad');
    const ttNote = toTikTok ? ' After it is published, TikTok may take a few minutes to process it before it shows on your profile.' : '';
    flash((now ? 'Publishing now. Watch progress in the Queue.' : `Scheduled for ${when.toLocaleString()}.`) + ttNote);
    form.elements.caption.value = ''; $('#caption-count').textContent = 0;
    ['tt_privacy', 'tt_comment', 'tt_duet', 'tt_stitch', 'tt_disclose', 'tt_yourbrand', 'tt_branded']
      .forEach((n) => (el(n).type === 'checkbox' ? (el(n).checked = false) : (el(n).value = '')));
    tt.infos = {}; updateTikTok();
    fileInput.value = ''; showFile();
    form.elements.when.value = defaultTime();
    showTab('queue');
  };
  xhr.open('POST', '/api/posts');
  xhr.send(body);
});

// ---- Queue ----
const STATUS = { scheduled: 'Scheduled', publishing: 'Publishing…', published: 'Published', partial: 'Partly failed', failed: 'Failed' };
const TSTATUS = { pending: '⏳', publishing: '⬆️', published: '✅', failed: '❌' };
let pollTimer;

async function loadPosts() {
  const posts = await api('/api/posts');
  const list = $('#post-list');
  list.innerHTML = posts.length ? '' : '<p class="empty">Nothing scheduled yet.</p>';
  let lastDay;
  for (const p of posts) {
    const d = new Date(p.scheduled_at);
    const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    if (day !== lastDay) list.insertAdjacentHTML('beforeend', `<div class="day">${day}</div>`);
    lastDay = day;

    const el = $('#post-tpl').content.firstElementChild.cloneNode(true);
    $('video', el).src = `/api/posts/${p.id}/video#t=0.5`;
    $('.when', el).textContent = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    $('.badge', el).textContent = STATUS[p.status];
    $('.badge', el).classList.add(`s-${p.status}`);
    $('.caption', el).textContent = p.caption || '(no caption)';
    $('.targets', el).innerHTML = p.targets.map((t) => `
      <li>${TSTATUS[t.status]} <span class="pf ${t.platform}">${PF[t.platform]}</span> ${esc(t.name)}
      ${t.error ? `<span class="err">${esc(t.error)}</span>` : ''}</li>`).join('');
    const actions = $('.post-actions', el);
    if (p.status === 'scheduled') actions.append(btn('Post now', () => edit(p.id, { scheduledAt: new Date().toISOString() })), btn('Change time', () => changeTime(p)));
    if (['failed', 'partial'].includes(p.status)) actions.append(btn('Retry failed', () => api(`/api/posts/${p.id}/retry`, { method: 'POST' }).then(loadPosts)));
    if (p.status !== 'publishing') actions.append(btn('Delete', () => confirm('Delete this post?') && api(`/api/posts/${p.id}`, { method: 'DELETE' }).then(loadPosts)));
    list.append(el);
  }
  clearTimeout(pollTimer);
  if (!$('#queue').hidden) pollTimer = setTimeout(loadPosts, posts.some((p) => p.status === 'publishing') ? 3000 : 20000);
}

function btn(label, fn) {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => Promise.resolve(fn()).catch((err) => flash(err.message, 'bad'));
  return b;
}

async function edit(id, body) {
  await api(`/api/posts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  loadPosts();
}

function changeTime(p) {
  const cur = new Date(p.scheduled_at);
  const local = new Date(cur.getTime() - cur.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const val = prompt('New time (YYYY-MM-DD HH:MM, your local time)', local.replace('T', ' '));
  if (val) return edit(p.id, { scheduledAt: new Date(val.replace(' ', 'T')).toISOString() });
}

// ---- Boot ----
const params = new URLSearchParams(location.search);
if (params.get('connected')) flash(`Connected ${params.get('connected')}`);
if (params.get('error')) flash(params.get('error'), 'bad');
if (params.size) { history.replaceState(null, '', '/'); showTab('accounts'); }
loadPlatforms();
loadAccounts();
