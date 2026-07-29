// ═══ The open-data bridge in production — Cloudflare Worker ═══
//
// The hosted playground (GitHub Pages) can't proxy the CORS-less open-data origins itself —
// a static site has no server. This Worker is that server: the SAME `/opendata/…` contract
// the vite dev middleware serves locally, so the live demos stream real data on the deployed
// site too. It shares `handleOpenData` with the dev bridge — one authority, no drift.
//
// Deploy from playground/ (config in wrangler.toml; CLOUDFLARE_API_TOKEN in the environment):
//   npx wrangler deploy
// That publishes https://opendata-bridge.x-gis.workers.dev/ — the origin loader.ts rewrites
// `/opendata/` to in production. Until it's deployed the demos degrade to imagery-only on the
// hosted site (they are fully live in local dev via the vite bridge).

import { handleOpenData, corsHeaders } from './opendata-bridge'

export default {
  fetch(request: Request): Promise<Response> {
    const origin = request.headers.get('origin')
    if (request.method === 'OPTIONS') {
      return Promise.resolve(
        new Response(null, {
          headers: {
            ...corsHeaders(origin),
            'access-control-allow-methods': 'GET, HEAD, OPTIONS',
            'access-control-allow-headers': 'range',
          },
        }),
      )
    }
    const url = new URL(request.url)
    return handleOpenData(url.pathname + url.search, request.headers.get('range'), origin)
  },
}
