import { renderMiroPanelV2 } from "./miro-panel-v2.js";

function responseWithText(original, text, contentType) {
  const headers = new Headers(original.headers);
  headers.delete("Content-Length");
  headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  if (contentType) headers.set("Content-Type", contentType);
  return new Response(text, {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

async function readPanelHtml() {
  const response = renderMiroPanelV2();
  const html = await response.text();
  return { response, html };
}

function extractClientScript(html) {
  const marker = "(function () {";
  const startMarker = `<script>\n${marker}`;
  const start = html.indexOf(startMarker);
  if (start < 0) return null;
  const scriptStart = start + "<script>\n".length;
  const end = html.indexOf("\n</script>", scriptStart);
  if (end < 0) return null;
  return html.slice(scriptStart, end);
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/miro-panel-client.js") {
      const { html } = await readPanelHtml();
      const script = extractClientScript(html);
      if (!script) {
        return new Response("console.error('Could not load Miro panel client');", {
          status: 500,
          headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      return new Response(script, {
        status: 200,
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/miro-panel") {
      const { response, html } = await readPanelHtml();
      const script = extractClientScript(html);
      if (!script) return response;

      const inlineBlock = `<script>\n${script}\n</script>`;
      const externalBlock = '<script src="/miro-panel-client.js?v=20260831-1"></script>';
      const patched = html.replace(inlineBlock, externalBlock);
      return responseWithText(response, patched, "text/html; charset=utf-8");
    }

    return new Response("Not found", { status: 404 });
  },
};
