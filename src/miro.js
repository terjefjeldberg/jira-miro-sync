import { config, customMapKey, normalizeIssueKey, normalizeStatus } from './config.js';

export const miroHeaders = env => ({ Authorization: `Bearer ${env.MIRO_TOKEN}`, Accept: 'application/json' });
const itemsBase = env => `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/items`;
const incomingFrameCache = new Map();
const INCOMING_FRAME_CACHE_TTL_MS = 30_000;

export async function getItem(env, itemId, { signal, type } = {}) {
  const base = type === 'image' || type === 'frame'
    ? `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/${type}s` : itemsBase(env);
  let response = await fetch(`${base}/${encodeURIComponent(itemId)}`, { headers: miroHeaders(env), signal: signal ?? AbortSignal.timeout(30000) });
  if ((type === 'frame' || type === 'image') && response.status >= 500 && !signal?.aborted) {
    await response.body?.cancel();
    response = await fetch(`${itemsBase(env)}/${encodeURIComponent(itemId)}`, { headers: miroHeaders(env), signal: signal ?? AbortSignal.timeout(30000) });
  }
  if (response.status === 404) return { ok: true, found: false };
  if (!response.ok) return { ok: false, found: true, status: response.status, error: await response.text() };
  return { ok: true, found: true, item: await response.json() };
}

