import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { renderAppClient } from '../src/app-client.js';
import worker from '../src/index.js';
import { auditJiraStatusChanges, hasMovement, logMovementAudit, prepareMovementAudit, requestingMiroUserId } from '../src/movement-audit.js';

class Kv {
  values = new Map([['movement-user-name:mover', 'Alice']]);
  async get(key) { return this.values.get(key); }
  async put(key, value, options) { assert.ok(options.expirationTtl > 0); this.values.set(key, value); }
}
const kv = new Kv();
const env = { CARD_MAP: kv, MIRO_BOARD_ID: 'board', JIRA_PROJECT_KEY: 'SN', JIRA_CLOUD_ID: 'cloud', MIRO_CLIENT_SECRET: 'secret' };
const now = new Date().toISOString();
const body = { boardId: 'board', issueKey: 'SN-1', itemId: 'image', desiredStatus: 'Code review',
  movement: { from: { x: 4350, y: 1000 }, to: { x: 3842, y: 1000 }, canvasX: 3842, canvasY: 1000, modifiedBy: 'mover', modifiedAt: now } };
const item = { id: 'image', type: 'image', data: { title: 'CUSTOM_JIRA_CARD:SN-1' }, position: { x: 3842, y: 1000 }, modifiedBy: { id: 'mover' }, modifiedAt: now };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const originalFetch = globalThis.fetch, originalLog = console.log, originalError = console.error;
const logs = [];
console.log = (...args) => logs.push(args);
console.error = (...args) => logs.push(args);
try {
  assert.equal(requestingMiroUserId({ user: 'viewer', sub: 'APP-ID' }), 'viewer');
  assert.equal(requestingMiroUserId({ sub: 'APP-ID' }), '');
  assert.equal(hasMovement({ from: { x: 1, y: 1 }, to: { x: 1, y: 1 } }), false);
  globalThis.fetch = async () => json(item);
  const audit = await prepareMovementAudit(env, body, { user: 'viewer', sub: 'APP-ID' });
  assert.equal(audit.actorMiroUserId, 'mover');
  assert.equal(audit.actorName, 'Alice');
  assert.equal(audit.requesterMiroUserId, 'viewer');
  assert.match(audit.attribution, /^miro-last-modifier/);
  assert.equal((await prepareMovementAudit(env, body, { user: 'other-viewer' })).eventId, audit.eventId);
  assert.equal((await prepareMovementAudit(env, { ...body, movement: { ...body.movement, modifiedBy: 'forged' } }, { user: 'viewer' })).actorMiroUserId, null);
  globalThis.fetch = async () => json({ ...item, modifiedAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal((await prepareMovementAudit(env, body, { user: 'viewer' })).attribution, 'unknown');
  globalThis.fetch = async () => json({ ...item, position: { x: 6000, y: 1000 } });
  assert.equal((await prepareMovementAudit(env, body, { user: 'viewer' })).attribution, 'unknown');
  globalThis.fetch = async () => json({}, 500);
  assert.equal((await prepareMovementAudit(env, body, { user: 'viewer' })).attribution, 'unknown');
  const legacy = await prepareMovementAudit(env, { ...body, movement: null }, { user: 'viewer' });
  assert.equal(legacy.actorMiroUserId, null);
  await logMovementAudit(env, audit, { fromStatus: 'Approved', toStatus: 'Code review', outcome: 'status-changed' });
  const stored = [...kv.values.entries()].find(([key]) => key.startsWith('audit:miro:SN-1:'));
  assert.equal(JSON.parse(stored[1]).actorMiroUserId, 'mover');
  assert.equal(JSON.parse(stored[1]).requesterMiroUserId, 'viewer');

  // Jira attribution is read from Jira's own history, never the caller's
  // claimed name. Catch up recent changes and de-duplicate queue redeliveries.
  const changes = [
    { id: 'old', created: '2020-01-01', items: [{ field: 'status' }] },
    { id: '101', created: now, author: { accountId: 'jira-alice', displayName: 'Alice' }, items: [{ field: 'status', fromString: 'Approved', toString: 'Code review' }] },
    { id: '102', created: now, author: { accountId: 'app-account', displayName: 'miro-jira-sync' }, items: [{ field: 'status', fromString: 'Code review', toString: 'Approved' }] },
  ];
  globalThis.fetch = async url => {
    assert.match(String(url), /\/issue\/SN-1\/changelog/);
    return String(url).includes('startAt=') ? json({ values: changes }) : json({ total: 3, values: [changes[0]] });
  };
  await auditJiraStatusChanges(env, 'SN-1');
  await auditJiraStatusChanges(env, 'SN-1');
  assert.equal(logs.filter(args => args[0] === 'Jira status change').length, 2);
  assert.equal(JSON.parse(await kv.get('audit:jira:SN-1:101')).jiraAccountId, 'jira-alice');
  assert.equal(JSON.parse(await kv.get('audit:jira:SN-1:102')).jiraDisplayName, 'miro-jira-sync');

  // Audit endpoint authenticates, checks board and mapping, and saves IDs.
  const segment = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${segment({ alg: 'HS256' })}.${segment({ user: 'viewer', sub: 'APP-ID', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const token = `${unsigned}.${createHmac('sha256', 'secret').update(unsigned).digest('base64url')}`;
  const request = (data, auth = token, path = '/card-movement') => new Request(`https://worker${path}`, { method: 'POST', headers: { Authorization: `Bearer ${auth}` }, body: JSON.stringify(data) });
  globalThis.fetch = async () => json(item);
  assert.equal((await worker.fetch(request(body, 'bad'), env)).status, 401);
  assert.equal((await worker.fetch(request({ ...body, boardId: 'wrong' }), env)).status, 403);
  assert.equal((await worker.fetch(request(body), env)).status, 200);

  // Transition logging must not change the result or turn a storage outage
  // after success into a client rollback.
  let transitioned = false;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith('/images/image')) return json(item);
    if (value.endsWith('/transitions') && init.method === 'POST') { transitioned = true; return new Response(null, { status: 204 }); }
    if (value.endsWith('/transitions')) return json({ transitions: [{ id: '20', name: 'Move to Code review', to: { name: 'Code review' } }] });
    if (value.includes('/issue/SN-1?')) return json({ fields: { summary: 'Test', status: { name: 'Approved' }, issuetype: { name: 'Bug' } } });
    throw new Error(`Unexpected fetch ${value}`);
  };
  await kv.put('custom-card:SN-1', 'image', { expirationTtl: 3600 });
  const response = await worker.fetch(request(body, token, '/custom-miro-to-jira'), env);
  assert.equal(response.status, 200);
  assert.ok(transitioned);
  assert.equal(logs.findLast(args => args[0] === 'Miro card movement')[1].actorName, 'Alice');
  const failingKv = { get: key => kv.get(key), put: async () => { throw new Error('KV unavailable'); } };
  assert.equal((await worker.fetch(request(body, token, '/custom-miro-to-jira'), { ...env, CARD_MAP: failingKv })).status, 200);

  // Exercise the rendered client: real positional changes carry modifier
  // metadata; metadata-only updates do not manufacture a movement. Moves
  // outside the workflow are still audited.
  const client = await renderAppClient(env).text();
  const instrumented = client.replace("await miro.board.ui.on('icon:click'", "globalThis.auditHooks={evaluate};return;await miro.board.ui.on('icon:click'");
  assert.notEqual(client, instrumented);
  let sdkItem = { id: 'image', type: 'image', title: 'CUSTOM_JIRA_CARD:SN-1', x: 3842, y: 1000, width: 189, height: 102, modifiedBy: 'mover', modifiedAt: now };
  const sent = [];
  const context = { console, setTimeout: callback => { callback(); return 1; }, Map, Set,
    miro: { board: { getById: async () => sdkItem, get: async () => [], getInfo: async () => ({ id: 'board' }), getIdToken: async () => 'viewer-token' } },
    fetch: async (path, init) => { sent.push({ path, body: JSON.parse(init.body) }); return json({ ok: true }); },
  };
  await runInNewContext(instrumented, context);
  const previous = { previousX: 4350, previousY: 1000, previousParentId: '' };
  await context.auditHooks.evaluate('image', previous, { modifiedBy: 'mover', modifiedAt: now });
  assert.equal(sent[0].path, '/custom-miro-to-jira');
  assert.equal(sent[0].body.movement.modifiedBy, 'mover');
  assert.equal(sent[0].body.movement.canvasX, 3842);
  sent.length = 0;
  await context.auditHooks.evaluate('image', { ...previous, previousX: 3842 });
  assert.equal(sent.length, 0);
  sdkItem = { ...sdkItem, x: 9000 };
  await context.auditHooks.evaluate('image', previous);
  assert.equal(sent[0].path, '/card-movement');
} finally {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
}
console.log('Movement and Jira status attribution verification passed.');
