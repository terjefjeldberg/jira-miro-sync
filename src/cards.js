import { commentIndicatorKey, config, customMapKey, normalizeIssueKey, WORK_TYPE_COLORS } from './config.js';
import { getCardData, listIssueComments } from './jira.js';
import { deleteImage, getItem, incomingPosition, listItems, issueKeyFromImage, patchItem, replaceSvg, uploadSvg } from './miro.js';

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&apos;');
}

const CARD_WIDTH = 189;
const CARD_HEIGHT = 123.12;

const UNASSIGNED_COLOR = { background: '#D1D5DB', foreground: '#374151' };

function hslToRgb(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = hue / 60;
  const x = chroma * (1 - Math.abs(segment % 2 - 1));
  const [r, g, b] = segment < 1 ? [chroma, x, 0]
    : segment < 2 ? [x, chroma, 0]
      : segment < 3 ? [0, chroma, x]
        : segment < 4 ? [0, x, chroma]
          : segment < 5 ? [x, 0, chroma]
            : [chroma, 0, x];
  const match = lightness - chroma / 2;
  return [r + match, g + match, b + match].map(value => Math.round(value * 255));
}

function assigneeColor(accountId) {
  const value = String(accountId ?? '').trim();
  if (!value) return UNASSIGNED_COLOR;
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  // Use the full hue wheel instead of a small palette so unrelated accountIds
  // do not collapse into the same few visually similar colors.
  const [red, green, blue] = hslToRgb((hash >>> 0) % 360, 0.68, 0.42);
  const hex = channel => channel.toString(16).padStart(2, '0').toUpperCase();
  const background = `#${hex(red)}${hex(green)}${hex(blue)}`;
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return { background, foreground: luminance > 0.52 ? '#1A1A1A' : '#FFFFFF' };
}

