// #1984 (ADR-0012 Phase B3) — a SOURCE-level `bounds: [west, south, east, north]` must
// reach the runtime instead of being warned away.
//
// The gap this closes, one property over from #1983's tileSize/maxzoom/minzoom:
//
//   • the xgis source grammar had no `bounds` property at all (ir/lower.ts
//     `lowerSource` claimed type/url/data/crs/layers/encoding/tileSize/*Factor/
//     baseShift/maxzoom/minzoom/refresh, and everything else fell into the
//     custom-loader options bag — where a NUMERIC array is silently discarded,
//     because that branch only collects StringLiteral elements);
//   • the converter validated the Mapbox `bounds` and then dropped it with a warning;
//   • and the raster request path clipped nothing spatially, so a regional source got
//     ocean-tile requests that can only 404.
//
// VECTOR sources already clip — `tileIntersectsBounds` (data/sources/
// pmtiles-backend-helpers.ts) gates PMTilesBackend.hasTile / the virtual catalog from
// the ARCHIVE's own header/manifest bounds. So the declared-bounds path is a raster /
// raster-dem concern only, which is why those are the two types that emit here (the
// same per-type rule #1983 landed: emitting a line nothing reads is the silent gap
// wearing a different hat).
//
// GRAMMAR: `bounds: [-10, 35, 5, 45]` needs ZERO new grammar. `parseBlockProperty`
// (parser-statements.ts:617) parses a full expression, and `parsePrimary`
// (parser-expressions.ts:232-241) already produces an `ArrayLiteral` whose elements are
// `parseExpr()` — so a negative arrives as `UnaryExpr('-', NumberLiteral)`, exactly the
// shape `astLiteralToJS` already folds for inline `data:` GeoJSON coordinates.
//
// ANTIMERIDIAN: Mapbox/TileJSON bounds do not wrap. MapLibre's `TileBounds` clamps each
// component into [-180,180]/[-90,90] and tests `minX <= maxX`, so a `west > east`
// declaration yields an EMPTY box and the source renders nothing at all. Inventing
// wraparound here would diverge from the reference renderer; emitting the empty box
// would silently kill the source. Both are worse than saying so — a crossing (or
// otherwise invalid) declaration warns and drops, leaving the source unclipped, which
// is the pre-existing behaviour.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertMapboxStyle, type StyleCoverage } from '../convert/mapbox-to-xgis'
import { Lexer, Parser, lower, optimize, emitCommands } from '..'

const HERE = dirname(fileURLToPath(import.meta.url))

function convert(style: unknown): { code: string; warnings: string[] } {
  const coverage: StyleCoverage = { sources: [], layers: [], warnings: [] }
  const code = convertMapboxStyle(style as never, { coverage })
  return { code, warnings: coverage.warnings }
}

/** The emitted `source <id> { … }` block, verbatim. Line-scanned rather than
 *  regex-matched: tile URL templates carry literal `{z}/{x}/{y}` braces. */
function sourceBlock(code: string, id: string): string {
  const lines = code.split('\n')
  const start = lines.indexOf(`source ${id} {`)
  expect(start, `no source block for "${id}" in:\n${code}`).toBeGreaterThanOrEqual(0)
  const end = lines.indexOf('}', start)
  return lines.slice(start, end + 1).join('\n')
}

const rasterStyle = (extra: Record<string, unknown>) => ({
  version: 8,
  sources: {
    regional: { type: 'raster', tiles: ['https://x/{z}/{x}/{y}.png'], ...extra },
  },
  layers: [{ id: 'r', type: 'raster', source: 'regional' }],
})

const boundsWarnings = (w: string[]) => w.filter((s) => s.includes('bounds'))

describe('#1984 W1 — a raster source: the declared bounds reach the xgis block', () => {
  it('emits `bounds: [-10, 35, 5, 45]` and warns about nothing', () => {
    const { code, warnings } = convert(rasterStyle({ bounds: [-10, 35, 5, 45] }))
    expect(sourceBlock(code, 'regional')).toContain('bounds: [-10, 35, 5, 45]')
    // The warning this issue exists to remove.
    expect(boundsWarnings(warnings)).toEqual([])
  })

  it('emits fractional bounds verbatim (the whole-world default rounds to nothing)', () => {
    const { code } = convert(
      rasterStyle({ bounds: [-180, -85.0511287798066, 180, 85.0511287798066] }),
    )
    expect(sourceBlock(code, 'regional')).toContain(
      'bounds: [-180, -85.0511287798066, 180, 85.0511287798066]',
    )
  })

  it('coexists with #1983 tileSize / maxzoom on the same block', () => {
    const { code, warnings } = convert(
      rasterStyle({ bounds: [125, 33, 132, 39], tileSize: 256, maxzoom: 6 }),
    )
    const block = sourceBlock(code, 'regional')
    expect(block).toContain('maxzoom: 6')
    expect(block).toContain('tileSize: 256')
    expect(block).toContain('bounds: [125, 33, 132, 39]')
    expect(warnings.filter((s) => /bounds|maxzoom|tileSize/.test(s))).toEqual([])
  })
})

