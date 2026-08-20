// ═══ Shader DSL — the unified compute runner (#1903) ═══
//
// One entry point for running a `portable: true` compute kernel, whichever backend the
// host actually has. The kernel is already backend-neutral — the same `fn(…, { stage:
// 'compute', portable: true })` emits native WGSL and, on GLSL ES 3.00, the
// compute→fragment-GPGPU lowering. What was NOT neutral was the DISPATCH: WebGPU takes a
// compute pass, WebGL2 takes a fullscreen draw into an R32UI target and a readback, and a
// consumer had to write both. This module absorbs that difference.
//
// ─── WHY THIS LIVES IN shader-dsl ───
// It executes, and shader-dsl is a compiler — but that boundary was already crossed, on
// purpose: `compileModuleJs` (core/cpu-codegen.ts) emits a JS source string and
// `new Function`s it, and map/ ships that in production. The line this package actually
// holds is DEPENDENCIES, and this module keeps it: `WebGL2RenderingContext` comes from
// `lib.dom`, the WebGPU surface is typed STRUCTURALLY below rather than pulled from
// `@webgpu/types` (the package compiles with `types: []` so it can be vendored out of the
// repo), and the whole thing is on its own subpath — an emit-only consumer that never
// imports `@xgis/shader-dsl/compute` bundles none of it.
//
// ─── THE THREE PROPERTIES THAT ARE NOT NEGOTIABLE ───
// 1. ASYNC, because WebGPU readback genuinely is (`mapAsync`); CPU and WebGL2 resolve
//    immediately. Unity hit the same wall and had to expose `AsyncGPUReadback` —
//    `ComputeBuffer.GetData` does not work there. A synchronous common signature would be
//    a lie on the one backend that most needs it.
// 2. RESOLVED ONCE, at construction, not per `run()`. Same shape as Unity's Graphics API
//    list: a declared order, tried once, and from then on you know what you have.
// 3. OBSERVABLE, never silent. three.js's WebGPURenderer falls back to WebGL2
//    automatically and its own docs warn that compute work "may not run when devices
//    silently drop to the WebGL2 fallback" — a perf/correctness cliff the consumer cannot
//    debug. `backend` says what won; `rejected` says why each earlier candidate did not.
//
// The tier CHECK is deliberately not here. A kernel outside the gather-only tier is
// already red at authoring time via `SD0111` (passes/portable-kernel.ts, run by
// `validate()` on BOTH writers), which beats every engine surveyed — Unity and Babylon
// both report compute availability as a RUNTIME flag. This module only re-reads the
// analyzer's facts to find the bindings; it never re-decides the shape.

import type { ModuleDecl, FuncDecl, BindingDecl } from '../ir/index.js'
import { analyzePortableKernel, isPortableComputeEntry } from '../passes/portable-kernel.js'
import { compileModuleJs } from '../cpu-codegen.js'
import { emitGlslModule } from '../backends/glsl.js'

/** The tiers, most-capable first. This is also the default `prefer` order. */
export type ComputeBackend = 'webgpu' | 'webgl2' | 'cpu'

/** A candidate that did not win, and the reason — so a fallback is never silent. */
export interface RejectedBackend {
  readonly backend: ComputeBackend
  readonly reason: string
}

/** The minimum of WebGPU this module calls. Typed structurally rather than imported from
 *  `@webgpu/types`: this package compiles with `types: []` so it stays vendorable, and a
 *  real `GPUDevice` satisfies this shape. Widen it only for members actually used. */
export interface GpuDeviceLike {
  createShaderModule(d: { code: string }): unknown
  createBuffer(d: { size: number; usage: number; mappedAtCreation?: boolean }): unknown
}

/** How to resolve the tier, and which live GPU handles are available to resolve onto.
 *  Everything here is read ONCE, when the runner is built. */
export interface ComputeRunnerOptions {
  /** Backends to try, in order. Defaults to `['webgpu', 'webgl2', 'cpu']`.
   *
   *  Pin it to a single entry to make a tier REQUIRED — `prefer: ['webgl2']` throws
   *  rather than quietly running 200k invocations on the CPU (21 ms) or 1M (~105 ms).
   *  That cliff is the reason this list is declared instead of inferred. */
  readonly prefer?: readonly ComputeBackend[]
  /** A live WebGL2 context. Its absence is why `webgl2` is skipped. */
  readonly gl?: WebGL2RenderingContext
  /** A live WebGPU device. Its absence is why `webgpu` is skipped. */
  readonly device?: GpuDeviceLike
}

