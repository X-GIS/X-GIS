// ═══ WebGL2 RHI render proof (browser side) ═══
//
// Runs the runtime WebGl2Device end-to-end in a REAL WebGL2 context: emits GLSL
// from the @xgis/shader-dsl GLSL backend, builds buffers/texture/sampler/bind-
// group/pipeline THROUGH the RHI, draws a fullscreen texture-sampling quad over a
// 2×2 checker texture, and reads back the framebuffer. Imported by
// _webgl2-render-gate.spec.ts via a vite-served dynamic import (it needs a live
// WebGL2 context, which only exists in the browser, not the node test process).
//
// The shader mirrors _glsl-texture-gate's module (uniform + texture + sampler,
// no storage/depth) but the vertex stage MULTIPLIES by the uniform mvp so the
// std140 UBO is genuinely LIVE (an unused block would be stripped at link, hiding
// the UBO-upload half of the proof).

import { WebGl2Device, wrapWebGl2Pass } from '@xgis/engine'
import { Material, executeItems } from '../../runtime/src/engine/render/material/material'
import { overdrawComposeModule } from '../../engine/src/shaders/dsl/overdraw-compose'
import { buildPointModule } from '../../runtime/src/engine/shaders/dsl/point'
import {
  emitGlslModule,
  mat4x4fT, vec4fT, vec2fT, f32T, u32T, structT, texture2dfT, samplerT,
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

const inpVsIn = param('inp', structT('VsIn'))
const posX = fld(fld(inpVsIn, 'pos', vec2fT), 'x', f32T)
const posY = fld(fld(inpVsIn, 'pos', vec2fT), 'y', f32T)
// clip = mvp * vec4(pos, 0, 1) — keeps the std140 UBO live (identity mvp → fullscreen).
const clip: Expr = { op: 'binop', type: vec4fT, bop: '*', a: fld(varref('u', structT('Uniforms')), 'mvp', mat4x4fT), b: v4(posX, posY, lit(0), lit(1)) }

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
        { s: 'assign', target: fld(varref('o', structT('VsOut')), 'position', vec4fT), expr: clip },
        { s: 'assign', target: fld(varref('o', structT('VsOut')), 'uv', vec2fT), expr: fld(inpVsIn, 'uv', vec2fT) },
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

// 2×2 checker, ROW-MAJOR with row 0 = the BOTTOM texture row (GL t=0 at bottom):
//   bottom row: BL=red,    BR=green
//   top row:    TL=blue,   TR=yellow
const TEXELS = {
  BL: [255, 0, 0, 255], BR: [0, 255, 0, 255],
  TL: [0, 0, 255, 255], TR: [255, 255, 0, 255],
}
const CLEAR = [255, 0, 255, 255] // magenta — a "blank" (un-drawn) pixel reads as this

export interface Webgl2ProofResult {
  fatal?: string
  vsGlsl: string
  fsGlsl: string
  glError: number // 0 === gl.NO_ERROR
  glNoError: number // gl.NO_ERROR enum value (for the assert)
  // sampled framebuffer colors at the 4 quadrant centers (each [r,g,b,a]).
  bottomLeft: number[]
  bottomRight: number[]
  topLeft: number[]
  topRight: number[]
  expected: { bottomLeft: number[]; bottomRight: number[]; topLeft: number[]; topRight: number[]; clear: number[] }
}

export function runWebgl2Proof(): Webgl2ProofResult {
  const vsGlsl = emitGlslModule(module, 'vertex')
  const fsGlsl = emitGlslModule(module, 'fragment')
  const expected = { bottomLeft: TEXELS.BL, bottomRight: TEXELS.BR, topLeft: TEXELS.TL, topRight: TEXELS.TR, clear: CLEAR }

  const SIZE = 64
  const canvas = document.createElement('canvas')
  canvas.width = SIZE; canvas.height = SIZE
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (!gl) return { fatal: 'no webgl2', vsGlsl, fsGlsl, glError: -1, glNoError: 0, bottomLeft: [], bottomRight: [], topLeft: [], topRight: [], expected }

  const device = new WebGl2Device(gl)

  // fullscreen quad: 2 triangles, pos in NDC [-1,1], uv [0,1]. stride 16 (pos.xy, uv.xy).
  const V = (px: number, py: number, u: number, v: number) => [px, py, u, v]
  const quad = new Float32Array([
    ...V(-1, -1, 0, 0), ...V(1, -1, 1, 0), ...V(-1, 1, 0, 1),
    ...V(-1, 1, 0, 1), ...V(1, -1, 1, 0), ...V(1, 1, 1, 1),
  ])
  const vbuf = device.createBuffer({ size: quad.byteLength, usage: 'vertex' })
  device.writeBuffer(vbuf, 0, quad)

  // identity mvp (std140 mat4 = 64 bytes, column-major).
  const mvp = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  const ubo = device.createBuffer({ size: 64, usage: 'uniform' })
  device.writeBuffer(ubo, 0, mvp)

  // 2×2 checker texture (row 0 = bottom).
  const texData = new Uint8Array([...TEXELS.BL, ...TEXELS.BR, ...TEXELS.TL, ...TEXELS.TR])
  const tex = device.createTexture({ width: 2, height: 2, format: 'rgba8unorm', usage: ['sample', 'copy-dst'] })
  device.writeTexture(tex, texData, 2 * 4, 2, 2)
  const view = device.createView(tex)
  const samp = device.createSampler({ mag: 'nearest', min: 'nearest' })

  const bgl = device.createBindGroupLayout([
    { binding: 0, kind: 'uniform' },
    { binding: 1, kind: 'texture' },
    { binding: 2, kind: 'sampler' },
  ])
  const bg = device.createBindGroup(bgl, [
    { binding: 0, resource: { buffer: ubo } },
    { binding: 1, resource: { view } },
    { binding: 2, resource: { sampler: samp } },
  ])

  const pipeline = device.createPipeline({
    code: '', vsEntry: 'vs', fsEntry: 'fs', vsCode: vsGlsl, fsCode: fsGlsl,
    bindGroupLayouts: [bgl],
    colorTargets: [{ format: 'rgba8unorm', blend: 'none' }],
    vertexBuffers: [{ stride: 16, attributes: [
      { location: 0, offset: 0, format: 'float32x2' },
      { location: 1, offset: 8, format: 'float32x2' },
    ] }],
  })

  // render to the default framebuffer, magenta clear → draw the quad.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.viewport(0, 0, SIZE, SIZE)
  gl.clearColor(CLEAR[0] / 255, CLEAR[1] / 255, CLEAR[2] / 255, CLEAR[3] / 255)
  gl.clear(gl.COLOR_BUFFER_BIT)

  const pass = wrapWebGl2Pass(device)
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bg)
  pass.setVertexBuffer(0, vbuf)
  pass.draw(6)
  gl.flush()

  const pixels = new Uint8Array(SIZE * SIZE * 4)
  gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
  const at = (x: number, y: number) => {
    const i = (y * SIZE + x) * 4
    return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]]
  }
  // quadrant centers (readPixels origin is bottom-left → y grows up).
  const result: Webgl2ProofResult = {
    vsGlsl, fsGlsl,
    glError: gl.getError(),
    glNoError: gl.NO_ERROR,
    bottomLeft: at(16, 16),
    bottomRight: at(48, 16),
    topLeft: at(16, 48),
    topRight: at(48, 48),
    expected,
  }
  return result
}

