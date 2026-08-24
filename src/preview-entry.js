import baseWorker from "./worker.js";

// Preview-only compatibility layer for the single-image custom-card experiment.
//
// Why this exists:
// - custom image cards are root-level Miro items and REST returns canvas coordinates
// - ACTIVE_BOARD and status-column values in worker.js are coordinates local to the
//   large workflow frame used as the test board
// - worker.js therefore currently classifies a visually valid image as parked
//
// This wrapper leaves worker.js and the native Jira Card sync untouched. It only
// performs a second, conservative custom-image move when worker.js has already
// authenticated the Jira webhook and returned custom.parked=true.

const ACTIVE_BOARD = {
  left: 438.36642375544034,
  right: 5303.436262036128,
  top: 434.257014599023,
  bottom: 3045.734778444852,
};

const COLUMNS = {
  "todo": { targetX: 1990.8399296925127 },
  "in progress": { targetX: 2923.455009676509 },
  "functional review": { targetX: 3472.938505190192 },
  "code review": { targetX: 3842.7526347392704 },
  "approved": { targetX: 4350.752924110384 },
  "merged": { targetX: 4983.202615160219 },
};

function normalizeStatus(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeIssueKey(value) {
  return String(value ?? "").trim().toUpperCase();
}

function customCardMapKey(issueKey) {
  return `custom-card:${normalizeIssueKey(issueKey)}`;
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function jsonResponseLike(original, data) {
  const headers = new Headers(original.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  return new Response(JSON.stringify(data), {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

async function readMiroItem(env, itemId) {
  const response = await fetch(
    `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/items/${encodeURIComponent(itemId)}`,
    {
      headers: {
        Authorization: `Bearer ${env.MIRO_TOKEN}`,
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: await response.text(),
    };
  }

  return {
    ok: true,
    item: await response.json(),
  };
}

async function listMiroFrames(env) {
  const frames = [];
  let cursor = null;

  for (let page = 0; page < 10; page += 1) {
    const url = new URL(
      `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/items`,
    );
    url.searchParams.set("type", "frame");
    url.searchParams.set("limit", "50");
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${env.MIRO_TOKEN}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: await response.text(),
      };
    }

    const data = await response.json();
    const items = Array.isArray(data?.data) ? data.data : [];
    frames.push(...items.filter((item) => item?.type === "frame"));

    cursor = String(data?.cursor ?? "").trim() || null;
    if (!cursor) {
      break;
    }
  }

  return { ok: true, frames };
}

function frameCandidateForCard(frame, cardX, cardY) {
  const frameX = frame?.position?.x;
  const frameY = frame?.position?.y;
  const frameWidth = frame?.geometry?.width;
  const frameHeight = frame?.geometry?.height;

  if (
    !isNumber(frameX) ||
    !isNumber(frameY) ||
    !isNumber(frameWidth) ||
    !isNumber(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0
  ) {
    return null;
  }

  // The active-board constants and every target column must physically fit
  // inside the candidate frame. This prevents a nested/nearby frame from
  // accidentally being treated as the workflow board.
  if (
    frameWidth < ACTIVE_BOARD.right ||
    frameHeight < ACTIVE_BOARD.bottom
  ) {
    return null;
  }

  const left = frameX - frameWidth / 2;
  const top = frameY - frameHeight / 2;
  const localX = cardX - left;
  const localY = cardY - top;

  const insideActiveBoard =
    localX >= ACTIVE_BOARD.left &&
    localX <= ACTIVE_BOARD.right &&
    localY >= ACTIVE_BOARD.top &&
    localY <= ACTIVE_BOARD.bottom;

  if (!insideActiveBoard) {
    return null;
  }

  return {
    frameId: String(frame.id),
    left,
    top,
    width: frameWidth,
    height: frameHeight,
    localX,
    localY,
    area: frameWidth * frameHeight,
  };
}

async function moveParkedCustomImage(env, issueKey, status) {
  if (!env.CARD_MAP || !env.MIRO_TOKEN || !env.MIRO_BOARD_ID) {
    return {
      ok: false,
      moved: false,
      reason: "Preview coordinate fallback is missing required bindings",
    };
  }

  const targetColumn = COLUMNS[normalizeStatus(status)];
  if (!targetColumn) {
    return {
      ok: true,
      moved: false,
      reason: "Status has no approved target column",
    };
  }

  const itemId = await env.CARD_MAP.get(customCardMapKey(issueKey));
  if (!itemId) {
    return {
      ok: true,
      moved: false,
      reason: "No custom-card mapping",
    };
  }

  const itemRead = await readMiroItem(env, itemId);
  if (!itemRead.ok) {
    return {
      ok: false,
      moved: false,
      stage: "preview-read-custom-image",
      miroStatus: itemRead.status,
      error: itemRead.error,
    };
  }

  const item = itemRead.item;
  if (item?.type !== "image") {
    return {
      ok: true,
      moved: false,
      reason: "Mapped custom item is not a single image",
      itemType: item?.type ?? null,
    };
  }

  const cardX = item?.position?.x;
  const cardY = item?.position?.y;
  const cardWidth = item?.geometry?.width;

  if (!isNumber(cardX) || !isNumber(cardY) || !isNumber(cardWidth)) {
    return {
      ok: false,
      moved: false,
      stage: "preview-custom-image-geometry",
      reason: "Invalid custom image geometry",
    };
  }

  const frameList = await listMiroFrames(env);
  if (!frameList.ok) {
    return {
      ok: false,
      moved: false,
      stage: "preview-list-frames",
      miroStatus: frameList.status,
      error: frameList.error,
    };
  }

  const candidates = frameList.frames
    .map((frame) => frameCandidateForCard(frame, cardX, cardY))
    .filter(Boolean)
    .sort((a, b) => a.area - b.area);

  if (candidates.length === 0) {
    return {
      ok: true,
      moved: false,
      parked: true,
      reason: "Custom image is outside every frame compatible with ACTIVE_BOARD",
      cardCanvasX: cardX,
      cardCanvasY: cardY,
    };
  }

  const boardFrame = candidates[0];
  const globalTargetX = boardFrame.left + targetColumn.targetX;

  const response = await fetch(
    `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/items/${encodeURIComponent(itemId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${env.MIRO_TOKEN}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        position: {
          x: globalTargetX,
          y: cardY,
          origin: "center",
        },
      }),
    },
  );

  if (!response.ok) {
    return {
      ok: false,
      moved: false,
      stage: "preview-move-custom-image",
      miroStatus: response.status,
      error: await response.text(),
      boardFrame,
    };
  }

  return {
    ok: true,
    moved: true,
    parked: false,
    movementMode: "preview-board-frame-coordinate-fallback",
    itemId,
    boardFrameId: boardFrame.frameId,
    fromCanvasX: cardX,
    fromLocalX: boardFrame.localX,
    toLocalX: targetColumn.targetX,
    toCanvasX: globalTargetX,
    yPreserved: cardY,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/") {
      return baseWorker.fetch(request, env, ctx);
    }

    const requestForBase = request.clone();
    const baseResponse = await baseWorker.fetch(requestForBase, env, ctx);

    let body;
    try {
      body = await baseResponse.clone().json();
    } catch {
      return baseResponse;
    }

    // Only intervene after the existing worker has accepted/authenticated the
    // webhook, identified a mapped custom card, and decided not to move it
    // solely because it considers it parked.
    if (
      !body?.ok ||
      body?.custom?.parked !== true ||
      body?.custom?.mapped !== true
    ) {
      return baseResponse;
    }

    const issueKey = normalizeIssueKey(body.issueKey);
    const status = String(body.status ?? "").trim();

    if (!/^SN-\d+$/i.test(issueKey) || !status) {
      return baseResponse;
    }

    const fallback = await moveParkedCustomImage(env, issueKey, status);

    if (!fallback.moved) {
      return jsonResponseLike(baseResponse, {
        ...body,
        custom: {
          ...body.custom,
          previewCoordinateFallback: fallback,
        },
      });
    }

    return jsonResponseLike(baseResponse, {
      ...body,
      moved: true,
      customMovementMode: "preview-board-frame-coordinate-fallback",
      custom: {
        ...body.custom,
        ok: true,
        mapped: true,
        moved: true,
        parked: false,
        previewCoordinateFallback: fallback,
      },
    });
  },
};
