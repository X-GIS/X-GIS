import { describe, it, expect } from 'vitest'
import { packLineLayerUniform } from './line-renderer'
import { emitLineWgsl } from '@xgis/shader-dsl/shaders/line'

// Regression: line stroke width must account for the device-pixel ratio.
//
// The projection MVP maps the CSS-pixel viewport to NDC, but the vs_line
// screen-width clamp divides the (CSS-px) width target by viewport_height,
// which is uploaded in DEVICE px. So the clamp dropped a factor of dpr and
// every stroke rendered 1/dpr too thin (roads far narrower than MapLibre on
// any retina / high-DPI display). G (outlines look fuzzy/over-wide) was the
// same defect: a too-thin core under a fixed 1-CSS-px AA reserve.
//
// The structural cause is CPU-testable on two surfaces without a GPU:
//   1. the uniform ABI must carry dpr (slot 46) so the shader CAN read it;
//   2. the emitted vs_line WGSL must multiply the width target by it.
// Both FAIL before the fix (slot 46 was an unwritten pad; the field was
// `_pad_b`, absent from the target_ndc expression).
describe('line stroke width — dpr', () => {
  it('packs dpr into uniform slot 46', () => {
    // Slot 46 per the LineLayerUniform layout doc (line-pattern.ts).
    const buf = packLineLayerUniform(
      [1, 1, 1, 1], 4, 1, 1000,
      undefined, undefined, undefined, null, [], 0, 1080, 0, 2,
    )
    expect(buf[46]).toBe(2)
  })

  it('defaults dpr to 1 when the caller omits it', () => {
    const buf = packLineLayerUniform([1, 1, 1, 1], 4, 1, 1000)
    expect(buf[46]).toBe(1)
  })

  it('multiplies the vs_line width target by layer.dpr', () => {
    const wgsl = emitLineWgsl(false)
    // dpr must appear INSIDE the target_ndc assignment statement (up to the
    // terminating semicolon) — not merely somewhere in the 1300-line shader.
    expect(wgsl).toMatch(/let target_ndc =[^;]*layer\.dpr[^;]*;/)
  })

  // The screen-width clamp's target_ndc is miscalibrated against the
  // perspective viewport scale (it under-targets ~4×), so the raw
  // target_ndc/screen_dist ratio SHRANK every flat stroke to a fraction of its
  // width — roads rendered ~1/3 of the MapLibre width (real-GPU: synthetic
  // stroke-10 fell to 3 px at dpr1). The base quad is (w/2+aa)·mpp metres,
  // which the FS distance field renders at exactly the intended width, so the
  // clamp must only GROW the quad (counter foreshortening), never shrink it.
  // The cap is `max(ratio, 1)`. Fails before (bare `target_ndc / screen_dist`),
  // passes after.
  it('caps the screen-width clamp scale at 1 — never shrinks the stroke quad', () => {
    const wgsl = emitLineWgsl(false)
    expect(wgsl).toMatch(/let scale = max\(\(target_ndc \/ screen_dist\), 1/)
  })
})
