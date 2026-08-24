import reporterWorker from "./reporter-fallback-entry.js";
import previewWorker from "./preview-entry-v2.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Sticky conversion and panel creator injection use the production reporter flow.
    if (
      (request.method === "POST" && url.pathname === "/sticky-to-jira") ||
      (request.method === "GET" && url.pathname === "/miro-panel")
    ) {
      return reporterWorker.fetch(request, env, ctx);
    }

    // Everything else uses the fully tested preview implementation now promoted to production.
    return previewWorker.fetch(request, env, ctx);
  },
};
