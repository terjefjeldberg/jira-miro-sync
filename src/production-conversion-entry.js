import productionWorker from "./production-entry.js";
import directConversionWorker from "./conversion-direct-card-entry.js";
import { renderMiroPanelV3, renderMiroPanelV3Client } from "./miro-panel-v3.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/miro-panel") {
      return renderMiroPanelV3();
    }

    if (request.method === "GET" && url.pathname === "/miro-panel-v3-client.js") {
      return renderMiroPanelV3Client();
    }

    if (
      (request.method === "POST" && url.pathname === "/") ||
      (request.method === "POST" && url.pathname === "/conversion-card-id") ||
      (request.method === "POST" && url.pathname === "/conversion-set-status") ||
      (request.method === "POST" && url.pathname === "/conversion-direct-card")
    ) {
      return directConversionWorker.fetch(request, env, ctx);
    }

    return productionWorker.fetch(request, env, ctx);
  },
};
