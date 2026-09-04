import { config, customMapKey, normalizeIssueKey, normalizeStatus } from './config.js';

export const miroHeaders = env => ({ Authorization: `Bearer ${env.MIRO_TOKEN}`, Accept: 'application/json' });
const itemsBase = env => `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/items`;

export async function getItem(env, itemId) {
  const response = await fetch(`${itemsBase(env)}/${encodeURIComponent(itemId)}`, { headers: miroHeaders(env) });
  if (response.status === 404) return { ok: true, found: false };
  if (!response.ok) return { ok: false, found: true, status: response.status, error: await response.text() };
  return { ok: true, found: true, item: await response.json() };
}

export async function patchItem(env, itemId, body) {
  return fetch(`${itemsBase(env)}/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers: { ...miroHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function deleteImage(env, itemId) {
  const response = await fetch(`https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images/${encodeURIComponent(itemId)}`, { method: 'DELETE', headers: miroHeaders(env) });
  return response.ok || response.status === 404;
}

export async function uploadSvg(env, issueKey, svg, patch) {
  const form = new FormData();
  form.append('resource', new Blob([new TextEncoder().encode(svg)], { type: 'image/svg+xml' }), `${issueKey}.svg`);
  form.append('data', JSON.stringify({ title: `CUSTOM_JIRA_CARD:${issueKey}` }));
  const upload = await fetch(`https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images`, { method: 'POST', headers: miroHeaders(env), body: form });
  if (!upload.ok) return { ok: false, status: 502, stage: 'miro-image-upload', miroStatus: upload.status, error: await upload.text() };
  const itemId = String((await upload.json())?.id ?? '').trim();
  if (!itemId) return { ok: false, status: 502, stage: 'miro-image-id', reason: 'Miro returned no image ID' };
  const positioned = await fetch(`https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers: { ...miroHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { title: `CUSTOM_JIRA_CARD:${issueKey}` }, geometry: { width: config(env).card.width }, ...patch }),
  });
  if (!positioned.ok) {
    const error = await positioned.text();
    await deleteImage(env, itemId).catch(() => {});
    return { ok: false, status: 502, stage: 'miro-image-position', miroStatus: positioned.status, error };
  }
  return { ok: true, itemId };
}

export async function replaceSvg(env, itemId, issueKey, svg) {
  const form = new FormData();
  form.append('resource', new Blob([new TextEncoder().encode(svg)], { type: 'image/svg+xml' }), `${issueKey}.svg`);
  form.append('data', JSON.stringify({ title: `CUSTOM_JIRA_CARD:${issueKey}` }));
  const url = `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images/${encodeURIComponent(itemId)}`;
  const response = await fetch(url, { method: 'PATCH', headers: miroHeaders(env), body: form });
  if (!response.ok) return { ok: false, refreshed: false, stage: 'refresh-custom-card', miroStatus: response.status, error: await response.text() };

  const resized = await fetch(url, {
    method: 'PATCH',
    headers: { ...miroHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { title: `CUSTOM_JIRA_CARD:${issueKey}` }, geometry: { width: config(env).card.width } }),
  });
  return resized.ok
    ? { ok: true, refreshed: true, resized: true }
    : { ok: false, refreshed: false, stage: 'resize-custom-card', miroStatus: resized.status, error: await resized.text() };
}
export async function listItems(env, params = {}) {
  const result = [];
  let cursor = '';
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(itemsBase(env));
    url.searchParams.set('limit', '50');
    for (const [key, value] of Object.entries(params)) if (value != null && value !== '') url.searchParams.set(key, String(value));
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, { headers: miroHeaders(env) });
    if (!response.ok) return { ok: false, status: response.status, error: await response.text(), items: result };
    const body = await response.json();
    result.push(...(Array.isArray(body?.data) ? body.data : []));
    cursor = String(body?.cursor ?? '').trim();
    if (!cursor) break;
  }
  return { ok: true, items: result };
}

