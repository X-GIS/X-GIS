// #1582 sites 1+2 — the same GPU pass encoder was re-wrapped into a fresh
// `WebGpuRenderPass` instance once per fill draw (polygon-fill-material.ts)
// and once per stroke draw (line-renderer.ts), even though the encoder is
// loop-invariant for the whole render call. Mirrors the identical WeakMap
// pattern already proven at render-loop.ts:108-125 ("steady-state frames
// allocate nothing... allocation-paranoid") — shared by both call sites so
// a fill draw and a stroke draw against the SAME encoder reuse one wrapper.
//
// WeakMap keyed on the native encoder's identity: a new encoder each frame
// (rhi.beginScreenPass mints one) makes the prior frame's entry unreachable,
// so this self-cleans without an explicit per-frame reset.

import { wrapWebGpuPass } from '@xgis/rhi-webgpu'
import type { RhiRenderPass } from '@xgis/engine'
import { bumpAlloc } from '../../__profile__/alloc-counter'

const memo = new WeakMap<object, RhiRenderPass>()

/** Wrap a native GPU pass encoder into an `RhiRenderPass`, memoized on the
 *  encoder's identity. The SAME encoder wrapped twice (once from a fill
 *  draw, once from a stroke draw) returns the SAME `RhiRenderPass`
 *  instance instead of allocating a new wrapper class each time. */
export function wrapWebGpuPassMemoized(
  encoder: Parameters<typeof wrapWebGpuPass>[0],
): RhiRenderPass {
  let wrapped = memo.get(encoder)
  if (!wrapped) {
    bumpAlloc('pass-wrap-memo.wrapWebGpuPassMemoized.miss')
    wrapped = wrapWebGpuPass(encoder)
    memo.set(encoder, wrapped)
  }
  return wrapped
}
