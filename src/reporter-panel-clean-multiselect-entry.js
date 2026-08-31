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
  if (html.includes("CLEAN MULTI STICKY POSITION-PRESERVING CONVERSION")) {
    return baseResponse;
  }

  html = html.replace(
    /<div class="small">\s*Work type is determined from the sticky colour\.\s*Tags and assignee are ignored for now\.\s*<\/div>/m,
    "",
  );

  const script = `
<script>
(function () {
  // CLEAN MULTI STICKY POSITION-PRESERVING CONVERSION
  const CONVERSION_METADATA_KEY = "rendraStickyJiraConversionV1";

  const ACTIVE_BOARD = {
    left: 438.36642375544034,
    right: 5303.436262036128,
    top: 434.257014599023,
    bottom: 3045.734778444852
  };

  const STATUS_COLUMNS = [
    { status: "Todo", left: 1468.7903676550886, right: 2551.696467655089 },
    { status: "In progress", left: 2564.6113791667394, right: 3277.6028791667395 },
    { status: "Functional review", left: 3289.4484150169965, right: 3651.451815016996 },
    { status: "Code review", left: 3662.9922412433402, right: 4020.66884124334 },
    { status: "Approved", left: 4033.200178788891, right: 4680.471778788891 },
    { status: "Merged", left: 4692.4616140640555, right: 5284.738514064056 }
  ];

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

  async function getCanvasPosition(item) {
    const x = Number(item?.x);
    const y = Number(item?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("A selected note has an invalid board position.");
    }

    if (!item.parentId || item.relativeTo === "canvas_center") {
      return { x, y };
    }

    const parent = await miro.board.getById(item.parentId);
    if (!parent) {
      throw new Error("Could not resolve a selected note's parent frame.");
    }

    const parentPosition = await getCanvasPosition(parent);

    if (item.relativeTo === "parent_top_left") {
      const parentWidth = Number(parent.width);
      const parentHeight = Number(parent.height);
      if (!Number.isFinite(parentWidth) || !Number.isFinite(parentHeight)) {
        throw new Error("Could not resolve a selected note's frame dimensions.");
      }
      return {
        x: parentPosition.x - parentWidth / 2 + x,
        y: parentPosition.y - parentHeight / 2 + y
      };
    }

    if (item.relativeTo === "parent_center") {
      return {
        x: parentPosition.x + x,
        y: parentPosition.y + y
      };
    }

    return { x, y };
  }

  function statusFromPosition(sticky, canvasPosition) {
    if (
      canvasPosition.x < ACTIVE_BOARD.left ||
      canvasPosition.x > ACTIVE_BOARD.right ||
      canvasPosition.y < ACTIVE_BOARD.top ||
      canvasPosition.y > ACTIVE_BOARD.bottom
    ) {
      return null;
    }

    const width = Number(sticky?.width);
    const effectiveWidth = Number.isFinite(width) && width > 0 ? width : 1;
    const itemLeft = canvasPosition.x - effectiveWidth / 2;
    const itemRight = canvasPosition.x + effectiveWidth / 2;

    const ranked = STATUS_COLUMNS
      .map(column => {
        const overlap = Math.max(0, Math.min(itemRight, column.right) - Math.max(itemLeft, column.left));
        return { ...column, ratio: overlap / effectiveWidth };
      })
      .sort((a, b) => b.ratio - a.ratio);

    return ranked[0] && ranked[0].ratio >= 0.60 ? ranked[0].status : null;
  }

  async function waitForCustomCard(issueKey) {
    const started = Date.now();
    const timeoutMs = 8000;

    while (Date.now() - started < timeoutMs) {
      try {
        const response = await backendPost("/conversion-card-id", { issueKey });
        const result = await response.json();
        if (response.ok && result?.ok && result?.itemId) {
          const item = await miro.board.getById(String(result.itemId));
          if (item && item.type === "image") return item;
        }
      } catch (error) {
        console.warn("CONVERSION card lookup retry", issueKey, error);
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    throw new Error(issueKey + " was created in Jira, but its Miro card did not appear in time. Try converting the note again; the existing Jira issue will be reused.");
  }

  async function applyConversionStatus(issueKey, desiredStatus) {
    if (!desiredStatus) return;

    const response = await backendPost("/conversion-set-status", {
      issueKey,
      desiredStatus
    });

    let result = null;
    try {
      result = await response.json();
    } catch {}

    if (!response.ok || !result?.ok) {
      const reason = result?.reason || result?.error || "Could not set Jira status.";
      throw new Error(typeof reason === "string" ? reason : JSON.stringify(reason));
    }
  }

  async function moveCardToExactCanvasPosition(card, canvasPosition) {
    let current = card;

    if (current.parentId) {
      const parent = await miro.board.getById(current.parentId);
      if (!parent || typeof parent.remove !== "function") {
        throw new Error("Could not release the converted card from Incoming.");
      }

      await parent.remove(current);
      current = await miro.board.getById(String(current.id));
      if (!current) {
        throw new Error("Could not reload the converted Miro card.");
      }
    }

    current.x = canvasPosition.x;
    current.y = canvasPosition.y;
    await current.sync();
    return current;
  }

  const heading = document.querySelector("h2");
  if (heading) heading.textContent = "Convert Miro notes to Jira";

  const intro = document.querySelector("body > p");
  if (intro) {
    intro.textContent = "Select one or more sticky notes and convert them to Jira. The converted cards stay exactly where the notes are. Notes inside a workflow column get that Jira status; notes outside the workflow board keep Jira's default status.";
  }

  const oldButton = document.getElementById("convertButton");
  const status = document.getElementById("status");
  if (!oldButton || !status) return;

  const convertButton = oldButton.cloneNode(true);
  convertButton.textContent = "Convert selected notes";
  oldButton.replaceWith(convertButton);

  const creatorButton = document.getElementById("creatorIdButton");
  const creatorResult = document.getElementById("creatorDiagnosticResult");
  const frameButton = document.getElementById("frameIdButton");
  const frameResult = document.getElementById("frameDiagnosticResult");

  if (creatorButton && frameButton) {
    const details = document.createElement("details");
    details.style.marginTop = "14px";

    const adminSummary = document.createElement("summary");
    adminSummary.textContent = "Admin tools";
    adminSummary.style.cursor = "pointer";
    adminSummary.style.fontSize = "12px";
    adminSummary.style.color = "#666";
    details.appendChild(adminSummary);

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

    const originalPosition = await getCanvasPosition(sticky);
    const desiredStatus = statusFromPosition(sticky, originalPosition);
    const workType = workTypeFromSticky(sticky);
    const stickyColor = String(sticky?.style?.fillColor || "");

    let conversionState;
    try {
      conversionState = await sticky.getMetadata(CONVERSION_METADATA_KEY);
    } catch {
      conversionState = undefined;
    }

    if (conversionState?.stage === "card-created" && conversionState?.issueKey) {
      await miro.board.remove(sticky);
      return {
        issueKey: String(conversionState.issueKey),
        desiredStatus,
        alreadyConverted: true
      };
    }

    let issueKey = conversionState?.issueKey
      ? String(conversionState.issueKey)
      : "";

    if (!issueKey) {
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

      issueKey = String(result.issueKey);

      await sticky.setMetadata(CONVERSION_METADATA_KEY, {
        issueKey,
        stage: "jira-created",
        workType,
        stickyColor,
        desiredStatus: desiredStatus || null
      });
    }

    const customCard = await waitForCustomCard(issueKey);

    // Set Jira status before placing the final card. The backend suppresses the
    // corresponding Jira -> Miro movement so the conversion itself never
    // changes the note/card's original board position.
    await applyConversionStatus(issueKey, desiredStatus);

    const movedCard = await moveCardToExactCanvasPosition(customCard, originalPosition);

    await sticky.setMetadata(CONVERSION_METADATA_KEY, {
      issueKey,
      stage: "card-created",
      customCardFrameId: String(movedCard.id),
      workType,
      stickyColor,
      desiredStatus: desiredStatus || null
    });

    await miro.board.remove(sticky);

    return {
      issueKey,
      desiredStatus,
      created: true
    };
  }

  convertButton.addEventListener("click", async function () {
    convertButton.disabled = true;

    try {
      const selection = await miro.board.getSelection();
      const selected = Array.isArray(selection) ? selection : [];
      const stickies = selected.filter(item => item?.type === "sticky_note");
      const unsupportedCount = selected.length - stickies.length;

      if (stickies.length === 0) {
        throw new Error("Select at least one sticky note first.");
      }

      if (unsupportedCount > 0) {
        throw new Error("Select only sticky notes before converting.");
      }

      setStatus(
        stickies.length === 1
          ? "Converting 1 note…"
          : "Converting " + stickies.length + " notes…",
        "info"
      );

      const successes = [];
      const failures = [];

      for (let index = 0; index < stickies.length; index += 1) {
        const sticky = stickies[index];
        setStatus(
          "Converting " + (index + 1) + " of " + stickies.length + "…",
          "info"
        );

        try {
          const result = await convertSticky(sticky);
          successes.push(result);
        } catch (error) {
          failures.push({
            text: plainText(sticky.content).slice(0, 60) || "Untitled note",
            reason: error?.message || String(error)
          });
        }
      }

      if (failures.length === 0) {
        if (successes.length === 1) {
          const result = successes[0];
          setStatus(
            result.issueKey + " converted successfully" +
              (result.desiredStatus ? " with status " + result.desiredStatus + "." : " with the default Jira status."),
            "success"
          );
        } else {
          setStatus(
            successes.length + " notes converted successfully. Their positions were preserved.",
            "success"
          );
        }
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