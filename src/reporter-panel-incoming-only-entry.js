import reporterWorker from "./reporter-panel-diagnostic-entry.js";

function responseWithText(original, text) {
  const headers = new Headers(original.headers);
  headers.delete("Content-Length");
  return new Response(text, {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

async function patchStickyConversionToIncoming(baseResponse) {
  if (!baseResponse.ok) return baseResponse;

  const html = await baseResponse.clone().text();
  if (html.includes("STICKY CONVERSION: INCOMING OWNS CARD")) {
    return baseResponse;
  }

  const startNeedle = `      setStatus(\n        issueKey +\n        " exists. Building custom card…",`;
  const catchNeedle = `\n\n    } catch (\n      error\n    ) {`;

  const start = html.indexOf(startNeedle);
  if (start < 0) {
    console.warn("STICKY CONVERSION: could not find local-card creation block start");
    return baseResponse;
  }

  const end = html.indexOf(catchNeedle, start);
  if (end < 0) {
    console.warn("STICKY CONVERSION: could not find conversion catch block");
    return baseResponse;
  }

  const replacement = `      // STICKY CONVERSION: INCOMING OWNS CARD\n      // Jira creation sync is the single owner of Miro card creation.\n      // Do not create a second card locally in the panel.\n      setStatus(\n        issueKey +\n        " created. Sending card to Incoming…",\n        "info"\n      );\n\n      await sticky.setMetadata(\n        CONVERSION_METADATA_KEY,\n        {\n          issueKey,\n          stage:\n            "card-created",\n          workType:\n            detectedWorkType,\n          stickyColor\n        }\n      );\n\n      await miro.board.remove(\n        sticky\n      );\n\n      setStatus(\n        issueKey +\n        " converted successfully. Card will appear in Incoming.",\n        "success"\n      );\n\n      console.log(\n        "CUSTOM CARD STICKY CONVERSION COMPLETE - Incoming owns card:",\n        {\n          issueKey,\n          workType:\n            detectedWorkType\n        }\n      );\n`;

  const patched = html.slice(0, start) + replacement + html.slice(end);
  return responseWithText(baseResponse, patched);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/miro-panel") {
      const response = await reporterWorker.fetch(request, env, ctx);
      return await patchStickyConversionToIncoming(response);
    }

    return reporterWorker.fetch(request, env, ctx);
  },
};
