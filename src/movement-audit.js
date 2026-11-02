import { getItem, issueKeyFromImage, resolveCanvasPosition } from './miro.js';
import { jiraApi, resolveMiroCommentAuthor } from './jira.js';

// In Miro's signed JWT, `user` is the person and `sub` is the app client ID.
export function requestingMiroUserId(identity) {
  return String(typeof identity?.user === 'string' ? identity.user : identity?.user?.id ?? identity?.userId ?? '').trim();
}

export function hasMovement(movement) {
  const from = movement?.from, to = movement?.to;
  return Boolean(from && to && [from.x, from.y, to.x, to.y].every(Number.isFinite)
    && (Math.abs(from.x - to.x) > 1 || Math.abs(from.y - to.y) > 1
      || String(from.parentId ?? '') !== String(to.parentId ?? '')));
}

export async function prepareMovementAudit(env, body, identity) {
  const movement = body.movement;
  const record = {
    eventId: crypto.randomUUID(), issueKey: body.issueKey, itemId: body.itemId,
    boardId: body.boardId, recordedAt: new Date().toISOString(),
    requesterMiroUserId: requestingMiroUserId(identity) || null,
    actorMiroUserId: null, actorName: null, attribution: 'unknown',
    attributionReason: 'legacy-client-no-movement-evidence',
  };
  if (!hasMovement(movement)) return record;
  // Several open app instances can observe one move. Give their records the
  // same event ID without pretending the observing user made the move.
  const signature = JSON.stringify([body.boardId, body.itemId, movement.modifiedAt, movement.from, movement.to]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature));
  record.eventId = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  const position = value => ({ x: value.x, y: value.y, parentId: String(value.parentId ?? '') });
  record.fromPosition = position(movement.from);
  record.toPosition = position(movement.to);
  record.observedMiroUserId = String(movement.modifiedBy ?? '') || null;
  record.miroModifiedAt = String(movement.modifiedAt ?? '');
  record.attributionReason = 'miro-metadata-unavailable';
  try {
    const read = await getItem(env, body.itemId, { signal: AbortSignal.timeout(5000) });
    if (!read.ok || !read.found || issueKeyFromImage(read.item) !== body.issueKey) return record;
    const item = read.item;
    const id = String(item.modifiedBy?.id ?? (typeof item.modifiedBy === 'string' ? item.modifiedBy : '')).trim();
    const observedTime = Date.parse(movement.modifiedAt), actualTime = Date.parse(item.modifiedAt);
    const observedId = String(movement.modifiedBy ?? '').trim();
    const canvas = await resolveCanvasPosition(env, item);
    if (!id || id !== observedId || !Number.isFinite(observedTime) || actualTime !== observedTime
      || Math.abs(Date.now() - actualTime) > 300_000 || !canvas
      || !Number.isFinite(movement.canvasX) || !Number.isFinite(movement.canvasY)
      || Math.abs(canvas.x - movement.canvasX) > 1 || Math.abs(canvas.y - movement.canvasY) > 1) {
      record.attributionReason = 'metadata-or-position-changed-since-move';
      return record;
    }
    record.actorMiroUserId = id;
    // This is verified last-modifier evidence at the observed position, not
    // a claim that a particular person performed a physical drag gesture.
    record.attribution = 'miro-last-modifier-at-observed-position';
    record.attributionReason = null;
    const cacheKey = `movement-user-name:${id}`;
    let name = await env.CARD_MAP.get(cacheKey);
    if (!name) {
      name = await resolveMiroCommentAuthor(env, { userId: id }).catch(() => '');
      if (name) await env.CARD_MAP.put(cacheKey, name, { expirationTtl: 3600 });
    }
    record.actorName = name || null;
  } catch {
    // Audit lookup must not block an otherwise valid transition or rollback.
    record.attributionReason = 'miro-verification-failed';
  }
  return record;
}

export async function logMovementAudit(env, record, details = {}) {
  const entry = { ...record, ...details, source: 'miro' };
  try {
    await env.CARD_MAP.put(`audit:miro:${record.issueKey}:${record.eventId}:${crypto.randomUUID()}`, JSON.stringify(entry), { expirationTtl: 90 * 86400 });
  } catch {
    // A storage outage AFTER Jira changed status must never make the client
    // roll the Miro card back while Jira remains in the new status.
    console.error('Miro movement audit storage failed', { issueKey: record.issueKey, eventId: record.eventId });
  }
  console.log('Miro card movement', entry);
}

export async function auditJiraStatusChanges(env, issueKey) {
  const { base, headers } = jiraApi(env);
  const path = `${base}/issue/${encodeURIComponent(issueKey)}/changelog`;
  const probe = await fetch(`${path}?maxResults=1`, { headers });
  if (!probe.ok) throw new Error(`Jira history returned HTTP ${probe.status}`);
  const first = await probe.json();
  let values = first.values || [];
  if (first.total > 1) {
    const tail = await fetch(`${path}?startAt=${Math.max(0, first.total - 50)}&maxResults=50`, { headers });
    if (!tail.ok) throw new Error(`Jira history returned HTTP ${tail.status}`);
    values = (await tail.json()).values || [];
  }
  for (const change of values) {
    const status = change.items?.find(item => item.field === 'status');
    // Catch up recent history after queue delays, without importing years of
    // history on unrelated field updates. Attribution comes from Jira itself.
    if (!status || !change.id || Date.parse(change.created) < Date.now() - 86400_000) continue;
    const key = `audit:jira:${issueKey}:${change.id}`;
    if (await env.CARD_MAP.get(key)) continue;
    const entry = {
      source: 'jira', eventId: String(change.id), issueKey,
      changedAt: change.created, recordedAt: new Date().toISOString(),
      jiraAccountId: change.author?.accountId ?? null,
      jiraDisplayName: change.author?.displayName ?? null,
      fromStatus: status.fromString ?? null, toStatus: status.toString ?? null,
      // An integration-account author is deliberately NOT presented as a
      // human. The corresponding Miro record has the actual modifier evidence.
      attribution: change.author?.accountId ? 'jira-changelog-author' : 'unknown',
    };
    await env.CARD_MAP.put(key, JSON.stringify(entry), { expirationTtl: 90 * 86400 });
    console.log('Jira status change', entry);
  }
}
