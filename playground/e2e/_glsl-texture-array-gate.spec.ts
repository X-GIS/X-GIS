// ═══ GLSL ES 3.00 compile gate — 2d-ARRAY texture sampling (#1651) ═══
//
// The sibling _glsl-texture-gate covers the flat `sampler2D` surface (fused
// texture+sampler) and the explicit-LOD mip selection. A 2d-ARRAY texture adds a
// second selector — the LAYER — and the two targets carry it differently: WGSL
// appends it as its own argument (`textureSample(t, s, uv, layer)`), GLSL ES 3.00
// folds it into the coordinate's third component
// (`texture(sampler2DArray, vec3(uv, float(layer)))`). That restructuring is why the
// array reads carry DISTINCT neutral intrinsic ids rather than an arity branch, and
// it is exactly the kind of thing a unit string-shape test cannot prove: only a real
// driver says whether the emitted vec3 coordinate SELECTS the layer the author asked
// for. So this spec compiles + links the emitted GLSL on a real WebGL2 context and
// then READS BACK a pixel from a fixture where every (layer, level) cell is a
// distinct colour — each of the three reads owns its own output channel, so a wrong
// layer OR a wrong level flips a channel and fails loudly.
//
// The fixture (TEXTURE_2D_ARRAY, 2 layers × 2 mip levels, hand-built so no two cells
// can be confused — generateMipmap would make level 1 a blur of level 0):
//
//     layer 0, level 0 (2×2) — RED    (255,   0,   0, 255)
//     layer 0, level 1 (1×1) — YELLOW (255, 255,   0,   0)   ← alpha 0: the vertex target
//     layer 1, level 0 (2×2) — GREEN  (  0, 255,   0, 255)   ← the implicit-LOD target
//     layer 1, level 1 (1×1) — BLUE   (  0,   0, 255, 255)   ← the explicit-LOD target
//
// Channel routing (the discrimination table):
//     r,g ← FRAGMENT textureSampleArray(layer 1)        → expect r=0, g=255 (green)
//     b   ← FRAGMENT textureSampleLevelArray(1, lod 1)  → expect b=255      (blue)
//     a   ← VERTEX   textureSampleLevelArray(0, lod 1)  → expect a=0        (yellow)
// A wrong layer on the first read reads red/yellow → r=255. A wrong level reads blue
// → g=0. A wrong cell on either explicit-LOD read has b=0 / a=255. The clear colour is
// 50% grey with alpha 1, so "nothing drew" is (128,128,128,255) — distinct from every
// wrong-selection outcome.
//
// MUTATION-PROBE NOTE (verification review of #1651): folding the layer into the
// WRONG vec3 component leaves r/g/b byte-identical to healthy — the interpolated
// VERTEX read's alpha (159 instead of 0) is the ONLY detector for that mutation
// class. Do NOT simplify the vertex read or the valpha routing; the coordinate-fold
// swizzle detection dies with it.

// Relative deep import (charter): Playwright transpiles specs in raw Node — the @xgis/* workspace alias does not resolve here, so specs import package SOURCES relatively (see _glsl-compile-gate.spec.ts).
import { test, expect } from '@playwright/test'
import {
  emitGlslModule,
  vec4fT,
  vec2fT,
  vec2iT,
  vec2uT,
  f32T,
  i32T,
  u32T,
  structT,
  texture2dArrayfT,
  samplerT,
  type ShaderType,
  type Expr,
  type ModuleDecl,
  type StructDecl,
} from '../../shader-dsl/src/index'

