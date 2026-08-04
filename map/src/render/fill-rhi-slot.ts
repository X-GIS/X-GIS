// ═══ The #717 dual-instance fill-RHI mirror — one home for a globalThis slot ═══
//
// The site's Astro island duplicates the VTR module, so `setFillRhi(present)` lands
// on one VectorTileRenderer instance while a DIFFERENT instance runs
// `recordFillDraw` with `_fillRhi` still null. The fix is to mirror the fill state
// onto a `globalThis` slot both module copies can see, and let the draw side recover
// it (the pipeline-object mismatch that then arises across instances is tolerated by
// `recordFillDraw`'s label match). Same single-instance discipline as the
// projections / RHI dual-package fixes. A no-op in the normal single-instance path.
//
// It lives here rather than as two inline `globalThis as {…}` casts (#1567) because
// a slot with a writer in one file and a reader in another, and no release path in
// either, is exactly how it became a leak: the mirror was guarded by `if (state)`,
// which made it write-once-latching — `setFillRhi(null)` could not clear it,
// `destroy()` never touched it, and repo-wide nothing else wrote or deleted it. A
// destroyed map's entire fill Material/pipeline registry (one Material per
// data-driven style variant) therefore stayed strongly reachable for the page
// lifetime, so the ordinary SPA mount/unmount never got that memory back — and
// `recordFillDraw`'s label fallback could resolve a DESTROYED device's Materials
// against a live map.
//
// `rhi.destroy()` reclaims the GPU bytes. What these three functions govern is the
// JS wrapper graph, which it cannot see.

import type { FillRhiState } from './frame-renderer'

interface FillRhiSlot {
  __xgisFillRhi?: FillRhiState | null
}

/** Mirror the owning renderer's current fill state, EXACTLY — including null, so
 *  this is a mirror and not a high-water mark. */
export function mirrorFillRhi(state: FillRhiState | null): void {
  ;(globalThis as FillRhiSlot).__xgisFillRhi = state
}

/** The mirrored state, for a draw-side instance whose own `_fillRhi` is null. */
export function recoverFillRhi(): FillRhiState | null {
  return (globalThis as FillRhiSlot).__xgisFillRhi ?? null
}

/** Release the mirror on teardown — BY IDENTITY. With two live maps the slot may
 *  already hold the OTHER map's state, and clearing that would break the very #717
 *  case the slot exists for, so only the instance that last wrote it clears it. */
export function releaseFillRhi(state: FillRhiState | null): void {
  const g = globalThis as FillRhiSlot
  if (state !== null && g.__xgisFillRhi === state) g.__xgisFillRhi = null
}
