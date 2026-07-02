// ═══ shader-dsl examples — emit gate ═══
//
// The examples are the /shader-dsl site's runnable content, so they MUST stay WebGL2-valid.
// This guards what the unit shape-tests can't see from inside the package: that the SHIPPED
// examples emit GLSL ES 3.00 with no WGSL-ism leaks (the `f32()` cast, an `in`-named param)
// and with the int→uint cast on gl_VertexID. The real-WebGL2 compile+render of these same
// modules is the sibling Playwright spec (playground/e2e/_shader-dsl-examples-render.spec.ts).

import { describe, it, expect } from 'vitest'
import { examples } from './index.ts'
import { emitGlslModule, reflect } from '../src/index.ts'

describe('shader-dsl examples', () => {
  it('every example reflects a pipeline', () => {
    expect(examples.length).toBeGreaterThan(0)
    for (const ex of examples) {
      // WGSL emit bytes are pinned exactly by emit-goldens.test.ts (#763 V3) — the old
      // `.length > 50` check here was near-vacuous and is superseded by that gate.
      expect(reflect(ex.module), ex.id).toBeTruthy()
    }
  })

  it('renderable examples emit WebGL2-valid GLSL ES 3.00 (no WGSL-ism leaks)', () => {
    const renderable = examples.filter((e) => e.renderable)
    expect(renderable.length).toBeGreaterThan(0)
    for (const ex of renderable) {
      const vs = emitGlslModule(ex.module, 'vertex')
      const fs = emitGlslModule(ex.module, 'fragment')
      for (const src of [vs, fs]) {
        expect(src.startsWith('#version 300 es'), ex.id).toBe(true)
        // scalar casts must be GLSL-spelled (float/int/uint), never the WGSL f32()/i32()/u32()
        expect(src, ex.id).not.toMatch(/\b(f32|i32|u32)\(/)
        // `in` is a GLSL reserved word — never emitted as a bare identifier
        expect(src, ex.id).not.toMatch(/\b(VsOut|vec[234]|float) in\b/)
      }
      // gl_VertexID is `int`; a u32 vertex_index param must be cast for overload resolution
      expect(vs, ex.id).toContain('uint(gl_VertexID)')
    }
  })

  it('the compute example stays WGSL-only (no GLSL ES compute/SSBO)', () => {
    const compute = examples.find((e) => e.category === 'compute')
    expect(compute).toBeTruthy()
    expect(compute!.renderable).toBe(false)
    expect(() => emitGlslModule(compute!.module, 'fragment')).toThrow()
  })
})
