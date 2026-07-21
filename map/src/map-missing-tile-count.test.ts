// #1229 item 1 — the public `getMissingTileCount()` accessor. A zero-allocation
// read over the `_missingTileCount` host field that BOTH render paths write with
// the per-frame in-flight tile sum (VT missed + raster/hillshade mid-fetch). The
// real end-to-end write is covered by the playground e2e (_1229-loading-indicator);
// this pins the accessor contract: defaults to 0, and reflects the field the
// render loop publishes.

import { describe, expect, it, vi } from 'vitest'
import { XGISMap } from './map'

function mockCanvas(): HTMLCanvasElement {
  return { width: 1200, height: 800 } as unknown as HTMLCanvasElement
}

describe('XGISMap.getMissingTileCount', () => {
  it('defaults to 0 before any frame has rendered', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const map = new XGISMap(mockCanvas())
    expect(map.getMissingTileCount()).toBe(0)
  })

  it('reflects the per-frame count the render loop publishes', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const map = new XGISMap(mockCanvas())
    // Simulate a render-loop end-of-frame write (host field, public-by-convention).
    ;(map as unknown as { _missingTileCount: number })._missingTileCount = 7
    expect(map.getMissingTileCount()).toBe(7)
    // Settled frame → back to 0.
    ;(map as unknown as { _missingTileCount: number })._missingTileCount = 0
    expect(map.getMissingTileCount()).toBe(0)
  })

  it('returns the same primitive on repeated reads (no allocation churn)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const map = new XGISMap(mockCanvas())
    ;(map as unknown as { _missingTileCount: number })._missingTileCount = 3
    expect(map.getMissingTileCount()).toBe(map.getMissingTileCount())
  })
})
