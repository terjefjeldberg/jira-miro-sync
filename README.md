# Jira ↔ Miro sync

Cloudflare Worker that keeps the StreamBIM Jira workflow and Miro board in sync.

## Architecture

The production code is intentionally small and split by responsibility:

- `src/index.js` — HTTP routes and orchestration. Start here when tracing a request.
- `src/config.js` — project IDs, field IDs, workflow geometry, KV key names and environment overrides.
- `src/auth.js` — Miro JWT, Jira webhook secret, CORS and response helpers.
- `src/jira.js` — Jira reads, issue creation, transitions and Reporter resolution.
- `src/miro.js` — Miro REST item lookup, movement, mapping and Incoming layout.
- `src/cards.js` — one shared custom-card renderer plus create/refresh/dedupe logic.
- `src/ui.js` — the small Miro app client and conversion panel client.

There are no patch-on-patch wrapper files. A behavior should have one implementation and one obvious home.

## Main flows

### Jira → Miro

`POST /` receives Jira Automation webhooks. Creation / manual `ensure_card`
events are persisted in `MIRO_CARD_DELIVERY`, one Durable Object per board and
issue. HTTP 202 means accepted/pending, never confirmed. An alarm processes the
job and reads the actual image back from Miro, checking its issue key, geometry
and (for a new upload) Incoming parent before logging `Miro card delivery
confirmed` with the issue key, board, item ID and timestamp. Other webhooks use
the queue below. The Worker:

1. validates `X-Webhook-Secret`;
2. reads Jira's live status;
3. looks up custom-card mappings in KV;
4. refreshes custom-card content;
5. moves mapped cards horizontally while preserving Y;
6. creates an Incoming custom card only for an explicitly marked issue-creation event with no mapping;
7. leaves cards in Incoming parked until a user manually places them on the workflow board.

### Miro card → Jira status

The Miro app watches card/image movement. After debounce and the 60% column-overlap rule it calls:

- `POST /custom-miro-to-jira` for custom image cards.

Jira rejection causes a Miro rollback. Required fields are enforced by Jira transition validators for each work type.

### Sticky → Jira

The conversion panel supports one or many sticky notes:

1. resolve the sticky creator to Jira Reporter;
2. create the Jira issue with required defaults;
3. store the original Miro creation timestamp;
4. create the custom card directly at the sticky's exact canvas position;
5. apply the workflow status when the sticky is inside a workflow column;
6. remove the sticky only after successful card creation.

Sticky conversion never uses Incoming. A short-lived KV flag suppresses the Jira-created webhook until the direct card exists. The sticky ID is also cached to the Jira issue for 24 hours, so retrying after a partial failure reuses the same Jira issue instead of creating a duplicate.

## KV keys

- `custom-card:<issue>` — custom image card Miro item ID (legacy group IDs are still supported).
- `reporter-account:<miro-user-id>` — cached Jira Reporter account ID.
- `conversion-freeze:<issue>` — prevents a conversion status transition from moving the new card.
- `conversion-direct-pending:<issue>` — prevents sticky conversion from creating an Incoming card.
- `conversion-sticky:<miro-sticky-id>` — short-lived sticky → Jira issue idempotency mapping.

## Environment / production migration

Secrets and environment-specific IDs belong in Cloudflare variables, not business logic.

Required bindings/variables:

- `CARD_MAP` KV namespace
- `MIRO_CARD_DELIVERY` SQLite Durable Object binding and `v1-card-delivery` migration
- `MIRO_CLIENT_SECRET`
- `MIRO_TOKEN`
- `MIRO_BOARD_ID`
- `JIRA_API_TOKEN`
- `JIRA_CLOUD_ID`
- `JIRA_WEBHOOK_SECRET`

Optional overrides (current dev values are defaults):

- `JIRA_PROJECT_KEY`
- `JIRA_SITE_URL`
- `MIRO_INCOMING_FRAME_ID`
- `WORKFLOW_LAYOUT_JSON`
- `STATUS_OVERLAP_THRESHOLD`
- `JIRA_FIELD_ORIGINAL_MIRO_CREATED`
- `JIRA_FIELD_BUG_REPRO`
- `JIRA_FIELD_BUG_CUSTOMER`
- `JIRA_FIELD_FUNCTIONAL_AREA`
- `JIRA_FIELD_TEST_DESCRIPTION`
- `JIRA_FIELD_HOTFIX_CANDIDATE`

Production currently uses project key `ROV`, Worker `jira-to-miro-prod` and queue `jira-to-miro-prod-events`.

Card delivery has no application retry count or expiry. Failed jobs retain their
payload and last error and reschedule themselves after 15, 30, 60 seconds, then
increasing delays up to one hour. The next alarm is saved before external I/O.
Credentials/permissions and full Incoming errors also remain pending until fixed.
Known upload IDs survive placement failures and are repaired instead of deleted
and uploaded again. Unknown upload outcomes get a visibility grace period and a
complete board scan before another upload; an incomplete scan fails closed.
Miro has no transactional exactly-once upload contract, so a lost response plus
delayed visibility can still produce duplicates; normal Incoming deduplication
remains in place. Queue retry exhaustion no longer discards creation obligations.
Existing incidents must be submitted once more with `event: "ensure_card"` after
deploying; they cannot be reconstructed from already discarded queue messages.
Functional area and Test description are validated by the Jira transition to Functional Review, not during issue creation. Sticky creation only applies the Bug-specific defaults when the work type is Bug.

Jira Automation web requests must include `"event":"created"` in the rule that runs when a work item is created. Status and field-sync rules must omit that marker (or use another event value). This prevents an update to an existing Jira issue from creating a new Incoming card.

