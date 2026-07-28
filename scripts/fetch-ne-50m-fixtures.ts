#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════════════
// Natural Earth 50m fixture provenance (#1349 step 1)
// ═══════════════════════════════════════════════════════════════════
//
// `playground/src/examples/physical-map-50m.xgis` needs `ne_50m_rivers.geojson`
// and `ne_50m_lakes.geojson`. Neither was in the repository, so `physical_map_50m`
// — and every stability spec that renders it — could not run from a clean clone.
// That is #1349's step-1 blocker: not missing CI wiring, missing data.
//
// The two files ARE now committed, because CI must work offline and because
// re-fetching upstream on every run would make the gate depend on GitHub being
// up. This script exists so their provenance is MECHANICAL rather than a claim
// in a README: run it and `git diff` must come back empty. A fixture nobody can
// re-derive is a fixture nobody can trust after the first person who understood
// it moves on.
//
// WHY REAL DATA rather than a synthetic generator. #1349 offered either. Natural
// Earth is public domain, the repo already commits `ne_110m_*.geojson` from the
// same upstream by the same transform, and — decisively — the blocked specs were
// authored and their thresholds tuned against THIS data. A synthetic stand-in
// would have made every threshold a fresh guess, and the point of the gate is to
// catch a regression against the behaviour that was actually measured.
//
// WHY NOT PMTiles. The issue suggested a PMTiles archive as one option. It is not
// needed: `physical-map-50m.xgis` declares `type: geojson`, and the runtime tiles
// GeoJSON in-worker (geojson-tiling-pool.ts), so this yields a genuine multi-tile
// vector scene through the existing path. PMTiles would have meant a binary blob
// plus an encoder dependency (the `pmtiles` npm package is a READER) to reach the
// same place.
//
// Invocation:
//   bun scripts/fetch-ne-50m-fixtures.ts
//   git diff --stat playground/public/data   # must be empty

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const UPSTREAM = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson'
const OUT_DIR = join(import.meta.dir, '..', 'playground', 'public', 'data')

/** [upstream basename, committed basename] — `rivers` is upstream's
 *  `rivers_lake_centerlines`, renamed to match the 110m file already committed
 *  (and the name `physical-map-50m.xgis` asks for). */
const FIXTURES: [string, string][] = [
  ['ne_50m_rivers_lake_centerlines', 'ne_50m_rivers'],
  ['ne_50m_lakes', 'ne_50m_lakes'],
]

/** Serialise exactly like the committed `ne_110m_*.geojson` files: top-level
 *  `crs` / `bbox` / `name` dropped, everything else — properties and full
 *  coordinate precision — kept verbatim, one feature per line.
 *
 *  Coordinates are deliberately NOT rounded. Trimming them would shave ~40 % off
 *  the file and be visually identical at every zoom these fixtures are used at,
 *  but it would also mean the bytes here no longer follow from upstream by a
 *  stated rule — which is the one property this script exists to provide. */
function serialise(fc: { features: unknown[] }): string {
  const lines = fc.features.map((f) => JSON.stringify(f))
  return '{\n"type": "FeatureCollection",\n"features": [\n' + lines.join(',\n') + '\n]\n}\n'
}

for (const [upstream, local] of FIXTURES) {
  const url = `${UPSTREAM}/${upstream}.geojson`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  const fc = (await res.json()) as { type: string; features: unknown[] }
  if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features) || fc.features.length === 0) {
    throw new Error(`${url} → not a non-empty FeatureCollection`)
  }
  const out = join(OUT_DIR, `${local}.geojson`)
  writeFileSync(out, serialise(fc))
  console.log(`${local}.geojson  ${fc.features.length} features  ${serialise(fc).length} bytes`)
}
