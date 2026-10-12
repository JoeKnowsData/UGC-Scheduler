// Small fetch wrapper: parses JSON and turns platform error payloads into readable Errors.
export async function request(url, { method = 'GET', headers = {}, json, form, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers['Content-Type'] ??= 'application/json; charset=UTF-8';
  } else if (form !== undefined) {
    init.body = new URLSearchParams(clean(form));
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (body !== undefined) {
    init.body = body;
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${new URL(url).host}${new URL(url).pathname} -> ${res.status}: ${describe(data)}`);
  return { data, headers: res.headers, status: res.status };
}

export const withQuery = (url, params) => `${url}?${new URLSearchParams(clean(params))}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
}

function describe(data) {
  const e = data?.error;
  // TikTok often sends a generic message; its code (e.g. unaudited_client_can_only_post_to_private_accounts) says what is wrong.
  if (e?.message) return e.code && e.code !== 'ok' && !e.message.includes(e.code) ? `${e.message} [${e.code}]` : e.message;
  if (typeof e === 'string') return data.error_description ? `${e}: ${data.error_description}` : e;
  if (data?.error_message) return data.error_message;
  return (data?.raw ?? JSON.stringify(data)).slice(0, 300);
}