/** A kernel bound to one resolved backend. Build it with {@link createComputeRunner},
 *  read {@link ComputeRunner.backend} to learn which tier won, then call
 *  {@link ComputeRunner.run} as many times as you like — the emit, the program link and
 *  the tier decision all happened at construction, so `run` is the dispatch alone. */
export interface ComputeRunner {
  /** Which tier resolved. Read it — a CPU fallback costs ~105 ms at 1M invocations. */
  readonly backend: ComputeBackend
  /** Every candidate ahead of the winner, with the reason it was skipped. */
  readonly rejected: readonly RejectedBackend[]
  /** Run the kernel over `input`.
   *
   *  `invocations` defaults to `input.length` — right for a stride-1 kernel, which is the
   *  common shape. A kernel that reads several lanes per invocation
   *  (`feat_data[i * STRIDE + lane]`) must pass its own count, because the array length no
   *  longer is one.
   *
   *  Returns one `u32` per invocation: the value the `@compute` kernel would have written
   *  to its `read_write` binding. 32 bits is the width of an R32UI texel, not a semantic
   *  limit — pack a colour with `pack4x8unorm`, or round-trip an f32 through `bitcastU32`. */
  run(input: Float32Array, invocations?: number): Promise<Uint32Array>
  /** Release backend resources (GL programs/textures). Idempotent; a no-op on CPU. */
  dispose(): void
}

const DEFAULT_PREFER: readonly ComputeBackend[] = ['webgpu', 'webgl2', 'cpu']

/** The guaranteed WebGL2 `MAX_TEXTURE_SIZE` floor. Both the input data texture and the
 *  output grid wrap at this width, so a longer array spills across rows. */
const MAX_W = 2048

/** The kernel facts every tier needs: which binding is the input, which is the output,
 *  which uniform carries the dispatch, and what the entry is called. */
interface KernelPlan {
  readonly entry: FuncDecl
  readonly readBindings: readonly BindingDecl[]
  readonly outBinding: BindingDecl
  readonly dispatchUniform: BindingDecl
}

/** Read the tier analyzer's facts off `m`. Throws with the analyzer's own sentences when
 *  the module carries no portable entry or the entry is outside the tier — the same
 *  strings `SD0111` reports, so a consumer who reaches here without linting still gets the
 *  remedy rather than a shape error from three frames deeper. */
function planKernel(m: ModuleDecl): KernelPlan {
  const entry = m.funcs.find(isPortableComputeEntry)
  if (!entry)
    throw new Error(
      "createComputeRunner: no `portable: true` compute entry in this module. Declare the kernel `fn(…, { stage: 'compute', portable: true })` — the declaration is what routes the WebGL2 lowering and what gets the tier checked on both writers (#1812).",
    )
  const tier = analyzePortableKernel(m, entry)
  if (!tier.ok) throw new Error(`createComputeRunner: ${tier.violations.join('; ')}`)
  return {
    entry,
    readBindings: m.bindings.filter((b) => b.space === 'storage' && b.access === 'read'),
    outBinding: tier.outBinding,
    dispatchUniform: tier.dispatchUniform,
  }
}

// ── CPU tier ────────────────────────────────────────────────────────────────────────
//
// No dispatch abstraction needed at all: `compileModuleJs` walks the IR once, emits a JS
// source string per fn and `new Function`s it, so running the kernel is calling a
// function. Measured at 9.5 M invocations/sec on an 8-arm match paint kernel (6.6x the
// tree-walk interpreter, bit-identical to it by construction).
//
// This tier is STRICTLY MORE CAPABLE than WebGL2 — it has no gather-only restriction, no
// 32-bit output ceiling, no scatter ban. The ladder is therefore NOT monotonic: a kernel
// can be valid on cpu and webgpu but not webgl2. `planKernel` still gates on the tier
// here, deliberately: a runner whose CPU arm accepted kernels its GPU arms reject would
// pass in development and throw the first time it met a real device.
function createCpuRunner(
  m: ModuleDecl,
  plan: KernelPlan,
): Omit<ComputeRunner, 'backend' | 'rejected'> {
  const cm = compileModuleJs(m)
  const entryFn = cm.fns[plan.entry.name]
  if (typeof entryFn !== 'function')
    throw new Error(`createComputeRunner: compiled module has no entry '${plan.entry.name}'`)
  const gid: [number, number, number] = [0, 0, 0]

  return {
    run(input: Float32Array, invocations?: number): Promise<Uint32Array> {
      const n = invocations ?? input.length
      const out = new Array<number>(n).fill(0)
      for (const b of plan.readBindings) cm.setBinding(b.name, Array.from(input))
      // .y = W_out is the GLSL grid width and carries no meaning here; .x is the bounds
      // guard the kernel itself reads, so it must be right.
      cm.setBinding(plan.dispatchUniform.name, [n, 0, 0, 0])
      cm.setBinding(plan.outBinding.name, out)
      // The gid array is hoisted: reusing it instead of minting `[i,0,0]` per invocation
      // measured 12–24% across kernel shapes.
      for (let i = 0; i < n; i++) {
        gid[0] = i
        entryFn(gid)
      }
      return Promise.resolve(Uint32Array.from(out))
    },
    dispose(): void {},
  }
}

