import productionWorker from "./production-entry.js";
import conversionWorker from "./conversion-aware-entry.js";
import { renderMiroPanelV2 } from "./miro-panel-v2.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/miro-panel") {
      return renderMiroPanelV2();
    }

    if (
      (request.method === "POST" && url.pathname === "/") ||
      (request.method === "POST" && url.pathname === "/conversion-card-id") ||
      (request.method === "POST" && url.pathname === "/conversion-set-status")
    ) {
      return conversionWorker.fetch(request, env, ctx);
    }

    return productionWorker.fetch(request, env, ctx);
  },
};