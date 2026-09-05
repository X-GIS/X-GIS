// ═══ createComputeRunner — cross-tier value parity on REAL GPUs (#1903) ═══
//
// The runner's whole promise is that ONE call site produces the same numbers whichever
// tier resolves. That is only checkable where a real GPU exists, so this is the half the
// vitest suite cannot do: `runner.backend === 'webgl2'`, `=== 'webgpu'` and `=== 'cpu'`
// over the SAME module and the SAME input, compared byte-for-byte against each other AND
// against the tree-walk interpreter — independent engines, one expected answer.
//
// Why more than two arms: the CPU tier runs `compileModuleJs` (a `new Function`'d JS
// source) and the oracle runs the interpreter, so a bug in the shared cpu-runtime op
// library would agree with itself. The GPU arms are the outside witnesses. They are also
// not each other's witness — WebGL2 goes through the compute→fragment lowering, a 2D-tiled
// R32F data texture and an R32UI readback, while WebGPU runs the UNCHANGED `@compute`
// source through a compute pass and a mapped staging copy. The two share nothing below the
// IR, which is the point: the portable tier claims both spellings compute the same thing.
//
// Fails when: the lowering stops being value-faithful, the runner's WebGL2 host contract
// drifts from what the emit expects (a UBO where the backend spells a bare uniform, a
// renamed sampler), the WebGPU bind group stops matching the DECLARED binding numbers, or
// a tier silently resolves to something other than what was asked.
//
// ─── THE FIXTURE CONSTRAINT, MEASURED — do not "simplify" these inputs ───
// Every feature value here is k/255 for an integer k. That is not decoration: it makes
// `round(v * 255)` land on an exact integer in BOTH f32 and f64, so byte-equality against
// an f64 oracle holds BY CONSTRUCTION rather than by luck.
//
// A round value breaks it. Measured, with 0.9:
//
//     0.9 as f32          0.89999997615814208984
//     x 255 in f64        229.49999392...   -> round 229   (the oracle)
//     x 255 in f32        229.50000000000   -> round 230   (the GPU)
//
// The f32 multiply rounds the product UP to exactly 229.5 and lands on the round-half
// boundary, so the two engines legitimately disagree by one byte. That is the f64-ALGEBRA
// caveat oracle.ts states in its own header ("still NOT an f32 GPU-precision oracle"), not
// a defect in the lowering — and it cost one red run here before it was computed rather
// than guessed at. Keep the inputs exact, or compare with a tolerance instead of bytes.

import {
  fn,
  module,
  If,
  Return,
  storageBuffer,
  resource,
  builtin,
  pack4x8unorm,
  vec4,
  compileModule,
  f32T,
  u32T,
  vec3uT,
  voidT,
  vec4uT,
  type ModuleDecl,
} from '../../shader-dsl/src/index'
import { createComputeRunner, type GpuDeviceLike } from '../../shader-dsl/src/compute'

// ─── THE CONFORMANCE PROBE — a compile-time gate, not a runtime one ───
// shader-dsl compiles with `types: []` so it stays vendorable, which means it types the
// WebGPU device STRUCTURALLY and cannot itself check the mirror against the real thing.
// This project can: it has `@webgpu/types`, so this one line decides whether a consumer
// can pass their `GPUDevice` with no cast. It is not decoration — the first version of
// `GpuDeviceLike` spelled its argument shapes and a real `GPUDevice` was NOT assignable
// (a method parameter is contravariant: `module: unknown` demands the device accept
// anything, and `layout: 'auto'` is narrower than `GPUPipelineLayout | 'auto'`). Delete
// this and that regression comes back silently, because nothing else typechecks the two
// against each other.
export const _deviceConformance = (d: GPUDevice): GpuDeviceLike => d

export interface RunnerParityResult {
  ok: boolean
  glBackend: string
  cpuBackend: string
  /** Why webgpu/webgl2 were skipped on the CPU-pinned arm — proves `rejected` is populated
   *  on a real host, not just in the Node unit test. */
  cpuRejected: { backend: string; reason: string }[]
  cases: {
    name: string
    n: number
    /** gl-vs-oracle and cpu-vs-oracle mismatches, capped for the report. */
    glMismatches: { i: number; got: number; want: number }[]
    cpuMismatches: { i: number; got: number; want: number }[]
  }[]
  note: string
}

/** The per-feature paint shape: the kernel the compute path actually runs. */
function paintKernel(): ModuleDecl {
  const featData = storageBuffer('feat_data', f32T, { group: 0, binding: 0, access: 'read' })
  const outColor = storageBuffer('out_color', u32T, { group: 0, binding: 1, access: 'read_write' })
  const uCount = resource('u_count', vec4uT, { group: 0, binding: 2 })
  const kernel = fn(
    'paint',
    { gid: builtin('global_invocation_id', vec3uT) },
    voidT,
    ({ gid }) => {
      const i = gid.x
      If(i.ge(uCount.node.x), () => {
        Return()
      })
      outColor.at(i).assign(pack4x8unorm(vec4(featData.at(i), 0, 0, 1)))
    },
    { stage: 'compute', workgroupSize: 64, portable: true },
  )
  return module({
    bindings: [featData.binding, outColor.binding, uCount.binding],
    funcs: [kernel],
  })
}

