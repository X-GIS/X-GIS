// ═══ shader-dsl — caps-gated language-feature enable directives (#628) ═══
//
// The `enable`-directive knob system: a module opts into a language-feature
// capability via `enables` (e.g. `['f16']`); the WGSL writer emits the matching
// `enable <ext>;` header, and the GLSL ES 3.00 writer — which supports none of these
// caps — fails closed at assertCaps (never a silent invalid-GLSL emit). Default
// emission (no `enables`) is byte-identical: no directive, body unchanged.

import { describe, it, expect } from 'vitest'
import type { Capability } from '../ir'
import { module, fn, f32T } from '../ir'
import { emitModule, wgslBackend } from './wgsl'
import { emitGlslModule, UnsupportedFeatureError } from './glsl'
import { emitModuleWithReflection } from '../emit'

// A minimal, backend-neutral helper module (no entry stage) — emits on BOTH backends
// when it opts into nothing, so the `enables` knob is the only variable under test.
const scaleMod = (enables?: readonly Capability[]) =>
  module({
    enables,
    funcs: [
      fn('scale', { x: f32T }, f32T, (p, b) => {
        b.ret(p.x.mul(2))
      }),
    ],
  })

describe('#628 — caps-gated enable directives (WGSL header + GLSL fail-closed)', () => {
  it('default (no enables) emits NO enable directive', () => {
    expect(emitModule(scaleMod())).not.toContain('enable ')
  })

  it('opting into f16 prepends `enable f16;` before the first declaration', () => {
    expect(emitModule(scaleMod(['f16'])).startsWith('enable f16;\n\n')).toBe(true)
  })

  it('the directive is purely additive — the body is byte-identical to the default emit', () => {
    const base = emitModule(scaleMod())
    expect(emitModule(scaleMod(['f16']))).toBe(`enable f16;\n\n${base}`)
  })

  it('multiple enables are deduped + sorted for a deterministic byte order', () => {
    const wgsl = emitModule(scaleMod(['subgroups', 'f16', 'f16']))
    expect(wgsl.startsWith('enable f16;\nenable subgroups;\n\n')).toBe(true)
    // exactly two directive lines — the duplicate f16 collapsed
    expect(wgsl.match(/^enable /gm)?.length).toBe(2)
  })

  it('the reflection emit path carries the same header (the runtime pipeline stays valid)', () => {
    const { code } = emitModuleWithReflection(scaleMod(['f16']), wgslBackend)
    expect(code.startsWith('enable f16;\n\n')).toBe(true)
  })

  it('GLSL ES 3.00 fails closed on an f16 module (never a silent invalid emit)', () => {
    expect(() => emitGlslModule(scaleMod(['f16']))).toThrow(UnsupportedFeatureError)
  })

  it('GLSL ES 3.00 still emits the SAME module when it opts into nothing', () => {
    expect(() => emitGlslModule(scaleMod())).not.toThrow()
  })
})
