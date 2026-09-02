import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../src/index.js';
import { createDirectCard } from '../src/cards.js';
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
// transition to the requested status.
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

// A direct sticky conversion reuses and repositions an existing SVG custom card
// that a racing Jira creation webhook may already have created in Incoming.
{
  const kv = new FakeKv({ [customMapKey('SN-3')]: 'img-3' });
  const env = { ...baseEnv, CARD_MAP: kv };
  const oldFetch = globalThis.fetch;
  let patchBody = null;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith('/items/img-3') && !init.method) return json({ id: 'img-3', type: 'image', data: { title: 'CUSTOM_JIRA_CARD:SN-3' }, position: { x: 10, y: 20 }, geometry: { width: 320 } });
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

// Jira -> Miro must recover a missing KV mapping from the board itself. This
// keeps existing custom cards movable even when the Miro app's periodic scan
// was stopped or its first registration request failed.
{
  const kv = new FakeKv();
  const env = { ...baseEnv, CARD_MAP: kv, JIRA_WEBHOOK_SECRET: 'webhook-secret' };
  const oldFetch = globalThis.fetch;
  let moveBody = null;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/issue/SN-4?fields=')) {
      return json({ fields: { summary: 'Recovered card', priority: { name: 'Medium' }, assignee: null, issuetype: { name: 'Bug' }, status: { name: 'In progress' }, customfield_11207: null } });
    }
    if (value.includes('/items?') && value.includes('type=image')) {
      return json({ data: [{ id: 'img-4', type: 'image', data: { title: 'CUSTOM_JIRA_CARD:SN-4' }, position: { x: 1990, y: 1000, relativeTo: 'parent_top_left' }, parent: { id: 'workflow-frame' }, geometry: { width: 320 } }] });
    }
    if (value.endsWith('/items/img-4') && !init.method) {
      return json({ id: 'img-4', type: 'image', data: { title: 'CUSTOM_JIRA_CARD:SN-4' }, position: { x: 1990, y: 1000, relativeTo: 'parent_top_left' }, parent: { id: 'workflow-frame' }, geometry: { width: 320 } });
    }
    if (value.endsWith('/items/workflow-frame')) {
      return json({ id: 'workflow-frame', type: 'frame', position: { x: 3000, y: 2000 }, geometry: { width: 6000, height: 4000 } });
    }
    if (value.endsWith('/items/img-4') && init.method === 'PATCH') {
      moveBody = JSON.parse(init.body);
      return json({ id: 'img-4' });
    }
    if (value.endsWith('/images/img-4') && init.method === 'PATCH') return json({ id: 'img-4' });
    throw new Error(`Unexpected fetch ${value}`);
  };
  const response = await worker.fetch(new Request('https://worker.test/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': 'webhook-secret' },
    body: JSON.stringify({ issueKey: 'SN-4', status: 'In progress' }),
  }), env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.mappingRecoveredFromBoard, true);
  assert.equal(body.moved, true);
  assert.equal(await kv.get(customMapKey('SN-4')), 'img-4');
  assert.deepEqual(moveBody.position, { x: 2923.455009676509, y: 1000, origin: 'center' });
  globalThis.fetch = oldFetch;
}

// Finalizing conversion removes the pending marker but keeps the freeze,
// even when Jira was already in that status, so a late webhook cannot recenter the card.
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
