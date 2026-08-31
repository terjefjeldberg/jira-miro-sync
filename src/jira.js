import { config, FIXED_MIRO_USERS, normalizeIssueKey, normalizeStatus, reporterMapKey } from './config.js';

const DEFAULT_TEXT = 'Created from Miro sticky note';
const adf = text => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const meaningful = value => value != null && (typeof value !== 'string' || value.trim()) && (!Array.isArray(value) || value.length) && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length);

export function jiraApi(env) {
  return {
    base: `https://api.atlassian.com/ex/jira/${encodeURIComponent(env.JIRA_CLOUD_ID)}/rest/api/3`,
    headers: { Authorization: `Bearer ${env.JIRA_API_TOKEN}`, Accept: 'application/json' },
  };
}

async function request(env, path, init = {}) {
  const { base, headers } = jiraApi(env);
  return fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
}

export async function getIssue(env, issueKey, fields) {
  const query = fields?.length ? `?fields=${fields.map(encodeURIComponent).join(',')}` : '';
  const response = await request(env, `/issue/${encodeURIComponent(issueKey)}${query}`);
  if (!response.ok) return { ok: false, status: response.status, error: await response.text() };
  return { ok: true, issue: await response.json() };
}

export async function getCardData(env, issueKey) {
  const { fields } = config(env);
  const result = await getIssue(env, issueKey, ['summary', 'priority', 'assignee', 'issuetype', 'status', fields.originalMiroCreated]);
  if (!result.ok) return result;
  const f = result.issue?.fields || {};
  return {
    ok: true,
    issueKey: normalizeIssueKey(issueKey),
    summary: String(f.summary ?? ''),
    priority: String(f.priority?.name ?? 'None'),
    assignee: String(f.assignee?.displayName ?? 'Unassigned'),
    workType: String(f.issuetype?.name ?? 'Unknown'),
    status: String(f.status?.name ?? ''),
    originalMiroCreated: f[fields.originalMiroCreated] ?? null,
  };
}