/** The SAME kernel with its resources renumbered — input at @binding(3), output at
 *  @binding(7), the dispatch uniform at @binding(2), and none of them in declaration
 *  order. Nothing in the tier requires 0/1/2, so a runner that hardcodes them (as the rhi
 *  dispatcher does, legitimately, for kernels it emits itself) binds the wrong resources
 *  here. On WebGPU that is a bind-group validation error against the `layout: 'auto'`
 *  layout — which is why `gpuErrors` is asserted and not just the numbers. */
function permutedPaintKernel(): ModuleDecl {
  const featData = storageBuffer('feat_data', f32T, { group: 0, binding: 3, access: 'read' })
  const outColor = storageBuffer('out_color', u32T, { group: 0, binding: 7, access: 'read_write' })
  const uCount = resource('u_count', vec4uT, { group: 0, binding: 2 })
  const kernel = fn(
    'paint',
    { gid: builtin('global_invocation_id', vec3uT) },
    voidT,
    ({ gid }) => {
      const i = gid.x
      If(i.ge(uCount.node.x), () => {
        Return()
      })
      outColor.at(i).assign(pack4x8unorm(vec4(featData.at(i), 0, 0, 1)))
    },
    { stage: 'compute', workgroupSize: 64, portable: true },
  )
  return module({
    bindings: [outColor.binding, uCount.binding, featData.binding],
    funcs: [kernel],
  })
}

/** The interpreter mirror — a third engine, sharing only the IR. */
function oracle(m: ModuleDecl, data: Float32Array): Uint32Array {
  const n = data.length
  const out = new Array<number>(n).fill(0)
  const cm = compileModule(m)
  cm.setBinding('feat_data', Array.from(data))
  cm.setBinding('u_count', [n, 0, 0, 0])
  cm.setBinding('out_color', out)
  for (let i = 0; i < n; i++) (cm.fns.paint as (g: number[]) => unknown)([i, 0, 0])
  return Uint32Array.from(out)
}

const diff = (got: Uint32Array, want: Uint32Array) => {
  const out: { i: number; got: number; want: number }[] = []
  for (let i = 0; i < want.length && out.length < 8; i++)
    if (got[i] !== want[i]) out.push({ i, got: got[i]!, want: want[i]! })
  return out
}

export async function runComputeRunnerParity(): Promise<RunnerParityResult> {
  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl)
    return {
      ok: false,
      glBackend: '',
      cpuBackend: '',
      cpuRejected: [],
      cases: [],
      note: 'no webgl2 context',
    }

  const m = paintKernel()
  // ONE module, two runners. `prefer` is what decides — not a capability guess.
  const glRunner = await createComputeRunner(m, { prefer: ['webgl2', 'cpu'], gl })
  const cpuRunner = await createComputeRunner(m, { prefer: ['cpu'] })

  // A single-row grid, and one whose count is NOT a multiple of the 2048 row width so the
  // last partial row exercises the over-grid discard path on the GL arm.
  const fixtures: { name: string; n: number }[] = [
    { name: 'single-row N=8', n: 8 },
    { name: 'multi-row N=4100 (over-grid discard)', n: 4100 },
  ]

  const cases: RunnerParityResult['cases'] = []
  let ok = glRunner.backend === 'webgl2' && cpuRunner.backend === 'cpu'
  for (const fx of fixtures) {
    const data = new Float32Array(Array.from({ length: fx.n }, (_, i) => ((i * 37) % 256) / 255))
    const want = oracle(m, data)
    const glMismatches = diff(await glRunner.run(data), want)
    const cpuMismatches = diff(await cpuRunner.run(data), want)
    if (glMismatches.length || cpuMismatches.length) ok = false
    cases.push({ name: fx.name, n: fx.n, glMismatches, cpuMismatches })
  }

  // Re-run the GL arm to prove the runner is reusable: the emit and the program link
  // happened at construction, so a second run must neither re-emit nor drift.
  const again = new Float32Array([13 / 255, 128 / 255, 229 / 255])
  const reuseGot = await glRunner.run(again)
  const reuseMismatches = diff(reuseGot, oracle(m, again))
  if (reuseMismatches.length) ok = false
  cases.push({
    name: 'REUSE N=3 (second run on the same runner)',
    n: 3,
    glMismatches: reuseMismatches,
    cpuMismatches: [],
  })

  glRunner.dispose()
  cpuRunner.dispose()

  return {
    ok,
    glBackend: glRunner.backend,
    cpuBackend: cpuRunner.backend,
    cpuRejected: cpuRunner.rejected.map((r) => ({ backend: r.backend, reason: r.reason })),
    cases,
    note: ok ? 'webgl2 and cpu tiers agree with the oracle' : 'a tier DIVERGED',
  }
}