// ═══ Reflection-BY-NAME proof (US-001) ═══
//
// A TWO-texture shader: left half samples tex_a, right half tex_b. The bind-group
// LAYOUT lists the texture entries in REVERSED declaration order (tex_b before
// tex_a), so a by-ORDER reflection pairs the program's active samplers (GL order:
// tex_a, tex_b) to the WRONG layout entries → the texture units swap → the readback
// swaps (left=blue, right=red). A by-NAME reflection (getUniformLocation(name)) binds
// each sampler to its own unit → correct (left=red, right=blue). Running BOTH (names
// present vs names stripped) shows the name path is what fixes the multi-resource group.

const boolT = { kind: 'scalar', scalar: 'bool' } as unknown as ShaderType
const cmpLt = (a: Expr, b: Expr): Expr => ({ op: 'compare', type: boolT, cop: '<', a, b })
const sel = (cond: Expr, ifTrue: Expr, ifFalse: Expr): Expr => ({ op: 'select', type: vec4fT, cond, ifTrue, ifFalse })

const VsInP: StructDecl = { name: 'VsInP', fields: [
  { name: 'pos', type: vec2fT, attr: '@location(0)' },
  { name: 'uv', type: vec2fT, attr: '@location(1)' },
] }
const VsOutP: StructDecl = { name: 'VsOutP', fields: [
  { name: 'position', type: vec4fT, attr: '@builtin(position)' },
  { name: 'uv', type: vec2fT, attr: '@location(0)' },
] }
const FsOutP: StructDecl = { name: 'FsOutP', fields: [{ name: 'color', type: vec4fT, attr: '@location(0)' }] }

const inP = param('inp', structT('VsInP'))
const fsUv = fld(param('inp', structT('VsOutP')), 'uv', vec2fT)
const sampleA: Expr = { op: 'call', type: vec4fT, fn: 'textureSample', args: [varref('tex_a', texture2dfT), varref('samp', samplerT), fsUv] }
const sampleB: Expr = { op: 'call', type: vec4fT, fn: 'textureSample', args: [varref('tex_b', texture2dfT), varref('samp', samplerT), fsUv] }

const reflModule: ModuleDecl = {
  consts: [],
  structs: [VsInP, VsOutP, FsOutP],
  bindings: [
    { group: 0, binding: 0, name: 'tex_a', space: 'uniform', type: texture2dfT },
    { group: 0, binding: 1, name: 'tex_b', space: 'uniform', type: texture2dfT },
    { group: 0, binding: 2, name: 'samp', space: 'uniform', type: samplerT },
  ],
  funcs: [
    {
      name: 'vs', attrs: ['@vertex'],
      params: [{ name: 'inp', type: structT('VsInP') }], ret: structT('VsOutP'),
      body: [
        { s: 'var', name: 'o', type: structT('VsOutP') },
        { s: 'assign', target: fld(varref('o', structT('VsOutP')), 'position', vec4fT),
          expr: v4(fld(fld(inP, 'pos', vec2fT), 'x', f32T), fld(fld(inP, 'pos', vec2fT), 'y', f32T), lit(0), lit(1)) },
        { s: 'assign', target: fld(varref('o', structT('VsOutP')), 'uv', vec2fT), expr: fld(inP, 'uv', vec2fT) },
        { s: 'return', expr: varref('o', structT('VsOutP')) },
      ],
    },
    {
      name: 'fs', attrs: ['@fragment'],
      params: [{ name: 'inp', type: structT('VsOutP') }], ret: structT('FsOutP'),
      body: [{ s: 'return', expr: { op: 'construct', type: structT('FsOutP'),
        args: [sel(cmpLt(fld(fsUv, 'x', f32T), lit(0.5)), sampleA, sampleB)] } }],
    },
  ],
}

const RED = [255, 0, 0, 255]
const BLUE = [0, 0, 255, 255]

export interface Webgl2ReflectionResult {
  fatal?: string
  glError: number
  glNoError: number
  named: { left: number[]; right: number[] }   // name reflection → correct
  ordered: { left: number[]; right: number[] } // names stripped → by-order SWAPS
  expected: { left: number[]; right: number[] } // left=tex_a=red, right=tex_b=blue
}

export function runWebgl2ReflectionProof(): Webgl2ReflectionResult {
  const vsGlsl = emitGlslModule(reflModule, 'vertex')
  const fsGlsl = emitGlslModule(reflModule, 'fragment')
  const expected = { left: RED, right: BLUE }

  const SIZE = 64
  const canvas = document.createElement('canvas')
  canvas.width = SIZE; canvas.height = SIZE
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (!gl) return { fatal: 'no webgl2', glError: -1, glNoError: 0, named: { left: [], right: [] }, ordered: { left: [], right: [] }, expected }
  const device = new WebGl2Device(gl)

  const V = (px: number, py: number, u: number, v: number) => [px, py, u, v]
  const quad = new Float32Array([
    ...V(-1, -1, 0, 0), ...V(1, -1, 1, 0), ...V(-1, 1, 0, 1),
    ...V(-1, 1, 0, 1), ...V(1, -1, 1, 0), ...V(1, 1, 1, 1),
  ])
  const vbuf = device.createBuffer({ size: quad.byteLength, usage: 'vertex' })
  device.writeBuffer(vbuf, 0, quad)

  const mk1px = (rgba: number[]) => {
    const t = device.createTexture({ width: 1, height: 1, format: 'rgba8unorm', usage: ['sample', 'copy-dst'] })
    device.writeTexture(t, new Uint8Array(rgba), 4, 1, 1)
    return device.createView(t)
  }
  const viewA = mk1px(RED)
  const viewB = mk1px(BLUE)
  const samp = device.createSampler({ mag: 'nearest', min: 'nearest' })

  // texture layout entries in REVERSED declaration order (tex_b, tex_a) — the
  // construction that makes a by-order reflection mis-pair the active samplers.
  const namedEntries = [
    { binding: 1, kind: 'texture' as const, name: 'tex_b' },
    { binding: 0, kind: 'texture' as const, name: 'tex_a' },
    { binding: 2, kind: 'sampler' as const },
  ]
  const strippedEntries = namedEntries.map((e) => ({ binding: e.binding, kind: e.kind })) // no name → by-order

  const vbDesc = [{ stride: 16, attributes: [
    { location: 0, offset: 0, format: 'float32x2' },
    { location: 1, offset: 8, format: 'float32x2' },
  ] }]

  type LayoutEntry = { binding: number; kind: 'uniform' | 'texture' | 'sampler' | 'storage'; name?: string; dynamic?: boolean }
  const draw = (entries: LayoutEntry[]) => {
    const bgl = device.createBindGroupLayout(entries)
    const bg = device.createBindGroup(bgl, [
      { binding: 0, resource: { view: viewA } },
      { binding: 1, resource: { view: viewB } },
      { binding: 2, resource: { sampler: samp } },
    ])
    const pipeline = device.createPipeline({
      code: '', vsEntry: 'vs', fsEntry: 'fs', vsCode: vsGlsl, fsCode: fsGlsl,
      bindGroupLayouts: [bgl], colorTargets: [{ format: 'rgba8unorm', blend: 'none' }], vertexBuffers: vbDesc,
    })
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, SIZE, SIZE)
    gl.clearColor(1, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT)
    const pass = wrapWebGl2Pass(device)
    pass.setPipeline(pipeline); pass.setBindGroup(0, bg); pass.setVertexBuffer(0, vbuf); pass.draw(6)
    gl.flush()
    const px = new Uint8Array(SIZE * SIZE * 4)
    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const at = (x: number, y: number) => { const i = (y * SIZE + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]] }
    return { left: at(16, 32), right: at(48, 32) }
  }

  const named = draw(namedEntries)
  const ordered = draw(strippedEntries)
  return { glError: gl.getError(), glNoError: gl.NO_ERROR, named, ordered, expected }
}

