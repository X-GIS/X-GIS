// text-rotation-alignment: 'map'/'viewport'/'auto' point-label rotation
// wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: text-rotation-alignment
// is marked `supported` in the symbol capability table
// (runtime/src/capabilities/symbol.ts) and the converter emits the
// `label-rotation-alignment-{map,viewport,auto}` utility, which lower-label
// records as LabelDef.rotationAlignment. But the only coverage was structural
// (converter emits a utility) + the enum-literal compiler tests — nothing
// pinned the RUNTIME consumer, so a break in the threading would ship silently
// (the heatmap-class wiring bug).
//
// The runtime consumer is resolveLabelEffectiveDef (render-loop-helpers.ts):
// for a POINT label with rotationAlignment === 'map', the resolver bakes the
// camera bearing into the label rotate —
//     effectiveDef.rotate = (def.rotate ?? 0) + (-cameraBearing)
// — so the text follows the world, not the viewport. For 'viewport' / 'auto'
// (and the unset default) NO bearing is added (effectiveDef.rotate stays
// def.rotate). This is the exact CPU-observable byte text-rotation-alignment
// controls; the per-feature dispatch loop (label-pass) consumes effectiveDef.
//
// This drives the REAL resolveLabelEffectiveDef (no GPU — it is a pure
// resolver) and asserts effectiveDef.rotate as a function of rotationAlignment
// and cameraBearing, never a constant.
//
// Fail-before: in render-loop-helpers.ts replace `? -cameraBearing :` with
// `? 0 :` in the `bearingDeg` line. The map-case assertion (rotate ===
// baseRotate - bearing) goes red while the viewport/default assertions stay
// green — proving this test pins the wire that makes text-rotation-alignment
// 'map' actually reach the rendered label.

import { describe, it, expect } from 'vitest'
import type { LabelDef } from '@xgis/compiler'
import { resolveLabelEffectiveDef } from '../../render-loop-helpers'

// Minimal point LabelDef. Only `text` + `size` are required; `placement`
// defaults to point (undefined), which is the case where rotation-alignment
// 'map' adds the bearing. `rotate` is the static baseline the resolver adds
// the baked bearing onto.
const BASE_ROTATE = 12
const CAMERA_BEARING = 30

function makeDef(rotationAlignment?: 'map' | 'viewport' | 'auto'): LabelDef {
  return {
    text: { kind: 'template', parts: [{ kind: 'literal', value: 'A' }] },
    size: 14,
    rotate: BASE_ROTATE,
    ...(rotationAlignment !== undefined ? { rotationAlignment } : {}),
  }
}

/** Run the real per-show resolver (no shapes, no GPU) and return the resolved
 *  label rotate for the given rotation-alignment under a non-zero camera
 *  bearing. */
function resolvedRotate(
  rotationAlignment: 'map' | 'viewport' | 'auto' | undefined,
  cameraBearing: number,
): number | undefined {
  const eff = resolveLabelEffectiveDef(
    makeDef(rotationAlignment),
    undefined,        // no LabelShapes bundle — exercise the static path
    8,                // z
    0,                // elapsedMs
    null,             // layerFill
    cameraBearing,
  )
  return eff.rotate
}

describe('text-rotation-alignment point-label rotation wiring (GPU-free)', () => {
  it("'map' bakes -cameraBearing into the point-label rotate", () => {
    // The wire: rotationAlignment 'map' → effectiveDef.rotate gains
    // (-cameraBearing). Break `-cameraBearing` → 0 and this fails.
    expect(resolvedRotate('map', CAMERA_BEARING)).toBeCloseTo(
      BASE_ROTATE - CAMERA_BEARING, 6,
    )
  })

  it("'map' rotation tracks the camera bearing (non-vacuous: value depends on bearing)", () => {
    // A second, different bearing — proves the asserted value is a function of
    // cameraBearing, not a constant or an artefact of one input.
    expect(resolvedRotate('map', 90)).toBeCloseTo(BASE_ROTATE - 90, 6)
    expect(resolvedRotate('map', -45)).toBeCloseTo(BASE_ROTATE + 45, 6)
  })

  it("'viewport' adds NO bearing — point label stays at its static rotate", () => {
    expect(resolvedRotate('viewport', CAMERA_BEARING)).toBeCloseTo(BASE_ROTATE, 6)
  })

  it("'auto' (and unset default) resolve to viewport for point labels — no bearing", () => {
    expect(resolvedRotate('auto', CAMERA_BEARING)).toBeCloseTo(BASE_ROTATE, 6)
    expect(resolvedRotate(undefined, CAMERA_BEARING)).toBeCloseTo(BASE_ROTATE, 6)
  })
})