function width(text, size) {
  let units = 0;
  for (const char of String(text ?? '')) {
    if (char === ' ' || /[ilI1.,'!:;|]/.test(char)) units += 0.28;
    else if (/[mwMW@#%&]/.test(char)) units += 0.9;
    else if (/[A-Z0-9]/.test(char)) units += 0.72;
    else units += 0.56;
  }
  return units * size;
}

function fit(text, size, maxWidth) {
  const value = String(text ?? '').trim();
  if (width(value, size) <= maxWidth) return value;
  let result = '';
  for (const char of value) {
    if (width(result + char + '…', size) > maxWidth) break;
    result += char;
  }
  return result ? result + '…' : '…';
}

function assigneeBadge(card) {
  const label = fit(card.assignee, 8, 72) || 'Unassigned';
  // This is intentionally a fixed slot, matching the red-marked area in the
  // card design. The label is fitted inside it rather than changing the card
  // layout as assignee names vary.
  const x = 106;
  const badgeWidth = 80;
  const color = assigneeColor(card.assigneeAccountId);
  return `<g aria-label="Assignee: ${esc(label)}"><rect x="${x}" y="80" width="${badgeWidth}" height="18" rx="4" fill="${color.background}"/><text x="146" y="92.8" text-anchor="middle" font-family="Open Sans, Arial, sans-serif" font-size="8" font-weight="700" fill="${color.foreground}">${esc(label)}</text></g>`;
}

function wrap(text, size, maxWidth) {
  const lines = [];
  let current = '';
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  for (const word of words) {
    const parts = [];
    if (width(word, size) <= maxWidth) parts.push(word);
    else {
      let part = '';
      for (const char of word) {
        if (part && width(part + char, size) > maxWidth) { parts.push(part); part = char; }
        else part += char;
      }
      if (part) parts.push(part);
    }
    for (const part of parts) {
      const candidate = current ? `${current} ${part}` : part;
      if (width(candidate, size) <= maxWidth) current = candidate;
      else { if (current) lines.push(current); current = part; }
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function titleLayout(text) {
  const box = { x: 10, y: 20, width: 150, height: 52 };
  for (let size = 24; size >= 8; size -= 1) {
    const lines = wrap(text, size, box.width);
    const lineHeight = size * 1.05;
    if (lines.length <= 4 && lines.length * lineHeight <= box.height) return { x: 94.5, y: box.y + (box.height - lines.length * lineHeight) / 2 + size * 0.82, size, lineHeight, lines };
  }
  const size = 8, lines = wrap(text, size, box.width).slice(0, 4), lineHeight = size * 1.05;
  return { x: 94.5, y: box.y + (box.height - lines.length * lineHeight) / 2 + size * 0.82, size, lineHeight, lines };
}

function priorityIcon(priority) {
  const p = String(priority ?? '').trim().toLowerCase();
  if (p === 'blocker' || p === 'highest') return '<g transform="translate(9 75)" fill="none" stroke="#E34935" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M0 6 L5 1 L10 6"/><path d="M0 10 L5 5 L10 10"/></g>';
  if (p === 'high') return '<g transform="translate(9 77)" fill="none" stroke="#E34935" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M0 7 L5 2 L10 7"/></g>';
  if (p === 'medium') return '<g transform="translate(9 79)" fill="none" stroke="#F5A700" stroke-width="1.7" stroke-linecap="round"><path d="M0 0 H10"/><path d="M0 4 H10"/></g>';
  if (p === 'low') return '<g transform="translate(9 78)" fill="none" stroke="#1267E5" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M0 2 L5 7 L10 2"/></g>';
  if (p === 'trivial' || p === 'lowest') return '<g transform="translate(9 75)" fill="none" stroke="#1267E5" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M0 1 L5 6 L10 1"/><path d="M0 5 L5 10 L10 5"/></g>';
  return '<g transform="translate(9 81)" fill="none" stroke="#6B778C" stroke-width="1.8" stroke-linecap="round"><path d="M0 0 H10"/></g>';
}

export function cardSvg(card) {
  const layout = titleLayout(card.summary);
  const title = [`<text x="${layout.x}" y="${layout.y}" text-anchor="middle" font-family="Open Sans, Arial, sans-serif" font-size="${layout.size}" font-weight="400" fill="#1A1A1A">`, ...layout.lines.map((line, i) => i ? `<tspan x="${layout.x}" dy="${layout.lineHeight}">${esc(line)}</tspan>` : `<tspan x="${layout.x}">${esc(line)}</tspan>`), '</text>'].join('');
  const isBlocker = String(card.priority ?? '').trim().toLowerCase() === 'blocker';
  const isHotfixCandidate = Boolean(card.hotfixCandidate);
  const color = isBlocker ? '#000000' : isHotfixCandidate ? '#FFB677' : (WORK_TYPE_COLORS[String(card.workType ?? '').trim().toLowerCase()] || '#E8E8E8');
  const textColor = isBlocker ? '#FFFFFF' : '#1A1A1A';
  const linkColor = isBlocker ? '#9CCBFF' : '#0A66C2';
  const priority = fit(card.priority, 8, 62) || 'None';
  return ['<svg xmlns="http://www.w3.org/2000/svg" width="189" height="102" viewBox="0 0 189 102">', '<rect x="1" y="1" width="187" height="100" rx="6" fill="' + color + '" stroke="#8A8A8A" stroke-width="1.0"/>', `<text x="8" y="15" font-family="Open Sans, Arial, sans-serif" font-size="8" font-weight="700" fill="${textColor}">${esc(card.issueKey)}</text>`, `<text x="181" y="15" text-anchor="end" font-family="Open Sans, Arial, sans-serif" font-size="8" fill="${linkColor}">Jira ↗</text>`, title.replaceAll('fill="#1A1A1A"', `fill="${textColor}"`), commentIndicatorSvg(card.commentCount), priorityIcon(card.priority), `<text x="25" y="89" font-family="Open Sans, Arial, sans-serif" font-size="8" fill="${textColor}">${esc(priority)}</text>`, assigneeBadge(card), '</svg>'].join('');
}

export async function createCard(env, issueKey, position, parentId = null) {
  issueKey = normalizeIssueKey(issueKey);
  const existing = String(await env.CARD_MAP.get(customMapKey(issueKey)) ?? '').trim();
  if (existing) return { ok: true, created: false, mapped: true, itemId: existing };
  const data = await getCardData(env, issueKey);
  if (!data.ok) return { ok: false, status: 502, stage: 'read-jira-data', jiraStatus: data.status, error: data.error };
  const patch = { position: { x: Number(position.x), y: Number(position.y), origin: 'center' } };
  if (parentId) patch.parent = { id: parentId };
  const created = await uploadSvg(env, issueKey, cardSvg(data), patch);
  if (!created.ok) return created;
  await env.CARD_MAP.put(customMapKey(issueKey), created.itemId);
  return { ok: true, created: true, itemId: created.itemId };
}

export async function createDirectCard(env, issueKey, x, y) {
  if (![x, y].every(Number.isFinite)) return { ok: false, status: 400, reason: 'Invalid card position' };
  issueKey = normalizeIssueKey(issueKey);
  const result = await createCard(env, issueKey, { x, y });
  if (!result.ok || result.created) return result;

  const read = await getItem(env, result.itemId);
  if (!read.ok) return { ok: false, status: 502, stage: 'direct-read-existing-card', miroStatus: read.status, error: read.error };
  if (!read.found || String(read.item?.type ?? '') !== 'image' || !issueKeyFromImage(read.item)) {
    await env.CARD_MAP.delete(customMapKey(issueKey));
    return createCard(env, issueKey, { x, y });
  }
  const moved = await patchItem(env, result.itemId, {
    parent: { id: null },
    position: { x, y, origin: 'center' },
  });
  if (!moved.ok) return { ok: false, status: 502, stage: 'direct-reposition-existing-card', miroStatus: moved.status, error: await moved.text() };
  return { ...result, directPositionEnsured: true };
}

async function dedupeIncoming(env, issueKey, createdItemId) {
  await new Promise(resolve => setTimeout(resolve, 700));
  const cfg = config(env);
  const incoming = await listItems(env, { parent_item_id: cfg.incomingFrameId });
  if (!incoming.ok) return { keptItemId: createdItemId, removedItemIds: [] };
  const incomingMatches = incoming.items.filter(item => issueKeyFromImage(item) === issueKey);
  const mapped = String(await env.CARD_MAP.get(customMapKey(issueKey)) ?? '').trim();
  const mappedInIncoming = incomingMatches.some(item => String(item.id) === mapped);

  // Most creations have one card in Incoming. Avoid scanning the whole board
  // unless there is evidence of a race or the mapped card has already moved.
  if (incomingMatches.length <= 1 && (!mapped || mappedInIncoming)) {
    return { keptItemId: mapped || String(incomingMatches[0]?.id ?? createdItemId), removedItemIds: [] };
  }

  // A competing webhook can move one duplicate out of Incoming before the
  // old Incoming-only scan runs. Search the whole board so duplicates are
  // removed regardless of their current workflow position.
  const listed = await listItems(env, { type: 'image' });
  if (!listed.ok) return { keptItemId: createdItemId, removedItemIds: [] };
  const matches = listed.items.filter(item => issueKeyFromImage(item) === issueKey);
  const ids = matches.map(item => String(item.id)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (ids.length <= 1) return { keptItemId: ids[0] || createdItemId, removedItemIds: [] };
  const mappedMatch = mapped && matches.find(item => String(item.id) === mapped);
  const outsideIncoming = matches
    .filter(item => String(item?.parent?.id ?? item?.parentId ?? '').trim() !== cfg.incomingFrameId)
    .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const keep = String(mappedMatch?.id ?? outsideIncoming[0]?.id ?? ids[0]);
  const removed = [];
  for (const id of ids.filter(candidate => candidate !== keep)) if (await deleteImage(env, id)) removed.push(id);
  await env.CARD_MAP.put(customMapKey(issueKey), keep);
  return { keptItemId: keep, removedItemIds: removed };
}

function commentIndicatorSvg(total) {
  const count = Number(total) || 0;
  if (count <= 0) return '';
  const label = count > 99 ? '99+' : String(count);
  const fontSize = label.length > 2 ? 5.5 : 6.5;
  return `<g transform="translate(174 72)"><rect x="-8" y="-6" width="16" height="12" rx="2" fill="#fff" stroke="#24527A" stroke-width="0.8"/><path d="M-7 -4 L0 1 L7 -4 M-7 4 L-2 0 M7 4 L2 0" fill="none" stroke="#24527A" stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="-5" r="4.5" fill="#F26B38"/><text x="8" y="-3.4" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="700" fill="#fff">${label}</text></g>`;
}

function indicatorPatch(item) {
  const x = Number(item?.position?.x ?? item?.x), y = Number(item?.position?.y ?? item?.y);
  const width = Number(item?.geometry?.width ?? item?.width), height = Number(item?.geometry?.height ?? item?.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  const parentId = String(item?.parent?.id ?? item?.parentId ?? '').trim();
  const patch = { position: { x: x + width / 2 - 25, y: y - height / 2 + 22, origin: 'center' } };
  if (parentId) patch.parent = { id: parentId };
  return patch;
}

export async function syncCommentIndicator(env, issueKey) {
  issueKey = normalizeIssueKey(issueKey);
  const legacyIndicatorKey = commentIndicatorKey(issueKey);
  const legacyIndicatorId = String(await env.CARD_MAP.get(legacyIndicatorKey) ?? '').trim();
  if (legacyIndicatorId) {
    await deleteImage(env, legacyIndicatorId).catch(() => {});
    await env.CARD_MAP.delete(legacyIndicatorKey);
  }
  const refreshed = await refreshCard(env, issueKey);
  return refreshed.ok === false ? refreshed : { ...refreshed, commentIndicator: 'embedded', visible: true };
}

export async function createIncomingCard(env, issueKey) {
  issueKey = normalizeIssueKey(issueKey);
  const existing = String(await env.CARD_MAP.get(customMapKey(issueKey)) ?? '').trim();
  if (existing) return { ok: true, created: false, mapped: true, itemId: existing };
  const position = await incomingPosition(env);
  if (!position.ok) return position;
  const created = await createCard(env, issueKey, position, position.parentId);
  if (!created.ok) return created;
  const dedupe = await dedupeIncoming(env, issueKey, created.itemId);
  return { ...created, itemId: dedupe.keptItemId, position, dedupe };
}

export async function refreshCard(env, issueKey, existingData = null) {
  issueKey = normalizeIssueKey(issueKey);
  const itemId = String(await env.CARD_MAP.get(customMapKey(issueKey)) ?? '').trim();
  if (!itemId) return { ok: true, refreshed: false, mapped: false };

  const read = await getItem(env, itemId);
  if (!read.ok) return { ok: false, refreshed: false, mapped: true, stage: 'refresh-read-miro', miroStatus: read.status, error: read.error };
  if (!read.found || String(read.item?.type ?? '') !== 'image' || !issueKeyFromImage(read.item)) {
    await env.CARD_MAP.delete(customMapKey(issueKey));
    return { ok: true, refreshed: false, mapped: false, missing: true };
  }

  const [data, comments] = await Promise.all([
    existingData?.ok ? existingData : getCardData(env, issueKey),
    listIssueComments(env, issueKey),
  ]);
  if (!data.ok) return { ok: false, refreshed: false, mapped: true, stage: 'refresh-read-jira', jiraStatus: data.status, error: data.error };
  if (!comments.ok) return { ok: false, refreshed: false, mapped: true, stage: 'refresh-read-comments', jiraStatus: comments.status, error: comments.error };
  data.commentCount = comments.total;
  const result = await replaceSvg(env, itemId, issueKey, cardSvg(data));
  if (!result.ok) return { ...result, mapped: true, itemId };
  return { ok: true, refreshed: true, mapped: true, itemId, fields: { summary: data.summary, priority: data.priority, assignee: data.assignee, workType: data.workType, hotfixCandidate: data.hotfixCandidate } };
}
