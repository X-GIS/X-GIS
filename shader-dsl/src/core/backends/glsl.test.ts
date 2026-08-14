// ═══ GLSL ES 3.00 backend — std140 UBO + entry-IO lowering (Phase 4) ═══
//
// The Phase-0 reflection engine (wgslLayout std140) feeds the GLSL UBO offsets;
// this suite proves the GLSL writer turns a uniform-struct + @vertex + @fragment
// module into a std140 block + in/out varyings + a synthesised main(), with the
// block field order matching the engine's offsets. A SYNTHETIC ModuleDecl is
// built here (NOT a runtime shader import) so the gate stays inside the package.
//
// GATE achieved here: std140-OFFSET-CORRECT STRING-SHAPE (valid `#version 300 es`,
// the std140 block whose declared field order reproduces the wgslLayout offsets,
// the in/out varyings, the gl_* builtin glue, a single main() per stage). The
// REAL-WebGL2 `gl.compileShader` gate is the sibling Playwright spec
// (playground/e2e/_glsl-compile-gate.spec.ts), which compiles these same strings.

import { describe, it, expect } from 'vitest'
import { emitGlslModule, emitModule, wgslLayout, UnsupportedFeatureError } from '@xgis/shader-dsl'
import {
  mat4x4fT,
  vec4fT,
  vec2fT,
  vec3fT,
  f32T,
  f64T,
  u32T,
  i32T,
  texture2dfT,
  texture2dArrayfT,
  texture2duT,
  texture2diT,
  texture2dArrayuT,
  samplerT,
  structT,
  type ShaderType,
  type Expr,
  type ModuleDecl,
  type StructDecl,
} from '@xgis/shader-dsl'
import {
  fn,
  module as dslModule,
  f32,
  vec2,
  vec4,
  fract,
  toF32,
  toF64,
  ioStruct,
  builtin,
  location,
  resource,
  textureSample,
  textureSampleLevel,
  textureLoad,
  textureDimensions,
  textureNumLayers,
  vec2i,
  u32,
  uniformStruct,
} from '@xgis/shader-dsl'

// ── a synthetic vertex+fragment module with a std140 uniform struct ──
const Uniforms: StructDecl = {
  name: 'Uniforms',
  fields: [
    { name: 'mvp', type: mat4x4fT }, // std140 offset 0
    { name: 'viewport', type: vec4fT }, // 64
    { name: 'fade', type: f32T }, // 80
    { name: 'origin', type: vec3fT }, // 96 (vec3 aligns to 16 — the classic trap)
  ],
}
const VsIn: StructDecl = {
  name: 'VsIn',
  fields: [
    { name: 'pos', type: vec2fT, attr: '@location(0)' },
    { name: 'uv', type: vec2fT, attr: '@location(1)' },
  ],
}
const VsOut: StructDecl = {
  name: 'VsOut',
  fields: [
    { name: 'position', type: vec4fT, attr: '@builtin(position)' },
    { name: 'uv', type: vec2fT, attr: '@location(0)' },
  ],
}
const FsOut: StructDecl = {
  name: 'FsOut',
  fields: [{ name: 'color', type: vec4fT, attr: '@location(0)' }],
}

// minimal typed IR-node builders for the synthetic bodies (no authoring layer needed)
const param = (name: string, type: ShaderType): Expr => ({ op: 'param', type, name })
const varref = (name: string, type: ShaderType): Expr => ({ op: 'varref', type, name })
const fld = (base: Expr, field: string, type: ShaderType): Expr => ({
  op: 'member',
  type,
  base,
  field,
})
const lit = (value: number): Expr => ({ op: 'lit', type: f32T, value })
const v4 = (...args: Expr[]): Expr => ({ op: 'construct', type: vec4fT, args })

const module: ModuleDecl = {
  consts: [],
  structs: [Uniforms, VsIn, VsOut, FsOut],
  bindings: [{ group: 0, binding: 0, name: 'u', space: 'uniform', type: structT('Uniforms') }],
  funcs: [
    {
      name: 'vs',
      attrs: ['@vertex'],
      params: [{ name: 'inp', type: structT('VsIn') }],
      ret: structT('VsOut'),
      body: [
        { s: 'var', name: 'o', type: structT('VsOut') },
        {
          s: 'assign',
          target: fld(varref('o', structT('VsOut')), 'position', vec4fT),
          // z reads `u.fade` so the VERTEX stage references the UBO — per-stage
          // emit scope drops bindings a stage never touches, and the std140
          // block assertions below are against the vertex emit.
          expr: v4(
            fld(fld(param('inp', structT('VsIn')), 'pos', vec2fT), 'x', f32T),
            fld(fld(param('inp', structT('VsIn')), 'pos', vec2fT), 'y', f32T),
            fld(varref('u', structT('Uniforms')), 'fade', f32T),
            lit(1),
          ),
        },
        {
          s: 'assign',
          target: fld(varref('o', structT('VsOut')), 'uv', vec2fT),
          expr: fld(param('inp', structT('VsIn')), 'uv', vec2fT),
        },
        { s: 'return', expr: varref('o', structT('VsOut')) },
      ],
    },
    {
      name: 'fs',
      attrs: ['@fragment'],
      params: [{ name: 'inp', type: structT('VsOut') }],
      ret: structT('FsOut'),
      body: [
        {
          s: 'return',
          expr: {
            op: 'construct',
            type: structT('FsOut'),
            args: [
              v4(
                fld(fld(param('inp', structT('VsOut')), 'uv', vec2fT), 'x', f32T),
                fld(fld(param('inp', structT('VsOut')), 'uv', vec2fT), 'y', f32T),
                lit(0),
                lit(1),
              ),
            ],
          },
        },
      ],
    },
  ],
}

describe('glsl-es300 — std140 UBO from the reflection engine', () => {
  it('emits a layout(std140) uniform block whose field order matches wgslLayout offsets', () => {
    const glsl = emitGlslModule(module, 'vertex')
    expect(glsl.startsWith('#version 300 es')).toBe(true)
    expect(glsl).toContain('precision highp float;')

    // The std140 block: tag = struct name, instance = binding name.
    expect(glsl).toMatch(/layout\(std140\) uniform Uniforms \{[\s\S]*\} u;/)
    // Fields declared in order — std140 default packing reproduces these offsets.
    const block = glsl.slice(glsl.indexOf('layout(std140)'), glsl.indexOf('} u;'))
    expect(block.indexOf('mat4 mvp;')).toBeGreaterThan(-1)
    expect(block.indexOf('vec4 viewport;')).toBeGreaterThan(block.indexOf('mat4 mvp;'))
    expect(block.indexOf('float fade;')).toBeGreaterThan(block.indexOf('vec4 viewport;'))
    expect(block.indexOf('vec3 origin;')).toBeGreaterThan(block.indexOf('float fade;'))

    // The contract the GLSL block's std140 default packing reproduces (the engine is the
    // offset SoT the host packs against): mvp@0 viewport@64 fade@80 origin@96.
    const L = wgslLayout(Uniforms, 'std140')
    expect(Object.fromEntries(L.fields.map((f) => [f.name, f.offset]))).toEqual({
      mvp: 0,
      viewport: 64,
      fade: 80,
      origin: 96,
    })
    expect(L.size).toBe(112) // origin (vec3 @96, size 12) → padded to 16-multiple = 112
  })

  it('does NOT re-declare a uniform struct as a plain GLSL struct (name collision)', () => {
    const glsl = emitGlslModule(module, 'vertex')
    // `Uniforms` must appear ONLY as the UBO block tag, never as `struct Uniforms {`.
    expect(glsl).not.toContain('struct Uniforms {')
  })
})

