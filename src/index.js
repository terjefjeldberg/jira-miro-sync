import { assigneeColorKey, config, customMapKey, directPendingKey, freezeKey, issueKeyIsValid, normalizeIssueKey, stickyIssueKey } from './config.js';
import { json, preflight, readJson, requireJiraWebhook, requireMiro } from './auth.js';
import { addIssueComment, applyReporter, applyStickyMetadata, createIssueFromSticky, getCardData, getCardSummaries, getJiraAttachmentContent, listIssueComments, resolveMiroCommentAuthor, resolveReporter, syncMiroRemoteLink, transitionIssue } from './jira.js';
import { assigneeColor, createDirectCard, createIncomingCard, normalizeAssigneeLabel, refreshCard, syncCommentIndicator } from './cards.js';
import { getItem, inspectMappedPosition, issueKeyFromImage, listItems, moveMappedItemToStatus, patchItem, registerMappings, removeOrphanDuplicate, repairMappedPosition, resumeCardUpload } from './miro.js';
import { renderApp, renderAppClient, renderCommentsClient, renderCommentsModal, renderPanel, renderPanelClient } from './ui.js';
import { auditJiraStatusChanges, hasMovement, logMovementAudit, prepareMovementAudit } from './movement-audit.js';

function changedWebhookFields(body) {
  const items = Array.isArray(body?.changelog?.items) ? body.changelog.items : [];
  const fields = Array.isArray(body?.changedFields) ? body.changedFields : items.map(item => item?.field);
  return fields.map(field => String(field ?? '').trim().toLowerCase()).filter(Boolean);
}

function needsCardRefresh(body) {
  const fields = changedWebhookFields(body);
  return !fields.length || fields.some(field => field !== 'status' && field !== 'statuscategory');
}

function isIssueCreationWebhook(body) {
  if (body?.issueCreated === true || body?.created === true) return true;
  const event = String(body?.event ?? body?.eventType ?? body?.webhookEvent ?? '').trim().toLowerCase();
  return ['created', 'issue_created', 'issue-created', 'work_item_created', 'work-item-created', 'ensure_card', 'ensure-card'].includes(event);
}

async function requireMiroJson(request, env) {
  return (await requireMiro(request, env)) ? null : json({ ok: false, reason: 'Invalid Miro identity token' }, 401);
}

async function bodyOr400(request) {
  const body = await readJson(request);
  return body == null ? { error: json({ ok: false, reason: 'Invalid JSON' }, 400) } : { body };
}

async function recoverCustomMapping(env, issueKey) {
  const listed = await listItems(env, { type: 'image' });
  if (!listed.ok) return { ok: false, status: listed.status, error: listed.error };

  const item = listed.items.find(candidate => issueKeyFromImage(candidate) === issueKey);
  const itemId = String(item?.id ?? '').trim();
  if (!itemId) return { ok: true, recovered: false };

  await env.CARD_MAP.put(customMapKey(issueKey), itemId);
  return { ok: true, recovered: true, itemId };
}

async function register(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const boardId = String(parsed.body.boardId ?? '').trim();
  if (boardId !== String(env.MIRO_BOARD_ID)) return json({ ok: false, reason: 'Wrong Miro board' }, 403);
  const entries = (Array.isArray(parsed.body.cards) ? parsed.body.cards : [])
    .filter(entry => issueKeyIsValid(normalizeIssueKey(entry?.issueKey), env));
  const mappings = await registerMappings(env, entries);
  const links = await Promise.all(mappings.map(entry => linkMiroCardBestEffort(env, entry.issueKey, entry.mappedItemId)));
  return json({ ok: true, registered: mappings.length, mappings, links });
}

async function linkMiroCardBestEffort(env, issueKey, itemId) {
  try { return await syncMiroRemoteLink(env, issueKey, itemId); }
  catch (error) { console.error('Miro-to-Jira link sync failed', { issueKey, itemId, error: String(error) }); return { ok: false, error: String(error) }; }
}

async function reconcileCustomCards(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const boardId = String(parsed.body.boardId ?? '').trim();
  if (boardId !== String(env.MIRO_BOARD_ID)) return json({ ok: false, reason: 'Wrong Miro board' }, 403);
  const entries = (Array.isArray(parsed.body.cards) ? parsed.body.cards : [])
    .slice(0, 100)
    .map(entry => ({ issueKey: normalizeIssueKey(entry?.issueKey), itemId: String(entry?.itemId ?? '').trim() }))
    .filter(entry => issueKeyIsValid(entry.issueKey, env) && entry.itemId);
  const results = [];
  for (const entry of entries) {
    const live = await getCardData(env, entry.issueKey);
    if (!live.ok) {
      results.push({ ...entry, ok: false, stage: 'jira-read', status: live.status, error: live.error });
      continue;
    }
    const moved = await moveMappedItemToStatus(env, entry.itemId, live.status);
    results.push({ ...entry, jiraStatus: live.status, ...moved });
  }
  return json({ ok: results.every(result => result.ok !== false), reconciled: results.length, results });
}

