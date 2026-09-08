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

export async function uploadSvg(env, issueKey, svg, patch, title = `CUSTOM_JIRA_CARD:${issueKey}`, width = config(env).card.width) {
  const form = new FormData();
  form.append('resource', new Blob([new TextEncoder().encode(svg)], { type: 'image/svg+xml' }), `${issueKey}.svg`);
  form.append('data', JSON.stringify({ title }));
  const upload = await fetch(`https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images`, { method: 'POST', headers: miroHeaders(env), body: form });
  if (!upload.ok) return { ok: false, status: 502, stage: 'miro-image-upload', miroStatus: upload.status, error: await upload.text() };
  const itemId = String((await upload.json())?.id ?? '').trim();
  if (!itemId) return { ok: false, status: 502, stage: 'miro-image-id', reason: 'Miro returned no image ID' };
  const positioned = await fetch(`https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers: { ...miroHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { title }, geometry: { width }, ...patch }),
  });
  if (!positioned.ok) {
    const error = await positioned.text();
    await deleteImage(env, itemId).catch(() => {});
    return { ok: false, status: 502, stage: 'miro-image-position', miroStatus: positioned.status, error };
  }
  return { ok: true, itemId };
}

export async function replaceSvg(env, itemId, issueKey, svg, title = `CUSTOM_JIRA_CARD:${issueKey}`, width = config(env).card.width) {
  const form = new FormData();
  form.append('resource', new Blob([new TextEncoder().encode(svg)], { type: 'image/svg+xml' }), `${issueKey}.svg`);
  form.append('data', JSON.stringify({ title }));
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
const COLLISION_DIRECTIONS = [
  { x: 1, y: 1 },
  { x: -1, y: 1 },