import { config, customMapKey, directPendingKey, freezeKey, issueKeyIsValid, nativeMapKey, normalizeIssueKey } from './config.js';
import { json, preflight, readJson, requireJiraWebhook, requireMiro } from './auth.js';
import { applyReporter, applyStickyMetadata, createIssueFromSticky, getCardData, resolveReporter, transitionIssue } from './jira.js';
import { createDirectCard, createIncomingCard, refreshCard } from './cards.js';
import { moveMappedItemToStatus, registerMappings } from './miro.js';
import { renderApp, renderAppClient, renderPanel, renderPanelClient } from './ui.js';

async function requireMiroJson(request, env) {
  return (await requireMiro(request, env)) ? null : json({ ok: false, reason: 'Invalid Miro identity token' }, 401);
}

async function bodyOr400(request) {
  const body = await readJson(request);
  return body == null ? { error: json({ ok: false, reason: 'Invalid JSON' }, 400) } : { body };
}

async function register(request, env, kind) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const boardId = String(parsed.body.boardId ?? '').trim();
  if (boardId !== String(env.MIRO_BOARD_ID)) return json({ ok: false, reason: 'Wrong Miro board' }, 403);
  const entries = Array.isArray(parsed.body.cards) ? parsed.body.cards : [];
  const mappings = await registerMappings(env, entries, kind);
  return json({ ok: true, registered: mappings.length, mappings });
}

async function miroToJira(request, env, custom) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const body = parsed.body, boardId = String(body.boardId ?? '').trim(), issueKey = normalizeIssueKey(body.issueKey), itemId = String(custom ? body.groupId ?? body.itemId ?? '' : body.itemId ?? '').trim(), desiredStatus = String(body.desiredStatus ?? '').trim();
  if (boardId !== String(env.MIRO_BOARD_ID)) return json({ ok: false, reason: 'Wrong Miro board' }, 403);
  if (!issueKeyIsValid(issueKey, env)) return json({ ok: true, ignored: true, reason: `Only ${config(env).jiraProjectKey} issues are approved` });
  if (!itemId) return json({ ok: false, reason: custom ? 'Missing custom-card container ID' : 'Missing Miro item ID' }, 400);
  await env.CARD_MAP.put((custom ? customMapKey : nativeMapKey)(issueKey), itemId);
  const result = await transitionIssue(env, issueKey, desiredStatus, { enforceTestArea: true });
  return json({ ...result, issueKey, ...(custom ? { groupId: itemId } : { itemId }) }, result.ok ? 200 : (result.status || 500));
}

async function stickyToJira(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const body = parsed.body;
  const reporter = await resolveReporter(env, body.stickyId, body.createdBy);
  if (!reporter.ok) return json(reporter, reporter.status || 409);
  const created = await createIssueFromSticky(env, body.summary, String(body.workType ?? '').trim());
  if (!created.ok) return json(created, created.status || 500);
  await env.CARD_MAP.put(directPendingKey(created.issueKey), JSON.stringify({ stickyId: String(body.stickyId ?? '') }), { expirationTtl: 90 });
  const reporterUpdate = await applyReporter(env, created.issueKey, reporter);
  if (!reporterUpdate.ok) return json({ ...created, ok: false, reason: reporterUpdate.reason, reporterSync: reporterUpdate }, reporterUpdate.status || 409);
  const originalMiroCreatedSync = await applyStickyMetadata(env, created.issueKey, reporter);
  return json({ ...created, reporterSync: { ok: true, applied: true, miroCreatorId: reporter.creatorId, miroCreatorName: reporter.creatorName, jiraReporterAccountId: reporter.accountId, jiraReporterSource: reporter.source }, originalMiroCreatedSync });
}

