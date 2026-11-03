import assert from 'node:assert/strict';
import worker, { MiroCardDelivery } from '../src/index.js';
import { customMapKey } from '../src/config.js';
import { getItem, resumeCardUpload, uploadSvg, listItems } from '../src/miro.js';

class Storage {
  values = new Map();
  alarm = null;
  async get(key, type) {
    const value = structuredClone(this.values.get(key));
    return type === 'json' && typeof value === 'string' ? JSON.parse(value) : value;
  }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
  async transaction(action) { return action(this); }
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const body = { issueKey: 'SN-1', event: 'ensure_card', changedFields: ['status'] };
const item = { id: 'image-1', type: 'image', data: { title: 'CUSTOM_JIRA_CARD:SN-1' }, position: { x: 100, y: 100 }, geometry: { width: 189, height: 102 }, parent: { id: 'incoming' } };
const base = { JIRA_PROJECT_KEY: 'SN', JIRA_CLOUD_ID: 'cloud', MIRO_BOARD_ID: 'board', MIRO_INCOMING_FRAME_ID: 'incoming', JIRA_WEBHOOK_SECRET: 'secret' };
const ensure = () => new Request('https://delivery/ensure', { method: 'POST', body: JSON.stringify(body) });
const originalFetch = globalThis.fetch;
const originalLog = console.log, originalError = console.error;
const logs = [];
console.log = (...args) => logs.push(args);
console.error = (...args) => logs.push(args);

try {
  // Reproduce the incident: Backlog is ignored by movement, but a stored ID
  // does not prove that the image exists. Eight 500s exceed the old retry cap.
  const storage = new Storage(), kv = new Storage();
  await kv.put(customMapKey('SN-1'), 'image-1');
  const env = { ...base, CARD_MAP: kv };
  let readFailures = 8, imageReads = 0;
  globalThis.fetch = async url => {
    if (String(url).includes('/issue/SN-1?')) return json({ fields: { summary: 'Card', status: { name: '0. Backlog' }, issuetype: { name: 'Bug' } } });
    if (String(url).endsWith('/images/image-1')) {
      imageReads++;
      return readFailures-- > 0 ? json({ message: 'Internal error occurred' }, 500) : json(item);
    }
    throw new Error(`Unexpected request ${url}`);
  };
  let delivery = new MiroCardDelivery({ storage }, env);
  const accepted = await delivery.fetch(ensure());
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).confirmed, false);
  for (let n = 0; n < 8; n++) {
    // Simulate eviction/restart between every failed attempt.
    delivery = new MiroCardDelivery({ storage }, env);
    await delivery.alarm();
    assert.equal((await storage.get('job')).attempts, n + 1);
    assert.ok(await storage.getAlarm());
    assert.equal(await storage.get('confirmed'), undefined);
  }
  await delivery.alarm();
  assert.equal(await storage.get('job'), undefined);
  assert.equal(await storage.getAlarm(), null);
  assert.equal((await storage.get('confirmed')).itemId, 'image-1');
  assert.equal(imageReads, 9);
  assert.equal(logs.filter(args => args[0] === 'Miro card delivery confirmed').length, 1);

  // A new duplicate request is persisted but cannot complete based on the old
  // receipt. Concurrent requests coalesce to the same job and alarm.
  await Promise.all([delivery.fetch(ensure()), delivery.fetch(ensure())]);
  assert.equal((await storage.get('job')).attempts, 0);
  globalThis.fetch = async url => String(url).includes('/issue/')
    ? json({ fields: { status: { name: '0. Backlog' } } }) : json({}, 404);
  await delivery.alarm();
  assert.ok(await storage.get('job'));
  assert.equal(await kv.get(customMapKey('SN-1')), 'image-1');

  // Upload succeeds, placement fails. Persist its ID and repair that image
  // after a restart; never delete it or POST a second image.
  const uploadStorage = new Storage();
  const uploadEnv = { ...base, CARD_MAP: new Storage(), MIRO_DELIVERY_STORAGE: uploadStorage };
  let uploads = 0, deletes = 0, patchFailures = 1;
  const placement = { position: { x: 100, y: 100 }, parent: { id: 'incoming' } };
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/frames/incoming')) return json({ geometry: { width: 1200, height: 1200 } });
    if (init.method === 'DELETE') { deletes++; return json({}); }
    if (init.method === 'POST') { uploads++; return json({ id: 'image-1' }); }
    if (init.method === 'PATCH') return json({}, patchFailures-- > 0 ? 500 : 200);
    return json(item);
  };
  assert.equal((await uploadSvg(uploadEnv, 'SN-1', '<svg/>', placement)).ok, false);
  assert.equal((await uploadStorage.get('upload')).itemId, 'image-1');
  assert.equal((await resumeCardUpload(uploadEnv, 'SN-1')).ok, true);
  assert.equal(await uploadEnv.CARD_MAP.get(customMapKey('SN-1')), 'image-1');
  assert.equal(uploads, 1);
  assert.equal(deletes, 0);

  // Missing known upload: even repeated 404s and an empty listing cannot
  // prove that an accepted upload will never become visible. Retain its ID.
  globalThis.fetch = async url => String(url).includes('/items?') ? json({ data: [] }) : json({}, 404);
  for (let n = 0; n < 3; n++) assert.equal((await resumeCardUpload(uploadEnv, 'SN-1')).ok, false);
  assert.equal((await uploadStorage.get('upload')).itemId, 'image-1');
  assert.equal(await uploadEnv.CARD_MAP.get(customMapKey('SN-1')), 'image-1');

  // An incomplete scan must never authorize a replacement upload.
  globalThis.fetch = async () => json({ data: [], cursor: 'more' });
  assert.equal((await listItems(base, { type: 'image' })).ok, false);

  // Full fresh delivery: first placement fails; a new object instance repairs
  // the saved image and confirms it, with exactly one upload across attempts.
  const freshStorage = new Storage(), freshKv = new Storage();
  const freshEnv = { ...base, MIRO_BOARD_ID: 'fresh-board', CARD_MAP: freshKv };
  let freshItem = null, freshUploads = 0, freshPatches = 0;
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/issue/SN-1?')) return json({ fields: { summary: 'New card', status: { name: '0. Backlog' }, issuetype: { name: 'Bug' } } });
    if (value.endsWith('/frames/incoming')) return json({ geometry: { width: 1200, height: 1200 } });
    if (value.includes('/items?')) return json({ data: freshItem ? [freshItem] : [] });
    if (value.endsWith('/images') && init.method === 'POST') {
      freshUploads++;
      freshItem = { ...structuredClone(item), parent: null, position: { x: 0, y: 0 } };
      return json({ id: freshItem.id });
    }
    if (value.endsWith('/images/image-1') && init.method === 'PATCH') {
      const patch = JSON.parse(init.body);
      // Reproduce the real API's 400: image updates do not accept relativeTo.
      assert.equal(patch.position, undefined);
      assert.equal(patch.parent, undefined);
      if (freshPatches++ === 0) return json({ message: 'Internal error occurred' }, 500);
      freshItem = { ...freshItem, ...patch, type: 'image', geometry: { ...freshItem.geometry, ...patch.geometry } };
      return json(freshItem);
    }
    if (value.endsWith('/items/image-1') && init.method === 'PATCH') {
      const patch = JSON.parse(init.body);
      assert.equal(patch.position.relativeTo, 'parent_top_left');
      assert.equal(patch.parent.id, 'incoming');
      assert.equal(patch.geometry, undefined);
      assert.equal(patch.data, undefined);
      freshItem = { ...freshItem, ...patch }; return json(freshItem);
    }
    if (value.endsWith('/images/image-1')) return json(freshItem);
    throw new Error(`Unexpected fresh delivery request ${value}`);
  };
  let fresh = new MiroCardDelivery({ storage: freshStorage }, freshEnv);
  await fresh.fetch(ensure());
  await fresh.alarm();
  assert.equal((await freshStorage.get('upload')).positioned, false);
  assert.ok(await freshStorage.get('job'));
  fresh = new MiroCardDelivery({ storage: freshStorage }, freshEnv);
  await fresh.alarm();
  assert.equal((await freshStorage.get('confirmed')).itemId, 'image-1');
  assert.equal(freshUploads, 1);
  assert.equal(freshItem.parent.id, 'incoming');
  assert.equal(freshItem.position.relativeTo, 'parent_top_left');

  // Matching numeric coordinates with a canvas reference are not proof of
  // Incoming placement, even when the parent ID happens to match.
  const verifiedPosition = structuredClone(freshItem.position);
  await freshStorage.put('upload', { itemId: 'image-1', positioned: true, placement: { parent: { id: 'incoming' }, position: verifiedPosition } });
  freshItem.position.relativeTo = 'canvas_center';
  await fresh.fetch(ensure()); await fresh.alarm();
  assert.ok(await freshStorage.get('job'));
  assert.equal((await freshStorage.get('upload')).positioned, false);
  freshItem.position = verifiedPosition;
  // An out-of-frame saved destination must not be written on retry.
  await freshStorage.put('upload', { itemId: 'image-1', positioned: false, placement: { parent: { id: 'incoming' }, position: { x: 5000, y: 100, relativeTo: 'parent_top_left' } } });
  assert.equal((await resumeCardUpload(fresh.env, 'SN-1')).ok, false);
  assert.deepEqual(freshItem.position, verifiedPosition);

  // Miro acknowledging a PATCH is insufficient if read-back disagrees.
  await freshStorage.put('upload', { itemId: 'image-1', positioned: true, placement: { parent: { id: 'incoming' }, position: { x: 999, y: 999 } } });
  await fresh.fetch(ensure());
  await fresh.alarm();
  assert.ok(await freshStorage.get('job'));
  assert.equal((await freshStorage.get('upload')).positioned, false);

  // HTTP acceptance is returned only AFTER the durable job is stored. A
  // missing binding or storage outage must be visible to Jira as a failure.
  let scheduled = false;
  const webhook = () => new Request('https://worker/', { method: 'POST', headers: { 'X-Webhook-Secret': 'secret' }, body: JSON.stringify(body) });
  assert.equal((await worker.fetch(webhook(), { ...base, CARD_MAP: kv })).status, 503);
  const namespace = { idFromName: name => { assert.equal(name, 'board:SN-1'); return name; }, get: () => ({ fetch: async request => { scheduled = true; return delivery.fetch(request); } }) };
  assert.equal((await worker.fetch(webhook(), { ...env, MIRO_CARD_DELIVERY: namespace })).status, 202);
  assert.ok(scheduled);
  assert.ok(await storage.get('job'));

  // A thrown network request is also kept pending, including after eviction.
  globalThis.fetch = async () => { throw new Error('network disconnected'); };
  delivery = new MiroCardDelivery({ storage }, env);
  await delivery.alarm();
  assert.ok(await storage.get('job'));
  assert.ok(await storage.getAlarm());

  // Status placement survives more failures than the Queue's retry budget,
  // plus eviction. An obsolete webhook must use the CURRENT Jira status.
  const statusStorage = new Storage(), statusKv = new Storage();
  await statusKv.put(customMapKey('SN-1'), 'image-1');
  const statusLayout = { board: { left: 0, right: 4600, top: 0, bottom: 2600 }, columns: [
    { status: 'Todo', left: 700, right: 1800, targetX: 1250 },
    { status: 'Functional review', left: 2500, right: 2900, targetX: 2700 },
  ] };
  const statusEnv = { ...base, CARD_MAP: statusKv, MIRO_WORKFLOW_FRAME_ID: 'workflow', WORKFLOW_LAYOUT_JSON: JSON.stringify(statusLayout) };
  let liveStatus = 'Functional review', statusFailures = 8, statusPatches = 0;
  let statusItem = { ...structuredClone(item), parent: { id: 'workflow' }, position: { x: 1250, y: 1100, relativeTo: 'parent_top_left' } };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.includes('/changelog')) return json({ values: [] });
    if (path.includes('/issue/SN-1?')) return json({ fields: { status: { name: liveStatus } } });
    if (path.endsWith('/images/image-1')) {
      if (statusFailures-- > 0) throw new DOMException('Timed out', 'TimeoutError');
      return json(statusItem);
    }
    if (path.endsWith('/frames/workflow')) return json({ id: 'workflow', type: 'frame', geometry: { width: 4600, height: 2600 }, position: { x: -5000, y: -8000, relativeTo: 'canvas_center' } });
    if (path.includes('/items?')) return json({ data: [] });
    if (path.endsWith('/items/image-1') && init.method === 'PATCH') {
      statusPatches++; statusItem = { ...statusItem, ...JSON.parse(init.body) }; return json(statusItem);
    }
    throw new Error(`Unexpected status request ${path}`);
  };
  const requestStatus = (status = 'Todo') => new Request('https://delivery/ensure-status', { method: 'POST', body: JSON.stringify({ issueKey: 'SN-1', status, changedFields: ['status'] }) });
  let statusDelivery = new MiroCardDelivery({ storage: statusStorage }, statusEnv);
  assert.equal((await statusDelivery.fetch(requestStatus())).status, 202);
  for (let n = 0; n < 8; n++) {
    statusDelivery = new MiroCardDelivery({ storage: statusStorage }, statusEnv);
    await statusDelivery.alarm();
    assert.ok(await statusStorage.get('job'));
    assert.ok(await statusStorage.getAlarm());
    assert.equal(statusPatches, 0);
  }
  await statusDelivery.alarm();
  assert.equal((await statusStorage.get('confirmed')).verified, true);
  assert.equal(statusItem.position.x, 2700);
  assert.equal(statusItem.position.y, 1100);
  assert.equal(statusPatches, 1);
  assert.equal(await statusStorage.get('job'), undefined);
  // Repeating the notification verifies the existing placement without PATCH.
  await statusDelivery.fetch(requestStatus()); await statusDelivery.alarm();
  assert.equal(statusPatches, 1);
  assert.equal((await statusStorage.get('confirmed')).verified, true);
  // Jira read failures must not fall back to the webhook's obsolete status.
  globalThis.fetch = async () => json({}, 503);
  await statusDelivery.fetch(requestStatus()); await statusDelivery.alarm();
  assert.ok(await statusStorage.get('job'));
  // Typed Miro endpoints can fail independently; generic GET is read-only
  // and supplies the same identity/position evidence for verification.
  const fallbackReads = [];
  globalThis.fetch = async url => {
    fallbackReads.push(String(url));
    return String(url).includes('/items/') ? json(statusItem) : json({ error: 'Internal error occurred' }, 500);
  };
  assert.equal((await getItem(statusEnv, 'image-1', { type: 'image' })).item.id, 'image-1');
  assert.equal(fallbackReads.length, 2);
} finally {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
}
console.log('Persistent Miro delivery verification passed.');