// ═══ REAL DSL render shader on WebGL2 (US-003) ═══
//
// Renders the ACTUAL ?debug=overdraw compose shader (runtime overdrawComposeModule —
// fullscreen vertex_index triangle, textureLoad on the r16float overdraw accumulator,
// deterministic heat colormap) THROUGH WebGl2Device. Two controlled inputs give two
// verifiable outputs: an EMPTY accumulator (count 0 → the dark-navy "no fragments"
// branch vec4(0.02,0.02,0.04,1) = [5,5,10,255]) and a SATURATED one (count 16 → t=1 →
// colormap(1) = red [255,0,0,255]). No synthetic shader — this is a real renderer pass.

export interface Webgl2OverdrawResult {
  fatal?: string
  glError: number
  glNoError: number
  empty: number[]      // count 0  → expect dark navy
  full: number[]       // count 16 → expect red
  expectedEmpty: number[]
  expectedFull: number[]
}

// IEEE half-float bit patterns for the two test counts (avoids a float→half encoder).
const HALF_0 = 0x0000
const HALF_16 = 0x4c00

export function runWebgl2OverdrawProof(): Webgl2OverdrawResult {
  const vsGlsl = emitGlslModule(overdrawComposeModule, 'vertex')
  const fsGlsl = emitGlslModule(overdrawComposeModule, 'fragment')
  const expectedEmpty = [5, 5, 10, 255]
  const expectedFull = [255, 0, 0, 255]

  const SIZE = 32
  const canvas = document.createElement('canvas')
  canvas.width = SIZE; canvas.height = SIZE
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (!gl) return { fatal: 'no webgl2', glError: -1, glNoError: 0, empty: [], full: [], expectedEmpty, expectedFull }
  const device = new WebGl2Device(gl)

  // overdraw samples accum_tex via textureLoad (texelFetch) — texture binding, NO sampler.
  const bgl = device.createBindGroupLayout([{ binding: 0, kind: 'texture', name: 'accum_tex' }])
  const pipeline = device.createPipeline({
    code: '', vsEntry: 'vs_full', fsEntry: 'fs_compose', vsCode: vsGlsl, fsCode: fsGlsl,
    bindGroupLayouts: [bgl], colorTargets: [{ format: 'rgba8unorm', blend: 'none' }],
    // no vertexBuffers — the fullscreen triangle is generated from gl_VertexID.
  })

  const mkAccum = (halfBits: number) => {
    const t = device.createTexture({ width: 1, height: 1, format: 'r16float', usage: ['sample', 'copy-dst'] })
    device.writeTexture(t, new Uint16Array([halfBits]), 2, 1, 1)
    return device.createView(t)
  }

  const draw = (view: ReturnType<typeof device.createView>) => {
    const bg = device.createBindGroup(bgl, [{ binding: 0, resource: { view } }])
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, SIZE, SIZE)
    gl.clearColor(0, 1, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT) // green clear ≠ either expected
    const pass = wrapWebGl2Pass(device)
    pass.setPipeline(pipeline); pass.setBindGroup(0, bg); pass.draw(3) // fullscreen triangle
    gl.flush()
    const px = new Uint8Array(SIZE * SIZE * 4)
    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const i = (16 * SIZE + 16) * 4
    return [px[i], px[i + 1], px[i + 2], px[i + 3]]
  }

  const empty = draw(mkAccum(HALF_0))
  const full = draw(mkAccum(HALF_16))
  return { glError: gl.getError(), glNoError: gl.NO_ERROR, empty, full, expectedEmpty, expectedFull }
}

// ═══ STORAGE → data-texture emulation render proof (parked-ralph US-003) ═══
//
// Proves the WebGL2 fallback can read a STORAGE buffer (point/line/heatmap feat_data) —
// which GLSL ES 3.00 has no SSBO for — via the data-texture emulation. A storage
// `array<f32>` is emitted (emulateStorage) as a sampler2D data texture; the fs reads
// data[i] (i from screen region) → texelFetch. data=[0.25,0.5,0.75,1.0]; left/mid/right
// thirds read index 0/1/2 → grey 0.25/0.5/0.75. Renders THROUGH WebGl2Device + readback.
const arrF32S = { kind: 'array', elem: f32T } as unknown as ShaderType
const VsInS: StructDecl = { name: 'VsInS', fields: [
  { name: 'pos', type: vec2fT, attr: '@location(0)' }, { name: 'uv', type: vec2fT, attr: '@location(1)' },
] }
const VsOutS: StructDecl = { name: 'VsOutS', fields: [
  { name: 'position', type: vec4fT, attr: '@builtin(position)' }, { name: 'uv', type: vec2fT, attr: '@location(0)' },
] }
const FsOutS: StructDecl = { name: 'FsOutS', fields: [{ name: 'color', type: vec4fT, attr: '@location(0)' }] }
const inpS = param('inp', structT('VsInS'))
const fsUvS = fld(param('inp', structT('VsOutS')), 'uv', vec2fT)
const idxS: Expr = { op: 'binop', type: f32T, bop: '*', a: fld(fsUvS, 'x', f32T), b: lit(3) } // uv.x * 3 → region 0/1/2
const readC: Expr = { op: 'index', type: f32T, base: varref('data', arrF32S), idx: idxS } // data[idx] → storageFetchF32

const storageMod: ModuleDecl = {
  consts: [], structs: [VsInS, VsOutS, FsOutS],
  bindings: [{ group: 0, binding: 0, name: 'data', space: 'storage', access: 'read', type: arrF32S }],
  funcs: [
    {
      name: 'vs', attrs: ['@vertex'], params: [{ name: 'inp', type: structT('VsInS') }], ret: structT('VsOutS'),
      body: [
        { s: 'var', name: 'o', type: structT('VsOutS') },
        { s: 'assign', target: fld(varref('o', structT('VsOutS')), 'position', vec4fT),
          expr: v4(fld(fld(inpS, 'pos', vec2fT), 'x', f32T), fld(fld(inpS, 'pos', vec2fT), 'y', f32T), lit(0), lit(1)) },
        { s: 'assign', target: fld(varref('o', structT('VsOutS')), 'uv', vec2fT), expr: fld(inpS, 'uv', vec2fT) },
        { s: 'return', expr: varref('o', structT('VsOutS')) },
      ],
    },
    {
      name: 'fs', attrs: ['@fragment'], params: [{ name: 'inp', type: structT('VsOutS') }], ret: structT('FsOutS'),
      body: [{ s: 'return', expr: { op: 'construct', type: structT('FsOutS'), args: [v4(readC, readC, readC, lit(1))] } }],
    },
  ],
}

export interface Webgl2StorageResult {
  fatal?: string
  glError: number
  glNoError: number
  left: number[]; mid: number[]; right: number[]   // grey value per region
  expected: { left: number; mid: number; right: number } // 0.25/0.5/0.75 → ~64/128/191
  fsGlsl: string
}