async function directCard(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const issueKey = normalizeIssueKey(parsed.body.issueKey), x = Number(parsed.body.x), y = Number(parsed.body.y);
  if (!issueKeyIsValid(issueKey, env) || !Number.isFinite(x) || !Number.isFinite(y)) return json({ ok: false, reason: 'Invalid issue key or position' }, 400);
  const result = await createDirectCard(env, issueKey, x, y);
  if (result.ok) await env.CARD_MAP.delete(directPendingKey(issueKey));
  return json(result, result.ok ? 200 : (result.status || 500));
}

async function setConversionStatus(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const issueKey = normalizeIssueKey(parsed.body.issueKey), desiredStatus = String(parsed.body.desiredStatus ?? '').trim();
  if (!issueKeyIsValid(issueKey, env)) return json({ ok: false, reason: 'Invalid issue key' }, 400);
  await env.CARD_MAP.put(freezeKey(issueKey), JSON.stringify({ desiredStatus }), { expirationTtl: 30 });
  const result = await transitionIssue(env, issueKey, desiredStatus, { enforceTestArea: false, firstMatchingTransition: true });
  if (!result.ok || !result.changed) await env.CARD_MAP.delete(freezeKey(issueKey));
  return json({ ...result, issueKey }, result.ok ? 200 : (result.status || 500));
}

async function conversionCardId(request, env) {
  const auth = await requireMiroJson(request, env); if (auth) return auth;
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const issueKey = normalizeIssueKey(parsed.body.issueKey);
  if (!issueKeyIsValid(issueKey, env)) return json({ ok: false, reason: 'Invalid issue key' }, 400);
  const itemId = String(await env.CARD_MAP.get(customMapKey(issueKey)) ?? '').trim();
  return json({ ok: true, issueKey, mapped: Boolean(itemId), itemId: itemId || null });
}

