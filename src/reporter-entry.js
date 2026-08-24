import appWorker from "./preview-entry.js";

function jsonResponseLike(original, data) {
  const headers = new Headers(original.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  return new Response(JSON.stringify(data), {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

function responseWithText(original, text) {
  const headers = new Headers(original.headers);
  headers.delete("Content-Length");
  return new Response(text, {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

function normalizeIssueKey(value) {
  return String(value ?? "").trim().toUpperCase();
}

function miroUserIdentity(value) {
  if (!value) return { id: "", name: "", email: "" };
  if (typeof value === "string") {
    return { id: value.trim(), name: "", email: "" };
  }

  return {
    id: String(value.id ?? value.memberId ?? value.user?.id ?? "").trim(),
    name: String(
      value.name ??
      value.displayName ??
      value.user?.name ??
      value.user?.displayName ??
      "",
    ).trim(),
    email: String(
      value.email ??
      value.emailAddress ??
      value.user?.email ??
      value.user?.emailAddress ??
      "",
    ).trim(),
  };
}

async function readMiroBoardMember(env, memberId) {
  if (!memberId || !env.MIRO_TOKEN || !env.MIRO_BOARD_ID) return null;

  const response = await fetch(
    `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/members/${encodeURIComponent(memberId)}`,
    {
      headers: {
        Authorization: `Bearer ${env.MIRO_TOKEN}`,
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) return null;
  return await response.json();
}

async function resolveStickyCreator(env, stickyId, claimedCreatedBy) {
  const normalizedStickyId = String(stickyId ?? "").trim();
  const claimedCreatorId = String(claimedCreatedBy ?? "").trim();

  if (!normalizedStickyId) {
    return {
      ok: false,
      stage: "reporter-missing-sticky-id",
      reason: "Sticky ID was not supplied by the Miro panel",
    };
  }

  if (!env.MIRO_TOKEN || !env.MIRO_BOARD_ID) {
    return {
      ok: false,
      stage: "reporter-miro-config",
      reason: "Miro REST configuration is missing",
    };
  }

  const response = await fetch(
    `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/items/${encodeURIComponent(normalizedStickyId)}`,
    {
      headers: {
        Authorization: `Bearer ${env.MIRO_TOKEN}`,
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    return {
      ok: false,
      stage: "reporter-read-miro-sticky",
      miroStatus: response.status,
      error: await response.text(),
    };
  }

  const item = await response.json();
  if (item?.type !== "sticky_note") {
    return {
      ok: false,
      stage: "reporter-verify-miro-sticky",
      reason: "The supplied Miro item is not a sticky note",
      itemType: item?.type ?? null,
    };
  }

  let creator = miroUserIdentity(item.createdBy);

  if (claimedCreatorId && creator.id && claimedCreatorId !== creator.id) {
    return {
      ok: false,
      stage: "reporter-verify-created-by",
      reason: "Miro createdBy did not match the selected sticky",
      claimedCreatorId,
      actualCreatorId: creator.id,
    };
  }

  if (!creator.name && creator.id) {
    const member = await readMiroBoardMember(env, creator.id);
    if (member) {
      const memberIdentity = miroUserIdentity(member);
      creator = {
        id: creator.id || memberIdentity.id,
        name: memberIdentity.name,
        email: memberIdentity.email,
      };
    }
  }

  if (!creator.id || !creator.name) {
    return {
      ok: false,
      stage: "reporter-resolve-miro-creator",
      reason: "Could not resolve the Miro sticky creator",
      miroCreatorId: creator.id || null,
    };
  }

  return { ok: true, creator };
}

async function findJiraReporter(env, creator) {
  if (!env.JIRA_API_TOKEN || !env.JIRA_CLOUD_ID) {
    return {
      ok: false,
      stage: "reporter-jira-config",
      reason: "Jira API configuration is missing",
    };
  }

  const jiraBase =
    `https://api.atlassian.com/ex/jira/${encodeURIComponent(env.JIRA_CLOUD_ID)}/rest/api/3`;
  const headers = {
    Authorization: `Bearer ${env.JIRA_API_TOKEN}`,
    Accept: "application/json",
  };

  let response = await fetch(
    `${jiraBase}/user/search?query=${encodeURIComponent(creator.name)}&maxResults=50`,
    { headers },
  );

  if (!response.ok) {
    response = await fetch(
      `${jiraBase}/user/assignable/search?project=SN&query=${encodeURIComponent(creator.name)}&maxResults=50`,
      { headers },
    );
  }

  if (!response.ok) {
    return {
      ok: false,
      stage: "reporter-search-jira-user",
      jiraStatus: response.status,
      error: await response.text(),
      miroCreatorName: creator.name,
    };
  }

  const users = await response.json();
  const candidates = (Array.isArray(users) ? users : []).filter(
    user =>
      user?.active !== false &&
      String(user?.accountType ?? "atlassian") !== "app" &&
      String(user?.accountId ?? "").trim(),
  );

  const normalizedName = creator.name.trim().toLocaleLowerCase();
  let matches = candidates.filter(
    user =>
      String(user?.displayName ?? "").trim().toLocaleLowerCase() === normalizedName,
  );

  if (creator.email) {
    const normalizedEmail = creator.email.trim().toLocaleLowerCase();
    const emailMatches = candidates.filter(
      user =>
        String(user?.emailAddress ?? "").trim().toLocaleLowerCase() === normalizedEmail,
    );
    if (emailMatches.length === 1) matches = emailMatches;
  }

  if (matches.length !== 1) {
    return {
      ok: false,
      stage: "reporter-match-jira-user",
      reason:
        matches.length === 0
          ? "No exact Jira user matched the Miro creator"
          : "More than one exact Jira user matched the Miro creator",
      miroCreatorId: creator.id,
      miroCreatorName: creator.name,
      searchCandidates: candidates.map(user => user.displayName),
    };
  }

  return {
    ok: true,
    accountId: String(matches[0].accountId),
    displayName: String(matches[0].displayName ?? creator.name),
    miroCreatorId: creator.id,
    miroCreatorName: creator.name,
  };
}

async function setReporter(env, issueKey, reporter) {
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
        fields: {
          reporter: { accountId: reporter.accountId },
        },
      }),
    },
  );

  if (!response.ok) {
    return {
      ok: false,
      stage: "reporter-update-jira-issue",
      jiraStatus: response.status,
      error: await response.text(),
      jiraReporterName: reporter.displayName,
    };
  }

  return {
    ok: true,
    applied: true,
    jiraReporterAccountId: reporter.accountId,
    jiraReporterName: reporter.displayName,
    miroCreatorId: reporter.miroCreatorId,
    miroCreatorName: reporter.miroCreatorName,
  };
}

async function injectStickyCreatorIntoPanel(baseResponse) {
  if (!baseResponse.ok) return baseResponse;

  const html = await baseResponse.clone().text();
  const original = `              workType:\n                detectedWorkType\n\n            }`;
  const replacement = `              workType:\n                detectedWorkType,\n\n              stickyId:\n                String(sticky.id),\n\n              createdBy:\n                String(sticky.createdBy || \"\")\n\n            }`;

  if (!html.includes(original)) {
    console.warn("MIRO REPORTER SYNC: could not inject sticky creator fields into panel HTML");
    return baseResponse;
  }

  return responseWithText(baseResponse, html.replace(original, replacement));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/miro-panel") {
      const baseResponse = await appWorker.fetch(request, env, ctx);
      return await injectStickyCreatorIntoPanel(baseResponse);
    }

    if (request.method === "POST" && url.pathname === "/sticky-to-jira") {
      let requestBody = null;
      try {
        requestBody = await request.clone().json();
      } catch {
        // Base worker owns request validation.
      }

      const baseResponse = await appWorker.fetch(request.clone(), env, ctx);

      let result;
      try {
        result = await baseResponse.clone().json();
      } catch {
        return baseResponse;
      }

      if (
        !baseResponse.ok ||
        !result?.ok ||
        !result?.created ||
        !/^SN-\d+$/i.test(String(result?.issueKey ?? ""))
      ) {
        return baseResponse;
      }

      let reporterSync;
      try {
        const creatorResult = await resolveStickyCreator(
          env,
          requestBody?.stickyId,
          requestBody?.createdBy,
        );

        if (!creatorResult.ok) {
          reporterSync = creatorResult;
        } else {
          const reporterResult = await findJiraReporter(env, creatorResult.creator);
          reporterSync = reporterResult.ok
            ? await setReporter(env, normalizeIssueKey(result.issueKey), reporterResult)
            : reporterResult;
        }
      } catch (error) {
        reporterSync = {
          ok: false,
          stage: "reporter-unexpected-error",
          reason: error instanceof Error ? error.message : String(error),
        };
      }

      console.log(
        "MIRO STICKY CREATOR -> JIRA REPORTER:",
        normalizeIssueKey(result.issueKey),
        reporterSync,
      );

      return jsonResponseLike(baseResponse, {
        ...result,
        reporterSync,
      });
    }

    return appWorker.fetch(request, env, ctx);
  },
};