export function runWebgl2StorageProof(): Webgl2StorageResult {
  const vsGlsl = emitGlslModule(storageMod, 'vertex', { emulateStorage: true })
  const fsGlsl = emitGlslModule(storageMod, 'fragment', { emulateStorage: true })
  const expected = { left: 64, mid: 128, right: 191 }

  const SIZE = 64
  const canvas = document.createElement('canvas')
  canvas.width = SIZE; canvas.height = SIZE
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (!gl) return { fatal: 'no webgl2', glError: -1, glNoError: 0, left: [], mid: [], right: [], expected, fsGlsl }
  const device = new WebGl2Device(gl)

  const V = (px: number, py: number, u: number, v: number) => [px, py, u, v]
  const quad = new Float32Array([
    ...V(-1, -1, 0, 0), ...V(1, -1, 1, 0), ...V(-1, 1, 0, 1),
    ...V(-1, 1, 0, 1), ...V(1, -1, 1, 0), ...V(1, 1, 1, 1),
  ])
  const vbuf = device.createBuffer({ size: quad.byteLength, usage: 'vertex' })
  device.writeBuffer(vbuf, 0, quad)

  // the STORAGE buffer (4 f32) → a data texture.
  const arr = new Float32Array([0.25, 0.5, 0.75, 1.0])
  const sbuf = device.createBuffer({ size: arr.byteLength, usage: 'storage' })
  device.writeBuffer(sbuf, 0, arr)

  const bgl = device.createBindGroupLayout([{ binding: 0, kind: 'storage', name: 'data' }])
  const bg = device.createBindGroup(bgl, [{ binding: 0, resource: { buffer: sbuf } }])
  const pipeline = device.createPipeline({
    code: '', vsEntry: 'vs', fsEntry: 'fs', vsCode: vsGlsl, fsCode: fsGlsl,
    bindGroupLayouts: [bgl], colorTargets: [{ format: 'rgba8unorm', blend: 'none' }],
    vertexBuffers: [{ stride: 16, attributes: [
      { location: 0, offset: 0, format: 'float32x2' }, { location: 1, offset: 8, format: 'float32x2' },
    ] }],
  })

  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.viewport(0, 0, SIZE, SIZE)
  gl.clearColor(1, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT)
  const pass = wrapWebGl2Pass(device)
  pass.setPipeline(pipeline); pass.setBindGroup(0, bg); pass.setVertexBuffer(0, vbuf); pass.draw(6)
  gl.flush()
  const px = new Uint8Array(SIZE * SIZE * 4)
  gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px)
  const at = (x: number) => { const i = (32 * SIZE + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]] }
  return { glError: gl.getError(), glNoError: gl.NO_ERROR, left: at(10), mid: at(32), right: at(53), expected, fsGlsl }
}

// ═══ MULTI-STORAGE on WebGL2 (storage arc — point binds 3 storage buffers) ═══
//
// The single-storage proof read ONE array. The real point/line shaders bind MULTIPLE
// storage buffers (feat_data / shapes / segments). This proves two independent storage
// array<f32> bindings each become their OWN data texture, bound to distinct units +
// reflected BY NAME: data_a[0] → R, data_b[0] → G. data_a=[0.3], data_b=[0.6] →
// readback [76,153,0,255]. A swapped/missed binding would put the wrong value in a channel.
const VsInM = VsInS, VsOutM = VsOutS // reuse the storage proof's IO structs
const FsOutM: StructDecl = { name: 'FsOutM', fields: [{ name: 'color', type: vec4fT, attr: '@location(0)' }] }
const readA: Expr = { op: 'index', type: f32T, base: varref('data_a', arrF32S), idx: lit(0) }
const readB: Expr = { op: 'index', type: f32T, base: varref('data_b', arrF32S), idx: lit(0) }

const multiStorageMod: ModuleDecl = {
  consts: [], structs: [VsInM, VsOutM, FsOutM],
  bindings: [
    { group: 0, binding: 0, name: 'data_a', space: 'storage', access: 'read', type: arrF32S },
    { group: 0, binding: 1, name: 'data_b', space: 'storage', access: 'read', type: arrF32S },
  ],
  funcs: [
    {
      name: 'vs', attrs: ['@vertex'], params: [{ name: 'inp', type: structT('VsInS') }], ret: structT('VsOutS'),
      body: [
        { s: 'var', name: 'o', type: structT('VsOutS') },
        { s: 'assign', target: fld(varref('o', structT('VsOutS')), 'position', vec4fT),
          expr: v4(fld(fld(inpS, 'pos', vec2fT), 'x', f32T), fld(fld(inpS, 'pos', vec2fT), 'y', f32T), lit(0), lit(1)) },
        { s: 'assign', target: fld(varref('o', structT('VsOutS')), 'uv', vec2fT), expr: fld(inpS, 'uv', vec2fT) },
        { s: 'return', expr: varref('o', structT('VsOutS')) },
      ],
    },
    {
      name: 'fs', attrs: ['@fragment'], params: [{ name: 'inp', type: structT('VsOutS') }], ret: structT('FsOutM'),
      body: [{ s: 'return', expr: { op: 'construct', type: structT('FsOutM'), args: [v4(readA, readB, lit(0), lit(1))] } }],
    },
  ],
}

export interface Webgl2MultiStorageResult {
  fatal?: string; glError: number; glNoError: number
  px: number[]; expected: number[] // [R from data_a, G from data_b, 0, 255]
}

export function runWebgl2MultiStorageProof(): Webgl2MultiStorageResult {
  const vsGlsl = emitGlslModule(multiStorageMod, 'vertex', { emulateStorage: true })
  const fsGlsl = emitGlslModule(multiStorageMod, 'fragment', { emulateStorage: true })
  const expected = [76, 153, 0, 255] // 0.3→76, 0.6→153

  const SIZE = 32
  const canvas = document.createElement('canvas'); canvas.width = SIZE; canvas.height = SIZE
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (!gl) return { fatal: 'no webgl2', glError: -1, glNoError: 0, px: [], expected }
  const device = new WebGl2Device(gl)

  const V = (px: number, py: number, u: number, v: number) => [px, py, u, v]
  const quad = new Float32Array([...V(-1, -1, 0, 0), ...V(1, -1, 1, 0), ...V(-1, 1, 0, 1), ...V(-1, 1, 0, 1), ...V(1, -1, 1, 0), ...V(1, 1, 1, 1)])
  const vbuf = device.createBuffer({ size: quad.byteLength, usage: 'vertex' }); device.writeBuffer(vbuf, 0, quad)

  const mkStorage = (vals: number[]) => {
    const a = new Float32Array(vals); const b = device.createBuffer({ size: a.byteLength, usage: 'storage' }); device.writeBuffer(b, 0, a); return b
  }
  const sa = mkStorage([0.3]); const sb = mkStorage([0.6])
  const bgl = device.createBindGroupLayout([
    { binding: 0, kind: 'storage', name: 'data_a' }, { binding: 1, kind: 'storage', name: 'data_b' },
  ])
  const bg = device.createBindGroup(bgl, [
    { binding: 0, resource: { buffer: sa } }, { binding: 1, resource: { buffer: sb } },
  ])
  const pipeline = device.createPipeline({
    code: '', vsEntry: 'vs', fsEntry: 'fs', vsCode: vsGlsl, fsCode: fsGlsl,
    bindGroupLayouts: [bgl], colorTargets: [{ format: 'rgba8unorm', blend: 'none' }],
    vertexBuffers: [{ stride: 16, attributes: [{ location: 0, offset: 0, format: 'float32x2' }, { location: 1, offset: 8, format: 'float32x2' }] }],
  })
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, SIZE, SIZE)
  gl.clearColor(1, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT)
  const pass = wrapWebGl2Pass(device)
  pass.setPipeline(pipeline); pass.setBindGroup(0, bg); pass.setVertexBuffer(0, vbuf); pass.draw(6); gl.flush()
  const buf = new Uint8Array(SIZE * SIZE * 4); gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  const i = (16 * SIZE + 16) * 4
  return { glError: gl.getError(), glNoError: gl.NO_ERROR, px: [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]], expected }
}

