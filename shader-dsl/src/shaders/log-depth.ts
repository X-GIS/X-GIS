// ═══ Shader DSL — log-depth snippet (Phase 2, shared-math boundary) ═══
//
// Re-authors shaders/log-depth.ts WGSL_LOG_DEPTH_FNS as IR. A shared math
// snippet (like the projection block): two pure functions, no render-stage
// machinery, inlined by the polygon / line / point / raster shaders. First
// Phase-2 wiring — gated by the pixel survey + log-depth.test.ts.

import {
  fn, module, f32, vec4, max, log2,
  f32T, vec4fT,
  type FuncDecl, type ModuleDecl,
} from '../core/ir'
import { emitFuncsCsed } from '../core/backends/wgsl'

// apply_log_depth(pos, fc): write z = log2(max(1e-6, w+1)) * fc * w, keeping
// x/y/w. The *w pre-cancels the later perspective division.
export const apply_log_depth = fn('apply_log_depth', { pos: vec4fT, fc: f32T }, vec4fT, ({ pos, fc }, b) => {
  const z = b.let('z', log2(max(f32(1e-6), pos.w.add(1))).mul(fc).mul(pos.w))
  b.ret(vec4(pos.x, pos.y, z, pos.w))
})

// compute_log_frag_depth(view_w, fc): per-pixel log depth for @builtin(frag_depth).
export const compute_log_frag_depth = fn('compute_log_frag_depth', { view_w: f32T, fc: f32T }, f32T, ({ view_w, fc }, b) => {
  b.ret(log2(max(f32(1e-6), view_w.add(1))).mul(fc))
})

const LOG_DEPTH_FUNCS: FuncDecl[] = [apply_log_depth, compute_log_frag_depth]

export const LOG_DEPTH_MODULE: ModuleDecl = module({ funcs: LOG_DEPTH_FUNCS })

/** Emitted WGSL — re-exported as WGSL_LOG_DEPTH_FNS by shaders/log-depth.ts. */
export const LOG_DEPTH_WGSL_FNS = `${emitFuncsCsed(LOG_DEPTH_FUNCS)}\n`
