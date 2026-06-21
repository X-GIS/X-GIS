import { describe, expect, it } from 'vitest'
import { emitCompositeWgsl } from '@xgis/shader-dsl/shaders/line'
import { LineRenderer } from './line-renderer'

// ── Regression #284 (introduced by #259): composite bind size < pipeline min ──
//
// #259 replaced the single 32-byte composite uniform buffer with a dynamic-offset
// ring and set the bind `size` to COMPOSITE_USED = 16, mis-computed as
// "f32 opacity + vec3f pad = 16". But the WGSL `CompUniform { opacity: f32,
// _pad: vec3f }` has std140-style layout: vec3f ALIGNS to 16, so opacity sits at
// 0, _pad at 16, and the struct rounds up to 32 bytes. A bind range of 16 is
// smaller than the pipeline's minimum binding size, so a REAL GPU rejects every
// translucent-line composite draw at frame-validation:
//   "[Buffer "line-composite-ring"] bound with size 16 … requires at least 32".
// #259's mock-device reproduce test never caught it because a mock does not
// enforce WebGPU's minimum-binding-size validation (see
// feedback_verification_holistic_not_granular: mock unit tests verify CPU math,
// not real render/validation). This test closes that gap WITHOUT a GPU by
// deriving the required size from the emitted WGSL struct itself.

/** std140-ish byte layout (size + alignment) of the WGSL scalar/vector types
 *  that can appear in a composite uniform struct. Matches WGSL's uniform
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
  const m = src.match(new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`, 's'))
  if (!m) throw new Error(`struct ${name} not found in emitted WGSL`)
  const fields = m[1]
    .split(/[;,\n]/).map((s) => s.trim()).filter(Boolean)
    .map((line) => {
      const fm = line.match(/^[\w]+\s*:\s*(.+?)\s*$/)
      if (!fm) throw new Error(`unparseable struct field: "${line}"`)
      return fm[1].replace(/\s+/g, '')
    })
  let cursor = 0
  let maxAlign = 1
  for (const ty of fields) {
    const lay = WGSL_TYPE_LAYOUT[ty]
    if (!lay) throw new Error(`unknown WGSL type "${ty}" — extend WGSL_TYPE_LAYOUT`)
    const off = roundUp(cursor, lay.align)
    cursor = off + lay.size
    maxAlign = Math.max(maxAlign, lay.align)
  }
  return roundUp(cursor, maxAlign)
}

describe('LineRenderer composite bind size (regression #284)', () => {
  it('CompUniform std140 size is 32 ({f32, vec3f}), not 16', () => {
    // Pins the derivation: vec3f aligns to 16, so {opacity:f32, _pad:vec3f} = 32.
    const size = wgslStructSize(emitCompositeWgsl(), 'CompUniform')
    expect(size).toBe(32)
  })

  it('the composite bind size is >= the CompUniform std140 size', () => {
    const required = wgslStructSize(emitCompositeWgsl(), 'CompUniform')
    const used = (LineRenderer as unknown as { COMPOSITE_USED: number }).COMPOSITE_USED
    // The bind `size` passed to the composite bind group MUST be >= the
    // pipeline's minimum binding size (= the struct's std140 size), or WebGPU
    // rejects the draw. Pre-fix used=16 < required=32 → the #284 validation error.
    expect(used).toBeGreaterThanOrEqual(required)
  })

  it('the composite slot stride is a multiple of 256 and >= the bind size', () => {
    const used = (LineRenderer as unknown as { COMPOSITE_USED: number }).COMPOSITE_USED
    const slot = (LineRenderer as unknown as { COMPOSITE_SLOT: number }).COMPOSITE_SLOT
    // Dynamic-offset uniforms must be 256-aligned, and a slot must hold the bind.
    expect(slot % 256).toBe(0)
    expect(slot).toBeGreaterThanOrEqual(used)
  })
})
