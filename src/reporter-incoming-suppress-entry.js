import reporterWorker from "./reporter-panel-diagnostic-entry.js";

function normalizeIssueKey(value) {
  return String(value ?? "").trim().toUpperCase();
}

function suppressKey(issueKey) {
  return `incoming-suppress:${normalizeIssueKey(issueKey)}`;
}

export default {
  async fetch(request, env, ctx) {
    const response = await reporterWorker.fetch(request, env, ctx);
    const url = new URL(request.url);

    if (
      request.method !== "POST" ||
      url.pathname !== "/sticky-to-jira" ||
      !response.ok ||
      !env.CARD_MAP
    ) {
      return response;
    }

    let body = null;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }

    const issueKey = normalizeIssueKey(body?.issueKey);
    if (!body?.ok || !body?.created || !/^SN-\d+$/i.test(issueKey)) {
      return response;
    }

    // Mark this Jira issue as originating from the Miro sticky conversion.
    // The Jira "Work item created" automation can fire before the panel has
    // replaced the sticky with its custom card. This short-lived marker lets
    // the Incoming auto-create route skip that one webhook instead of creating
    // a second Miro card for the same issue.
    await env.CARD_MAP.put(
      suppressKey(issueKey),
      "1",
      { expirationTtl: 60 },
    );

    return response;
  },
};
