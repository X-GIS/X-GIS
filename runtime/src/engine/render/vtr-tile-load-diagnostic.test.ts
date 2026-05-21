// iter-289 — consume getTileLoadDiagnostic to pin its shape.
// Without a consumer the iter-288 accessor is dead scaffolding;
// this test reads every field so a future rename / removal trips
// here instead of silently leaving the user-side `__xgisMap`
// console probe broken.

import { describe, expect, it } from 'vitest'
import { VectorTileRenderer } from './vector-tile-renderer'

function makeBareVtr(): VectorTileRenderer {
  const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
  ;(vtr as unknown as { source: unknown }).source = null
  ;(vtr as unknown as { _frameTilesVisible: number })._frameTilesVisible = 0
  ;(vtr as unknown as { _missedTiles: number })._missedTiles = 0
  ;(vtr as unknown as { _gpuCacheCount: number })._gpuCacheCount = 0
  ;(vtr as unknown as { uploadQueue: { size: () => number } }).uploadQueue = {
    size: () => 0,
  }
  return vtr
}

describe('VectorTileRenderer.getTileLoadDiagnostic (iter-288)', () => {
  it('zero state — no source, no frame yet', () => {
    const vtr = makeBareVtr()
    const d = vtr.getTileLoadDiagnostic()
    expect(d.needed).toBe(0)
    expect(d.missed).toBe(0)
    expect(d.gpuUnique).toBe(0)
    expect(d.catalogCached).toBe(0)   // source null → fallback 0
    expect(d.catalogLoading).toBe(0)  // source null → fallback 0
    expect(d.uploadQueued).toBe(0)
    expect(typeof d.gpuCap).toBe('number')
    expect(d.gpuCap).toBeGreaterThan(0)
  })

  it('reflects mutated counters', () => {
    const vtr = makeBareVtr()
    ;(vtr as unknown as { _frameTilesVisible: number })._frameTilesVisible = 140
    ;(vtr as unknown as { _missedTiles: number })._missedTiles = 78
    ;(vtr as unknown as { _gpuCacheCount: number })._gpuCacheCount = 62
    ;(vtr as unknown as { uploadQueue: { size: () => number } }).uploadQueue = {
      size: () => 12,
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
