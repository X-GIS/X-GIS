// symbol-placement runtime wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: `symbol-placement`
// is marked `supported` (constant) in the symbol capability table +
// paint/layout-symbol spec-coverage, and has COMPILER lower tests
// (symbol-placement-step.test.ts, mapbox-convert), but no RUNTIME wiring
// test proves the compiled LabelDef.placement field actually reaches and
// steers the per-frame label dispatch. A wiring break (placement dropped
// or mis-branched) would ship silently — the heatmap-class bug this corpus
// targets.
//
// The runtime consumer is the label dispatch's point-vs-line branch:
//   render-loop-helpers.ts:160  isLineLabel = def.placement === 'line'
//                                            || def.placement === 'line-center'
// which (for a non-line, map-aligned point label under a nonzero camera
// bearing) bakes the bearing into the label rotation, and for a `line`
// placement leaves rotation untouched. `resolveLabelEffectiveDef` is the
// exported, pure CPU function the render loop calls each frame to collapse
// a show into its `effectiveDef`; label-pass.ts:619 reads
// `effectiveDef.placement` for the SAME line-vs-point split. We drive this
// real function (no GPU) and assert the EXACT prop-controlled output:
//   placement:'point' + rotation-alignment:'map' + bearing 30 → rotate = -30
//   placement:'line'  (same inputs)                           → rotate undefined
// The output differs ONLY because `placement` differs — non-vacuous.
//
// Fail-before: in render-loop-helpers.ts replace
//   const isLineLabel = def.placement === 'line' || def.placement === 'line-center'
// with `const isLineLabel = false` (drops the placement wire). The line
// case then bakes the bearing into rotate (-30) like a point, so the
// `toBeUndefined()` assertion fails — the symbol-placement → dispatch wire
// is gone and this test catches it before any render.

import { describe, it, expect } from 'vitest'
import type { LabelDef } from '@xgis/compiler'
import { resolveLabelEffectiveDef } from '@xgis/map'

const BEARING = 30
const Z = 14
const ELAPSED = 0

/** Build a minimal LabelDef for the given symbol-placement with a
 *  map-aligned text-rotation-alignment, then run the real per-frame
 *  resolver and return the resolved label rotation (undefined if the
 *  resolver left it unset). `shapes` is undefined → all data-driven /
 *  zoom-shape paths short-circuit to the static def, isolating the
 *  placement branch. */
function resolvedRotateFor(placement: 'point' | 'line' | 'line-center'): number | undefined {
  const def: LabelDef = {
    text: { kind: 'literal', value: 'A' } as unknown as LabelDef['text'],
    size: 12,
    placement,
    rotationAlignment: 'map',
  }
  const eff = resolveLabelEffectiveDef(def, undefined, Z, ELAPSED, null, BEARING)
  return eff.rotate
}

describe('symbol-placement runtime wiring (GPU-free)', () => {
  it("placement:'point' (map rotation-alignment) bakes -bearing into rotate", () => {
    // useMapRotForPoints=true → bearingDeg=-BEARING → rotate = (0)+(-30) = -30.
    expect(resolvedRotateFor('point')).toBe(-BEARING)
  })

  it("placement:'line' suppresses the point-bearing rotation (line label)", () => {
    // isLineLabel=true → useMapRotForPoints=false → bearingDeg=0 → rotate unset.
    // Break the placement==='line' branch and this leaks -30 like a point.
    expect(resolvedRotateFor('line')).toBeUndefined()
  })

  it("placement:'line-center' is also treated as a line label (no rotate)", () => {
    expect(resolvedRotateFor('line-center')).toBeUndefined()
  })
})
