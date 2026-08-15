// ═══ Fetch the bulk demo assets the repo deliberately does not carry (#1730) ═══
//
//     bun run fetch:demo-data
//
// `playground/public/AGENTS.md` states the policy:
//
//     Higher-resolution Natural Earth (`ne_10m_*` / `ne_50m_*`) … are gitignored bulk
//     assets FETCHED/GENERATED LOCALLY, not checked in.
//
// Only the "not checked in" half was implemented. Nothing in the repo fetched them, named a
// source, or recorded which upstream file becomes which local name — so 13 demos shipped in
// the picker depending on assets no one could obtain without reverse-engineering. This is
// the missing half.
//
// WHY NOT CHECK THEM IN: 73.8 MB measured, `ne_10m_states` alone 38.8 MB. The policy is
// right; it just had no implementation.
//
// ── The rename is REAL, and it is why this file exists rather than a README line ──
//
// The local names are not upstream names. `ne_50m_rivers.geojson` is upstream's
// `ne_50m_rivers_lake_centerlines.geojson`; `ne_50m_states.geojson` is
// `ne_50m_admin_1_states_provinces.geojson`. Verified against the one checked-in file that
// pins the convention: local `ne_110m_rivers.geojson` and upstream
// `ne_110m_rivers_lake_centerlines.geojson` agree at 13 features, while `ne_110m_rivers` is
// a 404 upstream. A human could not guess this mapping; that is the whole discoverability
// problem this closes.
//
// ── What this deliberately does NOT do: prune properties ──
//
// The checked-in 110m files were also property-pruned — local `ne_110m_rivers` keeps 7 of
// upstream's 35 keys, dropping the localised `name_*` columns. That was a size optimisation
// for files that travel in git, and it is NOT reproducible as one rule: `ne_110m_land` keeps
// 3 keys, `populated_places` keeps 37, and `ne_110m_countries` carries 71 UPPERCASE keys from
// an entirely different vintage (it even preserves upstream's `min_zooom` typo in
// `ne_110m_coastline`). There is no single recipe to re-run.
//
// Copying raw is safe here, and that was checked rather than assumed: of the 13 demos that
// need these files, 11 style by geometry alone and read no properties at all. The only two
// that read one — `states-10m` and `states-provinces`, both reading `admin` — get it, because
// upstream's admin-1 dataset carries `admin`. So the extra columns cost disk and change
// nothing. If someone later wants them smaller, that is a measured optimisation with its own
// reason, not a silent transformation buried in a fetch step.

// ── Why curl and not the runtime's own fetch ──
//
// Measured in this repo's container dev environment: `curl` pulls both a 0.8 MB and a 9.7 MB
// asset fine, while bun's global `fetch` fails on the SAME 0.8 MB URL — outbound HTTPS goes
// through an agent proxy with its own CA bundle, which curl honours from the environment and
// the runtime's fetch does not. curl is also the better tool for 40 MB downloads regardless.
// Not a try-fetch-then-fall-back-to-curl pair: that is two code paths and two failure modes
// for a dev-only script, where one that always works is enough.

import { spawnSync } from 'node:child_process'
import { mkdirSync, existsSync, statSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEST = join(ROOT, 'playground/public/data')
const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson'

/** local filename → the upstream Natural Earth basename it is a copy of. */
export const DEMO_ASSETS: Readonly<Record<string, string>> = {
  'ne_10m_land.geojson': 'ne_10m_land',
  'ne_10m_ocean.geojson': 'ne_10m_ocean',
  'ne_10m_lakes.geojson': 'ne_10m_lakes',
  'ne_10m_rivers.geojson': 'ne_10m_rivers_lake_centerlines',
  'ne_10m_states.geojson': 'ne_10m_admin_1_states_provinces',
  'ne_50m_lakes.geojson': 'ne_50m_lakes',
  'ne_50m_rivers.geojson': 'ne_50m_rivers_lake_centerlines',
  'ne_50m_states.geojson': 'ne_50m_admin_1_states_provinces',
}

/** Which demos each asset unblocks — printed on success so the payoff is visible, and the
 *  reason a reader can tell whether they need the download at all. */
export const DEMO_USERS: Readonly<Record<string, readonly string[]>> = {
  'ne_10m_land.geojson': [
    'night-map',
    'physical-map-10m',
    'populated-places',
    'rivers-10m',
    'states-10m',
    'water-hierarchy',
    'zoom-lod',
  ],
  'ne_10m_ocean.geojson': ['physical-map-10m', 'water-hierarchy'],
  'ne_10m_lakes.geojson': ['night-map', 'physical-map-10m', 'rivers-10m', 'water-hierarchy'],
  'ne_10m_rivers.geojson': ['night-map', 'physical-map-10m', 'rivers-10m', 'water-hierarchy'],
  'ne_10m_states.geojson': ['layered-borders', 'populated-places', 'raster-overlay', 'states-10m'],
  'ne_50m_lakes.geojson': ['physical-map-50m'],
  'ne_50m_rivers.geojson': ['night-map', 'physical-map-50m', 'zoom-lod'],
  'ne_50m_states.geojson': ['layered-borders', 'states-provinces'],
}

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`

function fetchOne(local: string, upstream: string, force: boolean): number {
  const dest = join(DEST, local)
  if (!force && existsSync(dest)) {
    console.log(`  = ${local.padEnd(24)} present (${mb(statSync(dest).size)}) — skipping`)
    return 0
  }
  const url = `${BASE}/${upstream}.geojson`
  // Download to a .part first, so an interrupted run cannot leave a truncated file that the
  // `existsSync` skip above would then treat as complete — the failure mode that turns one
  // bad network moment into a demo that renders half a continent forever.
  const part = `${dest}.part`
  const r = spawnSync('curl', ['-sSfL', '--max-time', '600', '-o', part, url], {
    encoding: 'utf8',
  })
  if (r.error || r.status !== 0) {
    rmSync(part, { force: true })
    throw new Error(`${local}: curl failed for ${url}\n  ${r.stderr?.trim() || r.error?.message}`)
  }
  // Guard the exact failure this whole issue is about: a server answering a missing file with
  // an HTML error page. `-f` catches an honest 404; this catches a 200 that is not JSON.
  const head = readFileSync(part, { encoding: 'utf8', flag: 'r' }).slice(0, 64).trimStart()
  if (!head.startsWith('{')) {
    rmSync(part, { force: true })
    throw new Error(
      `${local}: ${url} returned non-JSON (starts with ${JSON.stringify(head.slice(0, 32))})`,
    )
  }
  const size = statSync(part).size
  spawnSync('mv', [part, dest])
  console.log(`  + ${local.padEnd(24)} ${mb(size).padStart(8)}  <- ${upstream}`)
  return size
}

if (import.meta.main) {
  const force = process.argv.includes('--force')
  mkdirSync(DEST, { recursive: true })
  console.log(
    `Fetching demo assets into playground/public/data${force ? ' (--force: re-downloading)' : ''}\n`,
  )
  let total = 0
  for (const [local, upstream] of Object.entries(DEMO_ASSETS)) {
    total += fetchOne(local, upstream, force)
  }
  console.log(
    total === 0
      ? '\nEverything was already present. Pass --force to re-download.'
      : `\nDownloaded ${mb(total)}. These are gitignored by design — see playground/public/AGENTS.md.`,
  )
}
