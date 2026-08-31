import conversionWorker from "./conversion-aware-entry.js";

const CARD_WIDTH = 320;
const ORIGINAL_MIRO_CREATED_FIELD = "customfield_11207";

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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function miroHeaders(env) {
  return {
    Authorization: `Bearer ${env.MIRO_TOKEN}`,
    Accept: "application/json",
  };
}

async function readBody(request) {
  try {
    return await request.clone().json();
  } catch {
    return null;
  }
}

async function validateMiroRequest(request, env, ctx) {
  const probeUrl = new URL(request.url);
  probeUrl.pathname = "/custom-card-pending";
  probeUrl.search = "";
  const probe = new Request(probeUrl.toString(), {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({ issueKeys: [] }),
  });
  const response = await conversionWorker.fetch(probe, env, ctx);
  return response.ok;
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
    `https://api.atlassian.com/ex/jira/${encodeURIComponent(env.JIRA_CLOUD_ID)}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,priority,assignee,issuetype,${ORIGINAL_MIRO_CREATED_FIELD}`,
    {
      headers: {
        Authorization: `Bearer ${env.JIRA_API_TOKEN}`,
        Accept: "application/json",
      },
    },
  );
  if (!response.ok) {
    return { ok: false, status: response.status, error: await response.text() };
  }
  const issue = await response.json();
  return {
    ok: true,
    issueKey,
    summary: String(issue?.fields?.summary ?? ""),
    priority: String(issue?.fields?.priority?.name ?? "None"),
    assignee: String(issue?.fields?.assignee?.displayName ?? "Unassigned"),
    workType: String(issue?.fields?.issuetype?.name ?? "Unknown"),
    originalMiroCreated: issue?.fields?.[ORIGINAL_MIRO_CREATED_FIELD] ?? null,
  };
}

async function createDirectCard(env, issueKey, x, y) {
  if (!env.CARD_MAP || !env.MIRO_TOKEN || !env.MIRO_BOARD_ID) {
    return { ok: false, status: 500, reason: "Required Miro bindings are missing" };
  }
  const existing = String(await env.CARD_MAP.get(customCardMapKey(issueKey)) ?? "").trim();
  if (existing) {
    return { ok: true, created: false, itemId: existing, alreadyMapped: true };
  }

  const jira = await readJiraCardData(env, issueKey);
  if (!jira.ok) {
    return { ok: false, status: 502, stage: "direct-read-jira", jiraStatus: jira.status, error: jira.error };
  }

  const svg = buildSvg(jira);
  const formData = new FormData();
  formData.append(
    "resource",
    new Blob([new TextEncoder().encode(svg)], { type: "image/svg+xml" }),
    `${issueKey}.svg`,
  );
  formData.append("data", JSON.stringify({ title: `CUSTOM_JIRA_CARD:${issueKey}` }));

  const uploadResponse = await fetch(
    `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images`,
    { method: "POST", headers: miroHeaders(env), body: formData },
  );
  if (!uploadResponse.ok) {
    return { ok: false, status: 502, stage: "direct-upload", miroStatus: uploadResponse.status, error: await uploadResponse.text() };
  }

  const uploaded = await uploadResponse.json();
  const itemId = String(uploaded?.id ?? "").trim();
  if (!itemId) {
    return { ok: false, status: 502, stage: "direct-upload-id", reason: "Miro returned no image ID" };
  }

  const patchResponse = await fetch(
    `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images/${encodeURIComponent(itemId)}`,
    {
      method: "PATCH",
      headers: { ...miroHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({
        data: { title: `CUSTOM_JIRA_CARD:${issueKey}` },
        position: { x, y, origin: "center" },
        geometry: { width: CARD_WIDTH },
      }),
    },
  );
  if (!patchResponse.ok) {
    const error = await patchResponse.text();
    await fetch(
      `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/images/${encodeURIComponent(itemId)}`,
      { method: "DELETE", headers: miroHeaders(env) },
    ).catch(() => {});
    return { ok: false, status: 502, stage: "direct-position", miroStatus: patchResponse.status, error };
  }

  await env.CARD_MAP.put(customCardMapKey(issueKey), itemId);
  return { ok: true, created: true, itemId };
}

async function shouldSuppressIncomingForConvertedIssue(env, issueKey) {
  if (!env.CARD_MAP || !issueKey) return false;
  const mapping = String(await env.CARD_MAP.get(customCardMapKey(issueKey)) ?? "").trim();
  if (mapping) return false;
  const jira = await readJiraCardData(env, issueKey);
  return Boolean(jira.ok && jira.originalMiroCreated);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/conversion-direct-card") {
      if (!(await validateMiroRequest(request, env, ctx))) {
        return jsonResponse({ ok: false, reason: "Invalid Miro identity token" }, 401);
      }
      const body = await readBody(request);
      const issueKey = normalizeIssueKey(body?.issueKey);
      const x = Number(body?.x);
      const y = Number(body?.y);
      if (!/^SN-\d+$/i.test(issueKey) || !Number.isFinite(x) || !Number.isFinite(y)) {
        return jsonResponse({ ok: false, reason: "Invalid issue key or position" }, 400);
      }
      const result = await createDirectCard(env, issueKey, x, y);
      return jsonResponse(result, result.ok ? 200 : (result.status || 500));
    }

    // A Jira issue created from a Miro sticky already has an exact board
    // position to inherit. If it has Original Miro created and no card mapping
    // yet, the Work item created webhook must NOT create an Incoming card.
    // After the direct card is mapped, normal Jira -> Miro status webhooks work.
    if (request.method === "POST" && url.pathname === "/") {
      const providedSecret = String(request.headers.get("X-Webhook-Secret") ?? "");
      const expectedSecret = String(env.JIRA_WEBHOOK_SECRET ?? "");
      if (expectedSecret && providedSecret === expectedSecret) {
        const body = await readBody(request);
        const issueKey = normalizeIssueKey(body?.issueKey);
        if (/^SN-\d+$/i.test(issueKey) && await shouldSuppressIncomingForConvertedIssue(env, issueKey)) {
          return jsonResponse({
            ok: true,
            moved: false,
            issueKey,
            status: String(body?.status ?? ""),
            conversionDirectCreatePending: true,
          });
        }
      }
    }

    return conversionWorker.fetch(request, env, ctx);
  },
};
