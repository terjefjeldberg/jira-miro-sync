import reporterWorker from "./reporter-create-entry.js";
import previewWorker from "./preview-entry-v2.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://miro.com",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Webhook-Secret",
  "Access-Control-Max-Age": "86400",
};

const FIXED_MIRO_USERS = {
  "3458764589815876301": { displayName: "Kristoffer Rask", email: "" },
  "3074457347700027993": { displayName: "Tim Chipman", email: "" },
  "3074457362562828515": { displayName: "Rupert Hanna", email: "" },
  "3074457346177807607": { displayName: "Robin Grønvold", email: "" },
  "3458764570480950130": { displayName: "Terje Fjeldberg", email: "" },
  "3074457345777323592": { displayName: "Ole Kristian Kvarsvik", email: "" },
  "3458764555898556023": { displayName: "Masud Mahamed", email: "" },
  "3074457366743197593": { displayName: "Jostein Edvardsen", email: "" },
  "3074457346139208205": { displayName: "Kristian Samuelsen", email: "" },
  "3458764561305764945": { displayName: "Mathias Hellqvist", email: "" },
  "99386030": { displayName: "Christoffer Henne", email: "" },
  "3458764544817410612": { displayName: "Zandrex Ramos Camagon", email: "" },
  "3074457352976810809": { displayName: "Erwin Berkers", email: "" },
  "3074457352976810811": { displayName: "Manuel Gonzalez", email: "" },
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

function memberIdentity(value) {
  if (!value) return { id: "", name: "", email: "" };
  return {
    id: String(value.id ?? value.memberId ?? value.user?.id ?? "").trim(),
    name: String(value.name ?? value.displayName ?? value.user?.name ?? value.user?.displayName ?? "").trim(),
    email: String(value.email ?? value.emailAddress ?? value.user?.email ?? value.user?.emailAddress ?? "").trim(),
  };
}

async function readMiroBoardMember(env, miroUserId) {
  if (!env.MIRO_TOKEN || !env.MIRO_BOARD_ID) {
    return { ok: false, stage: "reporter-fallback-miro-board-config", reason: "Miro board configuration is missing" };
  }

  const headers = {
    Authorization: `Bearer ${env.MIRO_TOKEN}`,
    Accept: "application/json",
  };

  const direct = await fetch(
    `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/members/${encodeURIComponent(miroUserId)}`,
    { headers },
  );

  if (direct.ok) {
    const raw = await direct.json();
    const identity = memberIdentity(raw);
    if (identity.name) return { ok: true, ...identity, source: "board-member-direct" };
  }

  let cursor = "";
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/members`);
    url.searchParams.set("limit", "50");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url.toString(), { headers });
    if (!response.ok) {
      return {
        ok: false,
        stage: "reporter-fallback-miro-board-members",
        reason: `Miro board member lookup failed with HTTP ${response.status}`,
        miroStatus: response.status,
        error: await response.text(),
        miroCreatorId: miroUserId,
      };
    }

    const payload = await response.json();
    const members = Array.isArray(payload?.data) ? payload.data : [];
    for (const member of members) {
      const identity = memberIdentity(member);
      if (identity.id === String(miroUserId) && identity.name) {
        return { ok: true, ...identity, source: "board-members-list" };
      }
    }

    cursor = String(payload?.cursor ?? "").trim();
    if (!cursor) break;
  }

  return {
    ok: false,
    stage: "reporter-fallback-miro-board-member-not-found",
    reason: `Miro creator ${miroUserId} was not found with a name in the board member API`,
    miroCreatorId: miroUserId,
  };
}

async function readMiroScimUser(env, miroUserId) {
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
      stage: "reporter-fallback-miro-scim-user",
      reason: `Miro SCIM user lookup failed with HTTP ${response.status}`,
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
      stage: "reporter-fallback-miro-scim-name",
      reason: "Miro SCIM user lookup returned no display name",
      miroCreatorId: miroUserId,
    };
  }

  return { ok: true, id: miroUserId, name: displayName, email, source: "scim" };
}

async function resolveMiroUser(env, miroUserId) {
  const fixed = FIXED_MIRO_USERS[String(miroUserId)];
  if (fixed?.displayName) {
    return {
      ok: true,
      id: String(miroUserId),
      displayName: fixed.displayName,
      email: fixed.email || "",
      source: "fixed-mapping",
    };
  }

  const boardMember = await readMiroBoardMember(env, miroUserId);
  if (boardMember.ok) {
    return {
      ok: true,
      id: miroUserId,
      displayName: boardMember.name,
      email: boardMember.email,
      source: boardMember.source,
    };
  }

  const scim = await readMiroScimUser(env, miroUserId);
  if (scim.ok) {
    return {
      ok: true,
      id: miroUserId,
      displayName: scim.name,
      email: scim.email,
      source: scim.source,
    };
  }

  return {
    ok: false,
    stage: "reporter-fallback-miro-user-unresolved",
    reason: `Could not resolve Miro creator ${miroUserId}. Board member lookup: ${boardMember.reason}. SCIM lookup: ${scim.reason}.`,
    miroCreatorId: miroUserId,
    boardMember,
    scim,
  };
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
      reason: `Jira user search failed with HTTP ${response.status}`,
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
        ? `No exact Jira user matched Miro creator ${miroUser.displayName}`
        : `More than one Jira user matched Miro creator ${miroUser.displayName}`,
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
      reason: `Jira rejected the Reporter update with HTTP ${response.status}`,
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

    const miroUser = await resolveMiroUser(env, String(reporterError.miroCreatorId));
    if (!miroUser.ok) {
      return jsonResponse({
        ...reporterError,
        stage: miroUser.stage,
        reason: miroUser.reason,
        fallback: miroUser,
      }, 409);
    }

    const jiraReporter = await findJiraReporter(env, miroUser);
    if (!jiraReporter.ok) {
      return jsonResponse({
        ...reporterError,
        stage: jiraReporter.stage,
        reason: jiraReporter.reason,
        fallback: jiraReporter,
      }, 409);
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
        reason: reporterUpdate.reason,
        reporterSync: reporterUpdate,
        reporterResolvedFrom: {
          miroCreatorId: miroUser.id,
          miroCreatorName: miroUser.displayName,
          miroCreatorSource: miroUser.source,
          jiraReporterName: jiraReporter.displayName,
        },
      }, 409);
    }

    return jsonResponse({
      ...created,
      reporterSync: {
        ok: true,
        applied: true,
        fallback: miroUser.source,
        miroCreatorId: miroUser.id,
        miroCreatorName: miroUser.displayName,
        jiraReporterAccountId: jiraReporter.accountId,
        jiraReporterName: jiraReporter.displayName,
      },
    });
  },
};
