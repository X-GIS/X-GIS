// ═══ fp64 (df64) known-answer gate — the REAL-GPU half of the fp64 contract ═══
//
// The CPU-side gates (shader-dsl/src/core/fp64/df64-known-answer.test.ts) prove
// the df64 algorithms under a correctly-rounding f32 model. What they CANNOT
// see is the one failure mode fp64 exists to survive: a downstream shader
// compiler's fast-math (WGSL §15.7.5 explicitly permits reassociation; Metal
// defaults to fast-math; ANGLE's D3D compiler reassociates) cancelling the
// error-free-transformation terms and silently collapsing df64 to f32
// precision. This spec executes the ACTUAL emitted shaders on the real
// GPU/driver stack and checks known-answer vectors that plain f32 arithmetic
// PROVABLY cannot produce:
//
//   • WGSL: a WebGPU compute pass over the emitted module (compute works
//     under SwiftShader in CI — same charter as _shader-math-parity.spec.ts).
//   • GLSL ES 3.00: a WebGL2 fragment pass (exercises ANGLE) rendering one
//     pass/fail pixel per test vector, plus a compile+link gate over the
//     fp64-deep-zoom example's emitted GLSL.
//
// Every numeric case carries a DISCRIMINATIVE half: the plain-f32 result
// differs from the expected value by far more than the tolerance, so a
// fast-math collapse of the guard turns the case red — the test cannot pass
// vacuously.

import { test, expect } from '@playwright/test'
// Relative deep import (charter): Playwright transpiles specs in raw Node — the
// @xgis/* workspace alias does not resolve here, so specs import package SOURCES
// relatively (see _shader-math-parity.spec.ts).
import {
  fn,
  module,
  emitModule,
  f64,
  f64Parts,
  toF32,
  sqrt,
  abs,
  u32,
  vec2fT,
  vec3uT,
  vec4,
  vec2,
  vec4fT,
  u32T,
  matchExpr,
  toU32,
  floor,
  If,
  Return,
  storageBuffer,
  builtin,
  ioStruct,
  FP64_GUARD_STRUCT,
  f32,
  emitGlslModule,
  type ReadonlyNode,
  type Node,
} from '../../shader-dsl/src/index'
import { fp64DeepZoom } from '../../shader-dsl/examples/fp64-deep-zoom'

// ── The shared known-answer vectors ──
// [description, exact expected (JS f64), plain-f32 twin, abs tolerance]
const A0 = 2 ** 20 + 2 ** -20
const CASES: Array<{ name: string; exact: number; f32: number; tol: number }> = [
  {
    name: '(2^20 + 2^-20) − 2^20',
    exact: 2 ** -20,
    f32: Math.fround(Math.fround(A0) - 2 ** 20), // 0 — total cancellation
    tol: 2 ** -30,
  },
  {
    name: '(1e8 + 0.5) − 1e8',
    exact: 0.5,
    f32: Math.fround(Math.fround(1e8 + 0.5) - 1e8), // 0
    tol: 2 ** -20,
  },
  {
    name: 'π × e',
    exact: Math.PI * Math.E,
    f32: Math.fround(Math.fround(Math.PI) * Math.fround(Math.E)),
    tol: Math.PI * Math.E * 2 ** -35,
  },
  {
    name: '1 ÷ 3',
    exact: 1 / 3,
    f32: Math.fround(1 / 3),
    tol: 2 ** -35,
  },
  {
    name: '√2',
    exact: Math.SQRT2,
    f32: Math.fround(Math.sqrt(Math.fround(2))),
    tol: 2 ** -35,
  },
]
const N = CASES.length

// The df64 result of case i, as authored DSL (f64 literals split at build time).
const caseExpr = (i: ReadonlyNode<'u32'>): Node<'f64'> =>
  matchExpr(
    i,
    [
      [0, () => f64(A0).add(f64(-(2 ** 20)))],
      [1, () => f64(1e8 + 0.5).add(f64(-1e8))],
      [2, () => f64(Math.PI).mul(f64(Math.E))],
      [3, () => f64(1).div(f64(3))],
    ],
    () => sqrt(f64(2)),
  )

// ── WGSL compute module ──

const outB = storageBuffer('outp', vec2fT, { group: 0, binding: 0, access: 'read_write' })
const computeKernel = fn(
  'k_main',
  { gid: builtin('global_invocation_id', vec3uT) },
  ({ gid }) => {
    const i = gid.x
    If(i.ge(u32(N)), () => {
      Return()
    })
    outB.at(i).assign(f64Parts(caseExpr(i)))
  },
  { stage: 'compute', workgroupSize: 64 },
)
// `_fp64` guard auto-injected at (group 0, binding 1) — first slot past outp.
const computeModule = module({ funcs: [computeKernel], uses: [outB] })

