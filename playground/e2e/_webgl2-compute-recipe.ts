// ═══ The documented standalone WebGL2 GPGPU recipe, on a REAL WebGL2 GPU ═══
//
// `site/src/pages/shader-dsl/webgl2-compute.astro` publishes a host recipe for running a
// `portable: true` compute kernel on WebGL2 using ONLY `@xgis/shader-dsl` — no @xgis/rhi,
// no @xgis/rhi-webgl2. That page is read by consumers who vendor the DSL alone, so the
// snippet it prints has to be a proven program, not a plausible one.
//
// This file is that proof: `createDataTexture` and `dispatchToR32UI` below are the page's
// two snippets VERBATIM (same names, same order, same comments-worth of steps), driven
// against the CPU-f64 oracle over the same module. A drift on either side — the page
// edited without the recipe, the emit changing what the host must bind — fails here.
//
// Deliberately HAND GL, unlike `_compute-dispatch-parity.ts` (which drives the production
// `dispatchComputeKernelWebGl2`): the standalone consumer has no device object, so a gate
// that used one would prove nothing about the code the page actually prints.

import {
  fn,
  module,
  If,
  Return,
  storageBuffer,
  resource,
  builtin,
  bitcastU32,
  compileModule,
  emitGlslModule,
  f32T,
  u32T,
  vec3uT,
  voidT,
  vec4uT,
} from '../../shader-dsl/src/index'

export interface RecipeParityResult {
  ok: boolean
  cases: { name: string; n: number; mismatches: { i: number; got: number; want: number }[] }[]
  glsl: string
  note: string
}

// ── The kernel the page authors (its "one source, two dispatches" section) ──
const featData = storageBuffer('feat_data', f32T, { group: 0, binding: 0, access: 'read' })
const outValue = storageBuffer('out_value', u32T, { group: 0, binding: 1, access: 'read_write' })
const dispatchU = resource('u_dispatch', vec4uT, { group: 0, binding: 2 })

const kernel = fn(
  'scale_features',
  { gid: builtin('global_invocation_id', vec3uT) },
  voidT,
  ({ gid }) => {
    const i = gid.x
    If(i.ge(dispatchU.node.x), () => {
      Return()
    })
    outValue.at(i).assign(bitcastU32(featData.at(i).mul(2).add(1)))
  },
  { stage: 'compute', workgroupSize: 64, portable: true },
)

const kernelModule = module({
  bindings: [featData.binding, outValue.binding, dispatchU.binding],
  funcs: [kernel],
})

// The fullscreen-triangle vertex shader the page prints — 3 vertices from gl_VertexID,
// no VBO and no attributes.
const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

/** The guaranteed WebGL2 MAX_TEXTURE_SIZE floor — the row width both tilings wrap at. */
const MAX_W = 2048

// ── PAGE SNIPPET 1 (verbatim) ──
/** Upload `data` as the 2D-tiled R32F data texture the emitted `_sfetch` reads. */
function createDataTexture(gl: WebGL2RenderingContext, data: Float32Array): WebGLTexture {
  const w = Math.min(Math.max(1, data.length), MAX_W)
  const h = Math.ceil(data.length / w)
  const tex = gl.createTexture()
  if (!tex) throw new Error('createTexture failed')
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, null)
  // REQUIRED: the default MIN_FILTER is NEAREST_MIPMAP_LINEAR, so without these the
  // texture is mipmap-INCOMPLETE and every texelFetch silently returns 0 — no GL error.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  // Pad to the full w*h: texSubImage2D must cover the whole texture.
  let padded = data
  if (data.length !== w * h) {
    padded = new Float32Array(w * h)
    padded.set(data)
  }
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.FLOAT, padded)
  return tex
}

// ── PAGE SNIPPET 2 (verbatim) ──
/** Run the lowered kernel as a fullscreen draw into an R32UI target; read back one u32
 *  per invocation. `program` links FULLSCREEN_VS with `emitGlslModule(m, 'fragment')`. */
