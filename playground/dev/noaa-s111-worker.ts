// ═══ NOAA S-111 production CORS proxy — Cloudflare Worker ═══
//
// The hosted playground (GitHub Pages) can't proxy the CORS-less NOAA S3 bucket itself
// — a static site has no server. This Worker is that server: the SAME resolve+stream
// contract the vite dev middleware serves locally, so the `s111_live` demo streams real
// NOAA data on the deployed site too. It shares `handleNoaaS111` with the dev proxy —
// one authority, no drift.
//
// Deploy (from playground/, one time; the x-gis account owns the worker subdomain):
//   npx wrangler deploy dev/noaa-s111-worker.ts --name noaa-s111 --compatibility-date 2024-01-01
// That publishes https://noaa-s111.x-gis.workers.dev/ — the URL loader.ts rewrites
// `/noaa-s111/` to in production. Until it's deployed the demo degrades to imagery-only
// on the hosted site (it is fully live in local dev via the vite proxy).

import { handleNoaaS111 } from './noaa-s111-proxy'

export default {
  fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return Promise.resolve(
        new Response(null, {
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, HEAD, OPTIONS',
            'access-control-allow-headers': 'range',
          },
        }),
      )
    }
    const url = new URL(request.url)
    // Routed at the worker root, so the pathname IS the cell path (`/latest.h5` or a key).
    return handleNoaaS111(url.pathname + url.search, request.headers.get('range'))
  },
}
