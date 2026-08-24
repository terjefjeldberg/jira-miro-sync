import baseWorker from "./worker.js";

// Compatibility layer for single-image custom Jira cards.
// Supports both root-level images (canvas coordinates) and images that Miro
// reparents into the workflow frame (parent_top_left coordinates).
// Also refreshes the existing custom-card SVG in place from live Jira data.

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

const WORK_TYPE_COLORS = {
  bug: "#FD9DE8",
  improvement: "#B7D3FE",
  spike: "#FFEB7F",
  "new feature": "#D7F2AC",
  "hotfix candidate": "#FFB677",
  "task/config/doc/test": "#89E8E0",
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

function svgEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function titleFontSize(value) {
  const length = String(value ?? "").trim().length;
  if (length <= 20) return 20;
  if (length <= 35) return 17;
  if (length <= 50) return 15;
  if (length <= 70) return 13;
  return 11;
}

function cardColorForWorkType(workType) {
  return WORK_TYPE_COLORS[String(workType ?? "").trim().toLowerCase()] || "#E8E8E8";
}

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
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

async function readJiraCardData(env, issueKey) {
  if (!env.JIRA_API_TOKEN || !env.JIRA_CLOUD_ID) {
    return {
      ok: false,
      stage: "refresh-jira-config",
      reason: "Jira API bindings are missing",
    };
  }

  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${encodeURIComponent(env.JIRA_CLOUD_ID)}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,priority,assignee,issuetype`,
    {
      headers: {
        Authorization: `Bearer ${env.JIRA_API_TOKEN}`,
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    return {
      ok: false,
      stage: "refresh-read-jira",
      jiraStatus: response.status,
      error: await response.text(),
    };
  }

  const issue = await response.json();
  return {
    ok: true,
    issueKey,
    summary: String(issue?.fields?.summary ?? ""),
    priority: String(issue?.fields?.priority?.name ?? "None"),
    priorityIconUrl: String(issue?.fields?.priority?.iconUrl ?? ""),
    assignee: String(issue?.fields?.assignee?.displayName ?? "Unassigned"),
    workType: String(issue?.fields?.issuetype?.name ?? "Unknown"),
  };
}

async function priorityIconAsDataUrl(iconUrl) {
  if (!iconUrl) return "";

  try {
    const response = await fetch(iconUrl, {
      headers: { Accept: "image/*" },
    });

    if (!response.ok) return "";

    const contentType = String(response.headers.get("Content-Type") || "image/png")
      .split(";")[0]
      .trim();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 256 * 1024) return "";

    return `data:${contentType};base64,${bytesToBase64(bytes)}`;
  } catch {
    return "";
  }
}

async function buildCardSvgDataUrl(jira) {
  const cardColor = cardColorForWorkType(jira.workType);
  const issueKey = svgEscape(jira.issueKey);
  const summary = svgEscape(jira.summary);
  const priority = svgEscape(jira.priority);
  const assignee = svgEscape(jira.assignee);
  const titleSize = titleFontSize(jira.summary);
  const priorityIconDataUrl = await priorityIconAsDataUrl(jira.priorityIconUrl);

  const priorityIconSvg = priorityIconDataUrl
    ? `<image x="18" y="88" width="14" height="14" href="${priorityIconDataUrl}"/>`
    : '<g transform="translate(18 92)" stroke="#1267E5" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M0 0 L6 5 L12 0"/><path d="M0 4 L6 9 L12 4"/></g>';

  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">',
    `<rect width="320" height="120" rx="0" fill="${cardColor}"/>`,
    `<text x="12" y="18" font-family="Arial, sans-serif" font-size="10" font-weight="700" fill="#1A1A1A">${issueKey}</text>`,
    '<text x="308" y="18" text-anchor="end" font-family="Arial, sans-serif" font-size="10" fill="#0A66C2">Jira ↗</text>',
    `<text x="20" y="60" font-family="Arial, sans-serif" font-size="${titleSize}" font-weight="700" fill="#1A1A1A">${summary}</text>`,
    priorityIconSvg,
    `<text x="40" y="101" font-family="Arial, sans-serif" font-size="10" fill="#1A1A1A">${priority}</text>`,
    `<text x="300" y="101" text-anchor="end" font-family="Arial, sans-serif" font-size="10" fill="#1A1A1A">${assignee}</text>`,
    '</svg>',
  ].join("");

  return `data:image/svg+xml;base64,${utf8ToBase64(svg)}`;
}

async function refreshCustomCardImage(env, issueKey) {
  if (!env.CARD_MAP || !env.MIRO_TOKEN || !env.MIRO_BOARD_ID) {
    return {
      ok: false,
      refreshed: false,
      stage: "refresh-config",
      reason: "Custom-card refresh bindings are missing",
    };
  }

  const itemId = await env.CARD_MAP.get(customCardMapKey(issueKey));
  if (!itemId) {
    return { ok: true, refreshed: false, mapped: false };
  }

  const itemRead = await readMiroItem(env, itemId);
  if (!itemRead.ok) {
    return {
      ok: false,
      refreshed: false,
      mapped: true,
      stage: "refresh-read-miro-image",
      miroStatus: itemRead.status,
      error: itemRead.error,
    };
  }

  if (itemRead.item?.type !== "image") {
    return {
      ok: true,
      refreshed: false,
      mapped: true,
      reason: "Mapped custom card is not a single image",
      itemType: itemRead.item?.type ?? null,
    };
  }

  const jira = await readJiraCardData(env, issueKey);
  if (!jira.ok) {
    return { ...jira, refreshed: false, mapped: true };
  }

  const dataUrl = await buildCardSvgDataUrl(jira);
  const encodedSvg = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binarySvg = atob(encodedSvg);
  const svgBytes = new Uint8Array(binarySvg.length);
  for (let index = 0; index < binarySvg.length; index += 1) {
    svgBytes[index] = binarySvg.charCodeAt(index);
  }

  const formData = new FormData();
  formData.append(
    "resource",
    new Blob([svgBytes], { type: "image/svg+xml" }),
    `${issueKey}.svg`,
  );
  formData.append(
    "data",
    JSON.stringify({ title: `CUSTOM_JIRA_CARD:${issueKey}` }),
  );

  const response = await fetch(
    `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images/${encodeURIComponent(itemId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${env.MIRO_TOKEN}`,
        Accept: "application/json",
      },
      body: formData,
    },
  );

  if (!response.ok) {
    return {
      ok: false,
      refreshed: false,
      mapped: true,
      stage: "refresh-upload-miro-image",
      miroStatus: response.status,
      error: await response.text(),
    };
  }

  return {
    ok: true,
    refreshed: true,
    mapped: true,
    itemId,
    fields: {
      summary: jira.summary,
      priority: jira.priority,
      priorityIcon: Boolean(jira.priorityIconUrl),
      assignee: jira.assignee,
    },
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

    const issueKey = normalizeIssueKey(body?.issueKey);
    const status = String(body?.status ?? "").trim();

    // Any authenticated/accepted SN webhook may carry a field-only change.
    // The refresh helper performs its own custom-card mapping check.
    let customRefresh = null;
    if (body?.ok && /^SN-\d+$/i.test(issueKey)) {
      customRefresh = await refreshCustomCardImage(env, issueKey);
    }

    if (
      !body?.ok ||
      body?.custom?.parked !== true ||
      body?.custom?.mapped !== true ||
      !/^SN-\d+$/i.test(issueKey) ||
      !status
    ) {
      return customRefresh
        ? jsonResponseLike(baseResponse, { ...body, customRefresh })
        : baseResponse;
    }

    const fallback = await moveParkedCustomImage(env, issueKey, status);

    if (!fallback.moved) {
      return jsonResponseLike(baseResponse, {
        ...body,
        customRefresh,
        custom: {
          ...body.custom,
          previewCoordinateFallback: fallback,
        },
      });
    }

    return jsonResponseLike(baseResponse, {
      ...body,
      moved: true,
      customRefresh,
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