async function refreshCustomCards(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const boardId = String(parsed.body.boardId ?? '').trim();
  if (boardId !== String(env.MIRO_BOARD_ID)) return json({ ok: false, reason: 'Wrong Miro board' }, 403);
  const entries = (Array.isArray(parsed.body.cards) ? parsed.body.cards : [])
    .slice(0, 50)
    .map(entry => ({ issueKey: normalizeIssueKey(entry?.issueKey), itemId: String(entry?.itemId ?? '').trim() }))
    .filter(entry => issueKeyIsValid(entry.issueKey, env) && entry.itemId);
  const mappings = parsed.body.selected === true ? entries : await registerMappings(env, entries);
  const results = [];
  for (const entry of mappings) {
    const refreshed = await refreshCard(env, entry.issueKey, null, parsed.body.selected === true ? entry.itemId : '');
    results.push({ ...entry, ...refreshed });
  }
  return json({ ok: results.every(result => result.ok !== false), refreshed: results.filter(result => result.refreshed).length, results });
}

async function searchCardSummaries(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  if (String(parsed.body.boardId ?? '').trim() !== String(env.MIRO_BOARD_ID)) return json({ ok: false, reason: 'Wrong Miro board' }, 403);
  const cards = Array.isArray(parsed.body.cards) ? parsed.body.cards : [];
  if (cards.length > 25) return json({ ok: false, reason: 'Too many cards in one search batch' }, 400);
  const candidates = [...new Set(cards.map(card => normalizeIssueKey(card?.issueKey)).filter(key => issueKeyIsValid(key, env)))];
  const mapped = await Promise.all(candidates.map(async key => ({ key, itemId: await env.CARD_MAP.get(customMapKey(key)) })));
  const keys = mapped.filter(entry => entry.itemId).map(entry => entry.key);
  const result = await getCardSummaries(env, keys);
  return json(result, result.ok ? 200 : 502);
}

async function assigneeColorLegend(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const boardId = String(parsed.body.boardId ?? '').trim();
  if (boardId !== String(env.MIRO_BOARD_ID)) return json({ ok: false, reason: 'Wrong Miro board' }, 403);
  const entries = (Array.isArray(parsed.body.cards) ? parsed.body.cards : [])
    .slice(0, 50)
    .map(entry => ({ issueKey: normalizeIssueKey(entry?.issueKey), itemId: String(entry?.itemId ?? '').trim() }))
    .filter(entry => issueKeyIsValid(entry.issueKey, env) && entry.itemId);
  const mappings = await registerMappings(env, entries);
  const users = new Map();
  for (const entry of mappings) {
    const live = await getCardData(env, entry.issueKey);
    if (!live.ok) continue;
    const accountId = String(live.assigneeAccountId ?? '').trim();
    const name = normalizeAssigneeLabel(live.assignee) || 'Unassigned';
    const key = accountId || 'unassigned';
    // Use the same persisted override as cardSvg(). Without this, the legend
    // shows the deterministic default while the card shows the saved color.
    if (!users.has(key)) users.set(key, { name, accountId, ...assigneeColor(accountId, live.assigneeColorOverride) });
  }
  return json({ ok: true, users: [...users.values()].sort((a, b) => a.name.localeCompare(b.name)) });
}

