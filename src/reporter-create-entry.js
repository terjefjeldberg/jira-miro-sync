import appWorker from "./preview-entry.js";

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
    id: String(value.id ?? value.memberId ?? value.user?.id ?? value.data?.id ?? value.data?.memberId ?? "").trim(),
    name: String(
      value.name ??
      value.displayName ??
      value.user?.name ??
      value.user?.displayName ??
      value.data?.name ??
      value.data?.displayName ??
      "",
    ).trim(),
    email: String(
      value.email ??
      value.emailAddress ??
      value.user?.email ??
      value.user?.emailAddress ??
      value.data?.email ??
      value.data?.emailAddress ??
      "",
    ).trim(),
  };
}

async function validateMiroRequest(request, env, ctx) {
  const probeUrl = new URL(request.url);
  probeUrl.pathname = "/custom-card-pending";
  probeUrl.search = "";
  const probeRequest = new Request(probeUrl.toString(), {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({ issueKeys: [] }),
  });
  return await appWorker.fetch(probeRequest, env, ctx);
}

async function readMiroBoardMember(env, memberId) {
  if (!memberId || !env.MIRO_TOKEN || !env.MIRO_BOARD_ID) return null;

  const headers = {
    Authorization: `Bearer ${env.MIRO_TOKEN}`,
    Accept: "application/json",
  };

  const directResponse = await fetch(
    `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/members/${encodeURIComponent(memberId)}`,
    { headers },
  );

  if (directResponse.ok) {
    const directMember = await directResponse.json();
    if (miroUserIdentity(directMember).name) return directMember;
  }

  for (let offset = 0; offset < 1000; offset += 50) {
    const listResponse = await fetch(
      `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/members?limit=50&offset=${offset}`,
      { headers },
    );

    if (!listResponse.ok) break;

    const payload = await listResponse.json();
    const members = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload)
        ? payload
        : [];

    const match = members.find(member => {
      const identity = miroUserIdentity(member);
      return identity.id === String(memberId);
    });

    if (match) return match;
    if (members.length < 50) break;
  }

  return null;
}

