import reporterWorker from "./reporter-jira-picker-entry.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://miro.com",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Webhook-Secret",
  "Access-Control-Max-Age": "86400",
};

const KNOWN_MIRO_CREATORS = {
  "3458764589815876301": "Kristoffer Rask",
  "3074457347700027993": "Tim Chipman",
  "3074457362562828515": "Rupert Hanna",
  "3074457346177807607": "Robin Grønvold",
  "3458764570480950130": "Terje Fjeldberg",
  "3074457345777323592": "Ole Kristian Kvarsvik",
  "3458764555898556023": "Masud Mahamed",
  "3074457366743197593": "Jostein Edvardsen",
  "3074457346139208205": "Kristian Samuelsen",
  "3458764561305764945": "Mathias Hellqvist",
  "99386030": "Christoffer Henne",
  "3458764544817410612": "Zandrex Ramos Camagon",
  "3074457352976810809": "Erwin Berkers",
  "3074457352976810811": "Manuel Gonzalez",
};

function responseWithText(original, text) {
  const headers = new Headers(original.headers);
  headers.delete("Content-Length");
  return new Response(text, {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function validateMiroRequest(request, env, ctx) {
  const probeUrl = new URL(request.url);
  probeUrl.pathname = "/custom-card-pending";
  probeUrl.search = "";
  const probeRequest = new Request(probeUrl.toString(), {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({ issueKeys: [] }),
  });
  return await reporterWorker.fetch(probeRequest, env, ctx);
}

function memberIdentity(value) {
  if (!value) return { id: "", name: "", role: "" };
  return {
    id: String(value.id ?? value.memberId ?? value.user?.id ?? value.data?.id ?? "").trim(),
    name: String(
      value.name ?? value.displayName ?? value.user?.name ?? value.user?.displayName ?? value.data?.name ?? "",
    ).trim(),
    role: String(value.role ?? value.type ?? "").trim(),
  };
}

async function listBoardMembers(env) {
  if (!env.MIRO_TOKEN || !env.MIRO_BOARD_ID) {
    return { ok: false, status: 500, reason: "Miro board configuration is missing" };
  }

  const headers = {
    Authorization: `Bearer ${env.MIRO_TOKEN}`,
    Accept: "application/json",
  };

  const byId = new Map();
  let cursor = "";

  for (let page = 0; page < 30; page += 1) {
    const url = new URL(`https://api.miro.com/v2/boards/${encodeURIComponent(env.MIRO_BOARD_ID)}/members`);
    url.searchParams.set("limit", "50");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url.toString(), { headers });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        reason: `Miro board member lookup failed with HTTP ${response.status}`,
        error: await response.text(),
      };
    }

    const payload = await response.json();
    const members = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload)
        ? payload
        : [];

    for (const raw of members) {
      const member = memberIdentity(raw);
      if (!member.id) continue;
      byId.set(member.id, {
        id: member.id,
        name: member.name || KNOWN_MIRO_CREATORS[member.id] || "Unknown name",
        role: member.role,
        knownMapping: Boolean(KNOWN_MIRO_CREATORS[member.id]),
      });
    }

    cursor = String(payload?.cursor ?? "").trim();
    if (!cursor) break;
  }

  const members = Array.from(byId.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );

  return { ok: true, members, count: members.length };
}

