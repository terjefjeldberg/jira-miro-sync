import assert from 'node:assert/strict';
import { moveMappedItemToStatus, patchItem } from '../src/miro.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const layout = { board: { left: 0, right: 4628, top: 0, bottom: 2611 }, columns: [
  { status: '3. Functional review', left: 2532, right: 2914, targetX: 2723 },
  { status: '4. Code review', left: 2914, right: 3279, targetX: 3096 },
] };
const oldFetch = globalThis.fetch, oldLog = console.log, oldError = console.error;
console.log = () => {}; console.error = () => {};
function setup(options = {}) {
  const values = new Map(), writes = [], requests = [];
  const frame = { id: 'workflow', type: 'frame', position: { x: -5000, y: -8000, relativeTo: 'canvas_center' }, geometry: { width: 4628, height: 2611 }, ...options.frame };
  let item = { id: 'image', type: 'image', data: { title: 'CUSTOM_JIRA_CARD:SN-1' }, parent: { id: 'workflow' },
    position: { x: 2723, y: 586.225, relativeTo: 'parent_top_left' }, geometry: { width: 189, height: 123 }, ...options.item };
  const env = { MIRO_BOARD_ID: 'board', MIRO_WORKFLOW_FRAME_ID: 'workflow', WORKFLOW_LAYOUT_JSON: JSON.stringify(layout),
    CARD_MAP: { get: async key => values.get(key), put: async (key, value) => values.set(key, value) } };
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url); requests.push(value);
    if (value.includes('/items?')) {
      assert.ok(value.includes('parent_item_id=workflow'));
      assert.ok(!value.includes('type=image')); // no board-wide image scan
      if (options.stale) item.position.x += 40;
      if (options.collisionError) return json({}, 500);
      return json({ data: options.others || [] });
    }
    if (value.endsWith('/frames/workflow')) return options.frameError ? json({}, 500) : json(frame);
    if (value.endsWith('/items/image') && init.method === 'PATCH') {
      const body = JSON.parse(init.body); writes.push(body);
      assert.equal(body.parent.id, 'workflow');
      assert.equal(body.position.relativeTo, 'parent_top_left');
      // Model the actual API default: local coordinates without relativeTo
      // become CANVAS coordinates and can throw a card far off its frame.
      const ref = options.wrongApiResponse ? 'canvas_center' : body.position.relativeTo || 'canvas_center';
      item = { ...item, parent: ref === 'canvas_center' ? null : body.parent, position: { ...body.position, relativeTo: ref } };
      return json(item);
    }
    if (value.endsWith('/images/image')) return json(item);
    throw new Error(`Unexpected request ${value}`);
  };
  return { env, writes, requests, values, item: () => item };
}
try {
  // Regression: frame is thousands of pixels from canvas origin. The card
  // must stay attached, land in Code review and retain its original Y.
  let test = setup();
  let result = await moveMappedItemToStatus(test.env, 'image', '4. Code review');
  assert.equal(result.verified, true);
  assert.equal(test.item().parent.id, 'workflow');
  assert.equal(test.item().position.x, 3096);
  assert.equal(test.item().position.y, 586.225);
  assert.ok(test.values.has('move-before:SN-1'));
  assert.ok(test.values.has('move-confirmed:SN-1'));
  assert.equal(test.writes.length, 1);
  assert.ok(test.requests.length <= 6);

  // Absolute canvas reads also become the same explicit local write.
  test = setup({ item: { parent: null, position: { x: -7314 + 2723, y: -9305.5 + 586.225, relativeTo: 'canvas_center' } } });
  result = await moveMappedItemToStatus(test.env, 'image', '4. Code review');
  assert.equal(result.verified, true);
  assert.ok(Math.abs(test.item().position.y - 586.225) < 0.001);

  // Fail closed for ambiguous reference, rotated/wrong frame, outside board,
  // stale reads and destinations that cannot fit the entire card.
  for (const options of [
    { item: { position: { x: 2723, y: 586.225 } } },
    { frame: { rotation: 15 } },
    { frame: { geometry: { width: 100, height: 100 } } },
    { item: { position: { x: 9000, y: 8000, relativeTo: 'canvas_center' }, parent: null } },
    { stale: true },
    { item: { position: { x: 2723, y: 10, relativeTo: 'parent_top_left' } } },
  ]) {
    test = setup(options);
    result = await moveMappedItemToStatus(test.env, 'image', '4. Code review');
    assert.equal(test.writes.length, 0, JSON.stringify(options));
    assert.notEqual(result.moved, true);
  }

  // A 200 with the wrong coordinates is NOT success. Block subsequent writes
  // to that image instead of letting reconciliation repeatedly fling it.
  test = setup({ wrongApiResponse: true });
  result = await moveMappedItemToStatus(test.env, 'image', '4. Code review');
  assert.equal(result.ok, false);
  assert.equal(result.quarantined, true);
  assert.ok(test.values.has('move-quarantine:image'));
  await moveMappedItemToStatus(test.env, 'image', '4. Code review');
  assert.equal(test.writes.length, 1);

  // Collision lookup failure cannot turn into unbounded board scans or Y
  // changes: use the safe destination in the correct column.
  test = setup({ collisionError: true });
  result = await moveMappedItemToStatus(test.env, 'image', '4. Code review');
  assert.equal(result.verified, true);
  assert.equal(test.item().position.y, 586.225);
  await assert.rejects(patchItem(test.env, 'image', { position: { x: 3096, y: 586 } }), /explicit coordinate reference/);
  test = setup({ frameError: true });
  result = await moveMappedItemToStatus(test.env, 'image', '4. Code review');
  assert.equal(result.verified, true);
  assert.equal(test.writes[0].position.relativeTo, 'parent_top_left');
  assert.equal(test.writes[0].parent.id, 'workflow');
} finally {
  globalThis.fetch = oldFetch; console.log = oldLog; console.error = oldError;
}
console.log('Safe coordinate references, read-back, quarantine and latency bounds verified.');