// ═══ BITCAST-u32 lane from storage (the REAL feat_data read pattern) ═══
//
// Real point/heatmap feat_data is array<f32> but several lanes are u32 values packed via
// bitcast (quad_id, indices). KEY RISK: a small-int u32 packed as f32 bits is a DENORMAL;
// if a GPU flushes denormals on R32F texture load, bitcast<u32> recovers GARBAGE → the
// data-texture emulation would need an R32UI/usampler2D path for u32 lanes. This PROVES or
// REFUTES it: lane0 = 0xC0DE1234 (a NORMAL float's bits, low byte 0x34=52), lane1 = 200
// (a DENORMAL: bits 0x000000C8, low byte 0xC8=200). Read bitcast<u32>(data[i]) & 0xFF → R/G.
// Expect [52, 200]. If G != 200, the denormal was flushed → R32UI needed (a real finding).
const u32lit = (value: number): Expr => ({ op: 'lit', type: u32T, value })
const bcLane = (i: number): Expr => {
  const read: Expr = { op: 'index', type: f32T, base: varref('data', arrF32S), idx: lit(i) }
  const u: Expr = { op: 'call', type: u32T, fn: 'bitcastU32', args: [read] }
  const byte: Expr = { op: 'binop', type: u32T, bop: '&', a: u, b: u32lit(0xFF) }
  return { op: 'binop', type: f32T, bop: '/', a: { op: 'call', type: f32T, fn: 'f32', args: [byte] }, b: lit(255) }
}
const FsOutB: StructDecl = { name: 'FsOutB', fields: [{ name: 'color', type: vec4fT, attr: '@location(0)' }] }
const bitcastMod: ModuleDecl = {
  consts: [], structs: [VsInS, VsOutS, FsOutB],
  bindings: [{ group: 0, binding: 0, name: 'data', space: 'storage', access: 'read', type: arrF32S }],
  funcs: [
    {
      name: 'vs', attrs: ['@vertex'], params: [{ name: 'inp', type: structT('VsInS') }], ret: structT('VsOutS'),
      body: [
        { s: 'var', name: 'o', type: structT('VsOutS') },
        { s: 'assign', target: fld(varref('o', structT('VsOutS')), 'position', vec4fT),
          expr: v4(fld(fld(inpS, 'pos', vec2fT), 'x', f32T), fld(fld(inpS, 'pos', vec2fT), 'y', f32T), lit(0), lit(1)) },
        { s: 'assign', target: fld(varref('o', structT('VsOutS')), 'uv', vec2fT), expr: fld(inpS, 'uv', vec2fT) },
        { s: 'return', expr: varref('o', structT('VsOutS')) },
      ],
    },
    {
      name: 'fs', attrs: ['@fragment'], params: [{ name: 'inp', type: structT('VsOutS') }], ret: structT('FsOutB'),
      body: [{ s: 'return', expr: { op: 'construct', type: structT('FsOutB'), args: [v4(bcLane(0), bcLane(1), lit(0), lit(1))] } }],
    },
  ],
}

export interface Webgl2BitcastResult {
  fatal?: string; glError: number; glNoError: number
  px: number[]; expected: number[]; fsGlsl: string
}

export function runWebgl2BitcastProof(): Webgl2BitcastResult {
  const vsGlsl = emitGlslModule(bitcastMod, 'vertex', { emulateStorage: true })
  const fsGlsl = emitGlslModule(bitcastMod, 'fragment', { emulateStorage: true })
  const expected = [52, 200, 0, 255] // lane0 low byte 0x34, lane1 (denormal) low byte 0xC8

  const SIZE = 32
  const canvas = document.createElement('canvas'); canvas.width = SIZE; canvas.height = SIZE
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (!gl) return { fatal: 'no webgl2', glError: -1, glNoError: 0, px: [], expected, fsGlsl }
  const device = new WebGl2Device(gl)

  const V = (px: number, py: number, u: number, v: number) => [px, py, u, v]
  const quad = new Float32Array([...V(-1, -1, 0, 0), ...V(1, -1, 1, 0), ...V(-1, 1, 0, 1), ...V(-1, 1, 0, 1), ...V(1, -1, 1, 0), ...V(1, 1, 1, 1)])
  const vbuf = device.createBuffer({ size: quad.byteLength, usage: 'vertex' }); device.writeBuffer(vbuf, 0, quad)

  // pack two u32 lane values as their f32 bit-patterns (CPU writes u32 bits; shader bitcasts back).
  const bits = new Uint32Array([0xC0DE1234, 0x000000C8])
  const arr = new Float32Array(bits.buffer)
  const sbuf = device.createBuffer({ size: arr.byteLength, usage: 'storage' }); device.writeBuffer(sbuf, 0, arr)

  const bgl = device.createBindGroupLayout([{ binding: 0, kind: 'storage', name: 'data' }])
  const bg = device.createBindGroup(bgl, [{ binding: 0, resource: { buffer: sbuf } }])
  const pipeline = device.createPipeline({
    code: '', vsEntry: 'vs', fsEntry: 'fs', vsCode: vsGlsl, fsCode: fsGlsl,
    bindGroupLayouts: [bgl], colorTargets: [{ format: 'rgba8unorm', blend: 'none' }],
    vertexBuffers: [{ stride: 16, attributes: [{ location: 0, offset: 0, format: 'float32x2' }, { location: 1, offset: 8, format: 'float32x2' }] }],
  })
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, SIZE, SIZE)
  gl.clearColor(1, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT)
  const pass = wrapWebGl2Pass(device)
  pass.setPipeline(pipeline); pass.setBindGroup(0, bg); pass.setVertexBuffer(0, vbuf); pass.draw(6); gl.flush()
  const b = new Uint8Array(SIZE * SIZE * 4); gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, b)
  const i = (16 * SIZE + 16) * 4
  return { glError: gl.getError(), glNoError: gl.NO_ERROR, px: [b[i], b[i + 1], b[i + 2], b[i + 3]], expected, fsGlsl }
}

