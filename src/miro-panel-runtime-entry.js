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

function normalizeGeneratedClientScript(script) {
  // The panel HTML is generated inside a Worker template literal. Escapes such
  // as \n inside quoted browser-JS strings are evaluated once while rendering
  // the HTML, which can leave literal line breaks inside those strings and make
  // the external client script invalid JavaScript. Re-escape the known status
  // message newlines before serving the browser script.
  return script
    .replace(
      ' failed and were left on the board.\n\n" + failures',
      ' failed and were left on the board.\\n\\n" + failures',
    )
    .replace(
      'setStatus("No notes were converted.\n\n" + failures',
      'setStatus("No notes were converted.\\n\\n" + failures',
    )
    .replaceAll('.join("\n")', '.join("\\n")');
}

function patchConvertedCardLookup(script) {
  const startNeedle = "  async function waitForCustomCard(issueKey) {";
  const endNeedle = "\n  async function applyConversionStatus";
  const start = script.indexOf(startNeedle);
  if (start < 0) return script;
  const end = script.indexOf(endNeedle, start);
  if (end < 0) return script;

  const replacement = `  async function waitForCustomCard(issueKey) {
    const normalizedIssueKey = String(issueKey || "").trim().toUpperCase();
    const expectedTitle = "CUSTOM_JIRA_CARD:" + normalizedIssueKey;
    const started = Date.now();

    while (Date.now() - started < 12000) {
      let mappedItemId = "";

      try {
        const response = await backendPost("/conversion-card-id", { issueKey: normalizedIssueKey });
        const result = await response.json();
        if (response.ok && result && result.ok && result.itemId) {
          mappedItemId = String(result.itemId);
        }
      } catch (error) {
        console.warn("Conversion card mapping lookup retry", normalizedIssueKey, error);
      }

      // Images created by the Jira creation webhook can exist on the board
      // before getById() can resolve them in this panel's SDK cache. Scan the
      // board directly and match either the mapped item ID or our card title.
      try {
        const images = await miro.board.get({ type: "image" });
        const match = (images || []).find(function (image) {
          const imageId = String(image && image.id || "");
          const title = String(
            image && (image.title || (image.data && image.data.title)) || ""
          ).trim().toUpperCase();

          return (
            (mappedItemId && imageId === mappedItemId) ||
            title === expectedTitle
          );
        });

        if (match) return match;
      } catch (error) {
        console.warn("Conversion card board scan retry", normalizedIssueKey, error);
      }

      if (mappedItemId) {
        try {
          const item = await miro.board.getById(mappedItemId);
          if (item && item.type === "image") return item;
        } catch (error) {
          console.warn("Conversion card direct lookup retry", normalizedIssueKey, error);
        }
      }

      await new Promise(function (resolve) { setTimeout(resolve, 200); });
    }

    throw new Error(normalizedIssueKey + " was created in Jira, but its Miro card could not be resolved for repositioning.");
  }
`;

  return script.slice(0, start) + replacement + script.slice(end);
}

function buildClientScript(html) {
  const extracted = extractClientScript(html);
  if (!extracted) return null;
  return patchConvertedCardLookup(normalizeGeneratedClientScript(extracted));
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/miro-panel-client.js") {
      const { html } = await readPanelHtml();
      const script = buildClientScript(html);
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
      const externalBlock = '<script src="/miro-panel-client.js?v=20260831-3"></script>';
      const patched = html.replace(inlineBlock, externalBlock);
      return responseWithText(response, patched, "text/html; charset=utf-8");
    }

    return new Response("Not found", { status: 404 });
  },
};