export async function transitionIssue(env, issueKey, desiredStatus, { enforceTestArea = true } = {}) {
  const cfg = config(env);
  const normalized = normalizeStatus(desiredStatus);
  const allowed = new Set(cfg.layout.columns.map(column => normalizeStatus(column.status)));
  if (!allowed.has(normalized)) return { ok: true, changed: false, ignored: true, reason: `Unapproved status: ${desiredStatus}` };

  const read = await getIssue(env, issueKey, ['status', cfg.fields.testArea]);
  if (!read.ok) return { ok: false, status: 502, stage: 'read-current-status', jiraStatus: read.status, error: read.error };
  const currentStatus = String(read.issue?.fields?.status?.name ?? '');
  if (enforceTestArea && normalized === 'functional review' && !meaningful(read.issue?.fields?.[cfg.fields.testArea])) {
    return { ok: false, status: 409, changed: false, rejected: true, reason: 'TEST_AREA_REQUIRED', issueKey, currentStatus, desiredStatus, fieldId: cfg.fields.testArea, message: 'Test area must be filled in before moving to Functional review.' };
  }
  if (normalizeStatus(currentStatus) === normalized) return { ok: true, changed: false, issueKey, currentStatus, desiredStatus, reason: 'Jira already has desired status' };

  const transitionsResponse = await request(env, `/issue/${encodeURIComponent(issueKey)}/transitions`);
  if (!transitionsResponse.ok) return { ok: false, status: 502, stage: 'read-transitions', jiraStatus: transitionsResponse.status, error: await transitionsResponse.text() };
  const transitions = (await transitionsResponse.json())?.transitions || [];
  const destinations = transitions.filter(t => normalizeStatus(t?.to?.name) === normalized);
  const preferred = destinations.filter(t => String(t?.name ?? '').trim().toLowerCase().startsWith('move to '));
  const selected = preferred.length === 1 ? preferred[0] : preferred.length === 0 && destinations.length === 1 ? destinations[0] : null;
  if (!selected?.id) return { ok: false, status: 409, changed: false, reason: 'No unique approved Jira transition found', issueKey, currentStatus, desiredStatus };

  const response = await request(env, `/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transition: { id: String(selected.id) } }),
  });
  if (!response.ok) return { ok: false, status: response.status >= 400 && response.status < 500 ? 409 : 502, changed: false, rejected: true, stage: 'transition', jiraStatus: response.status, issueKey, currentStatus, desiredStatus, error: await response.text() };
  return { ok: true, changed: true, issueKey, fromStatus: currentStatus, toStatus: desiredStatus, transitionId: selected.id, transitionName: selected.name };
}

function createField(fields, id) {
  return fields.find(field => String(field?.fieldId ?? '') === id) || null;
}

function option(field, value) {
  const wanted = String(value).trim().toLowerCase();
  return (Array.isArray(field?.allowedValues) ? field.allowedValues : []).find(item => String(item?.value ?? item?.name ?? '').trim().toLowerCase() === wanted) || null;
}

function textValue(field, text) {
  const schema = String(field?.schema?.type ?? '').toLowerCase();
  const custom = String(field?.schema?.custom ?? '').toLowerCase();
  return schema === 'doc' || custom.includes(':textarea') ? adf(text) : text;
}

export async function createIssueFromSticky(env, summary, workType) {
  const cfg = config(env);
  summary = String(summary ?? '').replace(/\s+/g, ' ').trim();
  const allowed = new Set(['Bug', 'Improvement', 'Spike', 'New Feature', 'Hotfix candidate', 'Task/config/doc/test']);
  if (!summary) return { ok: false, status: 400, reason: 'Sticky note has no text' };
  if (summary.length > 255) return { ok: false, status: 400, reason: 'Sticky text is too long for Jira summary', maxLength: 255 };
  if (!allowed.has(workType)) return { ok: false, status: 400, reason: 'Unapproved work type', workType };

  const typesResponse = await request(env, `/issue/createmeta/${encodeURIComponent(cfg.jiraProjectKey)}/issuetypes?maxResults=100`);
  if (!typesResponse.ok) return { ok: false, status: 502, stage: 'read-create-issue-types', jiraStatus: typesResponse.status, error: await typesResponse.text() };
  const types = (await typesResponse.json())?.issueTypes || [];
  const type = types.find(item => String(item?.name ?? '').trim().toLowerCase() === workType.toLowerCase());
  if (!type?.id) return { ok: false, status: 409, reason: `Jira work type was not found in project ${cfg.jiraProjectKey}`, workType, availableWorkTypes: types.map(item => item?.name).filter(Boolean) };

  const metaResponse = await request(env, `/issue/createmeta/${encodeURIComponent(cfg.jiraProjectKey)}/issuetypes/${encodeURIComponent(String(type.id))}?maxResults=200`);
  if (!metaResponse.ok) return { ok: false, status: 502, stage: 'read-create-field-metadata', jiraStatus: metaResponse.status, error: await metaResponse.text() };
  const fields = (await metaResponse.json())?.fields || [];
  const createFields = { project: { key: cfg.jiraProjectKey }, summary, issuetype: { id: String(type.id) } };
  const applied = {};

  if (workType === 'Bug') {
    const customer = createField(fields, cfg.fields.bugCustomer);
    const selected = option(customer, DEFAULT_TEXT);
    if (!customer || !selected?.id) return { ok: false, status: 409, stage: 'find-bug-sticky-defaults', reason: 'Required Bug sticky-conversion field or option was not found', fieldId: cfg.fields.bugCustomer };
    createFields[cfg.fields.bugRepro] = adf(`${DEFAULT_TEXT}.`);
    createFields[cfg.fields.bugCustomer] = { id: String(selected.id) };
    applied.reproSteps = { fieldId: cfg.fields.bugRepro, value: `${DEFAULT_TEXT}.` };
    applied.customer = { fieldId: cfg.fields.bugCustomer, optionId: String(selected.id), value: selected.value ?? selected.name ?? DEFAULT_TEXT };
  }

  if (workType === 'New Feature' || workType === 'Improvement') {
    const ids = [cfg.fields.nfDropdown1, cfg.fields.nfText1, cfg.fields.nfText2, cfg.fields.nfDropdown2];
    const found = Object.fromEntries(ids.map(id => [id, createField(fields, id)]));
    const missing = ids.filter(id => !found[id]);
    if (missing.length) return { ok: false, status: 409, stage: 'find-new-feature-improvement-fields', reason: 'One or more required sticky-conversion fields were not found in Jira create metadata', workType, missingFieldIds: missing };
    const first = option(found[cfg.fields.nfDropdown1], DEFAULT_TEXT);
    const second = option(found[cfg.fields.nfDropdown2], DEFAULT_TEXT);
    if (!first?.id || !second?.id) return { ok: false, status: 409, stage: 'find-new-feature-improvement-dropdown-option', reason: `Dropdown option "${DEFAULT_TEXT}" was not found`, workType };
    createFields[cfg.fields.nfDropdown1] = { id: String(first.id) };
    createFields[cfg.fields.nfText1] = textValue(found[cfg.fields.nfText1], DEFAULT_TEXT);
    createFields[cfg.fields.nfText2] = textValue(found[cfg.fields.nfText2], DEFAULT_TEXT);
    createFields[cfg.fields.nfDropdown2] = { id: String(second.id) };
    applied[cfg.fields.nfDropdown1] = DEFAULT_TEXT;
    applied[cfg.fields.nfText1] = DEFAULT_TEXT;
    applied[cfg.fields.nfText2] = DEFAULT_TEXT;
    applied[cfg.fields.nfDropdown2] = DEFAULT_TEXT;
  }

  if (workType === 'Task/config/doc/test') {
    const field = createField(fields, cfg.fields.taskRequired);
    if (!field) return { ok: false, status: 409, stage: 'find-task-required-field', reason: `Required field ${cfg.fields.taskRequired} was not found`, workType };
    createFields[cfg.fields.taskRequired] = textValue(field, DEFAULT_TEXT);
    applied[cfg.fields.taskRequired] = DEFAULT_TEXT;
  }

  const response = await request(env, '/issue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: createFields }) });
  if (!response.ok) return { ok: false, status: response.status >= 400 && response.status < 500 ? response.status : 502, stage: 'create-jira-issue', jiraStatus: response.status, workType, stickyDefaultsApplied: applied, error: await response.text() };
  const created = await response.json();
  return { ok: true, created: true, issueKey: normalizeIssueKey(created.key), workType, summary, jiraIssueTypeId: String(type.id), stickyDefaults: applied };
}

function userIdentity(value) {
  if (!value) return { id: '', name: '', email: '' };
  if (typeof value === 'string') return { id: value.trim(), name: '', email: '' };
  return {
    id: String(value.id ?? value.memberId ?? value.user?.id ?? value.data?.id ?? '').trim(),
    name: String(value.name ?? value.displayName ?? value.user?.name ?? value.user?.displayName ?? value.data?.name ?? '').trim(),
    email: String(value.email ?? value.emailAddress ?? value.user?.email ?? value.user?.emailAddress ?? value.data?.email ?? '').trim(),
  };
}

async function miroMember(env, id) {
  const headers = { Authorization: `Bearer ${env.MIRO_TOKEN}`, Accept: 'application/json' };
  const direct = await fetch(`https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/members/${encodeURIComponent(id)}`, { headers });
  if (direct.ok) {
    const identity = userIdentity(await direct.json());
    if (identity.name) return identity;
  }
  let cursor = '';
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/members`);
    url.searchParams.set('limit', '50');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, { headers });
    if (!response.ok) break;
    const body = await response.json();
    for (const member of body?.data || []) {
      const identity = userIdentity(member);
      if (identity.id === id && identity.name) return identity;
    }
    cursor = String(body?.cursor ?? '').trim();
    if (!cursor) break;
  }
  return null;
}

