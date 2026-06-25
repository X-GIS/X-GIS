// ═══ GLSL ES 3.00 compile gate — TEXTURE SAMPLING (render-shader surface) ═══
//
// The sibling _glsl-compile-gate covers a uniform+IO module (no texture). Render
// shaders (raster/icon/text/composite) sample a texture via a SEPARATE texture +
// sampler binding (WGSL splits them); GLSL ES 3.00 FUSES them into one combined
// sampler2D. This gate emits a texture+sampler+textureSample module via the GLSL
// backend and compiles + links it on a REAL WebGL2 context, proving the fused-
// sampler path (the standalone sampler binding must be dropped, not emitted).

import { test, expect } from '@playwright/test'
import {
  emitGlslModule,
  mat4x4fT, vec4fT, vec2fT, f32T, structT, texture2dfT, samplerT,
  type ShaderType, type Expr, type ModuleDecl, type StructDecl,
} from '../../shader-dsl/src/index'

const Uniforms: StructDecl = { name: 'Uniforms', fields: [{ name: 'mvp', type: mat4x4fT }] }
const VsIn: StructDecl = { name: 'VsIn', fields: [
  { name: 'pos', type: vec2fT, attr: '@location(0)' },
  { name: 'uv', type: vec2fT, attr: '@location(1)' },
] }
const VsOut: StructDecl = { name: 'VsOut', fields: [
  { name: 'position', type: vec4fT, attr: '@builtin(position)' },
  { name: 'uv', type: vec2fT, attr: '@location(0)' },
] }
const FsOut: StructDecl = { name: 'FsOut', fields: [{ name: 'color', type: vec4fT, attr: '@location(0)' }] }

const param = (name: string, type: ShaderType): Expr => ({ op: 'param', type, name })
const varref = (name: string, type: ShaderType): Expr => ({ op: 'varref', type, name })
const fld = (base: Expr, field: string, type: ShaderType): Expr => ({ op: 'member', type, base, field })
const lit = (value: number): Expr => ({ op: 'lit', type: f32T, value })
const v4 = (...args: Expr[]): Expr => ({ op: 'construct', type: vec4fT, args })

// fs samples the bound texture at the interpolated uv (the render-shader surface).
const sampleUv: Expr = {
  op: 'call', type: vec4fT, fn: 'textureSample',
  args: [varref('tex', texture2dfT), varref('samp', samplerT), fld(param('inp', structT('VsOut')), 'uv', vec2fT)],
}

const module: ModuleDecl = {
  consts: [],
  structs: [Uniforms, VsIn, VsOut, FsOut],
  bindings: [
    { group: 0, binding: 0, name: 'u', space: 'uniform', type: structT('Uniforms') },
    { group: 0, binding: 1, name: 'tex', space: 'uniform', type: texture2dfT },
    { group: 0, binding: 2, name: 'samp', space: 'uniform', type: samplerT },
  ],
  funcs: [
    {
      name: 'vs', attrs: ['@vertex'],
      params: [{ name: 'inp', type: structT('VsIn') }], ret: structT('VsOut'),
      body: [
        { s: 'var', name: 'o', type: structT('VsOut') },
        { s: 'assign', target: fld(varref('o', structT('VsOut')), 'position', vec4fT),
          expr: v4(fld(fld(param('inp', structT('VsIn')), 'pos', vec2fT), 'x', f32T), fld(fld(param('inp', structT('VsIn')), 'pos', vec2fT), 'y', f32T), lit(0), lit(1)) },
        { s: 'assign', target: fld(varref('o', structT('VsOut')), 'uv', vec2fT), expr: fld(param('inp', structT('VsIn')), 'uv', vec2fT) },
        { s: 'return', expr: varref('o', structT('VsOut')) },
      ],
    },
    {
      name: 'fs', attrs: ['@fragment'],
      params: [{ name: 'inp', type: structT('VsOut') }], ret: structT('FsOut'),
      body: [{ s: 'return', expr: { op: 'construct', type: structT('FsOut'), args: [sampleUv] } }],
    },
  ],
}

test('GLSL texture-sampling module compiles + links on real WebGL2 (fused sampler2D)', async ({ page }) => {
  const vertex = emitGlslModule(module, 'vertex')
  const fragment = emitGlslModule(module, 'fragment')
  expect(fragment).toContain('sampler2D')
  expect(fragment).toContain('texture(') // textureSample → texture(tex, uv)

  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  const result = await page.evaluate(({ vertex, fragment }) => {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return { fatal: 'no webgl2' as const }
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh)
      return { ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean, log: gl.getShaderInfoLog(sh) ?? '', sh }
    }
    const vs = compile(gl.VERTEX_SHADER, vertex)
    const fs = compile(gl.FRAGMENT_SHADER, fragment)
    let linkOk = false, linkLog = ''
    if (vs.ok && fs.ok) {
      const prog = gl.createProgram()!; gl.attachShader(prog, vs.sh); gl.attachShader(prog, fs.sh); gl.linkProgram(prog)
      linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean; linkLog = gl.getProgramInfoLog(prog) ?? ''
    }
    return { vsOk: vs.ok, vsLog: vs.log, fsOk: fs.ok, fsLog: fs.log, linkOk, linkLog }
  }, { vertex, fragment })

  expect(result, `WebGL2 unavailable`).not.toHaveProperty('fatal')
  if ('fatal' in result) return
  expect(result.vsOk, `vs:\n${result.vsLog}\n${vertex}`).toBe(true)
  expect(result.fsOk, `fs:\n${result.fsLog}\n${fragment}`).toBe(true)
  expect(result.linkOk, `link:\n${result.linkLog}`).toBe(true)
})
