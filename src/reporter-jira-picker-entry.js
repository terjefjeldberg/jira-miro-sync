import fallbackWorker from "./reporter-fallback-entry.js";
import previewWorker from "./preview-entry-v2.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://miro.com",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Webhook-Secret",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function readJson(response) {
  try { return await response.clone().json(); } catch { return null; }
}

function normalizeName(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function reporterCacheKey(miroCreatorId) {
  return `reporter-account:${String(miroCreatorId ?? "").trim()}`;
}

async function readCachedReporter(env, miroCreatorId) {
  if (!env.CARD_MAP || !miroCreatorId) return null;

  try {
    const cached = await env.CARD_MAP.get(reporterCacheKey(miroCreatorId), "json");
    const accountId = String(cached?.accountId ?? "").trim();
    if (!accountId) return null;

    return {
      ok: true,
      accountId,
      displayName: String(cached?.displayName ?? "").trim(),
      source: "kv-cache",
    };
  } catch {
    return null;
  }
}

async function writeCachedReporter(env, miroCreatorId, reporter) {
  if (!env.CARD_MAP || !miroCreatorId || !reporter?.accountId) return;

  await env.CARD_MAP.put(
    reporterCacheKey(miroCreatorId),
    JSON.stringify({
      accountId: String(reporter.accountId),
      displayName: String(reporter.displayName ?? ""),
    }),
  );
}

function jiraConfig(env) {
  return {
    base: `https://api.atlassian.com/ex/jira/${encodeURIComponent(env.JIRA_CLOUD_ID)}/rest/api/3`,
    headers: {
      Authorization: `Bearer ${env.JIRA_API_TOKEN}`,
      Accept: "application/json",
    },
  };
}

async function findWithUserPicker(env, displayName) {
  const { base, headers } = jiraConfig(env);
  const response = await fetch(
    `${base}/user/picker?query=${encodeURIComponent(displayName)}&showAvatar=false&excludeConnectUsers=true&maxResults=50`,
    { headers },
  );

  if (!response.ok) {
    return { ok: false, stage: "reporter-jira-user-picker", jiraStatus: response.status, error: await response.text() };
  }

  const body = await response.json();
  const users = Array.isArray(body?.users) ? body.users : [];
  const wanted = normalizeName(displayName);
  const matches = users.filter(user =>
    normalizeName(user?.displayName) === wanted && String(user?.accountId ?? "").trim()
  );

  if (matches.length !== 1) {
    return {
      ok: false,
      stage: "reporter-jira-user-picker-match",
      reason: matches.length === 0
        ? `No exact Jira user picker match for ${displayName}`
        : `More than one Jira user picker match for ${displayName}`,
      candidates: users.map(user => user?.displayName).filter(Boolean),
    };
  }

  return { ok: true, accountId: String(matches[0].accountId), displayName: String(matches[0].displayName ?? displayName), source: "user-picker" };
}

async function findWithIssueSearch(env, displayName) {
  const { base, headers } = jiraConfig(env);
  const escaped = String(displayName).replace(/\\/g, "\\\\").replace(/\"/g, '\\"');
  const jql = `(reporter = \"${escaped}\" OR assignee = \"${escaped}\") ORDER BY updated DESC`;
  const response = await fetch(
    `${base}/search/jql?jql=${encodeURIComponent(jql)}&fields=reporter,assignee&maxResults=100`,
    { headers },
  );

  if (!response.ok) {
    return { ok: false, stage: "reporter-jira-issue-search", jiraStatus: response.status, error: await response.text() };
  }

  const body = await response.json();
  const issues = Array.isArray(body?.issues) ? body.issues : [];
  const wanted = normalizeName(displayName);
  const candidates = [];

  for (const issue of issues) {
    for (const user of [issue?.fields?.reporter, issue?.fields?.assignee]) {
      if (user && normalizeName(user.displayName) === wanted && String(user.accountId ?? "").trim()) {
        candidates.push(user);
      }
    }
  }

  const byId = new Map(candidates.map(user => [String(user.accountId), user]));
  if (byId.size !== 1) {
    return {
      ok: false,
      stage: "reporter-jira-issue-search-match",
      reason: byId.size === 0
        ? `Could not infer Jira accountId for ${displayName} from any accessible Jira issue`
        : `More than one Jira accountId matched ${displayName} across accessible Jira issues`,
    };
  }

  const user = Array.from(byId.values())[0];
  return { ok: true, accountId: String(user.accountId), displayName: String(user.displayName ?? displayName), source: "issue-search-all-projects" };
}

async function resolveJiraReporter(env, displayName, miroCreatorId) {
  const cached = await readCachedReporter(env, miroCreatorId);
  if (cached) return cached;

  const picker = await findWithUserPicker(env, displayName);
  if (picker.ok) return picker;

  const issueSearch = await findWithIssueSearch(env, displayName);
  if (issueSearch.ok) return issueSearch;

  return {
    ok: false,
    stage: "reporter-jira-account-id-unresolved",
    reason: `Could not resolve Jira accountId for ${displayName}. User picker: ${picker.reason ?? `HTTP ${picker.jiraStatus ?? "unknown"}`}. Issue search: ${issueSearch.reason ?? `HTTP ${issueSearch.jiraStatus ?? "unknown"}`}.`,
    picker,
    issueSearch,
  };
}

function jiraErrorMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    const parts = [];
    if (Array.isArray(parsed?.errorMessages)) parts.push(...parsed.errorMessages.filter(Boolean));
    if (parsed?.errors && typeof parsed.errors === "object") {
      for (const [field, message] of Object.entries(parsed.errors)) {
        if (message) parts.push(`${field}: ${message}`);
      }
    }
    if (parts.length) return parts.join(" | ");
  } catch {}
  return String(raw ?? "").trim();
}

