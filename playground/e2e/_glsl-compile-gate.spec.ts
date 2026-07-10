// ═══ GLSL ES 3.00 compile gate: emitGlslModule output compiles on a real WebGL2 ═══
//
// The unit suite (shader-dsl/src/core/backends/glsl.test.ts) asserts the SHAPE of
// the emitted GLSL (version pragma, std140 block + engine-matched offsets, in/out
// varyings, single main()) but NEVER invokes `gl.compileShader`, so a string that
// is well-formed-LOOKING but rejected by the GLSL ES 3.00 compiler (precision
// omissions, reserved-word collisions, an in/out name collision, a bad gl_*
// builtin) would pass the unit gate. This spec closes that hole: it emits a
// representative @vertex + @fragment module via `emitGlslModule(m, stage)` and
// `compileShader`s + `linkProgram`s both in a REAL WebGL2 context (any browser —
// WebGL2 needs no WebGPU adapter), asserting empty info logs + a linked program.
//
// This is the headless-WebGL2 compile gate the glsl backend's W2 caveat called for.

import { test, expect } from '@playwright/test'
// Relative import (NOT the `@xgis/shader-dsl` alias): Playwright transpiles specs in raw
// Node, which does not resolve the workspace alias — the other compile gate
// (_wgsl-compile-gate.spec.ts) imports runtime shaders the same relative way.
import {
  emitGlslModule,
  mat4x4fT,
  vec4fT,
  vec2fT,
  vec3fT,
  f32T,
  u32T,
  structT,
  module as buildModule,
  fn,
  ioStruct,
  builtin,
  location,
  overrideConst,
  If,
  Var,
  f32,
  u32,
  toF32,
  vec2,
  vec4,
  type ShaderType,
  type Expr,
  type ModuleDecl,
  type StructDecl,
} from '../../shader-dsl/src/index'

