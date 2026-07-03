// US-3 — the GLSL ES 3.00 writer proves the IR is target-neutral: ONE authored
// graph emits valid GLSL spelling AND (the same IR) WGSL spelling. The writer
// owns every lexeme; the IR owns none.

import { describe, it, expect } from 'vitest'
import { emitGlslModule, emitModule } from '@xgis/shader-dsl'
import { LOG_DEPTH_MODULE } from './log-depth'
import { getPROJECTION_MODULE } from './projections'

describe('glsl-es300 backend — backend-neutral emit', () => {
  it('emits the log-depth math module as valid GLSL ES 3.00', () => {
    const glsl = emitGlslModule(LOG_DEPTH_MODULE)
    // GLSL spelling: version header, float-first decls, GLSL types.
    expect(glsl.startsWith('#version 300 es')).toBe(true)
    expect(glsl).toContain('vec4 apply_log_depth(vec4 pos, float fc)')
    expect(glsl).toContain('float ') // GLSL `float z = …`, not WGSL `let z`
    // NO WGSL lexemes leaked through.
    expect(glsl).not.toContain('vec4<f32>')
    expect(glsl).not.toContain('vec3<f32>')
    expect(glsl).not.toMatch(/\bfn\b/) // no WGSL `fn` keyword
    expect(glsl).not.toContain('@') // no WGSL attributes
    expect(glsl).not.toContain('let ') // no WGSL `let`
  })

  it('the SAME IR emits WGSL spelling — the writer owns the lexeme, not the IR', () => {
    const wgsl = emitModule(LOG_DEPTH_MODULE)
    expect(wgsl).toContain('fn apply_log_depth(pos: vec4<f32>, fc: f32) -> vec4<f32>')
    expect(wgsl).toContain('vec4<f32>')
    // The z value (log2(max(...)) * fc * w) is emitted in WGSL spelling. Post-CSE-migration
    // a single-use value is inlined rather than hand-bound to `let z`, so assert the SEMANTIC
    // content of the z computation (the log2/max call structure × the `fc` multiply) — robust
    // to the let-vs-inline shape and to any `_cseN` temp name.
    expect(wgsl).toMatch(/log2\(max\([\s\S]*\*\s*fc\b/)
  })

  it('lowers the divergent intrinsics on the projection graph (select→ternary, atan2→atan, consts)', () => {
    // setupFiles configures the projection spec list; getPROJECTION_MODULE is a
    // pure-math module (consts + funcs, no IO/bindings) → fully GLSL-emittable.
    const glsl = emitGlslModule(getPROJECTION_MODULE())
    expect(glsl.startsWith('#version 300 es')).toBe(true)
    // GLSL const spelling: `const float PI = …` (type-first), not `const PI: f32`.
    expect(glsl).toMatch(/const float \w+ = /)
    expect(glsl).not.toContain(': f32')
    // select(false, true, cond) → (cond ? true : false): no 3-arg select() builtin.
    expect(glsl).not.toMatch(/\bselect\(/)
    expect(glsl).toMatch(/\? .* : /) // a ternary is present
    // atan2(y, x) → atan(y, x): no atan2 builtin in GLSL ES.
    expect(glsl).not.toContain('atan2(')
    // no WGSL type/attr spelling anywhere.
    expect(glsl).not.toContain('<f32>')
    expect(glsl).not.toContain('@')
  })
})
