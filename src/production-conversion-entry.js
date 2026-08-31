import productionWorker from "./production-entry.js";
import conversionWorker from "./conversion-aware-entry.js";
import panelRuntimeWorker from "./miro-panel-runtime-entry.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      (url.pathname === "/miro-panel" || url.pathname === "/miro-panel-client.js")
    ) {
      return panelRuntimeWorker.fetch(request, env, ctx);
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