async function resolveStickyCreator(env, stickyId) {
  const id = String(stickyId ?? "").trim();
  if (!id) {
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
    `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/items/${encodeURIComponent(id)}`,
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
      reason: "The selected Miro item is not a sticky note",
      itemType: item?.type ?? null,
    };
  }

  let creator = miroUserIdentity(item.createdBy);
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

  if (!creator.id) {
    return {
      ok: false,
      stage: "reporter-miro-creator-id",
      reason: "Miro did not return createdBy for the sticky note",
    };
  }
  if (!creator.name) {
    return {
      ok: false,
      stage: "reporter-miro-creator-name",
      reason: "Could not resolve the Miro creator name",
      miroCreatorId: creator.id,
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

  const jiraBase = `https://api.atlassian.com/ex/jira/${encodeURIComponent(env.JIRA_CLOUD_ID)}/rest/api/3`;
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

function adfText(text) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function findCreateField(fields, fieldId) {
  return fields.find(field => String(field?.fieldId ?? "") === fieldId) || null;
}

function findDropdownOption(field, wantedValue) {
  const allowedValues = Array.isArray(field?.allowedValues) ? field.allowedValues : [];
  const wanted = String(wantedValue ?? "").trim().toLowerCase();
  return allowedValues.find(
    option =>
      String(option?.value ?? option?.name ?? "").trim().toLowerCase() === wanted,
  ) || null;
}

function textLikeCreateValue(field, text) {
  const schemaType = String(field?.schema?.type ?? "").trim().toLowerCase();
  const customType = String(field?.schema?.custom ?? "").trim().toLowerCase();
  if (schemaType === "doc" || customType.includes(":textarea")) {
    return adfText(text);
  }
  return text;
}

async function createJiraIssueWithReporter(env, requestBody, reporter) {
  const summary = String(requestBody?.summary ?? "").replace(/\s+/g, " ").trim();
  const workType = String(requestBody?.workType ?? "").trim();
  const allowedWorkTypes = new Set([
    "Bug",
    "Improvement",
    "Spike",
    "New Feature",
    "Hotfix candidate",
    "Task/config/doc/test",
  ]);

  if (!summary) {
    return { status: 400, body: { ok: false, reason: "Sticky note has no text" } };
  }
  if (summary.length > 255) {
    return {
      status: 400,
      body: { ok: false, reason: "Sticky text is too long for Jira summary", maxLength: 255 },
    };
  }
  if (!allowedWorkTypes.has(workType)) {
    return { status: 400, body: { ok: false, reason: "Unapproved work type", workType } };
  }

  const jiraBase = `https://api.atlassian.com/ex/jira/${encodeURIComponent(env.JIRA_CLOUD_ID)}/rest/api/3`;
  const jiraHeaders = {
    Authorization: `Bearer ${env.JIRA_API_TOKEN}`,
    Accept: "application/json",
  };

  const issueTypesResponse = await fetch(
    `${jiraBase}/issue/createmeta/SN/issuetypes?maxResults=100`,
    { headers: jiraHeaders },
  );
  if (!issueTypesResponse.ok) {
    return {
      status: 500,
      body: {
        ok: false,
        stage: "read-create-issue-types",
        jiraStatus: issueTypesResponse.status,
        error: await issueTypesResponse.text(),
      },
    };
  }

  const issueTypesData = await issueTypesResponse.json();
  const issueTypes = Array.isArray(issueTypesData?.issueTypes) ? issueTypesData.issueTypes : [];
  const matchingIssueType = issueTypes.find(
    item => String(item?.name ?? "").trim().toLowerCase() === workType.toLowerCase(),
  );
  if (!matchingIssueType) {
    return {
      status: 409,
      body: {
        ok: false,
        stage: "match-issue-type",
        reason: "Jira work type was not found in project SN",
        workType,
        availableWorkTypes: issueTypes.map(item => item?.name),
      },
    };
  }

  const fieldMetaResponse = await fetch(
    `${jiraBase}/issue/createmeta/SN/issuetypes/${encodeURIComponent(String(matchingIssueType.id))}?maxResults=200`,
    { headers: jiraHeaders },
  );
  if (!fieldMetaResponse.ok) {
    return {
      status: 500,
      body: {
        ok: false,
        stage: "read-create-field-metadata",
        jiraStatus: fieldMetaResponse.status,
        error: await fieldMetaResponse.text(),
      },
    };
  }

  const fieldMeta = await fieldMetaResponse.json();
  const fields = Array.isArray(fieldMeta?.fields) ? fieldMeta.fields : [];
  const defaultText = "Created from Miro sticky note";
  const createFields = {
    project: { key: "SN" },
    summary,
    issuetype: { id: String(matchingIssueType.id) },
    reporter: { accountId: reporter.accountId },
  };
  const stickyDefaultsApplied = {};

  if (workType === "Bug") {
    const customerFieldId = "customfield_11174";
    const reproFieldId = "customfield_10868";
    const customerField = findCreateField(fields, customerFieldId);
    const customerOption = customerField ? findDropdownOption(customerField, defaultText) : null;
    if (!customerField || !customerOption?.id) {
      return {
        status: 409,
        body: {
          ok: false,
          stage: "find-bug-sticky-defaults",
          reason: "Required Bug sticky-conversion field or option was not found",
          fieldId: customerFieldId,
        },
      };
    }
    createFields[reproFieldId] = adfText(`${defaultText}.`);
    createFields[customerFieldId] = { id: String(customerOption.id) };
    stickyDefaultsApplied.reproSteps = { fieldId: reproFieldId, value: `${defaultText}.` };
    stickyDefaultsApplied.customer = {
      fieldId: customerFieldId,
      optionId: String(customerOption.id),
      value: customerOption.value ?? customerOption.name ?? defaultText,
    };
  }

  if (workType === "New Feature" || workType === "Improvement") {
    const dropdown1Id = "customfield_10792";
    const text1Id = "customfield_10869";
    const text2Id = "customfield_10870";
    const dropdown2Id = "customfield_10832";
    const dropdown1 = findCreateField(fields, dropdown1Id);
    const text1 = findCreateField(fields, text1Id);
    const text2 = findCreateField(fields, text2Id);
    const dropdown2 = findCreateField(fields, dropdown2Id);
    const missingFieldIds = [
      [dropdown1Id, dropdown1],
      [text1Id, text1],
      [text2Id, text2],
      [dropdown2Id, dropdown2],
    ].filter(([, field]) => !field).map(([fieldId]) => fieldId);

    if (missingFieldIds.length) {
      return {
        status: 409,
        body: {
          ok: false,
          stage: "find-new-feature-improvement-fields",
          reason: "One or more required sticky-conversion fields were not found in Jira create metadata",
          workType,
          missingFieldIds,
        },
      };
    }

    const option1 = findDropdownOption(dropdown1, defaultText);
    const option2 = findDropdownOption(dropdown2, defaultText);
    if (!option1?.id || !option2?.id) {
      return {
        status: 409,
        body: {
          ok: false,
          stage: "find-new-feature-improvement-options",
          reason: 'Dropdown option "Created from Miro sticky note" was not found',
          workType,
        },
      };
    }

    createFields[dropdown1Id] = { id: String(option1.id) };
    createFields[text1Id] = adfText(defaultText);
    createFields[text2Id] = adfText(defaultText);
    createFields[dropdown2Id] = { id: String(option2.id) };
    stickyDefaultsApplied[dropdown1Id] = { optionId: String(option1.id) };
    stickyDefaultsApplied[text1Id] = defaultText;
    stickyDefaultsApplied[text2Id] = defaultText;
    stickyDefaultsApplied[dropdown2Id] = { optionId: String(option2.id) };
  }

  if (workType === "Task/config/doc/test") {
    const taskFieldId = "customfield_10872";
    const taskField = findCreateField(fields, taskFieldId);
    if (!taskField) {
      return {
        status: 409,
        body: {
          ok: false,
          stage: "find-task-required-field-10872",
          reason: "Required field customfield_10872 was not found in Jira create metadata",
          workType,
          fieldId: taskFieldId,
        },
      };
    }
    createFields[taskFieldId] = textLikeCreateValue(taskField, defaultText);
    stickyDefaultsApplied[taskFieldId] = defaultText;
  }

  const createResponse = await fetch(`${jiraBase}/issue`, {
    method: "POST",
    headers: {
      ...jiraHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: createFields }),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    let error = errorText;
    try {
      error = JSON.parse(errorText);
    } catch {}
    return {
      status: createResponse.status >= 400 && createResponse.status < 500 ? createResponse.status : 500,
      body: {
        ok: false,
        stage: "create-jira-issue-with-reporter",
        jiraStatus: createResponse.status,
        workType,
        reporter: {
          accountId: reporter.accountId,
          displayName: reporter.displayName,
          miroCreatorName: reporter.miroCreatorName,
        },
        stickyDefaultsApplied,
        error,
      },
    };
  }

  const created = await createResponse.json();
  const issueKey = normalizeIssueKey(created?.key);
  if (!/^SN-\d+$/i.test(issueKey)) {
    return {
      status: 500,
      body: {
        ok: false,
        stage: "validate-created-issue",
        reason: "Jira created an unexpected issue key",
        jiraResult: created,
      },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      created: true,
      issueKey,
      workType,
      summary,
      jiraIssueTypeId: String(matchingIssueType.id),
      stickyDefaults: stickyDefaultsApplied,
      reporterSync: {
        ok: true,
        appliedAtCreate: true,
        miroCreatorId: reporter.miroCreatorId,
        miroCreatorName: reporter.miroCreatorName,
        jiraReporterAccountId: reporter.accountId,
        jiraReporterName: reporter.displayName,
      },
    },
  };
}

async function injectStickyIdIntoPanel(baseResponse) {
  if (!baseResponse.ok) return baseResponse;
  const html = await baseResponse.clone().text();

  const pattern = /(summary,\s*\n\s*workType:\s*\n\s*detectedWorkType)(\s*\n\s*})/;
  if (!pattern.test(html)) {
    console.warn("MIRO REPORTER CREATE: could not inject stickyId into panel HTML");
    return baseResponse;
  }

  const patched = html.replace(
    pattern,
    `$1,\n\n              stickyId:\n                String(sticky.id)$2`,
  );
  return responseWithText(baseResponse, patched);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/miro-panel") {
      const baseResponse = await appWorker.fetch(request, env, ctx);
      return await injectStickyIdIntoPanel(baseResponse);
    }

    if (request.method !== "POST" || url.pathname !== "/sticky-to-jira") {
      return appWorker.fetch(request, env, ctx);
    }

    let requestBody;
    try {
      requestBody = await request.clone().json();
    } catch {
      return jsonResponse({ ok: false, reason: "Invalid JSON" }, 400);
    }

    const authProbe = await validateMiroRequest(request, env, ctx);
    if (!authProbe.ok) return authProbe;

    const creatorResult = await resolveStickyCreator(env, requestBody?.stickyId);
    if (!creatorResult.ok) {
      return jsonResponse(creatorResult, 409);
    }

    const reporterResult = await findJiraReporter(env, creatorResult.creator);
    if (!reporterResult.ok) {
      return jsonResponse(reporterResult, 409);
    }

    const creation = await createJiraIssueWithReporter(env, requestBody, reporterResult);
    console.log("MIRO STICKY CREATOR -> JIRA REPORTER AT CREATE:", {
      creator: creatorResult.creator,
      reporter: reporterResult,
      result: creation.body,
    });

    return jsonResponse(creation.body, creation.status);
  },
};
