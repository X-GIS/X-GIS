// ═══ GLSL ES 3.00 compile gate — TEXTURE SAMPLING (render-shader surface) ═══
//
// The sibling _glsl-compile-gate covers a uniform+IO module (no texture). Render
// shaders (raster/icon/text/composite) sample a texture via a SEPARATE texture +
// sampler binding (WGSL splits them); GLSL ES 3.00 FUSES them into one combined
// sampler2D. This gate emits a texture+sampler+textureSample module via the GLSL
// backend and compiles + links it on a REAL WebGL2 context, proving the fused-
// sampler path (the standalone sampler binding must be dropped, not emitted).
//
// #1650 adds the EXPLICIT-LOD twin (textureSampleLevel → textureLod): one case that
// compiles + links a module sampling in BOTH stages (a vertex sample is legal only
// with an explicit LOD — there are no derivatives there), and one READBACK probe that
// proves the emitted textureLod actually SELECTS the requested mip: a 2×2 texture whose
// level 0 is red and level 1 is green must read back GREEN at level 1. A compile+link
// pass alone would stay green if the level argument were dropped on the floor.

// Relative deep import (charter): Playwright transpiles specs in raw Node — the @xgis/* workspace alias does not resolve here, so specs import package SOURCES relatively (see _glsl-compile-gate.spec.ts).
import { test, expect } from '@playwright/test'
import {
  emitGlslModule,
  mat4x4fT,
  vec4fT,
  vec2fT,
  f32T,
  structT,
  texture2dfT,
  samplerT,
  type ShaderType,
  type Expr,
  type ModuleDecl,
  type StructDecl,
} from '../../shader-dsl/src/index'

const Uniforms: StructDecl = { name: 'Uniforms', fields: [{ name: 'mvp', type: mat4x4fT }] }
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

// fs samples the bound texture at the interpolated uv (the render-shader surface).
const sampleUv: Expr = {
  op: 'call',
  type: vec4fT,
  fn: 'textureSample',
  args: [
    varref('tex', texture2dfT),
    varref('samp', samplerT),
    fld(param('inp', structT('VsOut')), 'uv', vec2fT),
  ],
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
      body: [{ s: 'return', expr: { op: 'construct', type: structT('FsOut'), args: [sampleUv] } }],
    },
  ],
}

test('GLSL texture-sampling module compiles + links on real WebGL2 (fused sampler2D)', async ({
  page,
}) => {
  const vertex = emitGlslModule(module, 'vertex')
  const fragment = emitGlslModule(module, 'fragment')
  expect(fragment).toContain('sampler2D')
  expect(fragment).toContain('texture(') // textureSample → texture(tex, uv)

  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  const result = await page.evaluate(
    ({ vertex, fragment }) => {
      const gl = document.createElement('canvas').getContext('webgl2')
      if (!gl) return { fatal: 'no webgl2' as const }
      const compile = (type: number, src: string) => {
        const sh = gl.createShader(type)!
        gl.shaderSource(sh, src)
        gl.compileShader(sh)
        return {
          ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean,
          log: gl.getShaderInfoLog(sh) ?? '',
          sh,
        }
      }
      const vs = compile(gl.VERTEX_SHADER, vertex)
      const fs = compile(gl.FRAGMENT_SHADER, fragment)
      let linkOk = false,
        linkLog = ''
      if (vs.ok && fs.ok) {
        const prog = gl.createProgram()!
        gl.attachShader(prog, vs.sh)
        gl.attachShader(prog, fs.sh)
        gl.linkProgram(prog)
        linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
        linkLog = gl.getProgramInfoLog(prog) ?? ''
      }
      return { vsOk: vs.ok, vsLog: vs.log, fsOk: fs.ok, fsLog: fs.log, linkOk, linkLog }
    },
    { vertex, fragment },
  )

  expect(result, `WebGL2 unavailable`).not.toHaveProperty('fatal')
  if ('fatal' in result) return
  expect(result.vsOk, `vs:\n${result.vsLog}\n${vertex}`).toBe(true)
  expect(result.fsOk, `fs:\n${result.fsLog}\n${fragment}`).toBe(true)
  expect(result.linkOk, `link:\n${result.linkLog}`).toBe(true)
})

// ── #1650 — the explicit-LOD module (vertex sample + fragment textureLod) ──
//
// No uniform block: the vertex writes clip space directly, so the only bindings are
// the fused texture+sampler pair. z is DISPLACED by the sampled texel — a real vertex
// -stage texture read, which is legal precisely because the LOD is explicit.
const lodSample = (uv: Expr, level: number): Expr => ({
  op: 'call',
  type: vec4fT,
  fn: 'textureSampleLevel',
  args: [varref('tex', texture2dfT), varref('samp', samplerT), uv, lit(level)],
})

const lodModule: ModuleDecl = {
  consts: [],
  structs: [VsIn, VsOut, FsOut],
  bindings: [
    { group: 0, binding: 0, name: 'tex', space: 'uniform', type: texture2dfT },
    { group: 0, binding: 1, name: 'samp', space: 'uniform', type: samplerT },
  ],
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
            // level 1 is the 1×1 green texel → r = 0 → z = 0 (dead centre of clip z).
            fld(lodSample(fld(param('inp', structT('VsIn')), 'uv', vec2fT), 1), 'x', f32T),
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
            args: [lodSample(fld(param('inp', structT('VsOut')), 'uv', vec2fT), 1)],
          },
        },
      ],
    },
  ],
}

