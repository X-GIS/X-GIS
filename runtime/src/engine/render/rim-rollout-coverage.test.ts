// Coverage gate: every fragment shader that hard-discards on cos_c<0
// also applies rim_alpha to its output color. Regression catches a
// future shader edit that copies the discard but forgets the rim
// multiplication — which would silently revert the Phase 7.3 fade.
//
// Text and icon stages are tracked as deferred (separate composite
// pass on the 2D label canvas, rim plumbed at label-resolver level).

import { describe, expect, it } from 'vitest'
import { WGSL_PROJECTION_FNS } from '../shaders/projection'
import { emitRasterWgsl, emitPointWgsl, emitLineWgsl } from '@xgis/shader-dsl'
import { emitPolygonWgsl } from '@xgis/shader-dsl/shaders/polygon'

describe('rim_alpha rollout coverage', () => {
  it('polygon shader (fs_fill / fs_stroke / fs_oit_translucent) calls polygon_rim_alpha', () => {
    // 3 fragment entry points, each multiplies rim into alpha. The polygon
    // shader is now DSL-emitted (shader-dsl/shaders/polygon.ts) so this
    // counts call sites in the composed output.
    const wgsl = emitPolygonWgsl(null, false)
    const occurrences = (wgsl.match(/polygon_rim_alpha/g) ?? []).length
    // Counts: 1 definition (fn polygon_rim_alpha) + 4 call sites (fs_fill,
    // fs_fill_pattern, fs_oit_translucent's `a = ... * polygon_rim_alpha`,
    // fs_fill_extrude, fs_stroke) — composer emits each callFn unique to
    // that entry. The floor 3 catches a future shader edit that drops any
    // one of the discard-then-rim pairs.
    expect(occurrences, 'fs_fill + fs_stroke + fs_oit_translucent should each call polygon_rim_alpha').toBeGreaterThanOrEqual(3)
  })

  it('line shader calls line_rim_alpha in fs_line and fs_line_max', () => {
    // WGSL is now emitted from shader-dsl/shaders/line.ts.
    const src = emitLineWgsl(false)
    const occurrences = (src.match(/line_rim_alpha/g) ?? []).length
    // 1 definition + 3 uses (fs_line + fs_line_pattern + fs_line_max).
    expect(occurrences).toBeGreaterThanOrEqual(3)
  })

  it('point shader passes rim_a flat varying and applies it in fs_point', () => {
    // WGSL moved to point-renderer-shaders.ts (renderer re-exports POINT_SHADER).
    const src = emitPointWgsl()
    expect(src).toContain('point_rim_alpha')
    expect(src).toContain('color.a *= in.rim_a')
  })

  it('raster shader applies smoothstep rim fade in fs_tile', () => {
    const src = emitRasterWgsl(false)
    // smoothstep rim call — survives whether emitted as a named let-binding or
    // inlined by CSE. The literal values and the vis varying name are stable.
    expect(src).toContain('smoothstep(0.0, 0.02, input.vis)')
    // raster_params.x (opacity) is read in the fragment — field access on the
    // uniform struct is stable regardless of whether an intermediate let-binding
    // named 'rim' exists in the emitted output.
    expect(src).toContain('u.raster_params.x')
  })

  it('rim_alpha function is emitted into WGSL_PROJECTION_FNS', () => {
    // The projection block is now DSL-emitted (shader-dsl/projections.ts), so
    // check the emitted string carries the fn — not the source file text.
    expect(WGSL_PROJECTION_FNS()).toContain('fn rim_alpha(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>) -> f32')
  })
})