async function setAssigneeColor(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const boardId = String(parsed.body.boardId ?? '').trim();
  const accountId = String(parsed.body.accountId ?? '').trim();
  const color = String(parsed.body.color ?? '').trim().toUpperCase();
  if (boardId !== String(env.MIRO_BOARD_ID)) return json({ ok: false, reason: 'Wrong Miro board' }, 403);
  if (!accountId || !/^#[0-9A-F]{6}$/.test(color)) return json({ ok: false, reason: 'Invalid assignee color' }, 400);
  await env.CARD_MAP.put(assigneeColorKey(accountId), color);
  return json({ ok: true, accountId, color });
}

async function miroToJira(request, env) {
  const identity = await requireMiro(request, env);
  if (!identity) return json({ ok: false, reason: 'Invalid Miro identity token' }, 401);
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const body = parsed.body;
  const boardId = String(body.boardId ?? '').trim();
  const issueKey = normalizeIssueKey(body.issueKey);
  const itemId = String(body.itemId ?? '').trim();
  const desiredStatus = String(body.desiredStatus ?? '').trim();
  if (boardId !== String(env.MIRO_BOARD_ID)) return json({ ok: false, reason: 'Wrong Miro board' }, 403);
  if (!issueKeyIsValid(issueKey, env)) return json({ ok: true, ignored: true, reason: `Only ${config(env).jiraProjectKey} issues are approved` });
  if (!itemId) return json({ ok: false, reason: 'Missing custom-card image ID' }, 400);
  const mappedItemId = String(await env.CARD_MAP.get(customMapKey(issueKey)) ?? '').trim();
  if (mappedItemId && mappedItemId !== itemId) return json({ ok: true, changed: false, ignored: true, issueKey, itemId, mappedItemId, reason: 'A different Miro card is already mapped to this Jira issue' });
  if (!mappedItemId) await env.CARD_MAP.put(customMapKey(issueKey), itemId);

  const live = await getCardData(env, issueKey).catch(() => null);
  const audit = await prepareMovementAudit(env, { ...body, issueKey, itemId }, identity);
  if (live?.ok && String(live.status ?? '').trim().toLowerCase() === desiredStatus.toLowerCase()) {
    await logMovementAudit(env, audit, { fromStatus: live.status, toStatus: live.status, requestedStatus: desiredStatus, outcome: 'no-status-change' });
    return json({ ok: true, changed: false, issueKey, itemId, currentStatus: live.status, desiredStatus, reason: 'Jira already has desired status' });
  }

  let result;
  try { result = await transitionIssue(env, issueKey, desiredStatus); }
  catch (error) {
    await logMovementAudit(env, audit, { fromStatus: live?.status ?? null, requestedStatus: desiredStatus, outcome: 'transition-error' });
    throw error;
  }
  await logMovementAudit(env, audit, { fromStatus: result.fromStatus ?? live?.status ?? null, toStatus: result.ok ? result.toStatus ?? desiredStatus : live?.status ?? null, requestedStatus: desiredStatus, outcome: result.ok ? result.changed ? 'status-changed' : 'no-status-change' : 'transition-rejected' });
  return json({ ...result, issueKey, itemId }, result.ok ? 200 : (result.status || 500));
}

async function cardMovement(request, env) {
  const identity = await requireMiro(request, env);
  if (!identity) return json({ ok: false, reason: 'Invalid Miro identity token' }, 401);
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const body = parsed.body;
  const issueKey = normalizeIssueKey(body.issueKey), itemId = String(body.itemId ?? '').trim();
  if (String(body.boardId) !== String(env.MIRO_BOARD_ID)) return json({ ok: false, reason: 'Wrong Miro board' }, 403);
  if (!issueKeyIsValid(issueKey, env) || !itemId || !hasMovement(body.movement)) return json({ ok: false, reason: 'Invalid movement' }, 400);
  const mapped = await env.CARD_MAP.get(customMapKey(issueKey));
  if (mapped && String(mapped) !== itemId) return json({ ok: false, reason: 'Different card is mapped' }, 409);
  const audit = await prepareMovementAudit(env, { ...body, issueKey, itemId }, identity);
  await logMovementAudit(env, audit, { outcome: 'position-changed' });
  return json({ ok: true, eventId: audit.eventId, attribution: audit.attribution });
}

async function rollbackCustomCard(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const body = parsed.body;
  const issueKey = normalizeIssueKey(body.issueKey);
  const itemId = String(body.itemId ?? '').trim();
  const previousParentId = String(body.previousParentId ?? '').trim();
  const previousX = Number(body.previousX), previousY = Number(body.previousY);
  if (!issueKeyIsValid(issueKey, env) || !itemId || !Number.isFinite(previousX) || !Number.isFinite(previousY)) {
    return json({ ok: false, reason: 'Invalid rollback card or position' }, 400);
  }
  const mappedItemId = String(await env.CARD_MAP.get(customMapKey(issueKey)) ?? '').trim();
  if (mappedItemId && mappedItemId !== itemId) {
    return json({ ok: true, changed: false, ignored: true, reason: 'A different Miro card is mapped to this Jira issue' });
  }
  const response = await patchItem(env, itemId, {
    parent: { id: previousParentId || null },
    position: { x: previousX, y: previousY, origin: 'center', relativeTo: previousParentId ? 'parent_top_left' : 'canvas_center' },
  });
  if (!response.ok) return json({ ok: false, stage: 'miro-rollback', miroStatus: response.status, error: await response.text() }, 502);
  return json({ ok: true, rolledBack: true, issueKey, itemId, previousParentId, previousX, previousY });
}

async function stickyToJira(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const body = parsed.body;
  const stickyId = String(body.stickyId ?? '').trim();
  const reporter = await resolveReporter(env, stickyId, body.createdBy);
  if (!reporter.ok) return json(reporter, reporter.status || 409);

  const cachedIssueKey = normalizeIssueKey(await env.CARD_MAP.get(stickyIssueKey(stickyId)));
  let created;
  if (cachedIssueKey && issueKeyIsValid(cachedIssueKey, env)) {
    created = { ok: true, created: false, reused: true, issueKey: cachedIssueKey, workType: String(body.workType ?? '').trim(), summary: String(body.summary ?? '').replace(/\s+/g, ' ').trim() };
  } else {
    created = await createIssueFromSticky(env, body.summary, String(body.workType ?? '').trim());
    if (!created.ok) return json(created, created.status || 500);
    await env.CARD_MAP.put(stickyIssueKey(stickyId), created.issueKey, { expirationTtl: 86400 });
  }

  await env.CARD_MAP.put(directPendingKey(created.issueKey), JSON.stringify({ stickyId }), { expirationTtl: 90 });
  const reporterUpdate = await applyReporter(env, created.issueKey, reporter);
  if (!reporterUpdate.ok) return json({ ...created, ok: false, reason: reporterUpdate.reason, reporterSync: reporterUpdate }, reporterUpdate.status || 409);
  const originalMiroCreatedSync = await applyStickyMetadata(env, created.issueKey, reporter);
  if (!originalMiroCreatedSync.ok) {
    let detail = '';
    try {
      const body = JSON.parse(String(originalMiroCreatedSync.error || '{}'));
      detail = [...(Array.isArray(body.errorMessages) ? body.errorMessages : []), ...Object.values(body.errors || {})]
        .map(value => String(value).trim())
        .filter(Boolean)
        .join(' ');
    } catch {}
    return json({
      ...created,
      ok: false,
      reason: `${originalMiroCreatedSync.reason}${detail ? `: ${detail}` : ''}`,
      reporterSync: { ok: true, applied: true, miroCreatorId: reporter.creatorId, miroCreatorName: reporter.creatorName, jiraReporterAccountId: reporter.accountId, jiraReporterSource: reporter.source },
      originalMiroCreatedSync,
    }, originalMiroCreatedSync.status || 409);
  }
  return json({ ...created, reporterSync: { ok: true, applied: true, miroCreatorId: reporter.creatorId, miroCreatorName: reporter.creatorName, jiraReporterAccountId: reporter.accountId, jiraReporterSource: reporter.source }, originalMiroCreatedSync });
}

async function jiraComments(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const url = new URL(request.url);
  const issueKey = normalizeIssueKey(url.searchParams.get('issueKey'));
  const itemId = String(url.searchParams.get('itemId') ?? '').trim();
  if (!issueKeyIsValid(issueKey, env) || !itemId) return json({ ok: false, reason: 'Invalid issue key or Miro item ID' }, 400);
  const mappedItemId = String(await env.CARD_MAP.get(customMapKey(issueKey)) ?? '').trim();
  if (!mappedItemId || mappedItemId !== itemId) return json({ ok: false, reason: 'Miro card is not mapped to this Jira issue' }, 403);
  const result = await listIssueComments(env, issueKey);
  return json({ ...result, issueKey, itemId }, result.ok ? 200 : (result.status || 502));
}

async function jiraCommentMedia(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const url = new URL(request.url);
  const issueKey = normalizeIssueKey(url.searchParams.get('issueKey'));
  const itemId = String(url.searchParams.get('itemId') ?? '').trim();
  const attachmentId = String(url.searchParams.get('attachmentId') ?? '').trim();
  if (!issueKeyIsValid(issueKey, env) || !itemId || !attachmentId) return json({ ok: false, reason: 'Invalid Jira attachment request' }, 400);
  const mappedItemId = String(await env.CARD_MAP.get(customMapKey(issueKey)) ?? '').trim();
  if (!mappedItemId || mappedItemId !== itemId) return json({ ok: false, reason: 'Miro card is not mapped to this Jira issue' }, 403);
  const result = await getJiraAttachmentContent(env, issueKey, attachmentId);
  if (!result.ok) return json({ ok: false, reason: result.reason || result.error || 'Could not load Jira attachment' }, result.status || 502);
  return new Response(result.response.body, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': 'https://miro.com',
      'Content-Type': result.response.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'private, max-age=300',
      'Content-Disposition': 'inline',
    },
  });
}