const VsIn: StructDecl = {
  name: 'VsIn',
  fields: [
    { name: 'pos', type: vec2fT, attr: '@location(0)' },
    { name: 'uv', type: vec2fT, attr: '@location(1)' },
  ],
}
// `valpha` carries the VERTEX-stage array read into the fragment output's alpha —
// the vertex stage has no derivatives, so an array read there is legal ONLY in the
// explicit-LOD form. Routing it into the readback proves it actually happened.
const ArrVsOut: StructDecl = {
  name: 'ArrVsOut',
  fields: [
    { name: 'position', type: vec4fT, attr: '@builtin(position)' },
    { name: 'uv', type: vec2fT, attr: '@location(0)' },
    { name: 'valpha', type: f32T, attr: '@location(1)' },
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
const layerLit = (value: number): Expr => ({ op: 'lit', type: i32T, value })
const v4 = (...args: Expr[]): Expr => ({ op: 'construct', type: vec4fT, args })

/** textureSampleArray(tex, samp, uv, layer) — filtered, implicit LOD (fragment only). */
const sampleArray = (uv: Expr, layer: number): Expr => ({
  op: 'call',
  type: vec4fT,
  fn: 'textureSampleArray',
  args: [varref('tex', texture2dArrayfT), varref('samp', samplerT), uv, layerLit(layer)],
})
/** textureSampleLevelArray(tex, samp, uv, layer, level) — explicit LOD, any stage. */
const sampleLevelArray = (uv: Expr, layer: number, level: number): Expr => ({
  op: 'call',
  type: vec4fT,
  fn: 'textureSampleLevelArray',
  args: [
    varref('tex', texture2dArrayfT),
    varref('samp', samplerT),
    uv,
    layerLit(layer),
    lit(level),
  ],
})

const inUv = fld(param('inp', structT('VsIn')), 'uv', vec2fT)
const outUv = fld(param('inp', structT('ArrVsOut')), 'uv', vec2fT)

// ── ZERO-contribution witnesses for the remaining array spellings (verification
// review of #1651, finding C): the unit suite pins `texelFetch(…ivec3…)`,
// `uvec2(textureSize(…))` and `uint(textureSize(…).z)` as STRINGS, but only a real
// compiler consumes them — without these terms CI has no persistent driver witness
// for any of them. Every term is exactly 0, so the discrimination table above is
// unchanged.
//   loadArray(layer 0, level 0).y — the RED texel's green component → 0
//   float(dims.x - dims.y)        — the 2×2 base level → float(2u - 2u) → 0
//   float(numLayers - 2u)         — the fixture is 2 layers deep → float(2u - 2u) → 0
const loadArrayRed: Expr = {
  op: 'call',
  type: vec4fT,
  fn: 'textureLoadArray',
  args: [
    varref('tex', texture2dArrayfT),
    { op: 'construct', type: vec2iT, args: [layerLit(0), layerLit(0)] },
    layerLit(0),
    layerLit(0),
  ],
}
const dims: Expr = {
  op: 'call',
  type: vec2uT,
  fn: 'textureDimensions',
  args: [varref('tex', texture2dArrayfT)],
}
// #1658 — the layer COUNT is the ivec3 component `dims` (textureDimensions) drops, so
// it needs its own driver witness: the fixture is 2 layers deep at every level.
const numLayers: Expr = {
  op: 'call',
  type: u32T,
  fn: 'textureNumLayers',
  args: [varref('tex', texture2dArrayfT)],
}
const zeroWitness: Expr = {
  op: 'binop',
  type: f32T,
  bop: '+',
  a: {
    op: 'binop',
    type: f32T,
    bop: '+',
    a: fld(loadArrayRed, 'y', f32T),
    b: {
      op: 'call',
      type: f32T,
      fn: 'f32',
      args: [
        { op: 'binop', type: u32T, bop: '-', a: fld(dims, 'x', u32T), b: fld(dims, 'y', u32T) },
      ],
    },
  },
  b: {
    op: 'call',
    type: f32T,
    fn: 'f32',
    args: [
      { op: 'binop', type: u32T, bop: '-', a: numLayers, b: { op: 'lit', type: u32T, value: 2 } },
    ],
  },
}

const arrayModule: ModuleDecl = {
  consts: [],
  structs: [VsIn, ArrVsOut, FsOut],
  bindings: [
    { group: 0, binding: 0, name: 'tex', space: 'uniform', type: texture2dArrayfT },
    { group: 0, binding: 1, name: 'samp', space: 'uniform', type: samplerT },
  ],
  funcs: [
    {
      name: 'vs',
      attrs: ['@vertex'],
      params: [{ name: 'inp', type: structT('VsIn') }],
      ret: structT('ArrVsOut'),
      body: [
        { s: 'var', name: 'o', type: structT('ArrVsOut') },
        {
          s: 'assign',
          target: fld(varref('o', structT('ArrVsOut')), 'position', vec4fT),
          expr: v4(
            fld(fld(param('inp', structT('VsIn')), 'pos', vec2fT), 'x', f32T),
            fld(fld(param('inp', structT('VsIn')), 'pos', vec2fT), 'y', f32T),
            lit(0),
            lit(1),
          ),
        },
        {
          s: 'assign',
          target: fld(varref('o', structT('ArrVsOut')), 'uv', vec2fT),
          expr: inUv,
        },
        {
          // layer 0 / level 1 = YELLOW, whose ALPHA is 0 — every other cell has alpha 1.
          s: 'assign',
          target: fld(varref('o', structT('ArrVsOut')), 'valpha', f32T),
          expr: fld(sampleLevelArray(inUv, 0, 1), 'w', f32T),
        },
        { s: 'return', expr: varref('o', structT('ArrVsOut')) },
      ],
    },
    {
      name: 'fs',
      attrs: ['@fragment'],
      params: [{ name: 'inp', type: structT('ArrVsOut') }],
      ret: structT('FsOut'),
      body: [
        {
          s: 'return',
          expr: {
            op: 'construct',
            type: structT('FsOut'),
            args: [
              v4(
                fld(sampleArray(outUv, 1), 'x', f32T),
                fld(sampleArray(outUv, 1), 'y', f32T),
                {
                  // b = blue.z + the three zero witnesses (see zeroWitness above)
                  op: 'binop',
                  type: f32T,
                  bop: '+',
                  a: fld(sampleLevelArray(outUv, 1, 1), 'z', f32T),
                  b: zeroWitness,
                },
                fld(param('inp', structT('ArrVsOut')), 'valpha', f32T),
              ),
            ],
          },
        },
      ],
    },
  ],
}

/** Compile + link a GLSL ES 3.00 pair on a real WebGL2 context (page-side). */
const COMPILE_LINK = ({ vertex, fragment }: { vertex: string; fragment: string }) => {
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
}

test('GLSL 2d-array module compiles + links on real WebGL2 (sampler2DArray, vec3 coords)', async ({
  page,
}) => {
  const vertex = emitGlslModule(arrayModule, 'vertex')
  const fragment = emitGlslModule(arrayModule, 'fragment')

  // Emit shape: the array type + the layer folded into a vec3 coordinate on BOTH forms.
  expect(fragment).toContain('sampler2DArray')
  expect(fragment).toContain('texture(tex, vec3(') // textureSampleArray
  expect(fragment).toContain('textureLod(tex, vec3(') // textureSampleLevelArray
  expect(fragment).toContain('texelFetch(tex, ivec3(') // textureLoadArray (zero witness)
  expect(fragment).toContain('uvec2(textureSize(tex, 0))') // textureDimensions on the array type
  expect(fragment).toContain('uint(textureSize(tex, 0).z)') // textureNumLayers (zero witness)
  expect(vertex).toContain('sampler2DArray')
  expect(vertex).toContain('textureLod(tex, vec3(') // the VERTEX-stage array read
  // …and the standalone sampler binding fuses away (word-boundary: `samp` alone).
  expect(vertex).not.toMatch(/\bsamp\b/)
  expect(fragment).not.toMatch(/\bsamp\b/)

  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  const result = await page.evaluate(COMPILE_LINK, { vertex, fragment })

  expect(result, `WebGL2 unavailable`).not.toHaveProperty('fatal')
  if ('fatal' in result) return
  expect(result.vsOk, `vs:\n${result.vsLog}\n${vertex}`).toBe(true)
  expect(result.fsOk, `fs:\n${result.fsLog}\n${fragment}`).toBe(true)
  expect(result.linkOk, `link:\n${result.linkLog}`).toBe(true)
})

// The READBACK rung: compile+link proves the spelling is legal GLSL, not that the
// layer/level arguments reach the sampler. See the discrimination table at the top —
// each of the three array reads owns one output channel.
test('emitted sampler2DArray reads SELECT the requested (layer, level) on real WebGL2', async ({
  page,
}) => {
  const vertex = emitGlslModule(arrayModule, 'vertex')
  const fragment = emitGlslModule(arrayModule, 'fragment')

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

      // 2 layers × 2 mip levels, every cell a distinct colour. Levels are supplied by
      // hand (no generateMipmap): a generated level 1 would be a blur of level 0 and the
      // probe could not tell the levels apart. A 2d-array mip reduces width/height only —
      // the DEPTH (layer count) stays 2 at every level.
      const solid = (n: number, rgba: readonly number[]) => {
        const px = new Uint8Array(n * 4)
        for (let i = 0; i < n; i++) px.set(rgba, i * 4)
        return px
      }
      const level0 = new Uint8Array(2 * 2 * 2 * 4) // 2×2 × 2 layers
      level0.set(solid(4, [255, 0, 0, 255]), 0) // layer 0 — RED
      level0.set(solid(4, [0, 255, 0, 255]), 4 * 4) // layer 1 — GREEN
      const level1 = new Uint8Array(1 * 1 * 2 * 4) // 1×1 × 2 layers
      level1.set([255, 255, 0, 0], 0) // layer 0 — YELLOW, alpha 0
      level1.set([0, 0, 255, 255], 4) // layer 1 — BLUE

      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex)
      // prettier-ignore
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA, 2, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, level0)
      // prettier-ignore
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA, 1, 1, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, level1)
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST)
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_BASE_LEVEL, 0)
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, 1)

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
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex)
      gl.uniform1i(gl.getUniformLocation(prog, 'tex'), 0)
      gl.viewport(0, 0, 4, 4)
      // 50% grey, alpha 1 — a pixel that stays (128,128,128,255) means nothing drew.
      gl.clearColor(0.5, 0.5, 0.5, 1)
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
  expect(result.glError, 'gl error during the 2d-array selection draw').toBe(0)
  const [r, g, b, a] = result.px
  expect(
    { r, g, b, a },
    `expected {r:0, g:255} (fragment implicit-LOD read hit layer 1 / level 0 = green), ` +
      `b=255 (fragment explicit-LOD read hit layer 1 / level 1 = blue), ` +
      `a=0 (VERTEX explicit-LOD read hit layer 0 / level 1 = yellow, alpha 0). ` +
      `r=255 → the fragment read took the wrong LAYER; g=0 → it took the wrong LEVEL; ` +
      `b=0 → the fragment explicit-LOD cell was wrong; a=255 → the vertex one was; ` +
      `(128,128,128,255) = nothing drew`,
  ).toEqual({ r: 0, g: 255, b: 255, a: 0 })
})