describe('glsl-es300 — @vertex / @fragment entry-IO lowering', () => {
  it('flattens vertex @location inputs to `layout(location) in` attributes and the return to plain `out` varyings', () => {
    const vs = emitGlslModule(module, 'vertex')
    // vertex attributes carry a location qualifier (valid for vertex INPUTS in ES 3.00).
    expect(vs).toMatch(/layout\(location = 0\) in vec2 a_pos;/)
    expect(vs).toMatch(/layout\(location = 1\) in vec2 a_uv;/)
    // an inter-stage OUT varying must NOT carry layout(location) in ES 3.00 (links by name).
    expect(vs).toMatch(/^out vec2 uv;$/m)
    expect(vs).not.toMatch(/layout\(location = \d+\) out/)
    // @builtin(position) → gl_Position (vertex output), not a varying.
    expect(vs).toContain('gl_Position = _out.position;')
    expect(vs).not.toMatch(/out vec4 position;/)
    // single main() that calls the authored entry body via the `_impl` fn.
    expect(vs).toContain('VsOut vs_impl(VsIn inp)')
    expect((vs.match(/void main\(\) \{/g) ?? []).length).toBe(1)
    expect(vs).toContain('VsOut _out = vs_impl(inp);')
  })

  it('maps a readable @builtin(position) fragment input to gl_FragCoord (not gl_Position)', () => {
    const fs = emitGlslModule(module, 'fragment')
    expect(fs).toContain('inp.position = gl_FragCoord;')
    expect(fs).not.toContain('gl_Position')
    // a fragment INPUT varying must NOT carry layout(location) (links by name to the vertex out `uv`).
    expect(fs).toMatch(/^in vec2 uv;$/m)
    // a fragment OUTPUT (draw buffer) DOES carry a location qualifier in ES 3.00.
    expect(fs).toMatch(/layout\(location = 0\) out vec4 color;/)
    expect(fs).toContain('color = _out.color;')
    expect((fs.match(/void main\(\) \{/g) ?? []).length).toBe(1)
  })

  it('no WGSL lexemes leak (no `fn`, no `@`, no `let`, no `<f32>`)', () => {
    for (const stage of ['vertex', 'fragment'] as const) {
      const glsl = emitGlslModule(module, stage)
      expect(glsl).not.toMatch(/\bfn\b/)
      expect(glsl).not.toContain('@')
      expect(glsl).not.toContain('let ')
      expect(glsl).not.toContain('<f32>')
    }
  })

  it('emits exactly one main() per stage (GLSL ES is single-entry per compilation unit)', () => {
    expect((emitGlslModule(module, 'vertex').match(/void main\(\)/g) ?? []).length).toBe(1)
    expect((emitGlslModule(module, 'fragment').match(/void main\(\)/g) ?? []).length).toBe(1)
    // whole-module (no stage) emits BOTH main()s — a string-shape artifact, not a unit.
    expect((emitGlslModule(module).match(/void main\(\)/g) ?? []).length).toBe(2)
  })
})

describe('glsl-es300 — reserved-word identifier sanitisation', () => {
  // A GLSL ES reserved word (`input`, `in`, `out`, …) is a legal WGSL identifier but a
  // GLSL compile error. The backend renames any param/local-var that collides (and every
  // reference) so a real shader whose entry param is named `input` (raster) / `in`
  // (overdraw) links. Struct fields + binding names are left alone.
  const ReservedIn: StructDecl = {
    name: 'ReservedIn',
    fields: [{ name: 'uv', type: vec2fT, attr: '@location(0)' }],
  }
  const reservedMod: ModuleDecl = {
    consts: [],
    structs: [ReservedIn, FsOut],
    bindings: [],
    funcs: [
      {
        name: 'fs',
        attrs: ['@fragment'],
        params: [{ name: 'input', type: structT('ReservedIn') }], // `input` is GLSL-reserved
        ret: structT('FsOut'),
        body: [
          // a local var named `sample` (also reserved) initialised from the reserved param.
          {
            s: 'let',
            name: 'sample',
            expr: fld(fld(param('input', structT('ReservedIn')), 'uv', vec2fT), 'x', f32T),
          },
          {
            s: 'return',
            expr: {
              op: 'construct',
              type: structT('FsOut'),
              args: [v4(varref('sample', f32T), lit(0), lit(0), lit(1))],
            },
          },
        ],
      },
    ],
  }

  it('renames a reserved-word entry param + every reference consistently', () => {
    const fs = emitGlslModule(reservedMod, 'fragment')
    // the reserved param `input` is renamed (to `input_`) at the decl AND every reference.
    expect(fs).toMatch(/\binput_\b/)
    expect(fs).not.toMatch(/\binput\b(?!_)/) // no bare reserved `input` left
    expect(fs).toContain('fs_impl(input_)') // the call site uses the renamed name
  })

  it('renames a reserved-word local var (`sample`) consistently', () => {
    const fs = emitGlslModule(reservedMod, 'fragment')
    expect(fs).toMatch(/\bsample_\b/)
    expect(fs).not.toMatch(/\bsample\b(?!_)/)
  })

  it('does NOT touch struct field names (the std140 / varying-linkage contract)', () => {
    const fs = emitGlslModule(reservedMod, 'fragment')
    expect(fs).toMatch(/\.uv\b/) // the `uv` field is still accessed as `.uv`, not renamed
  })
})

describe('glsl-es300 — GLSL ES integer rules (u32 switch labels, flat varyings)', () => {
  it('a u32 switch emits u-suffixed case labels (label type must match the scrutinee)', () => {
    const mod: ModuleDecl = {
      consts: [],
      structs: [],
      bindings: [],
      funcs: [
        {
          name: 'pick',
          params: [{ name: 'k', type: u32T }],
          ret: f32T,
          body: [
            { s: 'var', name: 'o', type: f32T, init: lit(0) },
            {
              s: 'switch',
              scrut: { op: 'param', type: u32T, name: 'k' },
              cases: [
                {
                  value: 1,
                  body: [
                    { s: 'assign', target: { op: 'varref', type: f32T, name: 'o' }, expr: lit(1) },
                  ],
                },
              ],
              defaultBody: [],
            },
            { s: 'return', expr: { op: 'varref', type: f32T, name: 'o' } },
          ],
        },
      ],
    }
    const glsl = emitGlslModule(mod)
    expect(glsl).toMatch(/switch \(k\)/)
    expect(glsl).toMatch(/case 1u:/) // u32 scrutinee → u-suffixed label
    expect(glsl).not.toMatch(/case 1:/) // a bare int label is a GLSL ES type-mismatch error
  })

  it('an integer inter-stage varying is `flat` (vertex-OUT + fragment-IN), an int vertex attribute is NOT', () => {
    const IntIn: StructDecl = {
      name: 'IntIn',
      fields: [{ name: 'idx', type: u32T, attr: '@location(0)' }],
    }
    const IntOut: StructDecl = {
      name: 'IntOut',
      fields: [
        { name: 'position', type: vec4fT, attr: '@builtin(position)' },
        { name: 'tag', type: u32T, attr: '@location(0)' },
      ],
    }
    const vmod: ModuleDecl = {
      consts: [],
      structs: [IntIn, IntOut],
      bindings: [],
      funcs: [
        {
          name: 'vs',
          attrs: ['@vertex'],
          params: [{ name: 'inp', type: structT('IntIn') }],
          ret: structT('IntOut'),
          body: [
            { s: 'var', name: 'o', type: structT('IntOut') },
            {
              s: 'assign',
              target: fld(varref('o', structT('IntOut')), 'position', vec4fT),
              expr: v4(lit(0), lit(0), lit(0), lit(1)),
            },
            {
              s: 'assign',
              target: fld(varref('o', structT('IntOut')), 'tag', u32T),
              expr: fld(param('inp', structT('IntIn')), 'idx', u32T),
            },
            { s: 'return', expr: varref('o', structT('IntOut')) },
          ],
        },
      ],
    }
    const vs = emitGlslModule(vmod, 'vertex')
    expect(vs).toMatch(/flat out uint tag;/) // integer vertex-OUT varying → flat
    expect(vs).toMatch(/layout\(location = 0\) in uint a_idx;/) // integer vertex attribute → NOT flat
    expect(vs).not.toMatch(/flat (?:layout|in)/) // no flat on the attribute
  })
})

describe('glsl-es300 — storage → data-texture emulation (default-on)', () => {
  const arrF32 = { kind: 'array', elem: f32T } as ShaderType // runtime-sized storage array<f32>
  const storageMod: ModuleDecl = {
    consts: [],
    structs: [FsOut],
    bindings: [
      { group: 0, binding: 0, name: 'data', space: 'storage', access: 'read', type: arrF32 },
    ],
    funcs: [
      {
        name: 'fs',
        attrs: ['@fragment'],
        params: [],
        ret: structT('FsOut'),
        body: [
          {
            s: 'return',
            expr: {
              op: 'construct',
              type: structT('FsOut'),
              // data[2] read → its value as the red channel.
              args: [
                v4(
                  {
                    op: 'index',
                    type: f32T,
                    base: varref('data', arrF32),
                    idx: { op: 'lit', type: u32T, value: 2 },
                  },
                  lit(0),
                  lit(0),
                  lit(1),
                ),
              ],
            },
          },
        ],
      },
    ],
  }

  it('the storage lowering turns a storage array<f32> into a sampler2D + texelFetch (no SSBO)', () => {
    const fs = emitGlslModule(storageMod, 'fragment')
    expect(fs).toContain('uniform sampler2D data;') // storage binding → data texture
    // data[i] → 2D-tiled fetch: ivec2(i % textureSize(data,0).x, i / textureSize(data,0).x)
    expect(fs).toMatch(
      /texelFetch\(data, ivec2\(int\(.*\) % textureSize\(data, 0\)\.x, int\(.*\) \/ textureSize\(data, 0\)\.x\), 0\)\.r/,
    )
    expect(fs).not.toContain('data[') // no raw array indexing survives
  })

  // #1647/#1649/#1681 — WebGL2 having no SSBO is a PLATFORM fact, not a caller choice, so
  // the lowering is default-on for any module carrying a storage binding. The
  // `emulateStorage` opt-in that used to force it is GONE from GlslEmitOptions (#1681 A1);
  // the byte-identity test that pinned "setting it changes nothing" died with the flag,
  // and this default-on pin is the surviving half of that contract.
  it('a storage module emits by DEFAULT (no opts) and spells the data-texture fetch', () => {
    expect(() => emitGlslModule(storageMod, 'fragment')).not.toThrow()
    const fs = emitGlslModule(storageMod, 'fragment')
    expect(fs).toContain('uniform sampler2D data;')
    expect(fs).toContain('texelFetch(data,')
  })

  // #823 — the retained-icon tint buffer shape: a top-level array<vec4<f32>> element
  // reads its 4 consecutive std430 lanes (i*4 .. i*4+3) recombined with a vec4 ctor.
  it('the storage lowering turns a storage array<vec4f> into 4 texelFetch lanes + a vec4 ctor', () => {
    const arrVec4 = { kind: 'array', elem: vec4fT } as ShaderType
    const vecMod: ModuleDecl = {
      consts: [],
      structs: [FsOut],
      bindings: [
        { group: 0, binding: 0, name: 'tint', space: 'storage', access: 'read', type: arrVec4 },
      ],
      funcs: [
        {
          name: 'fs',
          attrs: ['@fragment'],
          params: [],
          ret: structT('FsOut'),
          body: [
            {
              s: 'return',
              expr: {
                op: 'construct',
                type: structT('FsOut'),
                args: [
                  {
                    op: 'index',
                    type: vec4fT,
                    base: varref('tint', arrVec4),
                    idx: { op: 'lit', type: u32T, value: 3 },
                  },
                ],
              },
            },
          ],
        },
      ],
    }
    const fs = emitGlslModule(vecMod, 'fragment')
    expect(fs).toContain('uniform sampler2D tint;') // storage binding → data texture
    // element 3 → base lane 3u*4u, lanes +1/+2/+3, recombined into a vec4.
    expect(fs).toMatch(/vec4\(/)
    const fetches = fs.match(/texelFetch\(tint,/g) ?? []
    expect(fetches.length).toBe(4)
    expect(fs).not.toContain('tint[') // no raw array indexing survives
  })

  // ── the RESIDUAL shapes: still fail closed, now on the DEFAULT path (#1647) ──
  // Each message must NAME the offending binding/field — these throws are user-facing
  // now that no opt-in stands between a consumer and this lowering.
  const residualMod = (
    binding: ModuleDecl['bindings'][number],
    structs: StructDecl[] = [],
    body: ModuleDecl['funcs'][number]['body'] = [],
  ): ModuleDecl => ({
    consts: [],
    structs: [FsOut, ...structs],
    bindings: [binding],
    funcs: [
      {
        name: 'fs',
        attrs: ['@fragment'],
        params: [],
        ret: structT('FsOut'),
        body: [
          ...body,
          {
            s: 'return',
            expr: {
              op: 'construct',
              type: structT('FsOut'),
              args: [v4(lit(0), lit(0), lit(0), lit(1))],
            },
          },
        ],
      },
    ],
  })
  const storageOf = (name: string, type: ShaderType): ModuleDecl['bindings'][number] => ({
    group: 0,
    binding: 0,
    name,
    space: 'storage',
    access: 'read',
    type,
  })

  it('a NON-ARRAY storage binding still fails closed (named, with the supported shapes)', () => {
    const Blob: StructDecl = { name: 'Blob', fields: [{ name: 'a', type: vec2fT }] }
    const m = residualMod(storageOf('blob', structT('Blob')), [Blob])
    expect(() => emitGlslModule(m, 'fragment')).toThrow(UnsupportedFeatureError)
    expect(() => emitGlslModule(m, 'fragment')).toThrow(/'blob'[\s\S]*array<f32>/)
  })

  // ── #1703 — the two shapes that USED to be the residual now lower, typed ──
  //
  // The choice under test is the data texture's ELEMENT, not the index math (that is
  // shared with the f32 path and pinned above). An integer array must land on
  // usampler2D / isampler2D — reusing the R32F sampler2D and bitcasting would compile,
  // emit plausible-looking GLSL, and lose small values on any driver that exercises its
  // GLSL ES 3.00 §2.1.1 right to flush denormals (`1u` is the f32 denormal 1.4e-45).
  // That is why these assert the SAMPLER TYPE, not merely that a texelFetch appeared.
  // The fetched value is CONSUMED by the returned colour, never left in a dangling
  // `let` — an unread element would be dead code, and DCE would delete the very
  // texelFetch these tests assert on (an assertion that passes because nothing ran).
  const intStorageMod = (name: string, elem: ShaderType): ModuleDecl => {
    const arrT = { kind: 'array', elem } as ShaderType
    const read: Expr = {
      op: 'index',
      type: elem,
      base: { op: 'varref', type: arrT, name },
      idx: { op: 'lit', type: u32T, value: 3 },
    }
    return {
      consts: [],
      structs: [FsOut],
      bindings: [storageOf(name, arrT)],
      funcs: [
        {
          name: 'fs',
          attrs: ['@fragment'],
          params: [],
          ret: structT('FsOut'),
          body: [
            {
              s: 'return',
              expr: {
                op: 'construct',
                type: structT('FsOut'),
                args: [
                  v4({ op: 'call', type: f32T, fn: 'f32', args: [read] }, lit(0), lit(0), lit(1)),
                ],
              },
            },
          ],
        },
      ],
    }
  }

  it('a top-level array<u32> lowers to a usampler2D data texture (#1703)', () => {
    const fs = emitGlslModule(intStorageMod('idx_data', u32T), 'fragment')
    expect(fs).toContain('uniform usampler2D idx_data;')
    // …and the §4.5.4 precision line without which it would not compile at all
    expect(fs).toContain('precision highp usampler2D;')
    // same 2D-tiled index math as the f32 path — the element moved, the tiling did not
    expect(fs).toMatch(
      /texelFetch\(idx_data, ivec2\(int\(.*\) % textureSize\(idx_data, 0\)\.x, int\(.*\) \/ textureSize\(idx_data, 0\)\.x\), 0\)\.r/,
    )
    expect(fs).not.toContain('idx_data[') // no raw array indexing survives
    // the negative that makes this test mean something: NO float sampler, and no
    // bitcast recovering the value through one
    expect(fs).not.toContain('uniform sampler2D idx_data;')
    expect(fs).not.toContain('floatBitsToUint')
  })

  it('a top-level array<i32> lowers to an isampler2D data texture (#1703)', () => {
    const fs = emitGlslModule(intStorageMod('sign_data', i32T), 'fragment')
    expect(fs).toContain('uniform isampler2D sign_data;')
    expect(fs).toContain('precision highp isampler2D;')
    expect(fs).toContain('texelFetch(sign_data,')
    expect(fs).not.toContain('uniform sampler2D sign_data;')
  })

  it('an UNSUPPORTED element still fails closed, and the message now lists the integer shapes', () => {
    // The residual did not disappear — it shrank. A shape outside the supported set
    // must still throw by NAME, and the listing a caller is pointed at has to mention
    // the two shapes that just became legal, or it sends them to a workaround they no
    // longer need.
    const arrBool = { kind: 'array', elem: { kind: 'scalar', scalar: 'bool' } } as ShaderType
    const m = residualMod(storageOf('flag_data', arrBool))
    expect(() => emitGlslModule(m, 'fragment')).toThrow(UnsupportedFeatureError)
    expect(() => emitGlslModule(m, 'fragment')).toThrow(/'flag_data'[\s\S]*array<u32>, array<i32>/)
  })

  it('an i32 struct field still fails closed, naming the field and its struct', () => {
    const Flagged: StructDecl = {
      name: 'Flagged',
      fields: [
        { name: 'w', type: f32T },
        { name: 'flag', type: i32T },
      ],
    }
    const arrFlagged = { kind: 'array', elem: structT('Flagged') } as ShaderType
    const m = residualMod(
      storageOf('flags', arrFlagged),
      [Flagged],
      [
        {
          s: 'let',
          name: 'f',
          expr: {
            op: 'member',
            type: i32T,
            base: {
              op: 'index',
              type: structT('Flagged'),
              base: varref('flags', arrFlagged),
              idx: { op: 'lit', type: u32T, value: 0 },
            },
            field: 'flag',
          },
        },
      ],
    )
    expect(() => emitGlslModule(m, 'fragment')).toThrow(UnsupportedFeatureError)
    expect(() => emitGlslModule(m, 'fragment')).toThrow(/'flag'[\s\S]*'Flagged'/)
  })

  it('a whole-struct element read (no .field) still fails closed, naming the binding', () => {
    const Seg: StructDecl = { name: 'Seg', fields: [{ name: 'a', type: vec2fT }] }
    const arrSeg = { kind: 'array', elem: structT('Seg') } as ShaderType
    const m = residualMod(
      storageOf('segs', arrSeg),
      [Seg],
      [
        {
          s: 'let',
          name: 'e',
          expr: {
            op: 'index',
            type: structT('Seg'),
            base: varref('segs', arrSeg),
            idx: { op: 'lit', type: u32T, value: 0 },
          },
        },
      ],
    )
    expect(() => emitGlslModule(m, 'fragment')).toThrow(UnsupportedFeatureError)
    expect(() => emitGlslModule(m, 'fragment')).toThrow(/'segs\[i\]'/)
  })

  it('a mat / vec<u32> struct field fails closed ON ACCESS, naming the field', () => {
    // Pins the doc claim (glsl.ts header / AGENTS.md): these lanes throw LAZILY at the
    // first read — an unread one passes — unlike the i32 field's declaration-time throw.
    const Motion: StructDecl = {
      name: 'Motion',
      fields: [
        { name: 'w', type: f32T },
        { name: 'vel', type: { kind: 'vec', elem: 'u32', n: 2 } as ShaderType },
      ],
    }
    const arrMotion = { kind: 'array', elem: structT('Motion') } as ShaderType
    const m = residualMod(
      storageOf('motions', arrMotion),
      [Motion],
      [
        {
          s: 'let',
          name: 'v',
          expr: {
            op: 'member',
            type: { kind: 'vec', elem: 'u32', n: 2 } as ShaderType,
            base: {
              op: 'index',
              type: structT('Motion'),
              base: varref('motions', arrMotion),
              idx: { op: 'lit', type: u32T, value: 0 },
            },
            field: 'vel',
          },
        },
      ],
    )
    expect(() => emitGlslModule(m, 'fragment')).toThrow(UnsupportedFeatureError)
    expect(() => emitGlslModule(m, 'fragment')).toThrow(/'vel'[\s\S]*not supported/)
  })

  it('a read_write storage binding fails closed at declaration (the emulation is gather-only)', () => {
    // Without this gate a storage WRITE would not even fail at the driver: autoVars
    // materialises the assigned element into a local var, so the store silently becomes
    // a dead local write while the WGSL twin performs a real SSBO store — a silent
    // cross-backend divergence, both green (#1648 review).
    const arr = { kind: 'array', elem: f32T } as ShaderType
    const m = residualMod(
      { ...storageOf('accum', arr), access: 'read_write' },
      [],
      [
        {
          s: 'assign',
          target: {
            op: 'index',
            type: f32T,
            base: varref('accum', arr),
            idx: { op: 'lit', type: u32T, value: 0 },
          },
          expr: { op: 'lit', type: f32T, value: 1 },
        },
      ],
    )
    expect(() => emitGlslModule(m, 'fragment')).toThrow(UnsupportedFeatureError)
    expect(() => emitGlslModule(m, 'fragment')).toThrow(/'accum'[\s\S]*read-only \(gather\)/)
  })

  it('a @compute module without {emulateCompute} keeps the compute caps error (not a storage-shape one)', () => {
    // The default storage lowering must NOT run first here — it would replace the
    // "missing capabilities: compute" diagnosis with an unsupported-element error
    // pointing away from the actual fix, the missing {emulateCompute} opt-in (#1648 review).
    const m: ModuleDecl = {
      consts: [],
      structs: [],
      bindings: [
        {
          ...storageOf('out_color', { kind: 'array', elem: u32T } as ShaderType),
          access: 'read_write',
        },
      ],
      funcs: [
        {
          name: 'paint',
          params: [
            {
              name: 'gid',
              type: { kind: 'vec', elem: 'u32', n: 3 } as ShaderType,
              builtin: 'global_invocation_id',
            },
          ],
          ret: { kind: 'void' } as ShaderType,
          attrs: ['@compute', '@workgroup_size(64)'],
          body: [{ s: 'return' }],
        },
      ],
    }
    expect(() => emitGlslModule(m, 'fragment')).toThrow(/missing capabilities:[\s\S]*compute/)
  })
})

describe('glsl-es300 — fail-closed on out-of-scope features', () => {
  // A storage binding is NOT in this list any more (#1647): it lowers to a data texture
  // by default. Its residual fail-closed shapes are pinned by the emulation suite above,
  // and the raw caps gate (assertCaps on glslEs300Backend) by passes/required-caps.test.ts.
  it('an unmapped builtin fails closed rather than emitting a bad gl_* name', () => {
    const badOut: StructDecl = {
      name: 'BadOut',
      fields: [{ name: 'p', type: vec4fT, attr: '@builtin(sample_index)' }],
    }
    const badMod: ModuleDecl = {
      consts: [],
      structs: [badOut],
      bindings: [],
      funcs: [
        {
          name: 'vs',
          attrs: ['@vertex'],
          params: [],
          ret: structT('BadOut'),
          body: [
            {
              s: 'return',
              expr: {
                op: 'construct',
                type: structT('BadOut'),
                args: [v4(lit(0), lit(0), lit(0), lit(1))],
              },
            },
          ],
        },
      ],
    }
    expect(() => emitGlslModule(badMod, 'vertex')).toThrow(UnsupportedFeatureError)
  })

  // #1672 — the point_size SYMMETRY pin. This writer already rejected it (no
  // gl_PointSize entry in BUILTIN_OUT); the WGSL writer used to spell it verbatim and
  // let naga find it. Both rejections now live one grep apart — the WGSL twin is
  // backends/wgsl-absent-builtins.test.ts. The mechanisms stay SEPARATE on purpose:
  // GLSL's set is implicit in its own BUILTIN_IN/BUILTIN_OUT tables (these messages are
  // pinned), WGSL's is the explicit `Backend.absentBuiltins` set the shared pre-pass reads.
  it('@builtin(point_size) fails closed here too, with the gl_* mapping message', () => {
    const PointOut = ioStruct('PointOut', {
      clip_pos: builtin('position', vec4fT),
      psize: builtin('point_size', f32T),
    })
    const pointMod = dslModule({
      funcs: [
        fn(
          'vs_point',
          {},
          () => PointOut.construct({ clip_pos: vec4(0, 0, 0, 1), psize: f32(4) }),
          { stage: 'vertex' },
        ),
      ],
      uses: [PointOut],
    })
    expect(() => emitGlslModule(pointMod, 'vertex')).toThrow(UnsupportedFeatureError)
    expect(() => emitGlslModule(pointMod, 'vertex')).toThrow(
      /unsupported output @builtin\(point_size\)/,
    )
  })
})

describe('glsl-es300 — per-stage emit scope (stage reachability)', () => {
  // The user-visible bug this pins: f64 used ONLY in the fragment stage left
  // the whole df64 helper set + the `_fp64` guard sampler (+ the UBO) in the
  // VERTEX GLSL. Each stage's emit is now scoped to what its entries
  // transitively reach. Authored through the real surface so the fp64Lower
  // injection path is the one under test.
  const U = uniformStruct(
    'ScopeU',
    { group: 0, binding: 0, as: 'su' },
    {
      origin: f64T,
      span: f32T,
    },
  )
  const SvOut = ioStruct('ScopeVsOut', {
    pos: builtin('position', vec4fT),
    uv: location(0, vec2fT),
  })
  const vsScope = fn(
    'vs_scope',
    {},
    () => SvOut.construct({ pos: vec4(0.0, 0.0, 0.0, 1.0), uv: vec2(0.0, 0.0) }),
    { stage: 'vertex' },
  )
  const fsScope = fn(
    'fs_scope',
    { vo: SvOut },
    (p) => {
      const v = toF32(fract(U.field.origin.add(toF64(p.vo.uv.x.mul(U.field.span)))))
      return vec4(v, v, v, 1.0)
    },
    { stage: 'fragment', retAttr: '@location(0)' },
  )
  const scopeMod = dslModule({ funcs: [vsScope, fsScope], uses: [U, SvOut] })

  it('vertex GLSL carries NO fragment-only machinery (df64 helpers, _fp64 guard, UBO)', () => {
    const vs = emitGlslModule(scopeMod, 'vertex')
    expect(vs).not.toContain('df64_')
    expect(vs).not.toContain('_fp64')
    expect(vs).not.toContain('ScopeU') // the UBO is referenced only by the fragment
  })

  it('fragment GLSL still carries the df64 helpers, the _fp64 guard, and the UBO', () => {
    const fs = emitGlslModule(scopeMod, 'fragment')
    expect(fs).toContain('df64_add(')
    expect(fs).toContain('uniform sampler2D _fp64;')
    expect(fs).toMatch(/layout\(std140\) uniform ScopeU \{[\s\S]*\} su;/)
  })

  it('a helper reached by BOTH stages stays in both; a fragment-only helper stays out of vertex', () => {
    const half = fn('scope_half', { x: f32T }, (p) => p.x.mul(0.5))
    const fragOnly = fn('scope_frag_only', { x: f32T }, (p) => p.x.add(1.0))
    const vs = fn(
      'vs_shared',
      {},
      () => SvOut.construct({ pos: vec4(0.0, 0.0, 0.0, 1.0), uv: vec2(half(1.0), 0.0) }),
      { stage: 'vertex' },
    )
    const fs = fn(
      'fs_shared',
      { vo: SvOut },
      (p) => vec4(half(p.vo.uv.x), fragOnly(p.vo.uv.y), 0.0, 1.0),
      { stage: 'fragment', retAttr: '@location(0)' },
    )
    const m = dslModule({ funcs: [vs, fs], uses: [SvOut] })
    const vsG = emitGlslModule(m, 'vertex')
    const fsG = emitGlslModule(m, 'fragment')
    expect(vsG).toContain('scope_half')
    expect(vsG).not.toContain('scope_frag_only')
    expect(fsG).toContain('scope_half')
    expect(fsG).toContain('scope_frag_only')
  })
})

// ── textureSampleLevel (#1650) — the explicit-LOD sample, pinned on BOTH backends ──
//
// The two spellings of the SAME module are asserted side by side (the WGSL twin lives
// here rather than in a sibling file so a divergence shows up in one diff): WGSL keeps
// the standalone sampler argument, GLSL fuses tex+sampler into one sampler2D and drops
// BOTH the sampler argument and the standalone sampler BINDING. Pinned in the vertex
// stage too — an explicit LOD needs no derivatives, which is the whole point of the
// intrinsic (textureSample is fragment-only).
describe('glsl-es300 / wgsl — textureSampleLevel explicit-LOD sample', () => {
  const LodOut = ioStruct('LodOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })
  const lodTex = resource('lod_tex', texture2dfT, { group: 0, binding: 0 })
  const lodSmp = resource('lod_smp', samplerT, { group: 0, binding: 1 })
  const lodVs = fn(
    'lod_vs',
    { uv: location(0, vec2fT) },
    ({ uv }) => {
      const o = LodOut.var('out')
      // displace the vertex along z by a texel read at an explicit LOD
      o.pos.assign(vec4(uv.x, uv.y, textureSampleLevel(lodTex.node, lodSmp.node, uv, 1).x, 1))
      o.uv.assign(uv)
      return o
    },
    { stage: 'vertex' },
  )
  const lodFs = fn(
    'lod_fs',
    { inp: LodOut },
    ({ inp }) => textureSampleLevel(lodTex.node, lodSmp.node, inp.uv, 1),
    { stage: 'fragment', retAttr: location(0, vec4fT) },
  )
  const lodMod = dslModule({ uses: [LodOut, lodTex, lodSmp], funcs: [lodVs, lodFs] })

  it('WGSL keeps the sampler argument and the sampler binding', () => {
    const w = emitModule(lodMod)
    expect(w).toContain('textureSampleLevel(lod_tex, lod_smp, uv, 1.0)')
    expect(w).toContain('textureSampleLevel(lod_tex, lod_smp, inp.uv, 1.0)')
    expect(w).toContain('var lod_smp: sampler;')
  })

  it('GLSL spells textureLod with NO sampler arg and drops the standalone sampler binding', () => {
    const fsG = emitGlslModule(lodMod, 'fragment')
    expect(fsG).toContain('textureLod(lod_tex, inp.uv, 1.0)')
    expect(fsG).toContain('uniform sampler2D lod_tex;')
    expect(fsG).not.toContain('lod_smp') // fused into the combined sampler2D
  })

  it('the VERTEX stage emits the same explicit-LOD sample (no derivatives needed)', () => {
    const vsG = emitGlslModule(lodMod, 'vertex')
    expect(vsG).toContain('textureLod(lod_tex, uv, 1.0)')
    expect(vsG).toContain('uniform sampler2D lod_tex;')
    expect(vsG).not.toContain('lod_smp')
  })
})

// ── 2d-array textures (#1651) — sampler2DArray on BOTH backends ──
//
// The array forms carry DISTINCT neutral ids (textureSampleArray /
// textureSampleLevelArray / textureLoadArray) because the two targets RESTRUCTURE the
// arguments rather than merely adding one: WGSL appends the layer as its own argument,
// GLSL folds it into the coordinate's third component. Both spellings of the SAME
// module are asserted side by side so a divergence shows up in one diff.
describe('glsl-es300 / wgsl — 2d-array texture reads (#1651)', () => {
  const ArrOut = ioStruct('ArrOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })
  const arrTex = resource('arr_tex', texture2dArrayfT, { group: 0, binding: 0 })
  const arrSmp = resource('arr_smp', samplerT, { group: 0, binding: 1 })
  const arrVs = fn(
    'arr_vs',
    { uv: location(0, vec2fT) },
    ({ uv }) => {
      const o = ArrOut.var('out')
      // vertex-stage ARRAY read — legal only with an explicit LOD (no derivatives).
      o.pos.assign(vec4(uv.x, uv.y, textureSampleLevel(arrTex.node, arrSmp.node, uv, 1, 0).x, 1))
      o.uv.assign(uv)
      return o
    },
    { stage: 'vertex' },
  )
  const arrFs = fn(
    'arr_fs',
    { inp: ArrOut },
    ({ inp }) => textureSample(arrTex.node, arrSmp.node, inp.uv, 1),
    { stage: 'fragment', retAttr: location(0, vec4fT) },
  )
  const arrMod = dslModule({ uses: [ArrOut, arrTex, arrSmp], funcs: [arrVs, arrFs] })

  // Fixtures for the two precision-header negatives below: a vertex stage that
  // touches NO texture, and a fragment stage sampling a PLAIN 2d texture.
  const plainVs = fn(
    'arr_plain_vs',
    { uv: location(0, vec2fT) },
    ({ uv }) => {
      const o = ArrOut.var('out')
      o.pos.assign(vec4(uv.x, uv.y, 0, 1))
      o.uv.assign(uv)
      return o
    },
    { stage: 'vertex' },
  )
  const tex2d = resource('prec_tex', texture2dfT, { group: 0, binding: 0 })
  const smp2d = resource('prec_smp', samplerT, { group: 0, binding: 1 })
  const fs2d = fn(
    'prec_fs',
    { inp: ArrOut },
    ({ inp }) => textureSample(tex2d.node, smp2d.node, inp.uv),
    { stage: 'fragment', retAttr: location(0, vec4fT) },
  )

  it('WGSL spells the array type + keeps the layer as its own argument', () => {
    const w = emitModule(arrMod)
    expect(w).toContain('var arr_tex: texture_2d_array<f32>;')
    expect(w).toContain('textureSample(arr_tex, arr_smp, inp.uv, 1)')
    expect(w).toContain('textureSampleLevel(arr_tex, arr_smp, uv, 1, 0.0)')
  })

  it('declares `precision highp sampler2DArray;` — and ONLY when the stage has one', () => {
    // GLSL ES 3.00 §4.5.4 predeclares default precisions for sampler2D / samplerCube
    // ONLY: an unqualified `uniform sampler2DArray` is a COMPILE error, and
    // `precision highp float;` does not cover it. Both stages declare the atlas here.
    expect(emitGlslModule(arrMod, 'fragment')).toContain('precision highp sampler2DArray;')
    expect(emitGlslModule(arrMod, 'vertex')).toContain('precision highp sampler2DArray;')
    // The negative holds a PLAIN 2d texture — so a dim check degenerating to
    // `kind === 'texture'` goes red here, which a textureless module (or the emit
    // goldens, none of which bind a texture) could never catch. The stray line
    // would even be legal GLSL, so no driver gate catches it either.
    const plainMod = dslModule({ uses: [ArrOut, tex2d, smp2d], funcs: [plainVs, fs2d] })
    const plainFsG = emitGlslModule(plainMod, 'fragment')
    expect(plainFsG).toContain('uniform sampler2D prec_tex;')
    expect(plainFsG).not.toContain('sampler2DArray')
  })

  it('the precision line is PER-STAGE: array reaching only the fragment stage keeps the vertex header clean', () => {
    // Keyed on the STAGE's binding scope, not the module's: the vertex stage of
    // this module never touches arr_tex, so its header (and its uniforms) must
    // stay byte-identical to the no-array baseline — stage-scoped emit invariant.
    const m = dslModule({ uses: [ArrOut, arrTex, arrSmp], funcs: [plainVs, arrFs] })
    expect(emitGlslModule(m, 'fragment')).toContain('precision highp sampler2DArray;')
    const vsG = emitGlslModule(m, 'vertex')
    expect(vsG).not.toContain('sampler2DArray')
    expect(vsG).not.toContain('arr_tex') // the binding itself is stage-scoped out too
  })

  it('GLSL declares a sampler2DArray and folds the layer into a vec3 coordinate', () => {
    const fsG = emitGlslModule(arrMod, 'fragment')
    expect(fsG).toContain('uniform sampler2DArray arr_tex;')
    expect(fsG).toContain('texture(arr_tex, vec3(inp.uv, float(1)))')
    expect(fsG).not.toContain('arr_smp') // fused into the combined sampler
    const vsG = emitGlslModule(arrMod, 'vertex')
    expect(vsG).toContain('textureLod(arr_tex, vec3(uv, float(1)), 0.0)')
    expect(vsG).toContain('uniform sampler2DArray arr_tex;')
  })

  it('textureLoad folds the layer into an ivec3 fetch; textureDimensions is unchanged', () => {
    const loadFs = fn(
      'arr_load_fs',
      { inp: ArrOut },
      () =>
        textureLoad(arrTex.node, vec2i(0, 0), 1, u32(0)).add(
          toF32(textureDimensions(arrTex.node).x),
        ),
      { stage: 'fragment', retAttr: location(0, vec4fT) },
    )
    const m = dslModule({ uses: [ArrOut, arrTex, arrSmp], funcs: [arrVs, loadFs] })
    const fsG = emitGlslModule(m, 'fragment')
    expect(fsG).toContain('texelFetch(arr_tex, ivec3(ivec2(0, 0), int(1)), int(0u))')
    // WGSL textureDimensions returns vec2<u32> for arrays too — GLSL's ivec3
    // textureSize truncates into the uvec2() constructor (GLSL ES 3.00 §5.4.2).
    expect(fsG).toContain('uvec2(textureSize(arr_tex, 0))')
    const w = emitModule(m)
    expect(w).toContain('textureLoad(arr_tex, vec2<i32>(0, 0), 1, 0u)')
  })

  it('textureNumLayers (#1658) reads the .z textureDimensions drops', () => {
    // The two targets are structurally different here — WGSL has a dedicated builtin,
    // GLSL ES 3.00 has none and takes the THIRD component of its ivec3 textureSize
    // (lod 0: the layer count is lod-invariant). Both spellings pinned side by side.
    const layersFs = fn(
      'arr_layers_fs',
      { inp: ArrOut },
      () => vec4(toF32(textureNumLayers(arrTex.node)), 0, 0, 1),
      { stage: 'fragment', retAttr: location(0, vec4fT) },
    )
    const m = dslModule({ uses: [ArrOut, arrTex, arrSmp], funcs: [arrVs, layersFs] })
    expect(emitGlslModule(m, 'fragment')).toContain('uint(textureSize(arr_tex, 0).z)')
    expect(emitModule(m)).toContain('textureNumLayers(arr_tex)')
  })
})

// ── integer sampled textures (#1703) — u/isampler on GLSL, texture_2d<u32> on WGSL ──
//
// The element axis needs NO new neutral id: texelFetch / textureSize / the .z layer
// read are already generic over the sampler type, so only the DECLARED type and the
// RESULT type move. Both spellings of the same module are asserted side by side, same
// as the #1651 block above, so a divergence lands in one diff.
describe('glsl-es300 / wgsl — integer texture reads (#1703)', () => {
  const IntOut = ioStruct('IntOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })
  const uTex = resource('u_ids', texture2duT, { group: 0, binding: 0 })
  const iTex = resource('i_deltas', texture2diT, { group: 0, binding: 1 })
  const uArr = resource('u_atlas', texture2dArrayuT, { group: 0, binding: 2 })
  const intVs = fn(
    'int_vs',
    { uv: location(0, vec2fT) },
    ({ uv }) => {
      const o = IntOut.var('out')
      o.pos.assign(vec4(uv.x, uv.y, 0, 1))
      o.uv.assign(uv)
      return o
    },
    { stage: 'vertex' },
  )
  const intFs = fn(
    'int_fs',
    { inp: IntOut },
    () =>
      vec4(
        toF32(textureLoad(uTex.node, vec2i(0, 0), 0).x),
        toF32(textureLoad(iTex.node, vec2i(1, 0), 0).y),
        toF32(textureLoad(uArr.node, vec2i(2, 0), 1, 0).z),
        1,
      ),
    { stage: 'fragment', retAttr: location(0, vec4fT) },
  )
  const intMod = dslModule({ uses: [IntOut, uTex, iTex, uArr], funcs: [intVs, intFs] })

  it('WGSL parameterizes the texture type on its element', () => {
    const w = emitModule(intMod)
    expect(w).toContain('var u_ids: texture_2d<u32>;')
    expect(w).toContain('var i_deltas: texture_2d<i32>;')
    expect(w).toContain('var u_atlas: texture_2d_array<u32>;')
    // The read spelling is the SAME builtin as the f32 one — only the type moved.
    expect(w).toContain('textureLoad(u_ids, vec2<i32>(0, 0), 0u)')
    expect(w).toContain('textureLoad(u_atlas, vec2<i32>(2, 0), 1, 0u)')
  })

  it('GLSL prefixes the sampler type per element, and fetches through the same texelFetch', () => {
    const fsG = emitGlslModule(intMod, 'fragment')
    expect(fsG).toContain('uniform usampler2D u_ids;')
    expect(fsG).toContain('uniform isampler2D i_deltas;')
    expect(fsG).toContain('uniform usampler2DArray u_atlas;')
    expect(fsG).toContain('texelFetch(u_ids, ivec2(0, 0), int(0u))')
    // the array form still folds the layer into the ivec3 coordinate (#1651)
    expect(fsG).toContain('texelFetch(u_atlas, ivec3(ivec2(2, 0), int(1)), int(0u))')
  })

  it('every non-sampler2D type gets its own precision line, deduped and sorted', () => {
    // GLSL ES 3.00 §4.5.4 predeclares defaults for sampler2D / samplerCube ONLY, so each
    // integer sampler type needs its own line exactly as sampler2DArray does (#1651) —
    // and WITHOUT one the shader does not compile at all. Asserted as a contiguous
    // literal block, not three toContain()s: order and adjacency are what make the
    // header deterministic, and three independent substring checks would pass on a
    // header that emitted them scattered or duplicated.
    expect(emitGlslModule(intMod, 'fragment')).toContain(
      'precision highp int;\n' +
        'precision highp isampler2D;\n' +
        'precision highp usampler2D;\n' +
        'precision highp usampler2DArray;\n',
    )
  })

  it('the precision lines stay keyed to the STAGE, and a float-only module emits none', () => {
    // Same negative shape as #1651's: the vertex stage here touches no texture, so a
    // check that degenerated to `kind === 'texture'` (module-wide instead of
    // stage-scoped) goes red. A stray precision line is legal GLSL, so no driver
    // catches this — only the assertion does.
    const vsG = emitGlslModule(intMod, 'vertex')
    expect(vsG).not.toContain('sampler') // neither the types nor the bindings
    expect(vsG).toContain('precision highp int;\n\n')
  })

  it('an integer texture is a LOAD-ONLY resource — no sampler binding is emitted for it', () => {
    // The type system already refuses textureSample on these keys (dx-sweep pins it);
    // this is the emit-side witness that nothing synthesises a companion sampler, which
    // on WebGPU would be an invalid bind-group layout (a filtering sampler cannot pair
    // with a uint-sampleType texture).
    const fsG = emitGlslModule(intMod, 'fragment')
    expect(fsG).not.toContain('texture(u_ids')
    expect(emitModule(intMod)).not.toContain(': sampler;')
  })
})

// ── #1673 default FLOAT precision — a build-time emit knob, float line ONLY ──
//
// Mobile GPUs pay bandwidth/power for highp where mediump suffices, so the GLSL backend
// takes a build-time `floatPrecision` emit option. Two properties carry the whole
// feature, and both are byte-level:
//
//   1. `'highp'` (the default) is BYTE-NEUTRAL — an emit that omits the option is
//      identical to every emit produced before the option existed.
//   2. `'mediump'` moves EXACTLY ONE TOKEN. `precision highp int;` is load-bearing
//      (storage-emulation index math, bitcast lanes) and the #1651
//      `precision highp sampler2DArray;` line is a separate GLSL ES 3.00 §4.5.4
//      requirement — sweeping either into the knob turns a bandwidth optimisation into
//      a correctness bug.
//
// The headers below are written out as LITERAL blocks rather than generated from the
// template the emitter uses: a `toContain('precision mediump float;')` would be blind to
// the int line changing, a line disappearing, or the blank separator moving — which is
// precisely the failure this pin exists for.
//
// Numeric mediump BEHAVIOR is deliberately NOT gated anywhere: the CI rasterizer
// advertises mediump as 10-bit but computes it at f32 (census in
// playground/e2e/_glsl-compile-gate.spec.ts), so a pixel gate could not distinguish the
// two emits — an assertion that fails identically either way (§12). Header shape here,
// compile validity in the Playwright gate, real-device behavior an explicit skip.
describe('glsl-es300 — GlslEmitOptions.floatPrecision (#1673)', () => {
  const HIGHP_HEADER = '#version 300 es\nprecision highp float;\nprecision highp int;\n\n'
  const MEDIUMP_HEADER = '#version 300 es\nprecision mediump float;\nprecision highp int;\n\n'

  // `.slice(0, n)` + toBe, never `.startsWith(...)` + toBe(true): a boolean assertion
  // reports only "expected false to be true" and leaves the reader to find WHICH header
  // line moved, which is the one thing this suite exists to say out loud.
  const header = (glsl: string, expected: string): string => glsl.slice(0, expected.length)

  it('DEFAULT (option absent) emits the pre-#1673 header byte-for-byte, in BOTH stages', () => {
    expect(header(emitGlslModule(module, 'vertex'), HIGHP_HEADER)).toBe(HIGHP_HEADER)
    expect(header(emitGlslModule(module, 'fragment'), HIGHP_HEADER)).toBe(HIGHP_HEADER)
  })

  it("explicit {floatPrecision:'highp'} is byte-identical to omitting it entirely", () => {
    // WHOLE-STRING equality, not just the header: an option leaking into any other part
    // of the emit path (a plugin bag, a literal, a qualifier) shows up right here.
    for (const stage of ['vertex', 'fragment'] as const)
      expect(emitGlslModule(module, stage, { floatPrecision: 'highp' })).toBe(
        emitGlslModule(module, stage),
      )
  })

  it("{floatPrecision:'mediump'} flips EXACTLY the float line, in BOTH stages", () => {
    for (const stage of ['vertex', 'fragment'] as const) {
      const base = emitGlslModule(module, stage)
      const med = emitGlslModule(module, stage, { floatPrecision: 'mediump' })
      // The LOAD-BEARING int line first, and by name: a knob that over-reached into it
      // must produce a message that says `int`, not a bare header-block diff.
      expect(med).toContain('\nprecision highp int;\n')
      expect(med).not.toContain('precision mediump int;')
      expect(header(med, MEDIUMP_HEADER)).toBe(MEDIUMP_HEADER)
      // ...and that ONE line is the only difference in the entire emit: putting the
      // token back reproduces the default bytes. A knob that also touched a body
      // qualifier or a literal would fail here even with the header pin green.
      expect(med.replace('precision mediump float;', 'precision highp float;')).toBe(base)
    }
  })

  // The #1651 line is a DIFFERENT requirement from the float default: GLSL ES 3.00
  // §4.5.4 predeclares a default precision for sampler2D / samplerCube only, so a
  // sampler2DArray needs its own qualifier or the shader does not compile at all.
  // It stays highp under the knob.
  const PArrOut = ioStruct('PrecArrOut', {
    pos: builtin('position', vec4fT),
    uv: location(0, vec2fT),
  })
  const pArrTex = resource('prec_arr_tex', texture2dArrayfT, { group: 0, binding: 0 })
  const pArrSmp = resource('prec_arr_smp', samplerT, { group: 0, binding: 1 })
  const pArrVs = fn(
    'prec_arr_vs',
    { uv: location(0, vec2fT) },
    ({ uv }) => {
      const o = PArrOut.var('out')
      o.pos.assign(vec4(uv.x, uv.y, 0, 1))
      o.uv.assign(uv)
      return o
    },
    { stage: 'vertex' },
  )
  const pArrFs = fn(
    'prec_arr_fs',
    { inp: PArrOut },
    ({ inp }) => textureSample(pArrTex.node, pArrSmp.node, inp.uv, 1),
    { stage: 'fragment', retAttr: location(0, vec4fT) },
  )
  const pArrMod = dslModule({ uses: [PArrOut, pArrTex, pArrSmp], funcs: [pArrVs, pArrFs] })

  it('the #1651 sampler2DArray line stays highp under mediump (it is not part of the knob)', () => {
    const HIGHP_ARR =
      '#version 300 es\nprecision highp float;\nprecision highp int;\n' +
      'precision highp sampler2DArray;\n\n'
    const MEDIUMP_ARR =
      '#version 300 es\nprecision mediump float;\nprecision highp int;\n' +
      'precision highp sampler2DArray;\n\n'
    expect(header(emitGlslModule(pArrMod, 'fragment'), HIGHP_ARR)).toBe(HIGHP_ARR)
    const med = emitGlslModule(pArrMod, 'fragment', { floatPrecision: 'mediump' })
    expect(med).toContain('precision highp sampler2DArray;')
    expect(med).not.toContain('precision mediump sampler2DArray;')
    expect(header(med, MEDIUMP_ARR)).toBe(MEDIUMP_ARR)
  })
})
