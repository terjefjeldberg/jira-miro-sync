import baseWorker from "./worker.js";

// Compatibility layer for single-image custom Jira cards.
// Supports both root-level images (canvas coordinates) and images that Miro
// reparents into the workflow frame (parent_top_left coordinates).

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

  return { ok: true, item: await response.json() };
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
    if (cursor) url.searchParams.set("cursor", cursor);

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
    if (!cursor) break;
  }

  return { ok: true, frames };
}

function isCompatibleBoardFrame(frame) {
  const width = frame?.geometry?.width;
  const height = frame?.geometry?.height;
  return (
    frame?.type === "frame" &&
    isNumber(width) &&
    isNumber(height) &&
    width >= ACTIVE_BOARD.right &&
    height >= ACTIVE_BOARD.bottom
  );
}

function insideActiveBoard(localX, localY) {
  return (
    isNumber(localX) &&
    isNumber(localY) &&
    localX >= ACTIVE_BOARD.left &&
    localX <= ACTIVE_BOARD.right &&
    localY >= ACTIVE_BOARD.top &&
    localY <= ACTIVE_BOARD.bottom
  );
}

function frameCandidateForCanvasCard(frame, cardCanvasX, cardCanvasY) {
  const frameX = frame?.position?.x;
  const frameY = frame?.position?.y;
  const frameWidth = frame?.geometry?.width;
  const frameHeight = frame?.geometry?.height;

  if (
    !isCompatibleBoardFrame(frame) ||
    !isNumber(frameX) ||
    !isNumber(frameY)
  ) {
    return null;
  }

  const left = frameX - frameWidth / 2;
  const top = frameY - frameHeight / 2;
  const localX = cardCanvasX - left;
  const localY = cardCanvasY - top;

  if (!insideActiveBoard(localX, localY)) return null;

  return {
    frameId: String(frame.id),
    left,
    top,
    localX,
    localY,
    area: frameWidth * frameHeight,
  };
}

async function patchItemPosition(env, itemId, x, y) {
  return await fetch(
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
          x,
          y,
          origin: "center",
        },
      }),
    },
  );
}

async function moveParkedCustomImage(env, issueKey, status) {
  if (!env.CARD_MAP || !env.MIRO_TOKEN || !env.MIRO_BOARD_ID) {
    return {
      ok: false,
      moved: false,
      reason: "Coordinate fallback is missing required bindings",
    };
  }

  const targetColumn = COLUMNS[normalizeStatus(status)];
  if (!targetColumn) {
    return { ok: true, moved: false, reason: "Status has no approved target column" };
  }

  const itemId = await env.CARD_MAP.get(customCardMapKey(issueKey));
  if (!itemId) {
    return { ok: true, moved: false, reason: "No custom-card mapping" };
  }

  const itemRead = await readMiroItem(env, itemId);
  if (!itemRead.ok) {
    return {
      ok: false,
      moved: false,
      stage: "read-custom-image",
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

  const rawX = item?.position?.x;
  const rawY = item?.position?.y;
  const relativeTo = String(item?.position?.relativeTo ?? "canvas_center");
  const parentId = String(item?.parent?.id ?? "").trim();

  if (!isNumber(rawX) || !isNumber(rawY)) {
    return {
      ok: false,
      moved: false,
      stage: "custom-image-geometry",
      reason: "Invalid custom image geometry",
    };
  }

  // Miro can reparent a root image into the board frame when the user drags it
  // back onto the frame. In that state REST returns parent-local coordinates.
  // Validate the exact parent as a compatible workflow frame and move using the
  // same local coordinate system. This preserves the board safety rule.
  if (parentId && relativeTo.startsWith("parent_")) {
    const parentRead = await readMiroItem(env, parentId);
    if (!parentRead.ok) {
      return {
        ok: false,
        moved: false,
        stage: "read-parent-frame",
        miroStatus: parentRead.status,
        error: parentRead.error,
      };
    }

    const parent = parentRead.item;
    if (!isCompatibleBoardFrame(parent)) {
      return {
        ok: true,
        moved: false,
        parked: true,
        reason: "Custom image parent is not a compatible ACTIVE_BOARD frame",
        parentId,
        relativeTo,
      };
    }

    if (!insideActiveBoard(rawX, rawY)) {
      return {
        ok: true,
        moved: false,
        parked: true,
        reason: "Custom image is outside ACTIVE_BOARD inside its parent frame",
        parentId,
        relativeTo,
        localX: rawX,
        localY: rawY,
      };
    }

    const response = await patchItemPosition(
      env,
      itemId,
      targetColumn.targetX,
      rawY,
    );

    if (!response.ok) {
      return {
        ok: false,
        moved: false,
        stage: "move-parented-custom-image",
        miroStatus: response.status,
        error: await response.text(),
        parentId,
      };
    }

    return {
      ok: true,
      moved: true,
      parked: false,
      movementMode: "parent-local-board-coordinate-fallback",
      itemId,
      boardFrameId: parentId,
      fromLocalX: rawX,
      toLocalX: targetColumn.targetX,
      localYPreserved: rawY,
      relativeTo,
    };
  }

  // Root-level image: coordinates are canvas-relative. Find the compatible
  // workflow frame that contains the card, validate ACTIVE_BOARD locally, then
  // convert the target column back to canvas X.
  const frameList = await listMiroFrames(env);
  if (!frameList.ok) {
    return {
      ok: false,
      moved: false,
      stage: "list-frames",
      miroStatus: frameList.status,
      error: frameList.error,
    };
  }

  const candidates = frameList.frames
    .map((frame) => frameCandidateForCanvasCard(frame, rawX, rawY))
    .filter(Boolean)
    .sort((a, b) => a.area - b.area);

  if (candidates.length === 0) {
    return {
      ok: true,
      moved: false,
      parked: true,
      reason: "Custom image is outside every frame compatible with ACTIVE_BOARD",
      cardCanvasX: rawX,
      cardCanvasY: rawY,
    };
  }

  const boardFrame = candidates[0];
  const globalTargetX = boardFrame.left + targetColumn.targetX;
  const response = await patchItemPosition(env, itemId, globalTargetX, rawY);

  if (!response.ok) {
    return {
      ok: false,
      moved: false,
      stage: "move-root-custom-image",
      miroStatus: response.status,
      error: await response.text(),
      boardFrame,
    };
  }

  return {
    ok: true,
    moved: true,
    parked: false,
    movementMode: "canvas-board-coordinate-fallback",
    itemId,
    boardFrameId: boardFrame.frameId,
    fromCanvasX: rawX,
    fromLocalX: boardFrame.localX,
    toLocalX: targetColumn.targetX,
    toCanvasX: globalTargetX,
    yPreserved: rawY,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/") {
      return baseWorker.fetch(request, env, ctx);
    }

    const baseResponse = await baseWorker.fetch(request.clone(), env, ctx);

    let body;
    try {
      body = await baseResponse.clone().json();
    } catch {
      return baseResponse;
    }

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
      customMovementMode: fallback.movementMode,
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
