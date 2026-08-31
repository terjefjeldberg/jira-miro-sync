import reporterWorker from "./reporter-panel-clean-multiselect-entry.js";
import previewWorker from "./incoming-multipart-fix-entry.js";

function responseWithText(original, text) {
  const headers = new Headers(original.headers);
  headers.delete("Content-Length");
  return new Response(text, {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

async function injectCustomCardDragFallback(baseResponse) {
  if (!baseResponse.ok) return baseResponse;

  const html = await baseResponse.clone().text();
  if (html.includes("CUSTOM CARD DRAG FALLBACK ACTIVE")) {
    return baseResponse;
  }

  const script = `
<script>
(async function () {
  const ACTIVE_BOARD = {
    left: 438.36642375544034,
    right: 5303.436262036128,
    top: 434.257014599023,
    bottom: 3045.734778444852
  };

  const COLUMNS = [
    { status: "Todo", left: 1468.7903676550886, right: 2551.696467655089 },
    { status: "In progress", left: 2564.6113791667394, right: 3277.6028791667395 },
    { status: "Functional review", left: 3289.4484150169965, right: 3651.451815016996 },
    { status: "Code review", left: 3662.9922412433402, right: 4020.66884124334 },
    { status: "Approved", left: 4033.200178788891, right: 4680.471778788891 },
    { status: "Merged", left: 4692.4616140640555, right: 5284.738514064056 }
  ];

  const baselines = new Map();
  const timers = new Map();

  function getIssueKey(image) {
    const title = String(image?.title || "").trim();
    const match = title.match(/^CUSTOM_JIRA_CARD:(SN-\\d+)$/i);
    return match ? match[1].toUpperCase() : null;
  }

  function remember(image) {
    if (!image || image.type !== "image") return;
    const issueKey = getIssueKey(image);
    if (!issueKey) return;
    if (typeof image.x !== "number" || typeof image.y !== "number") return;
    baselines.set(String(image.id), { x: image.x, y: image.y, issueKey });
  }

  async function seedUnknownImages() {
    try {
      const images = await miro.board.get({ type: "image" });
      for (const image of images || []) {
        const id = String(image?.id || "");
        if (!id || baselines.has(id)) continue;
        remember(image);
      }
    } catch (error) {
      console.warn("CUSTOM CARD DRAG FALLBACK baseline scan failed", error);
    }
  }

  function overlapRatio(image, column) {
    const width = Number(image?.width);
    const x = Number(image?.x);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(x)) return 0;
    const left = x - width / 2;
    const right = x + width / 2;
    const overlap = Math.max(0, Math.min(right, column.right) - Math.max(left, column.left));
    return overlap / width;
  }

  function detectColumn(image) {
    const ranked = COLUMNS
      .map(column => ({ ...column, overlap: overlapRatio(image, column) }))
      .sort((a, b) => b.overlap - a.overlap);
    return ranked[0] || null;
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

  async function evaluate(imageId, original) {
    const image = await miro.board.getById(imageId);
    if (!image || image.type !== "image") return;

    const issueKey = getIssueKey(image);
    if (!issueKey) return;

    if (typeof image.x !== "number" || typeof image.y !== "number") return;

    if (!original) {
      remember(image);
      return;
    }

    const moved = Math.abs(image.x - original.x) > 1 || Math.abs(image.y - original.y) > 1;
    if (!moved) {
      remember(image);
      return;
    }

    if (
      image.x < ACTIVE_BOARD.left || image.x > ACTIVE_BOARD.right ||
      image.y < ACTIVE_BOARD.top || image.y > ACTIVE_BOARD.bottom
    ) {
      remember(image);
      return;
    }

    const winner = detectColumn(image);
    if (!winner || winner.overlap < 0.60) {
      remember(image);
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 1200));

    const boardInfo = await miro.board.getInfo();
    const response = await backendPost("/custom-miro-to-jira", {
      boardId: boardInfo.id,
      issueKey,
      groupId: String(image.id),
      desiredStatus: winner.status
    });

    let result = null;
    try {
      result = await response.json();
    } catch {}

    console.log("CUSTOM CARD DRAG FALLBACK result:", issueKey, winner.status, result);
    remember(image);
  }

  await seedUnknownImages();

  setInterval(function () {
    seedUnknownImages().catch(console.error);
  }, 2000);

  await miro.board.ui.on("experimental:items:update", function (event) {
    for (const item of event?.items || []) {
      if (item?.type !== "image") continue;

      const imageId = String(item.id || "");
      if (!imageId) continue;

      const existing = timers.get(imageId);
      if (existing) clearTimeout(existing.timer);

      const original = existing?.original || baselines.get(imageId) || null;
      const timer = setTimeout(function () {
        timers.delete(imageId);
        evaluate(imageId, original).catch(function (error) {
          console.error("CUSTOM CARD DRAG FALLBACK failed", error);
        });
      }, 1400);

      timers.set(imageId, { timer, original });
    }
  });

  console.log("CUSTOM CARD DRAG FALLBACK ACTIVE");
})();
</script>
`;

  return responseWithText(baseResponse, html.replace("</body>", script + "\n</body>"));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (
      (request.method === "POST" && url.pathname === "/sticky-to-jira") ||
      (request.method === "GET" && url.pathname === "/miro-panel")
    ) {
      return reporterWorker.fetch(request, env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/miro-app") {
      const response = await previewWorker.fetch(request, env, ctx);
      return await injectCustomCardDragFallback(response);
    }

    return previewWorker.fetch(request, env, ctx);
  },
};
