import assert from 'node:assert/strict';
import { MiroCardDelivery } from '../src/index.js';
import { createCard } from '../src/cards.js';
import { removeOrphanDuplicate } from '../src/miro.js';

class Storage {
  values = new Map(); alarm = null;
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
  async transaction(fn) { return fn(this); }
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const originalFetch = globalThis.fetch, originalLog = console.log;
console.log = () => {};
try {
  const storage = new Storage(), kv = new Storage();
  const env = { JIRA_PROJECT_KEY: 'SN', MIRO_BOARD_ID: 'board', JIRA_CLOUD_ID: 'cloud', CARD_MAP: kv };
  let image = null, uploads = 0;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.includes('/issue/SN-1?')) return json({ fields: { summary: 'Card', status: { name: '0. Backlog' } } });
    if (path.includes('/items?')) return json({ data: image ? [image] : [] });
    if (path.endsWith('/images') && init.method === 'POST') {
      uploads++; image = { id: 'one-image', type: 'image', data: { title: 'CUSTOM_JIRA_CARD:SN-1' }, geometry: { width: 189, height: 102 }, position: { x: 0, y: 0, relativeTo: 'canvas_center' } };
      return json({ id: image.id });
    }
    if (path.endsWith('/images/one-image') && init.method === 'PATCH') {
      const patch = JSON.parse(init.body);
      image = { ...image, ...patch, geometry: { ...image.geometry, ...patch.geometry } }; return json(image);
    }
    if (path.endsWith('/items/one-image') && init.method === 'PATCH') {
      image = { ...image, ...JSON.parse(init.body) }; return json(image);
    }
    if (path.endsWith('/images/one-image')) return image ? json(image) : json({}, 404);
    throw new Error(`Unexpected request ${path}`);
  };
  let delivery = new MiroCardDelivery({ storage }, env);
  const direct = () => new Request('https://delivery/direct', { method: 'POST', body: JSON.stringify({ issueKey: 'SN-1', x: -3000, y: -7000 }) });
  const creation = () => new Request('https://delivery/ensure', { method: 'POST', body: JSON.stringify({ issueKey: 'SN-1', event: 'created', changedFields: ['status'] }) });
  // Two direct retries race a Jira creation webhook. All share one serializer.
  const results = await Promise.all([delivery.fetch(direct()), delivery.fetch(direct()), delivery.fetch(creation())]);
  assert.deepEqual(results.map(result => result.status), [200, 200, 202]);
  await delivery.alarm();
  assert.equal((await storage.get('confirmed')).itemId, 'one-image');
  assert.equal(uploads, 1);
  assert.equal(await kv.get('custom-card:SN-1'), 'one-image');
  assert.equal(image.position.x, -3000);
  // Restart and retry: mapping survives, no second upload.
  delivery = new MiroCardDelivery({ storage }, env);
  assert.equal((await delivery.fetch(direct())).status, 200);
  assert.equal(uploads, 1);
  image = null;
  assert.equal((await delivery.fetch(direct())).status, 502);
  assert.equal(uploads, 1);
  assert.equal(await kv.get('custom-card:SN-1'), 'one-image');

  // A lost POST response cannot authorize a second POST after an empty scan.
  const ambiguous = new Storage();
  await ambiguous.put('uploadStartedAt', Date.now() - 120000);
  globalThis.fetch = async (url, init = {}) => {
    assert.notEqual(init.method, 'POST');
    assert.ok(String(url).includes('/items?')); return json({ data: [] });
  };
  const uncertain = await createCard({ ...env, CARD_MAP: new Storage(), MIRO_DELIVERY_STORAGE: ambiguous }, 'SN-2', { x: 100, y: 100 });
  assert.equal(uncertain.stage, 'delivery-ambiguous-upload');
  assert.ok(await ambiguous.get('uploadStartedAt'));

  // Cleanup can only delete the identified, unmapped orphan at canvas zero.
  await kv.put('custom-card:SN-1', 'canonical');
  const canonical = { id: 'canonical', type: 'image', data: { title: 'CUSTOM_JIRA_CARD:SN-1' }, parent: { id: 'workflow' } };
  let orphan = { id: 'orphan', type: 'image', data: { title: 'CUSTOM_JIRA_CARD:SN-1' }, position: { x: 0, y: 0, relativeTo: 'canvas_center' } };
  let deletes = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'DELETE') { assert.ok(String(url).endsWith('/images/orphan')); deletes++; orphan = null; return json({}); }
    return String(url).endsWith('/images/canonical') ? json(canonical) : orphan ? json(orphan) : json({}, 404);
  };
  assert.equal((await removeOrphanDuplicate(env, 'SN-1', 'canonical', 'canonical')).ok, false);
  orphan.position.x = 10;
  assert.equal((await removeOrphanDuplicate(env, 'SN-1', 'orphan', 'canonical')).ok, false);
  assert.equal(deletes, 0);
  orphan.position.x = 0;
  const removed = await removeOrphanDuplicate(env, 'SN-1', 'orphan', 'canonical');
  assert.equal(removed.deleted, true);
  assert.equal(deletes, 1);
  assert.equal(await kv.get('custom-card:SN-1'), 'canonical');
} finally { globalThis.fetch = originalFetch; console.log = originalLog; }
console.log('Shared creation serialization, ambiguous-upload retention and guarded duplicate cleanup verified.');
