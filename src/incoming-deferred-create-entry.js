import incomingWorker from "./incoming-multipart-fix-entry.js";

const SUPPRESS_WAIT_MS = 700;

function normalizeIssueKey(value) {
  return String(value ?? "").trim().toUpperCase();
}

function customCardMapKey(issueKey) {
  return `custom-card:${normalizeIssueKey(issueKey)}`;
}

function suppressKey(issueKey) {
  return `incoming-suppress:${normalizeIssueKey(issueKey)}`;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/" || !env.CARD_MAP) {
      return incomingWorker.fetch(request, env, ctx);
    }

    let body = null;
    try {
      body = await request.clone().json();
    } catch {
      return incomingWorker.fetch(request, env, ctx);
    }

    const issueKey = normalizeIssueKey(body?.issueKey);
    if (!/^SN-\d+$/i.test(issueKey)) {
      return incomingWorker.fetch(request, env, ctx);
    }

    const existing = await env.CARD_MAP.get(customCardMapKey(issueKey));
    if (existing) {
      return incomingWorker.fetch(request, env, ctx);
    }

    let suppressed = await env.CARD_MAP.get(suppressKey(issueKey));
    if (!suppressed) {
      await new Promise(resolve => setTimeout(resolve, SUPPRESS_WAIT_MS));
      suppressed = await env.CARD_MAP.get(suppressKey(issueKey));
    }

    if (suppressed) {
      await env.CARD_MAP.delete(suppressKey(issueKey));
      console.log("JIRA -> MIRO Incoming create suppressed for Miro-origin issue:", issueKey);
      return jsonResponse({
        ok: true,
        moved: false,
        issueKey,
        status: String(body?.status ?? ""),
        incomingCreate: {
          ok: true,
          created: false,
          skipped: true,
          reason: "Issue originated from Miro sticky conversion",
        },
      });
    }

    return incomingWorker.fetch(request, env, ctx);
  },
};