async function addJiraComment(request, env, ctx) {
  const auth = await requireMiro(request, env);
  if (!auth) return json({ ok: false, reason: 'Invalid Miro identity token' }, 401);
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const issueKey = normalizeIssueKey(parsed.body.issueKey);
  const itemId = String(parsed.body.itemId ?? '').trim();
  if (!issueKeyIsValid(issueKey, env) || !itemId) return json({ ok: false, reason: 'Invalid issue key or Miro item ID' }, 400);
  const mappedItemId = String(await env.CARD_MAP.get(customMapKey(issueKey)) ?? '').trim();
  if (!mappedItemId || mappedItemId !== itemId) return json({ ok: false, reason: 'Miro card is not mapped to this Jira issue' }, 403);
  const rawComment = String(parsed.body.comment ?? '').trim().replace(/^(?:[^\n:]{1,120})\s+via\s+Miro:\s*/i, '').trim();
  if (!rawComment) return json({ ok: false, reason: 'Comment cannot be empty' }, 400);
  const author = (await resolveMiroCommentAuthor(env, auth)) || 'Miro user';
  const comment = `${author} via Miro:\n\n${rawComment}`;
  const result = await addIssueComment(env, issueKey, comment);
  if (result.ok) {
    const sync = () => syncCommentIndicator(env, issueKey).catch(error => console.error('Comment indicator sync failed', error));
    if (ctx?.waitUntil) ctx.waitUntil(sync());
    else await sync();
  }
  return json({ ...result, issueKey, itemId }, result.ok ? 200 : (result.status || 502));
}

async function directCard(request, env, ctx) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const issueKey = normalizeIssueKey(parsed.body.issueKey), x = Number(parsed.body.x), y = Number(parsed.body.y);
  if (!issueKeyIsValid(issueKey, env) || !Number.isFinite(x) || !Number.isFinite(y)) return json({ ok: false, reason: 'Invalid issue key or position' }, 400);
  let result;
  if (env.MIRO_CARD_DELIVERY) {
    const id = env.MIRO_CARD_DELIVERY.idFromName(`${env.MIRO_BOARD_ID}:${issueKey}`);
    const response = await env.MIRO_CARD_DELIVERY.get(id).fetch(new Request('https://card-delivery/direct', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issueKey, x, y }),
    }));
    result = await response.json();
  } else result = await createDirectCard(env, issueKey, x, y);
  if (result.ok && result.itemId) {
    const sync = () => linkMiroCardBestEffort(env, issueKey, result.itemId);
    if (ctx?.waitUntil) ctx.waitUntil(sync()); else await sync();
  }
  if (result.ok) await env.CARD_MAP.delete(directPendingKey(issueKey));
  return json(result, result.ok ? 200 : (result.status || 500));
}

async function setConversionStatus(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const issueKey = normalizeIssueKey(parsed.body.issueKey), desiredStatus = String(parsed.body.desiredStatus ?? '').trim();
  if (!issueKeyIsValid(issueKey, env)) return json({ ok: false, reason: 'Invalid issue key' }, 400);
  await env.CARD_MAP.put(freezeKey(issueKey), JSON.stringify({ desiredStatus }), { expirationTtl: 60 });
  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, attempt * 500));
    result = await transitionIssue(env, issueKey, desiredStatus, { firstMatchingTransition: true });
    if (result.ok) break;
  }
  if (!result.ok) {
    await Promise.all([env.CARD_MAP.delete(freezeKey(issueKey)), env.CARD_MAP.delete(directPendingKey(issueKey))]);
  }
  return json({ ...result, issueKey }, result.ok ? 200 : (result.status || 500));
}