export async function resolveCanvasPosition(env, item, seen = new Set()) {
  const id = String(item?.id ?? '');
  if (id && seen.has(id)) return null;
  if (id) seen.add(id);
  const x = Number(item?.position?.x ?? item?.x);
  const y = Number(item?.position?.y ?? item?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const relativeTo = String(item?.position?.relativeTo ?? item?.relativeTo ?? 'canvas_center');
  const parentId = String(item?.parent?.id ?? item?.parentId ?? '').trim();
  if (!parentId || relativeTo === 'canvas_center') return { x, y };
  const parentRead = await getItem(env, parentId);
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

const COLLISION_OVERLAP_LIMIT = 0.95;
const COLLISION_STEP = 12;
const COLLISION_OFFSETS = [
  { x: 0, y: 0 },
  { x: COLLISION_STEP, y: COLLISION_STEP },
  { x: -COLLISION_STEP, y: COLLISION_STEP },
  { x: COLLISION_STEP, y: -COLLISION_STEP },
  { x: -COLLISION_STEP, y: -COLLISION_STEP },
  { x: 0, y: COLLISION_STEP },
  { x: 0, y: -COLLISION_STEP },
];

function nearlyFullyOverlaps(a, b) {
  const aLeft = a.x - a.width / 2, aRight = a.x + a.width / 2;
  const aTop = a.y - a.height / 2, aBottom = a.y + a.height / 2;
  const bLeft = b.x - b.width / 2, bRight = b.x + b.width / 2;
  const bTop = b.y - b.height / 2, bBottom = b.y + b.height / 2;
  const intersection = Math.max(0, Math.min(aRight, bRight) - Math.max(aLeft, bLeft))
    * Math.max(0, Math.min(aBottom, bBottom) - Math.max(aTop, bTop));
  return intersection / (a.width * a.height) > COLLISION_OVERLAP_LIMIT;
}

async function collisionFreePosition(env, item, base, target, mode) {
  const cfg = config(env);
  const width = Number(item?.geometry?.width ?? item?.width);
  const height = Number(item?.geometry?.height ?? item?.height);
  if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) return { ...base, adjusted: false };

  const others = [];
  if (mode === 'parent-local') {
    const parentId = String(item?.parent?.id ?? item?.parentId ?? '');
    // Miro's REST API can ignore parent_item_id when combined with type.
    // Fetch images first and filter by parent locally so collisions are reliable.
    const listed = await listItems(env, { type: 'image' });
    if (!listed.ok) return { ...base, adjusted: false };
    for (const other of listed.items) {
      const otherParentId = String(other?.parent?.id ?? other?.parentId ?? '');
      if (otherParentId !== parentId || String(other?.id) === String(item?.id) || !issueKeyFromImage(other)) continue;
      const x = Number(other?.position?.x ?? other?.x), y = Number(other?.position?.y ?? other?.y);
      const w = Number(other?.geometry?.width ?? other?.width), h = Number(other?.geometry?.height ?? other?.height);
      if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) others.push({ x, y, width: w, height: h });
    }
  } else {
    const listed = await listItems(env, { type: 'image' });
    if (!listed.ok) return { ...base, adjusted: false };
    for (const other of listed.items) {
      if (String(other?.id) === String(item?.id) || !issueKeyFromImage(other)) continue;
      const position = await resolveCanvasPosition(env, other);
      const w = Number(other?.geometry?.width ?? other?.width), h = Number(other?.geometry?.height ?? other?.height);
      if (position && [w, h].every(Number.isFinite) && w > 0 && h > 0) others.push({ x: position.x, y: position.y, width: w, height: h });
    }
  }

  const isValid = candidate => {
    const localX = mode === 'parent-local' ? candidate.x : candidate.x - base.frameLeft;
    const localY = mode === 'parent-local' ? candidate.y : candidate.y - base.frameTop;
    return insideBoard(cfg.layout, localX, localY) && overlap(localX, width, target) >= cfg.overlapThreshold;
  };
  const collides = candidate => others.some(other => nearlyFullyOverlaps({ x: candidate.x, y: candidate.y, width, height }, other));
  const normal = { x: base.x, y: base.y };
  if (isValid(normal) && !collides(normal)) return { ...base, adjusted: false };
  for (const offset of COLLISION_OFFSETS.slice(1)) {
    const candidate = { x: base.x + offset.x, y: base.y + offset.y };
    if (isValid(candidate) && !collides(candidate)) return { ...base, ...candidate, adjusted: true, offset };
  }
  return { ...base, adjusted: false };
}

async function findWorkflowFrame(env, canvasX, canvasY) {
  const cfg = config(env);
  const frames = await listItems(env, { type: 'frame' });
  if (!frames.ok) return null;
  return frames.items.map(frame => {
    const x = Number(frame?.position?.x), y = Number(frame?.position?.y), width = Number(frame?.geometry?.width), height = Number(frame?.geometry?.height);
    if (![x, y, width, height].every(Number.isFinite) || width < cfg.layout.board.right || height < cfg.layout.board.bottom) return null;
    const left = x - width / 2, top = y - height / 2;
    const localX = canvasX - left, localY = canvasY - top;
    return insideBoard(cfg.layout, localX, localY) ? { frame, left, top, localX, localY, area: width * height } : null;
  }).filter(Boolean).sort((a, b) => a.area - b.area)[0] || null;
}

