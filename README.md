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

`POST /` receives Jira Automation webhooks. The Worker:

1. validates `X-Webhook-Secret`;
2. reads Jira's live status;
3. looks up native/custom Miro mappings in KV;
4. refreshes custom-card content;
5. moves mapped cards horizontally while preserving Y;
6. creates an Incoming custom card only when a Jira-created issue has no mapping.

### Miro card → Jira status

The Miro app watches card/image movement. After debounce and the 60% column-overlap rule it calls:

- `POST /miro-to-jira` for native Jira cards;
- `POST /custom-miro-to-jira` for custom image cards.

Jira rejection causes a Miro rollback. Moving to Functional review is rejected when Test area is empty.

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

- `jira-card:<issue>` — native Jira card Miro item ID.
- `custom-card:<issue>` — custom image card Miro item ID (legacy group IDs are still supported).
- `reporter-account:<miro-user-id>` — cached Jira Reporter account ID.
- `conversion-freeze:<issue>` — prevents a conversion status transition from moving the new card.
- `conversion-direct-pending:<issue>` — prevents sticky conversion from creating an Incoming card.
- `conversion-sticky:<miro-sticky-id>` — short-lived sticky → Jira issue idempotency mapping.

## Environment / production migration

Secrets and environment-specific IDs belong in Cloudflare variables, not business logic.

Required bindings/variables:

- `CARD_MAP` KV namespace
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
- `JIRA_FIELD_TEST_AREA`
- `JIRA_FIELD_ORIGINAL_MIRO_CREATED`
- `JIRA_FIELD_BUG_REPRO`
- `JIRA_FIELD_BUG_CUSTOMER`
- `JIRA_FIELD_NF_DROPDOWN_1`
- `JIRA_FIELD_NF_TEXT_1`
- `JIRA_FIELD_NF_TEXT_2`
- `JIRA_FIELD_NF_DROPDOWN_2`
- `JIRA_FIELD_TASK_REQUIRED`

For production migration, create a separate Worker/KV namespace and set these variables to production values. No code fork should be necessary.

## Debugging

Start from the endpoint in `src/index.js`. Responses include `stage`, Jira/Miro HTTP status and error text for external failures. Keep errors structured this way when adding functionality.

Useful checks after a change:

1. `GET /health` reports required bindings.
2. Jira-created issue creates exactly one Incoming card.
3. Jira status change moves the mapped card and preserves Y.
4. Miro drag changes Jira status; rejection rolls back.
5. Functional review gate still rejects missing Test area.
6. Sticky conversion preserves exact position, Reporter, original timestamp and required defaults.
7. Multi-select conversion continues after an individual failure.
8. Jira field changes refresh the custom-card SVG.

## Live verification order before merge

Run these against a separately deployed refactor Worker before changing `main`:

1. Open the Miro app and confirm `/health`, panel opening and existing-card discovery.
2. Create one Jira issue and verify one — and only one — Incoming card.
3. Change that Jira issue through every approved status and verify X movement with Y preserved.
4. Drag a custom card through every column and verify Jira follows the 60% rule.
5. Attempt Functional review with empty Test area and verify rollback; fill Test area and retry.
6. Change summary, priority and assignee in Jira and verify the existing Miro card refreshes without duplication.
7. Convert one sticky outside the workflow board and verify exact position + default Jira status.
8. Convert one sticky in each workflow column and verify exact position + inherited Jira status.
9. Convert multiple stickies in one selection and verify per-item failure isolation.
10. Force/retry a conversion after Jira issue creation and verify the same issue/card is reused.
11. Create an issue directly in Jira while sticky conversion is happening and verify the Jira-created issue still goes to Incoming while the sticky-originated issue does not.
12. Verify Reporter, Original Miro created and required work-type defaults for Bug, Improvement, New Feature and Task/config/doc/test.

Only after this list passes should the refactor replace `main`.

## Safe rollback

The pre-refactor working snapshot is preserved on branch `backup/pre-refactor-2026-08-31`.
## Developer guide

See [ARCHITECTURE.md](ARCHITECTURE.md) for the runtime flows, module responsibilities, required secrets and safe Miro-client change points.