function dispatchToR32UI(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  dataTex: WebGLTexture,
  n: number,
): Uint32Array {
  const wOut = Math.min(n, MAX_W)
  const hOut = Math.ceil(n / wOut)

  const outTex = gl.createTexture()
  if (!outTex) throw new Error('createTexture (out) failed')
  gl.bindTexture(gl.TEXTURE_2D, outTex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, wOut, hOut, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

  const fbo = gl.createFramebuffer()
  if (!fbo) {
    gl.deleteTexture(outTex)
    throw new Error('createFramebuffer failed')
  }
  // Snapshot the viewport: overriding it below would otherwise corrupt every later draw.
  const vp = gl.getParameter(gl.VIEWPORT) as Int32Array
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error('R32UI FBO incomplete')

    gl.viewport(0, 0, wOut, hOut)
    gl.disable(gl.BLEND) // blending is illegal on an integer attachment
    gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0])) // not clearColor

    gl.useProgram(program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, dataTex)
    gl.uniform1i(gl.getUniformLocation(program, 'feat_data'), 0)
    // u_dispatch is a BARE uniform, not a UBO. .x = invocation count, .y = W_out.
    gl.uniform4uiv(gl.getUniformLocation(program, 'u_dispatch'), new Uint32Array([n, wOut, 0, 0]))

    gl.drawArrays(gl.TRIANGLES, 0, 3) // fullscreen triangle — no VBO, no attributes

    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    const out = new Uint32Array(wOut * hOut)
    gl.readPixels(0, 0, wOut, hOut, gl.RED_INTEGER, gl.UNSIGNED_INT, out)
    return out.slice(0, n) // the rest of the grid is over-grid padding
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(vp[0]!, vp[1]!, vp[2]!, vp[3]!)
    gl.deleteFramebuffer(fbo)
    gl.deleteTexture(outTex)
  }
}

/** The CPU-f64 oracle: run the ORIGINAL @compute kernel per invocation. */
function oracle(data: Float32Array, n: number): number[] {
  const out = new Array<number>(n).fill(0)
  const cm = compileModule(kernelModule)
  cm.setBinding('feat_data', Array.from(data))
  cm.setBinding('u_dispatch', [n, 0, 0, 0])
  cm.setBinding('out_value', out)
  for (let i = 0; i < n; i++) cm.fns.scale_features([i, 0, 0])
  return out
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type)
    if (!sh) throw new Error('createShader failed')
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error(`compile failed: ${gl.getShaderInfoLog(sh) ?? ''}`)
    return sh
  }
  const prog = gl.createProgram()
  if (!prog) throw new Error('createProgram failed')
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc))
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(`link failed: ${gl.getProgramInfoLog(prog) ?? ''}`)
  return prog
}

export function runWebGl2ComputeRecipe(): RecipeParityResult {
  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) return { ok: false, cases: [], glsl: '', note: 'no webgl2 context' }

  // The page's option-free emit: the kernel's own `portable` declaration routes the
  // compute→fragment lowering. An undeclared kernel would throw here instead.
  const glsl = emitGlslModule(kernelModule, 'fragment')
  const program = link(gl, FULLSCREEN_VS, glsl)

  // A single-row grid, and one whose count is NOT a multiple of the 2048 row width so the
  // last partial row exercises the over-grid discard contract.
  const fixtures: { name: string; n: number }[] = [
    { name: 'single-row N=8', n: 8 },
    { name: 'multi-row N=4100 (over-grid discard)', n: 4100 },
  ]

  const cases: RecipeParityResult['cases'] = []
  let ok = true
  for (const fx of fixtures) {
    const data = new Float32Array(Array.from({ length: fx.n }, (_, i) => ((i * 7) % 11) / 11 - 0.5))
    const want = oracle(data, fx.n)
    const tex = createDataTexture(gl, data)
    const got = dispatchToR32UI(gl, program, tex, fx.n)
    gl.deleteTexture(tex)
    const mismatches: { i: number; got: number; want: number }[] = []
    for (let i = 0; i < fx.n; i++) {
      if (got[i] !== want[i]! >>> 0) mismatches.push({ i, got: got[i]!, want: want[i]! >>> 0 })
      if (mismatches.length >= 8) break // cap the report
    }
    if (mismatches.length) ok = false
    cases.push({ name: fx.name, n: fx.n, mismatches })
  }

  return {
    ok,
    cases,
    glsl,
    note: ok
      ? 'documented recipe byte-matches the CPU-f64 oracle'
      : 'documented recipe DIVERGED from the oracle',
  }
}
