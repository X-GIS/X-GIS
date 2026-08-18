// ═══ WGSL backend — absent-builtin fail-closed (#1672) ═══
//
// The asymmetry this closes: a `point_size` builtin was rejected by the GLSL writer
// with a precise message (backends/glsl.ts builtinOut — "no writable gl_* mapping",
// pinned in glsl.test.ts) while the WGSL writer spelled `@builtin(point_size)`
// VERBATIM into the module string. That is not WGSL, so the failure surfaced at
// naga / the driver with no line back to the authoring site.
//
// Fail-before transcript (pre-implementation, this same file): emitModule SUCCEEDED
// and its output CONTAINED `@builtin(point_size)`:
//   struct PointOut {
//     @builtin(position) clip_pos: vec4<f32>,
//     @builtin(point_size) psize: f32,
//   }
// The gate is now the shared pre-pass (passes/required-caps.ts `assertBuiltins`,
// run from lowerForBackend beside assertCaps) reading the per-backend
// `Backend.absentBuiltins` set.

import { describe, it, expect } from 'vitest'
import { emitModule } from './wgsl.js'
import { emitGlslModule } from './glsl.js'
import { UnsupportedFeatureError } from '../backend.js'
import { ioStruct, builtin, location } from '../sot.js'
import {
  module,
  fn,
  vec2,
  vec4,
  f32,
  toF32,
  vec4fT,
  vec2fT,
  f32T,
  u32T,
  type StructDecl,
  type ModuleDecl,
} from '../ir/index.js'

// ── an IO-struct FIELD carrying the absent builtin (the sot-authored shape) ──
// The WgslBuiltinName union now rejects the denylist names at tsc as well; these
// fixtures keep the deliberate error to prove the EMIT-time gates (the raw-IR
// backstop) still fire with their remedies — the two-layer pin pattern.
const PointOut = ioStruct('PointOut', {
  clip_pos: builtin('position', vec4fT),
  // @ts-expect-error — 'point_size' is not a WGSL builtin (WgslBuiltinName)
  psize: builtin('point_size', f32T),
})
const pointSizeMod = (): ModuleDecl =>
  module({
    funcs: [
      fn('vs_point', {}, () => PointOut.construct({ clip_pos: vec4(0, 0, 0, 1), psize: f32(4) }), {
        stage: 'vertex',
      }),
    ],
    uses: [PointOut],
  })

// ── an entry PARAM carrying the absent builtin (the other place a backend spells one) ──
const pointCoordMod = (): ModuleDecl =>
  module({
    funcs: [
      // @ts-expect-error — 'point_coord' is not a WGSL builtin (WgslBuiltinName)
      fn('fs_pc', { pc: builtin('point_coord', vec2fT) }, (p) => vec4(p.pc.x, p.pc.y, 0, 1), {
        stage: 'fragment',
        retAttr: '@location(0)',
      }),
    ],
  })

const fragCoordMod = (): ModuleDecl =>
  module({
    funcs: [
      // @ts-expect-error — 'frag_coord' is not a WGSL builtin (WgslBuiltinName)
      fn('fs_fc', { fc: builtin('frag_coord', vec4fT) }, (p) => p.fc, {
        stage: 'fragment',
        retAttr: '@location(0)',
      }),
    ],
  })

// ── the negative arm: an entry using ONLY legal WGSL builtins ──
const LegalOut = ioStruct('LegalVsOut', {
  clip_pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})
const legalMod = (): ModuleDecl =>
  module({
    funcs: [
      fn(
        'vs_legal',
        { vi: builtin('vertex_index', u32T) },
        (p) => LegalOut.construct({ clip_pos: vec4(toF32(p.vi), 0, 0, 1), uv: vec2(0, 0) }),
        { stage: 'vertex' },
      ),
    ],
    uses: [LegalOut],
  })