async function miroScim(env, id) {
  const response = await fetch(`https://miro.com/api/v1/scim/Users/${encodeURIComponent(id)}?attributes=id,displayName,name,userName,emails`, {
    headers: { Authorization: `Bearer ${env.MIRO_TOKEN}`, Accept: 'application/scim+json, application/json' },
  });
  if (!response.ok) return null;
  const user = await response.json();
  const name = String(user?.displayName ?? `${user?.name?.givenName ?? ''} ${user?.name?.familyName ?? ''}`).trim();
  const email = String(user?.userName ?? (user?.emails || []).find(item => item?.primary)?.value ?? user?.emails?.[0]?.value ?? '').trim();
  return name ? { id, name, email } : null;
}

async function jiraUserByName(env, displayName) {
  const wanted = displayName.trim().toLocaleLowerCase();
  const { base, headers } = jiraApi(env);
  const endpoints = [
    `/user/picker?query=${encodeURIComponent(displayName)}&showAvatar=false&excludeConnectUsers=true&maxResults=50`,
    `/user/assignable/search?project=${encodeURIComponent(config(env).jiraProjectKey)}&query=${encodeURIComponent(displayName)}&maxResults=50`,
  ];
  for (const path of endpoints) {
    const response = await fetch(`${base}${path}`, { headers });
    if (!response.ok) continue;
    const body = await response.json();
    const users = Array.isArray(body) ? body : body?.users || [];
    const matches = users.filter(user => user?.active !== false && String(user?.accountType ?? 'atlassian') !== 'app' && String(user?.accountId ?? '').trim() && String(user?.displayName ?? '').trim().toLocaleLowerCase() === wanted);
    if (matches.length === 1) return { accountId: String(matches[0].accountId), displayName: String(matches[0].displayName ?? displayName), source: path.startsWith('/user/picker') ? 'user-picker' : 'assignable-search' };
  }

  // Some Jira tenants reject the user lookup endpoints. Preserve the existing
  // fallback: infer the unique account ID from recent issues where the person
  // appears as reporter or assignee.
  const escaped = String(displayName).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const jql = `(reporter = \"${escaped}\" OR assignee = \"${escaped}\") ORDER BY updated DESC`;
  const response = await fetch(`${base}/search/jql?jql=${encodeURIComponent(jql)}&fields=reporter,assignee&maxResults=100`, { headers });
  if (!response.ok) return null;
  const issues = (await response.json())?.issues || [];
  const matches = new Map();
  for (const issue of issues) for (const user of [issue?.fields?.reporter, issue?.fields?.assignee]) {
    if (user && String(user?.displayName ?? '').trim().toLocaleLowerCase() === wanted && String(user?.accountId ?? '').trim()) matches.set(String(user.accountId), user);
  }
  if (matches.size !== 1) return null;
  const user = [...matches.values()][0];
  return { accountId: String(user.accountId), displayName: String(user.displayName ?? displayName), source: 'issue-search' };
}

