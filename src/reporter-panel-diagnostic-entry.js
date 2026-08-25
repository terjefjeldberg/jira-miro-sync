import reporterWorker from "./reporter-jira-picker-entry.js";

function responseWithText(original, text) {
  const headers = new Headers(original.headers);
  headers.delete("Content-Length");
  return new Response(text, {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

async function injectCreatorDiagnostic(baseResponse) {
  if (!baseResponse.ok) return baseResponse;

  const html = await baseResponse.clone().text();

  const buttonMarkup = `
    <button id="creatorIdButton" type="button" style="margin-top:10px;background:#ffffff;color:#4262ff;border:1px solid #4262ff;">
      Show selected sticky creator
    </button>
  `;

  const buttonTarget = '<button id="convertButton">';
  let patched = html;

  if (patched.includes(buttonTarget) && !patched.includes('id="creatorIdButton"')) {
    patched = patched.replace(buttonTarget, buttonMarkup + "\n" + buttonTarget);
  }

  const script = `
<script>
(function () {
  const KNOWN_MIRO_CREATORS = {
    "3458764589815876301": "Kristoffer Rask",
    "3074457347700027993": "Tim Chipman",
    "3074457362562828515": "Rupert Hanna",
    "3458764555898556023": "Masud Mahamed"
  };

  const creatorIdButton = document.getElementById("creatorIdButton");
  if (!creatorIdButton) return;

  creatorIdButton.addEventListener("click", async function () {
    try {
      const selected = await miro.board.getSelection();
      if (!Array.isArray(selected) || selected.length !== 1) {
        alert("Select exactly one sticky note first.");
        return;
      }

      const sticky = selected[0];
      if (!sticky || sticky.type !== "sticky_note") {
        alert("The selected item is not a sticky note.");
        return;
      }

      const creatorId = String(sticky.createdBy || "").trim();
      if (!creatorId) {
        alert("Miro did not return a creator ID for this sticky note.");
        return;
      }

      const creatorName = KNOWN_MIRO_CREATORS[creatorId] || "Unknown creator";
      alert("Creator: " + creatorName + "\\nMiro creator ID: " + creatorId);
    } catch (error) {
      console.error("MIRO CREATOR ID DIAGNOSTIC FAILED:", error);
      alert("Could not read the sticky creator. Check the browser console for details.");
    }
  });
})();
</script>
`;

  if (!patched.includes("KNOWN_MIRO_CREATORS")) {
    patched = patched.replace("</body>", script + "\n</body>");
  }

  return responseWithText(baseResponse, patched);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/miro-panel") {
      const response = await reporterWorker.fetch(request, env, ctx);
      return await injectCreatorDiagnostic(response);
    }

    return reporterWorker.fetch(request, env, ctx);
  },
};
