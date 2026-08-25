# Mail Intake

Mail Intake turns `.eml` and Outlook `.msg` enquiries into reviewed monday.com
items. It extracts customer details, keeps useful attachments, ignores email
branding, and prevents the same message from being imported twice.

There are two ways to run it:

| Project | Use it when | Output |
| --- | --- | --- |
| Full-stack app | A local Node service is available | SQLite-backed queue with server-side downloads and monday uploads |
| Standalone app | The UI must live on GitHub Pages | One HTML file plus the upload bridge |

## Full-stack app

Requires Node.js 24 and a monday personal API token with access to the target
board.

```bash
npm ci
cp .env.example .env
# Set MONDAY_API_TOKEN in .env
npm run dev
```

Open <http://127.0.0.1:5173>, then use **Settings** to select the board, group,
and columns. The API runs on port 3001 during development.

For Windows production:

```powershell
Copy-Item .env.example .env
# Set MONDAY_API_TOKEN in .env
.\operations\windows\setup.ps1
```

The production UI is served at <http://127.0.0.1:3000>. Its SQLite database and
customer files live in `data/`; back up that directory.

## GitHub Pages app

A browser cannot upload directly to monday's multipart file endpoint or read
WordPress uploads that omit CORS headers. The standalone app therefore uses the
small Cloudflare Worker in `apps/upload-proxy` for all monday requests and
remote-file downloads.

First deploy the bridge:

```bash
npx wrangler secret put MONDAY_API_TOKEN --config apps/upload-proxy/wrangler.jsonc
npx wrangler secret put BRIDGE_KEY --config apps/upload-proxy/wrangler.jsonc
npm run proxy:deploy
```

Use a long random value for `BRIDGE_KEY`. The monday token stays in Cloudflare;
the published HTML only stores the bridge URL and bridge key. Check
`ALLOWED_ORIGINS` and `REMOTE_FILE_HOSTS` in
`apps/upload-proxy/wrangler.jsonc` before deploying.

Build the page:

```bash
npm ci
npm run build:standalone
```

Publish the contents of `artifacts/github-pages/`. Open the page's **Settings**
and enter the Worker URL, bridge key, board ID, and column mapping.

The queue is deliberately temporary and clears on refresh. Remote-file
downloads open the original URL in a new tab; imports are fetched server-side
by the bridge.

## Project layout

```text
apps/
  full-stack/       React UI and Fastify/SQLite service
  standalone/       Browser-only mail parser and UI
  upload-proxy/     Cloudflare Worker for CORS-safe monday uploads
packages/
  mail-parser/      Shared lead types and extraction rules
operations/
  windows/          PM2 configuration and setup script
tests/
  unit/             Focused parser, downloader, monday, and attachment tests
  integration/      Service, standalone, bridge, and local regression tests
  e2e/              Playwright browser workflow
tools/              Build scripts
artifacts/           Generated builds; safe to delete and rebuild
.local/              Private fixtures, test output, and old archives
```

Real customer mail belongs under `.local/fixtures/`, never in source control.
The 25 August regression batch is stored at
`.local/fixtures/regression/2026-08-25/`.

## Checks

```bash
npm run check
npx playwright install chromium
npm run test:e2e
```

`npm run check` type-checks the three apps, runs the unit and integration tests,
and builds both production variants.
