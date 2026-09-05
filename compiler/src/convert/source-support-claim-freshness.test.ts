// A converter warning must not tell the author a SUPPORTED source type is unsupported (#2520).
//
// THE INCIDENT. `sources.ts` emitted, into the converted output a user reads:
//
//   // NOTE: raster-dem rendering (hillshade / 3D terrain) — Batch 4 of the …roadmap.
//   Source "dem" type="raster-dem" registered but rendering not yet supported
//     (Batch 4 — hillshade + 3D terrain).
//
// Both were false. #777 Phase II renders raster-dem end to end on both backends, and
// spec-coverage carried `raster-dem` and `hillshade` at `supported` the whole time. The
// emit site's own neighbouring comment already cited `demUnpack()` in
// `hillshade-renderer.ts`. It survived because nothing could see it: the drift gate
// matches row PRESENCE, not agreement between a row and a warning, and the one test
// that touched the strings ASSERTED them — it pinned the bug.
//
// WHY THIS SHAPE. The first design scanned converter SOURCE TEXT for deferral phrases
// near feature names. That is the #2489 guard's shape, and here it would be noisy for a
// reason that guard did not face: source-type names are ordinary words (`raster`,
// `image`, `video`), not hyphenated Mapbox properties, so a substring hit proves
// nothing. A noisy gate is one people learn to ignore.
//
// So this asserts BEHAVIOUR instead: convert a minimal style using each type and read
// the warnings the author would actually get. Zero false positives by construction —
// it tests the exact channel that lied.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from './mapbox-to-xgis'
import { SOURCE_TYPES } from './spec-coverage/source-types'

/** Phrases a warning uses to say "this does not work yet". */
const DEFERRAL = /not yet supported|not supported|not yet implemented|Batch \d|roadmap/i

/** One minimal style per spec-coverage row, keyed by the row's `name`. A row with no
 *  entry here fails the coverage assertion below rather than being skipped — a guard
 *  that silently ignores new rows is the vacuity this file exists to prevent. */
const STYLE_FOR: Record<string, Record<string, unknown>> = {
  'vector (.pmtiles)': { type: 'vector', url: 'pmtiles://https://example.com/v.pmtiles' },
  'vector (TileJSON)': { type: 'vector', url: 'https://example.com/tiles.json' },
  pmtiles: { type: 'vector', url: 'pmtiles://https://example.com/v.pmtiles' },
  'tilejson (explicit)': { type: 'vector', url: 'https://example.com/tiles.json' },
  raster: { type: 'raster', tiles: ['https://example.com/{z}/{x}/{y}.png'], tileSize: 256 },
  'geojson (URL)': { type: 'geojson', data: 'https://example.com/f.geojson' },
  'geojson (inline)': {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  },
  'raster-dem': { type: 'raster-dem', url: 'https://example.com/dem.json', tileSize: 512 },
  image: {
    type: 'image',
    url: 'https://example.com/i.png',
    coordinates: [
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
  },
  video: {
    type: 'video',
    urls: ['https://example.com/v.mp4'],
    coordinates: [
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
  },
}

function warningsFor(source: Record<string, unknown>): string[] {
  const out = convertMapboxStyle({
    version: 8,
    sources: { s: source },
    layers: [],
  } as never)
  // Warnings ride the output as a `/* Conversion notes … */` trailer — the same text
  // the author reads, which is the point of testing here rather than at a callback.
  const m = /\/\* Conversion notes[\s\S]*?\*\//.exec(out)
  return m ? m[0].split('\n').filter((l) => l.includes('•')) : []
}

describe('#2520 — a supported source type is never reported as unsupported', () => {
  it('every spec-coverage source row has a style here (no row silently unscanned)', () => {
    const missing = SOURCE_TYPES.map((r) => r.name).filter((n) => !(n in STYLE_FOR))
    expect(missing, `add a minimal style for: ${missing.join(', ')}`).toEqual([])
    expect(SOURCE_TYPES.length, 'no source rows to scan').toBeGreaterThan(5)
  })

  for (const row of SOURCE_TYPES.filter((r) => r.status === 'supported')) {
    it(`"${row.name}" converts without claiming it is unsupported`, () => {
      const offenders = warningsFor(STYLE_FOR[row.name]!).filter((w) => DEFERRAL.test(w))
      expect(
        offenders,
        `spec-coverage says "${row.name}" is supported, but the converter tells the ` +
          `author otherwise:\n    ${offenders.join('\n    ')}`,
      ).toEqual([])
    })
  }

  // THE CONTROL, and without it every assertion above is satisfied by a detector that
  // cannot see a deferral at all — a blind instrument reports zero, which reads as a
  // clean corpus (CLAUDE.md §12). `image` / `video` are genuinely `unsupported`, so
  // their warning MUST trip the same regex the assertions above rely on.
  for (const row of SOURCE_TYPES.filter((r) => r.status === 'unsupported')) {
    it(`CONTROL — "${row.name}" is unsupported, and the detector sees that warning`, () => {
      const seen = warningsFor(STYLE_FOR[row.name]!).filter((w) => DEFERRAL.test(w))
      expect(seen.length, `the DEFERRAL regex found nothing for "${row.name}"`).toBeGreaterThan(0)
    })
  }
})
