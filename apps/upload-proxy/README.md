# Upload bridge

The GitHub Pages app cannot read WordPress uploads or call monday's multipart
file endpoint directly because those servers do not allow cross-origin browser
requests. This Cloudflare Worker performs those requests server-side.

Deploy it with Wrangler:

```bash
npx wrangler secret put MONDAY_API_TOKEN --config apps/upload-proxy/wrangler.jsonc
npx wrangler secret put BRIDGE_KEY --config apps/upload-proxy/wrangler.jsonc
npx wrangler deploy --config apps/upload-proxy/wrangler.jsonc
```

Use a long random value for `BRIDGE_KEY`. Put the resulting Worker URL and that
key into the standalone app's Settings. The monday token stays in Worker
secrets and is never included in the published HTML.

`ALLOWED_ORIGINS` limits browser callers. `REMOTE_FILE_HOSTS` limits which
sites the bridge may download form uploads from. Both are comma-separated and
live in `wrangler.jsonc`.
