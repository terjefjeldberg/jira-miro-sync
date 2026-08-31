import incomingWorker from "./incoming-multipart-fix-entry.js";

const CREATE_GRACE_MS = 3000;

function normalizeIssueKey(value) {
  return String(value ?? "").trim().toUpperCase();
}

function customCardMapKey(issueKey) {
  return `custom-card:${normalizeIssueKey(issueKey)}`;
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

    const mapKey = customCardMapKey(issueKey);
    const existing = await env.CARD_MAP.get(mapKey);

    // A sticky -> Jira conversion creates the Jira issue first and then
    // replaces the sticky with/registers its Miro custom card. Jira's
    // "Work item created" automation can reach this Worker in the tiny gap
    // between those two operations. Without a grace period, the Incoming
    // auto-create path sees an unmapped Jira issue and creates a second card.
    //
    // Give the conversion flow a short chance to register its mapping. Normal
    // Jira-created issues simply wait these few seconds before appearing in
    // Incoming. Mapped issues/status changes are never delayed.
    if (!existing) {
      await new Promise(resolve => setTimeout(resolve, CREATE_GRACE_MS));

      const mappingAfterGrace = await env.CARD_MAP.get(mapKey);
      if (mappingAfterGrace) {
        console.log(
          "JIRA -> MIRO Incoming create skipped after mapping appeared during grace period:",
          issueKey,
          mappingAfterGrace,
        );
      }
    }

    return incomingWorker.fetch(request, env, ctx);
  },
};
