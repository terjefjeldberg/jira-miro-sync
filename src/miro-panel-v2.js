export function renderMiroPanelV2() {
  return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Convert Miro notes to Jira</title>
  <script src="https://miro.com/app/static/sdk/v2/miro.js"></script>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 20px; font-family: Arial, sans-serif; color: #1a1a1a; background: #fff; }
    h2 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0 0 16px; font-size: 13px; line-height: 1.45; }
    .card { border: 1px solid #e6e6e6; border-radius: 8px; padding: 16px; }
    button { width: 100%; min-height: 42px; border: 0; border-radius: 6px; padding: 10px 14px; font-size: 14px; font-weight: 600; cursor: pointer; background: #4262ff; color: #fff; }
    button:disabled { opacity: .5; cursor: default; }
    #status { display: none; margin-top: 14px; padding: 10px; border-radius: 6px; font-size: 12px; line-height: 1.4; white-space: pre-wrap; }
    #status.info { display: block; background: #eef2ff; }
    #status.success { display: block; background: #e8f7ed; }
    #status.error { display: block; background: #ffeceb; }
    details { margin-top: 14px; }
    summary { cursor: pointer; font-size: 12px; color: #666; }
    .admin-tools { margin-top: 10px; display: grid; gap: 8px; }
    .admin-tools button { background: #fff; color: #4262ff; border: 1px solid #4262ff; }
    .diagnostic { display: none; padding: 10px; border: 1px solid #d9d9d9; border-radius: 4px; background: #f7f7f7; }
    .diagnostic label { display: block; font-size: 12px; margin-bottom: 4px; }
    .diagnostic input { width: 100%; padding: 7px; border: 1px solid #c8c8c8; border-radius: 3px; background: #fff; }
  </style>
</head>
<body>
  <h2>Convert Miro notes to Jira</h2>
  <p>Select one or more sticky notes and convert them to Jira. Converted cards stay exactly where the notes are. Notes inside a workflow column get that Jira status; notes outside the workflow board keep Jira's default status.</p>

  <div class="card">
    <button id="convertButton">Convert selected notes</button>
    <div id="status"></div>

    <details>
      <summary>Admin tools</summary>
      <div class="admin-tools">
        <button id="creatorIdButton" type="button">Show selected item creator ID</button>
        <div id="creatorDiagnostic" class="diagnostic">
          <label for="creatorId">Miro creator ID</label>
          <input id="creatorId" readonly />
        </div>
        <button id="frameIdButton" type="button">Show selected frame ID</button>
        <div id="frameDiagnostic" class="diagnostic">
          <label for="frameId">Miro frame ID</label>
          <input id="frameId" readonly />
        </div>
      </div>
    </details>
  </div>

<script>
(function () {
  const CONVERSION_METADATA_KEY = "rendraStickyJiraConversionV1";
  const ACTIVE_BOARD = { left: 438.36642375544034, right: 5303.436262036128, top: 434.257014599023, bottom: 3045.734778444852 };
  const STATUS_COLUMNS = [
    { status: "Todo", left: 1468.7903676550886, right: 2551.696467655089 },
    { status: "In progress", left: 2564.6113791667394, right: 3277.6028791667395 },
    { status: "Functional review", left: 3289.4484150169965, right: 3651.451815016996 },
    { status: "Code review", left: 3662.9922412433402, right: 4020.66884124334 },
    { status: "Approved", left: 4033.200178788891, right: 4680.471778788891 },
    { status: "Merged", left: 4692.4616140640555, right: 5284.738514064056 }
  ];
  const COLOR_TO_WORK_TYPE = {
    light_pink: "Bug", pink: "Bug", violet: "Bug",
    light_blue: "Improvement", blue: "Improvement", dark_blue: "Improvement", gray: "Improvement",
    light_yellow: "Spike", yellow: "Spike",
    light_green: "New Feature", green: "New Feature", dark_green: "New Feature",
    orange: "Hotfix candidate", red: "Hotfix candidate",
    cyan: "Task/config/doc/test"
  };

  const convertButton = document.getElementById("convertButton");
  const statusElement = document.getElementById("status");

  function setStatus(message, type) {
    statusElement.className = type || "info";
    statusElement.textContent = message;
  }

  function plainText(value) {
    const holder = document.createElement("div");
    holder.innerHTML = String(value || "");
    return String(holder.textContent || "").replace(/\\s+/g, " ").trim();
  }

  function workTypeFromSticky(sticky) {
    const color = String(sticky && sticky.style && sticky.style.fillColor || "").trim().toLowerCase();
    return COLOR_TO_WORK_TYPE[color] || "Bug";
  }

  function creatorId(createdBy) {
    if (!createdBy) return "";
    if (typeof createdBy === "string" || typeof createdBy === "number") return String(createdBy).trim();
    return String(createdBy.id || createdBy.userId || createdBy.memberId || (createdBy.user && createdBy.user.id) || "").trim();
  }

  async function backendPost(path, body) {
    const token = await miro.board.getIdToken();
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(body)
    });
  }

  async function getCanvasPosition(item) {
    const x = Number(item && item.x);
    const y = Number(item && item.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("A selected note has an invalid board position.");
    if (!item.parentId || item.relativeTo === "canvas_center") return { x: x, y: y };

    const parent = await miro.board.getById(item.parentId);
    if (!parent) throw new Error("Could not resolve a selected note's parent frame.");
    const parentPosition = await getCanvasPosition(parent);

    if (item.relativeTo === "parent_top_left") {
      const parentWidth = Number(parent.width);
      const parentHeight = Number(parent.height);
      if (!Number.isFinite(parentWidth) || !Number.isFinite(parentHeight)) throw new Error("Could not resolve a selected note's frame dimensions.");
      return { x: parentPosition.x - parentWidth / 2 + x, y: parentPosition.y - parentHeight / 2 + y };
    }
    if (item.relativeTo === "parent_center") return { x: parentPosition.x + x, y: parentPosition.y + y };
    return { x: x, y: y };
  }

  function statusFromPosition(sticky, pos) {
    if (pos.x < ACTIVE_BOARD.left || pos.x > ACTIVE_BOARD.right || pos.y < ACTIVE_BOARD.top || pos.y > ACTIVE_BOARD.bottom) return null;
    const width = Number(sticky && sticky.width);
    const effectiveWidth = Number.isFinite(width) && width > 0 ? width : 1;
    const itemLeft = pos.x - effectiveWidth / 2;
    const itemRight = pos.x + effectiveWidth / 2;
    const ranked = STATUS_COLUMNS.map(function (column) {
      const overlap = Math.max(0, Math.min(itemRight, column.right) - Math.max(itemLeft, column.left));
      return { status: column.status, ratio: overlap / effectiveWidth };
    }).sort(function (a, b) { return b.ratio - a.ratio; });
    return ranked[0] && ranked[0].ratio >= 0.60 ? ranked[0].status : null;
  }

  async function waitForCustomCard(issueKey) {
    const started = Date.now();
    while (Date.now() - started < 10000) {
      try {
        const response = await backendPost("/conversion-card-id", { issueKey: issueKey });
        const result = await response.json();
        if (response.ok && result && result.ok && result.itemId) {
          const item = await miro.board.getById(String(result.itemId));
          if (item && item.type === "image") return item;
        }
      } catch (error) {
        console.warn("Conversion card lookup retry", issueKey, error);
      }
      await new Promise(function (resolve) { setTimeout(resolve, 200); });
    }
    throw new Error(issueKey + " was created in Jira, but its Miro card did not appear in time.");
  }

  async function applyConversionStatus(issueKey, desiredStatus) {
    if (!desiredStatus) return;
    const response = await backendPost("/conversion-set-status", { issueKey: issueKey, desiredStatus: desiredStatus });
    let result = null;
    try { result = await response.json(); } catch (error) {}
    if (!response.ok || !result || !result.ok) {
      const reason = result && (result.reason || result.error) || "Could not set Jira status.";
      throw new Error(typeof reason === "string" ? reason : JSON.stringify(reason));
    }
  }

  async function moveCardToExactCanvasPosition(card, pos) {
    let current = card;
    if (current.parentId) {
      const parent = await miro.board.getById(current.parentId);
      if (!parent || typeof parent.remove !== "function") throw new Error("Could not release the converted card from Incoming.");
      await parent.remove(current);
      current = await miro.board.getById(String(current.id));
      if (!current) throw new Error("Could not reload the converted Miro card.");
    }
    current.x = pos.x;
    current.y = pos.y;
    await current.sync();
    return current;
  }

  async function convertSticky(sticky) {
    const summary = plainText(sticky.content);
    if (!summary) throw new Error("This sticky note has no text.");

    const originalPosition = await getCanvasPosition(sticky);
    const desiredStatus = statusFromPosition(sticky, originalPosition);
    const workType = workTypeFromSticky(sticky);
    const stickyColor = String(sticky && sticky.style && sticky.style.fillColor || "");

    let state;
    try { state = await sticky.getMetadata(CONVERSION_METADATA_KEY); } catch (error) { state = undefined; }

    if (state && state.stage === "card-created" && state.issueKey) {
      await miro.board.remove(sticky);
      return { issueKey: String(state.issueKey), desiredStatus: desiredStatus, alreadyConverted: true };
    }

    let issueKey = state && state.issueKey ? String(state.issueKey) : "";
    if (!issueKey) {
      const response = await backendPost("/sticky-to-jira", {
        summary: summary,
        workType: workType,
        stickyId: String(sticky.id),
        createdBy: creatorId(sticky.createdBy)
      });
      let result = null;
      try { result = await response.json(); } catch (error) {}
      if (!response.ok || !result || !result.ok || !result.issueKey) {
        const reason = result && (result.reason || result.error) || "Could not create Jira issue.";
        throw new Error(typeof reason === "string" ? reason : JSON.stringify(reason));
      }
      issueKey = String(result.issueKey);
      await sticky.setMetadata(CONVERSION_METADATA_KEY, {
        issueKey: issueKey, stage: "jira-created", workType: workType, stickyColor: stickyColor, desiredStatus: desiredStatus || null
      });
    }

    const customCard = await waitForCustomCard(issueKey);
    await applyConversionStatus(issueKey, desiredStatus);
    const movedCard = await moveCardToExactCanvasPosition(customCard, originalPosition);

    await sticky.setMetadata(CONVERSION_METADATA_KEY, {
      issueKey: issueKey, stage: "card-created", customCardFrameId: String(movedCard.id), workType: workType, stickyColor: stickyColor, desiredStatus: desiredStatus || null
    });
    await miro.board.remove(sticky);
    return { issueKey: issueKey, desiredStatus: desiredStatus, created: true };
  }

  convertButton.addEventListener("click", async function () {
    convertButton.disabled = true;
    try {
      const selection = await miro.board.getSelection();
      const selected = Array.isArray(selection) ? selection : [];
      const stickies = selected.filter(function (item) { return item && item.type === "sticky_note"; });
      if (!stickies.length) throw new Error("Select at least one sticky note first.");
      if (stickies.length !== selected.length) throw new Error("Select only sticky notes before converting.");

      const successes = [];
      const failures = [];
      for (let i = 0; i < stickies.length; i += 1) {
        setStatus("Converting " + (i + 1) + " of " + stickies.length + "…", "info");
        try {
          successes.push(await convertSticky(stickies[i]));
        } catch (error) {
          failures.push({ text: plainText(stickies[i].content).slice(0, 60) || "Untitled note", reason: error && error.message || String(error) });
        }
      }

      if (!failures.length) {
        if (successes.length === 1) {
          const result = successes[0];
          setStatus(result.issueKey + " converted successfully" + (result.desiredStatus ? " with status " + result.desiredStatus + "." : " with the default Jira status."), "success");
        } else {
          setStatus(successes.length + " notes converted successfully. Their positions were preserved.", "success");
        }
      } else if (successes.length) {
        setStatus(successes.length + " converted successfully. " + failures.length + " failed and were left on the board.\n\n" + failures.map(function (item) { return item.text + ": " + item.reason; }).join("\n"), "error");
      } else {
        setStatus("No notes were converted.\n\n" + failures.map(function (item) { return item.text + ": " + item.reason; }).join("\n"), "error");
      }
    } catch (error) {
      setStatus(error && error.message || String(error), "error");
    } finally {
      convertButton.disabled = false;
    }
  });

  document.getElementById("creatorIdButton").addEventListener("click", async function () {
    const selection = await miro.board.getSelection();
    if (!Array.isArray(selection) || selection.length !== 1) return alert("Select exactly one item first.");
    const value = creatorId(selection[0].createdBy);
    if (!value) return alert("Could not read creator ID for the selected item.");
    document.getElementById("creatorId").value = value;
    document.getElementById("creatorDiagnostic").style.display = "block";
  });

  document.getElementById("frameIdButton").addEventListener("click", async function () {
    const selection = await miro.board.getSelection();
    if (!Array.isArray(selection) || selection.length !== 1 || !selection[0] || selection[0].type !== "frame") return alert("Select exactly one frame first.");
    document.getElementById("frameId").value = String(selection[0].id || "");
    document.getElementById("frameDiagnostic").style.display = "block";
  });
})();
</script>
</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    }
  });
}