// ── WebGL2 tier ─────────────────────────────────────────────────────────────────────
//
// The host contract for the compute→fragment lowering, as published on
// /shader-dsl/webgl2-compute and proven against the CPU-f64 oracle on a real WebGL2
// context. Three things here are load-bearing and each fails SILENTLY when omitted:
// the texture parameters (the default NEAREST_MIPMAP_LINEAR leaves a mipmap-incomplete
// texture whose every texelFetch returns 0 with no GL error), `disable(BLEND)` (blending
// on an integer attachment is a GL error), and `clearBufferuiv` rather than `clearColor`.

/** The fullscreen triangle: three vertices from `gl_VertexID`, no VBO, no attributes. */
const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

function compileGlProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type)
    if (!sh) throw new Error('createComputeRunner: gl.createShader failed')
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) ?? ''
      gl.deleteShader(sh)
      throw new Error(`createComputeRunner: shader compile failed: ${log}`)
    }
    return sh
  }
  const prog = gl.createProgram()
  if (!prog) throw new Error('createComputeRunner: gl.createProgram failed')
  const vs = compile(gl.VERTEX_SHADER, vsSrc)
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc)
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? ''
    gl.deleteProgram(prog)
    throw new Error(`createComputeRunner: program link failed: ${log}`)
  }
  return prog
}

/** Upload `data` as the 2D-tiled R32F data texture the emitted `_sfetch` reads: element i
 *  lives at texel (i % W, i / W), and the shader reads W back through `textureSize()` so
 *  there is no width constant for the two sides to disagree about. */
function uploadDataTexture(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture,
  data: Float32Array,
): void {
  const w = Math.min(Math.max(1, data.length), MAX_W)
  const h = Math.ceil(data.length / w)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, null)
  // REQUIRED — see the note above the tier.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  // texSubImage2D must cover the whole texture, so a partial last row is zero-padded.
  // The view honours the caller's window (byteOffset/length): a frame-arena subarray read
  // from offset 0 would upload a neighbouring buffer's bytes, silently.
  let padded = data
  if (data.length !== w * h) {
    padded = new Float32Array(w * h)
    padded.set(data)
  }
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.FLOAT, padded)
}

