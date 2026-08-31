const CORS = {
  'Access-Control-Allow-Origin': 'https://miro.com',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Webhook-Secret',
  'Access-Control-Max-Age': '86400',
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export function text(body, contentType = 'text/plain; charset=utf-8', status = 200) {
  return new Response(body, {
    status,
    headers: { ...CORS, 'Content-Type': contentType, 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}

export function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function readJson(request) {
  try { return await request.clone().json(); } catch { return null; }
}

function base64UrlBytes(value) {
  let base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  const binary = atob(base64);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export async function verifyMiroToken(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const [head, payload, signature] = parts;
    const header = JSON.parse(new TextDecoder().decode(base64UrlBytes(head)));
    const data = JSON.parse(new TextDecoder().decode(base64UrlBytes(payload)));
    if (header.alg !== 'HS256' || (typeof data.exp === 'number' && data.exp <= Math.floor(Date.now() / 1000))) return null;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, base64UrlBytes(signature), new TextEncoder().encode(`${head}.${payload}`)) ? data : null;
  } catch {
    return null;
  }
}

export async function requireMiro(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  return verifyMiroToken(auth.slice(7).trim(), env.MIRO_CLIENT_SECRET);
}

export function requireJiraWebhook(request, env) {
  return Boolean(env.JIRA_WEBHOOK_SECRET) && (request.headers.get('X-Webhook-Secret') || '') === env.JIRA_WEBHOOK_SECRET;
}