async function injectBoardMemberPanel(baseResponse) {
  if (!baseResponse.ok) return baseResponse;

  const html = await baseResponse.clone().text();
  const buttonMarkup = `
    <button id="boardMembersButton" type="button" style="margin-top:10px;background:#ffffff;color:#4262ff;border:1px solid #4262ff;">
      Show board members
    </button>
    <div id="boardMembersResult" style="display:none;margin-top:10px;padding:10px;border:1px solid #d9d9d9;border-radius:4px;background:#f7f7f7;max-height:380px;overflow:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;">
        <strong id="boardMembersHeading">Board members</strong>
        <button id="copyAllMembersButton" type="button" style="background:#ffffff;color:#4262ff;border:1px solid #4262ff;">Copy all</button>
      </div>
      <div id="boardMembersList"></div>
    </div>
  `;

  const buttonTarget = '<button id="convertButton">';
  let patched = html;

  if (patched.includes(buttonTarget) && !patched.includes('id="boardMembersButton"')) {
    patched = patched.replace(buttonTarget, buttonMarkup + "\n" + buttonTarget);
  }

  const script = `
<script>
(function () {
  const button = document.getElementById("boardMembersButton");
  const result = document.getElementById("boardMembersResult");
  const heading = document.getElementById("boardMembersHeading");
  const list = document.getElementById("boardMembersList");
  const copyAll = document.getElementById("copyAllMembersButton");
  if (!button || !result || !heading || !list || !copyAll) return;

  let latestMembers = [];

  async function backendPost(path, body) {
    const token = await miro.board.getIdToken();
    return await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      },
      body: JSON.stringify(body || {})
    });
  }

  function rowFor(member) {
    const row = document.createElement("div");
    row.style.cssText = "padding:8px 0;border-top:1px solid #e4e4e4;";

    const name = document.createElement("div");
    name.textContent = member.name || "Unknown name";
    name.style.cssText = "font-weight:600;margin-bottom:4px;";

    const idLine = document.createElement("div");
    idLine.style.cssText = "display:flex;gap:6px;align-items:center;";

    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.value = member.id || "";
    input.style.cssText = "box-sizing:border-box;flex:1;min-width:0;padding:6px;border:1px solid #c8c8c8;border-radius:3px;background:#fff;";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy";
    copy.style.cssText = "background:#fff;color:#4262ff;border:1px solid #4262ff;";
    copy.addEventListener("click", async function () {
      try {
        await navigator.clipboard.writeText(input.value);
        copy.textContent = "Copied";
        setTimeout(function () { copy.textContent = "Copy"; }, 1000);
      } catch {
        input.focus();
        input.select();
      }
    });

    idLine.appendChild(input);
    idLine.appendChild(copy);
    row.appendChild(name);
    row.appendChild(idLine);
    return row;
  }

  async function loadMembers() {
    button.disabled = true;
    button.textContent = "Loading board members...";
    try {
      const response = await backendPost("/miro-board-members", {});
      const data = await response.json();
      if (!response.ok || !data?.ok) {
        throw new Error(data?.reason || "Could not load board members");
      }

      latestMembers = Array.isArray(data.members) ? data.members : [];
      heading.textContent = "Board members (" + latestMembers.length + ")";
      list.innerHTML = "";
      for (const member of latestMembers) list.appendChild(rowFor(member));
      result.style.display = "block";
    } catch (error) {
      console.error("MIRO BOARD MEMBER LIST FAILED:", error);
      alert(error?.message || "Could not load board members.");
    } finally {
      button.disabled = false;
      button.textContent = "Show board members";
    }
  }

  button.addEventListener("click", loadMembers);

  copyAll.addEventListener("click", async function () {
    if (!latestMembers.length) return;
    const text = latestMembers.map(function (member) {
      return (member.name || "Unknown name") + " - " + member.id;
    }).join("\\n");
    try {
      await navigator.clipboard.writeText(text);
      copyAll.textContent = "Copied";
      setTimeout(function () { copyAll.textContent = "Copy all"; }, 1000);
    } catch {
      console.log(text);
      alert("Could not copy automatically. The member list was written to the console.");
    }
  });
})();
</script>
`;

  if (!patched.includes("MIRO BOARD MEMBER LIST FAILED:")) {
    patched = patched.replace("</body>", script + "\n</body>");
  }

  return responseWithText(baseResponse, patched);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/miro-board-members") {
      const authProbe = await validateMiroRequest(request, env, ctx);
      if (!authProbe.ok) return authProbe;

      const members = await listBoardMembers(env);
      if (!members.ok) {
        return jsonResponse({ ok: false, reason: members.reason, error: members.error }, members.status || 500);
      }
      return jsonResponse({ ok: true, count: members.count, members: members.members });
    }

    if (request.method === "GET" && url.pathname === "/miro-panel") {
      const response = await reporterWorker.fetch(request, env, ctx);
      return await injectBoardMemberPanel(response);
    }

    return reporterWorker.fetch(request, env, ctx);
  },
};
