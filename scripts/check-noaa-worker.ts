// ═══ Does the DEPLOYED NOAA worker serve what the demos now ask for? ═══
//
// The hosted site and the Cloudflare Worker are deployed SEPARATELY: `deploy-pages.yml` ships
// the site on every push to main, while the worker goes out by hand
// (`npx wrangler deploy dev/noaa-s111-worker.ts --name noaa-s111 …`). Nothing tied them
// together, so a demo could start asking for a worker route that did not exist yet, and the
// only symptom was a 404 on the live site.
//
// That is not hypothetical — it is what #1453 shipped. `s111-live.xgis` moved to
// `url: "/noaa-s111/catalog.json"`, the site deployed with it, and the worker was still
// running code with no catalogue route. The request fell through to the explicit
// `noaa-s111/<key>` passthrough, S3 was asked for an object literally named `catalog.json`,
// and S-111 Live went dead in production while every local gate and every CI leg was green:
// the dev proxy and the worker share `handleNoaa`, so they agree in the SOURCE, which is
// exactly what made the divergence invisible.
//
// So this reads the routes from the DEMOS rather than from a list someone must remember to
// update — the same lesson as the proxy's own prefix matcher, which broke on the third
// product for being a hand-maintained list. Every `/noaa…` URL any `.xgis` example declares
// must answer from the deployed worker.
//
//   node --experimental-strip-types scripts/check-noaa-worker.ts [--origin https://…]
//
// NODE, not bun, and that is not incidental: in a proxied environment bun's fetch fails to
// reach the worker at all, and this script then reports every route "unreachable" — a verdict
// that happens to be red for the wrong reason, which is worse than being wrong. node's fetch
// honours the proxy, so a failure here is the worker's, not the runner's.
//
// Exit 0 = the deployed worker satisfies the demos. Exit 1 = redeploy it (the failing routes
// are printed with what they answered).

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXAMPLES = join(ROOT, 'playground', 'src', 'examples')
/** Mirrors `playground/src/demos/loader.ts`'s production rewrite target. */
const DEFAULT_ORIGIN = 'https://noaa-s111.x-gis.workers.dev'

/** Every `/noaa…` path the shipped demos declare, deduplicated. */
export function demoNoaaRoutes(dir = EXAMPLES): string[] {
  const found = new Set<string>()
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.xgis')) continue
    const text = readFileSync(join(dir, name), 'utf8')
    for (const m of text.matchAll(/"(\/noaa[^"]*)"/g)) found.add(m[1]!)
  }
  return [...found].sort()
}

/** A route is satisfied when the worker answers 2xx AND does not hand back an S3 error
 *  document. The second half matters: a missing route falls through to the key passthrough,
 *  which returns S3's own 404 XML — a shape a naive status check could mistake for the
 *  worker being fine if the bucket ever answered 200 for a stray key. */
async function probe(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { headers: { Origin: 'https://x-gis.github.io' } })
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok) {
      const body = (await res.text()).slice(0, 120).replace(/\s+/g, ' ')
      return { ok: false, detail: `HTTP ${res.status} ${type} — ${body}` }
    }
    if (type.includes('xml')) return { ok: false, detail: `HTTP 200 but S3 XML (${type})` }
    return { ok: true, detail: `HTTP ${res.status} ${type}` }
  } catch (e) {
    return { ok: false, detail: `unreachable — ${(e as Error).message}` }
  }
}

const originArg = process.argv.indexOf('--origin')
const origin = originArg > -1 ? process.argv[originArg + 1]! : DEFAULT_ORIGIN
const routes = demoNoaaRoutes()

if (routes.length === 0) {
  console.error('no /noaa routes found in playground/src/examples — has the layout moved?')
  process.exit(1)
}

console.log(`Checking ${routes.length} demo-declared NOAA route(s) against ${origin}\n`)
const failures: string[] = []
for (const route of routes) {
  const { ok, detail } = await probe(origin + route)
  console.log(`  ${ok ? '✓' : '✗'} ${route}  ${detail}`)
  if (!ok) failures.push(route)
}

if (failures.length > 0) {
  console.error(
    `\n${failures.length} route(s) the demos need are NOT served by the deployed worker:\n` +
      failures.map((r) => `  ${r}`).join('\n') +
      `\n\nRedeploy it from playground/:\n` +
      `  npx wrangler deploy dev/noaa-s111-worker.ts --name noaa-s111 --compatibility-date 2024-01-01\n`,
  )
  process.exit(1)
}
console.log('\nAll demo-declared NOAA routes are served.')
