import { describe, it, expect } from 'vitest'
import { compileModule } from '@xgis/shader-dsl/core/backends/cpu'
import { LOG_DEPTH_MODULE, LOG_DEPTH_WGSL_FNS } from '@xgis/shader-dsl/shaders/log-depth'
import { computeLogDepthFc, simulateLogDepthZ } from './shaders/log-depth'

// Phase-2 first wiring: log-depth WGSL is now emitted from the DSL. The cpu
// interpreter of the SAME IR must reproduce the canonical CPU helpers
// (simulateLogDepthZ / computeLogDepthFc), which the shader math is pinned to.
const M = compileModule(LOG_DEPTH_MODULE)

describe('Phase-2 log-depth — cpu interpreter ↔ canonical CPU helpers', () => {
  it('compute_log_frag_depth(view_w, fc) == simulateLogDepthZ(view_w, far)', () => {
    for (const far of [1e4, 1e7, 2e10]) {
      const fc = computeLogDepthFc(far)
      for (const w of [1, 100, 1e4, 1e6]) {
        expect(M.fns.compute_log_frag_depth(w, fc) as number).toBeCloseTo(simulateLogDepthZ(w, far), 9)
      }
    }
  })

  it('apply_log_depth keeps x/y/w and its z divides down to simulateLogDepthZ', () => {
    for (const far of [1e4, 1e7]) {
      const fc = computeLogDepthFc(far)
      for (const w of [1, 100, 1e4]) {
        const out = M.fns.apply_log_depth([3, 5, 999, w], fc) as number[]
        expect(out[0]).toBe(3)
        expect(out[1]).toBe(5)
        expect(out[3]).toBe(w)
        // z is the pre-perspective-divide clip z; /w recovers the NDC z.
        expect(out[2]! / w).toBeCloseTo(simulateLogDepthZ(w, far), 9)
      }
    }
  })
})

describe('Phase-2 log-depth — WGSL emission', () => {
  it('emits both fns with correct signatures + log2/max', () => {
    expect(LOG_DEPTH_WGSL_FNS).toContain('fn apply_log_depth(pos: vec4<f32>, fc: f32) -> vec4<f32>')
    expect(LOG_DEPTH_WGSL_FNS).toContain('fn compute_log_frag_depth(view_w: f32, fc: f32) -> f32')
    expect(LOG_DEPTH_WGSL_FNS).toContain('log2(')
    expect((LOG_DEPTH_WGSL_FNS.match(/{/g) ?? []).length).toBe((LOG_DEPTH_WGSL_FNS.match(/}/g) ?? []).length)
  })
})
