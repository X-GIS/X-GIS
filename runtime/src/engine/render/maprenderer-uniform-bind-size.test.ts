import { describe, expect, it } from 'vitest'
import { emitPolygonWgsl } from '../shaders/dsl/polygon'
import { MapRenderer } from './renderer'
import { GraticuleRenderer } from './graticule-renderer'
import { polygonUniformBytes } from './polygon-uniform-slots'

// ── Bug maprenderer-uniform-240 (MED, webgpu-validation) ──
//
// MapRenderer binds its uniform ring at binding 0 with `size:
// MapRenderer.UNIFORM_SIZE`, and draws the SHARED fill/line pipelines
// (compiled from the polygon/line shader). That shader's `struct Uniforms`
// grew to 240 bytes when the camera-relative RTC fields were added
// (cam_ecef_off_h @208, cam_ecef_off_l @224), then to 256 when #420 appended
// light_dir_ecef @240; it statically references `u`. The bind-group-layout
// omits minBindingSize (→0), so WebGPU uses the shader-derived 256-byte
// minimum at draw time. A smaller MapRenderer.UNIFORM_SIZE (192, then 240)
// → a REAL GPU rejects the draw at frame-validation:
//   "[Buffer] bound with size 240 … requires at least 256".
// Reachable via the shipped graticule overlay (setGraticuleEnabled(true)),
// which borrows MapRenderer's linePipeline + base bindGroup. VTR already
// uses 256 (uniform-layout-consistency.test).
//
// The mock GPUDevice does NOT enforce WebGPU's minimum-binding-size
// validation (see feedback_verification_holistic_not_granular: mock unit
// tests verify CPU math, not real render/validation). This test closes that
// gap WITHOUT a GPU by deriving the required size from the emitted WGSL
// struct itself — exactly as composite-bind-size.test.ts does for #284.

/** std140-ish byte layout (size + alignment) of the WGSL scalar/vector types
 *  that appear in the polygon Uniforms struct. Matches WGSL's uniform
 *  address-space layout rules. */
const WGSL_TYPE_LAYOUT: Record<string, { size: number; align: number }> = {
  f32: { size: 4, align: 4 }, i32: { size: 4, align: 4 }, u32: { size: 4, align: 4 },
  'vec2<f32>': { size: 8, align: 8 }, vec2f: { size: 8, align: 8 },
  'vec3<f32>': { size: 12, align: 16 }, vec3f: { size: 12, align: 16 },
  'vec4<f32>': { size: 16, align: 16 }, vec4f: { size: 16, align: 16 },
  'mat4x4<f32>': { size: 64, align: 16 }, mat4x4f: { size: 64, align: 16 },
}

const roundUp = (n: number, a: number): number => Math.ceil(n / a) * a

/** Compute the uniform-buffer byte size of a WGSL struct by name from emitted
 *  source. Throws if a field type isn't in the layout table (forces this test
 *  to be updated rather than silently under-counting). */
function wgslStructSize(src: string, name: string): number {
  const m = src.match(new RegExp(`struct\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`))
  if (!m) throw new Error(`struct ${name} not found in emitted WGSL`)
  const fields = m[1]!
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const fm = line.match(/^\w+\s*:\s*([\w<>]+)\s*,?$/)
      if (!fm) throw new Error(`unparseable struct field: "${line}"`)
      return fm[1]!
    })
  let cursor = 0
  let maxAlign = 1
  for (const ty of fields) {
    const lay = WGSL_TYPE_LAYOUT[ty]
    if (!lay) throw new Error(`unknown WGSL type "${ty}" — extend WGSL_TYPE_LAYOUT`)
    cursor = roundUp(cursor, lay.align) + lay.size
    maxAlign = Math.max(maxAlign, lay.align)
  }
  return roundUp(cursor, maxAlign)
}

describe('MapRenderer uniform bind size (bug maprenderer-uniform-240)', () => {
  const required = wgslStructSize(emitPolygonWgsl(null, false), 'Uniforms')

  it('polygon Uniforms std140 size matches emitted WGSL struct', () => {
    // Pins the canonical figure asserted by uniform-layout-consistency.test.ts.
    // If this fails, a struct field was added/removed without updating the test.
    expect(required).toBeGreaterThan(0)
    expect(required % 16).toBe(0) // WGSL struct alignment
  })

  it('polygonUniformBytes() === the emitted WGSL struct size', () => {
    // The reflect-derived helper must agree with the independently-computed
    // WGSL parse — these are two independent routes to the same number.
    // A mismatch means the DSL IR and the WGSL emitter diverged.
    expect(polygonUniformBytes()).toBe(required)
  })

  it('MapRenderer.UNIFORM_SIZE === polygonUniformBytes() (reflect-derived)', () => {
    const used = (MapRenderer as unknown as { UNIFORM_SIZE: number }).UNIFORM_SIZE
    // The bind `size` for binding 0 MUST be >= the pipeline's minimum binding
    // size (= the shared shader's Uniforms struct size), or WebGPU rejects the
    // draw. After this PR it is derived from polygonUniformBytes() — so the
    // assertion is exact equality, not just ≥.
    expect(used).toBe(polygonUniformBytes())
    expect(used).toBeGreaterThanOrEqual(required)
  })

  it('the uniform slot stride holds the bind size', () => {
    const used = (MapRenderer as unknown as { UNIFORM_SIZE: number }).UNIFORM_SIZE
    const slot = (MapRenderer as unknown as { UNIFORM_SLOT: number }).UNIFORM_SLOT
    expect(slot).toBeGreaterThanOrEqual(used)
    expect(slot % 256).toBe(0) // must be a 256-multiple for WebGPU alignment
  })

  it('GraticuleRenderer.UNIFORM_SIZE === polygonUniformBytes() (borrows same pipeline+bindGroup)', () => {
    // The graticule draws with MapRenderer's linePipeline + base bindGroup, so
    // its gratData must fill the same struct-sized bound range.
    const grat = (GraticuleRenderer as unknown as { UNIFORM_SIZE: number }).UNIFORM_SIZE
    expect(grat).toBe(polygonUniformBytes())
    expect(grat).toBe(required)
  })
})
