# X-GIS PMTiles CORS proxy

A 60-line Cloudflare Worker that proxies
`https://demo-bucket.protomaps.com/v4.pmtiles` (and any other path
under that origin) with `Access-Control-Allow-Origin: *` so the
playground's PMTiles demos work in production from
`https://x-gis.github.io`.

The protomaps demo bucket explicitly rejects CORS preflight
(returns 403 on `OPTIONS` with an `Origin` header), so a browser
running at any origin other than the bucket's own domain can't
fetch the v4 archive directly. The dev server bypasses this with a
Vite proxy; production needs an equivalent edge proxy.

## Deploy

Once-off, requires a Cloudflare account (free tier is plenty).

```bash
# 1. Install wrangler if you don't have it
npm i -g wrangler

# 2. Authenticate (opens a browser to your Cloudflare account)
wrangler login

# 3. Deploy from this directory
cd tools/pmtiles-cors-proxy
wrangler deploy
```

Wrangler prints the deployed URL, something like:

```
Published x-gis-pmtiles-proxy
  https://x-gis-pmtiles-proxy.<your-account>.workers.dev
```

Copy that URL.

## Wire it into the playground

Open `playground/src/demos.ts` and update `PROD_PMTILES_PROXY_BASE`:

```ts
const PROD_PMTILES_PROXY_BASE =
  'https://x-gis-pmtiles-proxy.<your-account>.workers.dev'
//                            ^^^^^^^^^^^^^^^^^ replace
```

Commit + push. The next CI deploy substitutes
`/pmtiles-proxy/protomaps/v4.pmtiles` in the bundled `.xgis`
sources with `<PROD_PMTILES_PROXY_BASE>/v4.pmtiles` at module-load
time, so every PMTiles demo on the deployed playground fetches
through the proxy.

## Test the worker directly

```bash
# Should return 204 with CORS headers (preflight)
curl -i -X OPTIONS \
     -H "Origin: https://x-gis.github.io" \
     -H "Access-Control-Request-Method: GET" \
     -H "Access-Control-Request-Headers: range" \
     https://x-gis-pmtiles-proxy.<your-account>.workers.dev/v4.pmtiles

# Should return 206 Partial Content with the first 127 bytes of
# the v4 archive header
curl -i -H "Range: bytes=0-127" \
     https://x-gis-pmtiles-proxy.<your-account>.workers.dev/v4.pmtiles
```

## Cost

Free Workers tier:

- 100,000 requests / day
- 10 ms CPU / request

This worker uses single-digit ms of CPU per request (it just relays
the body stream). A typical demo session costs ~50 requests
(archive header + visible tiles). Free tier handles ~2,000 demo
loads / day before hitting the limit; well above what
`x-gis.github.io` traffic is going to need anywhere near soon.

Cloudflare edge cache (`cf.cacheTtl: 86400` in `worker.ts`) makes
repeat fetches of the same byte range serve from the closest PoP
without round-tripping to the protomaps bucket — fast for the user,
free for our request budget (cache hits don't count against the
quota).

## Updating the worker

Edit `worker.ts`, run `wrangler deploy`. The deployed URL stays
stable; no playground changes needed.
