// ============================================================
// JIRA <-> MIRO SYNC
//
// EXISTING NATIVE JIRA CARD SYNC
//
// IMPORTANT:
// All experimental custom-card functionality is isolated with:
//
//   CUSTOM CARD EXPERIMENT - START
//   CUSTOM CARD EXPERIMENT - END
//
// Sticky conversion is additionally isolated with:
//
//   CUSTOM CARD EXPERIMENT - STICKY TO JIRA - START
//   CUSTOM CARD EXPERIMENT - STICKY TO JIRA - END
//
// These sections are intended to be removable without changing
// the existing native Jira Card sync.
// ============================================================


// ============================================================
// EXISTING NATIVE SYNC CONFIG
// ============================================================

const TEST_AREA_FIELD_ID =
  "customfield_10832";


// ============================================================
// EXISTING NATIVE SYNC HELPERS
// ============================================================

function normalizeStatus(value) {

  return String(value ?? "")
    .trim()
    .toLowerCase();

}


function normalizeIssueKey(value) {

  return String(value ?? "")
    .trim()
    .toUpperCase();

}


function isSnIssueKey(value) {

  return /^SN-\d+$/i.test(
    String(value ?? "").trim()
  );

}


function cardMapKey(issueKey) {

  return `jira-card:${normalizeIssueKey(issueKey)}`;

}


// ############################################################
// CUSTOM CARD EXPERIMENT - MIRO -> JIRA STATUS SYNC - START
// Separate KV key namespace from native Jira Cards.
// ############################################################

function customCardMapKey(issueKey) {

  return `custom-card:${normalizeIssueKey(issueKey)}`;

}


function customCardPendingKey(issueKey) {

  return `custom-card-pending:${normalizeIssueKey(issueKey)}`;

}

// ############################################################
// CUSTOM CARD EXPERIMENT - MIRO -> JIRA STATUS SYNC - END
// ############################################################


function hasMeaningfulValue(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return false;
  }


  if (
    typeof value === "string"
  ) {
    return value.trim().length > 0;
  }


  if (
    Array.isArray(value)
  ) {
    return value.length > 0;
  }


  if (
    typeof value === "object"
  ) {
    return Object.keys(value).length > 0;
  }


  return true;

}


// ============================================================
// EXISTING NATIVE SYNC
// JWT HELPERS
// ============================================================

function base64UrlToUint8Array(value) {

  let base64 =
    value
      .replace(/-/g, "+")
      .replace(/_/g, "/");


  while (
    base64.length % 4
  ) {
    base64 += "=";
  }


  const binary =
    atob(base64);


  const bytes =
    new Uint8Array(
      binary.length
    );


  for (
    let i = 0;
    i < binary.length;
    i++
  ) {

    bytes[i] =
      binary.charCodeAt(i);

  }


  return bytes;

}


function decodeJwtPart(value) {

  const bytes =
    base64UrlToUint8Array(
      value
    );


  return JSON.parse(
    new TextDecoder()
      .decode(bytes)
  );

}


async function verifyMiroIdToken(
  token,
  clientSecret
) {

  if (
    !token ||
    !clientSecret
  ) {
    return null;
  }


  const parts =
    token.split(".");


  if (
    parts.length !== 3
  ) {
    return null;
  }


  const [
    encodedHeader,
    encodedPayload,
    encodedSignature
  ] = parts;


  let header;
  let payload;


  try {

    header =
      decodeJwtPart(
        encodedHeader
      );


    payload =
      decodeJwtPart(
        encodedPayload
      );


  } catch {

    return null;

  }


  if (
    header.alg !== "HS256"
  ) {
    return null;
  }


  const now =
    Math.floor(
      Date.now() / 1000
    );


  if (
    typeof payload.exp === "number" &&
    payload.exp <= now
  ) {
    return null;
  }


  const key =
    await crypto.subtle.importKey(

      "raw",

      new TextEncoder().encode(
        clientSecret
      ),

      {
        name: "HMAC",
        hash: "SHA-256"
      },

      false,

      [
        "verify"
      ]

    );


  const valid =
    await crypto.subtle.verify(

      "HMAC",

      key,

      base64UrlToUint8Array(
        encodedSignature
      ),

      new TextEncoder().encode(
        encodedHeader +
        "." +
        encodedPayload
      )

    );


  if (
    !valid
  ) {
    return null;
  }


  return payload;

}


async function authenticateMiroRequest(
  request,
  env
) {

  const authorization =
    request.headers.get(
      "Authorization"
    ) || "";


  if (
    !authorization.startsWith(
      "Bearer "
    )
  ) {
    return null;
  }


  const token =
    authorization
      .slice(7)
      .trim();


  return await verifyMiroIdToken(
    token,
    env.MIRO_CLIENT_SECRET
  );

}


// ============================================================
// WORKER
// ============================================================

