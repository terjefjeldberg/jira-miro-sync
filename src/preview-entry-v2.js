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

function responseWithText(original, text) {
  const headers = new Headers(original.headers);
  headers.delete("Content-Length");
  return new Response(text, {
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
  const value = String(text ?? "");
  let units = 0;

  for (const char of value) {
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
    const candidate = `${current}${char}`;
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
  // Reserved middle zone. The top row is reserved for issue key/Jira link,
  // and the bottom row is reserved for priority/assignee.
  const titleBox = {
    x: 20,
    y: 26,
    width: 280,
    height: 56,
  };

  const minFontSize = 10;
  const maxFontSize = 44;
  const maxLines = 4;
  const lineHeightFactor = 1.05;

  for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 1) {
    const lines = wrapTitleLines(text, fontSize, titleBox.width);
    const lineHeight = fontSize * lineHeightFactor;
    const totalHeight = lines.length * lineHeight;

    if (lines.length <= maxLines && totalHeight <= titleBox.height) {
      const centerX = titleBox.x + titleBox.width / 2;
      const startY =
        titleBox.y +
        (titleBox.height - totalHeight) / 2 +
        fontSize * 0.82;

      return {
        centerX,
        startY,
        fontSize,
        lineHeight,
        lines,
      };
    }
  }

  const fontSize = minFontSize;
  const lines = wrapTitleLines(text, fontSize, titleBox.width).slice(0, maxLines);
  const lineHeight = fontSize * lineHeightFactor;
  const totalHeight = lines.length * lineHeight;
  const centerX = titleBox.x + titleBox.width / 2;
  const startY =
    titleBox.y +
    (titleBox.height - totalHeight) / 2 +
    fontSize * 0.82;

  return {
    centerX,
    startY,
    fontSize,
    lineHeight,
    lines,
  };
}

function cardColorForWorkType(workType) {
  return WORK_TYPE_COLORS[String(workType ?? "").trim().toLowerCase()] || "#E8E8E8";
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

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
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

function miroUserIdentity(value) {
  if (!value) return { id: "", name: "", email: "" };

  if (typeof value === "string") {
    return { id: value.trim(), name: "", email: "" };
  }

  return {
    id: String(value.id ?? value.memberId ?? value.user?.id ?? "").trim(),
    name: String(
      value.name ??
      value.displayName ??
      value.user?.name ??
      value.user?.displayName ??
      "",
    ).trim(),
    email: String(
      value.email ??
      value.emailAddress ??
      value.user?.email ??
      value.user?.emailAddress ??
      "",
    ).trim(),
  };
}

async function readMiroBoardMember(env, memberId) {
  if (!memberId || !env.MIRO_TOKEN || !env.MIRO_BOARD_ID) {
    return null;
  }

  const response = await fetch(
    `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/members/${encodeURIComponent(memberId)}`,
    {
      headers: {
        Authorization: `Bearer ${env.MIRO_TOKEN}`,
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) return null;
  return await response.json();
}

async function resolveStickyCreator(env, stickyId, claimedCreatedBy) {
  const normalizedStickyId = String(stickyId ?? "").trim();
  const claimedCreatorId = String(claimedCreatedBy ?? "").trim();

  if (!normalizedStickyId) {
    return {
      ok: false,
      stage: "reporter-missing-sticky-id",
      reason: "Sticky ID was not supplied by the Miro panel",
    };
  }

  if (!env.MIRO_TOKEN || !env.MIRO_BOARD_ID) {
    return {
      ok: false,
      stage: "reporter-miro-config",
      reason: "Miro REST configuration is missing",
    };
  }

  const itemResponse = await fetch(
    `https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/items/${encodeURIComponent(normalizedStickyId)}`,
    {
      headers: {
        Authorization: `Bearer ${env.MIRO_TOKEN}`,
        Accept: "application/json",
      },
    },
  );

  if (!itemResponse.ok) {
    return {
      ok: false,
      stage: "reporter-read-miro-sticky",
      miroStatus: itemResponse.status,
      error: await itemResponse.text(),
    };
  }

  const item = await itemResponse.json();
  if (item?.type !== "sticky_note") {
    return {
      ok: false,
      stage: "reporter-verify-miro-sticky",
      reason: "The supplied Miro item is not a sticky note",
      itemType: item?.type ?? null,
    };
  }

  let creator = miroUserIdentity(item.createdBy);

  if (
    claimedCreatorId &&
    creator.id &&
    claimedCreatorId !== creator.id
  ) {
    return {
      ok: false,
      stage: "reporter-verify-created-by",
      reason: "Miro createdBy did not match the selected sticky",
      claimedCreatorId,
      actualCreatorId: creator.id,
    };
  }

  if (!creator.name && creator.id) {
    const member = await readMiroBoardMember(env, creator.id);
    if (member) {
      const memberIdentity = miroUserIdentity(member);
      creator = {
        id: creator.id || memberIdentity.id,
        name: memberIdentity.name,
        email: memberIdentity.email,
      };
    }
  }

  if (!creator.id) {
    return {
      ok: false,
      stage: "reporter-miro-creator-id",
      reason: "Miro did not return a creator ID for the sticky note",
    };
  }

  if (!creator.name) {
    return {
      ok: false,
      stage: "reporter-miro-creator-name",
      reason: "Could not resolve the Miro creator name",
      miroCreatorId: creator.id,
    };
  }

  return {
    ok: true,
    creator,
  };
}

async function findJiraReporter(env, creator) {
  if (!env.JIRA_API_TOKEN || !env.JIRA_CLOUD_ID) {
    return {
      ok: false,
      stage: "reporter-jira-config",
      reason: "Jira API configuration is missing",
    };
  }

  const jiraBase =
    `https://api.atlassian.com/ex/jira/${encodeURIComponent(env.JIRA_CLOUD_ID)}/rest/api/3`;

  const searchResponse = await fetch(
    `${jiraBase}/user/assignable/search?project=SN&query=${encodeURIComponent(creator.name)}&maxResults=50`,
    {
      headers: {
        Authorization: `Bearer ${env.JIRA_API_TOKEN}`,
        Accept: "application/json",
      },
    },
  );

  if (!searchResponse.ok) {
    return {
      ok: false,
      stage: "reporter-search-jira-user",
      jiraStatus: searchResponse.status,
      error: await searchResponse.text(),
      miroCreatorName: creator.name,
    };
  }

  const users = await searchResponse.json();
  const candidates = Array.isArray(users)
    ? users.filter(
        user =>
          user?.active !== false &&
          String(user?.accountType ?? "atlassian") !== "app" &&
          String(user?.accountId ?? "").trim(),
      )
    : [];

  const normalizedName = creator.name.toLocaleLowerCase();
  const exactNameMatches = candidates.filter(
    user =>
      String(user?.displayName ?? "")
        .trim()
        .toLocaleLowerCase() === normalizedName,
  );

  let exactMatches = exactNameMatches;

  if (creator.email) {
    const normalizedEmail = creator.email.toLocaleLowerCase();
    const exactEmailMatches = candidates.filter(
      user =>
        String(user?.emailAddress ?? "")
          .trim()
          .toLocaleLowerCase() === normalizedEmail,
    );

    if (exactEmailMatches.length === 1) {
      exactMatches = exactEmailMatches;
    }
  }

  if (exactMatches.length !== 1) {
    return {
      ok: false,
      stage: "reporter-match-jira-user",
      reason:
        exactMatches.length === 0
          ? "No exact assignable Jira user matched the Miro creator"
          : "More than one exact Jira user matched the Miro creator",
      miroCreatorId: creator.id,
      miroCreatorName: creator.name,
      matches: exactMatches.map(user => ({
        accountId: user.accountId,
        displayName: user.displayName,
      })),
      searchCandidates: candidates.map(user => user.displayName),
    };
  }

  const user = exactMatches[0];
  return {
    ok: true,
    accountId: String(user.accountId),
    displayName: String(user.displayName ?? creator.name),
    miroCreatorId: creator.id,
    miroCreatorName: creator.name,
  };
}

async function setReporterFromStickyCreator(
  env,
  issueKey,
  stickyId,
  claimedCreatedBy,
) {
  const creatorResult = await resolveStickyCreator(
    env,
    stickyId,
    claimedCreatedBy,
  );

  if (!creatorResult.ok) return creatorResult;

  const reporterResult = await findJiraReporter(env, creatorResult.creator);
  if (!reporterResult.ok) return reporterResult;

  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${encodeURIComponent(env.JIRA_CLOUD_ID)}/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.JIRA_API_TOKEN}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          reporter: {
            accountId: reporterResult.accountId,
          },
        },
      }),
    },
  );

  if (!response.ok) {
    return {
      ok: false,
      stage: "reporter-update-jira-issue",
      jiraStatus: response.status,
      error: await response.text(),
      miroCreatorId: reporterResult.miroCreatorId,
      miroCreatorName: reporterResult.miroCreatorName,
      jiraReporterAccountId: reporterResult.accountId,
      jiraReporterName: reporterResult.displayName,
    };
  }

  return {
    ok: true,
    applied: true,
    miroCreatorId: reporterResult.miroCreatorId,
    miroCreatorName: reporterResult.miroCreatorName,
    jiraReporterAccountId: reporterResult.accountId,
    jiraReporterName: reporterResult.displayName,
  };
}