export async function resolveReporter(env, stickyId, claimedCreatorId) {
  const id = String(stickyId ?? '').trim();
  if (!id || !env.MIRO_TOKEN || !env.MIRO_BOARD_ID) return { ok: false, status: 409, stage: 'reporter-miro-config', reason: 'Missing sticky ID or Miro REST configuration' };
  const response = await fetch(`https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/items/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${env.MIRO_TOKEN}`, Accept: 'application/json' } });
  if (!response.ok) return { ok: false, status: 409, stage: 'reporter-read-miro-sticky', reason: `Miro item lookup returned HTTP ${response.status}` };
  const sticky = await response.json();
  if (sticky?.type !== 'sticky_note') return { ok: false, status: 409, stage: 'reporter-verify-miro-sticky', reason: 'The supplied Miro item is not a sticky note' };
  let creator = userIdentity(sticky.createdBy);
  if (claimedCreatorId && creator.id && creator.id !== String(claimedCreatorId)) return { ok: false, status: 409, stage: 'reporter-verify-created-by', reason: 'Miro createdBy did not match the selected sticky' };
  if (!creator.id) creator.id = String(claimedCreatorId ?? '').trim();
  if (!creator.id) return { ok: false, status: 409, stage: 'reporter-miro-creator-id', reason: 'Miro did not return a creator ID for the sticky note' };

  const cached = env.CARD_MAP ? await env.CARD_MAP.get(reporterMapKey(creator.id), 'json').catch(() => null) : null;
  if (cached?.accountId) return { ok: true, creatorId: creator.id, creatorName: String(cached.displayName ?? ''), accountId: String(cached.accountId), source: 'kv-cache', createdAt: sticky.createdAt };

  if (!creator.name && FIXED_MIRO_USERS[creator.id]) creator.name = FIXED_MIRO_USERS[creator.id];
  if (!creator.name) creator = (await miroMember(env, creator.id)) || creator;
  if (!creator.name) creator = (await miroScim(env, creator.id)) || creator;
  if (!creator.name) return { ok: false, status: 409, stage: 'reporter-miro-creator-name', reason: `Could not resolve Miro creator ${creator.id}`, miroCreatorId: creator.id };

  const jiraUser = await jiraUserByName(env, creator.name);
  if (!jiraUser) return { ok: false, status: 409, stage: 'reporter-jira-account-id-unresolved', reason: `Could not resolve Jira accountId for ${creator.name}`, miroCreatorId: creator.id, miroCreatorName: creator.name };
  if (env.CARD_MAP) await env.CARD_MAP.put(reporterMapKey(creator.id), JSON.stringify(jiraUser));
  return { ok: true, creatorId: creator.id, creatorName: creator.name, accountId: jiraUser.accountId, source: jiraUser.source || 'jira-user-search', createdAt: sticky.createdAt };
}

export async function applyReporter(env, issueKey, reporter) {
  if (!reporter?.accountId) return { ok: false, stage: 'reporter-jira-account-id', reason: 'Reporter account ID is missing' };
  const response = await request(env, `/issue/${encodeURIComponent(issueKey)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { reporter: { accountId: String(reporter.accountId) } } }),
  });
  if (!response.ok) return { ok: false, status: 409, stage: 'reporter-jira-update', reason: `Jira rejected Reporter update with HTTP ${response.status}`, jiraStatus: response.status, error: await response.text() };
  return { ok: true, applied: true, accountId: String(reporter.accountId), displayName: reporter.creatorName };
}

function jiraDate(value) {
  const date = new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().replace(/Z$/, '+0000');
}

export async function applyStickyMetadata(env, issueKey, reporter) {
  const cfg = config(env);
  const created = jiraDate(reporter.createdAt);
  if (!created) return { ok: true, skipped: true, reason: 'Original Miro timestamp unavailable' };
  const response = await request(env, `/issue/${encodeURIComponent(issueKey)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { [cfg.fields.originalMiroCreated]: created } }) });
  if (!response.ok) return { ok: false, stage: 'original-miro-created-jira-update', reason: `Jira rejected Original Miro created update with HTTP ${response.status}`, error: await response.text() };
  return { ok: true, reporter: reporter.creatorName, originalMiroCreated: created };
}