describe('#1984 W2 — a raster-dem source emits it too (the other clipping consumer)', () => {
  const demStyle = (extra: Record<string, unknown>) => ({
    version: 8,
    sources: {
      terrain: {
        type: 'raster-dem',
        tiles: ['https://dem/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        ...extra,
      },
    },
    layers: [{ id: 'h', type: 'hillshade', source: 'terrain' }],
  })

  it('emits bounds on the raster-dem block, DEM diagnostics untouched', () => {
    const { code, warnings } = convert(demStyle({ bounds: [5, 45, 11, 48] }))
    const block = sourceBlock(code, 'terrain')
    // Quoted since #2549 — a bare `raster-dem` re-parses as `raster - dem`.
    expect(block).toContain('type: "raster-dem"')
    expect(block).toContain('bounds: [5, 45, 11, 48]')
    expect(boundsWarnings(warnings)).toEqual([])
    // Pre-existing raster-dem diagnostics are not in scope and must not move by THIS
    // change. #2003 landed separately since this test was written: encoding: terrarium
    // is now emitted (not warned) — that is the correct, updated diagnostic set this
    // bounds emission must not disturb.
    expect(block).toContain('encoding: terrarium')
    expect(warnings.some((w) => w.includes('encoding'))).toBe(false)
  })
})

describe('#1984 W3 — the emitted block survives the whole compile pipeline', () => {
  const loadOf = (code: string, name: string) =>
    emitCommands(optimize(lower(new Parser(new Lexer(code).tokenize()).parse()))).loads.find(
      (l) => l.name === name,
    )

  it('convert → Lexer → Parser → lower → emitCommands carries the exact 4 numbers', () => {
    const { code } = convert(rasterStyle({ bounds: [-10, 35, 5, 45] }))
    const load = loadOf(code, 'regional')
    expect(load?.type).toBe('raster')
    expect(load?.bounds).toEqual([-10, 35, 5, 45])
  })

  // A hand-authored block, asserted at BOTH levels below. The grammar decision is that
  // it needs no new production: the existing ArrayLiteral + the unary-minus fold carry it.
  const HAND_AUTHORED = [
    'xgis 1',
    'source regional {',
    '  type: raster',
    '  url: "https://x/{z}/{x}/{y}.png"',
    '  bounds: [-122.5, 37.7, -122.3, 37.9]',
    '}',
    '', // a layer is required — `optimize` prunes a source no layer references
    'layer r {',
    '  source: regional',
    '}',
  ].join('\n')

  it('lower() alone puts the box on SourceDef — the CAUSE, asserted before the effect', () => {
    // Split from the pipeline assertions so the two compiler hops accuse themselves
    // separately: cutting `lowerSource`'s branch and cutting `emitCommands`' `bounds:
    // src.bounds` otherwise produce the IDENTICAL red, which only says "the pipeline
    // lost it somewhere". This one names the lowering half.
    const scene = lower(new Parser(new Lexer(HAND_AUTHORED).tokenize()).parse())
    expect(scene.sources.find((s) => s.name === 'regional')?.bounds).toEqual([
      -122.5, 37.7, -122.3, 37.9,
    ])
  })

  it('a hand-authored xgis block reaches the LoadCommand too (negatives via UnaryExpr)', () => {
    expect(loadOf(HAND_AUTHORED, 'regional')?.bounds).toEqual([-122.5, 37.7, -122.3, 37.9])
  })

  it('a source declaring no bounds leaves the field undefined — unclipped, as before', () => {
    const { code } = convert(rasterStyle({}))
    expect(loadOf(code, 'regional')?.bounds).toBeUndefined()
  })
})

describe('#1984 W4 — invalid bounds warn and DROP (never emit a box that kills the source)', () => {
  const cases: ReadonlyArray<readonly [label: string, value: unknown, reason: string]> = [
    ['antimeridian crossing (west > east)', [170, -10, -170, 10], 'west=170 > east=-170'],
    ['inverted latitude (south > north)', [-10, 45, 5, 35], 'south=45 > north=35'],
    ['latitude out of [-90, 90]', [-10, 35, 5, 95], 'latitude'],
    ['longitude out of [-180, 180]', [-190, 35, 5, 45], 'longitude'],
    ['wrong arity', [-10, 35, 5], '4 finite numbers'],
    ['non-numeric entries', ['-10', '35', '5', '45'], '4 finite numbers'],
    ['non-finite entry', [-10, 35, 5, Number.POSITIVE_INFINITY], '4 finite numbers'],
  ]

  for (const [label, value, reason] of cases) {
    it(`${label} → one warning naming the reason, and no bounds line`, () => {
      const { code, warnings } = convert(rasterStyle({ bounds: value }))
      expect(sourceBlock(code, 'regional')).not.toContain('bounds')
      const w = boundsWarnings(warnings)
      expect(w).toHaveLength(1)
      expect(w[0]).toContain('"regional"')
      expect(w[0]).toContain(reason)
    })
  }

  it('the antimeridian warning says what the reference renderer does, not "unsupported"', () => {
    const { warnings } = convert(rasterStyle({ bounds: [170, -10, -170, 10] }))
    // The decision is documented at the point of failure: no wraparound, because
    // MapLibre has none either — a crossing box is EMPTY there.
    expect(boundsWarnings(warnings)[0]).toMatch(/antimeridian/i)
    expect(boundsWarnings(warnings)[0]).toMatch(/split.*two sources|two sources/i)
  })
})

describe('#1984 W5 — types with no request path to clip keep a narrowed warning', () => {
  it('a vector source warns that its ARCHIVE metadata owns the clip, and emits nothing', () => {
    const { code, warnings } = convert({
      version: 8,
      sources: {
        v: { type: 'vector', url: 'https://x/v.pmtiles', bounds: [125, 33, 132, 39] },
      },
      layers: [{ id: 'l', type: 'line', source: 'v', 'source-layer': 'roads' }],
    })
    expect(sourceBlock(code, 'v')).not.toContain('bounds')
    const w = boundsWarnings(warnings)
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('"v"')
    // The narrowing: not "unsupported", but "a different authority already does it".
    expect(w[0]).toMatch(/PMTiles header|TileJSON manifest/)
  })

  it('a geojson source warns that nothing downstream reads it', () => {
    const { code, warnings } = convert({
      version: 8,
      sources: { g: { type: 'geojson', data: 'https://x/f.geojson', bounds: [1, 2, 3, 4] } },
      layers: [{ id: 'l', type: 'circle', source: 'g' }],
    })
    expect(sourceBlock(code, 'g')).not.toContain('bounds')
    expect(boundsWarnings(warnings)).toHaveLength(1)
    expect(boundsWarnings(warnings)[0]).toContain('"g"')
  })

  it('an INVALID bounds on a non-emitting type still reports the invalidity', () => {
    // Otherwise a typo'd box on a vector source would be masked by the type warning.
    const { warnings } = convert({
      version: 8,
      sources: { v: { type: 'vector', url: 'https://x/v.pmtiles', bounds: [-10, 45, 5, 35] } },
      layers: [{ id: 'l', type: 'line', source: 'v', 'source-layer': 'roads' }],
    })
    expect(boundsWarnings(warnings)).toHaveLength(1)
    expect(boundsWarnings(warnings)[0]).toContain('south=45 > north=35')
  })
})

describe('#1984 W6 — regression guards', () => {
  it('a raster source declaring no bounds emits exactly the pre-fix block', () => {
    const { code, warnings } = convert(rasterStyle({}))
    expect(sourceBlock(code, 'regional')).toBe(
      'source regional {\n  type: raster\n  url: "https://x/{z}/{x}/{y}.png"\n}',
    )
    expect(warnings).toEqual([])
  })

  it('OFM Liberty declares no source bounds — its warning set is byte-unchanged', () => {
    const style = readFileSync(join(HERE, 'fixtures', 'openfreemap-liberty.json'), 'utf8')
    const { warnings } = convert(JSON.parse(style))
    expect(boundsWarnings(warnings)).toEqual([])
    // #1983 left liberty at 6; this issue must not move it. #2166 narrowed the
    // text-pitch-alignment runtime-gap warning to its real residual and removed
    // the 5 that fired on line-placed labels the runtime DOES ground-project,
    // leaving only the `text-optional` one — which #2440 then delivered. Zero.
    expect(warnings).toHaveLength(0)
  })
})
