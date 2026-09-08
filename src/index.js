import { config, customMapKey, directPendingKey, freezeKey, issueKeyIsValid, normalizeIssueKey, stickyIssueKey } from './config.js';
import { json, preflight, readJson, requireJiraWebhook, requireMiro } from './auth.js';
import { addIssueComment, applyReporter, applyStickyMetadata, createIssueFromSticky, getCardData, listIssueComments, resolveReporter, transitionIssue } from './jira.js';
import { createDirectCard, createIncomingCard, refreshCard, syncCommentIndicator } from './cards.js';
import { issueKeyFromImage, listItems, moveMappedItemToStatus, registerMappings } from './miro.js';
import { renderApp, renderAppClient, renderCommentsClient, renderCommentsModal, renderPanel, renderPanelClient } from './ui.js';

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
  return json({ ok: true, registered: mappings.length, mappings });
}

async function miroToJira(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const body = parsed.body;
  const boardId = String(body.boardId ?? '').trim();
  const issueKey = normalizeIssueKey(body.issueKey);
  const itemId = String(body.itemId ?? '').trim();
  const desiredStatus = String(body.desiredStatus ?? '').trim();
  if (boardId !== String(env.MIRO_BOARD_ID)) return json({ ok: false, reason: 'Wrong Miro board' }, 403);
  if (!issueKeyIsValid(issueKey, env)) return json({ ok: true, ignored: true, reason: `Only ${config(env).jiraProjectKey} issues are approved` });
  if (!itemId) return json({ ok: false, reason: 'Missing custom-card image ID' }, 400);
  await env.CARD_MAP.put(customMapKey(issueKey), itemId);

  const live = await getCardData(env, issueKey).catch(() => null);
  if (live?.ok && String(live.status ?? '').trim().toLowerCase() === desiredStatus.toLowerCase()) {
    return json({ ok: true, changed: false, issueKey, itemId, currentStatus: live.status, desiredStatus, reason: 'Jira already has desired status' });
  }

  const result = await transitionIssue(env, issueKey, desiredStatus, { enforceTestArea: true });
  return json({ ...result, issueKey, itemId }, result.ok ? 200 : (result.status || 500));
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

async function addJiraComment(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const issueKey = normalizeIssueKey(parsed.body.issueKey);
  const itemId = String(parsed.body.itemId ?? '').trim();
  if (!issueKeyIsValid(issueKey, env) || !itemId) return json({ ok: false, reason: 'Invalid issue key or Miro item ID' }, 400);
  const mappedItemId = String(await env.CARD_MAP.get(customMapKey(issueKey)) ?? '').trim();
  if (!mappedItemId || mappedItemId !== itemId) return json({ ok: false, reason: 'Miro card is not mapped to this Jira issue' }, 403);
  const result = await addIssueComment(env, issueKey, parsed.body.comment);
  if (result.ok) await syncCommentIndicator(env, issueKey).catch(error => console.error('Comment indicator sync failed', error));
  return json({ ...result, issueKey, itemId }, result.ok ? 200 : (result.status || 502));
}

async function directCard(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const issueKey = normalizeIssueKey(parsed.body.issueKey), x = Number(parsed.body.x), y = Number(parsed.body.y);
  if (!issueKeyIsValid(issueKey, env) || !Number.isFinite(x) || !Number.isFinite(y)) return json({ ok: false, reason: 'Invalid issue key or position' }, 400);
  const result = await createDirectCard(env, issueKey, x, y);
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
    result = await transitionIssue(env, issueKey, desiredStatus, { enforceTestArea: false, firstMatchingTransition: true });
    if (result.ok) break;
  }
  if (!result.ok) {
    await Promise.all([env.CARD_MAP.delete(freezeKey(issueKey)), env.CARD_MAP.delete(directPendingKey(issueKey))]);
  } else {
    await env.CARD_MAP.delete(directPendingKey(issueKey));
  }
  return json({ ...result, issueKey }, result.ok ? 200 : (result.status || 500));
}