describe('wgsl — absent builtins fail closed (#1672)', () => {
  it('an IO-struct field @builtin(point_size) throws instead of emitting invalid WGSL', () => {
    expect(() => emitModule(pointSizeMod())).toThrow(UnsupportedFeatureError)
    // The message is the deliverable — a prescriptive remedy, not just a rejection.
    expect(() => emitModule(pointSizeMod())).toThrow(/1px|instanced quad/)
  })

  it('an entry-param @builtin(point_coord) throws too (params are spelled, not just fields)', () => {
    expect(() => emitModule(pointCoordMod())).toThrow(UnsupportedFeatureError)
    expect(() => emitModule(pointCoordMod())).toThrow(/@builtin\(point_coord\)/)
  })

  it('@builtin(frag_coord) — absent in WGSL — throws with the remedy naming position', () => {
    expect(() => emitModule(fragCoordMod())).toThrow(UnsupportedFeatureError)
    expect(() => emitModule(fragCoordMod())).toThrow(/@builtin\(position\)/)
  })

  // The GLSL writer used to accept frag_coord as a gl_FragCoord ALIAS, so exactly this
  // module emitted fine on WebGL2 and died only when the WGSL writer ran — the
  // works-on-one-backend trap. Both writers now reject it with the SAME remedy, so the
  // error arrives on the FIRST emit, whichever backend that is.
  it('@builtin(frag_coord) — the GLSL writer rejects the retired alias with the same remedy', () => {
    expect(() => emitGlslModule(fragCoordMod(), 'fragment')).toThrow(UnsupportedFeatureError)
    expect(() => emitGlslModule(fragCoordMod(), 'fragment')).toThrow(/@builtin\(position\)/)
  })

  // The pre-pass must add ZERO bytes to a legal module. This is the exact string the
  // pre-implementation run emitted (captured from the fail-before transcript), so the
  // assertion is a real before/after byte equality, not a re-baked snapshot.
  it('a legal-builtin entry (position + vertex_index) emits byte-identically', () => {
    expect(emitModule(legalMod())).toBe(
      'struct LegalVsOut {\n' +
        '  @builtin(position) clip_pos: vec4<f32>,\n' +
        '  @location(0) uv: vec2<f32>,\n' +
        '}\n' +
        '\n' +
        '@vertex\n' +
        'fn vs_legal(@builtin(vertex_index) vi: u32) -> LegalVsOut {\n' +
        '  return LegalVsOut(vec4<f32>(f32(vi), 0.0, 0.0, 1.0), vec2<f32>(0.0, 0.0));\n' +
        '}\n',
    )
  })

  // The documented contract (#740 R3): the STRUCTURED `builtin` field is the semantic
  // source, `attr` is only the emit spelling. A hand-built decl literal carrying just
  // the string is outside that contract and is NOT gated here — pinned so the choice is
  // a decision on record rather than an accident, and so a later "just regex the attr
  // too" edit has to argue with this test.
  it('a string-only `attr` decl is NOT gated (structured field is the authority)', () => {
    const stringOnly: StructDecl = {
      name: 'RawOut',
      fields: [
        { name: 'clip_pos', type: vec4fT, attr: '@builtin(position)' },
        { name: 'psize', type: f32T, attr: '@builtin(point_size)' },
      ],
    }
    const m: ModuleDecl = { consts: [], structs: [stringOnly], bindings: [], funcs: [] }
    expect(emitModule(m)).toContain('@builtin(point_size)')
  })

  // #1672 review finding: `retAttr: builtin(name, T)` is a #740-R3-COMPLIANT authoring
  // form whose structured id the builder used to DISCARD (only `.attr` survived), so an
  // absent builtin on a bare return was the one structured path still emitting silently.
  // The builder now preserves it as `retBuiltin` and the gate reads it.
  it('a bare return authored as retAttr: builtin(point_size) throws too', () => {
    const m = module({
      funcs: [
        fn('vs_ps_ret', {}, f32T, () => f32(4), {
          stage: 'vertex',
          // @ts-expect-error — 'point_size' is not a WGSL builtin (WgslBuiltinName)
          retAttr: builtin('point_size', f32T),
        }),
      ],
    })
    expect(() => emitModule(m)).toThrow(UnsupportedFeatureError)
    expect(() => emitModule(m)).toThrow(/1px|instanced quad/)
  })

  it('the live idiom retAttr: builtin(position) keeps emitting untouched', () => {
    const m = module({
      funcs: [
        fn('vs_pos_ret', {}, vec4fT, () => vec4(0, 0, 0, 1), {
          stage: 'vertex',
          retAttr: builtin('position', vec4fT),
        }),
      ],
    })
    expect(emitModule(m)).toContain('-> @builtin(position) vec4<f32>')
  })
})
