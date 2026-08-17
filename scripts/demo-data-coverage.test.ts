// ═══ Every demo asset is either checked in or fetchable (#1730) ═══
//
// The defect this closes: `playground/public/AGENTS.md` says the bulk Natural Earth layers
// are "fetched/generated locally, not checked in", and only the "not checked in" half was
// ever implemented. Thirteen demos shipped in the picker depending on files nobody could
// obtain — no script, no source URL, no record of which upstream file becomes which local
// name. `scripts/fetch-demo-data.ts` is the missing half; this keeps it honest.
//
// The rule: every local asset a demo references must be reachable one of two ways — it is
// checked into `playground/public`, or `DEMO_ASSETS` knows how to fetch it. A third state
// ("referenced, absent, unfetchable") is the bug, and it is the state 13 demos were in.
//
// Pure and offline — it reads the demo sources and the fetch map, and never hits the network.
// Whether the URLs still resolve upstream is a different question that a unit test should not
// be asking on every run; the script's own `curl -f` answers it at the moment it matters.

import { describe, expect, it } from 'vitest'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEMO_ASSETS } from './fetch-demo-data'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXAMPLES = join(ROOT, 'playground/src/examples')
const PUBLIC = join(ROOT, 'playground/public')

/** Every local `url: "…"` a demo declares, resolved the way the dev server resolves it:
 *  a leading `/` is the public root, anything else is relative to `public/data`. */
function referencedAssets(): ReadonlyMap<string, readonly string[]> {
  const byAsset = new Map<string, string[]>()
  for (const file of readdirSync(EXAMPLES).filter((f) => f.endsWith('.xgis'))) {
    const src = readFileSync(join(EXAMPLES, file), 'utf8')
    for (const m of src.matchAll(/url:\s*"([^"]+)"/g)) {
      const u = m[1]!
      // Absolute URLs are somebody else's server; `/pmtiles-proxy/…` and `/opendata/…` are
      // dev-server routes (playground/vite.config.ts), not files on disk. Neither is this
      // gate's business — over-reporting those is exactly the mistake the first sweep made.
      if (/^https?:\/\//.test(u) || u.startsWith('/pmtiles-proxy/') || u.startsWith('/opendata/'))
        continue
      if (u.includes('`') || u.includes('<')) continue // interpolated / prose placeholder
      const rel = u.startsWith('/') ? u.slice(1) : `data/${u}`
      ;(byAsset.get(rel) ?? byAsset.set(rel, []).get(rel)!).push(file)
    }
  }
  return byAsset
}

describe('demo assets are reachable — checked in, or fetchable (#1730)', () => {
  const refs = referencedAssets()

  it('the reader found the corpus', () => {
    // Two empty sets are equal; without a floor a broken regex greens the arm below.
    expect(readdirSync(EXAMPLES).filter((f) => f.endsWith('.xgis')).length).toBeGreaterThan(100)
    expect(refs.size).toBeGreaterThan(20)
  })

  it('no demo references an asset that is neither present nor fetchable', () => {
    const orphans = [...refs]
      .filter(([rel]) => !existsSync(join(PUBLIC, rel)))
      .filter(([rel]) => !Object.hasOwn(DEMO_ASSETS, rel.replace(/^data\//, '')))
      .map(([rel, demos]) => `${rel} — used by ${demos.join(', ')}`)
    expect(
      orphans,
      'these assets are referenced by a demo, absent from playground/public, and unknown to ' +
        'scripts/fetch-demo-data.ts, so the demo cannot work for anyone:\n  ' +
        orphans.join('\n  ') +
        '\nAdd the file, or add it to DEMO_ASSETS with its upstream name.',
    ).toEqual([])
  })

  it('the fetch map has no entry no demo asks for', () => {
    // The other direction. A stale row downloads megabytes nobody needs, and — worse — reads
    // as evidence that some demo still uses it.
    const unused = Object.keys(DEMO_ASSETS).filter((a) => !refs.has(`data/${a}`))
    expect(
      unused,
      `no demo references these; drop them from DEMO_ASSETS:\n  ${unused.join('\n  ')}`,
    ).toEqual([])
  })

  it('the fetch map is non-empty, and the arms above are not comparing nothing', () => {
    expect(Object.keys(DEMO_ASSETS).length).toBeGreaterThan(4)
    // At least one entry must actually be a RENAME, since the rename is the whole reason the
    // map exists rather than a README line listing URLs.
    const renames = Object.entries(DEMO_ASSETS).filter(([local, up]) => `${up}.geojson` !== local)
    expect(renames.length).toBeGreaterThan(0)
  })
})
