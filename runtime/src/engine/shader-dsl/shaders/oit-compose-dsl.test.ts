// ═══ OIT compose — emit smoke test ═══
//
// Verifies emitOitComposeWgsl() emits a valid-shaped WGSL string with
// the right binding type for MSAA / single-sample paths. The behavioural
// gate is the runtime pipeline (renderer.ts createShaderModule at OIT
// compose pipeline init); this test catches obvious structural drift
// (missing entrypoint / wrong binding type) at unit-test time.

import { describe, it, expect } from 'vitest'
import { emitOitComposeWgsl } from './oit-compose'

describe('oit-compose DSL emit', () => {
  it('MSAA path emits texture_multisampled_2d bindings', () => {
    const w = emitOitComposeWgsl(4, true)
    expect(w).toContain('texture_multisampled_2d<f32>')
    expect(w).not.toMatch(/var\s+accum_tex:\s*texture_2d</)
    expect(w).toContain('@vertex')
    expect(w).toContain('@fragment')
    expect(w).toContain('vs_full')
    expect(w).toContain('fs_compose')
    expect(w).toContain('accum_tex')
    expect(w).toContain('revealage_tex')
  })

  it('single-sample path emits texture_2d bindings', () => {
    const w = emitOitComposeWgsl(1, false)
    expect(w).toContain('texture_2d<f32>')
    expect(w).not.toContain('texture_multisampled_2d')
  })

  it('sampleCount baked into loop bound', () => {
    const w2 = emitOitComposeWgsl(2, true)
    const w4 = emitOitComposeWgsl(4, true)
    // forRange emits "i < 2" / "i < 4" — substring search avoids whitespace pinning
    expect(w2).toContain('< 2')
    expect(w4).toContain('< 4')
    expect(w2).not.toContain('< 4')
  })
})
