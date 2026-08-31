import previewWorker from "./preview-entry-v2.js";

const INCOMING_FRAME_ID = "3458764681916843188";
const CARD_WIDTH = 320;
const CARD_HEIGHT = 120;
const FRAME_MARGIN_X = 36;
const FRAME_MARGIN_Y = 36;
const CARD_GAP_X = 20;
const CARD_GAP_Y = 30;
const LAYER_OFFSET_X = 24;
const LAYER_OFFSET_Y = 24;
const MAX_LAYERS = 12;

const WORK_TYPE_COLORS = {
  bug: "#FD9DE8",
  improvement: "#B7D3FE",
  spike: "#FFEB7F",
  "new feature": "#D7F2AC",
  "hotfix candidate": "#FFB677",
  "task/config/doc/test": "#89E8E0",
};

function normalizeIssueKey(value) {
  return String(value ?? "").trim().toUpperCase();
}

function customCardMapKey(issueKey) {
  return `custom-card:${normalizeIssueKey(issueKey)}`;
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

function miroHeaders(env) {
  return {
    Authorization: `Bearer ${env.MIRO_TOKEN}`,
    Accept: "application/json",
  };
}

function svgEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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

function estimateTitleTextWidth(text, fontSize) {
  let units = 0;
  for (const char of String(text ?? "")) {
    if (char === " ") units += 0.28;
    else if (/[ilI1.,'!:;|]/.test(char)) units += 0.28;
    else if (/[mwMW@#%&]/.test(char)) units += 0.9;
    else if (/[A-Z0-9]/.test(char)) units += 0.62;
    else units += 0.54;
  }
  return units * fontSize;
}

function splitTitleWord(word, fontSize, maxWidth) {
  const chunks = [];
  let current = "";
  for (const char of String(word ?? "")) {
    const candidate = current + char;
    if (current && estimateTitleTextWidth(candidate, fontSize) > maxWidth) {
      chunks.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [String(word ?? "")];
}

function wrapTitleLines(text, fontSize, maxWidth) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    const parts = estimateTitleTextWidth(word, fontSize) > maxWidth
      ? splitTitleWord(word, fontSize, maxWidth)
      : [word];

    for (const part of parts) {
      const candidate = currentLine ? `${currentLine} ${part}` : part;
      if (estimateTitleTextWidth(candidate, fontSize) <= maxWidth) {
        currentLine = candidate;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = part;
      }
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines.length ? lines : [""];
}

function buildTitleLayout(text) {
  const box = { x: 20, y: 26, width: 280, height: 56 };
  const minFontSize = 10;
  const maxFontSize = 44;
  const maxLines = 4;
  const lineHeightFactor = 1.05;

  for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 1) {
    const lines = wrapTitleLines(text, fontSize, box.width);
    const lineHeight = fontSize * lineHeightFactor;
    const totalHeight = lines.length * lineHeight;
    if (lines.length <= maxLines && totalHeight <= box.height) {
      return {
        centerX: box.x + box.width / 2,
        startY: box.y + (box.height - totalHeight) / 2 + fontSize * 0.82,
        fontSize,
        lineHeight,
        lines,
      };
    }
  }

  const fontSize = minFontSize;
  const lines = wrapTitleLines(text, fontSize, box.width).slice(0, maxLines);
  const lineHeight = fontSize * lineHeightFactor;
  const totalHeight = lines.length * lineHeight;
  return {
    centerX: box.x + box.width / 2,
    startY: box.y + (box.height - totalHeight) / 2 + fontSize * 0.82,
    fontSize,
    lineHeight,
    lines,
  };
}

function priorityIconSvg(priority) {
  const value = String(priority ?? "").trim().toLowerCase();
  const red = "#E34935";
  const medium = "#F5A700";
  const blue = "#1267E5";
  const gray = "#6B778C";

  if (value === "blocker" || value === "highest") {
    return `<g transform="translate(18 88)" fill="none" stroke="${red}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M0 7 L6 1 L12 7"/><path d="M0 12 L6 6 L12 12"/></g>`;
  }
  if (value === "high") {
    return `<g transform="translate(18 90)" fill="none" stroke="${red}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M0 8 L6 2 L12 8"/></g>`;
  }
  if (value === "medium") {
    return `<g transform="translate(18 92)" fill="none" stroke="${medium}" stroke-width="2.2" stroke-linecap="round"><path d="M0 0 H12"/><path d="M0 5 H12"/></g>`;
  }
  if (value === "low") {
    return `<g transform="translate(18 91)" fill="none" stroke="${blue}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M0 2 L6 8 L12 2"/></g>`;
  }
  if (value === "trivial" || value === "lowest") {
    return `<g transform="translate(18 88)" fill="none" stroke="${blue}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M0 1 L6 7 L12 1"/><path d="M0 6 L6 12 L12 6"/></g>`;
  }
  return `<g transform="translate(18 95)" fill="none" stroke="${gray}" stroke-width="2.4" stroke-linecap="round"><path d="M0 0 H12"/></g>`;
}

function buildCardDataUrl(jira) {
  const color = WORK_TYPE_COLORS[String(jira.workType ?? "").trim().toLowerCase()] || "#E8E8E8";
  const titleLayout = buildTitleLayout(jira.summary);
  const titleSvg = [
    `<text x="${titleLayout.centerX}" y="${titleLayout.startY}" text-anchor="middle" font-family="Open Sans, Arial, sans-serif" font-size="${titleLayout.fontSize}" font-weight="400" fill="#1A1A1A">`,
    ...titleLayout.lines.map((line, index) =>
      index === 0
        ? `<tspan x="${titleLayout.centerX}">${svgEscape(line)}</tspan>`
        : `<tspan x="${titleLayout.centerX}" dy="${titleLayout.lineHeight}">${svgEscape(line)}</tspan>`,
    ),
    "</text>",
  ].join("");

  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">',
    `<rect x="2" y="2" width="316" height="116" rx="6" fill="${color}" stroke="#3F4854" stroke-width="2"/>`,
    `<text x="12" y="18" font-family="Open Sans, Arial, sans-serif" font-size="10" font-weight="700" fill="#1A1A1A">${svgEscape(jira.issueKey)}</text>`,
    '<text x="308" y="18" text-anchor="end" font-family="Open Sans, Arial, sans-serif" font-size="10" fill="#0A66C2">Jira ↗</text>',
    titleSvg,
    priorityIconSvg(jira.priority),
    `<text x="40" y="101" font-family="Open Sans, Arial, sans-serif" font-size="10" fill="#1A1A1A">${svgEscape(jira.priority)}</text>`,
    `<text x="300" y="101" text-anchor="end" font-family="Open Sans, Arial, sans-serif" font-size="10" fill="#1A1A1A">${svgEscape(jira.assignee)}</text>`,
    "</svg>",
  ].join("");

  return `data:image/svg+xml;base64,${utf8ToBase64(svg)}`;
}

async function readJiraCardData(env, issueKey) {
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
    return { ok: false, stage: "incoming-read-jira", jiraStatus: response.status, error: await response.text() };
  }

  const issue = await response.json();
  return {
    ok: true,
    issueKey,
    summary: String(issue?.fields?.summary ?? ""),
    priority: String(issue?.fields?.priority?.name ?? "None"),
    assignee: String(issue?.fields?.assignee?.displayName ?? "Unassigned"),
    workType: String(issue?.fields?.issuetype?.name ?? "Unknown"),
  };
}

async function readIncomingFrame(env) {
  const response = await fetch(
    `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/frames/${encodeURIComponent(INCOMING_FRAME_ID)}`,
    { headers: miroHeaders(env) },
  );
  if (!response.ok) {
    return { ok: false, stage: "incoming-read-frame", miroStatus: response.status, error: await response.text() };
  }
  const frame = await response.json();
  const width = Number(frame?.geometry?.width);
  const height = Number(frame?.geometry?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { ok: false, stage: "incoming-frame-geometry", reason: "Incoming frame has invalid geometry" };
  }
  return { ok: true, frame, width, height };
}

async function listIncomingChildren(env) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/items`);
    url.searchParams.set("parent_item_id", INCOMING_FRAME_ID);
    url.searchParams.set("limit", "50");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url.toString(), { headers: miroHeaders(env) });
    if (!response.ok) {
      return { ok: false, stage: "incoming-list-children", miroStatus: response.status, error: await response.text() };
    }

    const data = await response.json();
    items.push(...(Array.isArray(data?.data) ? data.data : []));
    cursor = String(data?.cursor ?? "").trim() || null;
    if (!cursor) break;
  }
  return { ok: true, items };
}

function customIssueKeyFromImage(item) {
  if (item?.type !== "image") return null;
  const title = String(item?.data?.title ?? "").trim();
  const match = title.match(/^CUSTOM_JIRA_CARD:(SN-\d+)$/i);
  return match ? normalizeIssueKey(match[1]) : null;
}

function chooseIncomingPosition(frameWidth, frameHeight, customImages) {
  const usableWidth = Math.max(CARD_WIDTH, frameWidth - FRAME_MARGIN_X * 2);
  const usableHeight = Math.max(CARD_HEIGHT, frameHeight - FRAME_MARGIN_Y * 2);
  const columns = Math.max(1, Math.floor((usableWidth + CARD_GAP_X) / (CARD_WIDTH + CARD_GAP_X)));
  const rows = Math.max(1, Math.floor((usableHeight + CARD_GAP_Y) / (CARD_HEIGHT + CARD_GAP_Y)));

  const occupied = customImages
    .map(item => ({ x: Number(item?.position?.x), y: Number(item?.position?.y) }))
    .filter(position => Number.isFinite(position.x) && Number.isFinite(position.y));

  const isOccupied = (x, y) => occupied.some(position =>
    Math.abs(position.x - x) <= 8 && Math.abs(position.y - y) <= 8,
  );

  // Fill the complete base grid first: top-to-bottom, then left-to-right.
  // Once full, every new layer repeats the same slot order and shifts ALL
  // cards in the same direction (+X/+Y). Using a per-slot direction caused
  // bottom-row cards to shift upward while top-row cards shifted downward.
  for (let layer = 0; layer < MAX_LAYERS; layer += 1) {
    for (let column = 0; column < columns; column += 1) {
      for (let row = 0; row < rows; row += 1) {
        const baseX = FRAME_MARGIN_X + CARD_WIDTH / 2 + column * (CARD_WIDTH + CARD_GAP_X);
        const baseY = FRAME_MARGIN_Y + CARD_HEIGHT / 2 + row * (CARD_HEIGHT + CARD_GAP_Y);
        const x = baseX + layer * LAYER_OFFSET_X;
        const y = baseY + layer * LAYER_OFFSET_Y;

        const inside =
          x - CARD_WIDTH / 2 >= 0 &&
          x + CARD_WIDTH / 2 <= frameWidth &&
          y - CARD_HEIGHT / 2 >= 0 &&
          y + CARD_HEIGHT / 2 <= frameHeight;

        if (inside && !isOccupied(x, y)) {
          return { x, y, row, column, layer, rows, columns };
        }
      }
    }
  }

  return null;
}

async function createIncomingCard(env, issueKey) {
  if (!env.CARD_MAP || !env.MIRO_TOKEN || !env.MIRO_BOARD_ID || !env.JIRA_API_TOKEN || !env.JIRA_CLOUD_ID) {
    return { ok: false, created: false, stage: "incoming-config", reason: "Required bindings are missing" };
  }

  const existingMapping = await env.CARD_MAP.get(customCardMapKey(issueKey));
  if (existingMapping) {
    return { ok: true, created: false, mapped: true, itemId: existingMapping };
  }

  const [frameResult, childrenResult, jira] = await Promise.all([
    readIncomingFrame(env),
    listIncomingChildren(env),
    readJiraCardData(env, issueKey),
  ]);

  if (!frameResult.ok) return { ...frameResult, created: false };
  if (!childrenResult.ok) return { ...childrenResult, created: false };
  if (!jira.ok) return { ...jira, created: false };

  if (!Object.prototype.hasOwnProperty.call(WORK_TYPE_COLORS, jira.workType.trim().toLowerCase())) {
    return { ok: true, created: false, ignored: true, reason: `Unsupported work type: ${jira.workType}` };
  }

  const existingImage = childrenResult.items.find(item => customIssueKeyFromImage(item) === issueKey);
  if (existingImage?.id) {
    await env.CARD_MAP.put(customCardMapKey(issueKey), String(existingImage.id));
    return { ok: true, created: false, mapped: true, recovered: true, itemId: String(existingImage.id) };
  }

  const customImages = childrenResult.items.filter(item => customIssueKeyFromImage(item));
  const position = chooseIncomingPosition(frameResult.width, frameResult.height, customImages);
  if (!position) {
    return { ok: false, created: false, stage: "incoming-no-space", reason: "No safe Incoming slot was available" };
  }

  const mappingAfterReads = await env.CARD_MAP.get(customCardMapKey(issueKey));
  if (mappingAfterReads) {
    return { ok: true, created: false, mapped: true, itemId: mappingAfterReads };
  }

  const dataUrl = buildCardDataUrl(jira);
  const response = await fetch(
    `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images`,
    {
      method: "POST",
      headers: {
        ...miroHeaders(env),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: {
          url: dataUrl,
          title: `CUSTOM_JIRA_CARD:${issueKey}`,
        },
        position: {
          x: position.x,
          y: position.y,
          origin: "center",
        },
        geometry: {
          width: CARD_WIDTH,
        },
        parent: {
          id: INCOMING_FRAME_ID,
        },
      }),
    },
  );

  if (!response.ok) {
    return { ok: false, created: false, stage: "incoming-create-image", miroStatus: response.status, error: await response.text(), position };
  }

  const image = await response.json();
  const itemId = String(image?.id ?? "").trim();
  if (!itemId) {
    return { ok: false, created: false, stage: "incoming-create-image-id", reason: "Miro created an image without returning an item ID" };
  }

  await env.CARD_MAP.put(customCardMapKey(issueKey), itemId);

  return {
    ok: true,
    created: true,
    mapped: true,
    itemId,
    issueKey,
    workType: jira.workType,
    frameId: INCOMING_FRAME_ID,
    position,
    layout: {
      cardWidth: CARD_WIDTH,
      cardHeight: CARD_HEIGHT,
      marginX: FRAME_MARGIN_X,
      marginY: FRAME_MARGIN_Y,
      gapX: CARD_GAP_X,
      gapY: CARD_GAP_Y,
      layerOffsetX: LAYER_OFFSET_X,
      layerOffsetY: LAYER_OFFSET_Y,
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/") {
      return previewWorker.fetch(request, env, ctx);
    }

    const baseResponse = await previewWorker.fetch(request.clone(), env, ctx);
    let body = null;
    try {
      body = await baseResponse.clone().json();
    } catch {
      return baseResponse;
    }

    const issueKey = normalizeIssueKey(body?.issueKey);
    if (
      !baseResponse.ok ||
      !body?.ok ||
      body?.unmapped !== true ||
      !/^SN-\d+$/i.test(issueKey)
    ) {
      return baseResponse;
    }

    let incomingCreate;
    try {
      incomingCreate = await createIncomingCard(env, issueKey);
    } catch (error) {
      incomingCreate = {
        ok: false,
        created: false,
        stage: "incoming-unexpected-error",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    console.log("JIRA -> MIRO Incoming auto-create:", issueKey, incomingCreate);
    return jsonResponseLike(baseResponse, { ...body, incomingCreate });
  },
};