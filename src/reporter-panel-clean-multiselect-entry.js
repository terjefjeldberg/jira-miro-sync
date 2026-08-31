import reporterWorker from "./reporter-panel-incoming-only-entry.js";

function responseWithText(original, text) {
  const headers = new Headers(original.headers);
  headers.delete("Content-Length");
  return new Response(text, {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

async function patchPanel(baseResponse) {
  if (!baseResponse.ok) return baseResponse;

  let html = await baseResponse.clone().text();
  if (html.includes("CLEAN MULTI STICKY CONVERSION PANEL")) {
    return baseResponse;
  }

  // Remove the old helper text under the button. It is implementation detail
  // and is not useful to normal users.
  html = html.replace(
    /<div class="small">\s*Work type is determined from the sticky colour\.\s*Tags and assignee are ignored for now\.\s*<\/div>/m,
    "",
  );

  const script = `
<script>
(function () {
  // CLEAN MULTI STICKY CONVERSION PANEL
  const CONVERSION_METADATA_KEY = "rendraStickyJiraConversionV1";

  const COLOR_TO_WORK_TYPE = {
    light_pink: "Bug",
    pink: "Bug",
    violet: "Bug",
    light_blue: "Improvement",
    blue: "Improvement",
    dark_blue: "Improvement",
    gray: "Improvement",
    light_yellow: "Spike",
    yellow: "Spike",
    light_green: "New Feature",
    green: "New Feature",
    dark_green: "New Feature",
    orange: "Hotfix candidate",
    red: "Hotfix candidate",
    cyan: "Task/config/doc/test"
  };

  function plainText(value) {
    const holder = document.createElement("div");
    holder.innerHTML = String(value || "");
    return String(holder.textContent || "").replace(/\\s+/g, " ").trim();
  }

  function workTypeFromSticky(sticky) {
    const color = String(sticky?.style?.fillColor || "").trim().toLowerCase();
    return COLOR_TO_WORK_TYPE[color] || "Bug";
  }

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

  async function backendPost(path, body) {
    const token = await miro.board.getIdToken();
    return await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token
      },
      body: JSON.stringify(body)
    });
  }

  const heading = document.querySelector("h2");
  if (heading) heading.textContent = "Convert Miro notes to Jira";

  const intro = document.querySelector("body > p");
  if (intro) {
    intro.textContent = "Select one or more sticky notes on the board, then convert them to Jira. Each note becomes a Jira issue and will appear in Incoming.";
  }

  const oldButton = document.getElementById("convertButton");
  const status = document.getElementById("status");
  if (!oldButton || !status) return;

  // Replace the button node to remove the old single-select click listener.
  const convertButton = oldButton.cloneNode(true);
  convertButton.textContent = "Convert selected notes to Jira";
  oldButton.replaceWith(convertButton);

  // Put diagnostic controls behind a collapsed Admin tools section.
  const creatorButton = document.getElementById("creatorIdButton");
  const creatorResult = document.getElementById("creatorDiagnosticResult");
  const frameButton = document.getElementById("frameIdButton");
  const frameResult = document.getElementById("frameDiagnosticResult");

  if (creatorButton && frameButton) {
    const details = document.createElement("details");
    details.style.marginTop = "14px";

    const summary = document.createElement("summary");
    summary.textContent = "Admin tools";
    summary.style.cursor = "pointer";
    summary.style.fontSize = "12px";
    summary.style.color = "#666";
    details.appendChild(summary);

    const tools = document.createElement("div");
    tools.style.marginTop = "10px";
    tools.appendChild(creatorButton);
    if (creatorResult) tools.appendChild(creatorResult);
    tools.appendChild(frameButton);
    if (frameResult) tools.appendChild(frameResult);
    details.appendChild(tools);

    const card = convertButton.closest(".card");
    if (card) card.appendChild(details);
  }

  function setStatus(message, type) {
    status.className = type || "info";
    status.textContent = message;
  }

  async function convertSticky(sticky) {
    const summary = plainText(sticky.content);
    if (!summary) {
      throw new Error("This sticky note has no text.");
    }

    let conversionState;
    try {
      conversionState = await sticky.getMetadata(CONVERSION_METADATA_KEY);
    } catch {
      conversionState = undefined;
    }

    if (conversionState?.issueKey) {
      if (conversionState.stage === "card-created") {
        await miro.board.remove(sticky);
        return { issueKey: String(conversionState.issueKey), alreadyConverted: true };
      }
      return { issueKey: String(conversionState.issueKey), alreadyCreated: true };
    }

    const workType = workTypeFromSticky(sticky);
    const response = await backendPost("/sticky-to-jira", {
      summary,
      workType,
      stickyId: String(sticky.id),
      createdBy: creatorId(sticky.createdBy)
    });

    let result = null;
    try {
      result = await response.json();
    } catch {}

    if (!response.ok || !result?.ok || !result?.issueKey) {
      const reason = result?.reason || result?.error || "Could not create Jira issue.";
      throw new Error(typeof reason === "string" ? reason : JSON.stringify(reason));
    }

    const issueKey = String(result.issueKey);
    await sticky.setMetadata(CONVERSION_METADATA_KEY, {
      issueKey,
      stage: "card-created",
      workType,
      stickyColor: String(sticky?.style?.fillColor || "")
    });

    await miro.board.remove(sticky);
    return { issueKey, created: true };
  }

  convertButton.addEventListener("click", async function () {
    convertButton.disabled = true;

    try {
      const selection = await miro.board.getSelection();
      const stickies = (Array.isArray(selection) ? selection : []).filter(item => item?.type === "sticky_note");
      const unsupportedCount = (Array.isArray(selection) ? selection.length : 0) - stickies.length;

      if (stickies.length === 0) {
        throw new Error("Select at least one sticky note on the board first.");
      }

      if (unsupportedCount > 0) {
        throw new Error("Select only sticky notes before converting.");
      }

      setStatus(
        stickies.length === 1
          ? "Converting 1 note to Jira…"
          : "Converting " + stickies.length + " notes to Jira…",
        "info"
      );

      const successes = [];
      const failures = [];

      // Sequential conversion avoids hammering Jira/Miro and keeps reporter,
      // metadata and Jira creation automation ordering deterministic.
      for (let index = 0; index < stickies.length; index += 1) {
        const sticky = stickies[index];
        setStatus(
          "Converting " + (index + 1) + " of " + stickies.length + "…",
          "info"
        );

        try {
          const result = await convertSticky(sticky);
          successes.push(result.issueKey);
        } catch (error) {
          failures.push({
            text: plainText(sticky.content).slice(0, 60) || "Untitled note",
            reason: error?.message || String(error)
          });
        }
      }

      if (failures.length === 0) {
        setStatus(
          successes.length === 1
            ? successes[0] + " created successfully. Card will appear in Incoming."
            : successes.length + " Jira issues created successfully. Cards will appear in Incoming.",
          "success"
        );
      } else if (successes.length > 0) {
        setStatus(
          successes.length + " converted successfully. " + failures.length + " failed and were left on the board.\n\n" +
          failures.map(item => item.text + ": " + item.reason).join("\n"),
          "error"
        );
      } else {
        setStatus(
          "No notes were converted.\n\n" + failures.map(item => item.text + ": " + item.reason).join("\n"),
          "error"
        );
      }
    } catch (error) {
      setStatus(error?.message || String(error), "error");
    } finally {
      convertButton.disabled = false;
    }
  });
})();
</script>
`;

  html = html.replace("</body>", script + "\n</body>");
  return responseWithText(baseResponse, html);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/miro-panel") {
      const response = await reporterWorker.fetch(request, env, ctx);
      return await patchPanel(response);
    }

    return reporterWorker.fetch(request, env, ctx);
  },
};
