// Coverage gate: every fragment shader that hard-discards on cos_c<0
// also applies rim_alpha to its output color. Regression catches a
// future shader edit that copies the discard but forgets the rim
// multiplication — which would silently revert the Phase 7.3 fade.
//
// Text and icon stages are tracked as deferred (separate composite
// pass on the 2D label canvas, rim plumbed at label-resolver level).

import { describe, expect, it } from 'vitest'
import {
  POLYGON_SHADER_SOURCE,
} from './renderer'
import { WGSL_PROJECTION_FNS } from '../shaders/projection'
import { readFileSync } from 'fs'
import { emitRasterWgsl } from '../shader-dsl'
import { join } from 'path'

function readShaderSource(relPath: string): string {
  return readFileSync(join(__dirname, relPath), 'utf8')
}

describe('rim_alpha rollout coverage', () => {
  it('polygon shader (fs_fill / fs_stroke / fs_oit_translucent) calls polygon_rim_alpha', () => {
    // 3 fragment entry points, each multiplies rim into alpha.
    const occurrences = (POLYGON_SHADER_SOURCE.match(/polygon_rim_alpha/g) ?? []).length
    expect(occurrences, 'fs_fill + fs_stroke + fs_oit_translucent should each call polygon_rim_alpha').toBeGreaterThanOrEqual(3)
  })

  it('line shader calls line_rim_alpha in fs_line and fs_line_max', () => {
    // WGSL moved to line-renderer-shaders.ts (renderer re-exports LINE_SHADER_SOURCE).
    const src = readShaderSource('line-renderer-shaders.ts')
    const occurrences = (src.match(/line_rim_alpha/g) ?? []).length
    // 1 definition + 2 uses (fs_line + fs_line_max)
    expect(occurrences).toBeGreaterThanOrEqual(3)
  })

  it('point shader passes rim_a flat varying and applies it in fs_point', () => {
    // WGSL moved to point-renderer-shaders.ts (renderer re-exports POINT_SHADER).
    const src = readShaderSource('point-renderer-shaders.ts')
    expect(src).toContain('point_rim_alpha')
    expect(src).toContain('color.a = color.a * in.rim_a')
  })

  it('raster shader applies smoothstep rim fade in fs_tile', () => {
    const src = emitRasterWgsl(false)
    expect(src).toContain('smoothstep(0.0, 0.02, input.vis)')
    expect(src).toContain('u.raster_params.x) * rim')
  })

  it('rim_alpha function is emitted into WGSL_PROJECTION_FNS', () => {
    // The projection block is now DSL-emitted (shader-dsl/projections.ts), so
    // check the emitted string carries the fn — not the source file text.
    expect(WGSL_PROJECTION_FNS).toContain('fn rim_alpha(lon_deg: f32, lat_deg: f32, proj_params: vec4<f32>) -> f32')
  })
})
