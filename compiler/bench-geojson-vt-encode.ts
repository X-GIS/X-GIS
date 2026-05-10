// Standalone bench: time the geojson-vt + vt-pbf encoding cost on
// the same fixtures the e2e perf spec uses. Gives an upper bound
// for what Option B (MVT pipeline insertion) would add at
// setRawParts time.
//
// Run: bun run bench-geojson-vt-encode.ts

import { readFileSync } from 'node:fs'
// @ts-expect-error — geojson-vt has no types in our setup
import geojsonvt from 'geojson-vt'
// @ts-expect-error — vt-pbf has no types
import vtpbf from 'vt-pbf'

interface FixtureCase {
  label: string
  path: string
  /** geojson-vt indexMaxZoom — eager pyramid depth. */
  indexMaxZoom: number
  /** Tiles to encode for the per-tile bench. */
  encodeKeys: { z: number; x: number; y: number }[]
}

const cases: FixtureCase[] = [
  {
    label: 'small inline (Korea + Tokyo, 2 features)',
    path: '../playground/public/sample-mapbox-with-inline-geojson.json',
    indexMaxZoom: 5,
    encodeKeys: [
      { z: 5, x: 27, y: 12 },  // Korea-containing
      { z: 5, x: 28, y: 12 },  // Tokyo-containing
    ],
  },
  {
    label: 'medium (ne_110m_countries, ~177 features, 725 KB)',
    path: '../playground/public/data/ne_110m_countries.geojson',
    indexMaxZoom: 5,
    encodeKeys: [
      { z: 4, x: 8, y: 6 },     // North America
      { z: 4, x: 9, y: 5 },     // Europe
      { z: 5, x: 27, y: 12 },   // East Asia
    ],
  },
  {
    label: 'large (countries.geojson, 14.6 MB, ~250 features)',
    path: '../playground/public/data/countries.geojson',
    indexMaxZoom: 5,
    encodeKeys: [
      { z: 4, x: 8, y: 6 },
      { z: 5, x: 27, y: 12 },
    ],
  },
]

for (const c of cases) {
  console.log(`\n=== ${c.label} ===`)

  // Some fixtures are Mapbox style files (sample-mapbox-with-inline-...)
  // not raw GeoJSON. Detect + extract the inline FC if so.
  let fc: { type: string; features: unknown[] }
  const raw = readFileSync(c.path, 'utf8')
  const t0 = performance.now()
  const parsed = JSON.parse(raw)
  if (parsed.sources) {
    // Mapbox style — extract the first inline geojson source.
    const sources = parsed.sources as Record<string, { type: string; data?: unknown }>
    const inline = Object.values(sources).find(s => s.type === 'geojson' && s.data)
    fc = inline?.data as { type: string; features: unknown[] }
  } else {
    fc = parsed
  }
  const parseMs = performance.now() - t0
  console.log(`  features: ${fc.features?.length ?? 0}, file size: ${(raw.length / 1024).toFixed(0)} KB, JSON.parse: ${parseMs.toFixed(1)} ms`)

  // ── geojson-vt index build ──
  const buildT0 = performance.now()
  const idx = geojsonvt(fc, {
    maxZoom: 14,
    indexMaxZoom: c.indexMaxZoom,
    tolerance: 3,
    buffer: 64,
    extent: 4096,
  })
  const buildMs = performance.now() - buildT0
  console.log(`  geojson-vt build (eager to z=${c.indexMaxZoom}): ${buildMs.toFixed(1)} ms`)

  // ── per-tile getTile + vt-pbf encode ──
  let getTileTotal = 0
  let encodeTotal = 0
  let bytesTotal = 0
  for (const k of c.encodeKeys) {
    const gt0 = performance.now()
    const tile = idx.getTile(k.z, k.x, k.y)
    getTileTotal += performance.now() - gt0
    if (!tile) {
      console.log(`    z=${k.z}/${k.x}/${k.y}: empty tile, skipping`)
      continue
    }
    const et0 = performance.now()
    const bytes = vtpbf.fromGeojsonVt({ default: tile }, { version: 1, extent: 4096 })
    encodeTotal += performance.now() - et0
    bytesTotal += bytes.length
    console.log(`    z=${k.z}/${k.x}/${k.y}: getTile ${(performance.now() - gt0 - encodeTotal + (encodeTotal - (encodeTotal - (performance.now() - et0)))).toFixed(1)} → encode → ${bytes.length} bytes`)
  }
  console.log(`  total getTile: ${getTileTotal.toFixed(1)} ms, encode: ${encodeTotal.toFixed(1)} ms, bytes: ${bytesTotal} (${(bytesTotal / 1024).toFixed(1)} KB)`)
  console.log(`  Σ build + getTile + encode (one-time + ${c.encodeKeys.length} tiles): ${(buildMs + getTileTotal + encodeTotal).toFixed(1)} ms`)
}
