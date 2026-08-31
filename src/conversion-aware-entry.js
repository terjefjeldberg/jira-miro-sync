import baseWorker from "./incoming-multipart-fix-entry.js";

function normalizeIssueKey(value) {
  return String(value ?? "").trim().toUpperCase();
}

function customCardMapKey(issueKey) {
  return `custom-card:${normalizeIssueKey(issueKey)}`;
}

function freezeKey(issueKey) {
  return `conversion-freeze:${normalizeIssueKey(issueKey)}`;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function validateMiroRequest(request, env, ctx) {
  const probeUrl = new URL(request.url);
  probeUrl.pathname = "/custom-card-pending";
  probeUrl.search = "";

  const probe = new Request(probeUrl.toString(), {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({ issueKeys: [] }),
  });

  const response = await baseWorker.fetch(probe, env, ctx);
  return response.ok;
}

async function readBody(request) {
  try {
    return await request.clone().json();
  } catch {
    return null;
  }
}

async function setJiraStatus(env, issueKey, desiredStatus) {
  const jiraBase =
    `https://api.atlassian.com/ex/jira/${encodeURIComponent(env.JIRA_CLOUD_ID)}/rest/api/3`;
  const headers = {
    Authorization: `Bearer ${env.JIRA_API_TOKEN}`,
    Accept: "application/json",
  };

  const issueResponse = await fetch(
    `${jiraBase}/issue/${encodeURIComponent(issueKey)}?fields=status`,
    { headers },
  );

  if (!issueResponse.ok) {
    return {
      ok: false,
      status: 502,
      stage: "conversion-read-jira-status",
      jiraStatus: issueResponse.status,
      error: await issueResponse.text(),
    };
  }

  const issue = await issueResponse.json();
  const currentStatus = String(issue?.fields?.status?.name ?? "").trim();
  if (currentStatus.toLowerCase() === desiredStatus.toLowerCase()) {
    return { ok: true, changed: false, currentStatus, desiredStatus };
  }

  const transitionsResponse = await fetch(
    `${jiraBase}/issue/${encodeURIComponent(issueKey)}/transitions`,
    { headers },
  );

  if (!transitionsResponse.ok) {
    return {
      ok: false,
      status: 502,
      stage: "conversion-read-jira-transitions",
      jiraStatus: transitionsResponse.status,
      error: await transitionsResponse.text(),
    };
  }

  const transitionsPayload = await transitionsResponse.json();
  const transitions = Array.isArray(transitionsPayload?.transitions)
    ? transitionsPayload.transitions
    : [];

  const transition = transitions.find(item =>
    String(item?.to?.name ?? "").trim().toLowerCase() === desiredStatus.toLowerCase(),
  );

  if (!transition?.id) {
    return {
      ok: false,
      status: 409,
      stage: "conversion-match-jira-transition",
      reason: `No Jira transition from ${currentStatus} to ${desiredStatus}`,
      currentStatus,
      desiredStatus,
      availableStatuses: transitions.map(item => item?.to?.name).filter(Boolean),
    };
  }

  const transitionResponse = await fetch(
    `${jiraBase}/issue/${encodeURIComponent(issueKey)}/transitions`,
    {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ transition: { id: String(transition.id) } }),
    },
  );

  if (!transitionResponse.ok) {
    return {
      ok: false,
      status: transitionResponse.status >= 400 && transitionResponse.status < 500 ? 409 : 502,
      stage: "conversion-apply-jira-transition",
      jiraStatus: transitionResponse.status,
      error: await transitionResponse.text(),
      currentStatus,
      desiredStatus,
    };
  }

  return { ok: true, changed: true, currentStatus, desiredStatus };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (
      request.method === "POST" &&
      (url.pathname === "/conversion-card-id" || url.pathname === "/conversion-set-status")
    ) {
      if (!(await validateMiroRequest(request, env, ctx))) {
        return jsonResponse({ ok: false, reason: "Invalid Miro identity token" }, 401);
      }

      const body = await readBody(request);
      const issueKey = normalizeIssueKey(body?.issueKey);
      if (!/^SN-\d+$/i.test(issueKey)) {
        return jsonResponse({ ok: false, reason: "Invalid SN issue key" }, 400);
      }

      if (url.pathname === "/conversion-card-id") {
        if (!env.CARD_MAP) {
          return jsonResponse({ ok: false, reason: "CARD_MAP is unavailable" }, 500);
        }

        const itemId = String(await env.CARD_MAP.get(customCardMapKey(issueKey)) ?? "").trim();
        return jsonResponse({
          ok: true,
          issueKey,
          mapped: Boolean(itemId),
          itemId: itemId || null,
        });
      }

      const desiredStatus = String(body?.desiredStatus ?? "").trim();
      const allowed = new Set([
        "Todo",
        "In progress",
        "Functional review",
        "Code review",
        "Approved",
        "Merged",
      ]);

      if (!allowed.has(desiredStatus)) {
        return jsonResponse({ ok: false, reason: "Unsupported desired status", desiredStatus }, 400);
      }

      // The Jira transition below can trigger the normal Jira -> Miro status
      // automation. Mark this one transition so the root webhook does not move
      // a newly converted card away from the sticky's original position.
      if (env.CARD_MAP) {
        await env.CARD_MAP.put(
          freezeKey(issueKey),
          JSON.stringify({ desiredStatus }),
          { expirationTtl: 30 },
        );
      }

      const result = await setJiraStatus(env, issueKey, desiredStatus);
      if (!result.ok) {
        if (env.CARD_MAP) await env.CARD_MAP.delete(freezeKey(issueKey));
        return jsonResponse(result, result.status || 500);
      }

      if (!result.changed && env.CARD_MAP) {
        await env.CARD_MAP.delete(freezeKey(issueKey));
      }

      return jsonResponse({ ok: true, issueKey, ...result });
    }

    // Suppress only the Jira -> Miro movement generated by a status transition
    // that was intentionally applied during sticky conversion. All other root
    // webhooks, including Work item created, continue through the normal flow.
    if (request.method === "POST" && url.pathname === "/" && env.CARD_MAP) {
      const body = await readBody(request);
      const issueKey = normalizeIssueKey(body?.issueKey);
      const webhookStatus = String(body?.status ?? "").trim();

      if (/^SN-\d+$/i.test(issueKey)) {
        const rawFreeze = await env.CARD_MAP.get(freezeKey(issueKey));
        if (rawFreeze) {
          let desiredStatus = "";
          try {
            desiredStatus = String(JSON.parse(rawFreeze)?.desiredStatus ?? "").trim();
          } catch {}

          if (
            desiredStatus &&
            webhookStatus.toLowerCase() === desiredStatus.toLowerCase()
          ) {
            await env.CARD_MAP.delete(freezeKey(issueKey));
            return jsonResponse({
              ok: true,
              moved: false,
              issueKey,
              status: webhookStatus,
              conversionPositionPreserved: true,
            });
          }
        }
      }
    }

    return baseWorker.fetch(request, env, ctx);
  },
};