// ── GLSL fragment module (one pass/fail pixel per case) ──

const VsOut = ioStruct('VsOut', {
  pos: builtin('position', vec4fT),
})
const vsFull = fn(
  'vs_full',
  { idx: builtin('vertex_index', u32T) },
  (p) => {
    const pos = vec2(-1, -1)
    If(p.idx.eq(1), () => {
      pos.assign(vec2(3, -1))
    }).elif(p.idx.eq(2), () => {
      pos.assign(vec2(-1, 3))
    })
    return VsOut.construct({ pos: vec4(pos, 0, 1) })
  },
  { stage: 'vertex' },
)
const fsCheck = fn(
  'fs_check',
  { frag: builtin('position', vec4fT) },
  (p) => {
    const i = toU32(floor(p.frag.x))
    const r = caseExpr(i)
    // Per-case expected value (f64 literal) and tolerance (f32 literal). The
    // DISCRIMINATIVE property lives in the vector choice: for every case the
    // plain-f32 result misses `expected` by far more than `tol` (asserted
    // JS-side in the compute test), so a fast-math collapse of the guard
    // degenerates r to ~f32 and turns the pixel red — no vacuous pass.
    const expected = matchExpr(
      i,
      CASES.slice(0, -1).map((c, k) => [k, () => f64(c.exact)] as const),
      () => f64(CASES[N - 1]!.exact),
    )
    const tol = matchExpr(
      i,
      CASES.slice(0, -1).map((c, k) => [k, () => f32(Math.fround(c.tol))] as const),
      () => f32(Math.fround(CASES[N - 1]!.tol)),
    )
    const pass = toF32(abs(r.sub(expected)))
      .lt(tol)
      .select(1.0, 0.0)
    return vec4(f32(1).sub(pass), pass, 0, 1)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)
const fragModule = module({ funcs: [vsFull, fsCheck], uses: [VsOut] })

test.describe('fp64 known answers on the real GPU', () => {
  test('WGSL compute: emitted df64 module reproduces f64 answers (fast-math survival)', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const wgsl = emitModule(computeModule)
    const gpu = await page.evaluate(
      async (args: { wgsl: string; n: number }) => {
        const nav = navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }
        if (!nav.gpu) return { error: 'no navigator.gpu' as const }
        const adapter = await (nav.gpu.requestAdapter() as Promise<GPUAdapter | null>)
        if (!adapter) return { error: 'no adapter' as const }
        const device = await adapter.requestDevice()
        const errors: string[] = []
        device.addEventListener('uncapturederror', (e) => {
          errors.push((e as GPUUncapturedErrorEvent).error.message)
        })
        const mod = device.createShaderModule({ code: args.wgsl })
        const info = await mod.getCompilationInfo()
        const fatals = info.messages.filter((m) => m.type === 'error')
        if (fatals.length > 0)
          return { error: 'compile: ' + fatals.map((m) => `${m.lineNum}:${m.message}`).join(' | ') }
        const pipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: mod, entryPoint: 'k_main' },
        })
        const outBuf = device.createBuffer({
          size: args.n * 8,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        })
        const readBuf = device.createBuffer({
          size: args.n * 8,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        // The auto-injected anti-fast-math guard: _fp64.one = 1.0f.
        const guardBuf = device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        device.queue.writeBuffer(guardBuf, 0, new Float32Array([1, 0, 0, 0]))
        const bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: outBuf } },
            { binding: 1, resource: { buffer: guardBuf } },
          ],
        })
        const enc = device.createCommandEncoder()
        const pass = enc.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bind)
        pass.dispatchWorkgroups(1)
        pass.end()
        enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, args.n * 8)
        device.queue.submit([enc.finish()])
        await readBuf.mapAsync(GPUMapMode.READ)
        const out = Array.from(new Float32Array(readBuf.getMappedRange().slice(0)))
        readBuf.unmap()
        return { out, errors }
      },
      { wgsl, n: N },
    )

    expect(gpu, `GPU compute failed: ${'error' in gpu ? gpu.error : ''}`).not.toHaveProperty(
      'error',
    )
    if ('error' in gpu) return
    expect(gpu.errors, `uncaptured GPU errors: ${gpu.errors.join(' | ')}`).toEqual([])

    const failures: string[] = []
    for (let i = 0; i < N; i++) {
      const c = CASES[i]!
      const got = gpu.out[i * 2]! + gpu.out[i * 2 + 1]! // hi + lo (both f32-exact in f64)
      const err = Math.abs(got - c.exact)
      const f32err = Math.abs(c.f32 - c.exact)
      if (err > c.tol) {
        failures.push(`${c.name}: got ${got} expected ${c.exact} (Δ=${err.toExponential(2)})`)
      }
      // Discriminative: the df64 result must clearly beat plain f32 — a
      // fast-math-collapsed guard degenerates to ~f32 and trips this.
      if (!(err < f32err / 8 || f32err === 0)) {
        failures.push(
          `${c.name}: df64 error ${err.toExponential(2)} did not beat f32 error ${f32err.toExponential(2)} — EFT likely cancelled by the shader compiler`,
        )
      }
      if (f32err === 0 && err !== 0 && err > c.tol) {
        failures.push(`${c.name}: expected exact cancellation recovery, got Δ=${err}`)
      }
    }
    expect(
      failures,
      `executed df64 WGSL drifted from f64 known answers:\n${failures.join('\n')}`,
    ).toEqual([])
  })

  test('WebGL2/ANGLE: emitted df64 GLSL passes per-case checks; example GLSL compiles', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const args = {
      vs: emitGlslModule(fragModule, 'vertex'),
      fs: emitGlslModule(fragModule, 'fragment'),
      exVs: emitGlslModule(fp64DeepZoom.module, 'vertex'),
      exFs: emitGlslModule(fp64DeepZoom.module, 'fragment'),
      guardBlock: FP64_GUARD_STRUCT,
      n: N,
    }
    const res = await page.evaluate((a: typeof args) => {
      const compile = (
        gl: WebGL2RenderingContext,
        vsSrc: string,
        fsSrc: string,
      ): WebGLProgram | string => {
        const sh = (type: number, src: string): WebGLShader | string => {
          const s = gl.createShader(type)!
          gl.shaderSource(s, src)
          gl.compileShader(s)
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
            return `${type === gl.VERTEX_SHADER ? 'vs' : 'fs'}: ${gl.getShaderInfoLog(s)}`
          return s
        }
        const v = sh(gl.VERTEX_SHADER, vsSrc)
        if (typeof v === 'string') return v
        const f = sh(gl.FRAGMENT_SHADER, fsSrc)
        if (typeof f === 'string') return f
        const p = gl.createProgram()!
        gl.attachShader(p, v)
        gl.attachShader(p, f)
        gl.linkProgram(p)
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return `link: ${gl.getProgramInfoLog(p)}`
        return p
      }

      const canvas = document.createElement('canvas')
      canvas.width = a.n
      canvas.height = 1
      const gl = canvas.getContext('webgl2')
      if (!gl) return { error: 'no webgl2' }

      // 1) Compile gate over the fp64-deep-zoom example's emitted GLSL.
      const exProg = compile(gl, a.exVs, a.exFs)
      if (typeof exProg === 'string') return { error: `example ${exProg}` }

      // 2) The per-case checker: draw N pass/fail pixels and read them back.
      const prog = compile(gl, a.vs, a.fs)
      if (typeof prog === 'string') return { error: prog }
      gl.useProgram(prog)
      // Bind the auto-injected guard UBO (std140: one f32 in 16 bytes) = 1.0f.
      const idx = gl.getUniformBlockIndex(prog, a.guardBlock)
      if (idx === gl.INVALID_INDEX) return { error: `uniform block ${a.guardBlock} not found` }
      gl.uniformBlockBinding(prog, idx, 0)
      const ubo = gl.createBuffer()
      gl.bindBuffer(gl.UNIFORM_BUFFER, ubo)
      gl.bufferData(gl.UNIFORM_BUFFER, new Float32Array([1, 0, 0, 0]), gl.STATIC_DRAW)
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo)
      gl.viewport(0, 0, a.n, 1)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      const px = new Uint8Array(a.n * 4)
      gl.readPixels(0, 0, a.n, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      return { px: Array.from(px) }
    }, args)

    expect(res, `WebGL2 failed: ${'error' in res ? res.error : ''}`).not.toHaveProperty('error')
    if ('error' in res) return
    const failures: string[] = []
    for (let i = 0; i < N; i++) {
      const [r, g] = [res.px![i * 4]!, res.px![i * 4 + 1]!]
      if (!(g > 200 && r < 50)) {
        failures.push(`${CASES[i]!.name}: pixel (r=${r}, g=${g}) — df64 check failed on ANGLE`)
      }
    }
    expect(failures, `df64 GLSL known-answer pixels not green:\n${failures.join('\n')}`).toEqual([])
  })
})