// ═══ 2D-TILED storage data texture (>maxTextureSize wraps across rows) — US-001 ═══
//
// The 1-row data texture caps an array at maxTextureSize. A real feat_data buffer can be
// larger, so storageFetchF32 maps i → (i % W, i / W) and the device tiles W×ceil(N/W). This
// proves a multi-ROW read: a 3000-float array (W=2048 → 2 rows). data[100] (row 0) → R,
// data[2500] (row 1, col 452) → G. data[100]=0.3, data[2500]=0.6 → readback [76,153,0,255].
const FsOutT: StructDecl = { name: 'FsOutT', fields: [{ name: 'color', type: vec4fT, attr: '@location(0)' }] }
const readAt = (i: number): Expr => ({ op: 'index', type: f32T, base: varref('data', arrF32S), idx: lit(i) })
const tiledMod: ModuleDecl = {
  consts: [], structs: [VsInS, VsOutS, FsOutT],
  bindings: [{ group: 0, binding: 0, name: 'data', space: 'storage', access: 'read', type: arrF32S }],
  funcs: [
    {
      name: 'vs', attrs: ['@vertex'], params: [{ name: 'inp', type: structT('VsInS') }], ret: structT('VsOutS'),
      body: [
        { s: 'var', name: 'o', type: structT('VsOutS') },
        { s: 'assign', target: fld(varref('o', structT('VsOutS')), 'position', vec4fT),
          expr: v4(fld(fld(inpS, 'pos', vec2fT), 'x', f32T), fld(fld(inpS, 'pos', vec2fT), 'y', f32T), lit(0), lit(1)) },
        { s: 'assign', target: fld(varref('o', structT('VsOutS')), 'uv', vec2fT), expr: fld(inpS, 'uv', vec2fT) },
        { s: 'return', expr: varref('o', structT('VsOutS')) },
      ],
    },
    {
      name: 'fs', attrs: ['@fragment'], params: [{ name: 'inp', type: structT('VsOutS') }], ret: structT('FsOutT'),
      body: [{ s: 'return', expr: { op: 'construct', type: structT('FsOutT'), args: [v4(readAt(100), readAt(2500), lit(0), lit(1))] } }],
    },
  ],
}

export interface Webgl2TiledResult { fatal?: string; glError: number; glNoError: number; px: number[]; expected: number[] }

export function runWebgl2TiledStorageProof(): Webgl2TiledResult {
  const vsGlsl = emitGlslModule(tiledMod, 'vertex', { emulateStorage: true })
  const fsGlsl = emitGlslModule(tiledMod, 'fragment', { emulateStorage: true })
  const expected = [76, 153, 0, 255] // data[100]=0.3→76, data[2500]=0.6→153

  const SIZE = 32
  const canvas = document.createElement('canvas'); canvas.width = SIZE; canvas.height = SIZE
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (!gl) return { fatal: 'no webgl2', glError: -1, glNoError: 0, px: [], expected }
  const device = new WebGl2Device(gl)
  const V = (px: number, py: number, u: number, v: number) => [px, py, u, v]
  const quad = new Float32Array([...V(-1, -1, 0, 0), ...V(1, -1, 1, 0), ...V(-1, 1, 0, 1), ...V(-1, 1, 0, 1), ...V(1, -1, 1, 0), ...V(1, 1, 1, 1)])
  const vbuf = device.createBuffer({ size: quad.byteLength, usage: 'vertex' }); device.writeBuffer(vbuf, 0, quad)

  const arr = new Float32Array(3000) // > 2048 → 2 rows at W=2048
  arr[100] = 0.3; arr[2500] = 0.6
  const sbuf = device.createBuffer({ size: arr.byteLength, usage: 'storage' }); device.writeBuffer(sbuf, 0, arr)

  const bgl = device.createBindGroupLayout([{ binding: 0, kind: 'storage', name: 'data' }])
  const bg = device.createBindGroup(bgl, [{ binding: 0, resource: { buffer: sbuf } }])
  const pipeline = device.createPipeline({
    code: '', vsEntry: 'vs', fsEntry: 'fs', vsCode: vsGlsl, fsCode: fsGlsl,
    bindGroupLayouts: [bgl], colorTargets: [{ format: 'rgba8unorm', blend: 'none' }],
    vertexBuffers: [{ stride: 16, attributes: [{ location: 0, offset: 0, format: 'float32x2' }, { location: 1, offset: 8, format: 'float32x2' }] }],
  })
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, SIZE, SIZE)
  gl.clearColor(1, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT)
  const pass = wrapWebGl2Pass(device)
  pass.setPipeline(pipeline); pass.setBindGroup(0, bg); pass.setVertexBuffer(0, vbuf); pass.draw(6); gl.flush()
  const b = new Uint8Array(SIZE * SIZE * 4); gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, b)
  const i = (16 * SIZE + 16) * 4
  return { glError: gl.getError(), glNoError: gl.NO_ERROR, px: [b[i], b[i + 1], b[i + 2], b[i + 3]], expected }
}

// ═══ STRIDED multi-lane storage read (the real feat_data[base*STRIDE+lane]) — US-002 ═══
//
// point/heatmap read feat_data at a COMPUTED stride: feat_data[featIndex*STRIDE + lane]. The
// storage index is thus a runtime expression, not a constant. This proves it: base = u32(uv.x*2)
// (screen half → feature 0/1), index = base*STRIDE(4) + lane(2). Left → data[0*4+2]=data[2]=0.4→102;
// right → data[1*4+2]=data[6]=0.7→179. A broken stride/truncation reads the wrong lane.
const stUvX = fld(param('inp', structT('VsOutS')), 'uv', vec2fT)
const stBaseF: Expr = { op: 'binop', type: f32T, bop: '*', a: fld(stUvX, 'x', f32T), b: lit(2) } // uv.x*2 ∈ [0,2)
const stBaseU: Expr = { op: 'call', type: u32T, fn: 'u32', args: [stBaseF] }                     // u32() truncates → 0/1
const stStrided: Expr = { op: 'binop', type: u32T, bop: '*', a: stBaseU, b: u32lit(4) }           // base*STRIDE
const stIdx: Expr = { op: 'binop', type: u32T, bop: '+', a: stStrided, b: u32lit(2) }             // + lane
const stRead: Expr = { op: 'index', type: f32T, base: varref('data', arrF32S), idx: stIdx }
const FsOutSt: StructDecl = { name: 'FsOutSt', fields: [{ name: 'color', type: vec4fT, attr: '@location(0)' }] }
const stridedMod: ModuleDecl = {
  consts: [], structs: [VsInS, VsOutS, FsOutSt],
  bindings: [{ group: 0, binding: 0, name: 'data', space: 'storage', access: 'read', type: arrF32S }],
  funcs: [
    {
      name: 'vs', attrs: ['@vertex'], params: [{ name: 'inp', type: structT('VsInS') }], ret: structT('VsOutS'),
      body: [
        { s: 'var', name: 'o', type: structT('VsOutS') },
        { s: 'assign', target: fld(varref('o', structT('VsOutS')), 'position', vec4fT),
          expr: v4(fld(fld(inpS, 'pos', vec2fT), 'x', f32T), fld(fld(inpS, 'pos', vec2fT), 'y', f32T), lit(0), lit(1)) },
        { s: 'assign', target: fld(varref('o', structT('VsOutS')), 'uv', vec2fT), expr: fld(inpS, 'uv', vec2fT) },
        { s: 'return', expr: varref('o', structT('VsOutS')) },
      ],
    },
    {
      name: 'fs', attrs: ['@fragment'], params: [{ name: 'inp', type: structT('VsOutS') }], ret: structT('FsOutSt'),
      body: [{ s: 'return', expr: { op: 'construct', type: structT('FsOutSt'), args: [v4(stRead, stRead, stRead, lit(1))] } }],
    },
  ],
}

export interface Webgl2StridedResult { fatal?: string; glError: number; glNoError: number; left: number[]; right: number[]; expected: { left: number; right: number } }