function createWebGl2Runner(
  gl: WebGL2RenderingContext,
  m: ModuleDecl,
  plan: KernelPlan,
): Omit<ComputeRunner, 'backend' | 'rejected'> {
  // No emit option: the kernel's own `portable` declaration routes the compute→fragment
  // lowering. Emitted ONCE here, not per run — the rhi dispatchers cache the PIPELINE but
  // key it on the emit OUTPUT, so they pay validate → lowering → the optimizer fixpoint on
  // every dispatch. That is the bug this runner exists not to inherit.
  const program = compileGlProgram(gl, FULLSCREEN_VS, emitGlslModule(m, 'fragment'))
  const dataTex = gl.createTexture()
  if (!dataTex) throw new Error('createComputeRunner: gl.createTexture failed')

  const samplerLoc = gl.getUniformLocation(program, plan.readBindings[0]?.name ?? '')
  const dispatchLoc = gl.getUniformLocation(program, plan.dispatchUniform.name)
  let disposed = false

  return {
    run(input: Float32Array, invocations?: number): Promise<Uint32Array> {
      if (disposed) throw new Error('createComputeRunner: runner has been disposed')
      const n = invocations ?? input.length
      const wOut = Math.min(Math.max(1, n), MAX_W)
      const hOut = Math.ceil(n / wOut)

      uploadDataTexture(gl, dataTex, input)

      const outTex = gl.createTexture()
      if (!outTex) throw new Error('createComputeRunner: gl.createTexture (out) failed')
      gl.bindTexture(gl.TEXTURE_2D, outTex)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32UI,
        wOut,
        hOut,
        0,
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
        null,
      )
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

      const fbo = gl.createFramebuffer()
      if (!fbo) {
        gl.deleteTexture(outTex)
        throw new Error('createComputeRunner: gl.createFramebuffer failed')
      }
      // Snapshot the viewport: overriding it for the output grid without restoring leaves
      // every later draw in the host's frame rendering at the compute pass's size.
      const vp = gl.getParameter(gl.VIEWPORT) as Int32Array
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0)
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
        if (status !== gl.FRAMEBUFFER_COMPLETE)
          throw new Error(
            `createComputeRunner: R32UI framebuffer incomplete (0x${status.toString(16)})`,
          )

        gl.viewport(0, 0, wOut, hOut)
        gl.disable(gl.BLEND)
        gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]))

        gl.useProgram(program)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, dataTex)
        if (samplerLoc) gl.uniform1i(samplerLoc, 0)
        // A BARE `uniform uvec4`, not a UBO — the GLSL backend spells the dispatch uniform
        // loose so this path can set it directly. .x = invocation count, .y = W_out.
        if (dispatchLoc) gl.uniform4uiv(dispatchLoc, new Uint32Array([n, wOut, 0, 0]))

        gl.drawArrays(gl.TRIANGLES, 0, 3)

        gl.readBuffer(gl.COLOR_ATTACHMENT0)
        const grid = new Uint32Array(wOut * hOut)
        gl.readPixels(0, 0, wOut, hOut, gl.RED_INTEGER, gl.UNSIGNED_INT, grid)
        // The tail of the grid is over-grid padding; those texels took the `discard` path.
        return Promise.resolve(grid.slice(0, n))
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(vp[0]!, vp[1]!, vp[2]!, vp[3]!)
        gl.deleteFramebuffer(fbo)
        gl.deleteTexture(outTex)
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      gl.deleteProgram(program)
      gl.deleteTexture(dataTex)
    },
  }
}

// ── resolution ──────────────────────────────────────────────────────────────────────

/** Build a runner for `m`, resolving the backend ONCE against `prefer`.
 *
 *  Throws — rather than silently degrading — when no candidate in `prefer` is available;
 *  the error lists every rejection reason, so "why is this on the CPU?" is answerable
 *  from the message alone.
 *
 *  @throws when the module has no `portable: true` compute entry, when that entry is
 *  outside the gather-only tier (the analyzer's own sentences, the `SD0111` text), or
 *  when no preferred backend can be built.
 */
export async function createComputeRunner(
  m: ModuleDecl,
  opts?: ComputeRunnerOptions,
): Promise<ComputeRunner> {
  const plan = planKernel(m)
  const prefer = opts?.prefer ?? DEFAULT_PREFER
  const rejected: RejectedBackend[] = []

  for (const backend of prefer) {
    if (backend === 'webgpu') {
      // Not built in this release. Reported as a rejection rather than omitted from the
      // enum, so a host that asks for it learns why instead of silently getting WebGL2 —
      // and so adding the tier later needs no API change.
      rejected.push({
        backend,
        reason: opts?.device
          ? 'the webgpu tier is not implemented in this release; run the kernel through emitModule() and a compute pass directly, or prefer webgl2/cpu'
          : 'no WebGPU device was passed (`device`)',
      })
      continue
    }
    if (backend === 'webgl2') {
      if (!opts?.gl) {
        rejected.push({ backend, reason: 'no WebGL2 context was passed (`gl`)' })
        continue
      }
      const impl = createWebGl2Runner(opts.gl, m, plan)
      return { backend, rejected, run: impl.run, dispose: impl.dispose }
    }
    const impl = createCpuRunner(m, plan)
    return { backend: 'cpu', rejected, run: impl.run, dispose: impl.dispose }
  }

  throw new Error(
    `createComputeRunner: no backend from [${prefer.join(', ')}] could be used. ` +
      rejected.map((r) => `${r.backend}: ${r.reason}`).join('; '),
  )
}