async function processJiraWebhookBody(body, env, ctx) {
  const issueKey = normalizeIssueKey(body.issueKey);
  if (!issueKeyIsValid(issueKey, env)) return json({ ok: true, ignored: true, reason: `Only ${config(env).jiraProjectKey} issues are approved`, issueKey });
  if (body.event === 'inspect_position') return json(await inspectMappedPosition(env, issueKey));
  if (body.event === 'remove_orphan_duplicate') {
    const result = await removeOrphanDuplicate(env, issueKey, String(body.itemId), String(body.canonicalId));
    await env.CARD_MAP.put(`duplicate-cleanup:${issueKey}`, JSON.stringify(result));
    return json(result, result.ok ? 200 : 409);
  }
  if (body.event === 'inspect_copies') {
    const listed = await listItems(env, { type: 'image' }, { signal: AbortSignal.timeout(30000) });
    const result = { issueKey, complete: listed.ok, status: listed.status, error: listed.error,
      matches: listed.items.filter(item => issueKeyFromImage(item) === issueKey), inspectedAt: new Date().toISOString() };
    await env.CARD_MAP.put(`copies-inspection:${issueKey}`, JSON.stringify(result));
    return json(result);
  }
  if (body.event === 'inspect_delivery' || body.event === 'retry_delivery') {
    const id = env.MIRO_CARD_DELIVERY.idFromName(`${env.MIRO_BOARD_ID}:${issueKey}`);
    const stub = env.MIRO_CARD_DELIVERY.get(id);
    const response = await stub.fetch(new Request(`https://card-delivery/${body.event === 'retry_delivery' ? 'retry' : 'state'}`, { method: body.event === 'retry_delivery' ? 'POST' : 'GET' }));
    const state = await response.json();
    await env.CARD_MAP.put(`delivery-inspection:${issueKey}`, JSON.stringify(state));
    return json(state);
  }
  if (body.event === 'repair_position') {
    const live = await getCardData(env, issueKey);
    if (!live.ok || String(live.status).toLowerCase() !== String(body.expectedStatus).toLowerCase()) return json({ ok: false, stage: 'repair-jira-status-changed' }, 409);
    const result = await repairMappedPosition(env, issueKey, String(body.parentId), body.localY, live.status);
    await env.CARD_MAP.put(`position-repair:${issueKey}`, JSON.stringify(result));
    console.log('Miro position repair result', { issueKey, ...result });
    return json(result, result.ok ? 200 : 502);
  }
  const issueCreated = isIssueCreationWebhook(body);
  let status = String(body.status ?? '').trim();
  let live = await getCardData(env, issueKey).catch(() => null);
  if (live?.ok && live.status) status = live.status;
  if (!issueCreated && (body.status || changedWebhookFields(body).includes('status')) && !String(body.webhookEvent ?? '').includes('comment')) {
    const audit = auditJiraStatusChanges(env, issueKey).catch(error => console.error('Jira status audit lookup failed', { issueKey, error: String(error) }));
    if (ctx?.waitUntil) ctx.waitUntil(audit); else await audit;
  }

  const frozen = await env.CARD_MAP.get(freezeKey(issueKey), 'json').catch(() => null);
  if (frozen?.desiredStatus && String(frozen.desiredStatus).trim().toLowerCase() === status.toLowerCase()) {
    await env.CARD_MAP.delete(freezeKey(issueKey));
    return json({ ok: true, moved: false, issueKey, status, conversionPositionPreserved: true });
  }

  let mappingRecoveredFromBoard = false;
  let [customId, directPending] = await Promise.all([
    env.CARD_MAP.get(customMapKey(issueKey)),
    env.CARD_MAP.get(directPendingKey(issueKey)),
  ]);

  if (!customId && !directPending) {
    // Direct Miro conversions can race the Jira creation webhook. Wait for
    // the mapping to arrive, but do not repeatedly scan the whole board.
    for (let attempt = 0; attempt < 3 && !customId && !directPending; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 750));
      [customId, directPending] = await Promise.all([
        env.CARD_MAP.get(customMapKey(issueKey)),
        env.CARD_MAP.get(directPendingKey(issueKey)),
      ]);
    }

    // A normal Jira-created issue has no original Miro timestamp and should
    // go directly to Incoming. Only sticky-originated issues need the
    // expensive board-wide mapping recovery scan.
    if (!customId && !directPending && live?.originalMiroCreated) {
      const recovered = await recoverCustomMapping(env, issueKey);
      if (recovered.ok && recovered.recovered) {
        customId = recovered.itemId;
        mappingRecoveredFromBoard = true;
      }
      // A transient Miro 5xx must not prevent normal Incoming creation.
      // If recovery fails, suppress only the sticky-originated creation.
      if (!customId) {
        return json({ ok: true, moved: false, issueKey, status, conversionDirectCreatePending: true, suppressionSource: 'original-miro-created' });
      }
    }
  }

  if (directPending) {
    // A direct Miro conversion creates the Jira issue in Todo. Suppress only
    // that initial webhook; a later manual status change must still move Miro.
    const isInitialStatus = ['todo', 'to do'].includes(String(status).trim().toLowerCase());
    if (isInitialStatus) {
      return json({ ok: true, moved: false, issueKey, status, conversionDirectCreatePending: true, suppressionSource: 'kv-marker' });
    }
  }

  if (!customId) {
    if (!issueCreated) {
      return json({ ok: true, moved: false, issueKey, status, skipped: 'existing-issue-without-miro-card' });
    }
    const incomingCreate = await createIncomingCard(env, issueKey);
    if (incomingCreate.ok !== false) {
      await linkMiroCardBestEffort(env, issueKey, incomingCreate.itemId);
      await syncCommentIndicator(env, issueKey).catch(error => console.error('Comment indicator sync failed', error));
    }
    return json({ ok: incomingCreate.ok !== false, moved: false, issueKey, status, incomingCreate }, incomingCreate.ok === false ? (incomingCreate.status || 500) : 200);
  }

  // Status is represented by the card's column, not its SVG content. Keep the
  // full refresh for other field changes and unknown webhook formats.
  const customRefresh = needsCardRefresh(body)
    ? await refreshCard(env, issueKey, live)
    : { ok: true, refreshed: false, skipped: 'status-only-webhook' };
  const custom = await moveMappedItemToStatus(env, String(customId), status);
  if (custom?.missing) {
    return json({ ok: false, moved: false, issueKey, status, stage: 'canonical-card-unconfirmed', itemId: customId }, 502);
  }
  const ok = custom.ok !== false && customRefresh.ok !== false;
  return json({ ok, issueKey, status, moved: Boolean(custom.moved), mappingRecoveredFromBoard, custom, customRefresh }, ok ? 200 : 500);
}