async function updateReporter(env, issueKey, reporter) {
  const { base, headers } = jiraConfig(env);
  const response = await fetch(`${base}/issue/${encodeURIComponent(issueKey)}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { reporter: { accountId: reporter.accountId } } }),
  });

  if (!response.ok) {
    const rawError = await response.text();
    const detail = jiraErrorMessage(rawError);
    return {
      ok: false,
      stage: "reporter-jira-update",
      reason: detail
        ? `Jira rejected Reporter update with HTTP ${response.status}: ${detail}`
        : `Jira rejected Reporter update with HTTP ${response.status}`,
      jiraStatus: response.status,
      error: rawError,
    };
  }
  return { ok: true };
}

async function createAndApplyReporter(request, env, reporter, miroCreatorId, miroCreatorName) {
  const createResponse = await previewWorker.fetch(request.clone(), env);
  const created = await readJson(createResponse);
  if (!createResponse.ok || !created?.ok || !created?.created || !/^SN-\d+$/i.test(String(created?.issueKey ?? ""))) {
    return createResponse;
  }

  const update = await updateReporter(env, String(created.issueKey), reporter);
  if (!update.ok) {
    return jsonResponse({
      ...created,
      ok: false,
      reason: update.reason,
      reporterSync: update,
      reporterResolvedFrom: {
        miroCreatorId,
        miroCreatorName,
        jiraReporterName: reporter.displayName,
        jiraReporterAccountId: reporter.accountId,
        jiraReporterSource: reporter.source,
      },
    }, 409);
  }

  await writeCachedReporter(env, miroCreatorId, reporter);

  return jsonResponse({
    ...created,
    reporterSync: {
      ok: true,
      applied: true,
      miroCreatorId,
      miroCreatorName,
      jiraReporterName: reporter.displayName,
      jiraReporterAccountId: reporter.accountId,
      jiraReporterSource: reporter.source,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/sticky-to-jira") {
      return fallbackWorker.fetch(request, env, ctx);
    }

    let requestBody = null;
    try { requestBody = await request.clone().json(); } catch {}

    const claimedMiroCreatorId = String(requestBody?.createdBy ?? "").trim();
    if (claimedMiroCreatorId) {
      const cachedReporter = await readCachedReporter(env, claimedMiroCreatorId);
      if (cachedReporter) {
        return await createAndApplyReporter(
          request,
          env,
          cachedReporter,
          claimedMiroCreatorId,
          cachedReporter.displayName,
        );
      }
    }

    const firstResponse = await fallbackWorker.fetch(request.clone(), env, ctx);
    const firstError = await readJson(firstResponse);
    const miroCreatorId = String(firstError?.miroCreatorId ?? firstError?.fallback?.miroCreatorId ?? "").trim();
    const miroCreatorName = String(
      firstError?.miroCreatorName ??
      firstError?.fallback?.miroCreatorName ??
      (miroCreatorId === "3458764589815876301" ? "Kristoffer Rask" : "")
    ).trim();

    if (
      firstResponse.status !== 409 ||
      firstError?.stage !== "reporter-fallback-jira-search" ||
      !miroCreatorId ||
      !miroCreatorName
    ) {
      return firstResponse;
    }

    const reporter = await resolveJiraReporter(env, miroCreatorName, miroCreatorId);
    if (!reporter.ok) {
      return jsonResponse({
        ...firstError,
        stage: reporter.stage,
        reason: reporter.reason,
        miroCreatorId,
        miroCreatorName,
        jiraReporterLookup: reporter,
      }, 409);
    }

    return await createAndApplyReporter(
      request,
      env,
      reporter,
      miroCreatorId,
      miroCreatorName,
    );
  },
};
