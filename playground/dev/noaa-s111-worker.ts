// ═══ NOAA production CORS proxy — Cloudflare Worker ═══
//
// The hosted playground (GitHub Pages) can't proxy the CORS-less NOAA S3 buckets itself
// — a static site has no server. This Worker is that server: the SAME general contract
// the vite dev middleware serves locally (`/noaa/<bucket>/…` passthrough for any NOAA
// bucket + the S-111 `/noaa-s111/latest[/<model>].h5` conveniences), so the live demos
// stream real NOAA data on the deployed site too. It shares `handleNoaa` with the dev
// proxy — one authority, no drift.
//
// Deploy (from playground/, one time; the x-gis account owns the worker subdomain):
//   npx wrangler deploy dev/noaa-s111-worker.ts --name noaa-s111 --compatibility-date 2024-01-01
// That publishes https://noaa-s111.x-gis.workers.dev/ — the origin loader.ts rewrites the
// `/noaa/` and `/noaa-s111/` paths to in production. Until it's deployed the demos degrade
// to imagery-only on the hosted site (they are fully live in local dev via the vite proxy).

import { handleNoaa } from './noaa-s111-proxy'

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
    return handleNoaa(url.pathname + url.search, request.headers.get('range'))
  },
}