async function jiraWebhook(request, env) {
  if (!env.JIRA_WEBHOOK_SECRET) return json({ ok: false, reason: 'JIRA_WEBHOOK_SECRET is not configured' }, 500);
  const rawBody = await request.clone().text();
  if (!(await requireJiraWebhook(request, env, rawBody))) return json({ ok: false, reason: 'Invalid Jira webhook secret' }, 401);
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const body = parsed.body;
  const issueKey = normalizeIssueKey(body.issueKey ?? body.issue?.key);
  if (!issueKeyIsValid(issueKey, env)) return json({ ok: true, ignored: true, reason: `Only ${config(env).jiraProjectKey} issues are approved`, issueKey });
  if (isIssueCreationWebhook(body)) return scheduleCardDelivery(env, { ...body, issueKey });
  if (env.MIRO_CARD_DELIVERY) return scheduleStatusDelivery(env, { ...body, issueKey });

  // When the Queue binding exists, acknowledge Jira immediately and let the
  // consumer perform the potentially slow Jira/Miro work. Until then the
  // existing synchronous path remains active as a safe fallback.
  if (env.JIRA_WEBHOOK_QUEUE && typeof env.JIRA_WEBHOOK_QUEUE.send === 'function') {
    try {
      await env.JIRA_WEBHOOK_QUEUE.send({ ...body, issueKey, status: body.status ?? body.issue?.fields?.status?.name ?? '', queuedAt: new Date().toISOString() });
      return json({ ok: true, accepted: true, queued: true, issueKey }, 202);
    } catch (error) {
      console.error('Failed to enqueue Jira webhook', error);
      return json({ ok: false, accepted: false, queued: false, issueKey, reason: 'Queue unavailable' }, 503);
    }
  }

  return processJiraWebhookBody(body, env);
}

