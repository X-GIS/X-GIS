// ═══════════════════════════════════════════════════════════════════
// AllocCounter — Plan AAA Phase C.2 (iter-240) diagnostic
// ═══════════════════════════════════════════════════════════════════
//
// Per-call-site allocation counter. Gated behind
// `globalThis.__xgisAllocProfileEnabled` (default false) so production
// pays nothing. When enabled, hot-path call sites bump per-key counters
// and the StatsTracker reports them via `getAllocProfile()`.
//
// Usage at a call site:
//
//   import { bumpAlloc } from '../__profile__/alloc-counter'
//   bumpAlloc('vtr.forEachLabelFeature.bestByFeatId.Map')
//   const map = new Map<...>()
//
// Or paired with `IS_ENABLED` short-circuit to skip the entire alloc
// branch when profiling is off (advanced — only worth it for very hot
// per-frame paths).
//
// Cost when disabled: a single `if (!enabled) return` branch per call
// site. V8 inlines + dead-code-eliminates the body. Negligible.
//
// Cost when enabled: 1 Map.get + 1 Map.set per call. Still much cheaper
// than the alloc being counted, so the profile signal isn't dominated
// by the instrumentation overhead.
//
// To run: in the browser console (or harness), set
// `__xgisAllocProfileEnabled = true`, drive the scene, then read
// `__xgisMap.stats.getAllocProfile()` to dump the counts.

const counts = new Map<string, number>()

export function bumpAlloc(key: string): void {
  const g = globalThis as { __xgisAllocProfileEnabled?: boolean }
  if (!g.__xgisAllocProfileEnabled) return
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

export function getAllocProfile(): Record<string, number> {
  const out: Record<string, number> = Object.create(null)
  for (const [k, v] of counts) out[k] = v
  return out
}

export function resetAllocProfile(): void {
  counts.clear()
}

/** Per-frame snapshot: returns delta of counts since last call.
 *  Useful for "what allocates per frame" rather than lifetime. */
let _prevSnapshot: Map<string, number> = new Map()
export function snapshotAllocProfile(): Record<string, number> {
  const out: Record<string, number> = Object.create(null)
  for (const [k, v] of counts) {
    const prev = _prevSnapshot.get(k) ?? 0
    const delta = v - prev
    if (delta > 0) out[k] = delta
  }
  _prevSnapshot = new Map(counts)
  return out
}

/** Test-only: control flag for unit tests. Production callers set
 *  `globalThis.__xgisAllocProfileEnabled` directly. */
export function _setEnabled(on: boolean): void {
  (globalThis as { __xgisAllocProfileEnabled?: boolean }).__xgisAllocProfileEnabled = on
}

// iter-240 — module-side-effect expose for harness + DevTools.
// Importing the runtime (via XGISMap) makes the API discoverable
// at `globalThis.__xgisAllocProfile`. Production cost: a single
// object literal at module init. Disabled-by-default flag means
// no per-frame overhead until the user opts in.
;(globalThis as {
  __xgisAllocProfile?: {
    getAllocProfile: typeof getAllocProfile
    snapshotAllocProfile: typeof snapshotAllocProfile
    resetAllocProfile: typeof resetAllocProfile
    setEnabled: typeof _setEnabled
  }
}).__xgisAllocProfile = {
  getAllocProfile,
  snapshotAllocProfile,
  resetAllocProfile,
  setEnabled: _setEnabled,
}
