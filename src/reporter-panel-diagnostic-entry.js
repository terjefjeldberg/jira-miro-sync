import reporterWorker from "./reporter-jira-picker-entry.js";

function responseWithText(original, text) {
  const headers = new Headers(original.headers);
  headers.delete("Content-Length");
  return new Response(text, {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

function patchCustomCardLayout(html) {
  let patched = html;

  const titleSizeBlock = /\n\s*const titleSize =\s*titleFontSize\(\s*jira\.summary\s*\);/;
  const dynamicTitleBlock = `

    function estimateTitleTextWidth(text, fontSize) {
      const value = String(text || "");
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

      for (const char of String(word || "")) {
        const candidate = current + char;
        if (current && estimateTitleTextWidth(candidate, fontSize) > maxWidth) {
          chunks.push(current);
          current = char;
        } else {
          current = candidate;
        }
      }

      if (current) chunks.push(current);
      return chunks.length ? chunks : [String(word || "")];
    }

    function wrapTitleLines(text, fontSize, maxWidth) {
      const words = String(text || "").trim().split(/\\s+/).filter(Boolean);
      const lines = [];
      let currentLine = "";

      for (const word of words) {
        const parts = estimateTitleTextWidth(word, fontSize) > maxWidth
          ? splitTitleWord(word, fontSize, maxWidth)
          : [word];

        for (const part of parts) {
          const candidate = currentLine ? currentLine + " " + part : part;
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
      const titleBox = { x: 20, y: 26, width: 280, height: 56 };
      const minFontSize = 10;
      const maxFontSize = 44;
      const maxLines = 4;
      const lineHeightFactor = 1.05;

      for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 1) {
        const lines = wrapTitleLines(text, fontSize, titleBox.width);
        const lineHeight = fontSize * lineHeightFactor;
        const totalHeight = lines.length * lineHeight;

        if (lines.length <= maxLines && totalHeight <= titleBox.height) {
          return {
            centerX: titleBox.x + titleBox.width / 2,
            startY: titleBox.y + (titleBox.height - totalHeight) / 2 + fontSize * 0.82,
            fontSize,
            lineHeight,
            lines
          };
        }
      }

      const fontSize = minFontSize;
      const lines = wrapTitleLines(text, fontSize, titleBox.width).slice(0, maxLines);
      const lineHeight = fontSize * lineHeightFactor;
      const totalHeight = lines.length * lineHeight;

      return {
        centerX: titleBox.x + titleBox.width / 2,
        startY: titleBox.y + (titleBox.height - totalHeight) / 2 + fontSize * 0.82,
        fontSize,
        lineHeight,
        lines
      };
    }

    const titleLayout = buildTitleLayout(jira.summary);
    const titleSvg = [
      '<text x="' + titleLayout.centerX + '" y="' + titleLayout.startY + '" text-anchor="middle" font-family="Open Sans, Arial, sans-serif" font-size="' + titleLayout.fontSize + '" font-weight="400" fill="#1A1A1A">',
      ...titleLayout.lines.map(function (line, index) {
        return index === 0
          ? '<tspan x="' + titleLayout.centerX + '">' + svgEscape(line) + '</tspan>'
          : '<tspan x="' + titleLayout.centerX + '" dy="' + titleLayout.lineHeight + '">' + svgEscape(line) + '</tspan>';
      }),
      '</text>'
    ].join("");`;

  if (titleSizeBlock.test(patched)) {
    patched = patched.replace(titleSizeBlock, dynamicTitleBlock);
  }

  const oldTitleLine = `        '<text x="20" y="60" font-family="Arial, sans-serif" font-size="' + titleSize + '" font-weight="700" fill="#1A1A1A">' + summary + '</text>',`;
  if (patched.includes(oldTitleLine)) {
    patched = patched.replace(oldTitleLine, "        titleSvg,");
  }

  const oldBackgroundLine = `        '<rect width="320" height="120" rx="0" fill="' + cardColor + '"/>',`;
  const borderedBackgroundLine = `        '<rect x="2" y="2" width="316" height="116" rx="6" fill="' + cardColor + '" stroke="#3F4854" stroke-width="2"/>',`;
  if (patched.includes(oldBackgroundLine)) {
    patched = patched.replace(oldBackgroundLine, borderedBackgroundLine);
  }

  patched = patched.replaceAll(
    'font-family="Arial, sans-serif"',
    'font-family="Open Sans, Arial, sans-serif"',
  );

  return patched;
}

async function injectCreatorDiagnostic(baseResponse) {
  if (!baseResponse.ok) return baseResponse;

  const html = await baseResponse.clone().text();
  const buttonMarkup = `
    <button id="creatorIdButton" type="button" style="margin-top:10px;background:#ffffff;color:#4262ff;border:1px solid #4262ff;">
      Show selected item creator ID
    </button>
    <div id="creatorDiagnosticResult" style="display:none;margin-top:10px;padding:10px;border:1px solid #d9d9d9;border-radius:4px;background:#f7f7f7;">
      <div style="font-size:12px;margin-bottom:4px;">Miro creator ID</div>
      <input id="creatorDiagnosticId" type="text" readonly style="box-sizing:border-box;width:100%;padding:7px;border:1px solid #c8c8c8;border-radius:3px;background:#ffffff;user-select:text;" />
      <button id="copyCreatorIdButton" type="button" style="margin-top:8px;background:#ffffff;color:#4262ff;border:1px solid #4262ff;">
        Copy ID
      </button>
    </div>
    <button id="frameIdButton" type="button" style="margin-top:10px;background:#ffffff;color:#4262ff;border:1px solid #4262ff;">
      Show selected frame ID
    </button>
    <div id="frameDiagnosticResult" style="display:none;margin-top:10px;padding:10px;border:1px solid #d9d9d9;border-radius:4px;background:#f7f7f7;">
      <div style="font-size:12px;margin-bottom:4px;">Miro frame ID</div>
      <input id="frameDiagnosticId" type="text" readonly style="box-sizing:border-box;width:100%;padding:7px;border:1px solid #c8c8c8;border-radius:3px;background:#ffffff;user-select:text;" />
      <button id="copyFrameIdButton" type="button" style="margin-top:8px;background:#ffffff;color:#4262ff;border:1px solid #4262ff;">
        Copy ID
      </button>
    </div>
  `;

  const buttonTarget = '<button id="convertButton">';
  let patched = patchCustomCardLayout(html);

  if (patched.includes(buttonTarget) && !patched.includes('id="creatorIdButton"')) {
    patched = patched.replace(buttonTarget, buttonMarkup + "\n" + buttonTarget);
  }

  const script = `
<script>
(function () {
  function creatorId(createdBy) {
    if (!createdBy) return "";
    if (typeof createdBy === "string" || typeof createdBy === "number") {
      return String(createdBy).trim();
    }
    return String(
      createdBy.id ??
      createdBy.userId ??
      createdBy.memberId ??
      createdBy.user?.id ??
      ""
    ).trim();
  }

  function isSupportedItem(item) {
    return item?.type === "sticky_note" || item?.type === "card";
  }

  const button = document.getElementById("creatorIdButton");
  const result = document.getElementById("creatorDiagnosticResult");
  const idElement = document.getElementById("creatorDiagnosticId");
  const copyButton = document.getElementById("copyCreatorIdButton");
  const frameButton = document.getElementById("frameIdButton");
  const frameResult = document.getElementById("frameDiagnosticResult");
  const frameIdElement = document.getElementById("frameDiagnosticId");
  const copyFrameButton = document.getElementById("copyFrameIdButton");
  if (!button || !result || !idElement || !copyButton || !frameButton || !frameResult || !frameIdElement || !copyFrameButton) return;

  function clearResult() {
    idElement.value = "";
    result.style.display = "none";
  }

  function clearFrameResult() {
    frameIdElement.value = "";
    frameResult.style.display = "none";
  }

  async function refreshFromCurrentSelection(selectId) {
    const selected = await miro.board.getSelection();
    if (!Array.isArray(selected) || selected.length !== 1 || !isSupportedItem(selected[0])) {
      clearResult();
      return false;
    }

    const id = creatorId(selected[0].createdBy);
    if (!id) {
      clearResult();
      return false;
    }

    idElement.value = id;
    result.style.display = "block";
    if (selectId) {
      idElement.focus();
      idElement.select();
    }
    return true;
  }

  async function refreshFrameFromCurrentSelection(selectId) {
    const selected = await miro.board.getSelection();
    if (!Array.isArray(selected) || selected.length !== 1 || selected[0]?.type !== "frame") {
      clearFrameResult();
      return false;
    }

    const id = String(selected[0].id || "").trim();
    if (!id) {
      clearFrameResult();
      return false;
    }

    frameIdElement.value = id;
    frameResult.style.display = "block";
    if (selectId) {
      frameIdElement.focus();
      frameIdElement.select();
    }
    return true;
  }

  button.addEventListener("click", async function () {
    try {
      const shown = await refreshFromCurrentSelection(true);
      if (!shown) alert("Select exactly one sticky note or Miro card first.");
    } catch (error) {
      console.error("MIRO CREATOR ID DIAGNOSTIC FAILED:", error);
      alert("Could not read the selected item creator ID.");
    }
  });

  frameButton.addEventListener("click", async function () {
    try {
      const shown = await refreshFrameFromCurrentSelection(true);
      if (!shown) alert("Select exactly one Miro frame first.");
    } catch (error) {
      console.error("MIRO FRAME ID DIAGNOSTIC FAILED:", error);
      alert("Could not read the selected frame ID.");
    }
  });

  miro.board.ui.on("selection:update", function () {
    refreshFromCurrentSelection(false).catch(function (error) {
      console.error("MIRO CREATOR SELECTION UPDATE FAILED:", error);
    });
    refreshFrameFromCurrentSelection(false).catch(function (error) {
      console.error("MIRO FRAME SELECTION UPDATE FAILED:", error);
    });
  });

  copyButton.addEventListener("click", async function () {
    const value = String(idElement.value || "").trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      copyButton.textContent = "Copied";
      setTimeout(function () { copyButton.textContent = "Copy ID"; }, 1000);
    } catch {
      idElement.focus();
      idElement.select();
    }
  });

  copyFrameButton.addEventListener("click", async function () {
    const value = String(frameIdElement.value || "").trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      copyFrameButton.textContent = "Copied";
      setTimeout(function () { copyFrameButton.textContent = "Copy ID"; }, 1000);
    } catch {
      frameIdElement.focus();
      frameIdElement.select();
    }
  });

  refreshFromCurrentSelection(false).catch(function (error) {
    console.error("MIRO CREATOR INITIAL REFRESH FAILED:", error);
  });
  refreshFrameFromCurrentSelection(false).catch(function (error) {
    console.error("MIRO FRAME INITIAL REFRESH FAILED:", error);
  });
})();
</script>
`;

  if (!patched.includes("MIRO CREATOR ID DIAGNOSTIC FAILED:")) {
    patched = patched.replace("</body>", script + "\n</body>");
  }

  return responseWithText(baseResponse, patched);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/miro-panel") {
      const response = await reporterWorker.fetch(request, env, ctx);
      return await injectCreatorDiagnostic(response);
    }

    return reporterWorker.fetch(request, env, ctx);
  },
};
