import incomingWorker from "./incoming-create-any-status-entry.js";

const INCOMING_FRAME_ID = "3458764681916843188";
const CARD_WIDTH = 320;

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

function svgEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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

function buildSvg(jira) {
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

  return [
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
    return { ok: false, stage: "incoming-multipart-read-jira", jiraStatus: response.status, error: await response.text() };
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

async function createWithMultipart(env, issueKey, position) {
  const existingMapping = await env.CARD_MAP.get(customCardMapKey(issueKey));
  if (existingMapping) {
    return { ok: true, created: false, mapped: true, itemId: existingMapping };
  }

  const jira = await readJiraCardData(env, issueKey);
  if (!jira.ok) return { ...jira, created: false };

  const svg = buildSvg(jira);
  const formData = new FormData();
  formData.append(
    "resource",
    new Blob([new TextEncoder().encode(svg)], { type: "image/svg+xml" }),
    `${issueKey}.svg`,
  );
  formData.append(
    "data",
    JSON.stringify({ title: `CUSTOM_JIRA_CARD:${issueKey}` }),
  );

  const uploadResponse = await fetch(
    `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MIRO_TOKEN}`,
        Accept: "application/json",
      },
      body: formData,
    },
  );

  if (!uploadResponse.ok) {
    return {
      ok: false,
      created: false,
      stage: "incoming-multipart-upload",
      miroStatus: uploadResponse.status,
      error: await uploadResponse.text(),
    };
  }

  const uploaded = await uploadResponse.json();
  const itemId = String(uploaded?.id ?? "").trim();
  if (!itemId) {
    return { ok: false, created: false, stage: "incoming-multipart-upload-id", reason: "Miro upload returned no image ID" };
  }

  const patchResponse = await fetch(
    `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images/${encodeURIComponent(itemId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${env.MIRO_TOKEN}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: { title: `CUSTOM_JIRA_CARD:${issueKey}` },
        position: {
          x: Number(position?.x),
          y: Number(position?.y),
          origin: "center",
        },
        geometry: { width: CARD_WIDTH },
        parent: { id: INCOMING_FRAME_ID },
      }),
    },
  );

  if (!patchResponse.ok) {
    const error = await patchResponse.text();
    try {
      await fetch(
        `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images/${encodeURIComponent(itemId)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${env.MIRO_TOKEN}`,
            Accept: "application/json",
          },
        },
      );
    } catch {}

    return {
      ok: false,
      created: false,
      stage: "incoming-multipart-position",
      miroStatus: patchResponse.status,
      error,
    };
  }

  await env.CARD_MAP.put(customCardMapKey(issueKey), itemId);

  return {
    ok: true,
    created: true,
    mapped: true,
    itemId,
    issueKey,
    frameId: INCOMING_FRAME_ID,
    position,
    uploadMode: "multipart-svg-then-patch",
  };
}

export default {
  async fetch(request, env, ctx) {
    const response = await incomingWorker.fetch(request, env, ctx);
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/") {
      return response;
    }

    let body = null;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }

    const issueKey = normalizeIssueKey(body?.issueKey);
    const failedCreate =
      response.ok &&
      body?.incomingCreate?.ok === false &&
      body?.incomingCreate?.stage === "incoming-create-image" &&
      /^SN-\d+$/i.test(issueKey);

    if (!failedCreate) {
      return response;
    }

    let fixedCreate;
    try {
      fixedCreate = await createWithMultipart(env, issueKey, body.incomingCreate.position);
    } catch (error) {
      fixedCreate = {
        ok: false,
        created: false,
        stage: "incoming-multipart-unexpected-error",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    console.log("JIRA -> MIRO Incoming multipart fallback:", issueKey, fixedCreate);

    return jsonResponseLike(response, {
      ...body,
      incomingCreateOriginalFailure: body.incomingCreate,
      incomingCreate: fixedCreate,
    });
  },
};