test('GLSL explicit-LOD module compiles + links on real WebGL2 (vertex-stage sample)', async ({
  page,
}) => {
  const vertex = emitGlslModule(lodModule, 'vertex')
  const fragment = emitGlslModule(lodModule, 'fragment')
  // textureSampleLevel → textureLod(tex, uv, level); the sampler arg + binding fuse away.
  expect(vertex).toContain('textureLod(tex, ')
  expect(fragment).toContain('textureLod(tex, ')
  // …the standalone `samp` binding is gone (word-boundary: `sampler2D` must still be there).
  expect(vertex).not.toMatch(/\bsamp\b/)
  expect(fragment).not.toMatch(/\bsamp\b/)

  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  const result = await page.evaluate(
    ({ vertex, fragment }) => {
      const gl = document.createElement('canvas').getContext('webgl2')
      if (!gl) return { fatal: 'no webgl2' as const }
      const compile = (type: number, src: string) => {
        const sh = gl.createShader(type)!
        gl.shaderSource(sh, src)
        gl.compileShader(sh)
        return {
          ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean,
          log: gl.getShaderInfoLog(sh) ?? '',
          sh,
        }
      }
      const vs = compile(gl.VERTEX_SHADER, vertex)
      const fs = compile(gl.FRAGMENT_SHADER, fragment)
      let linkOk = false,
        linkLog = ''
      if (vs.ok && fs.ok) {
        const prog = gl.createProgram()!
        gl.attachShader(prog, vs.sh)
        gl.attachShader(prog, fs.sh)
        gl.linkProgram(prog)
        linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
        linkLog = gl.getProgramInfoLog(prog) ?? ''
      }
      return { vsOk: vs.ok, vsLog: vs.log, fsOk: fs.ok, fsLog: fs.log, linkOk, linkLog }
    },
    { vertex, fragment },
  )

  expect(result, `WebGL2 unavailable`).not.toHaveProperty('fatal')
  if ('fatal' in result) return
  expect(result.vsOk, `vs:\n${result.vsLog}\n${vertex}`).toBe(true)
  expect(result.fsOk, `fs:\n${result.fsLog}\n${fragment}`).toBe(true)
  expect(result.linkOk, `link:\n${result.linkLog}`).toBe(true)
})

// The READBACK rung: compile+link proves the spelling is legal GLSL, not that the level
// argument reaches the sampler. Level 0 is red, level 1 (1×1) is green, MIN_FILTER is
// NEAREST_MIPMAP_NEAREST — so the drawn pixel is GREEN iff textureLod(t, uv, 1.0) really
// selected mip 1. A dropped/ignored level reads back RED and fails here.
test('emitted textureLod SELECTS the requested mip on real WebGL2 (readback: green, not red)', async ({
  page,
}) => {
  const vertex = emitGlslModule(lodModule, 'vertex')
  const fragment = emitGlslModule(lodModule, 'fragment')

  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  const result = await page.evaluate(
    ({ vertex, fragment }) => {
      const canvas = document.createElement('canvas')
      canvas.width = 4
      canvas.height = 4
      const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
      if (!gl) return { fatal: 'no webgl2' as const }
      const compile = (type: number, src: string) => {
        const sh = gl.createShader(type)!
        gl.shaderSource(sh, src)
        gl.compileShader(sh)
        return { ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean, sh }
      }
      const vs = compile(gl.VERTEX_SHADER, vertex)
      const fs = compile(gl.FRAGMENT_SHADER, fragment)
      if (!vs.ok || !fs.ok) return { fatal: 'compile' as const }
      const prog = gl.createProgram()!
      gl.attachShader(prog, vs.sh)
      gl.attachShader(prog, fs.sh)
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { fatal: 'link' as const }

      // 2×2 level 0 = solid RED; 1×1 level 1 = solid GREEN. Hand-built levels (no
      // generateMipmap) so the two levels are DISTINGUISHABLE — a generated mip of a
      // red level 0 would be red too, and the probe could not tell the levels apart.
      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      const red = new Uint8Array(2 * 2 * 4)
      for (let i = 0; i < 4; i++) red.set([255, 0, 0, 255], i * 4)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, red)
      gl.texImage2D(
        gl.TEXTURE_2D,
        1,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([0, 255, 0, 255]),
      )
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 1)

      // Fullscreen quad: a_pos (location 0) + a_uv (location 1), interleaved.
      const buf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      // prettier-ignore
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 0, 0,   1, -1, 1, 0,  -1, 1, 0, 1,
        -1,  1, 0, 1,   1, -1, 1, 0,   1, 1, 1, 1,
      ]), gl.STATIC_DRAW)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0)
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8)

      gl.useProgram(prog)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.uniform1i(gl.getUniformLocation(prog, 'tex'), 0)
      gl.viewport(0, 0, 4, 4)
      gl.clearColor(0, 0, 1, 1) // blue ground — a pixel that stays blue means nothing drew
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      const px = new Uint8Array(4)
      gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      return { px: [px[0], px[1], px[2], px[3]], glError: gl.getError() }
    },
    { vertex, fragment },
  )

  expect(result, `WebGL2 unavailable / shader rejected`).not.toHaveProperty('fatal')
  if ('fatal' in result) return
  expect(result.glError, 'gl error during the mip-selection draw').toBe(0)
  const [r, g, b] = result.px
  expect(
    { r, g, b },
    `expected the level-1 GREEN texel; red = the level argument never reached the sampler, blue = nothing drew`,
  ).toEqual({ r: 0, g: 255, b: 0 })
})