For production migration, create a separate Worker/KV namespace and set these variables to production values. No code fork should be necessary.

## Debugging

### Safe workflow positioning

Status/field webhooks are durably stored in a per-board/issue status job using
the existing `MiroCardDelivery` binding, separate from card creation. The Queue
also hands existing update messages to that job. It retries after 5–60 seconds
without a finite attempt limit, reading the current Jira status each time.
Duplicate updates coalesce without discarding a pending content refresh.
Image reads allow 30 seconds; a timeout never confirms placement. Receipts and
pending failures are available at `status-delivery:<issue>`. Completion requires
verified placement or an explicit non-applicable result (e.g. a parked card).
Quarantine still blocks writes; persistent retries never bypass safety checks.

Production pins `MIRO_WORKFLOW_FRAME_ID=3458764684156039511`. Workflow moves
always send this parent plus `position.relativeTo=parent_top_left`, keeping Y
in that frame's local coordinates. Bare position writes are rejected. Canvas
coordinates are converted before writing; missing/ambiguous references fail
closed. A card outside the workflow or in Incoming stays parked.

Each write rechecks the source position, saves `move-before:<issue>`, then reads
the image back and verifies its identity, parent, destination and Y before
saving `move-confirmed:<issue>`. A mismatched successful response stores
`move-quarantine:<image-id>` and blocks further automatic moves of that image.
`Miro status position confirmed` is logged only after read-back succeeds.
Use image/frame-specific GET endpoints. For a confirmed child of the pinned
frame, local positioning needs no absolute frame offset: if the frame-detail
API fails, configured local bounds remain usable with explicit parent/reference
and mandatory image read-back. This fallback never applies to canvas positions
or an unrecognized frame. Frame lookup failures are backed off for 30 seconds.

Collision checks read only frame children with a two-second budget, without
per-image parent requests. Jira author-history lookup runs through the queue's
execution context in the background rather than holding up a movement.

Protected Jira webhook/Cloudflare queue maintenance events `inspect_position`
and `repair_position` save `position-inspection:<issue>` and
`position-repair:<issue>`. Repair requires the pinned parent, an explicit local
Y, and a matching live Jira status; it uses the same verified write routine.
These are operator recovery commands, not automatic relocation of parked cards.

### Status and movement audit

Cloudflare Logs messages `Jira status change` and `Miro card movement` include
the issue key, source, positions/statuses, outcome and attribution evidence.
The same records are retained for 90 days in CARD_MAP under
`audit:jira:<issue>:<changelog-id>` and `audit:miro:<issue>:<event-id>:<record-id>`.
Jira account ID and display name come from Jira's own recent changelog, not the
webhook caller or rule actor. Recent status history is caught up and deduplicated
on incoming status webhooks; lookup failures are logged without blocking sync.
Miro records contain the signed JWT `user` as `requesterMiroUserId` (`sub` is the
app client ID). This observer is never assumed to be the mover. Attribution uses
Miro REST modifiedBy only when it matches the SDK movement metadata's time and
canvas position. `actorMiroUserId` / `actorName` then describe Miro's verified
last modifier at that position, not proof of a physical drag gesture. When an
API error, concurrent edit, or legacy client prevents verification, attribution
is explicitly unknown; `observedMiroUserId` remains unverified evidence only.
Several viewers can observe one move: matching eventId groups their records.
Moves outside workflow columns are recorded via `/card-movement` too. Pure
metadata updates and sub-pixel changes do not create movement records.

Collaborators must reload the Miro board to load app client v26. Already-open
legacy clients keep syncing but cannot supply historical mover evidence. No
past human identity can be reconstructed from the former generic HTTP logs.

Start from the endpoint in `src/index.js`. Responses include `stage`, Jira/Miro HTTP status and error text for external failures. Keep errors structured this way when adding functionality.

Useful checks after a change:

1. `GET /health` reports required bindings.
2. Jira-created issue creates exactly one Incoming card.
3. Jira status change moves the mapped card and preserves Y.
4. Miro drag changes Jira status; rejection rolls back.
5. Functional review rejects missing required fields for the current work type and Miro rolls the card back.
6. Sticky conversion preserves exact position, Reporter, original timestamp and required defaults.
7. Multi-select conversion continues after an individual failure.
8. Jira field changes refresh the custom-card SVG.

## Live verification order

Run these against the production Worker after a verified deployment:

1. Open the Miro app and confirm `/health`, panel opening and existing-card discovery.
2. Create one Jira issue and verify one — and only one — Incoming card.
3. Change that Jira issue through every approved status and verify X movement with Y preserved.
4. Drag a custom card through every column and verify Jira follows the 60% rule.
5. Attempt Functional review with the required fields empty for Bug, Improvement, New Feature and Task/config/doc/test; verify rollback, then fill the fields and retry.
6. Change summary, priority and assignee in Jira and verify the existing Miro card refreshes without duplication.
7. Convert one sticky outside the workflow board and verify exact position + default Jira status.
8. Convert one sticky in each workflow column and verify exact position + inherited Jira status.
9. Convert multiple stickies in one selection and verify per-item failure isolation.
10. Force/retry a conversion after Jira issue creation and verify the same issue/card is reused.
11. Create an issue directly in Jira while sticky conversion is happening and verify the Jira-created issue still goes to Incoming while the sticky-originated issue does not.
12. Verify Reporter, Original Miro created and required work-type defaults for Bug, Improvement, New Feature and Task/config/doc/test.

## Safe rollback

The previous production snapshot remains available in Git history for rollback.
## Developer guide

See [ARCHITECTURE.md](ARCHITECTURE.md) for the runtime flows, module responsibilities, required secrets and safe Miro-client change points.