async function injectStickyCreatorIntoPanel(baseResponse) {
  if (!baseResponse.ok) return baseResponse;

  const html = await baseResponse.clone().text();
  const original = `              workType:\n                detectedWorkType\n\n            }`;
  const replacement = `              workType:\n                detectedWorkType,\n\n              stickyId:\n                String(sticky.id),\n\n              createdBy:\n                String(sticky.createdBy || \"\")\n\n            }`;

  if (!html.includes(original)) {
    console.warn(
      "MIRO REPORTER SYNC: could not inject sticky creator fields into panel HTML",
    );
    return baseResponse;
  }

  return responseWithText(
    baseResponse,
    html.replace(original, replacement),
  );
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
    assignee: String(issue?.fields?.assignee?.displayName ?? "Unassigned"),
    workType: String(issue?.fields?.issuetype?.name ?? "Unknown"),
  };
}

async function buildCardSvgDataUrl(jira) {
  const cardColor = cardColorForWorkType(jira.workType);
  const issueKey = svgEscape(jira.issueKey);
  const priority = svgEscape(jira.priority);
  const assignee = svgEscape(jira.assignee);
  const titleLayout = buildTitleLayout(jira.summary);
  const priorityIcon = priorityIconSvg(jira.priority);

  const titleSvg = [
    `<text x="${titleLayout.centerX}" y="${titleLayout.startY}" text-anchor="middle" font-family="Open Sans, Arial, sans-serif" font-size="${titleLayout.fontSize}" font-weight="400" fill="#1A1A1A">`,
    ...titleLayout.lines.map((line, index) =>
      index === 0
        ? `<tspan x="${titleLayout.centerX}">${svgEscape(line)}</tspan>`
        : `<tspan x="${titleLayout.centerX}" dy="${titleLayout.lineHeight}">${svgEscape(line)}</tspan>`,
    ),
    '</text>',
  ].join("");

  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">',
    `<rect x="2" y="2" width="316" height="116" rx="6" fill="${cardColor}" stroke="#3F4854" stroke-width="2"/>`,
    `<text x="12" y="18" font-family="Arial, sans-serif" font-size="10" font-weight="700" fill="#1A1A1A">${issueKey}</text>`,
    '<text x="308" y="18" text-anchor="end" font-family="Arial, sans-serif" font-size="10" fill="#0A66C2">Jira ↗</text>',
    titleSvg,
    priorityIcon,
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
      priorityIcon: true,
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

    if (request.method === "GET" && url.pathname === "/miro-panel") {
      const baseResponse = await baseWorker.fetch(request, env, ctx);
      return await injectStickyCreatorIntoPanel(baseResponse);
    }

    if (request.method === "POST" && url.pathname === "/sticky-to-jira") {
      let requestBody = null;

      try {
        requestBody = await request.clone().json();
      } catch {
        // The base worker owns validation for malformed JSON.
      }

      const baseResponse = await baseWorker.fetch(request.clone(), env, ctx);

      let result;
      try {
        result = await baseResponse.clone().json();
      } catch {
        return baseResponse;
      }

      if (
        !baseResponse.ok ||
        !result?.ok ||
        !result?.created ||
        !/^SN-\d+$/i.test(String(result?.issueKey ?? ""))
      ) {
        return baseResponse;
      }

      let reporterSync;
      try {
        reporterSync = await setReporterFromStickyCreator(
          env,
          normalizeIssueKey(result.issueKey),
          requestBody?.stickyId,
          requestBody?.createdBy,
        );
      } catch (error) {
        reporterSync = {
          ok: false,
          stage: "reporter-unexpected-error",
          reason: error instanceof Error ? error.message : String(error),
        };
      }

      console.log(
        "MIRO STICKY CREATOR -> JIRA REPORTER:",
        normalizeIssueKey(result.issueKey),
        reporterSync,
      );

      return jsonResponseLike(baseResponse, {
        ...result,
        reporterSync,
      });
    }

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