async function jiraWebhook(request, env) {
  if (!env.JIRA_WEBHOOK_SECRET) return json({ ok: false, reason: 'JIRA_WEBHOOK_SECRET is not configured' }, 500);
  if (!requireJiraWebhook(request, env)) return json({ ok: false, reason: 'Invalid Jira webhook secret' }, 401);
  const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
  const issueKey = normalizeIssueKey(parsed.body.issueKey);
  if (!issueKeyIsValid(issueKey, env)) return json({ ok: true, ignored: true, reason: `Only ${config(env).jiraProjectKey} issues are approved`, issueKey });

  let status = String(parsed.body.status ?? '').trim();
  const live = await getCardData(env, issueKey).catch(() => null);
  if (live?.ok && live.status) status = live.status;

  const frozen = await env.CARD_MAP.get(freezeKey(issueKey), 'json').catch(() => null);
  if (frozen?.desiredStatus && String(frozen.desiredStatus).trim().toLowerCase() === status.toLowerCase()) {
    await env.CARD_MAP.delete(freezeKey(issueKey));
    return json({ ok: true, moved: false, issueKey, status, conversionPositionPreserved: true });
  }

  let [nativeId, customId, directPending] = await Promise.all([
    env.CARD_MAP.get(nativeMapKey(issueKey)),
    env.CARD_MAP.get(customMapKey(issueKey)),
    env.CARD_MAP.get(directPendingKey(issueKey)),
  ]);

  if (!nativeId && !customId && !directPending) {
    await new Promise(resolve => setTimeout(resolve, 750));
    [nativeId, customId, directPending] = await Promise.all([
      env.CARD_MAP.get(nativeMapKey(issueKey)),
      env.CARD_MAP.get(customMapKey(issueKey)),
      env.CARD_MAP.get(directPendingKey(issueKey)),
    ]);
  }

  if (!customId && directPending) return json({ ok: true, moved: false, issueKey, status, conversionDirectCreatePending: true });

  if (!nativeId && !customId) {
    const incomingCreate = await createIncomingCard(env, issueKey);
    return json({ ok: incomingCreate.ok !== false, moved: false, issueKey, status, incomingCreate }, incomingCreate.ok === false ? (incomingCreate.status || 500) : 200);
  }

  const [native, custom] = await Promise.all([
    nativeId ? moveMappedItemToStatus(env, String(nativeId), status, { native: true }) : Promise.resolve({ ok: true, mapped: false, moved: false }),
    customId ? moveMappedItemToStatus(env, String(customId), status) : Promise.resolve({ ok: true, mapped: false, moved: false }),
  ]);
  const customRefresh = customId ? await refreshCard(env, issueKey) : null;

  if (native?.missing) await env.CARD_MAP.delete(nativeMapKey(issueKey));
  if (custom?.missing) await env.CARD_MAP.delete(customMapKey(issueKey));
  const ok = native.ok !== false && custom.ok !== false && (!customRefresh || customRefresh.ok !== false);
  return json({ ok, issueKey, status, moved: Boolean(native.moved || custom.moved), native, custom, customRefresh }, ok ? 200 : 500);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), method = request.method, path = url.pathname;
    if (method === 'OPTIONS') return preflight();
    if (method === 'GET' && path === '/health') {
      const cfg = config(env);
      return json({ ok: true, cardMapConfigured: Boolean(env.CARD_MAP), miroClientSecretConfigured: Boolean(env.MIRO_CLIENT_SECRET), miroTokenConfigured: Boolean(env.MIRO_TOKEN), miroBoardConfigured: Boolean(env.MIRO_BOARD_ID), jiraTokenConfigured: Boolean(env.JIRA_API_TOKEN), jiraCloudIdConfigured: Boolean(env.JIRA_CLOUD_ID), jiraWebhookSecretConfigured: Boolean(env.JIRA_WEBHOOK_SECRET), projectKey: cfg.jiraProjectKey, incomingFrameId: cfg.incomingFrameId, testAreaField: cfg.fields.testArea });
    }
    if (method === 'GET' && path === '/miro-app') return renderApp();
    if (method === 'GET' && path === '/app.js') return renderAppClient(env);
    if (method === 'GET' && path === '/miro-panel') return renderPanel();
    if (method === 'GET' && path === '/panel.js') return renderPanelClient(env);
    if (method === 'POST' && path === '/register-cards') return register(request, env, 'native');
    if (method === 'POST' && path === '/register-custom-cards') return register(request, env, 'custom');
    if (method === 'POST' && path === '/miro-to-jira') return miroToJira(request, env, false);
    if (method === 'POST' && path === '/custom-miro-to-jira') return miroToJira(request, env, true);
    if (method === 'POST' && path === '/sticky-to-jira') return stickyToJira(request, env);
    if (method === 'POST' && path === '/conversion-direct-card') return directCard(request, env);
    if (method === 'POST' && path === '/conversion-set-status') return setConversionStatus(request, env);
    if (method === 'POST' && path === '/conversion-card-id') return conversionCardId(request, env);
    if (method === 'POST' && path === '/jira-card-data') {
      const auth = await requireMiroJson(request, env); if (auth) return auth;
      const parsed = await bodyOr400(request); if (parsed.error) return parsed.error;
      const issueKey = normalizeIssueKey(parsed.body.issueKey), data = await getCardData(env, issueKey);
      return json(data.ok ? { ...data, browseUrl: `${config(env).jiraSiteUrl}/browse/${encodeURIComponent(issueKey)}` } : data, data.ok ? 200 : 502);
    }
    if (method === 'POST' && path === '/custom-card-pending') {
      const auth = await requireMiroJson(request, env); if (auth) return auth;
      return json({ ok: true, moves: [], disabled: true, reason: 'Jira -> Miro custom movement is handled server-side' });
    }
    if (method === 'POST' && path === '/custom-card-ack') {
      const auth = await requireMiroJson(request, env); if (auth) return auth;
      return json({ ok: true, acknowledged: true });
    }
    if (method === 'POST' && path === '/') return jiraWebhook(request, env);
    return new Response('Not found', { status: 404 });
  },
};
