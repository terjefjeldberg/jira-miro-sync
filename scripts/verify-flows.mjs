import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../src/index.js';
import { createDirectCard, refreshCard } from '../src/cards.js';
import { transitionIssue } from '../src/jira.js';
import { customMapKey, directPendingKey, freezeKey } from '../src/config.js';

class FakeKv {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  async get(key, type) {
    const value = this.values.has(key) ? this.values.get(key) : null;
    if (type === 'json' && value != null) {
      try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
    }
    return value;
  }
  async put(key, value) { this.values.set(key, String(value)); }
  async delete(key) { this.values.delete(key); }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const baseEnv = {
  JIRA_PROJECT_KEY: 'SN',
  JIRA_CLOUD_ID: 'cloud',
  JIRA_API_TOKEN: 'jira-token',
  MIRO_BOARD_ID: 'board',
  MIRO_TOKEN: 'miro-token',
};

// Normal drag to Functional review must keep the Test area gate.
{
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.match(String(url), /\/issue\/SN-1\?fields=status,customfield_10832$/);
    return json({ fields: { status: { name: 'In progress' }, customfield_10832: null } });
  };
  const result = await transitionIssue(baseEnv, 'SN-1', 'Functional review');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TEST_AREA_REQUIRED');
  globalThis.fetch = oldFetch;
}

// Sticky conversion deliberately bypasses that gate and may use the first Jira
// transition to the requested status, matching the working pre-refactor flow.
{
  const oldFetch = globalThis.fetch;
  let transitioned = false;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/issue/SN-2?fields=status,customfield_10832')) return json({ fields: { status: { name: 'Todo' }, customfield_10832: null } });
    if (value.endsWith('/issue/SN-2/transitions') && !init.method) return json({ transitions: [
      { id: '11', name: 'Transition A', to: { name: 'Functional review' } },
      { id: '12', name: 'Transition B', to: { name: 'Functional review' } },
    ] });
    if (value.endsWith('/issue/SN-2/transitions') && init.method === 'POST') { transitioned = true; return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected fetch ${value}`);
  };
  const result = await transitionIssue(baseEnv, 'SN-2', 'Functional review', { enforceTestArea: false, firstMatchingTransition: true });
  assert.equal(result.ok, true);
  assert.equal(result.transitionId, '11');
  assert.equal(transitioned, true);
  globalThis.fetch = oldFetch;
}

// A direct sticky conversion reuses and repositions an image that a racing Jira
// creation webhook may already have created in Incoming.
{
  const kv = new FakeKv({ [customMapKey('SN-3')]: 'img-3' });
  const env = { ...baseEnv, CARD_MAP: kv };
  const oldFetch = globalThis.fetch;
  let patchBody = null;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith('/items/img-3') && !init.method) return json({ id: 'img-3', type: 'image', position: { x: 10, y: 20 }, geometry: { width: 320 } });
    if (value.endsWith('/items/img-3') && init.method === 'PATCH') { patchBody = JSON.parse(init.body); return json({ id: 'img-3' }); }
    throw new Error(`Unexpected fetch ${value}`);
  };
  const result = await createDirectCard(env, 'SN-3', 123, 456);
  assert.equal(result.ok, true);
  assert.equal(result.itemId, 'img-3');
  assert.deepEqual(patchBody.parent, { id: null });
  assert.deepEqual(patchBody.position, { x: 123, y: 456, origin: 'center' });
  globalThis.fetch = oldFetch;
}

// Legacy custom cards remain movable but are never sent to the image-only SVG
// refresh endpoint.
{
  const kv = new FakeKv({ [customMapKey('SN-4')]: 'frame-4' });
  const env = { ...baseEnv, CARD_MAP: kv };
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async url => {
    calls += 1;
    assert.match(String(url), /\/items\/frame-4$/);
    return json({ id: 'frame-4', type: 'frame', position: { x: 1, y: 2 }, geometry: { width: 320, height: 120 } });
  };
  const result = await refreshCard(env, 'SN-4');
  assert.equal(result.ok, true);
  assert.equal(result.legacy, true);
  assert.equal(calls, 1);
  globalThis.fetch = oldFetch;
}

function token(secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

// While sticky conversion is pending, Jira creation/status webhooks must not
// move an already-created direct card away from the sticky's exact position.
{
  const kv = new FakeKv({
    [customMapKey('SN-5')]: 'img-5',
    [directPendingKey('SN-5')]: JSON.stringify({ stickyId: 'sticky-5' }),
  });
  const env = { ...baseEnv, CARD_MAP: kv, JIRA_WEBHOOK_SECRET: 'webhook-secret' };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes('/issue/SN-5?fields=')) return json({ fields: { summary: 'x', priority: { name: 'Medium' }, assignee: null, issuetype: { name: 'Bug' }, status: { name: 'Todo' }, customfield_11207: null } });
    throw new Error(`Unexpected fetch ${url}`);
  };
  const response = await worker.fetch(new Request('https://worker.test/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': 'webhook-secret' },
    body: JSON.stringify({ issueKey: 'SN-5', status: 'Todo' }),
  }), env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.conversionDirectCreatePending, true);
  assert.equal(body.suppressionSource, 'kv-marker');
  globalThis.fetch = oldFetch;
}

// Finalizing conversion removes the pending marker but keeps the short freeze,
// even when Jira was already in that status, so a late creation webhook cannot
// recenter the card.
{
  const secret = 'miro-secret';
  const kv = new FakeKv({ [directPendingKey('SN-6')]: JSON.stringify({ stickyId: 'sticky-6' }) });
  const env = { ...baseEnv, CARD_MAP: kv, MIRO_CLIENT_SECRET: secret };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes('/issue/SN-6?fields=status,customfield_10832')) return json({ fields: { status: { name: 'Todo' }, customfield_10832: null } });
    throw new Error(`Unexpected fetch ${url}`);
  };
  const response = await worker.fetch(new Request('https://worker.test/conversion-set-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(secret)}` },
    body: JSON.stringify({ issueKey: 'SN-6', desiredStatus: 'Todo' }),
  }), env);
  assert.equal(response.status, 200);
  assert.equal(await kv.get(directPendingKey('SN-6')), null);
  assert.notEqual(await kv.get(freezeKey('SN-6')), null);
  globalThis.fetch = oldFetch;
}

console.log('Critical flow verification passed.');
