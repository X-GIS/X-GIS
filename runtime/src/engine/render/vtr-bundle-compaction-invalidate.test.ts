// Regression test for the bundle-cache compaction use-after-free (LATENT).
//
// THE BUG (preventive — GPURenderBundles are default-OFF behind
// `globalThis.__XGIS_BUNDLE_FORCE_ON === true`):
//
//   recordTileFill records a BUFFER REFERENCE into the bundle via
//   `setVertexBuffer(0, cached.vertexBuffer, …)` / `setIndexBuffer`. The
//   BundleCache assumes the arena buffer reference is STABLE. But the deferred
//   poly-arena compaction (GpuTileStore._compactPolyArenas) swaps each arena's
//   `.buffer` to a fresh packed buffer, rewrites every tile's
//   cached.vertexBuffer/indexBuffer to the new buffer, and RETIRES the old
//   buffer (destroyed on the NEXT runFrameMaintenance). Compaction bumps
//   NEITHER per-tile uploadEpoch NOR bindGroupEpoch — the only
//   compaction-relevant fields in the bundle cache key — so a cached bundle
//   recorded against the now-retired buffer keeps the SAME key → cache HIT →
//   executeBundles replays setVertexBuffer against a destroyed/relocated
//   GPUBuffer ("Buffer used in submit while destroyed" / wrong-buffer draw).
//
//   The async-upload path already guards this exact compaction case with a
//   buffer-identity check (vector-tile-renderer.ts ~1853-1861); the bundle
//   path had NO invalidation hook — bundleCache.invalidateAll() was never
//   called on compaction.
//
// THE FIX (signal seam, Option A): runFrameMaintenance now RETURNS whether
// compaction relocated the arenas this frame; VTR.beginFrame calls
// bundleCache.invalidateAll() when the signal is true. This drops every cached
// bundle a full frame BEFORE the retired buffer is destroyed.
//
// ORACLE — drive VTR.beginFrame through the Object.create + field-injection
// harness (same pattern as vtr-pump-prefetch.test.ts) with:
//   - a mock _store whose runFrameMaintenance reports compaction true / false,
//   - a BundleCache spy that records invalidateAll() calls.
// Assert invalidateAll() IS called exactly when compaction ran, and NOT when
// it didn't. BEFORE the fix the call site ignored the return value, so
// invalidateAll() was never reached on compaction → the "compaction → invalidate"
// case fails. AFTER the fix it passes; the "no compaction" case proves we don't
// over-invalidate (which would kill the steady-state 97.6% bundle hit rate).

import { describe, expect, it, vi } from 'vitest'
import { VectorTileRenderer } from './vector-tile-renderer'

// Build a VTR instance bypassing GPU init. Class field initializers don't run
// with Object.create, so every field beginFrame() reads up to + including the
// runFrameMaintenance seam is injected manually. The evictTiles block at the
// tail is skipped by leaving `source` null.
function makeVtr(opts: {
  compacted: boolean
  invalidateAllSpy: ReturnType<typeof vi.fn>
}): VectorTileRenderer {
  const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
  const inject = vtr as unknown as Record<string, unknown>

  // Collaborators beginFrame touches before the seam — minimal no-op stubs.
  inject._labelSource = { beginFrame() {} }
  inject._drawStats = { beginFrame() {} }
  inject._selection = { invalidateFrame() {} }
  inject._frameClassifyMemo = new Map()
  inject.uniformRing = undefined // optional-chained: resetSlot/takeRetired skip
  // Upload pipeline now lives on the coordinator; beginFrame calls
  // resetFrameCap() + passes the isActive() probe into runFrameMaintenance.
  inject._uploads = { resetFrameCap() {}, isActive: () => false }
  inject.stableKeys = []
  inject._releaseTileHook = () => {}
  inject.source = null // skips the CPU TileCatalog evictTiles tail

  // The mock store reports whether compaction relocated the arenas this frame.
  // Mirrors the real runFrameMaintenance(stableKeys, releaseTileHook,
  // uploadActive) → boolean contract.
  inject._store = {
    runFrameMaintenance: vi.fn(() => opts.compacted),
  }

  // BundleCache spy: only invalidateAll is exercised by the seam.
  inject.bundleCache = { invalidateAll: opts.invalidateAllSpy }

  return vtr
}

describe('VTR.beginFrame — compaction → bundleCache.invalidateAll linkage', () => {
  it('calls bundleCache.invalidateAll() when compaction relocated the arenas', () => {
    const invalidateAllSpy = vi.fn()
    const vtr = makeVtr({ compacted: true, invalidateAllSpy })

    vtr.beginFrame(1)

    // The recorded bundles point at the now-retired buffer; they MUST be
    // dropped this frame (before the next maintenance pass destroys the
    // retired buffer). Pre-fix the return value was ignored → 0 calls.
    expect(invalidateAllSpy).toHaveBeenCalledTimes(1)
  })

  it('does NOT invalidate when compaction did not run (preserves bundle hit rate)', () => {
    const invalidateAllSpy = vi.fn()
    const vtr = makeVtr({ compacted: false, invalidateAllSpy })

    vtr.beginFrame(1)

    // No relocation → buffer refs are stable → over-invalidating would force a
    // needless re-encode of every bundle the next frame (kills the steady-state
    // cache). Must stay untouched.
    expect(invalidateAllSpy).not.toHaveBeenCalled()
  })

  it('threads the maintenance return through unchanged across both branches', () => {
    // Belt-and-suspenders: prove the seam keys on the STORE return value, not
    // on some incidental state — flip the flag, observe the call count flip.
    for (const compacted of [true, false, true]) {
      const invalidateAllSpy = vi.fn()
      const vtr = makeVtr({ compacted, invalidateAllSpy })
      vtr.beginFrame(1)
      expect(invalidateAllSpy).toHaveBeenCalledTimes(compacted ? 1 : 0)
    }
  })
})