export function runWebgl2StridedProof(): Webgl2StridedResult {
  const vsGlsl = emitGlslModule(stridedMod, 'vertex', { emulateStorage: true })
  const fsGlsl = emitGlslModule(stridedMod, 'fragment', { emulateStorage: true })
  const expected = { left: 102, right: 179 } // data[2]=0.4→102, data[6]=0.7→179

  const SIZE = 64
  const canvas = document.createElement('canvas'); canvas.width = SIZE; canvas.height = SIZE
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (!gl) return { fatal: 'no webgl2', glError: -1, glNoError: 0, left: [], right: [], expected }
  const device = new WebGl2Device(gl)
  const V = (px: number, py: number, u: number, v: number) => [px, py, u, v]
  const quad = new Float32Array([...V(-1, -1, 0, 0), ...V(1, -1, 1, 0), ...V(-1, 1, 0, 1), ...V(-1, 1, 0, 1), ...V(1, -1, 1, 0), ...V(1, 1, 1, 1)])
  const vbuf = device.createBuffer({ size: quad.byteLength, usage: 'vertex' }); device.writeBuffer(vbuf, 0, quad)

  const arr = new Float32Array(8); arr[2] = 0.4; arr[6] = 0.7 // feature0 lane2 = idx2; feature1(base*4) lane2 = idx6
  const sbuf = device.createBuffer({ size: arr.byteLength, usage: 'storage' }); device.writeBuffer(sbuf, 0, arr)
  const bgl = device.createBindGroupLayout([{ binding: 0, kind: 'storage', name: 'data' }])
  const bg = device.createBindGroup(bgl, [{ binding: 0, resource: { buffer: sbuf } }])
  const pipeline = device.createPipeline({
    code: '', vsEntry: 'vs', fsEntry: 'fs', vsCode: vsGlsl, fsCode: fsGlsl,
    bindGroupLayouts: [bgl], colorTargets: [{ format: 'rgba8unorm', blend: 'none' }],
    vertexBuffers: [{ stride: 16, attributes: [{ location: 0, offset: 0, format: 'float32x2' }, { location: 1, offset: 8, format: 'float32x2' }] }],
  })
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, SIZE, SIZE)
  gl.clearColor(1, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT)
  const pass = wrapWebGl2Pass(device)
  pass.setPipeline(pipeline); pass.setBindGroup(0, bg); pass.setVertexBuffer(0, vbuf); pass.draw(6); gl.flush()
  const b = new Uint8Array(SIZE * SIZE * 4); gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, b)
  const at = (x: number) => { const i = (32 * SIZE + x) * 4; return [b[i], b[i + 1], b[i + 2], b[i + 3]] }
  return { glError: gl.getError(), glNoError: gl.NO_ERROR, left: at(16), right: at(48), expected }
}

// ═══ REAL point shader storage emit attempt (US-003 — honest gap probe) ═══
export function pointEmitAttempt(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const stage of ['vertex', 'fragment'] as const) {
    try { const s = emitGlslModule(buildPointModule(), stage, { emulateStorage: true }); out[stage] = `OK (${s.length} chars)` }
    catch (e) { out[stage] = 'THROW: ' + (e as Error).message }
  }
  return out
}

// ═══ array<Struct> storage scalar-field read (the real shapes/segments path) — US-005 ═══
//
// shapes/segments are array<Struct>. A read items[i].field lowers to storageFetchF32 at
// i*STRIDE + the field's std430 lane. Struct Item { id:u32, val:f32 } → stride 2 lanes
// (id@0, val@1). items=[{*,0.4},{*,0.7}]. fs reads items[u32(uv.x*2)].val: left → items[0].val
// (lane 0*2+1=1)=0.4→102; right → items[1].val (lane 1*2+1=3)=0.7→179. Proves the struct-lane math.
const ItemS: StructDecl = { name: 'Item', fields: [{ name: 'id', type: u32T }, { name: 'val', type: f32T }] }
const arrItemS = { kind: 'array', elem: structT('Item') } as unknown as ShaderType
const ssUvX = fld(fld(param('inp', structT('VsOutS')), 'uv', vec2fT), 'x', f32T)
const ssBaseF: Expr = { op: 'binop', type: f32T, bop: '*', a: ssUvX, b: lit(2) }
const ssBaseU: Expr = { op: 'call', type: u32T, fn: 'u32', args: [ssBaseF] }
const ssIndex: Expr = { op: 'index', type: structT('Item'), base: varref('items', arrItemS), idx: ssBaseU }
const ssRead: Expr = { op: 'member', type: f32T, base: ssIndex, field: 'val' }
const FsOutSs: StructDecl = { name: 'FsOutSs', fields: [{ name: 'color', type: vec4fT, attr: '@location(0)' }] }
const structStorageMod: ModuleDecl = {
  consts: [], structs: [ItemS, VsInS, VsOutS, FsOutSs],
  bindings: [{ group: 0, binding: 0, name: 'items', space: 'storage', access: 'read', type: arrItemS }],
  funcs: [
    {
      name: 'vs', attrs: ['@vertex'], params: [{ name: 'inp', type: structT('VsInS') }], ret: structT('VsOutS'),
      body: [
        { s: 'var', name: 'o', type: structT('VsOutS') },
        { s: 'assign', target: fld(varref('o', structT('VsOutS')), 'position', vec4fT),
          expr: v4(fld(fld(inpS, 'pos', vec2fT), 'x', f32T), fld(fld(inpS, 'pos', vec2fT), 'y', f32T), lit(0), lit(1)) },
        { s: 'assign', target: fld(varref('o', structT('VsOutS')), 'uv', vec2fT), expr: fld(inpS, 'uv', vec2fT) },
        { s: 'return', expr: varref('o', structT('VsOutS')) },
      ],
    },
    {
      name: 'fs', attrs: ['@fragment'], params: [{ name: 'inp', type: structT('VsOutS') }], ret: structT('FsOutSs'),
      body: [{ s: 'return', expr: { op: 'construct', type: structT('FsOutSs'), args: [v4(ssRead, ssRead, ssRead, lit(1))] } }],
    },
  ],
}

export interface Webgl2StructStorageResult { fatal?: string; glError: number; glNoError: number; left: number[]; right: number[]; expected: { left: number; right: number }; fsGlsl: string }

export function runWebgl2StructStorageProof(): Webgl2StructStorageResult {
  let vsGlsl = '', fsGlsl = ''
  try { vsGlsl = emitGlslModule(structStorageMod, 'vertex', { emulateStorage: true }); fsGlsl = emitGlslModule(structStorageMod, 'fragment', { emulateStorage: true }) }
  catch (e) { return { fatal: 'emit: ' + (e as Error).message, glError: -1, glNoError: 0, left: [], right: [], expected: { left: 102, right: 179 }, fsGlsl } }
  const expected = { left: 102, right: 179 }

  const SIZE = 64
  const canvas = document.createElement('canvas'); canvas.width = SIZE; canvas.height = SIZE
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (!gl) return { fatal: 'no webgl2', glError: -1, glNoError: 0, left: [], right: [], expected, fsGlsl }
  const device = new WebGl2Device(gl)
  const V = (px: number, py: number, u: number, v: number) => [px, py, u, v]
  const quad = new Float32Array([...V(-1, -1, 0, 0), ...V(1, -1, 1, 0), ...V(-1, 1, 0, 1), ...V(-1, 1, 0, 1), ...V(1, -1, 1, 0), ...V(1, 1, 1, 1)])
  const vbuf = device.createBuffer({ size: quad.byteLength, usage: 'vertex' }); device.writeBuffer(vbuf, 0, quad)

  // std430: Item = {id@lane0, val@lane1}, stride 2. items[0].val=lane1, items[1].val=lane3.
  const arr = new Float32Array(4); arr[1] = 0.4; arr[3] = 0.7
  const sbuf = device.createBuffer({ size: arr.byteLength, usage: 'storage' }); device.writeBuffer(sbuf, 0, arr)
  const bgl = device.createBindGroupLayout([{ binding: 0, kind: 'storage', name: 'items' }])
  const bg = device.createBindGroup(bgl, [{ binding: 0, resource: { buffer: sbuf } }])
  const pipeline = device.createPipeline({
    code: '', vsEntry: 'vs', fsEntry: 'fs', vsCode: vsGlsl, fsCode: fsGlsl,
    bindGroupLayouts: [bgl], colorTargets: [{ format: 'rgba8unorm', blend: 'none' }],
    vertexBuffers: [{ stride: 16, attributes: [{ location: 0, offset: 0, format: 'float32x2' }, { location: 1, offset: 8, format: 'float32x2' }] }],
  })
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, SIZE, SIZE)
  gl.clearColor(1, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT)
  const pass = wrapWebGl2Pass(device)
  pass.setPipeline(pipeline); pass.setBindGroup(0, bg); pass.setVertexBuffer(0, vbuf); pass.draw(6); gl.flush()
  const b = new Uint8Array(SIZE * SIZE * 4); gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, b)
  const at = (x: number) => { const i = (32 * SIZE + x) * 4; return [b[i], b[i + 1], b[i + 2], b[i + 3]] }
  return { glError: gl.getError(), glNoError: gl.NO_ERROR, left: at(16), right: at(48), expected, fsGlsl }
}