export async function patchItem(env, itemId, body) {
  if (body.position && !['canvas_center', 'parent_top_left'].includes(body.position.relativeTo)) {
    throw new Error('Refusing Miro position write without an explicit coordinate reference');
  }
  return fetch(`${itemsBase(env)}/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers: { ...miroHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
}

export async function deleteImage(env, itemId) {
  const response = await fetch(`https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images/${encodeURIComponent(itemId)}`, { method: 'DELETE', headers: miroHeaders(env) });
  return response.ok || response.status === 404;
}

// Image-specific updates reject position.relativeTo. Resize/title updates and
// explicit parent-relative placement must use their respective API endpoints.
async function placeUploadedImage(env, itemId, placement) {
  if (placement.parent?.id) {
    const frame = await getItem(env, placement.parent.id, { type: 'frame' });
    if (!frame.ok || !frame.found) return { ok: false, status: frame.status || 502, text: async () => 'Placement frame is unavailable' };
    const width = Number(placement.geometry?.width ?? config(env).card.width), height = config(env).card.height;
    const { x, y } = placement.position;
    if (![x, y, width, height, frame.item.geometry?.width, frame.item.geometry?.height].every(Number.isFinite)
      || x - width / 2 < 0 || y - height / 2 < 0
      || x + width / 2 > frame.item.geometry.width || y + height / 2 > frame.item.geometry.height) {
      return { ok: false, status: 409, text: async () => 'Refusing placement outside target frame' };
    }
  }
  const metadata = await fetch(`https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images/${encodeURIComponent(itemId)}`, {
    method: 'PATCH', headers: { ...miroHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: placement.data, geometry: placement.geometry }), signal: AbortSignal.timeout(30000),
  });
  if (!metadata.ok) return metadata;
  return patchItem(env, itemId, { ...(placement.parent ? { parent: placement.parent } : {}), position: placement.position });
}

export async function uploadSvg(env, issueKey, svg, patch, title = `CUSTOM_JIRA_CARD:${issueKey}`, width = config(env).card.width) {
  const form = new FormData();
  form.append('resource', new Blob([new TextEncoder().encode(svg)], { type: 'image/svg+xml' }), `${issueKey}.svg`);
  form.append('data', JSON.stringify({ title }));
  if (env.MIRO_DELIVERY_STORAGE) await env.MIRO_DELIVERY_STORAGE.put('uploadStartedAt', Date.now());
  const upload = await fetch(`https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images`, { method: 'POST', headers: miroHeaders(env), body: form });
  if (!upload.ok) return { ok: false, status: 502, stage: 'miro-image-upload', miroStatus: upload.status, error: await upload.text() };
  const itemId = String((await upload.json())?.id ?? '').trim();
  if (!itemId) return { ok: false, status: 502, stage: 'miro-image-id', reason: 'Miro returned no image ID' };
  const placement = { data: { title: `CUSTOM_JIRA_CARD:${issueKey}` }, geometry: { width }, ...patch,
    position: { ...patch.position, relativeTo: patch.parent?.id ? 'parent_top_left' : 'canvas_center' } };
  // Keep the upload ID before placement: a Miro 5xx must not make the next
  // attempt upload another image or delete an image that may already exist.
  if (env.MIRO_DELIVERY_STORAGE) {
    await env.MIRO_DELIVERY_STORAGE.put('upload', { itemId, placement, positioned: false });
    await env.MIRO_DELIVERY_STORAGE.delete('uploadStartedAt');
  }
  const positioned = await placeUploadedImage(env, itemId, placement);
  if (!positioned.ok) {
    const error = await positioned.text();
    if (!env.MIRO_DELIVERY_STORAGE) await deleteImage(env, itemId).catch(() => {});
    return { ok: false, status: 502, stage: 'miro-image-position', miroStatus: positioned.status, error };
  }
  if (env.MIRO_DELIVERY_STORAGE) {
    await env.MIRO_DELIVERY_STORAGE.put('upload', { itemId, placement, positioned: true });
  }
  return { ok: true, itemId };
}

export async function replaceSvg(env, itemId, issueKey, svg, title = `CUSTOM_JIRA_CARD:${issueKey}`, width = config(env).card.width) {
  const form = new FormData();
  form.append('resource', new Blob([new TextEncoder().encode(svg)], { type: 'image/svg+xml' }), `${issueKey}.svg`);
  form.append('data', JSON.stringify({ title: `CUSTOM_JIRA_CARD:${issueKey}` }));
  const url = `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images/${encodeURIComponent(itemId)}`;
  const response = await fetch(url, { method: 'PATCH', headers: miroHeaders(env), body: form });
  if (!response.ok) return { ok: false, refreshed: false, stage: 'refresh-custom-card', miroStatus: response.status, error: await response.text() };

  const resized = await fetch(url, {
    method: 'PATCH',
    headers: { ...miroHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { title }, geometry: { width } }),
  });
  return resized.ok
    ? { ok: true, refreshed: true, resized: true }
    : { ok: false, refreshed: false, stage: 'resize-custom-card', miroStatus: resized.status, error: await resized.text() };
}
export async function listItems(env, params = {}, { signal } = {}) {
  const result = [];
  let cursor = '';
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(itemsBase(env));
    url.searchParams.set('limit', '50');
    for (const [key, value] of Object.entries(params)) if (value != null && value !== '') url.searchParams.set(key, String(value));
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, { headers: miroHeaders(env), signal });
    if (!response.ok) return { ok: false, status: response.status, error: await response.text(), items: result };
    const body = await response.json();
    result.push(...(Array.isArray(body?.data) ? body.data : []));
    cursor = String(body?.cursor ?? '').trim();
    if (!cursor) return { ok: true, items: result };
  }
  return { ok: false, status: 502, error: 'Miro item listing exceeded pagination limit', items: result };
}

export async function resumeCardUpload(env, issueKey) {
  const pending = await env.MIRO_DELIVERY_STORAGE?.get('upload');
  if (!pending) return { ok: true };
  const read = await getItem(env, pending.itemId, { type: 'image' });
  if (!read.ok) return { ok: false, stage: 'delivery-read-upload', miroStatus: read.status, error: read.error };
  if (!read.found) {
    // A successful upload can take time to become readable. Do not upload
    // another card while its known ID is still awaiting confirmation.
    const missingReads = (pending.missingReads || 0) + 1;
    await env.MIRO_DELIVERY_STORAGE.put('upload', { ...pending, missingReads });
    if (missingReads >= 3) {
      const listed = await listItems(env, { type: 'image' });
      if (!listed.ok) return { ok: false, stage: 'delivery-recheck-missing-upload', error: listed.error };
      const recovered = listed.items.find(item => issueKeyFromImage(item) === issueKey);
      if (recovered) {
        await env.MIRO_DELIVERY_STORAGE.put('upload', { ...pending, itemId: String(recovered.id), missingReads: 0, positioned: false });
      }
    }
    return { ok: false, stage: 'delivery-upload-not-visible', itemId: pending.itemId };
  }
  if (issueKeyFromImage(read.item) !== issueKey) return { ok: false, stage: 'delivery-upload-identity', itemId: pending.itemId };
  if (!pending.positioned) {
    pending.placement.position.relativeTo ??= pending.placement.parent?.id ? 'parent_top_left' : 'canvas_center';
    const response = await placeUploadedImage(env, pending.itemId, pending.placement);
    if (!response.ok) return { ok: false, stage: 'delivery-resume-position', miroStatus: response.status, error: await response.text() };
    await env.MIRO_DELIVERY_STORAGE.put('upload', { ...pending, positioned: true });
  }
  await env.CARD_MAP.put(customMapKey(issueKey), pending.itemId);
  return { ok: true, itemId: pending.itemId };
}

export async function resolveCanvasPosition(env, item, seen = new Set()) {
  const id = String(item?.id ?? '');
  if (id && seen.has(id)) return null;
  if (id) seen.add(id);
  const x = Number(item?.position?.x ?? item?.x);
  const y = Number(item?.position?.y ?? item?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const parentId = String(item?.parent?.id ?? item?.parentId ?? '').trim();
  const relativeTo = String(item?.position?.relativeTo ?? item?.relativeTo ?? (parentId ? '' : 'canvas_center'));
  if (!relativeTo) return null;
  if (!parentId || relativeTo === 'canvas_center') return { x, y };
  const parentRead = await getItem(env, parentId, { type: 'frame', signal: AbortSignal.timeout(5000) });
  if (!parentRead.ok || !parentRead.found) return null;
  const parent = parentRead.item;
  const parentCanvas = await resolveCanvasPosition(env, parent, seen);
  if (!parentCanvas) return null;
  if (relativeTo === 'parent_center') return { x: parentCanvas.x + x, y: parentCanvas.y + y };
  if (relativeTo === 'parent_top_left') {
    const width = Number(parent?.geometry?.width ?? parent?.width);
    const height = Number(parent?.geometry?.height ?? parent?.height);
    return Number.isFinite(width) && Number.isFinite(height) ? { x: parentCanvas.x - width / 2 + x, y: parentCanvas.y - height / 2 + y } : null;
  }
  return null;
}

function insideBoard(layout, x, y) {
  return Number.isFinite(x) && Number.isFinite(y) && x >= layout.board.left && x <= layout.board.right && y >= layout.board.top && y <= layout.board.bottom;
}

function overlap(centerX, width, column) {
  const left = centerX - width / 2;
  const right = centerX + width / 2;
  return Math.max(0, Math.min(right, column.right) - Math.max(left, column.left)) / width;
}

// All workflow writes use ONE explicit reference: the pinned frame's top left.
// Read coordinates are never sent back to Miro with an implicit reference.
const itemParent = item => String(item?.parent?.id ?? item?.parentId ?? '').trim();
const itemReference = item => String(item?.position?.relativeTo ?? item?.relativeTo ?? (itemParent(item) ? '' : 'canvas_center'));
const samePosition = (a, b) => itemParent(a) === itemParent(b) && itemReference(a) === itemReference(b)
  && Math.abs(Number(a?.position?.x) - Number(b?.position?.x)) <= 1
  && Math.abs(Number(a?.position?.y) - Number(b?.position?.y)) <= 1;
const failedFrameReads = new Map();

async function workflowFrame(env, item) {
  const cfg = config(env);
  const frameId = cfg.workflowFrameId || itemParent(item);
  if (!frameId) return { ok: false, stage: 'miro-workflow-frame-unknown', reason: 'No verified workflow frame; card was not moved' };
  // A confirmed child already supplies the pinned frame ID and local origin.
  // In that case a frame's absolute canvas offset is unnecessary. If Miro's
  // frame-detail endpoint is unavailable, retain local-space positioning using
  // the admin-configured bounds; never guess an absolute canvas offset.
  const canUsePinnedLocalSpace = cfg.workflowFrameId === frameId && itemParent(item) === frameId && itemReference(item) === 'parent_top_left';
  const localFrame = () => ({ ok: true, id: frameId, source: 'pinned-frame-local-space',
    frame: { geometry: { width: cfg.layout.board.right, height: cfg.layout.board.bottom } }, left: NaN, top: NaN });
  const cacheKey = `${env.MIRO_BOARD_ID}:${frameId}`;
  if (canUsePinnedLocalSpace && Date.now() - (failedFrameReads.get(cacheKey) || 0) < 30_000) return localFrame();
  const read = await getItem(env, frameId, { type: 'frame', signal: AbortSignal.timeout(5000) }).catch(() => ({ ok: false }));
  if (!read.ok || !read.found) {
    if (canUsePinnedLocalSpace && !read.ok) { failedFrameReads.set(cacheKey, Date.now()); return localFrame(); }
    return { ok: false, stage: 'miro-workflow-frame-read', miroStatus: read.status };
  }
  failedFrameReads.delete(cacheKey);
  const frame = read.item;
  const width = Number(frame?.geometry?.width), height = Number(frame?.geometry?.height);
  if (frame.type !== 'frame' || ![width, height].every(Number.isFinite)
    || width + 1 < cfg.layout.board.right || height + 1 < cfg.layout.board.bottom
    || Math.abs(Number(frame.rotation || 0)) > 0.01) {
    return { ok: false, stage: 'miro-workflow-frame-invalid', reason: 'Workflow frame geometry is unsafe; card was not moved' };
  }
  const canvas = await resolveCanvasPosition(env, frame);
  if (!canvas) return { ok: false, stage: 'miro-workflow-frame-position' };
  return { ok: true, id: frameId, frame, left: canvas.x - width / 2, top: canvas.y - height / 2 };
}

async function localPosition(env, item, frame) {
  const ref = itemReference(item);
  if (itemParent(item) === frame.id && ref === 'parent_top_left') return { x: Number(item.position.x), y: Number(item.position.y) };
  if (!['canvas_center', 'parent_top_left', 'parent_center'].includes(ref)) return null;
  const canvas = await resolveCanvasPosition(env, item);
  return canvas ? { x: canvas.x - frame.left, y: canvas.y - frame.top } : null;
}

async function clearHorizontalPosition(env, item, frame, target, y) {
  const cfg = config(env), width = Number(item.geometry.width), height = Number(item.geometry.height || cfg.card.height);
  // Only inspect this frame, with a hard time budget. Never scan every image
  // and then read every image's parent before a single status movement.
  let children;
  try { children = await listItems(env, { parent_item_id: frame.id }, { signal: AbortSignal.timeout(2000) }); }
  catch { return target.targetX; }
  if (!children.ok) return target.targetX;
  const others = children.items.filter(other => String(other.id) !== String(item.id)
    && itemParent(other) === frame.id && itemReference(other) === 'parent_top_left' && issueKeyFromImage(other));
  const valid = x => x - width / 2 >= 0 && x + width / 2 <= Number(frame.frame.geometry.width)
    && overlap(x, width, target) >= cfg.overlapThreshold;
  const free = x => !others.some(other => {
    const w = Number(other.geometry?.width), h = Number(other.geometry?.height || height);
    const dx = Math.max(0, Math.min(x + width / 2, Number(other.position?.x) + w / 2) - Math.max(x - width / 2, Number(other.position?.x) - w / 2));
    const dy = Math.max(0, Math.min(y + height / 2, Number(other.position?.y) + h / 2) - Math.max(y - height / 2, Number(other.position?.y) - h / 2));
    return dx * dy / (width * height) > 0.95;
  });
  for (let n = 0; n <= 24; n++) for (const sign of n ? [1, -1] : [1]) {
    const x = target.targetX + sign * n * 12;
    if (valid(x) && free(x)) return x;
  }
  return target.targetX;
}

async function writeWorkflowPosition(env, item, frame, target, x, y) {
  const cfg = config(env), width = Number(item.geometry.width), height = Number(item.geometry.height || cfg.card.height);
  if (!insideBoard(cfg.layout, x, y) || ![x, y, width, height].every(Number.isFinite)
    || x - width / 2 < 0 || x + width / 2 > Number(frame.frame.geometry.width)
    || y - height / 2 < 0 || y + height / 2 > Number(frame.frame.geometry.height)
    || overlap(x, width, target) < cfg.overlapThreshold) return { ok: false, stage: 'miro-unsafe-destination', moved: false };
  // Reject a stale plan if someone moved the card while reads were in flight.
  const fresh = await getItem(env, item.id, { type: 'image' });
  if (!fresh.ok || !fresh.found || !samePosition(item, fresh.item)) return { ok: false, stage: 'miro-move-stale-position', moved: false };
  const issueKey = issueKeyFromImage(item);
  const before = { itemId: String(item.id), parentId: itemParent(item), reference: itemReference(item), position: item.position, recordedAt: new Date().toISOString() };
  await env.CARD_MAP.put(`move-before:${issueKey}`, JSON.stringify(before));
  const patch = { parent: { id: frame.id }, position: { x, y, origin: 'center', relativeTo: 'parent_top_left' } };
  const response = await patchItem(env, item.id, patch);
  if (!response.ok) return { ok: false, stage: 'miro-move', miroStatus: response.status, error: await response.text() };
  const check = await getItem(env, item.id, { type: 'image' });
  if (!check.ok || !check.found) return { ok: false, stage: 'miro-move-verification-unavailable', itemId: String(item.id) };
  const actual = await localPosition(env, check.item, frame);
  if (issueKeyFromImage(check.item) !== issueKey || itemParent(check.item) !== frame.id || !actual
    || Math.abs(actual.x - x) > 1 || Math.abs(actual.y - y) > 1 || overlap(actual.x, width, target) < cfg.overlapThreshold) {
    await env.CARD_MAP.put(`move-quarantine:${item.id}`, JSON.stringify({ before, expected: patch, actual: check.item.position, parentId: itemParent(check.item) }));
    console.error('Miro position verification failed; automatic movement blocked', { issueKey, itemId: String(item.id), expected: patch, actual: check.item.position, actualParentId: itemParent(check.item) });
    return { ok: false, stage: 'miro-move-verification-failed', quarantined: true, itemId: String(item.id) };
  }
  const result = { ok: true, mapped: true, moved: true, verified: true, itemId: String(item.id), parentId: frame.id,
    toX: actual.x, yPreserved: actual.y, movementMode: 'parent-top-left-explicit' };
  await env.CARD_MAP.put(`move-confirmed:${issueKey}`, JSON.stringify({ ...result, status: target.status, verifiedAt: new Date().toISOString() }));
  console.log('Miro status position confirmed', { issueKey, ...result, status: target.status });
  return result;
}

export async function moveMappedItemToStatus(env, itemId, status) {
  const cfg = config(env);
  const target = cfg.layout.columns.find(column => normalizeStatus(column.status) === normalizeStatus(status));
  if (!target) return { ok: true, moved: false, ignored: true, reason: `Unapproved status: ${status}` };
  if (await env.CARD_MAP.get(`move-quarantine:${itemId}`)) return { ok: false, stage: 'miro-move-quarantined', moved: false };
  const read = await getItem(env, itemId, { type: 'image' });
  if (!read.ok) return { ok: false, stage: 'miro-read', miroStatus: read.status, error: read.error };
  if (!read.found) return { ok: true, mapped: false, moved: false, missing: true };
  const item = read.item;
  if (item.type !== 'image' || !issueKeyFromImage(item)) return { ok: true, mapped: false, moved: false, missing: true, unsupported: true };
  if (itemParent(item) === cfg.incomingFrameId) return { ok: true, mapped: true, moved: false, parked: true, reason: 'Incoming card requires manual placement' };
  const frame = await workflowFrame(env, item);
  if (!frame.ok) return frame;
  const position = await localPosition(env, item, frame);
  if (!position) return { ok: false, stage: 'miro-unknown-coordinate-reference', moved: false };
  if (!insideBoard(cfg.layout, position.x, position.y)) return { ok: true, mapped: true, moved: false, parked: true };
  const width = Number(item.geometry?.width);
  if (!Number.isFinite(width) || width <= 0) return { ok: false, stage: 'miro-geometry' };
  if (overlap(position.x, width, target) >= cfg.overlapThreshold) return { ok: true, mapped: true, moved: false, reason: 'Already in correct column' };
  const x = await clearHorizontalPosition(env, item, frame, target, position.y);
  return writeWorkflowPosition(env, item, frame, target, x, position.y);
}

export async function inspectMappedPosition(env, issueKey) {
  const itemId = await env.CARD_MAP.get(customMapKey(issueKey));
  const item = itemId ? await getItem(env, itemId, { type: 'image' }).catch(error => ({ ok: false, error: String(error) })) : null;
  const frame = item?.ok && item.found ? await workflowFrame(env, item.item).catch(error => ({ ok: false, error: String(error) })) : null;
  const result = { issueKey, itemId, item, frame, layout: config(env).layout, inspectedAt: new Date().toISOString() };
  await env.CARD_MAP.put(`position-inspection:${issueKey}`, JSON.stringify(result));
  console.log('Miro position inspection', result);
  return result;
}

export async function repairMappedPosition(env, issueKey, parentId, localY, expectedStatus) {
  const cfg = config(env);
  if (!cfg.workflowFrameId || parentId !== cfg.workflowFrameId || !Number.isFinite(localY)) return { ok: false, stage: 'repair-unverified-frame-or-row' };
  const itemId = await env.CARD_MAP.get(customMapKey(issueKey));
  const read = itemId ? await getItem(env, itemId, { type: 'image', signal: AbortSignal.timeout(10000) }) : null;
  if (!read?.ok || !read.found || issueKeyFromImage(read.item) !== issueKey) return { ok: false, stage: 'repair-card-identity' };
  const frame = await workflowFrame(env, read.item);
  if (!frame.ok) return frame;
  const target = cfg.layout.columns.find(column => normalizeStatus(column.status) === normalizeStatus(expectedStatus));
  if (!target) return { ok: false, stage: 'repair-unapproved-status' };
  const result = await writeWorkflowPosition(env, read.item, frame, target, target.targetX, localY);
  if (result.verified) await env.CARD_MAP.delete(`move-quarantine:${itemId}`);
  return result;
}

export async function registerMappings(env, entries) {
  const valid = entries.slice(0, 500).map(entry => ({ issueKey: normalizeIssueKey(entry.issueKey), itemId: String(entry.itemId ?? '').trim() })).filter(entry => entry.issueKey && entry.itemId);
  const accepted = [];
  for (const entry of valid) {
    const existing = String(await env.CARD_MAP.get(customMapKey(entry.issueKey)) ?? '').trim();
    if (existing && existing !== entry.itemId) continue;
    if (!existing) await env.CARD_MAP.put(customMapKey(entry.issueKey), entry.itemId);
    accepted.push({ ...entry, mappedItemId: existing || entry.itemId });
  }
  return accepted;
}

export function issueKeyFromImage(item) {
  const title = String(item?.data?.title ?? item?.title ?? '').trim();
  const match = title.match(/^CUSTOM_JIRA_CARD:([A-Z]+-\d+)$/i);
  return match ? normalizeIssueKey(match[1]) : null;
}

export async function removeOrphanDuplicate(env, issueKey, itemId, canonicalId) {
  const mapped = await env.CARD_MAP.get(customMapKey(issueKey));
  if (mapped !== canonicalId || itemId === canonicalId) return { ok: false, reason: 'Canonical mapping changed' };
  const [canonical, duplicate] = await Promise.all([getItem(env, canonicalId, { type: 'image' }), getItem(env, itemId, { type: 'image' })]);
  if (!canonical.ok || !canonical.found || issueKeyFromImage(canonical.item) !== issueKey || !canonical.item.parent?.id) return { ok: false, reason: 'Canonical card is not confirmed in a frame' };
  if (duplicate.ok && !duplicate.found) return { ok: true, alreadyAbsent: true, canonicalId, itemId };
  if (!duplicate.ok || issueKeyFromImage(duplicate.item) !== issueKey || duplicate.item.parent?.id
    || duplicate.item.position?.relativeTo !== 'canvas_center' || duplicate.item.position.x !== 0 || duplicate.item.position.y !== 0) return { ok: false, reason: 'Duplicate is not an orphan at canvas origin' };
  if (await env.CARD_MAP.get(customMapKey(issueKey)) !== canonicalId) return { ok: false, reason: 'Canonical mapping changed' };
  if (!await deleteImage(env, itemId)) return { ok: false, reason: 'Duplicate deletion failed' };
  const check = await getItem(env, itemId, { type: 'image' });
  return { ok: check.ok && !check.found, canonicalId, itemId, deleted: check.ok && !check.found,
    previousItem: duplicate.item, checkedAt: new Date().toISOString() };
}

export async function incomingPosition(env) {
  const cfg = config(env);
  const frameUrl = `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/frames/${encodeURIComponent(cfg.incomingFrameId)}`;
  const cacheKey = `${env.MIRO_BOARD_ID}:${cfg.incomingFrameId}`;
  const cached = incomingFrameCache.get(cacheKey);
  let frame = cached && Date.now() - cached.timestamp < INCOMING_FRAME_CACHE_TTL_MS ? cached.frame : null;
  let response = null;
  let lastError = '';
  if (!frame) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await fetch(frameUrl, { headers: miroHeaders(env) });
      if (response.ok) break;
      lastError = await response.text();
      if (response.status < 500 || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  // Miro occasionally returns a transient 5xx for an existing frame. Use a
  // safe local position inside the known Incoming frame instead of failing the
  // Jira webhook; the parent frame ID is still valid for the image upload.
  if (!frame && !response?.ok) {
    if (response?.status >= 500) {
      const i = cfg.incoming, c = cfg.card;
      return { ok: true, x: i.marginX + c.width / 2, y: i.marginY + c.height / 2, parentId: cfg.incomingFrameId, fallback: true, fallbackReason: 'incoming-frame-read-5xx' };
    }
    return { ok: false, status: 502, stage: 'incoming-read-frame', miroStatus: response?.status || 502, error: lastError };
  }

  if (!frame) {
    frame = await response.json();
    incomingFrameCache.set(cacheKey, { frame, timestamp: Date.now() });
  }
  const width = Number(frame?.geometry?.width), height = Number(frame?.geometry?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return { ok: false, status: 502, stage: 'incoming-frame-geometry', reason: 'Incoming frame has invalid geometry' };
  const children = await listItems(env, { parent_item_id: cfg.incomingFrameId });
  if (!children.ok) {
    if (children.status >= 500) {
      const i = cfg.incoming, c = cfg.card;
      return { ok: true, x: i.marginX + c.width / 2, y: i.marginY + c.height / 2, parentId: cfg.incomingFrameId, fallback: true, fallbackReason: 'incoming-children-list-5xx' };
    }
    return { ...children, status: 502, stage: 'incoming-list-children' };
  }
  const custom = children.items.filter(item => issueKeyFromImage(item));
  const i = cfg.incoming, c = cfg.card;
  const columns = Math.max(1, Math.floor((Math.max(c.width, width - i.marginX * 2) + i.gapX) / (c.width + i.gapX)));
  const rows = Math.max(1, Math.floor((Math.max(c.height, height - i.marginY * 2) + i.gapY) / (c.height + i.gapY)));
  const occupied = custom.map(item => ({ x: Number(item?.position?.x), y: Number(item?.position?.y) })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  for (let layer = 0; layer < i.maxLayers; layer += 1) for (let column = 0; column < columns; column += 1) for (let row = 0; row < rows; row += 1) {
    const x = i.marginX + c.width / 2 + column * (c.width + i.gapX) + layer * i.layerX;
    const y = i.marginY + c.height / 2 + row * (c.height + i.gapY) + layer * i.layerY;
    const inside = x - c.width / 2 >= 0 && x + c.width / 2 <= width && y - c.height / 2 >= 0 && y + c.height / 2 <= height;
    const used = occupied.some(p => Math.abs(p.x - x) <= 8 && Math.abs(p.y - y) <= 8);
    if (inside && !used) return { ok: true, x, y, parentId: cfg.incomingFrameId, row, column, layer };
  }
  return { ok: false, status: 409, stage: 'incoming-layout-full', reason: 'No free Incoming position found' };
}