// ─── the WebGPU arm ───────────────────────────────────────────────────────────────────

export interface WebGpuParityResult {
  ok: boolean
  /** Which tier resolved. Asserted FIRST: `prefer: ['webgpu']` is pinned, so anything but
   *  'webgpu' here means the comparison below is cpu-against-cpu and proves nothing. */
  backend: string
  /** Set only when the platform has no WebGPU at all, so a skip is legible as a skip. */
  unavailable?: string
  /** Uncaptured WebGPU errors. A bind-group entry at the wrong binding number, or a
   *  missing usage flag, surfaces HERE rather than as a wrong number — a dispatch that
   *  never legally ran returns the zero-filled output buffer, which is a plausible answer
   *  for a kernel whose input is zero. Empty is part of the gate, not a formality. */
  gpuErrors: string[]
  cases: {
    name: string
    n: number
    gotLen: number
    mismatches: { i: number; got: number; want: number }[]
  }[]
  /** webgpu tier vs cpu tier, byte for byte — the runner's promise stated arm-to-arm
   *  rather than each arm against a third party. */
  crossTierMismatches: { i: number; got: number; want: number }[]
  note: string
}

const unavailable = (why: string): WebGpuParityResult => ({
  ok: false,
  backend: '',
  unavailable: why,
  gpuErrors: [],
  cases: [],
  crossTierMismatches: [],
  note: why,
})

export async function runComputeRunnerWebGpuParity(): Promise<WebGpuParityResult> {
  if (!navigator.gpu) return unavailable('no navigator.gpu')
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) return unavailable('no WebGPU adapter')
  const device = await adapter.requestDevice()
  const gpuErrors: string[] = []
  device.addEventListener('uncapturederror', (e) => {
    gpuErrors.push((e as GPUUncapturedErrorEvent).error.message)
  })

  const m = paintKernel()
  // Pinned, not preferred: a silent drop to cpu would make every comparison below compare
  // the cpu tier with itself. This throws instead — which is the behaviour the unit suite
  // asserts and the reason `prefer` is a declared list rather than a capability guess.
  //
  // It is also the proof that this tier emits NATIVE WGSL: the pipeline is built at
  // construction, so a runner that had reached for the compute→fragment GLSL lowering
  // would fail `createShaderModule` here and never return.
  const runner = await createComputeRunner(m, { prefer: ['webgpu'], device })
  const cpuRunner = await createComputeRunner(m, { prefer: ['cpu'] })

  // n=65 straddles the declared `@workgroup_size(64)`: the dispatch rounds up to 2 groups
  // and the kernel's own `if (i >= u_count.x) { return; }` has to discard invocations
  // 65..127. n=0 is the zero-size-buffer clamp, which WebGPU rejects outright if the
  // runner passes the length through unguarded.
  const fixtures = [
    { name: 'single group N=8', n: 8 },
    { name: 'workgroup boundary N=65 (2 groups, 63 discarded)', n: 65 },
    { name: 'multi group N=4100', n: 4100 },
    { name: 'empty N=0 (zero-size buffer clamp)', n: 0 },
  ]

  const cases: WebGpuParityResult['cases'] = []
  let ok = runner.backend === 'webgpu' && cpuRunner.backend === 'cpu'
  let crossTierMismatches: { i: number; got: number; want: number }[] = []
  for (const fx of fixtures) {
    // k/255 — the exact-in-both-f32-and-f64 constraint the file header measures.
    const data = new Float32Array(Array.from({ length: fx.n }, (_, i) => ((i * 37) % 256) / 255))
    const got = await runner.run(data)
    const mismatches = diff(got, oracle(m, data))
    if (mismatches.length || got.length !== fx.n) ok = false
    cases.push({ name: fx.name, n: fx.n, gotLen: got.length, mismatches })
    if (fx.n === 4100) crossTierMismatches = diff(got, await cpuRunner.run(data))
  }
  if (crossTierMismatches.length) ok = false

  // The renumbered twin, through its own runner: same values, different bind group.
  const pm = permutedPaintKernel()
  const pRunner = await createComputeRunner(pm, { prefer: ['webgpu'], device })
  const pData = new Float32Array(Array.from({ length: 96 }, (_, i) => ((i * 37) % 256) / 255))
  const pGot = await pRunner.run(pData)
  const pMismatches = diff(pGot, oracle(pm, pData))
  if (pMismatches.length || pGot.length !== pData.length || pRunner.backend !== 'webgpu') ok = false
  cases.push({
    name: 'permuted bindings N=96 (in @3, out @7, uniform @2)',
    n: pData.length,
    gotLen: pGot.length,
    mismatches: pMismatches,
  })
  pRunner.dispose()

  runner.dispose()
  cpuRunner.dispose()
  if (gpuErrors.length) ok = false

  return {
    ok,
    backend: runner.backend,
    gpuErrors,
    cases,
    crossTierMismatches,
    note: ok ? 'the webgpu tier agrees with the oracle and with the cpu tier' : 'a tier DIVERGED',
  }
}
