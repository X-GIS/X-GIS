// text-halo-width: ShowCommand paint-shape → effectiveDef.halo.width wiring
// (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: text-halo-width is
// marked `supported` (constant + zoom-interp) in the symbol capability table
// (runtime/src/capabilities/symbol.ts:16-17), but the ONLY behavioral test was
// the DOWNSTREAM packing math (text/halo-uniforms.test.ts), which constructs a
// TextDraw with halo.width already filled in by hand. The UPSTREAM wire — the
// per-frame resolution that turns the resolved `text-halo-width` PropertyShape
// (shapes.textPaint.haloWidth) into effectiveDef.halo.width — had no behavioral
// coverage. A break there (the paint field stops being threaded into the
// effective LabelDef) would ship silently: the prop is "supported" yet halos
// would render at the static default, not the authored width.
//
// This drives the REAL resolveLabelEffectiveDef (render-loop-helpers.ts) — the
// per-frame ShowCommand→runtime label-paint collapse — with a zoom-interpolated
// text-halo-width shape and asserts the resolved value lands in
// effectiveDef.halo.width. The stops are non-trivial (2→12 over zoom 0→10) and
// the test reads it at TWO distinct zooms (z=3 → 5, z=5 → 7), so the assertion
// is a genuine FUNCTION of the prop, never a constant.
//
// Fail-before: in render-loop-helpers.ts replace
//   `const baseWidth = haloWidthOverride ?? def.halo?.width ?? 0`
// with `const baseWidth = 0` (drop the resolved-shape thread). Both assertions
// go red — the text-halo-width wire no longer reaches the renderer, and the
// test catches it before any render.

import { describe, it, expect } from 'vitest'
import type { LabelDef } from '@xgis/compiler'
import { resolveLabelEffectiveDef } from '@xgis/map'

// A zoom-interpolated text-halo-width shape: halo width 2 px at z0 → 12 px at
// z10, linear. interpolateZoom (base 1) gives width = 2 + (z/10)*(12-2):
//   z=3 → 5,  z=5 → 7.
const haloWidthShape = {
  kind: 'zoom-interpolated',
  stops: [{ zoom: 0, value: 2 }, { zoom: 10, value: 12 }],
} as never

// Minimal LabelDef + LabelShapes bundle. resolveLabelEffectiveDef reads
// shapes.textLayout.size (constant → falls back to def.size) and
// shapes.textPaint.color (null → falls back to layer fill); only
// shapes.textPaint.haloWidth carries the property under test.
const def: LabelDef = { text: { kind: 'literal', value: 'X' } as never, size: 12 }

const shapes = {
  textLayout: { size: { kind: 'constant', value: 12 }, font: null, fontWeight: null, fontStyle: null },
  textPaint: { color: null, haloWidth: haloWidthShape, haloColor: null, haloBlur: null, opacity: null },
  icon: { iconSize: null, iconOpacity: null, iconColor: null },
} as never

function resolveHaloWidthAt(z: number): number | undefined {
  const eff = resolveLabelEffectiveDef(def, shapes, z, /* elapsedMs */ 0, '#ffffff', /* bearing */ 0)
  return eff.halo?.width
}

describe('text-halo-width wiring — resolved shape reaches effectiveDef.halo.width (GPU-free)', () => {
  it('zoom-interpolated text-halo-width = 5 px at z=3', () => {
    // 2 + (3/10)*(12-2) = 5. Break the baseWidth thread → undefined/0, fails.
    expect(resolveHaloWidthAt(3)).toBeCloseTo(5, 6)
  })

  it('zoom-interpolated text-halo-width = 7 px at z=5 (tracks the prop, not a constant)', () => {
    // 2 + (5/10)*(12-2) = 7. The two zooms differ ⇒ the wire carries the
    // PROP value, not any fixed fallback.
    expect(resolveHaloWidthAt(5)).toBeCloseTo(7, 6)
  })
})
