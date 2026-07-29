// ═══ Does the DEPLOYED open-data bridge serve what the demos now ask for? ═══
//
// The hosted site and the Cloudflare Worker are deployed SEPARATELY: `deploy-pages.yml` ships
// the site on every push to main, while the worker goes out by hand (`npx wrangler deploy`
// from playground/). Nothing tied them together, so a demo could start asking for a worker
// route that did not exist yet, and the only symptom was a 404 on the live site.
//
// That is not hypothetical — it is what #1453 shipped. `s111-live.xgis` moved to a catalogue
// URL, the site deployed with it, and the worker was still running code with no catalogue
// route. The request fell through to the key passthrough, S3 was asked for an object literally
// named `catalog.json`, and S-111 Live went dead in production while every local gate and
// every CI leg was green: the dev bridge and the worker share `handleOpenData`, so they agree
// in the SOURCE, which is exactly what made the divergence invisible.
//
// So this reads the routes from the DEMOS rather than from a list someone must remember to
// update — the same lesson as the bridge's own prefix matcher, which broke on the third
// product for being a hand-maintained list. Every `/opendata/…` URL any `.xgis` example
// declares must answer from the deployed worker.
//
// That is the catalogue URLs in practice, and checking them is worth more than it looks: a
// catalogue's asset hrefs are relative, so a 200 here means the CELLS resolve to this same
// origin too. The unit suite pins that an emitted href is a path the bridge serves.
//
//   node --experimental-strip-types scripts/check-opendata-bridge.ts [--origin https://…]
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
const DEFAULT_ORIGIN = 'https://opendata-bridge.x-gis.workers.dev'

/** Every `/opendata/…` path the shipped demos declare, deduplicated. */
export function demoOpenDataRoutes(dir = EXAMPLES): string[] {
  const found = new Set<string>()
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.xgis')) continue
    const text = readFileSync(join(dir, name), 'utf8')
    for (const m of text.matchAll(/"(\/opendata\/[^"]*)"/g)) found.add(m[1]!)
  }
  return [...found].sort()
}

/** A route is satisfied when the worker answers 2xx AND does not hand back an S3 error
 *  document. The second half matters: a missing route falls through to the key passthrough,
 *  which returns S3's own 404 XML — a shape a naive status check could mistake for the
 *  worker being fine if the bucket ever answered 200 for a stray key. */
async function probeOnce(url: string): Promise<{ ok: boolean; detail: string; retry: boolean }> {
  try {
    const res = await fetch(url, { headers: { Origin: 'https://x-gis.github.io' } })
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok) {
      const body = (await res.text()).slice(0, 120).replace(/\s+/g, ' ')
      // A 5xx is the EDGE failing, not the route missing — a colo still mid-rollout answers
      // a Cloudflare HTML error page. A missing route is a 403/404 from the bridge itself and
      // is never retried, so the two verdicts stay distinguishable.
      return { ok: false, detail: `HTTP ${res.status} ${type} — ${body}`, retry: res.status >= 500 }
    }
    if (type.includes('xml'))
      return { ok: false, detail: `HTTP 200 but S3 XML (${type})`, retry: false }

    // A 200 is not enough for a synthesised catalogue: its items are resolved against a live
    // bucket and a failed one is DROPPED, so a half-built catalogue answers exactly like a whole
    // one. That is not hypothetical — Cloudflare's 50-subrequest cap silently cut the S-111
    // catalogue to 5 of 12 models in production while this check said ✓. STAC's own
    // `numberMatched`/`numberReturned` carry the difference; a shortfall is a red.
    if (type.includes('json')) {
      const doc = (await res.json()) as { numberMatched?: number; numberReturned?: number }
      const { numberMatched: want, numberReturned: got } = doc
      if (typeof want === 'number' && typeof got === 'number' && got < want)
        return {
          ok: false,
          detail: `HTTP 200 but PARTIAL — ${got}/${want} items resolved`,
          retry: false,
        }
      if (typeof got === 'number')
        return {
          ok: true,
          detail: `HTTP ${res.status} ${type} — ${got}/${want} items`,
          retry: false,
        }
    }
    return { ok: true, detail: `HTTP ${res.status} ${type}`, retry: false }
  } catch (e) {
    return { ok: false, detail: `unreachable — ${(e as Error).message}`, retry: true }
  }
}

/** `probeOnce` with ONE retry on a transient. Observed once for real: run seconds after a
 *  `wrangler deploy` and a colo still propagating the new version answers 500 on a route the
 *  worker serves perfectly a moment later. A gate that cries wolf is a gate people stop
 *  reading, and this one's whole value is that a red means "redeploy". */
async function probe(url: string): Promise<{ ok: boolean; detail: string }> {
  const first = await probeOnce(url)
  if (first.ok || !first.retry) return first
  await new Promise((r) => setTimeout(r, 2000))
  const second = await probeOnce(url)
  return second.ok ? second : { ok: false, detail: `${second.detail} (twice)` }
}

const originArg = process.argv.indexOf('--origin')
const origin = originArg > -1 ? process.argv[originArg + 1]! : DEFAULT_ORIGIN
const routes = demoOpenDataRoutes()

if (routes.length === 0) {
  console.error('no /opendata routes found in playground/src/examples — has the layout moved?')
  process.exit(1)
}

console.log(`Checking ${routes.length} demo-declared open-data route(s) against ${origin}\n`)
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
      `\n\nRedeploy it from playground/:\n  npx wrangler deploy\n`,
  )
  process.exit(1)
}
console.log('\nAll demo-declared open-data routes are served.')
