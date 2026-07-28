// ═══ `filter:` reaches a coverage layer (#1366) ═══════════════════════════════
//
// A `filter:` clause had no path to a gridded coverage. GeoJSON is pre-filtered into its own
// FeatureCollection (`applyFilter`, keyed `source__N`), and vector tiles fold the filter into
// the MVT worker's slice key — a grid is neither, so `filter: .depth > 20` on a coverage layer
// compiled cleanly and thinned nothing. Measured on the synthetic demo before the fix: 38
// numerals with the filter, 38 without, and values of 3 / 6 / 12 all still on screen.
//
// The cell's BANDS are its property bag, so the clause reads exactly as it does on a feature
// layer. That equivalence is the real claim here, which is why the last case runs the SAME
// expression through `applyFilter` over features carrying the same properties and requires the
// two to agree — a coverage filter that quietly meant something else would be worse than one
// that did nothing.

import { describe, it, expect } from 'vitest'
import { coverageFromGrids, type CoverageHandle } from '@xgis/data'
import { Lexer, Parser, lower, type LabelDef } from '@xgis/compiler'
import { applyFilter } from '../../feature-helpers'
import { dispatchCoverageSoundings } from './dispatch-coverage-soundings'

const N = 8

/** depth = col + 10·rowFromSouth ⇒ every cell's value names the cell it came from. */
function grid(): CoverageHandle {
  const v = new Float32Array(N * N)
  for (let rowS = 0; rowS < N; rowS++) {
    for (let col = 0; col < N; col++) v[(N - 1 - rowS) * N + col] = col + 10 * rowS
  }
  return coverageFromGrids({
    product: 's102',
    crs: null,
    origin: [5, 50],
    spacing: [0.0625, 0.0625],
    size: [N, N],
    bands: [{ name: 'depth', unit: 'metres', kind: 'f32', nodata: 1e6, values: v }],
    vertical: { datumCode: 23, sign: 'down' },
  })
}

/** Compile a real `filter:` clause and hand back the lowered `DataExpr` the pass reads. Going
 *  through the compiler rather than hand-building an AST is the point: a filter that the
 *  language accepts but this arm mishandles is exactly the bug being gated. */
function filterExpr(src: string): { ast: unknown } {
  const scene = lower(
    new Parser(
      new Lexer(
        `xgis 1\nsource s { type: geojson }\nlayer l { source: s, filter: ${src} | fill-red-500 }\n`,
      ).tokenize(),
    ).parse(),
  )
  const node = scene.renderNodes.find((n) => n.name === 'l')
  if (!node?.filter) throw new Error(`filter did not lower for: ${src}`)
  return node.filter
}

const VIEW = { width: 800, height: 600, dpr: 1 }
/** Flat camera over the grid — 40 px per cell, so a good part of it is on screen. */
const unproject = (px: number, py: number): [number, number] => [
  5 + (px / 40) * 0.0625,
  50 + N * 0.0625 - (py / 40) * 0.0625,
]

/** Run the dispatch arm and collect the depth of every cell that produced a label. */
function dispatchedDepths(filter?: { ast: unknown } | null): number[] {
  const out: number[] = []
  dispatchCoverageSoundings(
    grid(),
    unproject,
    VIEW,
    () => ({ text: { kind: 'expr', expr: { ast: {} } } }) as unknown as LabelDef,
    (lon, lat) => [[lon, lat, 1]],
    (_v, props) => out.push((props as { depth: number }).depth),
    { layerName: 'soundings', region: 'r0', filter },
  )
  return out
}

describe('coverage soundings honour `filter:`', () => {
  it('emits every candidate when the layer has no filter', () => {
    const all = dispatchedDepths()
    expect(all.length).toBeGreaterThan(4)
    // The fixture spans both sides of the thresholds used below, or the tests are vacuous.
    expect(all.some((d) => d > 20)).toBe(true)
    expect(all.some((d) => d <= 20)).toBe(true)
  })

  it('drops the cells the filter rejects — and keeps exactly the ones it accepts', () => {
    const all = dispatchedDepths()
    const kept = dispatchedDepths(filterExpr('.depth > 20'))
    expect(kept).toEqual(all.filter((d) => d > 20))
    expect(kept.length).toBeLessThan(all.length)
    expect(kept.length).toBeGreaterThan(0)
  })

  it('a filter nothing satisfies emits nothing (not everything)', () => {
    // The failure mode being excluded: an ignored filter reads as "all pass", so a
    // never-satisfiable expression is the sharpest single case.
    expect(dispatchedDepths(filterExpr('.depth > 100000'))).toEqual([])
  })

  it('means the SAME thing as it does on a feature layer', () => {
    const all = dispatchedDepths()
    const expr = filterExpr('.depth > 20')
    const asFeatures = {
      type: 'FeatureCollection' as const,
      features: all.map((depth) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [0, 0] },
        properties: { depth },
      })),
    }
    const viaFeaturePath = applyFilter(asFeatures, expr).features.map(
      (f) => (f.properties as { depth: number }).depth,
    )
    expect(dispatchedDepths(expr)).toEqual(viaFeaturePath)
  })
})
