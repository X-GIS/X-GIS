// #2003 (T2 terrain track Phase 1) — the DISTINGUISHING check (CLAUDE.md §12 "the assertion
// that failed either way"): prove the DECODED elevation differs between encodings through the
// REAL decode path (demUnpack, this file's sibling hillshade-renderer.ts), not merely that the
// converter emitted a line. An emit that never reached a consumer would pass a text-only
// assertion identically — see compiler/src/__tests__/source-dem-encoding-emit.test.ts for that
// half of the corpus (converter → xgis text → IR SourceDef fields).
//
// Lives in @xgis/map, not @xgis/compiler: demUnpack is a map/src/render/hillshade-renderer.ts
// export, and @xgis/compiler must not depend on @xgis/map (the reverse dependency already
// holds — map/package.json devDependencies lists "@xgis/compiler"). This is the one file in the
// #2003 diff outside the compiler package, and it adds no wiring: every hop it exercises
// (lower.ts → interpreter → source-manager → demUnpack) was already landed — see the design doc
// docs/plans/2026-08-24-terrain-track.md, "What is already built".
//
// Worked example this reproduces (design doc): a mid-grey DEM texel (128,128,128) is 128.5 m of
// real elevation under the terrarium formula; decoded with the mapbox formula instead (the bug
// before this issue — the converter warned and emitted nothing, so the runtime always fell back
// to mapbox), the SAME bytes read as 832150.4 m — not a subtle drift, saturated garbage.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, Lexer, Parser, lower } from '@xgis/compiler'
import { demUnpack, type DemEncoding, type DemUnpack } from './hillshade-renderer'

type DemFields = {
  encoding?: string
  redFactor?: number
  greenFactor?: number
  blueFactor?: number
  baseShift?: number
}

/** Mapbox style JSON → the converter's xgis text → the lowered IR SourceDef for "dem". Exercises
 *  the REAL #2003 converter emit (sources.ts), not a hand-authored `.xgis` shortcut. */
function demSourceDefFor(extra: Record<string, unknown>): DemFields {
  const style = {
    version: 8,
    sources: { dem: { type: 'raster-dem', tiles: ['https://d/{z}/{x}/{y}.png'], ...extra } },
    layers: [{ id: 'h', type: 'hillshade', source: 'dem' }],
  }
  const xgis = convertMapboxStyle(style as never)
  const scene = lower(new Parser(new Lexer(xgis).tokenize()).parse())
  const dem = scene.sources.find((s) => s.name === 'dem')
  if (!dem) throw new Error(`no "dem" source in lowered scene:\n${xgis}`)
  return dem
}

/** elevation_m = R*redFactor + G*greenFactor + B*blueFactor − baseShift (design §2,
 *  hillshade-renderer.ts:56) — applied here against the REAL unpack factors demUnpack()
 *  resolves, not a re-implementation of the pack formula. */
function decode(u: DemUnpack, r: number, g: number, b: number): number {
  return r * u.redFactor + g * u.greenFactor + b * u.blueFactor - u.baseShift
}

/** Resolve the SAME way armHillshadeSource() does (hillshade-renderer.ts) — the single
 *  authority the whole runtime decode chain feeds. */
function unpackFor(dem: DemFields): DemUnpack {
  return demUnpack((dem.encoding as DemEncoding | undefined) ?? 'mapbox', {
    redFactor: dem.redFactor,
    greenFactor: dem.greenFactor,
    blueFactor: dem.blueFactor,
    baseShift: dem.baseShift,
  })
}

describe('#2003 DEC1 — a converted terrarium DEM decodes DIFFERENTLY from mapbox', () => {
  const texel = [128, 64, 32] as const

  it('the converter-emitted encoding reaches demUnpack and changes the decoded elevation', () => {
    const dem = demSourceDefFor({ encoding: 'terrarium' })
    expect(dem.encoding).toBe('terrarium') // the text-level emit + thread (also pinned in compiler/)

    const decodedViaPipeline = decode(unpackFor(dem), ...texel)
    const decodedAsMapbox = decode(unpackFor({}), ...texel)
    // Not merely "not equal" — the exact terrarium formula value, independently computed.
    expect(decodedViaPipeline).toBeCloseTo(64.125, 6)
    expect(decodedViaPipeline).not.toBeCloseTo(decodedAsMapbox, 0)
  })

  it('the design-doc worked example: mapbox misreads a mid-grey texel by six orders of magnitude', () => {
    const grey = [128, 128, 128] as const
    const mapboxRead = decode(unpackFor({}), ...grey)
    const terrariumRead = decode(unpackFor({ encoding: 'terrarium' }), ...grey)
    expect(mapboxRead).toBeCloseTo(832150.4, 4)
    expect(terrariumRead).toBe(128.5)
  })

  it('a mapbox-encoded DEM decodes identically to a source that declares no encoding', () => {
    const declared = demSourceDefFor({ encoding: 'mapbox' })
    const omitted = demSourceDefFor({})
    expect(decode(unpackFor(declared), ...texel)).toBe(decode(unpackFor(omitted), ...texel))
  })
})

describe('#2003 DEC2 — `custom` with a partial pack: the given lane applies, the rest fall back to mapbox', () => {
  it('only redFactor declared: red lane is custom, green/blue/baseShift are the mapbox factors', () => {
    const dem = demSourceDefFor({ encoding: 'custom', redFactor: 1000 })
    const unpack = unpackFor(dem)
    const mapbox = unpackFor({})
    expect(unpack.redFactor).toBe(1000)
    expect(unpack.greenFactor).toBe(mapbox.greenFactor)
    expect(unpack.blueFactor).toBe(mapbox.blueFactor)
    expect(unpack.baseShift).toBe(mapbox.baseShift)
    // And the decode genuinely differs from a straight mapbox read, proving the custom
    // lane is live end to end, not silently discarded somewhere in the pipeline.
    const texel = [200, 10, 10] as const
    expect(decode(unpack, ...texel)).not.toBe(decode(mapbox, ...texel))
  })
})