async function scheduleCardDelivery(env, body) {
  if (!env.MIRO_CARD_DELIVERY) return json({ ok: false, reason: 'Durable card delivery is not configured' }, 503);
  const id = env.MIRO_CARD_DELIVERY.idFromName(`${env.MIRO_BOARD_ID}:${body.issueKey}`);
  return env.MIRO_CARD_DELIVERY.get(id).fetch(new Request('https://card-delivery/ensure', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}

async function scheduleStatusDelivery(env, body) {
  const id = env.MIRO_CARD_DELIVERY.idFromName(`status:${env.MIRO_BOARD_ID}:${body.issueKey}`);
  return env.MIRO_CARD_DELIVERY.get(id).fetch(new Request('https://card-delivery/ensure-status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}

// One persistent job per board/issue, independent of Queue retry/retention
// limits. External I/O is serialized inside the object, not with a KV lock.
export class MiroCardDelivery {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.env = { ...env, MIRO_DELIVERY_STORAGE: ctx.storage };
    this.tail = Promise.resolve();
  }

  serial(action) {
    const next = this.tail.then(action);
    this.tail = next.catch(() => {});
    return next;
  }

  async fetch(request) {
    if (request.method === 'GET') {
      return this.serial(async () => json({ pending: await this.storage.get('job') ?? null, confirmed: await this.storage.get('confirmed') ?? null, upload: await this.storage.get('upload') ?? null }));
    }
    if (new URL(request.url).pathname === '/retry') return this.serial(async () => {
      if (!await this.storage.get('job')) return json({ ok: false, reason: 'No pending delivery' }, 409);
      await this.storage.setAlarm(Date.now() + 1000);
      return json({ ok: true, retryScheduled: true });
    });
    const body = await request.json();
    if (new URL(request.url).pathname === '/direct') {
      if (!issueKeyIsValid(body.issueKey, this.env) || ![body.x, body.y].every(Number.isFinite)) return json({ ok: false }, 400);
      return this.serial(async () => {
        // Use the SAME durable object/storage as Incoming creation. Concurrent
        // retries and Jira creation events cannot both upload a card.
        const resumed = await resumeCardUpload(this.env, body.issueKey);
        if (!resumed.ok) return json(resumed, 502);
        const result = await createDirectCard(this.env, body.issueKey, body.x, body.y);
        return json(result, result.ok ? 200 : (result.status || 502));
      });
    }
    const statusJob = new URL(request.url).pathname === '/ensure-status';
    if (!issueKeyIsValid(body.issueKey, this.env) || (!statusJob && !isIssueCreationWebhook(body))) return json({ ok: false }, 400);
    return this.serial(async () => {
      await this.storage.transaction(async txn => {
        const previous = await txn.get('job');
        if (statusJob || !previous) {
          // Coalesce notifications, but never discard a pending content refresh.
          const merged = statusJob && previous ? { ...body, changedFields: [...new Set([
            ...(needsCardRefresh(previous.body) ? ['content'] : []), ...changedWebhookFields(body),
          ])] } : body;
          await txn.put('job', { body: merged, mode: statusJob ? 'status' : 'create', attempts: 0, acceptedAt: new Date().toISOString() });
        }
        if (!await txn.getAlarm()) await txn.setAlarm(Date.now() + 1000);
      });
      return json({ ok: true, accepted: true, confirmed: false, delivery: 'pending', issueKey: body.issueKey }, 202);
    });
  }

  alarm() {
    return this.serial(async () => {
      const job = await this.storage.get('job');
      if (!job) return;
      job.attempts += 1;
      const issueKey = job.body.issueKey;
      const delaySeconds = Math.min(60, (job.mode === 'status' ? 5 : 15) * 2 ** Math.min(job.attempts - 1, 4));
      // Persist the next wakeup BEFORE any network request. Even a crash or
      // a sufficiently long Miro outage cannot consume a finite retry budget.
      await this.storage.transaction(async txn => {
        await txn.put('job', job);
        await txn.setAlarm(Date.now() + delaySeconds * 1000);
      });
      try {
        if (job.mode === 'status') {
          // An old queued notification must never restore an obsolete status.
          const live = await getCardData(this.env, issueKey);
          if (!live.ok || !live.status) throw new Error('Current Jira status is unavailable');
          const response = await processJiraWebhookBody({ ...job.body, status: live.status }, this.env, this.ctx);
          const details = await response.json();
          if (!response.ok || details.ok !== true) throw new Error(JSON.stringify(details));
          const movement = details.custom;
          const verified = movement?.verified === true || movement?.reason === 'Already in correct column';
          const inactive = movement?.parked || movement?.ignored || details.skipped || details.conversionPositionPreserved;
          if (!verified && !inactive) throw new Error(`Status placement not confirmed: ${JSON.stringify(details)}`);
          const confirmed = { issueKey, status: details.status, attempts: job.attempts, verified,
            disposition: verified ? 'confirmed' : 'not-applicable', details, confirmedAt: new Date().toISOString() };
          await this.storage.transaction(async txn => {
            await txn.put('confirmed', confirmed);
            await txn.delete('job');
            await txn.deleteAlarm();
          });
          await this.env.CARD_MAP.put(`status-delivery:${issueKey}`, JSON.stringify(confirmed));
          console.log(verified ? 'Miro status delivery confirmed' : 'Miro status delivery not applicable', confirmed);
          return;
        }
        const resumed = await resumeCardUpload(this.env, issueKey);
        if (!resumed.ok) throw new Error(JSON.stringify(resumed));
        const response = await processJiraWebhookBody(job.body, this.env);
        const details = await response.json();
        if (!response.ok || details.ok !== true) throw new Error(JSON.stringify(details));
        const itemId = String(await this.env.CARD_MAP.get(customMapKey(issueKey)) ?? '').trim();
        if (!itemId) throw new Error('Card mapping is missing; delivery is not confirmed');
        const read = await getItem(this.env, itemId, { type: 'image' });
        if (!read.ok) throw new Error(JSON.stringify(read));
        if (!read.found || read.item?.type !== 'image' || issueKeyFromImage(read.item) !== issueKey) {
          throw new Error('Mapped card is missing or belongs to another issue');
        }
        const item = read.item;
        if (![item.position?.x, item.position?.y, item.geometry?.width, item.geometry?.height].every(Number.isFinite)
          || item.geometry.width <= 0 || item.geometry.height <= 0) throw new Error('Miro card geometry is not confirmed');
        const upload = await this.storage.get('upload');
        if (upload?.placement?.parent?.id && (String(item.parent?.id) !== String(upload.placement.parent.id)
          || item.position.relativeTo !== 'parent_top_left'
          || Math.abs(item.position.x - upload.placement.position.x) > 1
          || Math.abs(item.position.y - upload.placement.position.y) > 1)) {
          await this.storage.put('upload', { ...upload, positioned: false });
          throw new Error('Miro has not confirmed placement in Incoming');
        }
        if (upload?.placement?.parent?.id) {
          const frame = await getItem(this.env, upload.placement.parent.id, { type: 'frame' });
          if (!frame.ok || !frame.found) throw new Error('Cannot confirm placement frame bounds');
          const { width, height } = frame.item.geometry ?? {};
          if (![width, height].every(Number.isFinite) || item.position.x - item.geometry.width / 2 < 0
            || item.position.y - item.geometry.height / 2 < 0 || item.position.x + item.geometry.width / 2 > width
            || item.position.y + item.geometry.height / 2 > height) throw new Error('Card is not fully inside placement frame');
        }
        const confirmed = { issueKey, itemId, boardId: this.env.MIRO_BOARD_ID, attempts: job.attempts, confirmedAt: new Date().toISOString() };
        await this.storage.transaction(async txn => {
          await txn.put('confirmed', confirmed);
          await txn.delete('job');
          await txn.delete('upload');
          await txn.delete('uploadStartedAt');
          await txn.deleteAlarm();
        });
        console.log('Miro card delivery confirmed', confirmed);
      } catch (error) {
        job.lastError = String(error?.message ?? error);
        job.nextAttemptAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
        await this.storage.transaction(async txn => {
          await txn.put('job', job);
          await txn.setAlarm(Date.now() + delaySeconds * 1000);
        });
        if (job.mode === 'status') await this.env.CARD_MAP.put(`status-delivery:${issueKey}`, JSON.stringify({ issueKey, status: 'pending', attempts: job.attempts, nextAttemptAt: job.nextAttemptAt, error: job.lastError }));
        console.error(job.mode === 'status' ? 'Miro status delivery pending; retry scheduled' : 'Miro card delivery pending; retry scheduled', { issueKey, attempts: job.attempts, delaySeconds, error: job.lastError });
      }
    });
  }
}

export default {
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      let response;
      try {
        const body = message.body ?? {};
        const diagnostic = ['inspect_position', 'inspect_copies', 'remove_orphan_duplicate', 'repair_position', 'inspect_delivery', 'retry_delivery'].includes(body.event);
        response = isIssueCreationWebhook(body)
          ? await scheduleCardDelivery(env, { ...body, issueKey: normalizeIssueKey(body.issueKey) })
          : env.MIRO_CARD_DELIVERY && !diagnostic
            ? await scheduleStatusDelivery(env, { ...body, issueKey: normalizeIssueKey(body.issueKey) })
            : await processJiraWebhookBody(body, env, ctx);
      } catch (error) {
        console.error('Jira to Miro processing exception', { name: error?.name ?? 'Error', message: error?.message ?? String(error), stack: error?.stack ?? '' });
        throw error;
      }
      if (response.status >= 500) {
        const details = await response.clone().json().catch(() => null);
        console.error('Jira webhook processing failed', {
          issueKey: String(message.body?.issueKey ?? '').trim(),
          status: response.status,
          details,
        });
        throw new Error(`Jira webhook processing failed with HTTP ${response.status}`);
      }
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url), method = request.method, path = url.pathname;
    if (method === 'OPTIONS') return preflight();
    if (method === 'GET' && path === '/health') {
      const cfg = config(env);
      return json({ ok: true, cardMapConfigured: Boolean(env.CARD_MAP), jiraWebhookQueueConfigured: Boolean(env.JIRA_WEBHOOK_QUEUE), miroClientSecretConfigured: Boolean(env.MIRO_CLIENT_SECRET), miroTokenConfigured: Boolean(env.MIRO_TOKEN), miroBoardConfigured: Boolean(env.MIRO_BOARD_ID), jiraTokenConfigured: Boolean(env.JIRA_API_TOKEN), jiraCloudIdConfigured: Boolean(env.JIRA_CLOUD_ID), jiraWebhookSecretConfigured: Boolean(env.JIRA_WEBHOOK_SECRET), projectKey: cfg.jiraProjectKey, incomingFrameId: cfg.incomingFrameId, functionalAreaField: cfg.fields.functionalArea, testDescriptionField: cfg.fields.testDescription, customerField: cfg.fields.bugCustomer });
    }
    if (method === 'GET' && path === '/miro-app') return renderApp();
    if (method === 'GET' && path === '/app.js') return renderAppClient(env);
    if (method === 'GET' && path === '/miro-panel') return renderPanel();
    if (method === 'GET' && path === '/panel.js') return renderPanelClient(env);
    if (method === 'GET' && path === '/comments.js') return renderCommentsClient();
    if (method === 'GET' && path === '/jira-comments-modal') return renderCommentsModal();
    if (method === 'GET' && path === '/jira-comments') return jiraComments(request, env);
    if (method === 'GET' && path === '/jira-comment-media') return jiraCommentMedia(request, env);
    if (method === 'POST' && path === '/jira-comments') return addJiraComment(request, env, ctx);
    if (method === 'POST' && path === '/register-custom-cards') return register(request, env);
    if (method === 'POST' && path === '/reconcile-custom-cards') return reconcileCustomCards(request, env);
    if (method === 'POST' && path === '/refresh-custom-cards') return refreshCustomCards(request, env);
    if (method === 'POST' && path === '/search-card-summaries') return searchCardSummaries(request, env);
    if (method === 'POST' && path === '/assignee-color-legend') return assigneeColorLegend(request, env);
    if (method === 'POST' && path === '/set-assignee-color') return setAssigneeColor(request, env);
    if (method === 'POST' && path === '/custom-miro-to-jira') return miroToJira(request, env);
    if (method === 'POST' && path === '/card-movement') return cardMovement(request, env);
    if (method === 'POST' && path === '/rollback-custom-card') return rollbackCustomCard(request, env);
    if (method === 'POST' && path === '/sticky-to-jira') return stickyToJira(request, env);
    if (method === 'POST' && path === '/conversion-direct-card') return directCard(request, env, ctx);
    if (method === 'POST' && path === '/conversion-set-status') return setConversionStatus(request, env);
    if (method === 'POST' && path === '/') return jiraWebhook(request, env);
    return new Response('Not found', { status: 404 });
  },
};
