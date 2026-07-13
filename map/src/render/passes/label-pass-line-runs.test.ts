import { describe, it, expect } from 'vitest'
import type { GeoJSONFeature } from '@xgis/data'
import type { LabelDef } from '@xgis/compiler'
import { placeInlineLineLabels } from './place-labels-along-line'

// #1050 — line-label placement must SPLIT the polyline at horizon-culled
// samples, never chord-jump. Both line paths projected every vertex and packed
// the survivors into ONE polyline; a culled (null) sample was silently dropped,
// so placeLabelsAlongLine could place a label at the midpoint of a PHANTOM CHORD
// spanning the culled gap — a screen position corresponding to no visible point
// of the line. The fix treats a null projection as a hard run break and places
// labels per contiguous run.
//
// This exercises the inline (raw-GeoJSON) path `placeInlineLineLabels`, which
// splits into runs and delegates each to placeLabelsAlongLine. The vector-tile
// path (label-pass.ts projection loop) trims to the first contiguous run by the
// same rule; both eliminate the phantom-chord placement.

/** A horizontal LineString at lat=0 whose vertices sit at the given lon (== the
 *  projected screen x under the identity projector below). */
const lineFeature = (lons: number[]): GeoJSONFeature =>
  ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: lons.map((x) => [x, 0]) },
  }) as unknown as GeoJSONFeature

/** Identity projector (lon → screen x, lat 0 → y 0), except it CULLS (returns
 *  null) for any lon in `culled` — modelling a horizon-culled sample. */
const projectorCulling =
  (culled: number[]) =>
  (lon: number, _lat: number): [number, number] | null =>
    culled.includes(lon) ? null : [lon, 0]

const LINE_DEF = {
  text: { kind: 'lit', value: 'X' } as unknown,
  placement: 'line',
  spacing: 140,
} as unknown as LabelDef

/** Run placeInlineLineLabels and collect the screen-x of every emitted label. */
function placedXs(lons: number[], culled: number[]): number[] {
  const xs: number[] = []
  placeInlineLineLabels(
    lineFeature(lons),
    LINE_DEF,
    () => LINE_DEF, // applyFeatureExprs — identity
    projectorCulling(culled),
    1, // dpr
    (_v, _p, x) => {
      xs.push(x)
    },
    () => {}, // dispatchIcon — ignored
    undefined,
  )
  return xs.sort((a, b) => a - b)
}

describe('#1050 — inline line labels split runs at culled samples (no phantom chord)', () => {
  // 5 vertices; the middle one (lon=200) is horizon-culled. Contiguous visible
  // runs are [0,100] and [300,400]; the gap 100↔300 is a phantom chord.
  const LONS = [0, 100, 200, 300, 400]

  it('places NO label on the phantom chord spanning the culled gap (fail-before)', () => {
    // Unfixed behaviour packs [0,100,300,400] as one polyline (total 400) and
    // its spacing walk (stops at 70,210,350) puts a label at x≈210 — ON the
    // chord bridging the culled 100↔300 gap. The fix must place labels only
    // WITHIN the two runs, so nothing lands strictly inside (100,300).
    const xs = placedXs(LONS, [200])
    const onPhantom = xs.filter((x) => x > 100.001 && x < 299.999)
    expect(onPhantom, `phantom-chord labels at ${JSON.stringify(onPhantom)}`).toEqual([])
  })

  it('still places labels WITHIN each contiguous run (runs are not dropped)', () => {
    const xs = placedXs(LONS, [200])
    expect(xs.length).toBeGreaterThan(0)
    // A placement inside run [0,100] and one inside run [300,400].
    expect(xs.some((x) => x >= 0 && x <= 100)).toBe(true)
    expect(xs.some((x) => x >= 300 && x <= 400)).toBe(true)
  })

  it('a fully-visible polyline is placed unchanged (a mid-line label survives)', () => {
    // With nothing culled the whole line is one run: the spacing walk over
    // [0..400] places a label at x≈210 (mid-line). This is exactly the placement
    // the culled case must NOT produce on the phantom chord — the direct
    // contrast that pins the split.
    const xs = placedXs(LONS, [])
    expect(xs.some((x) => x > 150 && x < 270)).toBe(true)
  })
})
