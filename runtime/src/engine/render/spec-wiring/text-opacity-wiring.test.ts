// text-opacity paint wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: text-opacity is marked
// `supported` (constant + zoom-interp) in capabilities/symbol.ts, but the
// non-constant runtime contract — multiply the resolved text-opacity scalar
// into the resolved text-fill alpha AND the halo-colour alpha, per frame —
// had no behavioral test. The wire lives in the PURE function
// resolveLabelEffectiveDef (render-loop-helpers.ts:178-193), consumed every
// frame by the label pass (render/passes/label-pass.ts:455). Because the
// consumer is a pure CPU function (no `this`, no GPU coupling — see the
// module header), this drives the REAL function directly: no WebGPU stub is
// needed, and it is GPU-free by construction.
//
// Contract pinned here: with text fill α = 0.8, halo α = 1.0, and a constant
// text-opacity of 0.5, the returned effectiveDef.color[3] === 0.8 * 0.5 and
// effectiveDef.halo.color[3] === 1.0 * 0.5. The asserted bytes are a PRODUCT
// of the prop — varying OPACITY moves both — so the test is non-vacuous (it
// asserts no constant and nothing independent of text-opacity).
//
// Fail-before: replace `resolvedColor[3] * clamped` with `resolvedColor[3] * 1`
// (drop the opacity factor) and the fill-alpha assertion goes red — the wire
// that makes text-opacity reach the text fill is gone, caught before render.

import { describe, it, expect } from 'vitest'
import type { LabelDef } from '@xgis/compiler'
import { resolveLabelEffectiveDef } from '../../render-loop-helpers'

// Probe values. The fill/halo base alphas and the opacity are all distinct so
// the asserted products (FILL_A*OPACITY, HALO_A*OPACITY) are unambiguous and
// uniquely attributable to the text-opacity multiply.
const FILL_A = 0.8
const HALO_A = 1.0
const OPACITY = 0.5

// A complete LabelShapes with text-opacity authored as a constant 0.5, an
// explicit text-color (so resolvedColor is defined from the shape, not the
// layer-fill fallback) and an explicit halo (so the halo-alpha branch fires).
// Every other axis is null / a benign constant so only the opacity axis is
// under test.
function makeShapes(opacity: number): NonNullable<LabelDef['shapes']> {
  return {
    textPaint: {
      color: { kind: 'constant', value: [1, 1, 1, FILL_A] },
      haloWidth: null,
      haloColor: null,
      haloBlur: null,
      opacity: { kind: 'constant', value: opacity },
    },
    textLayout: {
      size: { kind: 'constant', value: 16 },
      font: null,
      fontWeight: null,
      fontStyle: null,
    },
    icon: {
      iconSize: null,
      iconOpacity: null,
      iconColor: null,
    },
  }
}

// Minimal LabelDef: text + size are required; halo gives the halo-alpha
// multiply a target. color is left to the shape (above).
function makeDef(): LabelDef {
  return {
    text: { kind: 'expr', expr: 'name' } as unknown as LabelDef['text'],
    size: 16,
    halo: { color: [0, 0, 0, HALO_A], width: 1 },
  } as LabelDef
}

/** Run the real per-frame label paint resolver and return the effectiveDef. */
function resolve(opacity: number): LabelDef {
  return resolveLabelEffectiveDef(
    makeDef(),
    makeShapes(opacity),
    /* z */ 8,
    /* elapsedMs */ 0,
    /* layerFill */ '#ffffff',
    /* cameraBearing */ 0,
  )
}

describe('text-opacity paint wiring (GPU-free)', () => {
  it('multiplies text-opacity into the resolved text-fill alpha', () => {
    const def = resolve(OPACITY)
    expect(def.color, 'effectiveDef.color must be defined').toBeTruthy()
    // 0.8 (fill α) * 0.5 (text-opacity) = 0.4 — break the multiply and this fails.
    expect(def.color![3]).toBeCloseTo(FILL_A * OPACITY, 5)
  })

  it('multiplies text-opacity into the resolved halo-colour alpha', () => {
    const def = resolve(OPACITY)
    expect(def.halo, 'effectiveDef.halo must be defined').toBeTruthy()
    // 1.0 (halo α) * 0.5 (text-opacity) = 0.5.
    expect(def.halo!.color[3]).toBeCloseTo(HALO_A * OPACITY, 5)
  })

  it('is non-vacuous: a different opacity yields a different fill alpha', () => {
    // Opacity 1.0 leaves the fill alpha at its base; 0.5 halves it. If the
    // wire ignored the prop these would be equal — proving the assertion
    // tracks text-opacity and not a constant.
    const full = resolve(1.0)
    const half = resolve(0.5)
    expect(full.color![3]).toBeCloseTo(FILL_A, 5)
    expect(half.color![3]).toBeCloseTo(FILL_A * 0.5, 5)
    expect(half.color![3]).not.toBeCloseTo(full.color![3], 3)
  })
})