// ── a representative vertex+fragment module with a std140 uniform struct ──
const Uniforms: StructDecl = {
  name: 'Uniforms',
  fields: [
    { name: 'mvp', type: mat4x4fT },
    { name: 'viewport', type: vec4fT },
    { name: 'fade', type: f32T },
    { name: 'origin', type: vec3fT },
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

test.describe('GLSL ES 3.00 compile gate (emitGlslModule output compiles on real WebGL2)', () => {
  test('the @vertex + @fragment GLSL compiles + links with zero info-log errors', async ({
    page,
  }) => {
    const vertex = emitGlslModule(module, 'vertex')
    const fragment = emitGlslModule(module, 'fragment')
    // sanity: non-trivial emit (a silently-empty emit would pass the gate vacuously).
    expect(vertex.length).toBeGreaterThan(100)
    expect(fragment.length).toBeGreaterThan(100)
    expect(vertex.startsWith('#version 300 es')).toBe(true)

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const result = await page.evaluate(
      ({ vertex, fragment }) => {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl2')
        if (!gl) return { fatal: 'no webgl2 context' as const }

        const compile = (type: number, src: string): { ok: boolean; log: string } => {
          const sh = gl.createShader(type)!
          gl.shaderSource(sh, src)
          gl.compileShader(sh)
          const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean
          const log = gl.getShaderInfoLog(sh) ?? ''
          return { ok, log }
        }

        const vs = compile(gl.VERTEX_SHADER, vertex)
        const fs = compile(gl.FRAGMENT_SHADER, fragment)
        let linkOk = false
        let linkLog = ''
        if (vs.ok && fs.ok) {
          const prog = gl.createProgram()!
          const vsh = gl.createShader(gl.VERTEX_SHADER)!
          gl.shaderSource(vsh, vertex)
          gl.compileShader(vsh)
          const fsh = gl.createShader(gl.FRAGMENT_SHADER)!
          gl.shaderSource(fsh, fragment)
          gl.compileShader(fsh)
          gl.attachShader(prog, vsh)
          gl.attachShader(prog, fsh)
          gl.linkProgram(prog)
          linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
          linkLog = gl.getProgramInfoLog(prog) ?? ''
        }
        return { vs, fs, linkOk, linkLog }
      },
      { vertex, fragment },
    )

    // WebGL2 must be available in the test browser (a Chromium with no WebGL2 is a
    // gate failure, not a skip — every dev/CI browser has WebGL2).
    expect(
      result,
      `WebGL2 unavailable: ${'fatal' in result ? result.fatal : ''}`,
    ).not.toHaveProperty('fatal')
    if ('fatal' in result) return

    expect(
      result.vs.ok,
      `vertex shader failed to compile:\n${result.vs.log}\n--- GLSL ---\n${vertex}`,
    ).toBe(true)
    expect(
      result.fs.ok,
      `fragment shader failed to compile:\n${result.fs.log}\n--- GLSL ---\n${fragment}`,
    ).toBe(true)
    expect(result.linkOk, `program failed to link:\n${result.linkLog}`).toBe(true)
  })

  // #923: a HOST-SPECIALIZED GLSL variant compiles on real WebGL2. The unit gate
  // (override-constants.test.ts) string-matches the specialized emit, but only ANGLE
  // proves the mechanism is valid GLSL — the earlier "prepend a #define" contract
  // string-matched fine yet produced an uncompilable shader (`#version` must lead the
  // source). The emitter now places the pinned `#define` AFTER the `#version` preamble,
  // spelled via literal(); this gate compiles that variant end-to-end.
  test('a #923 host-specialized override variant compiles + links on real WebGL2', async ({
    page,
  }) => {
    // Fullscreen-triangle vertex + a fragment whose branch is guarded by an override.
    const VsOut = ioStruct('OvVsOut', {
      pos: builtin('position', vec4fT),
      uv: location(0, vec2fT),
    })
    const vsFn = fn(
      'ov_vs',
      { vi: builtin('vertex_index', u32T) },
      ({ vi }) => {
        const x = toF32(vi.bitAnd(u32(1)))
          .mul(4)
          .sub(1)
        const y = toF32(vi.shr(u32(1)))
          .mul(4)
          .sub(1)
        return VsOut.construct({
          pos: vec4(x, y, 0, 1),
          uv: vec2(x.mul(0.5).add(0.5), y.mul(0.5).add(0.5)),
        })
      },
      { stage: 'vertex' },
    )
    const quality = overrideConst('quality', f32T, 1.0)
    const fsFn = fn(
      'ov_fs',
      { inp: VsOut },
      ({ inp }) => {
        const g = Var(f32(1))
        If(quality.node.gt(f32(1)), () => {
          g.assign(f32(2))
        })
        return vec4(inp.uv.x.mul(g), inp.uv.y, f32(0), f32(1))
      },
      { stage: 'fragment', retAttr: '@location(0)' },
    )
    const overrideModule = buildModule({
      overrides: [quality.decl],
      funcs: [vsFn, fsFn],
      uses: [VsOut],
    })

    const vertex = emitGlslModule(overrideModule, 'vertex')
    // The SPECIALIZED fragment: host pins quality=2.0 → a hard `#define quality 2.0`.
    const fragment = emitGlslModule(overrideModule, 'fragment', {
      overrideValues: { quality: 2.0 },
    })
    // guardrails: valid position (never prepended) + the pinned define is present.
    expect(vertex.startsWith('#version 300 es')).toBe(true)
    expect(fragment.startsWith('#version 300 es')).toBe(true)
    expect(fragment).toContain('#define quality 2.0')
    expect(fragment).not.toContain('#ifndef quality')

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const result = await page.evaluate(
      ({ vertex, fragment }) => {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl2')
        if (!gl) return { fatal: 'no webgl2 context' as const }

        const compile = (type: number, src: string): { ok: boolean; log: string } => {
          const sh = gl.createShader(type)!
          gl.shaderSource(sh, src)
          gl.compileShader(sh)
          const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean
          return { ok, log: gl.getShaderInfoLog(sh) ?? '' }
        }

        const vs = compile(gl.VERTEX_SHADER, vertex)
        const fs = compile(gl.FRAGMENT_SHADER, fragment)
        let linkOk = false
        let linkLog = ''
        if (vs.ok && fs.ok) {
          const prog = gl.createProgram()!
          const vsh = gl.createShader(gl.VERTEX_SHADER)!
          gl.shaderSource(vsh, vertex)
          gl.compileShader(vsh)
          const fsh = gl.createShader(gl.FRAGMENT_SHADER)!
          gl.shaderSource(fsh, fragment)
          gl.compileShader(fsh)
          gl.attachShader(prog, vsh)
          gl.attachShader(prog, fsh)
          gl.linkProgram(prog)
          linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
          linkLog = gl.getProgramInfoLog(prog) ?? ''
        }
        return { vs, fs, linkOk, linkLog }
      },
      { vertex, fragment },
    )

    expect(
      result,
      `WebGL2 unavailable: ${'fatal' in result ? result.fatal : ''}`,
    ).not.toHaveProperty('fatal')
    if ('fatal' in result) return

    expect(
      result.vs.ok,
      `specialized vertex failed to compile:\n${result.vs.log}\n--- GLSL ---\n${vertex}`,
    ).toBe(true)
    expect(
      result.fs.ok,
      `specialized fragment failed to compile:\n${result.fs.log}\n--- GLSL ---\n${fragment}`,
    ).toBe(true)
    expect(result.linkOk, `specialized program failed to link:\n${result.linkLog}`).toBe(true)
  })
})