export default {

  async fetch(
    request,
    env
  ) {

    const url =
      new URL(
        request.url
      );


    // ========================================================
    // CORS
    // ========================================================

    const corsHeaders = {

      "Access-Control-Allow-Origin":
        "https://miro.com",

      "Access-Control-Allow-Methods":
        "POST, GET, OPTIONS",

      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Webhook-Secret",

      "Access-Control-Max-Age":
        "86400"

    };


    const jsonResponse = (
      data,
      init = {}
    ) => {

      const headers =
        new Headers(
          init.headers || {}
        );


      for (
        const [key, value]
        of Object.entries(
          corsHeaders
        )
      ) {

        headers.set(
          key,
          value
        );

      }


      headers.set(
        "Content-Type",
        "application/json"
      );


      return new Response(

        JSON.stringify(
          data
        ),

        {
          ...init,
          headers
        }

      );

    };


    // ========================================================
    // OPTIONS
    // ========================================================

    if (
      request.method === "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status:
            204,

          headers:
            corsHeaders
        }
      );

    }


    // ========================================================
    // HEALTH
    // ========================================================

    if (
      request.method === "GET" &&
      url.pathname === "/health"
    ) {

      return jsonResponse({

        ok:
          true,

        cardMapConfigured:
          Boolean(
            env.CARD_MAP
          ),

        miroClientSecretConfigured:
          Boolean(
            env.MIRO_CLIENT_SECRET
          ),

        miroTokenConfigured:
          Boolean(
            env.MIRO_TOKEN
          ),

        miroBoardConfigured:
          Boolean(
            env.MIRO_BOARD_ID
          ),

        jiraTokenConfigured:
          Boolean(
            env.JIRA_API_TOKEN
          ),

        jiraCloudIdConfigured:
          Boolean(
            env.JIRA_CLOUD_ID
          ),

        jiraWebhookSecretConfigured:
          Boolean(
            env.JIRA_WEBHOOK_SECRET
          ),

        testAreaField:
          TEST_AREA_FIELD_ID

      });

    }


    // ========================================================
    // EXISTING NATIVE JIRA CARD SYNC
    // MAIN MIRO APP
    // ========================================================

    if (
      request.method === "GET" &&
      url.pathname === "/miro-app"
    ) {

      const html = `
<!DOCTYPE html>

<html>

<head>

  <meta charset="UTF-8" />

  <title>
    Jira to Miro position sync
  </title>

  <script
    src="https://miro.com/app/static/sdk/v2/miro.js">
  </script>

</head>

<body>

<script>

(async function () {

  console.log(
    "Miro Jira sync app loaded"
  );


  // ==========================================================
  // EXISTING NATIVE SYNC
  // ACTIVE BOARD
  // ==========================================================

  const ACTIVE_BOARD = {

    left:
      438.36642375544034,

    right:
      5303.436262036128,

    top:
      434.257014599023,

    bottom:
      3045.734778444852

  };


  // ==========================================================
  // EXISTING NATIVE SYNC
  // STATUS COLUMNS
  // ==========================================================

  const columns = [

    {
      status:
        "Todo",

      left:
        1468.7903676550886,

      right:
        2551.696467655089
    },

    {
      status:
        "In progress",

      left:
        2564.6113791667394,

      right:
        3277.6028791667395
    },

    {
      status:
        "Functional review",

      left:
        3289.4484150169965,

      right:
        3651.451815016996
    },

    {
      status:
        "Code review",

      left:
        3662.9922412433402,

      right:
        4020.66884124334
    },

    {
      status:
        "Approved",

      left:
        4033.200178788891,

      right:
        4680.471778788891
    },

    {
      status:
        "Merged",

      left:
        4692.4616140640555,

      right:
        5284.738514064056
    }

  ];


  // ==========================================================
  // EXISTING NATIVE SYNC
  // STATE
  // ==========================================================

  const updateTimers =
    new Map();

  const lastPositions =
    new Map();

  const knownMappings =
    new Map();

  const rollbackTargets =
    new Map();

  let scanRunning =
    false;


  // ==========================================================
  // EXISTING NATIVE SYNC
  // HELPERS
  // ==========================================================

  function isSnIssueKey(
    value
  ) {

    return /^SN-\\d+$/i.test(
      String(
        value ?? ""
      ).trim()
    );

  }


  function normalizeIssueKey(
    value
  ) {

    return String(
      value ?? ""
    )
      .trim()
      .toUpperCase();

  }


  function getIssueKey(
    card
  ) {

    const field =
      (
        card.fields ||
        []
      ).find(
        field =>

          typeof field.value ===
            "string"

          &&

          isSnIssueKey(
            field.value
          )
      );


    return field
      ? normalizeIssueKey(
          field.value
        )
      : null;

  }


  function rememberPosition(
    card
  ) {

    if (
      !card ||
      typeof card.x !== "number" ||
      typeof card.y !== "number"
    ) {
      return;
    }


    lastPositions.set(

      String(
        card.id
      ),

      {

        x:
          card.x,

        y:
          card.y

      }

    );

  }


  function isInsideActiveBoard(
    card
  ) {

    return (

      card.x >=
        ACTIVE_BOARD.left

      &&

      card.x <=
        ACTIVE_BOARD.right

      &&

      card.y >=
        ACTIVE_BOARD.top

      &&

      card.y <=
        ACTIVE_BOARD.bottom

    );

  }


  function overlapPercent(
    card,
    column
  ) {

    const cardLeft =
      card.x -
      card.width / 2;


    const cardRight =
      card.x +
      card.width / 2;


    const overlapWidth =
      Math.max(

        0,

        Math.min(
          cardRight,
          column.right
        )

        -

        Math.max(
          cardLeft,
          column.left
        )

      );


    return (
      overlapWidth /
      card.width
    );

  }


  function detectColumn(
    card
  ) {

    const results =
      columns

        .map(
          column => ({

            status:
              column.status,

            overlap:
              overlapPercent(
                card,
                column
              )

          })
        )

        .sort(
          (a, b) =>
            b.overlap -
            a.overlap
        );


    return {

      winner:
        results[0],

      results

    };

  }


  // ==========================================================
  // EXISTING NATIVE SYNC
  // BACKEND POST
  // ==========================================================

  async function backendPost(
    path,
    body
  ) {

    const token =
      await miro.board
        .getIdToken();


    return await fetch(

      path,

      {

        method:
          "POST",

        headers: {

          "Content-Type":
            "application/json",

          "Authorization":
            "Bearer " +
            token

        },

        body:
          JSON.stringify(
            body
          )

      }

    );

  }


  // ==========================================================
  // EXISTING NATIVE SYNC
  // ROLLBACK
  // ==========================================================

  async function rollbackCard(
    issueKey,
    itemId,
    originalPosition
  ) {

    if (
      !originalPosition ||
      typeof originalPosition.x !== "number" ||
      typeof originalPosition.y !== "number"
    ) {

      console.error(
        "Cannot rollback card - original position missing:",
        issueKey,
        itemId
      );

      return false;

    }


    try {

      const card =
        await miro.board
          .getById(
            itemId
          );


      if (
        !card ||
        card.type !== "card"
      ) {

        console.error(
          "Cannot rollback card - card not found:",
          issueKey,
          itemId
        );

        return false;

      }


      rollbackTargets.set(

        String(
          itemId
        ),

        {

          x:
            originalPosition.x,

          y:
            originalPosition.y,

          expiresAt:
            Date.now() +
            5000

        }

      );


      card.x =
        originalPosition.x;

      card.y =
        originalPosition.y;


      await card.sync();


      lastPositions.set(

        String(
          itemId
        ),

        {

          x:
            originalPosition.x,

          y:
            originalPosition.y

        }

      );


      console.log(
        "Rollback complete:",
        issueKey
      );


      return true;


    } catch (
      error
    ) {

      console.error(
        "Rollback failed:",
        issueKey,
        error
      );


      rollbackTargets.delete(
        String(
          itemId
        )
      );


      return false;

    }

  }


  // ==========================================================
  // EXISTING NATIVE SYNC
  // REGISTER MAPPINGS
  // ==========================================================

  async function registerNewMappings(
    cards
  ) {

    const boardInfo =
      await miro.board
        .getInfo();


    const mappings =
      [];


    for (
      const card
      of cards || []
    ) {

      if (
        !card ||
        card.type !== "card"
      ) {
        continue;
      }


      const issueKey =
        getIssueKey(
          card
        );


      if (
        !issueKey
      ) {
        continue;
      }


      const itemId =
        String(
          card.id
        );


      const previousItemId =
        knownMappings.get(
          issueKey
        );


      if (
        previousItemId ===
        itemId
      ) {
        continue;
      }


      mappings.push({

        issueKey,
        itemId

      });

    }


    if (
      mappings.length === 0
    ) {

      return {

        ok:
          true,

        registered:
          0

      };

    }


    const response =
      await backendPost(

        "/register-cards",

        {

          boardId:
            boardInfo.id,

          cards:
            mappings

        }

      );


    const result =
      await response.json();


    if (
      response.ok &&
      result.ok
    ) {

      for (
        const mapping
        of mappings
      ) {

        knownMappings.set(
          mapping.issueKey,
          mapping.itemId
        );

      }

    }


    console.log(
      "Card mapping registration:",
      result
    );


    return result;

  }


  // ==========================================================
  // EXISTING NATIVE SYNC
  // BOARD SCAN
  // ==========================================================

  async function scanBoardCards(
    source
  ) {

    if (
      scanRunning
    ) {
      return;
    }


    scanRunning =
      true;


    try {

      const cards =
        await miro.board.get({

          type:
            "card"

        });


      for (
        const card
        of cards
      ) {

        const itemId =
          String(
            card.id
          );


        if (
          !lastPositions.has(
            itemId
          )
        ) {

          rememberPosition(
            card
          );

        }

      }


      const result =
        await registerNewMappings(
          cards
        );


      console.log(
        "SN card scan complete:",
        source,
        result
      );


    } catch (
      error
    ) {

      console.error(
        "SN card scan failed:",
        source,
        error
      );


    } finally {

      scanRunning =
        false;

    }

  }


  // ==========================================================
  // EXISTING APP ICON
  // +
  // CUSTOM STICKY PANEL
  // ==========================================================

  await miro.board.ui.on(

    "icon:click",

    async () => {

      console.log(
        "Jira to Miro position sync icon clicked"
      );


      try {

        await scanBoardCards(
          "icon-click"
        );


        const canOpenPanel =
          await miro.board.ui
            .canOpenPanel();


        if (
          !canOpenPanel
        ) {

          await miro.board
            .notifications
            .showError(
              "Could not open Jira/Miro panel."
            );

          return;

        }


        await miro.board.ui
          .openPanel({

            url:
              "/miro-panel"

          });


      } catch (
        error
      ) {

        console.error(
          error
        );

      }

    }

  );


  // ==========================================================
  // EXISTING NATIVE SYNC
  // MOVEMENT
  // ==========================================================

  async function evaluateMovedCard(
    itemId,
    originalPosition
  ) {

    const first =
      await miro.board
        .getById(
          itemId
        );


    if (
      !first ||
      first.type !== "card"
    ) {
      return;
    }


    const issueKey =
      getIssueKey(
        first
      );


    if (
      !issueKey
    ) {

      rememberPosition(
        first
      );

      return;

    }


    await registerNewMappings([
      first
    ]);


    if (
      !originalPosition
    ) {

      rememberPosition(
        first
      );

      return;

    }


    const positionChanged =

      Math.abs(
        originalPosition.x -
        first.x
      ) > 1

      ||

      Math.abs(
        originalPosition.y -
        first.y
      ) > 1;


    if (
      !positionChanged
    ) {

      rememberPosition(
        first
      );

      return;

    }


    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          300
        )
    );


    const second =
      await miro.board
        .getById(
          itemId
        );


    if (
      !second ||
      second.type !== "card"
    ) {
      return;
    }


    const stillMoving =

      Math.abs(
        first.x -
        second.x
      ) > 1

      ||

      Math.abs(
        first.y -
        second.y
      ) > 1;


    if (
      stillMoving
    ) {

      console.log(
        issueKey,
        "still moving - ignored"
      );

      return;

    }


    if (
      !isInsideActiveBoard(
        second
      )
    ) {

      rememberPosition(
        second
      );

      console.log(
        issueKey,
        "is parked outside active board"
      );

      return;

    }


    const {
      winner,
      results
    } =
      detectColumn(
        second
      );


    console.table(

      results.map(
        result => ({

          status:
            result.status,

          overlapPercent:
            Math.round(
              result.overlap *
              1000
            ) / 10

        })
      )

    );


    if (
      !winner ||
      winner.overlap < 0.60
    ) {

      rememberPosition(
        second
      );

      return;

    }


    let response;


    try {

      const boardInfo =
        await miro.board
          .getInfo();


      response =
        await backendPost(

          "/miro-to-jira",

          {

            boardId:
              boardInfo.id,

            issueKey,

            itemId:
              String(
                second.id
              ),

            desiredStatus:
              winner.status

          }

        );


    } catch (
      error
    ) {

      console.error(
        "Failed to reach Jira sync backend:",
        error
      );

      return;

    }


    let result;


    try {

      result =
        await response.json();


    } catch (
      error
    ) {

      console.error(
        "Backend returned invalid JSON:",
        error
      );

      return;

    }


    console.log(
      "Cloudflare/Jira result:",
      result
    );


    if (
      !response.ok ||
      result.ok === false
    ) {

      const rolledBack =
        await rollbackCard(

          issueKey,

          String(
            second.id
          ),

          originalPosition

        );


      let message;


      if (
        result.reason ===
        "TEST_AREA_REQUIRED"
      ) {

        message =
          "Test area must be filled in before moving to Functional review.";


      } else {

        message =
          issueKey +
          " could not be moved to " +
          winner.status +
          ". Jira rejected the status change.";

      }


      if (
        !rolledBack
      ) {

        message +=
          " Miro rollback also failed.";

      }


      try {

        await miro.board
          .notifications
          .showError(
            message
          );


      } catch (
        notificationError
      ) {

        console.error(
          notificationError
        );

      }


      return;

    }


    rememberPosition(
      second
    );

  }


  // ==========================================================
  // EXISTING NATIVE SYNC
  // UPDATE EVENT
  // ==========================================================

  const itemsUpdateHandler =
    async event => {

      console.log(
        "ITEM UPDATE EVENT RECEIVED:",
        event
      );


      for (
        const item
        of event.items || []
      ) {

        if (
          item.type !== "card"
        ) {
          continue;
        }


        const itemId =
          String(
            item.id
          );


        const rollbackTarget =
          rollbackTargets.get(
            itemId
          );


        if (
          rollbackTarget
        ) {

          const expired =
            Date.now() >
            rollbackTarget.expiresAt;


          if (
            expired
          ) {

            rollbackTargets.delete(
              itemId
            );


          } else {

            const hasCoordinates =

              typeof item.x === "number"

              &&

              typeof item.y === "number";


            const matchesRollback =

              !hasCoordinates

              ||

              (
                Math.abs(
                  item.x -
                  rollbackTarget.x
                ) <= 1

                &&

                Math.abs(
                  item.y -
                  rollbackTarget.y
                ) <= 1
              );


            if (
              matchesRollback
            ) {

              rollbackTargets.delete(
                itemId
              );


              lastPositions.set(

                itemId,

                {

                  x:
                    rollbackTarget.x,

                  y:
                    rollbackTarget.y

                }

              );


              continue;

            }


            rollbackTargets.delete(
              itemId
            );

          }

        }


        const existing =
          updateTimers.get(
            itemId
          );


        let originalPosition;


        if (
          existing
        ) {

          clearTimeout(
            existing.timer
          );


          originalPosition =
            existing.originalPosition;


        } else {

          originalPosition =
            lastPositions.get(
              itemId
            )

            ||

            {

              x:
                item.x,

              y:
                item.y

            };

        }


        const timer =
          setTimeout(

            () => {

              updateTimers.delete(
                itemId
              );


              evaluateMovedCard(
                itemId,
                originalPosition
              ).catch(
                console.error
              );

            },

            1200

          );


        updateTimers.set(

          itemId,

          {

            timer,
            originalPosition

          }

        );

      }

    };


  await miro.board.ui.on(
    "experimental:items:update",
    itemsUpdateHandler
  );


  // ##########################################################
  // ##########################################################
  //
  // CUSTOM CARD EXPERIMENT - MIRO -> JIRA STATUS SYNC - START
  //
  // FRAME-BASED CUSTOM CARDS
  //
  // New custom cards are Miro frames. Text/images are children
  // of the frame, so moving the frame moves the entire card in
  // one operation and the layout stays visually together.
  //
  // Legacy grouped custom cards are migrated to frames during
  // startup scan. The migration only targets groups containing
  // an exact SN-123 issue-key text plus the 320x120 card shape.
  //
  // Rules intentionally mirror native sync:
  // - 1.2s debounce + 300ms stable check
  // - 60% horizontal overlap
  // - parked outside active board = no Jira write
  // - Jira rejection => exact frame-position rollback
  // - Functional review gate is enforced by backend
  //
  // IMPORTANT:
  // New custom-card creation does NOT infer/change Jira status.
  // First observed position becomes baseline; Jira only changes
  // after a later user movement.
  //
  // SAFE REMOVAL:
  // Delete this whole block plus backend route
  // POST /custom-miro-to-jira and customCardMapKey().
  //
  // ##########################################################
  // ##########################################################

  const customSyncUpdateTimers =
    new Map();

  const customSyncLastPositions =
    new Map();

  const customSyncRollbackTargets =
    new Map();

  const customSyncKnownContainers =
    new Map();


  const customSyncRemoteMoveSuppressUntil =
    new Map();

  let customSyncPendingPollRunning =
    false;


  function customSyncPlainText(value) {

    return String(
      value || ""
    )
      .replace(
        /<[^>]*>/g,
        ""
      )
      .replace(
        /&nbsp;/g,
        " "
      )
      .replace(
        /&amp;/g,
        "&"
      )
      .trim();

  }


  function customSyncIsIssueKey(value) {

    // IMPORTANT: this code lives inside the Worker HTML template literal.
    // Two backslashes in Worker source serve one regex backslash to the browser.
    return /^SN-\\d+$/i.test(
      customSyncPlainText(
        value
      )
    );

  }


  async function customSyncGetAppCardSnapshot(appCardId) {

    const appCard =
      await miro.board.getById(
        appCardId
      );


    if (
      !appCard ||
      appCard.type !== "app_card"
    ) {
      return null;
    }


    const issueKeyField =
      (
        appCard.fields ||
        []
      ).find(
        field =>
          customSyncIsIssueKey(
            field?.value
          )
      );


    if (
      !issueKeyField
    ) {
      return null;
    }


    const issueKey =
      customSyncPlainText(
        issueKeyField.value
      ).toUpperCase();


    return {

      container:
        appCard,

      containerType:
        "app_card",

      items: [
        appCard
      ],

      issueKey,

      cardX:
        appCard.x,

      cardY:
        appCard.y,

      cardWidth:
        appCard.width,

      cardHeight:
        appCard.height

    };

  }


  async function customSyncGetFrameSnapshot(frameId) {

    const frame =
      await miro.board.getById(
        frameId
      );


    if (
      !frame ||
      frame.type !== "frame"
    ) {
      return null;
    }


    const items =
      await frame.getChildren();


    const keyText =
      items.find(
        item =>
          item.type === "text" &&
          customSyncIsIssueKey(
            item.content
          )
      );


    if (
      !keyText
    ) {
      return null;
    }


    const issueKey =
      customSyncPlainText(
        keyText.content
      ).toUpperCase();


    return {

      container:
        frame,

      containerType:
        "frame",

      items,
      issueKey,

      cardX:
        frame.x,

      cardY:
        frame.y,

      cardWidth:
        frame.width,

      cardHeight:
        frame.height

    };

  }


  async function customSyncGetLegacyGroupSnapshot(groupId) {

    const group =
      await miro.board.getById(
        groupId
      );


    if (
      !group ||
      group.type !== "group"
    ) {
      return null;
    }


    const items =
      await group.getItems();


    const keyText =
      items.find(
        item =>
          item.type === "text" &&
          customSyncIsIssueKey(
            item.content
          )
      );


    if (
      !keyText
    ) {
      return null;
    }


    const background =
      items.find(
        item =>
          item.type === "shape" &&
          typeof item.width === "number" &&
          typeof item.height === "number" &&
          Math.abs(
            item.width - 320
          ) < 5 &&
          Math.abs(
            item.height - 120
          ) < 5
      );


    if (
      !background
    ) {
      return null;
    }


    return {

      container:
        group,

      containerType:
        "group",

      items,

      issueKey:
        customSyncPlainText(
          keyText.content
        ).toUpperCase(),

      background,

      cardX:
        background.x,

      cardY:
        background.y,

      cardWidth:
        background.width,

      cardHeight:
        background.height

    };

  }


  async function customSyncGetContainerSnapshot(
    containerId
  ) {

    const item =
      await miro.board.getById(
        containerId
      );


    if (
      !item
    ) {
      return null;
    }


    if (
      item.type === "app_card"
    ) {

      return await customSyncGetAppCardSnapshot(
        containerId
      );

    }


    if (
      item.type === "frame"
    ) {

      return await customSyncGetFrameSnapshot(
        containerId
      );

    }


    if (
      item.type === "group"
    ) {

      return await customSyncGetLegacyGroupSnapshot(
        containerId
      );

    }


    return null;

  }


  function customSyncRememberSnapshot(snapshot) {

    if (
      !snapshot
    ) {
      return;
    }


    const containerId =
      String(
        snapshot.container.id
      );


    customSyncKnownContainers.set(
      containerId,
      snapshot.issueKey
    );


    customSyncLastPositions.set(
      containerId,
      {

        x:
          snapshot.cardX,

        y:
          snapshot.cardY

      }
    );

  }


  function customSyncIsInsideActiveBoard(snapshot) {

    return (

      snapshot.cardX >=
        ACTIVE_BOARD.left

      &&

      snapshot.cardX <=
        ACTIVE_BOARD.right

      &&

      snapshot.cardY >=
        ACTIVE_BOARD.top

      &&

      snapshot.cardY <=
        ACTIVE_BOARD.bottom

    );

  }


  function customSyncOverlapPercent(
    snapshot,
    column
  ) {

    const cardLeft =
      snapshot.cardX -
      snapshot.cardWidth / 2;


    const cardRight =
      snapshot.cardX +
      snapshot.cardWidth / 2;


    const overlapWidth =
      Math.max(

        0,

        Math.min(
          cardRight,
          column.right
        )

        -

        Math.max(
          cardLeft,
          column.left
        )

      );


    return (
      overlapWidth /
      snapshot.cardWidth
    );

  }


  function customSyncDetectColumn(snapshot) {

    const results =
      columns
        .map(
          column => ({

            status:
              column.status,

            overlap:
              customSyncOverlapPercent(
                snapshot,
                column
              )

          })
        )
        .sort(
          (a, b) =>
            b.overlap -
            a.overlap
        );


    return {

      winner:
        results[0],

      results

    };

  }


  async function customSyncRollbackContainer(
    snapshot,
    originalPosition
  ) {

    if (
      !snapshot ||
      !originalPosition
    ) {
      return false;
    }


    const containerId =
      String(
        snapshot.container.id
      );


    try {

      customSyncRollbackTargets.set(
        containerId,
        {

          x:
            originalPosition.x,

          y:
            originalPosition.y,

          expiresAt:
            Date.now() + 5000

        }
      );


      snapshot.container.x =
        originalPosition.x;

      snapshot.container.y =
        originalPosition.y;


      await snapshot.container.sync();


      const rolledBack =
        await customSyncGetContainerSnapshot(
          containerId
        );


      if (
        rolledBack
      ) {

        customSyncRememberSnapshot(
          rolledBack
        );

      }


      console.log(
        "CUSTOM CARD SYNC rollback complete:",
        snapshot.issueKey
      );


      return true;


    } catch (
      error
    ) {

      console.error(
        "CUSTOM CARD SYNC rollback failed:",
        snapshot.issueKey,
        error
      );


      customSyncRollbackTargets.delete(
        containerId
      );


      return false;

    }

  }


  async function customSyncEvaluateMovedContainer(
    containerId,
    originalPosition
  ) {

    const first =
      await customSyncGetContainerSnapshot(
        containerId
      );


    if (
      !first
    ) {
      return;
    }


    customSyncKnownContainers.set(
      String(
        containerId
      ),
      first.issueKey
    );


    // First observation is only a baseline. This prevents a
    // freshly-created custom card from changing Jira status.
    if (
      !originalPosition
    ) {

      customSyncRememberSnapshot(
        first
      );

      return;

    }


    const positionChanged =

      Math.abs(
        first.cardX -
        originalPosition.x
      ) > 1

      ||

      Math.abs(
        first.cardY -
        originalPosition.y
      ) > 1;


    if (
      !positionChanged
    ) {

      customSyncRememberSnapshot(
        first
      );

      return;

    }


    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          300
        )
    );


    const second =
      await customSyncGetContainerSnapshot(
        containerId
      );


    if (
      !second
    ) {
      return;
    }


    const stillMoving =

      Math.abs(
        first.cardX -
        second.cardX
      ) > 1

      ||

      Math.abs(
        first.cardY -
        second.cardY
      ) > 1;


    if (
      stillMoving
    ) {

      console.log(
        "CUSTOM CARD SYNC:",
        second.issueKey,
        "still moving - ignored"
      );

      return;

    }


    if (
      !customSyncIsInsideActiveBoard(
        second
      )
    ) {

      customSyncRememberSnapshot(
        second
      );


      console.log(
        "CUSTOM CARD SYNC:",
        second.issueKey,
        "parked outside active board"
      );


      return;

    }


    const {
      winner,
      results
    } =
      customSyncDetectColumn(
        second
      );


    console.table(

      results.map(
        result => ({

          customCard:
            second.issueKey,

          status:
            result.status,

          overlapPercent:
            Math.round(
              result.overlap *
              1000
            ) / 10

        })
      )

    );


    if (
      !winner ||
      winner.overlap < 0.60
    ) {

      customSyncRememberSnapshot(
        second
      );

      return;

    }


    let response;


    try {

      const boardInfo =
        await miro.board.getInfo();


      response =
        await backendPost(

          "/custom-miro-to-jira",

          {

            boardId:
              boardInfo.id,

            issueKey:
              second.issueKey,

            // Existing backend field name is retained for
            // compatibility. It now contains a frame ID.
            groupId:
              String(
                second.container.id
              ),

            desiredStatus:
              winner.status

          }

        );


    } catch (
      error
    ) {

      console.error(
        "CUSTOM CARD SYNC: backend request failed",
        error
      );

      return;

    }


    let result;


    try {

      result =
        await response.json();


    } catch (
      error
    ) {

      console.error(
        "CUSTOM CARD SYNC: backend returned invalid JSON",
        error
      );

      return;

    }


    console.log(
      "CUSTOM CARD SYNC Jira result:",
      result
    );


    if (
      !response.ok ||
      result.ok === false
    ) {

      const rolledBack =
        await customSyncRollbackContainer(
          second,
          originalPosition
        );


      let message;


      if (
        result.reason ===
        "TEST_AREA_REQUIRED"
      ) {

        message =
          "Test area must be filled in before moving to Functional review.";


      } else {

        message =
          second.issueKey +
          " could not be moved to " +
          winner.status +
          ". Jira rejected the status change.";

      }


      if (
        !rolledBack
      ) {

        message +=
          " Miro rollback also failed.";

      }


      try {

        await miro.board.notifications.showError(
          message
        );


      } catch (
        notificationError
      ) {

        console.error(
          notificationError
        );

      }


      return;

    }


    customSyncRememberSnapshot(
      second
    );

  }


  async function customSyncMigrateLegacyGroup(
    groupId
  ) {

    const snapshot =
      await customSyncGetLegacyGroupSnapshot(
        groupId
      );


    if (
      !snapshot
    ) {
      return null;
    }


    let releasedItems =
      null;

    let frame =
      null;

    const addedChildren =
      [];


    try {

      releasedItems =
        await snapshot.container.ungroup();


      const background =
        releasedItems.find(
          item =>
            String(
              item.id
            ) ===
            String(
              snapshot.background.id
            )
        )
        ||
        snapshot.background;


      const fillColor =
        background.style?.fillColor ||
        "#E8E8E8";


      frame =
        await miro.board.createFrame({

          title:
            "",

          style: {

            fillColor

          },

          x:
            background.x,

          y:
            background.y,

          width:
            320,

          height:
            120

        });


      for (
        const item
        of releasedItems
      ) {

        if (
          String(
            item.id
          ) ===
          String(
            background.id
          )
        ) {
          continue;
        }


        await frame.add(
          item
        );


        addedChildren.push(
          item
        );

      }


      await miro.board.remove(
        background
      );


      console.log(
        "CUSTOM CARD FRAME MIGRATION complete:",
        snapshot.issueKey,
        groupId,
        "->",
        frame.id
      );


      return await customSyncGetFrameSnapshot(
        String(
          frame.id
        )
      );


    } catch (
      error
    ) {

      console.error(
        "CUSTOM CARD FRAME MIGRATION failed:",
        snapshot.issueKey,
        groupId,
        error
      );


      // Best-effort rollback to the old group representation.
      try {

        if (
          frame
        ) {

          for (
            const child
            of addedChildren
          ) {

            try {

              await frame.remove(
                child
              );

            } catch (
              removeError
            ) {

              console.warn(
                "CUSTOM CARD FRAME MIGRATION child detach failed",
                removeError
              );

            }

          }


          try {

            await miro.board.remove(
              frame
            );

          } catch (
            frameRemoveError
          ) {

            console.warn(
              "CUSTOM CARD FRAME MIGRATION frame cleanup failed",
              frameRemoveError
            );

          }

        }


        if (
          releasedItems &&
          releasedItems.length > 1
        ) {

          await miro.board.group({

            items:
              releasedItems

          });

        }


      } catch (
        rollbackError
      ) {

        console.error(
          "CUSTOM CARD FRAME MIGRATION rollback failed:",
          snapshot.issueKey,
          rollbackError
        );

      }


      return null;

    }

  }


  async function customSyncScanExistingContainers(
    source
  ) {

    try {

      // ------------------------------------------------------
      // VIEWPORT SAFETY
      //
      // IMPORTANT: this recurring scan must be READ-ONLY in Miro.
      // Legacy group -> frame migration used to run here every
      // 10 seconds. Failed migrations could create/remove frames
      // repeatedly and make Miro reset/pan/zoom the user's view.
      //
      // Automatic legacy migration is therefore disabled.
      // Existing frame-based custom cards are discovered below.
      // No Miro item is created, removed, regrouped, reparented,
      // moved, selected, or zoomed by this scan.
      // ------------------------------------------------------


      // ------------------------------------------------------
      // Scan all frame-based custom cards and register them.
      // ------------------------------------------------------

      const appCards =
        await miro.board.get({
          type:
            "app_card"
        });


      const frames =
        await miro.board.get({
          type:
            "frame"
        });


      let registered = 0;

      const mappings =
        [];


      const groups =
        await miro.board.get({
          type:
            "group"
        });


      const customContainers = [
        ...frames,
        ...appCards,
        ...groups
      ];


      for (
        const container
        of customContainers
      ) {

        const snapshot =
          container.type === "app_card"
            ? await customSyncGetAppCardSnapshot(
                String(
                  container.id
                )
              )
            : container.type === "group"
              ? await customSyncGetLegacyGroupSnapshot(
                  String(
                    container.id
                  )
                )
              : await customSyncGetFrameSnapshot(
                  String(
                    container.id
                  )
                );


        if (
          !snapshot
        ) {
          continue;
        }


        customSyncRememberSnapshot(
          snapshot
        );


        mappings.push({

          issueKey:
            snapshot.issueKey,

          // Existing backend field name retained for
          // compatibility; value is now a frame ID.
          groupId:
            String(
              snapshot.container.id
            )

        });


        registered++;

      }


      // ------------------------------------------------------
      // KV-only registration. No Jira write.
      // ------------------------------------------------------

      if (
        mappings.length > 0
      ) {

        try {

          const boardInfo =
            await miro.board.getInfo();


          const response =
            await backendPost(

              "/register-custom-cards",

              {

                boardId:
                  boardInfo.id,

                cards:
                  mappings

              }

            );


          const result =
            await response.json();


          console.log(
            "CUSTOM CARD SYNC mapping registration:",
            source,
            result
          );


        } catch (
          mappingError
        ) {

          console.error(
            "CUSTOM CARD SYNC mapping registration failed:",
            source,
            mappingError
          );

        }

      }


      console.log(
        "CUSTOM CARD SYNC frame scan complete:",
        source,
        {
          registered,
          mappings: mappings.map(
            mapping => ({
              issueKey: mapping.issueKey,
              frameId: mapping.groupId
            })
          )
        }
      );


    } catch (
      error
    ) {

      console.error(
        "CUSTOM CARD SYNC frame scan failed:",
        source,
        error
      );

    }

  }


  const CUSTOM_SYNC_TARGET_X = {

    "todo":
      1990.8399296925127,

    "in progress":
      2923.455009676509,

    "functional review":
      3472.938505190192,

    "code review":
      3842.7526347392704,

    "approved":
      4350.752924110384,

    "merged":
      4983.202615160219

  };


  async function customSyncAckPendingMove(
    issueKey,
    requestId
  ) {

    const response =
      await backendPost(

        "/custom-card-ack",

        {
          issueKey,
          requestId
        }

      );


    if (
      !response.ok
    ) {

      console.warn(
        "CUSTOM CARD JIRA -> MIRO ack failed:",
        issueKey,
        await response.text()
      );

    }

  }


  async function customSyncApplyPendingMoves(
    source
  ) {

    if (
      customSyncPendingPollRunning
    ) {
      return;
    }


    const issueKeys =
      Array.from(
        new Set(
          customSyncKnownContainers.values()
        )
      );


    if (
      issueKeys.length === 0
    ) {

      console.log(
        "CUSTOM CARD JIRA -> MIRO pending poll:",
        source,
        {
          knownCards: 0,
          moves: []
        }
      );

      return;
    }


    customSyncPendingPollRunning =
      true;


    try {

      const response =
        await backendPost(

          "/custom-card-pending",

          {
            issueKeys
          }

        );


      const result =
        await response.json();


      if (
        !response.ok ||
        !result.ok
      ) {

        console.warn(
          "CUSTOM CARD JIRA -> MIRO pending poll failed:",
          source,
          result
        );

        return;

      }


      console.log(
        "CUSTOM CARD JIRA -> MIRO pending poll:",
        source,
        {
          knownCards: issueKeys.length,
          issueKeys,
          moves: result.moves || []
        }
      );


      for (
        const move
        of result.moves || []
      ) {

        const normalizedStatus =
          String(
            move.status || ""
          )
            .trim()
            .toLowerCase();


        const targetX =
          CUSTOM_SYNC_TARGET_X[
            normalizedStatus
          ];


        if (
          typeof targetX !== "number"
        ) {

          await customSyncAckPendingMove(
            move.issueKey,
            move.requestId
          );

          continue;

        }


        const containerEntry =
          Array.from(
            customSyncKnownContainers.entries()
          ).find(
            ([, issueKey]) =>
              issueKey === move.issueKey
          );


        if (
          !containerEntry
        ) {
          continue;
        }


        const containerId =
          containerEntry[0];


        const snapshot =
          await customSyncGetFrameSnapshot(
            containerId
          );


        // Only true frame-native cards are moved here.
        // Legacy groups remain pending until startup migration
        // converts them into frames.
        if (
          !snapshot ||
          snapshot.containerType !== "frame"
        ) {
          continue;
        }


        if (
          !customSyncIsInsideActiveBoard(
            snapshot
          )
        ) {

          await customSyncAckPendingMove(
            move.issueKey,
            move.requestId
          );

          continue;

        }


        const targetColumn =
          columns.find(
            column =>
              String(
                column.status
              )
                .trim()
                .toLowerCase() ===
              normalizedStatus
          );


        if (
          targetColumn &&
          customSyncOverlapPercent(
            snapshot,
            targetColumn
          ) >= 0.60
        ) {

          customSyncRememberSnapshot(
            snapshot
          );

          await customSyncAckPendingMove(
            move.issueKey,
            move.requestId
          );

          continue;

        }


        // Suppress all frame/child update events generated by
        // this Jira-driven SDK movement.
        customSyncRemoteMoveSuppressUntil.set(
          containerId,
          Date.now() + 4000
        );


        snapshot.container.x =
          targetX;


        await snapshot.container.sync();


        const movedSnapshot =
          await customSyncGetFrameSnapshot(
            containerId
          );


        if (
          movedSnapshot
        ) {

          customSyncRememberSnapshot(
            movedSnapshot
          );

        }


        await customSyncAckPendingMove(
          move.issueKey,
          move.requestId
        );


        console.log(
          "CUSTOM CARD JIRA -> MIRO moved frame via Web SDK:",
          move.issueKey,
          move.status,
          containerId
        );

      }


    } catch (
      error
    ) {

      console.error(
        "CUSTOM CARD JIRA -> MIRO pending poll error:",
        source,
        error
      );


    } finally {

      customSyncPendingPollRunning =
        false;

    }

  }


  const customSyncItemsUpdateHandler =
    async event => {

      const candidateContainerIds =
        new Set();


      for (
        const item
        of event.items || []
      ) {

        if (
          item.type === "frame" ||
          item.type === "app_card"
        ) {

          candidateContainerIds.add(
            String(
              item.id
            )
          );


        } else if (
          item.parentId
        ) {

          candidateContainerIds.add(
            String(
              item.parentId
            )
          );


        } else if (
          item.type === "group"
        ) {

          // Legacy fallback during migration.
          candidateContainerIds.add(
            String(
              item.id
            )
          );


        } else if (
          item.groupId
        ) {

          // Legacy fallback during migration.
          candidateContainerIds.add(
            String(
              item.groupId
            )
          );

        }

      }


      for (
        const containerId
        of candidateContainerIds
      ) {

        const suppressUntil =
          customSyncRemoteMoveSuppressUntil.get(
            containerId
          );


        if (
          suppressUntil &&
          Date.now() <= suppressUntil
        ) {

          continue;

        }


        if (
          suppressUntil
        ) {

          customSyncRemoteMoveSuppressUntil.delete(
            containerId
          );

        }


        const rollbackTarget =
          customSyncRollbackTargets.get(
            containerId
          );


        if (
          rollbackTarget
        ) {

          if (
            Date.now() <=
            rollbackTarget.expiresAt
          ) {

            customSyncRollbackTargets.delete(
              containerId
            );

            continue;

          }


          customSyncRollbackTargets.delete(
            containerId
          );

        }


        const existingTimer =
          customSyncUpdateTimers.get(
            containerId
          );


        let originalPosition;


        if (
          existingTimer
        ) {

          clearTimeout(
            existingTimer.timer
          );


          originalPosition =
            existingTimer.originalPosition;


        } else {

          originalPosition =
            customSyncLastPositions.get(
              containerId
            ) || null;

        }


        const timer =
          setTimeout(

            () => {

              customSyncUpdateTimers.delete(
                containerId
              );


              customSyncEvaluateMovedContainer(
                containerId,
                originalPosition
              ).catch(
                console.error
              );

            },

            1200

          );


        customSyncUpdateTimers.set(
          containerId,
          {
            timer,
            originalPosition
          }
        );

      }

    };


  await miro.board.ui.on(
    "experimental:items:update",
    customSyncItemsUpdateHandler
  );


  console.log(
    "CUSTOM CARD EXPERIMENT grouped classic-card Miro -> Jira status sync ACTIVE"
  );


  console.log(
    "CUSTOM CARD EXPERIMENT Jira -> Miro grouped-card movement ACTIVE"
  );


  // ##########################################################
  // ##########################################################
  //
  // CUSTOM CARD EXPERIMENT - MIRO -> JIRA STATUS SYNC - END
  //
  // ##########################################################
  // ##########################################################


  // ==========================================================
  // EXISTING NATIVE SYNC
  // STARTUP
  // ==========================================================

  await scanBoardCards(
    "startup"
  );


  setInterval(

    () => {

      scanBoardCards(
        "periodic-10s"
      ).catch(
        console.error
      );

    },

    10000

  );


  console.log(
    "Permanent ALL-SN Miro -> Jira monitor ACTIVE"
  );

  console.log(
    "Automatic SN card scan every 10 seconds ACTIVE"
  );

  console.log(
    "Exact-position Jira rejection rollback ACTIVE"
  );

  console.log(
    "Functional review Test area requirement ACTIVE: customfield_10832"
  );


  // ##########################################################
  // ##########################################################
  //
  // CUSTOM CARD EXPERIMENT - START
  //
  // EXISTING SN-30 VISUAL TEST
  //
  // ##########################################################
  // ##########################################################


  const CUSTOM_CARD_TEST = {

    enabled:
      true,

    issueKey:
      "SN-30",

    defaultX:
      2923.455009676509,

    defaultY:
      1958.8557552319453,

    width:
      320,

    height:
      120

  };


  const CUSTOM_CARD_WORK_TYPE_COLORS = {

    bug:
      "#FD9DE8",

    improvement:
      "#B7D3FE",

    spike:
      "#FFEB7F",

    "new feature":
      "#D7F2AC",

    "hotfix candidate":
      "#FFB677",

    "task/config/doc/test":
      "#89E8E0"

  };


  function customCardColorForWorkType(
    workType
  ) {

    const normalizedWorkType =
      String(
        workType ?? ""
      )
        .trim()
        .toLowerCase();


    return (
      CUSTOM_CARD_WORK_TYPE_COLORS[
        normalizedWorkType
      ]
      ||
      "#E8E8E8"
    );

  }


  function customCardTitleFontSize(
    value
  ) {

    const length =
      String(
        value || ""
      )
        .trim()
        .length;


    if (
      length <= 20
    ) {
      return 20;
    }

    if (
      length <= 35
    ) {
      return 17;
    }

    if (
      length <= 50
    ) {
      return 15;
    }

    if (
      length <= 70
    ) {
      return 13;
    }


    return 11;

  }


  function customCardPlainText(
    value
  ) {

    return String(
      value || ""
    )
      .replace(
        /<[^>]*>/g,
        ""
      )
      .replace(
        /&nbsp;/g,
        " "
      )
      .replace(
        /&amp;/g,
        "&"
      )
      .trim();

  }


  function customCardEscapeHtml(
    value
  ) {

    return String(
      value ?? ""
    )
      .replace(
        /&/g,
        "&amp;"
      )
      .replace(
        /</g,
        "&lt;"
      )
      .replace(
        />/g,
        "&gt;"
      )
      .replace(
        /"/g,
        "&quot;"
      )
      .replace(
        /'/g,
        "&#039;"
      );

  }


  async function customCardReadJira(
    issueKey
  ) {

    const response =
      await backendPost(

        "/jira-card-data",

        {
          issueKey
        }

      );


    const jira =
      await response.json();


    if (
      !response.ok ||
      !jira.ok
    ) {

      throw new Error(
        "CUSTOM CARD Jira read failed: " +
        JSON.stringify(
          jira
        )
      );

    }


    return jira;

  }


  async function customCardFindExisting(
    issueKey
  ) {

    const texts =
      await miro.board.get({
        type:
          "text"
      });


    const keyText =
      texts.find(
        item =>

          customCardPlainText(
            item.content
          ).toUpperCase() ===
            issueKey.toUpperCase()

          &&

          (
            item.parentId ||
            item.groupId
          )
      );


    if (
      !keyText
    ) {
      return null;
    }


    const containerId =
      keyText.parentId ||
      keyText.groupId;


    const container =
      await miro.board.getById(
        containerId
      );


    if (
      !container
    ) {
      return null;
    }


    if (
      container.type === "frame"
    ) {

      const items =
        await container.getChildren();


      return {

        frame:
          container,

        items,
        keyText

      };

    }


    // Legacy group: startup migration normally converts it.
    // Returning null avoids reintroducing group-based cards.
    return null;

  }


  async function customCardCreatePriorityIcon(
    jira,
    x,
    y
  ) {

    if (
      !jira.priorityIconUrl
    ) {
      return null;
    }


    try {

      return await miro.board.createImage({

        title:
          "Jira priority: " +
          jira.priority,

        url:
          jira.priorityIconUrl,

        x,

        y,

        width:
          14

      });


    } catch (
      error
    ) {

      console.warn(
        "CUSTOM CARD EXPERIMENT: priority icon failed",
        error
      );


      return null;

    }

  }


  async function customCardCreateNew(
    jira
  ) {

    const cardX =
      CUSTOM_CARD_TEST.defaultX;

    const cardY =
      CUSTOM_CARD_TEST.defaultY;


    const cardColor =
      customCardColorForWorkType(
        jira.workType
      );


    const frame =
      await miro.board.createFrame({

        title:
          "",

        style: {

          fillColor:
            cardColor

        },

        x:
          cardX,

        y:
          cardY,

        width:
          CUSTOM_CARD_TEST.width,

        height:
          CUSTOM_CARD_TEST.height

      });


    const createdItems =
      [];


    try {

      const issueKeyText =
        await miro.board.createText({

          content:
            "<strong>" +
            customCardEscapeHtml(
              jira.issueKey
            ) +
            "</strong>",

          x:
            cardX - 122,

          y:
            cardY - 45,

          width:
            60,

          style: {

            color:
              "#1A1A1A",

            fillColor:
              "transparent",

            fontFamily:
              "arial",

            fontSize:
              10,

            textAlign:
              "left"

          }

        });


      createdItems.push(
        issueKeyText
      );


      const jiraLinkText =
        await miro.board.createText({

          content:
            '<a href="' +
            customCardEscapeHtml(
              jira.browseUrl
            ) +
            '">Jira ↗</a>',

          x:
            cardX + 112,

          y:
            cardY - 45,

          width:
            70,

          style: {

            color:
              "#1A1A1A",

            fillColor:
              "transparent",

            fontFamily:
              "arial",

            fontSize:
              10,

            textAlign:
              "right"

          }

        });


      createdItems.push(
        jiraLinkText
      );


      const summaryText =
        await miro.board.createText({

          content:
            "<strong>" +
            customCardEscapeHtml(
              jira.summary
            ) +
            "</strong>",

          x:
            cardX,

          y:
            cardY - 10,

          width:
            280,

          style: {

            color:
              "#1A1A1A",

            fillColor:
              "transparent",

            fontFamily:
              "arial",

            fontSize:
              customCardTitleFontSize(
                jira.summary
              ),

            textAlign:
              "left"

          }

        });


      createdItems.push(
        summaryText
      );


      const priorityIcon =
        await customCardCreatePriorityIcon(

          jira,

          cardX - 138,

          cardY + 42

        );


      if (
        priorityIcon
      ) {

        createdItems.push(
          priorityIcon
        );

      }


      const priorityText =
        await miro.board.createText({

          content:
            customCardEscapeHtml(
              jira.priority
            ),

          x:
            cardX - 72,

          y:
            cardY + 42,

          width:
            94,

          style: {

            color:
              "#1A1A1A",

            fillColor:
              "transparent",

            fontFamily:
              "arial",

            fontSize:
              10,

            textAlign:
              "left"

          }

        });


      createdItems.push(
        priorityText
      );


      const assigneeText =
        await miro.board.createText({

          content:
            customCardEscapeHtml(
              jira.assignee
            ),

          x:
            cardX + 62,

          y:
            cardY + 42,

          width:
            160,

          style: {

            color:
              "#1A1A1A",

            fillColor:
              "transparent",

            fontFamily:
              "arial",

            fontSize:
              10,

            textAlign:
              "right"

          }

        });


      createdItems.push(
        assigneeText
      );


      for (
        const item
        of createdItems
      ) {

        await frame.add(
          item
        );

      }


      return {

        frame,

        items:
          createdItems

      };


    } catch (
      error
    ) {

      console.error(
        "CUSTOM CARD EXPERIMENT frame creation failed",
        error
      );


      for (
        const item
        of createdItems
      ) {

        try {

          await miro.board.remove(
            item
          );

        } catch {}

      }


      try {

        await miro.board.remove(
          frame
        );

      } catch {}


      throw error;

    }

  }


  async function customCardUpgradeExisting(
    existing,
    jira
  ) {

    const frame =
      existing.frame;


    if (
      !frame ||
      frame.type !== "frame"
    ) {

      throw new Error(
        "CUSTOM CARD frame not found"
      );

    }


    const items =
      await frame.getChildren();


    const textItems =
      items.filter(
        item =>
          item.type === "text"
      );


    const imageItems =
      items.filter(
        item =>
          item.type === "image"
      );


    const cardX =
      frame.x;

    const cardY =
      frame.y;


    frame.style.fillColor =
      customCardColorForWorkType(
        jira.workType
      );


    await frame.sync();


    const issueKeyText =
      textItems.find(
        item =>
          customCardPlainText(
            item.content
          ).toUpperCase() ===
          jira.issueKey.toUpperCase()
      );


    const jiraLinkText =
      textItems.find(
        item =>
          customCardPlainText(
            item.content
          ).startsWith(
            "Jira"
          )
      );


    const priorityText =
      textItems.find(
        item =>
          item !== issueKeyText &&
          item !== jiraLinkText &&
          item.y > 70 &&
          item.x < 160
      );


    const assigneeText =
      textItems.find(
        item =>
          item !== issueKeyText &&
          item !== jiraLinkText &&
          item.y > 70 &&
          item.x > 160
      );


    const summaryText =
      textItems.find(
        item =>
          item !== issueKeyText &&
          item !== jiraLinkText &&
          item !== priorityText &&
          item !== assigneeText
      );


    if (
      issueKeyText
    ) {

      issueKeyText.content =
        "<strong>" +
        customCardEscapeHtml(
          jira.issueKey
        ) +
        "</strong>";

      await issueKeyText.sync();

    }


    if (
      summaryText
    ) {

      summaryText.content =
        "<strong>" +
        customCardEscapeHtml(
          jira.summary
        ) +
        "</strong>";

      summaryText.style.fontSize =
        customCardTitleFontSize(
          jira.summary
        );

      await summaryText.sync();

    }


    if (
      priorityText
    ) {

      priorityText.content =
        customCardEscapeHtml(
          jira.priority
        );

      await priorityText.sync();

    }


    if (
      assigneeText
    ) {

      assigneeText.content =
        customCardEscapeHtml(
          jira.assignee
        );

      await assigneeText.sync();

    }


    if (
      jiraLinkText
    ) {

      jiraLinkText.content =
        '<a href="' +
        customCardEscapeHtml(
          jira.browseUrl
        ) +
        '">Jira ↗</a>';

      await jiraLinkText.sync();

    }


    for (
      const oldImage
      of imageItems
    ) {

      try {

        await miro.board.remove(
          oldImage
        );

      } catch (
        error
      ) {

        console.warn(
          "Could not remove old priority icon",
          error
        );

      }

    }


    const priorityIcon =
      await customCardCreatePriorityIcon(

        jira,

        cardX - 138,

        cardY + 42

      );


    if (
      priorityIcon
    ) {

      await frame.add(
        priorityIcon
      );

    }


    return {

      frame,

      items:
        await frame.getChildren()

    };

  }


  async function customCardCreateOrUpdate() {

    if (
      !CUSTOM_CARD_TEST.enabled
    ) {
      return;
    }


    try {

      console.log(
        "CUSTOM CARD EXPERIMENT: reading Jira data for",
        CUSTOM_CARD_TEST.issueKey
      );


      const jira =
        await customCardReadJira(
          CUSTOM_CARD_TEST.issueKey
        );


      const existing =
        await customCardFindExisting(
          jira.issueKey
        );


      let result;


      if (
        existing
      ) {

        result =
          await customCardUpgradeExisting(
            existing,
            jira
          );


      } else {

        result =
          await customCardCreateNew(
            jira
          );

      }


      console.log(
        "CUSTOM CARD EXPERIMENT: create/update complete",
        jira.issueKey
      );


      return result;


    } catch (
      error
    ) {

      console.error(
        "CUSTOM CARD EXPERIMENT: create/update failed",
        error
      );

    }

  }


  await customCardCreateOrUpdate();


  // ==========================================================
  // CUSTOM CARD EXPERIMENT
  // POST-CREATE DISCOVERY + JIRA -> MIRO PENDING POLL START
  //
  // Run discovery AFTER custom-card create/update/migration so
  // frame mappings exist before Jira -> Miro pending moves poll.
  // No Jira issues or Miro cards are created by this scan.
  // ==========================================================

  await customSyncScanExistingContainers(
    "post-custom-card-create"
  );


  // ==========================================================
  // MULTI-USER SAFETY
  //
  // Jira -> Miro movement is now handled server-side by the
  // Cloudflare Worker when the Jira webhook arrives.
  //
  // Therefore this Miro client does NOT:
  // - poll for Jira-driven moves
  // - move frames because of Jira status changes
  // - run recurring custom-card discovery/migration loops
  //
  // Each open Miro user only handles their local app UI and
  // drag -> Jira flow. Startup discovery above is read-only in
  // Miro and idempotently refreshes custom-card:* KV mappings.
  // ==========================================================

  console.log(
    "CUSTOM CARD MULTI-USER MODE ACTIVE: Jira -> Miro is server-side; client polling disabled"
  );


  console.log(
    "CUSTOM CARD EXPERIMENT ACTIVE:",
    CUSTOM_CARD_TEST.issueKey
  );


  // ##########################################################
  // ##########################################################
  //
  // CUSTOM CARD EXPERIMENT - END
  //
  // ##########################################################
  // ##########################################################


})();

</script>

</body>

</html>
`;


      return new Response(

        html,

        {

          status:
            200,

          headers: {

            "Content-Type":
              "text/html; charset=UTF-8",

            "Cache-Control":
              "no-store"

          }

        }

      );

    }


    // ##########################################################
    // ##########################################################
    //
    // CUSTOM CARD EXPERIMENT - STICKY TO JIRA - START
    //
    // MIRO CONTROL PANEL
    //
    // ##########################################################
    // ##########################################################


    if (
      request.method === "GET" &&
      url.pathname === "/miro-panel"
    ) {

      const html = `
<!DOCTYPE html>

<html>

<head>

  <meta charset="UTF-8" />

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  />

  <title>
    Jira / Miro
  </title>

  <script
    src="https://miro.com/app/static/sdk/v2/miro.js">
  </script>


  <style>

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 20px;
      font-family: Arial, sans-serif;
      color: #1a1a1a;
      background: #ffffff;
    }

    h2 {
      margin: 0 0 8px 0;
      font-size: 20px;
    }

    p {
      margin: 0 0 16px 0;
      font-size: 13px;
      line-height: 1.45;
    }

    .card {
      border: 1px solid #e6e6e6;
      border-radius: 8px;
      padding: 16px;
    }

    button {
      width: 100%;
      min-height: 42px;
      border: 0;
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      background: #4262ff;
      color: #ffffff;
    }

    button:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .small {
      margin-top: 10px;
      color: #666666;
      font-size: 12px;
      line-height: 1.4;
    }

    #status {
      display: none;
      margin-top: 14px;
      padding: 10px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
    }

    #status.info {
      display: block;
      background: #eef2ff;
    }

    #status.success {
      display: block;
      background: #e8f7ed;
    }

    #status.error {
      display: block;
      background: #ffeceb;
    }

  </style>

</head>


<body>

  <h2>
    Jira ↔ Miro
  </h2>


  <p>
    Select exactly one sticky note on the board.
  </p>


  <div class="card">

    <button id="convertButton">
      Convert selected sticky to Jira
    </button>


    <div class="small">
      Work type is determined from the sticky colour.
      Tags and assignee are ignored for now.
    </div>


    <div id="status"></div>

  </div>


<script>

(async function () {

  const CONVERSION_METADATA_KEY =
    "rendraStickyJiraConversionV1";


  const CUSTOM_CARD_WORK_TYPE_COLORS = {

    bug:
      "#FD9DE8",

    improvement:
      "#B7D3FE",

    spike:
      "#FFEB7F",

    "new feature":
      "#D7F2AC",

    "hotfix candidate":
      "#FFB677",

    "task/config/doc/test":
      "#89E8E0"

  };


  function customCardColorForWorkType(
    workType
  ) {

    const normalizedWorkType =
      String(
        workType ?? ""
      )
        .trim()
        .toLowerCase();


    return (
      CUSTOM_CARD_WORK_TYPE_COLORS[
        normalizedWorkType
      ]
      ||
      "#E8E8E8"
    );

  }


  const CUSTOM_STICKY_COLOR_TO_WORK_TYPE = {

    light_pink:
      "Bug",

    pink:
      "Bug",

    violet:
      "Bug",

    light_blue:
      "Improvement",

    blue:
      "Improvement",

    dark_blue:
      "Improvement",

    gray:
      "Improvement",

    light_yellow:
      "Spike",

    yellow:
      "Spike",

    light_green:
      "New Feature",

    green:
      "New Feature",

    dark_green:
      "New Feature",

    orange:
      "Hotfix candidate",

    red:
      "Hotfix candidate",

    cyan:
      "Task/config/doc/test"

  };


  const convertButton =
    document.getElementById(
      "convertButton"
    );


  const statusElement =
    document.getElementById(
      "status"
    );


  function setStatus(
    message,
    type
  ) {

    statusElement.className =
      type || "info";

    statusElement.textContent =
      message;

  }


  function escapeHtml(
    value
  ) {

    return String(
      value ?? ""
    )
      .replace(
        /&/g,
        "&amp;"
      )
      .replace(
        /</g,
        "&lt;"
      )
      .replace(
        />/g,
        "&gt;"
      )
      .replace(
        /"/g,
        "&quot;"
      )
      .replace(
        /'/g,
        "&#039;"
      );

  }


  function plainText(
    value
  ) {

    const holder =
      document.createElement(
        "div"
      );


    holder.innerHTML =
      String(
        value || ""
      );


    return String(
      holder.textContent || ""
    )
      .replace(
        /\\\\s+/g,
        " "
      )
      .trim();

  }


  function titleFontSize(
    value
  ) {

    const length =
      String(
        value || ""
      )
        .trim()
        .length;


    if (
      length <= 20
    ) {
      return 20;
    }

    if (
      length <= 35
    ) {
      return 17;
    }

    if (
      length <= 50
    ) {
      return 15;
    }

    if (
      length <= 70
    ) {
      return 13;
    }


    return 11;

  }


  function workTypeFromSticky(
    sticky
  ) {

    const miroColor =
      String(
        sticky.style &&
        sticky.style.fillColor
          ? sticky.style.fillColor
          : ""
      )
        .trim()
        .toLowerCase();


    return (
      CUSTOM_STICKY_COLOR_TO_WORK_TYPE[
        miroColor
      ]
      ||
      "Bug"
    );

  }


  async function backendPost(
    path,
    body
  ) {

    const token =
      await miro.board
        .getIdToken();


    return await fetch(

      path,

      {

        method:
          "POST",

        headers: {

          "Content-Type":
            "application/json",

          "Authorization":
            "Bearer " +
            token

        },

        body:
          JSON.stringify(
            body
          )

      }

    );

  }


  async function readJiraIssue(
    issueKey
  ) {

    const response =
      await backendPost(

        "/jira-card-data",

        {
          issueKey
        }

      );


    const result =
      await response.json();


    if (
      !response.ok ||
      !result.ok
    ) {

      throw new Error(
        "Could not read Jira issue: " +
        JSON.stringify(
          result
        )
      );

    }


    return result;

  }


  async function createPriorityIcon(
    jira,
    x,
    y
  ) {

    if (
      !jira.priorityIconUrl
    ) {
      return null;
    }


    try {

      return await miro.board.createImage({

        title:
          "Jira priority: " +
          jira.priority,

        url:
          jira.priorityIconUrl,

        x,

        y,

        width:
          14

      });


    } catch (
      error
    ) {

      console.warn(
        "CUSTOM CARD STICKY CONVERSION: priority icon failed",
        error
      );


      return null;

    }

  }


  async function createCustomCardAt(
    jira,
    x,
    y
  ) {

    const width =
      320;

    const height =
      120;


    const cardColor =
      customCardColorForWorkType(
        jira.workType
      );


    const createdItems =
      [];


    let group =
      null;


    try {

      const background =
        await miro.board.createShape({

          shape:
            "rectangle",

          x,

          y,

          width,

          height,

          style: {

            fillColor:
              cardColor,

            fillOpacity:
              1,

            borderOpacity:
              0,

            borderWidth:
              0

          }

        });


      createdItems.push(
        background
      );


      const issueKeyText =
        await miro.board.createText({

          content:
            "<strong>" +
            escapeHtml(
              jira.issueKey
            ) +
            "</strong>",

          x:
            x - 122,

          y:
            y - 45,

          width:
            60,

          style: {

            color:
              "#1A1A1A",

            fillColor:
              "transparent",

            fontFamily:
              "arial",

            fontSize:
              10,

            textAlign:
              "left"

          }

        });


      createdItems.push(
        issueKeyText
      );


      const jiraLinkText =
        await miro.board.createText({

          content:
            '<a href="' +
            escapeHtml(
              jira.browseUrl
            ) +
            '">Jira ↗</a>',

          linkedTo:
            jira.browseUrl,

          x:
            x + 112,

          y:
            y - 45,

          width:
            70,

          style: {

            color:
              "#1A1A1A",

            fillColor:
              "transparent",

            fontFamily:
              "arial",

            fontSize:
              10,

            textAlign:
              "right"

          }

        });


      createdItems.push(
        jiraLinkText
      );


      const summaryText =
        await miro.board.createText({

          content:
            "<strong>" +
            escapeHtml(
              jira.summary
            ) +
            "</strong>",

          x,

          y:
            y - 10,

          width:
            280,

          style: {

            color:
              "#1A1A1A",

            fillColor:
              "transparent",

            fontFamily:
              "arial",

            fontSize:
              titleFontSize(
                jira.summary
              ),

            textAlign:
              "left"

          }

        });


      createdItems.push(
        summaryText
      );


      const priorityIcon =
        await createPriorityIcon(

          jira,

          x - 138,

          y + 42

        );


      if (
        priorityIcon
      ) {

        createdItems.push(
          priorityIcon
        );

      }


      const priorityText =
        await miro.board.createText({

          content:
            escapeHtml(
              jira.priority
            ),

          x:
            x - 72,

          y:
            y + 42,

          width:
            94,

          style: {

            color:
              "#1A1A1A",

            fillColor:
              "transparent",

            fontFamily:
              "arial",

            fontSize:
              10,

            textAlign:
              "left"

          }

        });


      createdItems.push(
        priorityText
      );


      const assigneeText =
        await miro.board.createText({

          content:
            escapeHtml(
              jira.assignee
            ),

          x:
            x + 62,

          y:
            y + 42,

          width:
            160,

          style: {

            color:
              "#1A1A1A",

            fillColor:
              "transparent",

            fontFamily:
              "arial",

            fontSize:
              10,

            textAlign:
              "right"

          }

        });


      createdItems.push(
        assigneeText
      );


      group =
        await miro.board.group({

          items:
            createdItems

        });


      try {

        const boardInfo =
          await miro.board.getInfo();


        const registrationResponse =
          await backendPost(

            "/register-custom-cards",

            {

              boardId:
                boardInfo.id,

              cards: [

                {
                  issueKey:
                    jira.issueKey,

                  groupId:
                    String(
                      group.id
                    )
                }

              ]

            }

          );


        if (
          !registrationResponse.ok
        ) {

          console.warn(
            "CUSTOM CARD STICKY CONVERSION: grouped card mapping registration failed",
            await registrationResponse.text()
          );

        }


      } catch (
        registrationError
      ) {

        console.warn(
          "CUSTOM CARD STICKY CONVERSION: grouped card mapping registration failed",
          registrationError
        );

      }


      return {

        frame:
          group,

        items:
          createdItems

      };


    } catch (
      error
    ) {

      console.error(
        "CUSTOM CARD STICKY CONVERSION: grouped card creation failed, cleaning up",
        error
      );


      if (
        group
      ) {

        try {
          await group.ungroup();
        } catch {}

      }


      for (
        const item
        of createdItems
      ) {

        try {

          await miro.board.remove(
            item
          );

        } catch {}

      }


      throw error;

    }

  }


  // ========================================================
  // STICKY -> CUSTOM CARD POSITION
  //
  // A sticky that lives inside a Miro frame does NOT expose
  // canvas coordinates. Its x/y are relative to the parent.
  // Convert the position to absolute canvas coordinates before
  // creating the replacement custom-card frame.
  // ========================================================

  async function getCanvasPosition(
    item
  ) {

    const x =
      Number(
        item?.x
      );

    const y =
      Number(
        item?.y
      );


    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {

      throw new Error(
        "Selected sticky has invalid Miro coordinates."
      );

    }


    if (
      !item.parentId ||
      item.relativeTo === "canvas_center"
    ) {

      return {
        x,
        y
      };

    }


    const parent =
      await miro.board.getById(
        item.parentId
      );


    if (
      !parent
    ) {

      throw new Error(
        "Could not resolve the selected sticky's parent frame."
      );

    }


    const parentCanvasPosition =
      await getCanvasPosition(
        parent
      );


    if (
      item.relativeTo === "parent_top_left"
    ) {

      const parentWidth =
        Number(
          parent.width
        );

      const parentHeight =
        Number(
          parent.height
        );


      if (
        !Number.isFinite(parentWidth) ||
        !Number.isFinite(parentHeight)
      ) {

        throw new Error(
          "Could not resolve the parent frame dimensions."
        );

      }


      return {

        x:
          parentCanvasPosition.x -
          parentWidth / 2 +
          x,

        y:
          parentCanvasPosition.y -
          parentHeight / 2 +
          y

      };

    }


    if (
      item.relativeTo === "parent_center"
    ) {

      return {

        x:
          parentCanvasPosition.x +
          x,

        y:
          parentCanvasPosition.y +
          y

      };

    }


    // Fallback for unexpected Miro positioning modes.
    return {
      x,
      y
    };

  }


  async function convertSelectedSticky() {

    convertButton.disabled =
      true;


    try {

      setStatus(
        "Checking selected sticky…",
        "info"
      );


      const selection =
        await miro.board
          .getSelection();


      if (
        selection.length !== 1
      ) {

        throw new Error(
          "Select exactly one sticky note before converting."
        );

      }


      const sticky =
        selection[0];


      if (
        !sticky ||
        sticky.type !== "sticky_note"
      ) {

        throw new Error(
          "The selected item is not a sticky note."
        );

      }


      const summary =
        plainText(
          sticky.content
        );


      if (
        !summary
      ) {

        throw new Error(
          "The selected sticky note has no text."
        );

      }


      const stickyColor =
        String(
          sticky.style &&
          sticky.style.fillColor
            ? sticky.style.fillColor
            : ""
        );


      const detectedWorkType =
        workTypeFromSticky(
          sticky
        );


      console.log(
        "CUSTOM CARD STICKY CONVERSION:",
        {

          stickyId:
            sticky.id,

          stickyColor,

          detectedWorkType,

          summary

        }
      );


      let conversionState;


      try {

        conversionState =
          await sticky.getMetadata(
            CONVERSION_METADATA_KEY
          );


      } catch (
        metadataError
      ) {

        console.warn(
          "Could not read sticky conversion metadata",
          metadataError
        );


        conversionState =
          undefined;

      }


      if (
        conversionState &&
        conversionState.issueKey &&
        conversionState.stage ===
          "card-created"
      ) {

        setStatus(
          conversionState.issueKey +
          " was already converted. Removing original sticky…",
          "info"
        );


        await miro.board.remove(
          sticky
        );


        setStatus(
          conversionState.issueKey +
          " converted successfully.",
          "success"
        );


        return;

      }


      let issueKey =

        conversionState &&
        conversionState.issueKey

          ? String(
              conversionState.issueKey
            )

          : null;


      if (
        !issueKey
      ) {

        setStatus(
          "Creating Jira " +
          detectedWorkType +
          "…",
          "info"
        );


        const createResponse =
          await backendPost(

            "/sticky-to-jira",

            {

              summary,

              workType:
                detectedWorkType

            }

          );


        const createResult =
          await createResponse.json();


        if (
          !createResponse.ok ||
          !createResult.ok
        ) {

          const readableError =

            createResult.reason

            ||

            (
              typeof createResult.error === "string"
                ? createResult.error
                : JSON.stringify(
                    createResult.error,
                    null,
                    2
                  )
            )

            ||

            JSON.stringify(
              createResult,
              null,
              2
            );


          throw new Error(
            readableError
          );

        }


        issueKey =
          createResult.issueKey;


        await sticky.setMetadata(

          CONVERSION_METADATA_KEY,

          {

            issueKey,

            stage:
              "jira-created",

            workType:
              detectedWorkType,

            stickyColor

          }

        );

      }


      setStatus(
        issueKey +
        " exists. Building custom card…",
        "info"
      );


      const jira =
        await readJiraIssue(
          issueKey
        );


      // Preserve the sticky's exact VISUAL position on the canvas.
      // If the sticky is inside another frame, sticky.x/y are relative
      // to that parent and cannot be used directly for a new root item.
      const stickyCanvasPosition =
        await getCanvasPosition(
          sticky
        );


      const customCard =
        await createCustomCardAt(

          jira,

          stickyCanvasPosition.x,

          stickyCanvasPosition.y

        );


      await sticky.setMetadata(

        CONVERSION_METADATA_KEY,

        {

          issueKey,

          stage:
            "card-created",

          customCardFrameId:
            String(
              customCard.frame.id
            ),

          workType:
            jira.workType,

          stickyColor

        }

      );


      await miro.board.remove(
        sticky
      );


      setStatus(

        issueKey +
        " converted successfully to " +
        jira.workType +
        ".",

        "success"

      );


      console.log(
        "CUSTOM CARD STICKY CONVERSION COMPLETE:",
        {

          issueKey,

          workType:
            jira.workType,

          frameId:
            customCard.frame.id

        }
      );


    } catch (
      error
    ) {

      console.error(
        "CUSTOM CARD STICKY CONVERSION FAILED:",
        error
      );


      setStatus(

        error &&
        error.message

          ? error.message

          : String(
              error
            ),

        "error"

      );


    } finally {

      convertButton.disabled =
        false;

    }

  }


  convertButton.addEventListener(
    "click",
    convertSelectedSticky
  );

})();

</script>

</body>

</html>
`;


      return new Response(

        html,

        {

          status:
            200,

          headers: {

            "Content-Type":
              "text/html; charset=UTF-8",

            "Cache-Control":
              "no-store"

          }

        }

      );

    }


    // ##########################################################
    // ##########################################################
    //
    // CUSTOM CARD EXPERIMENT - STICKY TO JIRA - END
    //
    // ##########################################################
    // ##########################################################


    // ========================================================
    // EXISTING NATIVE SYNC
    // KV CHECK
    // ========================================================

    if (
      !env.CARD_MAP
    ) {

      return jsonResponse(
        {

          ok:
            false,

          reason:
            "CARD_MAP KV binding is not configured"

        },
        {
          status:
            500
        }
      );

    }


    // ========================================================
    // EXISTING NATIVE SYNC
    // REGISTER NATIVE JIRA CARDS
    // ========================================================

    if (
      request.method === "POST" &&
      url.pathname === "/register-cards"
    ) {

      const miroIdentity =
        await authenticateMiroRequest(
          request,
          env
        );


      if (
        !miroIdentity
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Invalid Miro identity token"

          },
          {
            status:
              401
          }
        );

      }


      let body;


      try {

        body =
          await request.json();


      } catch {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Invalid JSON"

          },
          {
            status:
              400
          }
        );

      }


      const boardId =
        String(
          body.boardId ??
          ""
        ).trim();


      if (
        boardId !==
        String(
          env.MIRO_BOARD_ID
        )
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Wrong Miro board"

          },
          {
            status:
              403
          }
        );

      }


      const cards =
        Array.isArray(
          body.cards
        )
          ? body.cards
          : [];


      const validMappings =
        [];


      for (
        const card
        of cards.slice(
          0,
          500
        )
      ) {

        const issueKey =
          normalizeIssueKey(
            card.issueKey
          );


        const itemId =
          String(
            card.itemId ??
            ""
          ).trim();


        if (
          !isSnIssueKey(
            issueKey
          ) ||
          !itemId
        ) {
          continue;
        }


        validMappings.push({

          issueKey,
          itemId

        });

      }


      await Promise.all(

        validMappings.map(
          mapping =>
            env.CARD_MAP.put(

              cardMapKey(
                mapping.issueKey
              ),

              mapping.itemId

            )
        )

      );


      return jsonResponse({

        ok:
          true,

        registered:
          validMappings.length

      });

    }


    // ========================================================
    // SHARED JIRA API CONFIG
    // ========================================================

    const jiraApiBase =

      "https://api.atlassian.com/ex/jira/" +

      encodeURIComponent(
        env.JIRA_CLOUD_ID
      ) +

      "/rest/api/3";


    const jiraHeaders = {

      Authorization:
        "Bearer " +
        env.JIRA_API_TOKEN,

      Accept:
        "application/json"

    };


    // ########################################################
    // ########################################################
    //
    // CUSTOM CARD EXPERIMENT - START
    //
    // READ JIRA DATA FOR CUSTOM CARDS
    //
    // READ-ONLY against Jira.
    //
    // ########################################################
    // ########################################################


    if (
      request.method === "POST" &&
      url.pathname === "/jira-card-data"
    ) {

      const miroIdentity =
        await authenticateMiroRequest(
          request,
          env
        );


      if (
        !miroIdentity
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Invalid Miro identity token"

          },
          {
            status:
              401
          }
        );

      }


      let body;


      try {

        body =
          await request.json();


      } catch {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Invalid JSON"

          },
          {
            status:
              400
          }
        );

      }


      const issueKey =
        normalizeIssueKey(
          body.issueKey
        );


      if (
        !isSnIssueKey(
          issueKey
        )
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Invalid SN issue key"

          },
          {
            status:
              400
          }
        );

      }


      const jiraResponse =
        await fetch(

          jiraApiBase +
          "/issue/" +
          encodeURIComponent(
            issueKey
          ) +
          "?fields=summary,priority,assignee,issuetype,status",

          {

            method:
              "GET",

            headers:
              jiraHeaders

          }

        );


      if (
        !jiraResponse.ok
      ) {

        const jiraError =
          await jiraResponse.text();


        return jsonResponse(
          {

            ok:
              false,

            stage:
              "custom-card-read-jira-data",

            jiraStatus:
              jiraResponse.status,

            error:
              jiraError

          },
          {
            status:
              500
          }
        );

      }


      const issue =
        await jiraResponse.json();


      return jsonResponse({

        ok:
          true,

        issueKey,

        browseUrl:
          "https://rendradev.atlassian.net/browse/" +
          encodeURIComponent(
            issueKey
          ),

        summary:
          issue.fields
            ?.summary
          ||
          "",

        priority:
          issue.fields
            ?.priority
            ?.name
          ||
          "None",

        priorityIconUrl:
          issue.fields
            ?.priority
            ?.iconUrl
          ||
          "",

        assignee:
          issue.fields
            ?.assignee
            ?.displayName
          ||
          "Unassigned",

        workType:
          issue.fields
            ?.issuetype
            ?.name
          ||
          "Unknown",

        status:
          issue.fields
            ?.status
            ?.name
          ||
          ""

      });

    }


    // ########################################################
    // ########################################################
    //
    // CUSTOM CARD EXPERIMENT - END
    //
    // ########################################################
    // ########################################################


    // ########################################################
    // ########################################################
    //
    // CUSTOM CARD EXPERIMENT - STICKY TO JIRA - START
    //
    // WORKER-SIDE JIRA CREATION
    //
    // THIS ROUTE WRITES TO JIRA.
    //
    // Special defaults ONLY for sticky conversion:
    //
    // Bug:
    // - Repro steps = Created from Miro sticky note.
    // - Customer (old v2) = Created from Miro sticky note
    //
    // New Feature + Improvement:
    // - customfield_10792 dropdown = Created from Miro sticky note
    // - customfield_10869 text = Created from Miro sticky note
    // - customfield_10870 text = Created from Miro sticky note
    // - customfield_10832 dropdown = Created from Miro sticky note
    //
    // Remaining work types get no extra sticky-only fields.
    // These defaults DO NOT affect any other Jira creation.
    //
    // ########################################################
    // ########################################################


    if (
      request.method === "POST" &&
      url.pathname === "/sticky-to-jira"
    ) {

      const miroIdentity =
        await authenticateMiroRequest(
          request,
          env
        );


      if (
        !miroIdentity
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Invalid Miro identity token"

          },
          {
            status:
              401
          }
        );

      }


      let body;


      try {

        body =
          await request.json();


      } catch {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Invalid JSON"

          },
          {
            status:
              400
          }
        );

      }


      const summary =
        String(
          body.summary ??
          ""
        )
          .replace(
            /\s+/g,
            " "
          )
          .trim();


      const workType =
        String(
          body.workType ??
          ""
        ).trim();


      const allowedWorkTypes =
        new Set([

          "Bug",
          "Improvement",
          "Spike",
          "New Feature",
          "Hotfix candidate",
          "Task/config/doc/test"

        ]);


      if (
        !summary
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Sticky note has no text"

          },
          {
            status:
              400
          }
        );

      }


      if (
        summary.length > 255
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Sticky text is too long for Jira summary",

            maxLength:
              255

          },
          {
            status:
              400
          }
        );

      }


      if (
        !allowedWorkTypes.has(
          workType
        )
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Unapproved work type",

            workType

          },
          {
            status:
              400
          }
        );

      }


      // ------------------------------------------------------
      // STEP 1:
      // Resolve actual Jira issue type dynamically.
      // ------------------------------------------------------

      const issueTypesResponse =
        await fetch(

          jiraApiBase +
          "/issue/createmeta/SN/issuetypes?maxResults=100",

          {

            method:
              "GET",

            headers:
              jiraHeaders

          }

        );


      if (
        !issueTypesResponse.ok
      ) {

        const jiraError =
          await issueTypesResponse.text();


        return jsonResponse(
          {

            ok:
              false,

            stage:
              "read-create-issue-types",

            jiraStatus:
              issueTypesResponse.status,

            error:
              jiraError

          },
          {
            status:
              500
          }
        );

      }


      const issueTypesData =
        await issueTypesResponse.json();


      const issueTypes =
        Array.isArray(
          issueTypesData.issueTypes
        )
          ? issueTypesData.issueTypes
          : [];


      const matchingIssueType =
        issueTypes.find(
          item =>

            String(
              item.name ??
              ""
            )
              .trim()
              .toLowerCase()

            ===

            workType.toLowerCase()
        );


      if (
        !matchingIssueType
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Jira work type was not found in project SN",

            workType,

            availableWorkTypes:
              issueTypes.map(
                item =>
                  item.name
              )

          },
          {
            status:
              409
          }
        );

      }


      // ------------------------------------------------------
      // STEP 2:
      // Read CREATE FIELD metadata for this exact work type.
      //
      // This lets us dynamically locate:
      //
      // Customer (old v2)
      //
      // and its allowed dropdown value:
      //
      // Created from Miro sticky note
      // ------------------------------------------------------

      const fieldMetaResponse =
        await fetch(

          jiraApiBase +
          "/issue/createmeta/SN/issuetypes/" +
          encodeURIComponent(
            String(
              matchingIssueType.id
            )
          ) +
          "?maxResults=200",

          {

            method:
              "GET",

            headers:
              jiraHeaders

          }

        );


      if (
        !fieldMetaResponse.ok
      ) {

        const jiraError =
          await fieldMetaResponse.text();


        return jsonResponse(
          {

            ok:
              false,

            stage:
              "read-create-field-metadata",

            jiraStatus:
              fieldMetaResponse.status,

            issueType:
              workType,

            error:
              jiraError

          },
          {
            status:
              500
          }
        );

      }


      const fieldMeta =
        await fieldMetaResponse.json();


      const fields =
        Array.isArray(
          fieldMeta.fields
        )
          ? fieldMeta.fields
          : [];


      // ------------------------------------------------------
      // STICKY -> JIRA REQUIRED FIELD RULES
      //
      // Bug:
      // - customfield_10868 Repro steps (ADF text)
      // - customfield_11174 Customer (old v2) dropdown
      //
      // New Feature + Improvement:
      // - customfield_10792 dropdown
      // - customfield_10869 ADF text
      // - customfield_10870 ADF text
      // - customfield_10832 dropdown
      //
      // Task/config/doc/test:
      // - customfield_10872 text-like required field
      //
      // Remaining work types:
      // - no extra fields are added by this sticky conversion.
      // ------------------------------------------------------

      const STICKY_DEFAULT_TEXT =
        "Created from Miro sticky note";

      const STICKY_CUSTOMER_FIELD_ID =
        "customfield_11174";

      const STICKY_REPRO_STEPS_FIELD_ID =
        "customfield_10868";

      const STICKY_NF_IMPROVEMENT_DROPDOWN_1_FIELD_ID =
        "customfield_10792";

      const STICKY_NF_IMPROVEMENT_TEXT_1_FIELD_ID =
        "customfield_10869";

      const STICKY_NF_IMPROVEMENT_TEXT_2_FIELD_ID =
        "customfield_10870";

      const STICKY_NF_IMPROVEMENT_DROPDOWN_2_FIELD_ID =
        "customfield_10832";

      const STICKY_TASK_REQUIRED_FIELD_ID =
        "customfield_10872";


      function findCreateField(
        fieldId
      ) {

        return fields.find(
          field =>
            String(
              field.fieldId ?? ""
            ) === fieldId
        ) || null;

      }


      function findDropdownOption(
        field,
        wantedValue
      ) {

        const allowedValues =
          Array.isArray(
            field?.allowedValues
          )
            ? field.allowedValues
            : [];


        return allowedValues.find(
          option => {

            const optionText =
              String(
                option?.value ??
                option?.name ??
                ""
              )
                .trim()
                .toLowerCase();


            return (
              optionText ===
              wantedValue
                .trim()
                .toLowerCase()
            );

          }
        ) || null;

      }


      function adfText(
        text
      ) {

        return {

          type:
            "doc",

          version:
            1,

          content: [

            {

              type:
                "paragraph",

              content: [

                {

                  type:
                    "text",

                  text

                }

              ]

            }

          ]

        };

      }


      function textLikeCreateValue(
        field,
        text
      ) {

        const schemaType =
          String(
            field?.schema?.type ??
            ""
          )
            .trim()
            .toLowerCase();

        const customType =
          String(
            field?.schema?.custom ??
            ""
          )
            .trim()
            .toLowerCase();


        if (
          schemaType === "doc" ||
          customType.includes(
            ":textarea"
          )
        ) {

          return adfText(
            text
          );

        }


        return text;

      }


      // ------------------------------------------------------
      // STEP 3:
      // Build fields for Jira issue creation.
      // ------------------------------------------------------

      const createFields = {

        project: {

          key:
            "SN"

        },

        summary,

        issuetype: {

          id:
            String(
              matchingIssueType.id
            )

        }

      };


      const stickyDefaultsApplied = {};


      // ------------------------------------------------------
      // BUG ONLY
      // ------------------------------------------------------

      if (
        workType === "Bug"
      ) {

        const customerField =
          findCreateField(
            STICKY_CUSTOMER_FIELD_ID
          );


        if (
          !customerField
        ) {

          return jsonResponse(
            {

              ok:
                false,

              stage:
                "find-bug-customer-field",

              reason:
                "Customer field customfield_11174 was not found in Jira create metadata for Bug",

              workType

            },
            {
              status:
                409
            }
          );

        }


        const customerOption =
          findDropdownOption(
            customerField,
            STICKY_DEFAULT_TEXT
          );


        if (
          !customerOption ||
          !customerOption.id
        ) {

          return jsonResponse(
            {

              ok:
                false,

              stage:
                "find-bug-customer-option",

              reason:
                'Dropdown option "Created from Miro sticky note" was not found in customfield_11174 for Bug',

              fieldId:
                STICKY_CUSTOMER_FIELD_ID

            },
            {
              status:
                409
            }
          );

        }


        createFields[
          STICKY_REPRO_STEPS_FIELD_ID
        ] = adfText(
          STICKY_DEFAULT_TEXT + "."
        );


        createFields[
          STICKY_CUSTOMER_FIELD_ID
        ] = {

          id:
            String(
              customerOption.id
            )

        };


        stickyDefaultsApplied.reproSteps = {
          fieldId:
            STICKY_REPRO_STEPS_FIELD_ID,
          value:
            STICKY_DEFAULT_TEXT + "."
        };


        stickyDefaultsApplied.customer = {
          fieldId:
            STICKY_CUSTOMER_FIELD_ID,
          optionId:
            String(
              customerOption.id
            ),
          value:
            customerOption.value ??
            customerOption.name ??
            STICKY_DEFAULT_TEXT
        };

      }


      // ------------------------------------------------------
      // NEW FEATURE + IMPROVEMENT ONLY
      // ------------------------------------------------------

      if (
        workType === "New Feature" ||
        workType === "Improvement"
      ) {

        const dropdown1Field =
          findCreateField(
            STICKY_NF_IMPROVEMENT_DROPDOWN_1_FIELD_ID
          );

        const text1Field =
          findCreateField(
            STICKY_NF_IMPROVEMENT_TEXT_1_FIELD_ID
          );

        const text2Field =
          findCreateField(
            STICKY_NF_IMPROVEMENT_TEXT_2_FIELD_ID
          );

        const dropdown2Field =
          findCreateField(
            STICKY_NF_IMPROVEMENT_DROPDOWN_2_FIELD_ID
          );


        const missingFieldIds = [

          [
            STICKY_NF_IMPROVEMENT_DROPDOWN_1_FIELD_ID,
            dropdown1Field
          ],

          [
            STICKY_NF_IMPROVEMENT_TEXT_1_FIELD_ID,
            text1Field
          ],

          [
            STICKY_NF_IMPROVEMENT_TEXT_2_FIELD_ID,
            text2Field
          ],

          [
            STICKY_NF_IMPROVEMENT_DROPDOWN_2_FIELD_ID,
            dropdown2Field
          ]

        ]
          .filter(
            ([, field]) =>
              !field
          )
          .map(
            ([fieldId]) =>
              fieldId
          );


        if (
          missingFieldIds.length > 0
        ) {

          return jsonResponse(
            {

              ok:
                false,

              stage:
                "find-new-feature-improvement-fields",

              reason:
                "One or more required sticky-conversion fields were not found in Jira create metadata",

              workType,

              missingFieldIds

            },
            {
              status:
                409
            }
          );

        }


        const dropdown1Option =
          findDropdownOption(
            dropdown1Field,
            STICKY_DEFAULT_TEXT
          );

        const dropdown2Option =
          findDropdownOption(
            dropdown2Field,
            STICKY_DEFAULT_TEXT
          );


        if (
          !dropdown1Option ||
          !dropdown1Option.id
        ) {

          return jsonResponse(
            {

              ok:
                false,

              stage:
                "find-new-feature-improvement-dropdown-option-10792",

              reason:
                'Dropdown option "Created from Miro sticky note" was not found in customfield_10792',

              workType,

              fieldId:
                STICKY_NF_IMPROVEMENT_DROPDOWN_1_FIELD_ID

            },
            {
              status:
                409
            }
          );

        }


        if (
          !dropdown2Option ||
          !dropdown2Option.id
        ) {

          return jsonResponse(
            {

              ok:
                false,

              stage:
                "find-new-feature-improvement-dropdown-option-10832",

              reason:
                'Dropdown option "Created from Miro sticky note" was not found in customfield_10832',

              workType,

              fieldId:
                STICKY_NF_IMPROVEMENT_DROPDOWN_2_FIELD_ID

            },
            {
              status:
                409
            }
          );

        }


        createFields[
          STICKY_NF_IMPROVEMENT_DROPDOWN_1_FIELD_ID
        ] = {

          id:
            String(
              dropdown1Option.id
            )

        };


        // Jira reports both customfield_10869 and customfield_10870
        // as Atlassian Document Format (ADF) fields, so they must
        // be sent as ADF documents rather than plain strings.

        const stickyDefaultAdf = {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: STICKY_DEFAULT_TEXT
                }
              ]
            }
          ]
        };


        createFields[
          STICKY_NF_IMPROVEMENT_TEXT_1_FIELD_ID
        ] =
          stickyDefaultAdf;


        createFields[
          STICKY_NF_IMPROVEMENT_TEXT_2_FIELD_ID
        ] =
          stickyDefaultAdf;


        createFields[
          STICKY_NF_IMPROVEMENT_DROPDOWN_2_FIELD_ID
        ] = {

          id:
            String(
              dropdown2Option.id
            )

        };


        stickyDefaultsApplied[
          STICKY_NF_IMPROVEMENT_DROPDOWN_1_FIELD_ID
        ] = {
          optionId:
            String(
              dropdown1Option.id
            ),
          value:
            dropdown1Option.value ??
            dropdown1Option.name ??
            STICKY_DEFAULT_TEXT
        };


        stickyDefaultsApplied[
          STICKY_NF_IMPROVEMENT_TEXT_1_FIELD_ID
        ] = STICKY_DEFAULT_TEXT;


        stickyDefaultsApplied[
          STICKY_NF_IMPROVEMENT_TEXT_2_FIELD_ID
        ] = STICKY_DEFAULT_TEXT;


        stickyDefaultsApplied[
          STICKY_NF_IMPROVEMENT_DROPDOWN_2_FIELD_ID
        ] = {
          optionId:
            String(
              dropdown2Option.id
            ),
          value:
            dropdown2Option.value ??
            dropdown2Option.name ??
            STICKY_DEFAULT_TEXT
        };

      }


      // ------------------------------------------------------
      // TASK/CONFIG/DOC/TEST ONLY
      // ------------------------------------------------------

      if (
        workType === "Task/config/doc/test"
      ) {

        const taskRequiredField =
          findCreateField(
            STICKY_TASK_REQUIRED_FIELD_ID
          );


        if (
          !taskRequiredField
        ) {

          return jsonResponse(
            {

              ok:
                false,

              stage:
                "find-task-required-field-10872",

              reason:
                "Required field customfield_10872 was not found in Jira create metadata for Task/config/doc/test",

              workType,

              fieldId:
                STICKY_TASK_REQUIRED_FIELD_ID

            },
            {
              status:
                409
            }
          );

        }


        createFields[
          STICKY_TASK_REQUIRED_FIELD_ID
        ] = textLikeCreateValue(
          taskRequiredField,
          STICKY_DEFAULT_TEXT
        );


        stickyDefaultsApplied[
          STICKY_TASK_REQUIRED_FIELD_ID
        ] = STICKY_DEFAULT_TEXT;

      }


      console.log(
        "CUSTOM CARD STICKY TO JIRA: creating issue",
        {

          workType,

          issueTypeId:
            matchingIssueType.id,

          stickyDefaultsApplied

        }
      );


      // ------------------------------------------------------
      // STEP 4:
      // CREATE JIRA ISSUE
      // ------------------------------------------------------

      const createResponse =
        await fetch(

          jiraApiBase +
          "/issue",

          {

            method:
              "POST",

            headers: {

              ...jiraHeaders,

              "Content-Type":
                "application/json"

            },

            body:
              JSON.stringify({

                fields:
                  createFields

              })

          }

        );


      if (
        !createResponse.ok
      ) {

        const jiraErrorText =
          await createResponse.text();


        let parsedError;


        try {

          parsedError =
            JSON.parse(
              jiraErrorText
            );


        } catch {

          parsedError =
            jiraErrorText;

        }


        return jsonResponse(
          {

            ok:
              false,

            stage:
              "create-jira-issue",

            jiraStatus:
              createResponse.status,

            workType,

            stickyDefaultsApplied,

            error:
              parsedError

          },
          {

            status:

              createResponse.status >= 400 &&
              createResponse.status < 500

                ? createResponse.status

                : 500

          }

        );

      }


      const created =
        await createResponse.json();


      const issueKey =
        normalizeIssueKey(
          created.key
        );


      if (
        !isSnIssueKey(
          issueKey
        )
      ) {

        return jsonResponse(
          {

            ok:
              false,

            stage:
              "validate-created-issue",

            reason:
              "Jira created an unexpected issue key",

            jiraResult:
              created

          },
          {
            status:
              500
          }
        );

      }


      return jsonResponse({

        ok:
          true,

        created:
          true,

        issueKey,

        workType,

        summary,

        jiraIssueTypeId:
          String(
            matchingIssueType.id
          ),

        stickyDefaults:
          stickyDefaultsApplied

      });

    }


    // ########################################################
    // ########################################################
    //
    // CUSTOM CARD EXPERIMENT - STICKY TO JIRA - END
    //
    // ########################################################
    // ########################################################


    // ########################################################
    // ########################################################
    //
    // CUSTOM CARD EXPERIMENT - MIRO -> JIRA STATUS SYNC - START
    //
    // Separate backend route for grouped custom cards.
    // Native /miro-to-jira remains unchanged below.
    //
    // WRITES:
    // - CARD_MAP KV under custom-card:SN-123 only
    // - Jira transition only when user moved a custom card
    //
    // ########################################################
    // ########################################################

    // ########################################################
    // CUSTOM CARD EXPERIMENT - JIRA <-> MIRO STATUS SYNC
    // REGISTER CUSTOM-CARD GROUP MAPPINGS
    //
    // WRITES: KV only under custom-card:SN-123.
    // No Jira write. No Miro mutation.
    // ########################################################

    if (
      request.method === "POST" &&
      url.pathname === "/register-custom-cards"
    ) {

      const miroIdentity =
        await authenticateMiroRequest(
          request,
          env
        );


      if (
        !miroIdentity
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Invalid Miro identity token"

          },
          {
            status:
              401
          }
        );

      }


      let body;


      try {

        body =
          await request.json();


      } catch {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Invalid JSON"

          },
          {
            status:
              400
          }
        );

      }


      const boardId =
        String(
          body.boardId ??
          ""
        ).trim();


      if (
        boardId !==
        String(
          env.MIRO_BOARD_ID
        )
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Wrong Miro board"

          },
          {
            status:
              403
          }
        );

      }


      const cards =
        Array.isArray(
          body.cards
        )
          ? body.cards
          : [];


      const validMappings =
        [];


      for (
        const card
        of cards.slice(
          0,
          500
        )
      ) {

        const issueKey =
          normalizeIssueKey(
            card.issueKey
          );


        const groupId =
          String(
            card.groupId ??
            ""
          ).trim();


        if (
          !isSnIssueKey(
            issueKey
          ) ||
          !groupId
        ) {
          continue;
        }


        validMappings.push({
          issueKey,
          groupId
        });

      }


      await Promise.all(

        validMappings.map(
          mapping =>
            env.CARD_MAP.put(

              customCardMapKey(
                mapping.issueKey
              ),

              mapping.groupId

            )
        )

      );


      console.log(
        "CUSTOM CARD KV mapping registration:",
        validMappings
      );


      return jsonResponse({

        ok:
          true,

        registered:
          validMappings.length,

        mappings:
          validMappings

      });

    }


    if (
      request.method === "POST" &&
      url.pathname === "/custom-miro-to-jira"
    ) {

      const miroIdentity =
        await authenticateMiroRequest(
          request,
          env
        );


      if (
        !miroIdentity
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Invalid Miro identity token"

          },
          {
            status:
              401
          }
        );

      }


      let body;


      try {

        body =
          await request.json();


      } catch {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Invalid JSON"

          },
          {
            status:
              400
          }
        );

      }


      const boardId =
        String(
          body.boardId ??
          ""
        ).trim();


      if (
        boardId !==
        String(
          env.MIRO_BOARD_ID
        )
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Wrong Miro board"

          },
          {
            status:
              403
          }
        );

      }


      const issueKey =
        normalizeIssueKey(
          body.issueKey
        );


      const groupId =
        String(
          body.groupId ??
          ""
        ).trim();


      const desiredStatus =
        String(
          body.desiredStatus ??
          ""
        ).trim();


      const normalizedDesiredStatus =
        normalizeStatus(
          desiredStatus
        );


      if (
        !isSnIssueKey(
          issueKey
        )
      ) {

        return jsonResponse({

          ok:
            true,

          ignored:
            true,

          reason:
            "Only SN issues are approved"

        });

      }


      if (
        !groupId
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Missing custom-card container ID"

          },
          {
            status:
              400
          }
        );

      }


      const allowedStatuses =
        new Set([

          "todo",
          "in progress",
          "functional review",
          "code review",
          "approved",
          "merged"

        ]);


      if (
        !allowedStatuses.has(
          normalizedDesiredStatus
        )
      ) {

        return jsonResponse({

          ok:
            true,

          ignored:
            true,

          reason:
            "Unapproved status: " +
            desiredStatus

        });

      }


      // Separate custom-card mapping. This does not overwrite
      // the native jira-card:SN-123 mapping.
      await env.CARD_MAP.put(

        customCardMapKey(
          issueKey
        ),

        groupId

      );


      const issueResponse =
        await fetch(

          jiraApiBase +
          "/issue/" +
          encodeURIComponent(
            issueKey
          ) +
          "?fields=status," +
          encodeURIComponent(
            TEST_AREA_FIELD_ID
          ),

          {

            method:
              "GET",

            headers:
              jiraHeaders

          }

        );


      if (
        !issueResponse.ok
      ) {

        const jiraError =
          await issueResponse.text();


        return jsonResponse(
          {

            ok:
              false,

            changed:
              false,

            stage:
              "custom-card-read-current-status",

            jiraStatus:
              issueResponse.status,

            error:
              jiraError

          },
          {
            status:
              500
          }
        );

      }


      const issueData =
        await issueResponse.json();


      const currentStatus =
        issueData.fields
          ?.status
          ?.name
        ||
        "";


      const testAreaValue =
        issueData.fields
          ?.[TEST_AREA_FIELD_ID];


      if (
        normalizedDesiredStatus ===
          "functional review"

        &&

        !hasMeaningfulValue(
          testAreaValue
        )
      ) {

        return jsonResponse(
          {

            ok:
              false,

            changed:
              false,

            rejected:
              true,

            reason:
              "TEST_AREA_REQUIRED",

            issueKey,

            currentStatus,

            desiredStatus,

            fieldId:
              TEST_AREA_FIELD_ID,

            message:
              "Test area must be filled in before moving to Functional review."

          },
          {
            status:
              409
          }
        );

      }


      if (
        normalizeStatus(
          currentStatus
        ) ===
        normalizedDesiredStatus
      ) {

        return jsonResponse({

          ok:
            true,

          changed:
            false,

          issueKey,

          currentStatus,

          desiredStatus,

          groupId,

          reason:
            "Jira already has desired status"

        });

      }


      const transitionsResponse =
        await fetch(

          jiraApiBase +
          "/issue/" +
          encodeURIComponent(
            issueKey
          ) +
          "/transitions",

          {

            method:
              "GET",

            headers:
              jiraHeaders

          }

        );


      if (
        !transitionsResponse.ok
      ) {

        const jiraError =
          await transitionsResponse.text();


        return jsonResponse(
          {

            ok:
              false,

            changed:
              false,

            stage:
              "custom-card-read-transitions",

            jiraStatus:
              transitionsResponse.status,

            error:
              jiraError

          },
          {
            status:
              500
          }
        );

      }


      const transitionsData =
        await transitionsResponse.json();


      const destinationMatches =
        (
          transitionsData.transitions ||
          []
        ).filter(
          transition =>

            normalizeStatus(
              transition.to
                ?.name
            )

            ===

            normalizedDesiredStatus
        );


      const preferredMatches =
        destinationMatches.filter(
          transition =>

            String(
              transition.name ||
              ""
            )
              .trim()
              .toLowerCase()
              .startsWith(
                "move to "
              )
        );


      let selectedTransition =
        null;


      if (
        preferredMatches.length === 1
      ) {

        selectedTransition =
          preferredMatches[0];


      } else if (
        preferredMatches.length === 0 &&
        destinationMatches.length === 1
      ) {

        selectedTransition =
          destinationMatches[0];

      }


      if (
        !selectedTransition
      ) {

        return jsonResponse(
          {

            ok:
              false,

            changed:
              false,

            reason:
              "No unique approved Jira transition found",

            issueKey,

            currentStatus,

            desiredStatus,

            groupId

          },
          {
            status:
              409
          }
        );

      }


      const transitionResponse =
        await fetch(

          jiraApiBase +
          "/issue/" +
          encodeURIComponent(
            issueKey
          ) +
          "/transitions",

          {

            method:
              "POST",

            headers: {

              ...jiraHeaders,

              "Content-Type":
                "application/json"

            },

            body:
              JSON.stringify({

                transition: {

                  id:
                    String(
                      selectedTransition.id
                    )

                }

              })

          }

        );


      if (
        !transitionResponse.ok
      ) {

        const transitionError =
          await transitionResponse.text();


        return jsonResponse(
          {

            ok:
              false,

            changed:
              false,

            rejected:
              true,

            stage:
              "custom-card-transition",

            jiraStatus:
              transitionResponse.status,

            issueKey,

            currentStatus,

            desiredStatus,

            groupId,

            error:
              transitionError

          },
          {

            status:

              transitionResponse.status >= 400 &&
              transitionResponse.status < 500

                ? transitionResponse.status

                : 500

          }
        );

      }


      return jsonResponse({

        ok:
          true,

        changed:
          true,

        issueKey,

        groupId,

        fromStatus:
          currentStatus,

        toStatus:
          desiredStatus,

        transitionId:
          selectedTransition.id,

        transitionName:
          selectedTransition.name

      });

    }


    // ########################################################
    // ########################################################
    //
    // CUSTOM CARD EXPERIMENT - MIRO -> JIRA STATUS SYNC - END
    //
    // ########################################################
    // ########################################################


    // ########################################################
    // ########################################################
    //
    // CUSTOM CARD EXPERIMENT - JIRA -> MIRO SDK QUEUE - START
    //
    // Jira webhook stores desired custom-card status in KV.
    // The open Miro app polls this queue and moves the FRAME
    // with Web SDK frame.sync(), so children move with parent.
    //
    // Native Jira Card sync does not use these routes.
    //
    // ########################################################
    // ########################################################


    if (
      request.method === "POST" &&
      url.pathname === "/custom-card-pending"
    ) {

      // MULTI-USER SAFETY / BACKWARD COMPATIBILITY:
      // Jira -> Miro custom-card movement is server-side now.
      // Return no pending moves so older open Miro app tabs cannot
      // execute stale client-side frame movements.
      const miroIdentity =
        await authenticateMiroRequest(
          request,
          env
        );

      if (
        !miroIdentity
      ) {

        return jsonResponse(
          {
            ok: false,
            reason: "Invalid Miro identity token"
          },
          {
            status: 401
          }
        );

      }

      return jsonResponse({
        ok: true,
        moves: [],
        disabled: true,
        reason: "Jira -> Miro custom movement is handled server-side"
      });

    }


    if (
      request.method === "POST" &&
      url.pathname === "/custom-card-ack"
    ) {

      const miroIdentity =
        await authenticateMiroRequest(
          request,
          env
        );


      if (
        !miroIdentity
      ) {

        return jsonResponse(
          {
            ok: false,
            reason: "Invalid Miro identity token"
          },
          {
            status: 401
          }
        );

      }


      let body;


      try {

        body =
          await request.json();


      } catch {

        return jsonResponse(
          {
            ok: false,
            reason: "Invalid JSON"
          },
          {
            status: 400
          }
        );

      }


      const issueKey =
        normalizeIssueKey(
          body.issueKey
        );


      const requestId =
        String(
          body.requestId || ""
        ).trim();


      if (
        !isSnIssueKey(
          issueKey
        ) ||
        !requestId
      ) {

        return jsonResponse(
          {
            ok: false,
            reason: "Invalid custom-card ack"
          },
          {
            status: 400
          }
        );

      }


      const key =
        customCardPendingKey(
          issueKey
        );


      const current =
        await env.CARD_MAP.get(
          key,
          "json"
        );


      if (
        current &&
        current.requestId === requestId
      ) {

        await env.CARD_MAP.delete(
          key
        );

      }


      return jsonResponse({
        ok: true,
        acknowledged: true,
        issueKey
      });

    }


    // ########################################################
    // CUSTOM CARD EXPERIMENT - JIRA -> MIRO SDK QUEUE - END
    // ########################################################


    // ========================================================
    // EXISTING NATIVE SYNC
    // MIRO -> JIRA
    // ========================================================

    if (
      request.method === "POST" &&
      url.pathname === "/miro-to-jira"
    ) {

      const miroIdentity =
        await authenticateMiroRequest(
          request,
          env
        );


      if (
        !miroIdentity
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Invalid Miro identity token"

          },
          {
            status:
              401
          }
        );

      }


      let body;


      try {

        body =
          await request.json();


      } catch {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Invalid JSON"

          },
          {
            status:
              400
          }
        );

      }


      const boardId =
        String(
          body.boardId ??
          ""
        ).trim();


      if (
        boardId !==
        String(
          env.MIRO_BOARD_ID
        )
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Wrong Miro board"

          },
          {
            status:
              403
          }
        );

      }


      const issueKey =
        normalizeIssueKey(
          body.issueKey
        );


      const itemId =
        String(
          body.itemId ??
          ""
        ).trim();


      const desiredStatus =
        String(
          body.desiredStatus ??
          ""
        ).trim();


      const normalizedDesiredStatus =
        normalizeStatus(
          desiredStatus
        );


      if (
        !isSnIssueKey(
          issueKey
        )
      ) {

        return jsonResponse({

          ok:
            true,

          ignored:
            true,

          reason:
            "Only SN issues are approved"

        });

      }


      if (
        !itemId
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Missing Miro item ID"

          },
          {
            status:
              400
          }
        );

      }


      await env.CARD_MAP.put(

        cardMapKey(
          issueKey
        ),

        itemId

      );


      const allowedStatuses =
        new Set([

          "todo",
          "in progress",
          "functional review",
          "code review",
          "approved",
          "merged"

        ]);


      if (
        !allowedStatuses.has(
          normalizedDesiredStatus
        )
      ) {

        return jsonResponse({

          ok:
            true,

          ignored:
            true,

          reason:
            "Unapproved status: " +
            desiredStatus

        });

      }


      const issueResponse =
        await fetch(

          jiraApiBase +
          "/issue/" +
          encodeURIComponent(
            issueKey
          ) +
          "?fields=status," +
          encodeURIComponent(
            TEST_AREA_FIELD_ID
          ),

          {

            method:
              "GET",

            headers:
              jiraHeaders

          }

        );


      if (
        !issueResponse.ok
      ) {

        const jiraError =
          await issueResponse.text();


        return jsonResponse(
          {

            ok:
              false,

            changed:
              false,

            stage:
              "read-current-status",

            jiraStatus:
              issueResponse.status,

            error:
              jiraError

          },
          {
            status:
              500
          }
        );

      }


      const issueData =
        await issueResponse.json();


      const currentStatus =
        issueData.fields
          ?.status
          ?.name
        ||
        "";


      const testAreaValue =
        issueData.fields
          ?.[TEST_AREA_FIELD_ID];


      if (
        normalizedDesiredStatus ===
          "functional review"

        &&

        !hasMeaningfulValue(
          testAreaValue
        )
      ) {

        return jsonResponse(
          {

            ok:
              false,

            changed:
              false,

            rejected:
              true,

            reason:
              "TEST_AREA_REQUIRED",

            issueKey,

            currentStatus,

            desiredStatus,

            fieldId:
              TEST_AREA_FIELD_ID,

            message:
              "Test area must be filled in before moving to Functional review."

          },
          {
            status:
              409
          }
        );

      }


      if (
        normalizeStatus(
          currentStatus
        ) ===
        normalizedDesiredStatus
      ) {

        return jsonResponse({

          ok:
            true,

          changed:
            false,

          issueKey,

          currentStatus,

          desiredStatus,

          reason:
            "Jira already has desired status"

        });

      }


      const transitionsResponse =
        await fetch(

          jiraApiBase +
          "/issue/" +
          encodeURIComponent(
            issueKey
          ) +
          "/transitions",

          {

            method:
              "GET",

            headers:
              jiraHeaders

          }

        );


      if (
        !transitionsResponse.ok
      ) {

        const jiraError =
          await transitionsResponse.text();


        return jsonResponse(
          {

            ok:
              false,

            changed:
              false,

            stage:
              "read-transitions",

            jiraStatus:
              transitionsResponse.status,

            error:
              jiraError

          },
          {
            status:
              500
          }
        );

      }


      const transitionsData =
        await transitionsResponse.json();


      const destinationMatches =
        (
          transitionsData.transitions ||
          []
        ).filter(
          transition =>

            normalizeStatus(
              transition.to
                ?.name
            )

            ===

            normalizedDesiredStatus
        );


      const preferredMatches =
        destinationMatches.filter(
          transition =>

            String(
              transition.name ||
              ""
            )
              .trim()
              .toLowerCase()
              .startsWith(
                "move to "
              )
        );


      let selectedTransition =
        null;


      if (
        preferredMatches.length === 1
      ) {

        selectedTransition =
          preferredMatches[0];


      } else if (
        preferredMatches.length === 0 &&
        destinationMatches.length === 1
      ) {

        selectedTransition =
          destinationMatches[0];

      }


      if (
        !selectedTransition
      ) {

        return jsonResponse(
          {

            ok:
              false,

            changed:
              false,

            reason:
              "No unique approved Jira transition found",

            issueKey,

            currentStatus,

            desiredStatus

          },
          {
            status:
              409
          }
        );

      }


      const transitionResponse =
        await fetch(

          jiraApiBase +
          "/issue/" +
          encodeURIComponent(
            issueKey
          ) +
          "/transitions",

          {

            method:
              "POST",

            headers: {

              ...jiraHeaders,

              "Content-Type":
                "application/json"

            },

            body:
              JSON.stringify({

                transition: {

                  id:
                    String(
                      selectedTransition.id
                    )

                }

              })

          }

        );


      if (
        !transitionResponse.ok
      ) {

        const transitionError =
          await transitionResponse.text();


        return jsonResponse(
          {

            ok:
              false,

            changed:
              false,

            rejected:
              true,

            stage:
              "transition",

            jiraStatus:
              transitionResponse.status,

            issueKey,

            currentStatus,

            desiredStatus,

            error:
              transitionError

          },
          {

            status:

              transitionResponse.status >= 400 &&
              transitionResponse.status < 500

                ? transitionResponse.status

                : 500

          }

        );

      }


      return jsonResponse({

        ok:
          true,

        changed:
          true,

        issueKey,

        fromStatus:
          currentStatus,

        toStatus:
          desiredStatus,

        transitionId:
          selectedTransition.id,

        transitionName:
          selectedTransition.name

      });

    }


    // ========================================================
    // EXISTING NATIVE SYNC + ISOLATED CUSTOM CARD EXPERIMENT
    // JIRA -> MIRO
    //
    // Native mapping: jira-card:SN-123
    // Custom mapping: custom-card:SN-123
    //
    // IMPORTANT:
    // - Missing mappings never create anything.
    // - Native and custom cards can both be moved for one issue.
    // - Custom Jira -> Miro movement happens server-side.
    // - Custom-card movement is isolated and removable.
    // ========================================================

    if (
      request.method === "POST" &&
      url.pathname === "/"
    ) {

      if (
        !env.JIRA_WEBHOOK_SECRET
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "JIRA_WEBHOOK_SECRET is not configured"

          },
          {
            status:
              500
          }
        );

      }


      const receivedSecret =
        request.headers.get(
          "X-Webhook-Secret"
        ) || "";


      if (
        receivedSecret !==
        env.JIRA_WEBHOOK_SECRET
      ) {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Invalid Jira webhook secret"

          },
          {
            status:
              401
          }
        );

      }


      let body;


      try {

        body =
          await request.json();


      } catch {

        return jsonResponse(
          {

            ok:
              false,

            reason:
              "Invalid JSON"

          },
          {
            status:
              400
          }
        );

      }


      const issueKey =
        normalizeIssueKey(
          body.issueKey
        );


      const status =
        String(
          body.status ??
          ""
        ).trim();


      if (
        !isSnIssueKey(
          issueKey
        )
      ) {

        return jsonResponse({

          ok:
            true,

          ignored:
            true,

          reason:
            "Only SN issues are approved",

          issueKey

        });

      }


      const normalizedStatus =
        normalizeStatus(
          status
        );


      const ACTIVE_BOARD = {

        left:
          438.36642375544034,

        right:
          5303.436262036128,

        top:
          434.257014599023,

        bottom:
          3045.734778444852

      };


      const columns = {

        "todo": {

          left:
            1468.7903676550886,

          right:
            2551.696467655089,

          targetX:
            1990.8399296925127

        },

        "in progress": {

          left:
            2564.6113791667394,

          right:
            3277.6028791667395,

          targetX:
            2923.455009676509

        },

        "functional review": {

          left:
            3289.4484150169965,

          right:
            3651.451815016996,

          targetX:
            3472.938505190192

        },

        "code review": {

          left:
            3662.9922412433402,

          right:
            4020.66884124334,

          targetX:
            3842.7526347392704

        },

        "approved": {

          left:
            4033.200178788891,

          right:
            4680.471778788891,

          targetX:
            4350.752924110384

        },

        "merged": {

          left:
            4692.4616140640555,

          right:
            5284.738514064056,

          targetX:
            4983.202615160219

        }

      };


      const targetColumn =
        columns[
          normalizedStatus
        ];


      if (
        !targetColumn
      ) {

        return jsonResponse({

          ok:
            true,

          ignored:
            true,

          reason:
            "Unapproved status: " +
            status,

          issueKey

        });

      }


      const miroHeaders = {

        Authorization:
          "Bearer " +
          env.MIRO_TOKEN,

        Accept:
          "application/json"

      };


      const boardItemsBase =

        "https://api.miro.com/v2/boards/" +

        encodeURIComponent(
          env.MIRO_BOARD_ID
        ) +

        "/items/";


      function insideActiveBoard(
        x,
        y
      ) {

        return (

          x >= ACTIVE_BOARD.left &&
          x <= ACTIVE_BOARD.right &&
          y >= ACTIVE_BOARD.top &&
          y <= ACTIVE_BOARD.bottom

        );

      }


      function horizontalOverlapRatio(
        centerX,
        width,
        column
      ) {

        const itemLeft =
          centerX -
          width / 2;


        const itemRight =
          centerX +
          width / 2;


        const overlapWidth =
          Math.max(

            0,

            Math.min(
              itemRight,
              column.right
            )

            -

            Math.max(
              itemLeft,
              column.left
            )

          );


        return (
          overlapWidth /
          width
        );

      }


      async function readMiroItem(
        itemId
      ) {

        const response =
          await fetch(

            boardItemsBase +
            encodeURIComponent(
              itemId
            ),

            {

              method:
                "GET",

              headers:
                miroHeaders

            }

          );


        if (
          response.status === 404
        ) {

          return {
            found:
              false
          };

        }


        if (
          !response.ok
        ) {

          return {

            found:
              true,

            ok:
              false,

            status:
              response.status,

            error:
              await response.text()

          };

        }


        return {

          found:
            true,

          ok:
            true,

          item:
            await response.json()

        };

      }


      async function patchMiroItemPosition(
        itemId,
        x,
        y
      ) {

        return await fetch(

          boardItemsBase +
          encodeURIComponent(
            itemId
          ),

          {

            method:
              "PATCH",

            headers: {

              ...miroHeaders,

              "Content-Type":
                "application/json"

            },

            body:
              JSON.stringify({

                position: {

                  x,
                  y,

                  origin:
                    "center"

                }

              })

          }

        );

      }


      // ------------------------------------------------------
      // EXISTING NATIVE JIRA CARD MOVEMENT
      // ------------------------------------------------------

      async function moveNativeCard(
        itemId
      ) {

        const read =
          await readMiroItem(
            itemId
          );


        if (
          !read.found
        ) {

          await env.CARD_MAP.delete(
            cardMapKey(
              issueKey
            )
          );


          return {

            ok:
              true,

            mapped:
              false,

            moved:
              false,

            reason:
              "Mapped native Miro card no longer exists; mapping removed"

          };

        }


        if (
          read.ok === false
        ) {

          return {

            ok:
              false,

            stage:
              "native-read",

            miroStatus:
              read.status,

            error:
              read.error

          };

        }


        const item =
          read.item;


        const currentX =
          item.position?.x;


        const currentY =
          item.position?.y;


        const cardWidth =
          item.geometry?.width;


        if (
          typeof currentX !== "number" ||
          typeof currentY !== "number" ||
          typeof cardWidth !== "number" ||
          cardWidth <= 0
        ) {

          return {

            ok:
              false,

            stage:
              "native-geometry",

            reason:
              "Invalid native Miro item geometry"

          };

        }


        if (
          !insideActiveBoard(
            currentX,
            currentY
          )
        ) {

          return {

            ok:
              true,

            mapped:
              true,

            moved:
              false,

            parked:
              true

          };

        }


        const overlapRatio =
          horizontalOverlapRatio(
            currentX,
            cardWidth,
            targetColumn
          );


        if (
          overlapRatio >= 0.60
        ) {

          return {

            ok:
              true,

            mapped:
              true,

            moved:
              false,

            reason:
              "Native card already sufficiently inside correct column",

            overlapPercent:
              Number(
                (
                  overlapRatio * 100
                ).toFixed(1)
              )

          };

        }


        const patchResponse =
          await patchMiroItemPosition(

            itemId,

            targetColumn.targetX,

            currentY

          );


        if (
          !patchResponse.ok
        ) {

          return {

            ok:
              false,

            stage:
              "native-move",

            miroStatus:
              patchResponse.status,

            error:
              await patchResponse.text()

          };

        }


        return {

          ok:
            true,

          mapped:
            true,

          moved:
            true,

          itemId,

          fromX:
            currentX,

          toX:
            targetColumn.targetX,

          yPreserved:
            currentY

        };

      }


      // ######################################################
      // CUSTOM CARD EXPERIMENT - JIRA -> MIRO - START
      //
      // FRAME-BASED CUSTOM CARDS:
      // A mapped frame is moved with ONE Miro PATCH. Its child
      // items follow the parent automatically, so the complete
      // card moves visually as one unit.
      //
      // Legacy grouped cards retain a fallback path only so an
      // unmigrated old card can still move.
      // ######################################################

      async function getCustomGroupItemIds(
        groupId
      ) {

        const groupUrl =

          "https://api.miro.com/v2/boards/" +

          encodeURIComponent(
            env.MIRO_BOARD_ID
          ) +

          "/groups/" +

          encodeURIComponent(
            groupId
          );


        const response =
          await fetch(

            groupUrl,

            {

              method:
                "GET",

              headers:
                miroHeaders

            }

          );


        if (
          response.status === 404
        ) {

          return {
            found:
              false
          };

        }


        if (
          !response.ok
        ) {

          return {

            found:
              true,

            ok:
              false,

            status:
              response.status,

            error:
              await response.text()

          };

        }


        const data =
          await response.json();


        const rawItems =

          Array.isArray(
            data?.data?.items
          )
            ? data.data.items
            :

          Array.isArray(
            data?.items
          )
            ? data.items
            :

          Array.isArray(
            data?.data
          )
            ? data.data
            :

          [];


        const itemIds =
          rawItems
            .map(
              item =>

                typeof item === "string"
                  ? item
                  : String(
                      item?.id ??
                      item?.itemId ??
                      ""
                    )
            )
            .filter(
              Boolean
            );


        return {

          found:
            true,

          ok:
            true,

          itemIds:
            Array.from(
              new Set(
                itemIds
              )
            )

        };

      }


      async function moveCustomFrame(
        frameId,
        frameItem
      ) {

        const currentX =
          frameItem.position?.x;

        const currentY =
          frameItem.position?.y;

        const cardWidth =
          frameItem.geometry?.width;


        if (
          typeof currentX !== "number" ||
          typeof currentY !== "number" ||
          typeof cardWidth !== "number" ||
          cardWidth <= 0
        ) {

          return {

            ok:
              false,

            stage:
              "custom-frame-geometry",

            reason:
              "Invalid custom-card frame geometry"

          };

        }


        if (
          !insideActiveBoard(
            currentX,
            currentY
          )
        ) {

          return {

            ok:
              true,

            mapped:
              true,

            moved:
              false,

            parked:
              true

          };

        }


        const overlapRatio =
          horizontalOverlapRatio(
            currentX,
            cardWidth,
            targetColumn
          );


        if (
          overlapRatio >= 0.60
        ) {

          return {

            ok:
              true,

            mapped:
              true,

            moved:
              false,

            reason:
              "Custom card frame already sufficiently inside correct column",

            overlapPercent:
              Number(
                (
                  overlapRatio * 100
                ).toFixed(1)
              )

          };

        }


        const patchResponse =
          await patchMiroItemPosition(

            frameId,

            targetColumn.targetX,

            currentY

          );


        if (
          !patchResponse.ok
        ) {

          return {

            ok:
              false,

            stage:
              "custom-frame-move",

            miroStatus:
              patchResponse.status,

            error:
              await patchResponse.text()

          };

        }


        return {

          ok:
            true,

          mapped:
            true,

          moved:
            true,

          frameId,

          movedAsSingleParent:
            true,

          fromX:
            currentX,

          toX:
            targetColumn.targetX,

          yPreserved:
            currentY

        };

      }


      async function moveLegacyCustomGroup(
        groupId
      ) {

        const groupRead =
          await getCustomGroupItemIds(
            groupId
          );


        if (
          !groupRead.found
        ) {

          await env.CARD_MAP.delete(
            customCardMapKey(
              issueKey
            )
          );


          return {

            ok:
              true,

            mapped:
              false,

            moved:
              false,

            reason:
              "Mapped legacy custom-card group no longer exists; mapping removed"

          };

        }


        if (
          groupRead.ok === false
        ) {

          return {

            ok:
              false,

            stage:
              "custom-legacy-group-read",

            miroStatus:
              groupRead.status,

            error:
              groupRead.error

          };

        }


        const itemReads =
          await Promise.all(

            groupRead.itemIds.map(
              async itemId => ({

                itemId,

                read:
                  await readMiroItem(
                    itemId
                  )

              })
            )

          );


        const childItems =
          [];


        for (
          const result
          of itemReads
        ) {

          if (
            !result.read.found ||
            result.read.ok === false
          ) {

            return {

              ok:
                false,

              stage:
                "custom-legacy-child-read",

              itemId:
                result.itemId,

              miroStatus:
                result.read.status ?? 404,

              error:
                result.read.error ??
                "Custom-card child item was not found"

            };

          }


          childItems.push(
            result.read.item
          );

        }


        const background =
          childItems.find(
            item =>

              item.type === "shape" &&
              typeof item.geometry?.width === "number" &&
              typeof item.geometry?.height === "number" &&
              Math.abs(
                item.geometry.width - 320
              ) < 5 &&
              Math.abs(
                item.geometry.height - 120
              ) < 5
          );


        if (
          !background
        ) {

          return {

            ok:
              false,

            stage:
              "custom-legacy-background",

            reason:
              "Could not identify legacy custom-card background shape"

          };

        }


        const currentX =
          background.position?.x;

        const currentY =
          background.position?.y;

        const cardWidth =
          background.geometry?.width;


        if (
          typeof currentX !== "number" ||
          typeof currentY !== "number" ||
          typeof cardWidth !== "number" ||
          cardWidth <= 0
        ) {

          return {

            ok:
              false,

            stage:
              "custom-legacy-geometry",

            reason:
              "Invalid legacy custom-card geometry"

          };

        }


        if (
          !insideActiveBoard(
            currentX,
            currentY
          )
        ) {

          return {

            ok:
              true,

            mapped:
              true,

            moved:
              false,

            parked:
              true

          };

        }


        const overlapRatio =
          horizontalOverlapRatio(
            currentX,
            cardWidth,
            targetColumn
          );


        if (
          overlapRatio >= 0.60
        ) {

          return {

            ok:
              true,

            mapped:
              true,

            moved:
              false,

            reason:
              "Legacy custom card already sufficiently inside correct column"

          };

        }


        const deltaX =
          targetColumn.targetX -
          currentX;


        const moveResults =
          await Promise.all(

            childItems.map(
              async item => {

                const itemX =
                  item.position?.x;

                const itemY =
                  item.position?.y;


                if (
                  typeof itemX !== "number" ||
                  typeof itemY !== "number"
                ) {

                  return {
                    ok: false,
                    itemId: String(item.id),
                    reason: "invalid-geometry"
                  };

                }


                const response =
                  await patchMiroItemPosition(

                    String(
                      item.id
                    ),

                    itemX + deltaX,

                    itemY

                  );


                return {
                  ok: response.ok,
                  itemId: String(item.id),
                  status: response.status,
                  error: response.ok ? null : await response.text()
                };

              }
            )

          );


        const failedMove =
          moveResults.find(
            result =>
              !result.ok
          );


        if (
          failedMove
        ) {

          return {

            ok:
              false,

            stage:
              "custom-group-parallel-move",

            itemId:
              failedMove.itemId,

            miroStatus:
              failedMove.status ?? null,

            error:
              failedMove.error ?? failedMove.reason

          };

        }


        return {

          ok:
            true,

          mapped:
            true,

          moved:
            true,

          legacyGroupId:
            groupId,

          movedAsSingleParent:
            false,

          fromX:
            currentX,

          toX:
            targetColumn.targetX,

          yPreserved:
            currentY

        };

      }


      async function moveCustomCardContainer(
        containerId
      ) {

        // Frames are normal Miro items and can be moved with one
        // PATCH. Try this path first.
        const read =
          await readMiroItem(
            containerId
          );


        if (
          read.found &&
          read.ok !== false &&
          (
            read.item?.type === "app_card" ||
            read.item?.type === "frame"
          )
        ) {

          return await moveCustomFrame(
            containerId,
            read.item
          );

        }


        if (
          read.found &&
          read.ok === false
        ) {

          return {

            ok:
              false,

            stage:
              "custom-container-read",

            miroStatus:
              read.status,

            error:
              read.error

          };

        }


        // Legacy fallback for old group IDs. This remains only for
        // backward compatibility. New cards are frame-native and use
        // one server-side PATCH. Legacy groups may still move item by
        // item until they are rebuilt/migrated as true frames.
        return await moveLegacyCustomGroup(
          containerId
        );

      }

      // ######################################################
      // CUSTOM CARD EXPERIMENT - JIRA -> MIRO - END
      // ######################################################


      const [
        nativeItemId,
        customContainerId
      ] =
        await Promise.all([

          env.CARD_MAP.get(
            cardMapKey(
              issueKey
            )
          ),

          env.CARD_MAP.get(
            customCardMapKey(
              issueKey
            )
          )

        ]);


      console.log(
        "JIRA -> MIRO mapping lookup:",
        {
          issueKey,
          status,
          nativeMapped: Boolean(nativeItemId),
          customMapped: Boolean(customContainerId),
          customContainerId: customContainerId || null
        }
      );


      if (
        !nativeItemId &&
        !customContainerId
      ) {

        return jsonResponse({

          ok:
            true,

          moved:
            false,

          unmapped:
            true,

          reason:
            "No registered native or custom Miro card for this Jira issue",

          issueKey,
          status

        });

      }


      const nativeResult =
        nativeItemId
          ? await moveNativeCard(
              nativeItemId
            )
          : {

              ok:
                true,

              mapped:
                false,

              moved:
                false

            };


      let customResult;


      if (
        customContainerId
      ) {

        // Clear any stale queue entry created by older Worker/app
        // versions. New architecture never relies on client polling.
        await env.CARD_MAP.delete(
          customCardPendingKey(
            issueKey
          )
        );


        // GLOBAL ACTION: server-side and idempotent.
        // A true frame is moved with ONE Miro REST PATCH.
        // No user's local Miro viewport is involved.
        customResult =
          await moveCustomCardContainer(
            customContainerId
          );


        console.log(
          "JIRA -> MIRO custom server-side result:",
          {
            issueKey,
            status,
            customContainerId,
            result: customResult
          }
        );


      } else {

        customResult = {

          ok:
            true,

          mapped:
            false,

          moved:
            false

        };

      }


      const combinedOk =
        nativeResult.ok !== false &&
        customResult.ok !== false;


      return jsonResponse(
        {

          ok:
            combinedOk,

          issueKey,
          status,

          moved:
            Boolean(
              nativeResult.moved ||
              customResult.moved
            ),

          customQueued:
            false,

          customMovementMode:
            customResult.movedAsSingleParent
              ? "server-side-frame-rest"
              : customResult.mapped
                ? "server-side-legacy-or-noop"
                : "unmapped",

          native:
            nativeResult,

          custom:
            customResult

        },
        combinedOk
          ? {
              status:
                200
            }
          : {
              status:
                500
            }
      );

    }


    // ========================================================
    // EVERYTHING ELSE
    // ========================================================

    return new Response(
      "Not found",
      {
        status:
          404
      }
    );

  }

};
