// ═══ createComputeRunner — cross-tier value parity on a REAL WebGL2 GPU (#1903) ═══
//
// The runner's whole promise is that ONE call site produces the same numbers whichever
// tier resolves. That is only checkable where a real GPU exists, so this is the half the
// vitest suite cannot do: `runner.backend === 'webgl2'` and `=== 'cpu'` over the SAME
// module and the SAME input, compared byte-for-byte against each other AND against the
// tree-walk interpreter — three independent engines, one expected answer.
//
// Why three arms and not two: the CPU tier runs `compileModuleJs` (a `new Function`'d JS
// source) and the oracle runs the interpreter, so a bug in the shared cpu-runtime op
// library would agree with itself. The WebGL2 arm is the outside witness — it goes
// through the compute→fragment lowering, a 2D-tiled R32F data texture and an R32UI
// readback, sharing nothing with either CPU path but the IR.
//
// Fails when: the lowering stops being value-faithful, the runner's WebGL2 host contract
// drifts from what the emit expects (a UBO where the backend spells a bare uniform, a
// renamed sampler), or a tier silently resolves to something other than what was asked.
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
  vec4uT,
  type ModuleDecl,
} from '../../shader-dsl/src/index'
import { createComputeRunner } from '../../shader-dsl/src/compute'

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
