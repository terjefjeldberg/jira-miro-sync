# Architecture

This Worker synchronizes Jira issues and custom Miro image cards for the SN project.

## Runtime flow

### Jira to Miro

1. Jira Automation sends a `POST /` request with `X-Webhook-Secret`.
2. `src/index.js` validates the request and reads the live Jira status.
3. The Worker resolves the custom-card mapping from KV.
4. If the mapping is missing, it scans Miro images for the card title `CUSTOM_JIRA_CARD:SN-123` and repairs the KV mapping.
5. `src/cards.js` refreshes the SVG content.
6. `src/miro.js` moves the image to the mapped workflow column and preserves Y.

The position update is intentionally the final Miro write.

### Miro to Jira

1. The Miro app listens for `experimental:items:update`.
2. It debounces the settled image position.
3. It applies the 60% overlap rule from `src/config.js`.
4. It calls `POST /custom-miro-to-jira`.
5. The Worker transitions Jira and stores the card mapping in KV.

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `src/index.js` | HTTP routes and orchestration |
| `src/jira.js` | Jira REST calls, status transitions and issue data |
| `src/miro.js` | Miro REST calls, mapping recovery and movement |
| `src/cards.js` | SVG generation, card creation and refresh |
| `src/config.js` | Status columns, thresholds, field IDs and defaults |
| `src/auth.js` | CORS, JSON responses and request authentication |
| `src/ui.js` | HTML shells for the Miro app and conversion panel |
| `src/app-client.js` | Miro board event client |
| `src/panel-client.js` | Sticky-note conversion panel client |

## Required runtime configuration

The Worker requires these values:

- `MIRO_TOKEN`: Miro REST API token with board read/write access
- `MIRO_BOARD_ID`: the Current Sprint board ID
- `MIRO_CLIENT_SECRET`: Miro app client secret for identity tokens
- `JIRA_API_TOKEN`: Jira API token
- `JIRA_CLOUD_ID`: Jira cloud ID
- `JIRA_WEBHOOK_SECRET`: shared secret configured in Jira Automation
- `CARD_MAP`: Cloudflare KV namespace binding

If Jira reports Miro HTTP 401 with `tokenNotProvided`, check `MIRO_TOKEN` in the production Worker secrets first.

## Testing and deployment

Run locally:

```bash
npm run verify
```

A successful push to `main` runs verification and deploys the production Worker through `.github/workflows/verify.yml`.

When changing the Miro client, preserve:

- the Miro SDK URL
- the `/miro-app`, `/app.js`, `/miro-panel` and `/panel.js` routes
- the `experimental:items:update` listener
- the initial `register()` call
- the browser-side Miro identity-token request
