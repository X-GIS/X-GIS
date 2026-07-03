// iter-289 — consume getTileLoadDiagnostic to pin its shape.
// Without a consumer the iter-288 accessor is dead scaffolding;
// this test reads every field so a future rename / removal trips
// here instead of silently leaving the user-side `__xgisMap`
// console probe broken.

import { describe, expect, it } from 'vitest'
import { VectorTileRenderer } from './vector-tile-renderer'
import { FrameDrawStats } from './frame-draw-stats'

// `needed`/`missed` now live on the FrameDrawStats collaborator (Cluster G,
// vtr-decomposition §4 Step 2). getTileLoadDiagnostic reads them back via
// `_drawStats.needed()/.missed()`, so the bare VTR must carry a real
// FrameDrawStats whose `_frameTilesVisible`/`_missedTiles` are poked.
// The GPU resident-tile COUNT now lives on the GpuTileStore collaborator
// (Cluster A, vtr-decomposition U3-prime); getTileLoadDiagnostic reads it
// via `_store.cacheCount()`, so the bare VTR carries a minimal store stub
// whose count is settable (mirrors the `_uploads` queueSize stub below).
function setGpuUnique(vtr: VectorTileRenderer, n: number): void {
  ;(vtr as unknown as { _store: { cacheCount: () => number } })._store = {
    cacheCount: () => n,
  }
}
function makeBareVtr(): VectorTileRenderer {
  const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
  const drawStats = new FrameDrawStats()
  ;(vtr as unknown as { _drawStats: FrameDrawStats })._drawStats = drawStats
  ;(vtr as unknown as { source: unknown }).source = null
  setNeeded(vtr, 0)
  setMissed(vtr, 0)
  setGpuUnique(vtr, 0)
  ;(vtr as unknown as { _uploads: { queueSize: () => number } })._uploads = {
    queueSize: () => 0,
  }
  return vtr
}

function setNeeded(vtr: VectorTileRenderer, n: number): void {
  const ds = (vtr as unknown as { _drawStats: FrameDrawStats })._drawStats
  ;(ds as unknown as { _frameTilesVisible: number })._frameTilesVisible = n
}

function setMissed(vtr: VectorTileRenderer, n: number): void {
  const ds = (vtr as unknown as { _drawStats: FrameDrawStats })._drawStats
  ;(ds as unknown as { _missedTiles: number })._missedTiles = n
}

describe('VectorTileRenderer.getTileLoadDiagnostic (iter-288)', () => {
  it('zero state — no source, no frame yet', () => {
    const vtr = makeBareVtr()
    const d = vtr.getTileLoadDiagnostic()
    expect(d.needed).toBe(0)
    expect(d.missed).toBe(0)
    expect(d.gpuUnique).toBe(0)
    expect(d.catalogCached).toBe(0) // source null → fallback 0
    expect(d.catalogLoading).toBe(0) // source null → fallback 0
    expect(d.uploadQueued).toBe(0)
    expect(typeof d.gpuCap).toBe('number')
    expect(d.gpuCap).toBeGreaterThan(0)
  })

  it('reflects mutated counters', () => {
    const vtr = makeBareVtr()
    setNeeded(vtr, 140)
    setMissed(vtr, 78)
    setGpuUnique(vtr, 62)
    ;(vtr as unknown as { _uploads: { queueSize: () => number } })._uploads = {
      queueSize: () => 12,
    }
    const d = vtr.getTileLoadDiagnostic()
    // Pins the FLICKER memory's reported numbers: 140 needed,
    // 62 on GPU, mid-burst — the exact partition next-iter
    // attribution needs to see.
    expect(d.needed).toBe(140)
    expect(d.missed).toBe(78)
    expect(d.gpuUnique).toBe(62)
    expect(d.uploadQueued).toBe(12)
  })

  it('reads source.getCacheSize + getPendingLoadCount when source attached', () => {
    const vtr = makeBareVtr()
    ;(vtr as unknown as { source: unknown }).source = {
      getCacheSize: () => 110,
      getPendingLoadCount: () => 8,
    }
    const d = vtr.getTileLoadDiagnostic()
    expect(d.catalogCached).toBe(110)
    expect(d.catalogLoading).toBe(8)
  })
})
