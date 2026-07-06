// M4 (browser side): run the RUNTIME WebGl2Device compute-dispatch path on a REAL WebGL2
// GPU and prove byte-parity vs the CPU-f64 oracle. Unlike _compute-parity.ts (which used
// hand GL to validate the SHADER), this drives the production helper
// dispatchComputeKernelWebGl2(device, kernel, featData) — the WebGL2 routing of a
// per-feature compute kernel as a fullscreen draw to an R32UI offscreen target.

import { compileModule } from '../../shader-dsl/src/index'
import { emitMatchComputeKernel } from '../../compiler/src/codegen/compute-gen'
import { WebGl2Device } from '@xgis/rhi-webgl2'
import { dispatchComputeKernelWebGl2 } from '@xgis/rhi-webgl2'

export interface DispatchParityResult {
  ok: boolean
  cases: { name: string; n: number; mismatches: { fid: number; got: number; want: number }[] }[]
  note: string
}

// exact 8-bit hex (no fractional alphas) so the bit-exact pack equality holds.
const SPEC = {
  fieldName: 'cls',
  arms: [
    { pattern: 'a', colorHex: '#ff0000ff' },
    { pattern: 'b', colorHex: '#00ff00ff' },
  ],
  defaultColorHex: '#0000ffff',
}

function oracle(
  kernel: ReturnType<typeof emitMatchComputeKernel>,
  feat: number[],
  n: number,
): number[] {
  const out = new Array<number>(n).fill(0)
  const cm = compileModule(kernel.module)
  cm.setBinding('feat_data', feat)
  cm.setBinding('u_count', [n, 0, 0, 0])
  cm.setBinding('out_color', out)
  for (let f = 0; f < n; f++) cm.fns[kernel.entryPoint]([f, 0, 0])
  return out
}

export function runComputeDispatchParity(): DispatchParityResult {
  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) return { ok: false, cases: [], note: 'no webgl2 context' }
  const device = new WebGl2Device(gl)
  const kernel = emitMatchComputeKernel(SPEC)

  // Two fixtures: a small single-row grid, and a LARGE one whose feature count is NOT a
  // multiple of the 2048 row width (W_out=2048, H_out=3, last row partial) so over-grid
  // padding texels exercise the discard contract. Category ids cycle 0,1,2 (a,b,default).
  const fixtures: { name: string; n: number }[] = [
    { name: 'single-row N=8', n: 8 },
    { name: 'multi-row N=4100 (over-grid discard)', n: 4100 },
  ]

  const cases: DispatchParityResult['cases'] = []
  let ok = true
  for (const fx of fixtures) {
    const feat = Array.from({ length: fx.n }, (_, i) => i % 3)
    const want = oracle(kernel, feat, fx.n)
    const got = dispatchComputeKernelWebGl2(device, kernel, new Float32Array(feat))
    const mismatches: { fid: number; got: number; want: number }[] = []
    for (let f = 0; f < fx.n; f++) {
      if (got[f] !== want[f]! >>> 0) mismatches.push({ fid: f, got: got[f]!, want: want[f]! >>> 0 })
      if (mismatches.length >= 8) break // cap the report
    }
    if (mismatches.length) ok = false
    cases.push({ name: fx.name, n: fx.n, mismatches })
  }

  return { ok, cases, note: ok ? 'all fixtures parity OK' : 'parity mismatch' }
}
