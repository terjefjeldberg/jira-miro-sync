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
      Show selected item creator ID
    </button>
    <div id="creatorDiagnosticResult" style="display:none;margin-top:10px;padding:10px;border:1px solid #d9d9d9;border-radius:4px;background:#f7f7f7;">
      <div style="font-size:12px;margin-bottom:4px;">Miro creator ID</div>
      <input id="creatorDiagnosticId" type="text" readonly style="box-sizing:border-box;width:100%;padding:7px;border:1px solid #c8c8c8;border-radius:3px;background:#ffffff;user-select:text;" />
      <button id="copyCreatorIdButton" type="button" style="margin-top:8px;background:#ffffff;color:#4262ff;border:1px solid #4262ff;">
        Copy ID
      </button>
    </div>
  `;

  const buttonTarget = '<button id="convertButton">';
  let patched = html;

  if (patched.includes(buttonTarget) && !patched.includes('id="creatorIdButton"')) {
    patched = patched.replace(buttonTarget, buttonMarkup + "\n" + buttonTarget);
  }

  const script = `
<script>
(function () {
  function creatorId(createdBy) {
    if (!createdBy) return "";
    if (typeof createdBy === "string" || typeof createdBy === "number") {
      return String(createdBy).trim();
    }
    return String(
      createdBy.id ??
      createdBy.userId ??
      createdBy.memberId ??
      createdBy.user?.id ??
      ""
    ).trim();
  }

  function isSupportedItem(item) {
    return item?.type === "sticky_note" || item?.type === "card";
  }

  const button = document.getElementById("creatorIdButton");
  const result = document.getElementById("creatorDiagnosticResult");
  const idElement = document.getElementById("creatorDiagnosticId");
  const copyButton = document.getElementById("copyCreatorIdButton");
  if (!button || !result || !idElement || !copyButton) return;

  function clearResult() {
    idElement.value = "";
    result.style.display = "none";
  }

  async function refreshFromCurrentSelection(selectId) {
    const selected = await miro.board.getSelection();
    if (!Array.isArray(selected) || selected.length !== 1 || !isSupportedItem(selected[0])) {
      clearResult();
      return false;
    }

    const id = creatorId(selected[0].createdBy);
    if (!id) {
      clearResult();
      return false;
    }

    idElement.value = id;
    result.style.display = "block";
    if (selectId) {
      idElement.focus();
      idElement.select();
    }
    return true;
  }

  button.addEventListener("click", async function () {
    try {
      const shown = await refreshFromCurrentSelection(true);
      if (!shown) alert("Select exactly one sticky note or Miro card first.");
    } catch (error) {
      console.error("MIRO CREATOR ID DIAGNOSTIC FAILED:", error);
      alert("Could not read the selected item creator ID.");
    }
  });

  miro.board.ui.on("selection:update", function () {
    refreshFromCurrentSelection(false).catch(function (error) {
      console.error("MIRO CREATOR SELECTION UPDATE FAILED:", error);
    });
  });

  copyButton.addEventListener("click", async function () {
    const value = String(idElement.value || "").trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      copyButton.textContent = "Copied";
      setTimeout(function () { copyButton.textContent = "Copy ID"; }, 1000);
    } catch {
      idElement.focus();
      idElement.select();
    }
  });

  refreshFromCurrentSelection(false).catch(function (error) {
    console.error("MIRO CREATOR INITIAL REFRESH FAILED:", error);
  });
})();
</script>
`;

  if (!patched.includes("MIRO CREATOR ID DIAGNOSTIC FAILED:")) {
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
