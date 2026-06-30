// M5 (browser side): run the M2 compute->fragment-GPGPU lowering on a REAL WebGL2
// context and prove byte-parity vs the CPU-f64 oracle. Emits the lowered GLSL for a
// real per-feature paint kernel (emitMatchComputeKernel), draws a fullscreen triangle
// into an R32UI offscreen FBO with feat_data as an R32F input texture, reads back the
// packed u32 per texel, and compares each to the oracle's out_color[fid]. Vite resolves
// @xgis/shader-dsl + @xgis/compiler; runs through the same dynamic-import path the
// _glsl-real-shader-link-gate uses.

import { emitGlslModule, emitModule, compileModule } from '../../shader-dsl/src/index'
import { emitMatchComputeKernel } from '../../compiler/src/codegen/compute-gen'

export interface ParityResult {
  ok: boolean
  n: number
  mismatches: { fid: number; got: number; want: number }[]
  glslFs: string
  wgsl: string
  vsLog: string
  fsLog: string
  linkLog: string
  fbStatus: string
  note: string
}

const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

export function runComputeParity(): ParityResult {
  // A real per-feature paint kernel: 2 match arms (sorted: 'a','b') + a default.
  const spec = {
    fieldName: 'cls',
    arms: [
      { pattern: 'a', colorHex: '#ff0000ff' },
      { pattern: 'b', colorHex: '#00ff00ff' },
    ],
    defaultColorHex: '#0000ffff',
  }
  const kernel = emitMatchComputeKernel(spec)
  // feat_data = the per-feature category id (stride 1): 0->'a', 1->'b', 2->unknown(default), repeat.
  const feat: number[] = [0, 1, 2, 0, 1, 2, 0, 1]
  const n = feat.length

  // ── CPU oracle: run the ORIGINAL @compute kernel per fid → expected out_color[] ──
  const expected = new Array<number>(n).fill(0)
  const cm = compileModule(kernel.module)
  cm.setBinding('feat_data', feat)
  cm.setBinding('u_count', [n, 0, 0, 0])
  cm.setBinding('out_color', expected)
  for (let f = 0; f < n; f++) cm.fns[kernel.entryPoint]([f, 0, 0])

  // ── The shaders the runtime would emit for this kernel ──
  const glslFs = emitGlslModule(kernel.module, 'fragment', { emulateCompute: true })
  const wgsl = emitModule(kernel.module)

  const blank: Omit<ParityResult, 'ok' | 'mismatches'> = {
    n, glslFs, wgsl, vsLog: '', fsLog: '', linkLog: '', fbStatus: '', note: '',
  }
  const fail = (note: string, extra: Partial<ParityResult> = {}): ParityResult =>
    ({ ...blank, ok: false, mismatches: [], note, ...extra })

  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) return fail('no webgl2 context')

  // compile VS + the lowered FS
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!
    gl.shaderSource(sh, src); gl.compileShader(sh)
    return { ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean, log: gl.getShaderInfoLog(sh) ?? '', sh }
  }
  const vs = compile(gl.VERTEX_SHADER, FULLSCREEN_VS)
  const fs = compile(gl.FRAGMENT_SHADER, glslFs)
  if (!vs.ok) return fail('VS compile fail', { vsLog: vs.log.slice(0, 500) })
  if (!fs.ok) return fail('FS compile fail', { fsLog: fs.log.slice(0, 800) })
  const prog = gl.createProgram()!
  gl.attachShader(prog, vs.sh); gl.attachShader(prog, fs.sh); gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return fail('link fail', { linkLog: (gl.getProgramInfoLog(prog) ?? '').slice(0, 800) })

  // feat_data → an R32F input texture (W_in = n, 1 row). texelFetch(i % W_in, i / W_in).
  const featTex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, featTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, n, 1, 0, gl.RED, gl.FLOAT, new Float32Array(feat))

  // output → an R32UI texture (W_out = n, 1 row) attached to an offscreen FBO.
  const outTex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, outTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, n, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, null)
  const fbo = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0)
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  if (status !== gl.FRAMEBUFFER_COMPLETE) return fail('FBO incomplete', { fbStatus: '0x' + status.toString(16) })

  // draw the fullscreen triangle → each output texel = one invocation
  gl.useProgram(prog)
  gl.viewport(0, 0, n, 1)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, featTex)
  const featLoc = gl.getUniformLocation(prog, 'feat_data'); if (featLoc) gl.uniform1i(featLoc, 0)
  const countLoc = gl.getUniformLocation(prog, 'u_count'); if (countLoc) gl.uniform4ui(countLoc, n, n, 0, 0)
  gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]))
  gl.drawArrays(gl.TRIANGLES, 0, 3)

  // readback the packed u32 per texel
  const got = new Uint32Array(n)
  gl.readPixels(0, 0, n, 1, gl.RED_INTEGER, gl.UNSIGNED_INT, got)

  const mismatches: { fid: number; got: number; want: number }[] = []
  for (let f = 0; f < n; f++) if (got[f] !== (expected[f]! >>> 0)) mismatches.push({ fid: f, got: got[f]!, want: expected[f]! >>> 0 })

  return { ...blank, ok: mismatches.length === 0, mismatches, fbStatus: 'complete', note: mismatches.length ? 'parity mismatch' : 'parity OK' }
}
