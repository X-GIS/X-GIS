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
import { emitGlslModule, wgslLayout, UnsupportedFeatureError } from '@xgis/shader-dsl'
import {
  mat4x4fT,
  vec4fT,
  vec2fT,
  vec3fT,
  f32T,
  u32T,
  structT,
  type ShaderType,
  type Expr,
  type ModuleDecl,
  type StructDecl,
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
          expr: v4(
            fld(fld(param('inp', structT('VsIn')), 'pos', vec2fT), 'x', f32T),
            fld(fld(param('inp', structT('VsIn')), 'pos', vec2fT), 'y', f32T),
            lit(0),
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

describe('glsl-es300 — storage → data-texture emulation (opt-in)', () => {
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

  it('emulateStorage lowers a storage array<f32> to a sampler2D + texelFetch (no SSBO)', () => {
    const fs = emitGlslModule(storageMod, 'fragment', { emulateStorage: true })
    expect(fs).toContain('uniform sampler2D data;') // storage binding → data texture
    // data[i] → 2D-tiled fetch: ivec2(i % textureSize(data,0).x, i / textureSize(data,0).x)
    expect(fs).toMatch(
      /texelFetch\(data, ivec2\(int\(.*\) % textureSize\(data, 0\)\.x, int\(.*\) \/ textureSize\(data, 0\)\.x\), 0\)\.r/,
    )
    expect(fs).not.toContain('data[') // no raw array indexing survives
  })

  it('storage still FAILS CLOSED without the opt-in (default contract preserved)', () => {
    expect(() => emitGlslModule(storageMod, 'fragment')).toThrow(UnsupportedFeatureError)
  })

  // #823 — the retained-icon tint buffer shape: a top-level array<vec4<f32>> element
  // reads its 4 consecutive std430 lanes (i*4 .. i*4+3) recombined with a vec4 ctor.
  it('emulateStorage lowers a storage array<vec4f> to 4 texelFetch lanes + a vec4 ctor', () => {
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
    const fs = emitGlslModule(vecMod, 'fragment', { emulateStorage: true })
    expect(fs).toContain('uniform sampler2D tint;') // storage binding → data texture
    // element 3 → base lane 3u*4u, lanes +1/+2/+3, recombined into a vec4.
    expect(fs).toMatch(/vec4\(/)
    const fetches = fs.match(/texelFetch\(tint,/g) ?? []
    expect(fetches.length).toBe(4)
    expect(fs).not.toContain('tint[') // no raw array indexing survives
  })
})

describe('glsl-es300 — fail-closed on out-of-scope features', () => {
  it('a storage binding fails closed (GLSL ES 3.00 has no SSBO)', () => {
    const seg: StructDecl = { name: 'Seg', fields: [{ name: 'a', type: vec2fT }] }
    const storageMod: ModuleDecl = {
      consts: [],
      structs: [seg],
      bindings: [
        {
          group: 0,
          binding: 0,
          name: 'segs',
          space: 'storage',
          access: 'read',
          type: { kind: 'array', elem: structT('Seg') },
        },
      ],
      funcs: [],
    }
    expect(() => emitGlslModule(storageMod)).toThrow(UnsupportedFeatureError)
  })

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
})
