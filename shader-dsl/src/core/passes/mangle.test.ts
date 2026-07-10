// ═══ mangleModule / emit-prod mangle() plugin — rename scope, ABI boundary, determinism ═══

import { describe, it, expect } from 'vitest'
import {
  fn,
  module,
  vec2,
  vec4,
  fract,
  toF32,
  toF64,
  sin,
  f32,
  f32T,
  f64T,
  vec2fT,
  vec4fT,
  overrideConst,
  If,
  Var,
} from '../ir'
import { ioStruct, builtin, location, uniformStruct } from '../sot'
import { emitModule } from '../backends/wgsl'
import { emitGlslModule } from '../backends/glsl'
import { mangle } from '../../emit-prod'
import { mangleModule } from './mangle'
import type { ModuleDecl } from '../ir'

// A representative render module: fragment-only f64 (df64 helpers + `_fp64`
// guard get injected), a shared helper reached by both stages, meaningfully
// named so the assertions can watch the vocabulary disappear.
const U = uniformStruct(
  'TerrainParams',
  { group: 0, binding: 0, as: 'params' },
  {
    world_origin: f64T,
    sweep: f32T,
  },
)
const VsOut = ioStruct('MangleVsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})
const terrainShade = fn('terrain_shade', { x: f32T }, (p) => sin(p.x).mul(0.5).add(0.5))
const vsEntry = fn(
  'vs_main',
  {},
  () => VsOut.construct({ pos: vec4(0.0, 0.0, 0.0, 1.0), uv: vec2(terrainShade({ x: 1.0 }), 0.0) }),
  { stage: 'vertex' },
)
const fsEntry = fn(
  'fs_main',
  { vo: VsOut },
  (p) => {
    const t = toF32(fract(U.field.world_origin.add(toF64(p.vo.uv.x.mul(U.field.sweep)))))
    const s = terrainShade({ x: t })
    return vec4(s, s, t, 1.0)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)
const m = module({ funcs: [vsEntry, fsEntry], uses: [U, VsOut] })

describe('emit-prod mangle() plugin through the { plugins } seam — authored vocabulary disappears', () => {
  it('WGSL: helper + plain-struct names are renamed; the renames map records them', () => {
    const renames = new Map<string, string>()
    const wgsl = emitModule(m, { plugins: [mangle({ renames })] })
    expect(wgsl).not.toContain('terrain_shade')
    expect(wgsl).not.toContain('MangleVsOut')
    expect(wgsl).not.toMatch(/\bdf64_/) // the injected df64 library is vocabulary too
    expect(renames.get('terrain_shade')).toMatch(/^_f\d+$/)
    expect(renames.get('MangleVsOut')).toMatch(/^_S\d+$/)
  })

  it('WGSL: the ABI boundary survives — entries, binding names, UBO struct, fields, guard', () => {
    const wgsl = emitModule(m, { plugins: [mangle()] })
    expect(wgsl).toContain('fn vs_main') // WebGPU createRenderPipeline entryPoint
    expect(wgsl).toContain('fn fs_main')
    expect(wgsl).toContain('params') // binding name (reflection-driven host bind)
    expect(wgsl).toContain('TerrainParams') // binding-struct name (UBO block tag on GLSL)
    expect(wgsl).toContain('world_origin') // struct field (std140 packing doc / varying link)
    expect(wgsl).toContain('textureLoad(_fp64, vec2<i32>(0, 0), 0).x') // guard spelling intact
    expect(wgsl).toContain('sin(') // builtins are not module fns — never renamed
  })

  it('is deterministic (same bytes twice) and default-off (no-plugins emit unchanged)', () => {
    expect(emitModule(m, { plugins: [mangle()] })).toBe(emitModule(m, { plugins: [mangle()] }))
    expect(emitModule(m)).toBe(emitModule(m, { plugins: [] }))
    expect(emitModule(m)).toContain('terrain_shade')
  })

  it('#923: a specialization-constant module still emits its `override` through mangle', () => {
    // mangle rebuilds the module; before the `...m` spread it whitelisted only
    // consts/structs/bindings/funcs, so `overrides` vanished and the emit dropped the
    // `override` line while the guarded branch still read the name → undeclared identifier.
    const quality = overrideConst('quality', f32T, 1.0)
    const om = module({
      overrides: [quality.decl],
      funcs: [
        fn('override_shade', { base: f32T }, ({ base }) => {
          const acc = Var(base)
          If(quality.node.gt(f32(1)), () => {
            acc.assign(acc.mul(f32(2)).add(f32(0.5)))
          })
          return acc
        }),
      ],
    })
    const wgsl = emitModule(om, { plugins: [mangle()] })
    expect(wgsl).toContain('override quality: f32 = 1.0;') // the decl still emits …
    expect(wgsl).toContain('quality > 1.0') // … and the read keeps the un-renamed ABI name
    expect(wgsl).not.toContain('override_shade') // the helper name IS still mangled
  })

  it('GLSL: the two stage emits agree on every shared mangled name (link contract)', () => {
    const rv = new Map<string, string>()
    const rf = new Map<string, string>()
    const vs = emitGlslModule(m, 'vertex', { plugins: [mangle({ renames: rv })] })
    const fs = emitGlslModule(m, 'fragment', { plugins: [mangle({ renames: rf })] })
    expect(rv.get('terrain_shade')).toBe(rf.get('terrain_shade'))
    const shared = rv.get('terrain_shade')!
    expect(vs).toContain(`${shared}(`)
    expect(fs).toContain(`${shared}(`)
    // varyings still link by their authored field name; the UBO block tag survives.
    expect(vs).toMatch(/^out vec2 uv;$/m)
    expect(fs).toMatch(/^in vec2 uv;$/m)
    expect(fs).toMatch(/layout\(std140\) uniform TerrainParams \{[\s\S]*\} params;/)
    expect(fs).toContain('texelFetch(_fp64, ivec2(0, 0), 0).x')
    expect(fs).not.toMatch(/\bdf64_/)
  })
})

describe('mangleModule — direct pass contracts', () => {
  it('renames a module const and every constref to it', () => {
    const raw: ModuleDecl = {
      consts: [{ name: 'HALF_TURN', type: f32T, wgslValue: 3.14, cpuValue: Math.PI }],
      structs: [],
      bindings: [],
      funcs: [
        {
          name: 'k',
          params: [{ name: 'x', type: f32T }],
          ret: f32T,
          body: [
            {
              s: 'return',
              expr: {
                op: 'binop',
                type: f32T,
                bop: '*',
                a: { op: 'param', type: f32T, name: 'x' },
                b: { op: 'constref', type: f32T, name: 'HALF_TURN' },
              },
            },
          ],
        },
      ],
    }
    const { module: out, renames } = mangleModule(raw)
    const to = renames.get('HALF_TURN')!
    expect(to).toMatch(/^_k\d+$/)
    expect(out.consts[0]!.name).toBe(to)
    const ret = out.funcs[0]!.body[0]!
    expect(ret.s === 'return' && ret.expr?.op === 'binop' && ret.expr.b.op === 'constref').toBe(
      true,
    )
    if (ret.s === 'return' && ret.expr?.op === 'binop' && ret.expr.b.op === 'constref')
      expect(ret.expr.b.name).toBe(to)
  })

  it('preserves #923 overrides through the rebuild and never renames an override name', () => {
    const quality = overrideConst('quality', f32T, 1.0)
    const om = module({
      // a module const alongside proves renaming still happens around the preserved override
      consts: [{ name: 'BIAS', type: f32T, wgslValue: 0.5, cpuValue: 0.5 }],
      overrides: [quality.decl],
      funcs: [
        fn('shade', { base: f32T }, ({ base }) => {
          const acc = Var(base)
          If(quality.node.gt(f32(1)), () => {
            acc.assign(acc.mul(f32(2)))
          })
          return acc
        }),
      ],
    })
    const { module: out, renames } = mangleModule(om)
    expect(out.overrides).toEqual(om.overrides) // the override decls survive the rebuild
    expect(renames.has('quality')).toBe(false) // the override NAME is host ABI — never renamed
    expect(renames.has('BIAS')).toBe(true) // … while ordinary vocabulary still is
  })

  it('bails to identity when a fn body carries a raw stmt (textual refs invisible)', () => {
    const raw: ModuleDecl = {
      consts: [],
      structs: [],
      bindings: [],
      funcs: [
        { name: 'helper', params: [], ret: f32T, body: [{ s: 'raw', wgsl: 'return helper2();' }] },
      ],
    }
    const { module: out, renames } = mangleModule(raw)
    expect(out).toBe(raw)
    expect(renames.size).toBe(0)
  })

  it('never assigns a fresh name that already exists in the module', () => {
    const raw: ModuleDecl = {
      consts: [],
      structs: [],
      bindings: [],
      funcs: [
        // `_f0` is taken by a param — the first generated fn name must skip it.
        {
          name: 'helper',
          params: [{ name: '_f0', type: f32T }],
          ret: f32T,
          body: [{ s: 'return', expr: { op: 'param', type: f32T, name: '_f0' } }],
        },
      ],
    }
    const { renames } = mangleModule(raw)
    expect(renames.get('helper')).toBe('_f1')
  })
})