// ═══ REAL point shader COMPILE+LINK on WebGL2 (US-006 capstone) ═══
export interface PointLinkResult { emitVs: string; emitFs: string; vsCompile: boolean; fsCompile: boolean; link: boolean; log: string }
export function pointLinkAttempt(): PointLinkResult {
  let vsSrc = '', fsSrc = ''
  try { vsSrc = emitGlslModule(buildPointModule(), 'vertex', { emulateStorage: true }); fsSrc = emitGlslModule(buildPointModule(), 'fragment', { emulateStorage: true }) }
  catch (e) { return { emitVs: 'THROW: ' + (e as Error).message, emitFs: '', vsCompile: false, fsCompile: false, link: false, log: 'emit threw' } }
  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) return { emitVs: 'ok', emitFs: 'ok', vsCompile: false, fsCompile: false, link: false, log: 'no webgl2' }
  const compile = (type: number, src: string) => { const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh); return { ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean, log: gl.getShaderInfoLog(sh) ?? '', sh } }
  const vs = compile(gl.VERTEX_SHADER, vsSrc), fs = compile(gl.FRAGMENT_SHADER, fsSrc)
  let link = false, log = ''
  if (!vs.ok) log = 'VS: ' + vs.log.slice(0, 400)
  else if (!fs.ok) log = 'FS: ' + fs.log.slice(0, 400)
  else { const p = gl.createProgram()!; gl.attachShader(p, vs.sh); gl.attachShader(p, fs.sh); gl.linkProgram(p); link = gl.getProgramParameter(p, gl.LINK_STATUS) as boolean; if (!link) log = 'LINK: ' + (gl.getProgramInfoLog(p) ?? '').slice(0, 400) }
  return { emitVs: `ok ${vsSrc.length}`, emitFs: `ok ${fsSrc.length}`, vsCompile: vs.ok, fsCompile: fs.ok, link, log }
}

// ═══ The generic Material + executeItems render on WebGl2Device (render-loop US-002/003) ═══
//
// Proves the COMMITTED render-layer abstraction (Material + DrawItem + executeItems — the path
// raster/point/line/text/icon/heatmap Drapers all flow through) builds + draws on WebGl2Device,
// not just the raw RHI. Routes the checker texture-sampling module through a real Material
// (global uniform + a 1-group uniform/texture/sampler layout) + executeItems; readback matches.
export interface Webgl2MaterialResult {
  fatal?: string; glError: number; glNoError: number
  bottomLeft: number[]; bottomRight: number[]; topLeft: number[]; topRight: number[]
  expected: { bottomLeft: number[]; bottomRight: number[]; topLeft: number[]; topRight: number[] }
}
export function runWebgl2MaterialProof(): Webgl2MaterialResult {
  const vsGlsl = emitGlslModule(module, 'vertex')
  const fsGlsl = emitGlslModule(module, 'fragment')
  const expected = { bottomLeft: TEXELS.BL, bottomRight: TEXELS.BR, topLeft: TEXELS.TL, topRight: TEXELS.TR }
  const SIZE = 64
  const canvas = document.createElement('canvas'); canvas.width = SIZE; canvas.height = SIZE
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (!gl) return { fatal: 'no webgl2', glError: -1, glNoError: 0, bottomLeft: [], bottomRight: [], topLeft: [], topRight: [], expected }
  const device = new WebGl2Device(gl)

  // the REAL generic Material (runtime) on WebGl2Device, fed GLSL via the new vsCode/fsCode.
  const material = new Material(device, {
    shader: '', vsEntry: 'vs', fsEntry: 'fs', vsCode: vsGlsl, fsCode: fsGlsl,
    format: 'rgba8unorm', sampleCount: 1,
    groups: [[{ binding: 0, kind: 'uniform' }, { binding: 1, kind: 'texture' }, { binding: 2, kind: 'sampler' }]],
    colorTargets: [{ format: 'rgba8unorm', blend: 'none' }],
    variants: [{ label: 'mat-rhi' }],
    globalUniformSize: 64,
    vertexBuffers: [{ stride: 16, attributes: [{ location: 0, offset: 0, format: 'float32x2' }, { location: 1, offset: 8, format: 'float32x2' }] }],
  })
  material.writeGlobal(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])) // identity mvp

  const V = (px: number, py: number, u: number, v: number) => [px, py, u, v]
  const quad = new Float32Array([...V(-1, -1, 0, 0), ...V(1, -1, 1, 0), ...V(-1, 1, 0, 1), ...V(-1, 1, 0, 1), ...V(1, -1, 1, 0), ...V(1, 1, 1, 1)])
  const vbuf = device.createBuffer({ size: quad.byteLength, usage: 'vertex' }); device.writeBuffer(vbuf, 0, quad)
  const texData = new Uint8Array([...TEXELS.BL, ...TEXELS.BR, ...TEXELS.TL, ...TEXELS.TR])
  const tex = device.createTexture({ width: 2, height: 2, format: 'rgba8unorm', usage: ['sample', 'copy-dst'] })
  device.writeTexture(tex, texData, 8, 2, 2)
  const samp = device.createSampler({ mag: 'nearest', min: 'nearest' })
  const globalBG = device.createBindGroup(material.layout(0), [
    { binding: 0, resource: { buffer: material.globalUniform! } },
    { binding: 1, resource: { view: device.createView(tex) } },
    { binding: 2, resource: { sampler: samp } },
  ])

  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, SIZE, SIZE)
  gl.clearColor(1, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT)
  const pass = wrapWebGl2Pass(device)
  executeItems(material, pass, [{ variant: 0, bindGroups: [globalBG], vertex: vbuf, count: 6, indexed: false }])
  gl.flush()
  const px = new Uint8Array(SIZE * SIZE * 4); gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px)
  const at = (x: number, y: number) => { const i = (y * SIZE + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]] }
  return { glError: gl.getError(), glNoError: gl.NO_ERROR, bottomLeft: at(16, 16), bottomRight: at(48, 16), topLeft: at(16, 48), topRight: at(48, 48), expected }
}