async function processJiraWebhookBody(body, env) {
  const issueKey = normalizeIssueKey(body.issueKey);
  if (!issueKeyIsValid(issueKey, env)) return json({ ok: true, ignored: true, reason: `Only ${config(env).jiraProjectKey} issues are approved`, issueKey });

  let status = String(body.status ?? '').trim();
  let live = await getCardData(env, issueKey).catch(() => null);
  if (live?.ok && live.status) status = live.status;

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
    await env.CARD_MAP.delete(directPendingKey(issueKey));
    if (isInitialStatus) {
      return json({ ok: true, moved: false, issueKey, status, conversionDirectCreatePending: true, suppressionSource: 'kv-marker' });
    }
  }

  if (!customId) {
    const incomingCreate = await createIncomingCard(env, issueKey);
    if (incomingCreate.ok !== false) await syncCommentIndicator(env, issueKey).catch(error => console.error('Comment indicator sync failed', error));
    return json({ ok: incomingCreate.ok !== false, moved: false, issueKey, status, incomingCreate }, incomingCreate.ok === false ? (incomingCreate.status || 500) : 200);
  }

  // Replacing the SVG can also affect image item metadata in Miro. Refresh the
  // resource first and make the position update the final write, so a Jira
  // status change always leaves the card in the intended column.
  const customRefresh = await refreshCard(env, issueKey);
  if (customRefresh.ok !== false) await syncCommentIndicator(env, issueKey).catch(error => console.error('Comment indicator sync failed', error));
  const custom = await moveMappedItemToStatus(env, String(customId), status);
  if (custom?.missing) {
    await env.CARD_MAP.delete(customMapKey(issueKey));
    const incomingCreate = await createIncomingCard(env, issueKey);
    return json({ ok: incomingCreate.ok !== false, moved: false, issueKey, status, staleMappingRemoved: true, incomingCreate }, incomingCreate.ok === false ? (incomingCreate.status || 500) : 200);
  }
  const ok = custom.ok !== false && customRefresh.ok !== false;
  return json({ ok, issueKey, status, moved: Boolean(custom.moved), mappingRecoveredFromBoard, custom, customRefresh }, ok ? 200 : 500);
}

async function jiraWebhook(request, env) {
  if (!env.JIRA_WEBHOOK_SECRET) return json({ ok: false, reason: 'JIRA_WEBHOOK_SECRET is not configured' }, 500);
  if (!requireJiraWebhook(request, env)) return json({ ok: false, reason: 'Invalid Jira webhook secret' }, 401);
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const body = parsed.body;
  const issueKey = normalizeIssueKey(body.issueKey);
  if (!issueKeyIsValid(issueKey, env)) return json({ ok: true, ignored: true, reason: `Only ${config(env).jiraProjectKey} issues are approved`, issueKey });

  // When the Queue binding exists, acknowledge Jira immediately and let the
  // consumer perform the potentially slow Jira/Miro work. Until then the
  // existing synchronous path remains active as a safe fallback.
  if (env.JIRA_WEBHOOK_QUEUE && typeof env.JIRA_WEBHOOK_QUEUE.send === 'function') {
    try {
      await env.JIRA_WEBHOOK_QUEUE.send({ ...body, issueKey, queuedAt: new Date().toISOString() });
      return json({ ok: true, accepted: true, queued: true, issueKey }, 202);
    } catch (error) {
      console.error('Failed to enqueue Jira webhook', error);
      return json({ ok: false, accepted: false, queued: false, issueKey, reason: 'Queue unavailable' }, 503);
    }
  }

  return processJiraWebhookBody(body, env);
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      const response = await processJiraWebhookBody(message.body ?? {}, env);
      if (response.status >= 500) {
        throw new Error(`Jira webhook processing failed with HTTP ${response.status}`);
      }
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url), method = request.method, path = url.pathname;
    if (method === 'OPTIONS') return preflight();
    if (method === 'GET' && path === '/health') {
      const cfg = config(env);
      return json({ ok: true, cardMapConfigured: Boolean(env.CARD_MAP), jiraWebhookQueueConfigured: Boolean(env.JIRA_WEBHOOK_QUEUE), miroClientSecretConfigured: Boolean(env.MIRO_CLIENT_SECRET), miroTokenConfigured: Boolean(env.MIRO_TOKEN), miroBoardConfigured: Boolean(env.MIRO_BOARD_ID), jiraTokenConfigured: Boolean(env.JIRA_API_TOKEN), jiraCloudIdConfigured: Boolean(env.JIRA_CLOUD_ID), jiraWebhookSecretConfigured: Boolean(env.JIRA_WEBHOOK_SECRET), projectKey: cfg.jiraProjectKey, incomingFrameId: cfg.incomingFrameId, testAreaField: cfg.fields.testArea });
    }
    if (method === 'GET' && path === '/miro-app') return renderApp();
    if (method === 'GET' && path === '/app.js') return renderAppClient(env);
    if (method === 'GET' && path === '/miro-panel') return renderPanel();
    if (method === 'GET' && path === '/panel.js') return renderPanelClient(env);
    if (method === 'GET' && path === '/comments.js') return renderCommentsClient();
    if (method === 'GET' && path === '/jira-comments-modal') return renderCommentsModal();
    if (method === 'GET' && path === '/jira-comments') return jiraComments(request, env);
    if (method === 'POST' && path === '/jira-comments') return addJiraComment(request, env);
    if (method === 'POST' && path === '/register-custom-cards') return register(request, env);
    if (method === 'POST' && path === '/custom-miro-to-jira') return miroToJira(request, env);
    if (method === 'POST' && path === '/sticky-to-jira') return stickyToJira(request, env);
    if (method === 'POST' && path === '/conversion-direct-card') return directCard(request, env);
    if (method === 'POST' && path === '/conversion-set-status') return setConversionStatus(request, env);
    if (method === 'POST' && path === '/') return jiraWebhook(request, env);
    return new Response('Not found', { status: 404 });
  },
};