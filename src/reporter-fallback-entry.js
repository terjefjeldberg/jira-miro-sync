import reporterWorker from "./reporter-create-entry.js";
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
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
}

async function readJson(response) {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

async function readMiroUser(env, miroUserId) {
  const response = await fetch(
    `https://miro.com/api/v1/scim/Users/${encodeURIComponent(miroUserId)}?attributes=id,displayName,name,userName,emails`,
    {
      headers: {
        Authorization: `Bearer ${env.MIRO_TOKEN}`,
        Accept: "application/scim+json, application/json",
      },
    },
  );

  if (!response.ok) {
    return {
      ok: false,
      stage: "reporter-fallback-miro-user",
      miroStatus: response.status,
      error: await response.text(),
      miroCreatorId: miroUserId,
    };
  }

  const user = await response.json();
  const given = String(user?.name?.givenName ?? "").trim();
  const family = String(user?.name?.familyName ?? "").trim();
  const composed = `${given} ${family}`.trim();
  const displayName = String(user?.displayName ?? composed).trim();
  const email = String(
    user?.userName ??
      (Array.isArray(user?.emails)
        ? user.emails.find(item => item?.primary)?.value ?? user.emails[0]?.value
        : "") ??
      "",
  ).trim();

  if (!displayName) {
    return {
      ok: false,
      stage: "reporter-fallback-miro-user-name",
      reason: "Miro user lookup returned no display name",
      miroCreatorId: miroUserId,
      miroUser: user,
    };
  }

  return { ok: true, id: miroUserId, displayName, email };
}

async function findJiraReporter(env, miroUser) {
  const jiraBase = `https://api.atlassian.com/ex/jira/${encodeURIComponent(env.JIRA_CLOUD_ID)}/rest/api/3`;
  const headers = {
    Authorization: `Bearer ${env.JIRA_API_TOKEN}`,
    Accept: "application/json",
  };

  let response = await fetch(
    `${jiraBase}/user/search?query=${encodeURIComponent(miroUser.displayName)}&maxResults=50`,
    { headers },
  );

  if (!response.ok) {
    response = await fetch(
      `${jiraBase}/user/assignable/search?project=SN&query=${encodeURIComponent(miroUser.displayName)}&maxResults=50`,
      { headers },
    );
  }

  if (!response.ok) {
    return {
      ok: false,
      stage: "reporter-fallback-jira-search",
      jiraStatus: response.status,
      error: await response.text(),
      miroCreatorName: miroUser.displayName,
    };
  }

  const users = await response.json();
  const candidates = (Array.isArray(users) ? users : []).filter(
    user =>
      user?.active !== false &&
      String(user?.accountType ?? "atlassian") !== "app" &&
      String(user?.accountId ?? "").trim(),
  );

  const name = miroUser.displayName.toLocaleLowerCase();
  let matches = candidates.filter(
    user => String(user?.displayName ?? "").trim().toLocaleLowerCase() === name,
  );

  if (miroUser.email) {
    const email = miroUser.email.toLocaleLowerCase();
    const emailMatches = candidates.filter(
      user => String(user?.emailAddress ?? "").trim().toLocaleLowerCase() === email,
    );
    if (emailMatches.length === 1) matches = emailMatches;
  }

  if (matches.length !== 1) {
    return {
      ok: false,
      stage: "reporter-fallback-jira-match",
      reason: matches.length === 0
        ? "No exact Jira user matched the Miro creator"
        : "More than one exact Jira user matched the Miro creator",
      miroCreatorName: miroUser.displayName,
      candidates: candidates.map(user => user.displayName),
    };
  }

  return {
    ok: true,
    accountId: String(matches[0].accountId),
    displayName: String(matches[0].displayName ?? miroUser.displayName),
  };
}

async function updateReporter(env, issueKey, reporter) {
  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${encodeURIComponent(env.JIRA_CLOUD_ID)}/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.JIRA_API_TOKEN}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: { reporter: { accountId: reporter.accountId } },
      }),
    },
  );

  if (!response.ok) {
    return {
      ok: false,
      stage: "reporter-fallback-jira-update",
      jiraStatus: response.status,
      error: await response.text(),
      jiraReporterName: reporter.displayName,
    };
  }

  return { ok: true, applied: true };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/sticky-to-jira") {
      return reporterWorker.fetch(request, env, ctx);
    }

    const reporterResponse = await reporterWorker.fetch(request.clone(), env, ctx);
    const reporterError = await readJson(reporterResponse);

    if (
      reporterResponse.status !== 409 ||
      reporterError?.stage !== "reporter-miro-creator-name" ||
      !reporterError?.miroCreatorId
    ) {
      return reporterResponse;
    }

    const miroUser = await readMiroUser(env, String(reporterError.miroCreatorId));
    if (!miroUser.ok) {
      return jsonResponse({ ...reporterError, fallback: miroUser }, 409);
    }

    const jiraReporter = await findJiraReporter(env, miroUser);
    if (!jiraReporter.ok) {
      return jsonResponse({ ...reporterError, fallback: jiraReporter }, 409);
    }

    const createResponse = await previewWorker.fetch(request.clone(), env, ctx);
    const created = await readJson(createResponse);

    if (!createResponse.ok || !created?.ok || !created?.created || !/^SN-\d+$/i.test(String(created?.issueKey ?? ""))) {
      return createResponse;
    }

    const reporterUpdate = await updateReporter(env, String(created.issueKey), jiraReporter);
    if (!reporterUpdate.ok) {
      return jsonResponse({
        ...created,
        ok: false,
        reporterSync: reporterUpdate,
        reporterResolvedFrom: {
          miroCreatorId: miroUser.id,
          miroCreatorName: miroUser.displayName,
          jiraReporterName: jiraReporter.displayName,
        },
      }, 409);
    }

    return jsonResponse({
      ...created,
      reporterSync: {
        ok: true,
        applied: true,
        fallback: "miro-scim-user-id",
        miroCreatorId: miroUser.id,
        miroCreatorName: miroUser.displayName,
        jiraReporterAccountId: jiraReporter.accountId,
        jiraReporterName: jiraReporter.displayName,
      },
    });
  },
};
