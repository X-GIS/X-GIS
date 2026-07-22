// By-construction gate for the declarative arrow layer's packer (#1302). The
// strongest guarantee: the compiled packer is BYTE-IDENTICAL to the already-
// proven retained-arrow packer (#824/#825) for equivalent inputs, so the
// declarative `| arrow bearing-[.dir]` layer orients/sizes/colours exactly like
// a `map.graphics.add({ type:'arrow' })` batch — no GPU needed to prove it.
import { describe, it, expect } from 'vitest'
import {
  packRetainedArrowFeat,
  packRetainedArrowTint,
  packCompiledArrowFeat,
  packCompiledArrowTint,
} from './retained-arrow-packer'
import { ARROW_RETAINED_FEAT } from '../shaders/dsl/arrow-retained-feat-layout'
import type { ArrowDrawSpec } from './graphics-types'

const F = ARROW_RETAINED_FEAT.slot
const S = ARROW_RETAINED_FEAT.stride

// Parallel per-feature arrays (index = feature) — as the rebuildLayers arrow
// fork will bake them from the source features' evaluated .dir / size / fill.
const lons = [10, -30, 126.98, -76.0]
const lats = [20, 45, 37.57, 38.0]
const bearings = [0, 90, 45, 210]
const sizes = [12, 20, 16, 34]
const rgba: Array<[number, number, number, number]> = [
  [1, 0, 0, 1],
  [0, 1, 0, 0.5],
  [0.2, 0.3, 0.4, 1],
  [0.9, 0.7, 0.1, 0.8],
]
const DPR = 2

describe('compiled arrow packer (#1302)', () => {
  it('is byte-identical to the proven retained-arrow packer for equivalent inputs', () => {
    const spec: ArrowDrawSpec<number> = {
      type: 'arrow',
      data: lons.map((_, i) => i),
      getPosition: (i) => [lons[i]!, lats[i]!] as const,
      getBearing: (i) => bearings[i]!,
      getSize: (i) => sizes[i]!,
      getColor: (i) => rgba[i]!,
    }
    expect(packCompiledArrowFeat(lons, lats, bearings, sizes, DPR)).toEqual(
      packRetainedArrowFeat(spec, DPR),
    )
    expect(packCompiledArrowTint(rgba)).toEqual(packRetainedArrowTint(spec))
  })

  it('packs tail = anchor, size = px × dpr, tint = rgba per feature', () => {
    const feat = packCompiledArrowFeat(lons, lats, bearings, sizes, DPR)
    const tint = packCompiledArrowTint(rgba)
    for (let i = 0; i < lons.length; i++) {
      const o = i * S
      // feat/tint are Float32Array — storing applies ToFloat32, so assert exact
      // fround(value), not full-precision closeness (a value like 126.98 or 0.2
      // cannot be held to 6 decimals in f32).
      expect(feat[o + F.abs_lon]).toBe(Math.fround(lons[i]!))
      expect(feat[o + F.abs_lat]).toBe(Math.fround(lats[i]!))
      expect(feat[o + F.size]).toBe(Math.fround(sizes[i]! * DPR))
      for (let k = 0; k < 4; k++) expect(tint[i * 4 + k]).toBe(Math.fround(rgba[i]![k]!))
    }
  })

  it('steps the tip along the bearing (0 = N clockwise)', () => {
    // bearing 90 (east) → tip east of tail, same lat; bearing 0 (north) → tip
    // north of tail, same lon.
    const feat = packCompiledArrowFeat([0, 0], [0, 0], [90, 0], [10, 10], 1)
    expect(feat[0 * S + F.tip_abs_lon]).toBeGreaterThan(feat[0 * S + F.abs_lon]!)
    expect(feat[0 * S + F.tip_abs_lat]).toBeCloseTo(feat[0 * S + F.abs_lat]!, 6)
    expect(feat[1 * S + F.tip_abs_lat]).toBeGreaterThan(feat[1 * S + F.abs_lat]!)
    expect(feat[1 * S + F.tip_abs_lon]).toBeCloseTo(feat[1 * S + F.abs_lon]!, 6)
  })
})
