import incomingWorker from "./incoming-card-entry.js";

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

async function readJson(response) {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/") {
      return incomingWorker.fetch(request, env, ctx);
    }

    const firstResponse = await incomingWorker.fetch(request.clone(), env, ctx);
    const firstBody = await readJson(firstResponse);

    const issueKey = String(firstBody?.issueKey ?? "").trim().toUpperCase();
    const ignoredForNonBoardStatus =
      firstResponse.ok &&
      firstBody?.ok === true &&
      firstBody?.ignored === true &&
      /^Unapproved status:/i.test(String(firstBody?.reason ?? "")) &&
      /^SN-\d+$/i.test(issueKey);

    if (!ignoredForNonBoardStatus) {
      return firstResponse;
    }

    let originalBody = null;
    try {
      originalBody = await request.clone().json();
    } catch {
      return firstResponse;
    }

    // The underlying Jira -> Miro worker only reaches the mapping lookup for
    // board statuses (Todo/In progress/etc.). Newly created issues may still
    // be in Backlog, but they should nevertheless get an Incoming card.
    // Re-run the same authenticated webhook internally with a board status so
    // the Incoming layer can perform its idempotent mapping/create check.
    // This does not change Jira status; it only reaches the Miro create path.
    const retryRequest = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({
        ...originalBody,
        issueKey,
        status: "Todo",
      }),
    });

    const retryResponse = await incomingWorker.fetch(retryRequest, env, ctx);
    const retryBody = await readJson(retryResponse);

    if (!retryBody) {
      return retryResponse;
    }

    return jsonResponseLike(retryResponse, {
      ...retryBody,
      incomingTriggeredFromStatus: String(originalBody?.status ?? ""),
    });
  },
};