export async function moveMappedItemToStatus(env, itemId, status) {
  const cfg = config(env);
  const target = cfg.layout.columns.find(column => normalizeStatus(column.status) === normalizeStatus(status));
  if (!target) return { ok: true, moved: false, ignored: true, reason: `Unapproved status: ${status}` };
  const read = await getItem(env, itemId);
  if (!read.ok) return { ok: false, stage: 'miro-read', miroStatus: read.status, error: read.error };
  if (!read.found) return { ok: true, mapped: false, moved: false, missing: true };
  const item = read.item;
  if (String(item?.type ?? '') !== 'image' || !issueKeyFromImage(item)) return { ok: true, mapped: false, moved: false, missing: true, unsupported: true };

  const width = Number(item?.geometry?.width ?? item?.width);
  const rawX = Number(item?.position?.x ?? item?.x), rawY = Number(item?.position?.y ?? item?.y);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(rawX) || !Number.isFinite(rawY)) return { ok: false, stage: 'miro-geometry', reason: 'Invalid Miro item geometry' };

  const relativeTo = String(item?.position?.relativeTo ?? item?.relativeTo ?? 'canvas_center');
  const parentId = String(item?.parent?.id ?? item?.parentId ?? '').trim();
  if (parentId && relativeTo.startsWith('parent_')) {
    const parentRead = await getItem(env, parentId);
    const parent = parentRead?.item;
    const parentWidth = Number(parent?.geometry?.width), parentHeight = Number(parent?.geometry?.height);
    if (parentRead.ok && parentRead.found && Number.isFinite(parentWidth) && Number.isFinite(parentHeight) && parentWidth >= cfg.layout.board.right && parentHeight >= cfg.layout.board.bottom && insideBoard(cfg.layout, rawX, rawY)) {
      if (overlap(rawX, width, target) >= cfg.overlapThreshold) return { ok: true, mapped: true, moved: false, reason: 'Already in correct column' };
      const placement = await collisionFreePosition(env, item, { x: target.targetX, y: rawY }, target, 'parent-local');
      const response = await patchItem(env, itemId, { position: { x: placement.x, y: placement.y, origin: 'center' } });
      return response.ok ? { ok: true, mapped: true, moved: true, itemId, fromX: rawX, toX: placement.x, yPreserved: placement.y, movementMode: 'parent-local', collisionAdjusted: placement.adjusted, collisionOffset: placement.offset || null } : { ok: false, stage: 'miro-move', miroStatus: response.status, error: await response.text() };
    }
  }

  const canvas = await resolveCanvasPosition(env, item);
  if (!canvas) return { ok: false, stage: 'miro-resolve-position', reason: 'Could not resolve canvas position' };
  const frame = await findWorkflowFrame(env, canvas.x, canvas.y);
  if (!frame) return { ok: true, mapped: true, moved: false, parked: true };
  if (overlap(frame.localX, width, target) >= cfg.overlapThreshold) return { ok: true, mapped: true, moved: false, reason: 'Already in correct column' };
  const targetCanvasX = frame.left + target.targetX;
  const placement = await collisionFreePosition(env, item, { x: targetCanvasX, y: canvas.y, frameLeft: frame.left, frameTop: frame.top }, target, 'canvas');
  const response = await patchItem(env, itemId, { position: { x: placement.x, y: placement.y, origin: 'center' } });
  return response.ok ? { ok: true, mapped: true, moved: true, itemId, fromX: canvas.x, toX: placement.x, yPreserved: placement.y, movementMode: 'canvas', collisionAdjusted: placement.adjusted, collisionOffset: placement.offset || null } : { ok: false, stage: 'miro-move', miroStatus: response.status, error: await response.text() };
}

export async function registerMappings(env, entries) {
  const valid = entries.slice(0, 500).map(entry => ({ issueKey: normalizeIssueKey(entry.issueKey), itemId: String(entry.itemId ?? '').trim() })).filter(entry => entry.issueKey && entry.itemId);
  await Promise.all(valid.map(entry => env.CARD_MAP.put(customMapKey(entry.issueKey), entry.itemId)));
  return valid;
}

export function issueKeyFromImage(item) {
  const title = String(item?.data?.title ?? item?.title ?? '').trim();
  const match = title.match(/^CUSTOM_JIRA_CARD:([A-Z]+-\d+)$/i);
  return match ? normalizeIssueKey(match[1]) : null;
}

export async function incomingPosition(env) {
  const cfg = config(env);
  const response = await fetch(`https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/frames/${encodeURIComponent(cfg.incomingFrameId)}`, { headers: miroHeaders(env) });
  if (!response.ok) return { ok: false, status: 502, stage: 'incoming-read-frame', miroStatus: response.status, error: await response.text() };
  const frame = await response.json();
  const width = Number(frame?.geometry?.width), height = Number(frame?.geometry?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return { ok: false, status: 502, stage: 'incoming-frame-geometry', reason: 'Incoming frame has invalid geometry' };
  const children = await listItems(env, { parent_item_id: cfg.incomingFrameId });
  if (!children.ok) return { ok: false, status: 502, stage: 'incoming-list-children', error: children.error };
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
