// #1355 — RenderStats publishes BYTE-level telemetry, not just counts.
//
// THE GAP THIS CLOSES: a host embedding this library could see `tilesCached`
// but not what those tiles cost. 256 entries is 64 MB of 256² tiles or 4 GB of
// 2048² ones, so a count is unbudgetable — and `heapDeltaBytes` is no
// substitute: it is Chrome/Edge-only (sentinel −1 elsewhere), measures the
// whole JS heap, attributes nothing, and sees no GPU memory at all.
//
// The values all existed internally, driving the engine's OWN eviction
// decisions; what was missing was a read-only way out. These assertions pin
// that the published numbers ARE those accumulators — a field that reported a
// constant, or read a different budget than the one enforced, would satisfy a
// "the key exists" check and is exactly what this has to exclude.

import { describe, expect, it, vi, afterEach } from 'vitest'
import { StatsTracker } from './stats'
import { GpuTileStore } from './render/gpu-tile-store'
import { TileCatalog, maxCachedBytes } from '@xgis/data'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import { getMaxGpuTiles } from './render/vector-tile-renderer-helpers'
import { arenaByteTotals } from './render-stats-bytes'

afterEach(() => {
  vi.unstubAllGlobals()
})

function mockDevice() {
  return {
    createBuffer(desc: GPUBufferDescriptor): GPUBuffer {
      return { size: desc.size, usage: desc.usage, destroy() {} } as unknown as GPUBuffer
    },
  } as unknown as GPUDevice
}

describe('RenderStats byte telemetry (#1355)', () => {
  it('reports the budgets the engine actually enforces, not copies of them', () => {
    // The point of publishing a budget is that a host can compare its usage
    // against the SAME number eviction uses; a hard-coded duplicate would drift
    // the moment either side is tuned.
    vi.stubGlobal('window', { innerWidth: 1440 })
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('coarse'), media: q }))
    const desktop = new StatsTracker().get()
    expect(desktop.cachedBytesBudget).toBe(maxCachedBytes())
    expect(desktop.gpuTilesBudget).toBe(getMaxGpuTiles())

    // The GPU cap is viewport-reactive, so a constant cannot track it — this is
    // what proves the snapshot RE-READS rather than capturing once.
    //
    // Only the GPU cap is asserted this way: `maxCachedBytes` reads its width
    // through a MEMOISED probe (tile-types.ts `readInnerWidthMemoised`), so it
    // cannot move within a process however the viewport is stubbed. That is its
    // own deliberate behaviour, not something this telemetry can or should
    // change — noted here so the asymmetry does not read as an oversight.
    vi.stubGlobal('window', { innerWidth: 390 })
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('coarse'), media: q }))
    const phone = new StatsTracker().get()
    expect(phone.gpuTilesBudget).toBeLessThan(desktop.gpuTilesBudget)
    expect(phone.gpuTilesBudget).toBe(getMaxGpuTiles())
  })

  it('publishes every accumulated field it was handed', () => {
    const t = new StatsTracker()
    t.cachedBytes = 12_345
    t.arenaLiveBytes = 6_000
    t.arenaCapacityBytes = 64 * 1024 * 1024
    t.inflightRequests = 7

    const s = t.get()
    expect(s.cachedBytes).toBe(12_345)
    expect(s.arenaLiveBytes).toBe(6_000)
    expect(s.arenaCapacityBytes).toBe(64 * 1024 * 1024)
    expect(s.inflightRequests).toBe(7)
  })

  it('clears the byte accumulators each frame, like the count ones', () => {
    // These are summed over a per-source walk each frame. Left uncleared they
    // would grow without bound and read as a leak that is not there.
    const t = new StatsTracker()
    t.cachedBytes = 999
    t.arenaLiveBytes = 999
    t.arenaCapacityBytes = 999
    t.inflightRequests = 999
    t.beginFrame()
    const s = t.get()
    expect([s.cachedBytes, s.arenaLiveBytes, s.arenaCapacityBytes, s.inflightRequests]).toEqual([
      0, 0, 0, 0,
    ])
  })

  it('does not republish the resident tile count under a second name', () => {
    // `tilesCached` has always been that number. A `gpuTilesResident` beside it
    // would be two authorities for one value — they can only ever drift apart,
    // and a host reading the wrong one budgets against nothing. What #1355 was
    // missing was the CAP, not the count.
    const keys = Object.keys(new StatsTracker().get())
    expect(keys).toContain('gpuTilesBudget')
    expect(keys).toContain('tilesCached')
    expect(keys).not.toContain('gpuTilesResident')
  })
})

describe('the accessors the telemetry reads (#1355)', () => {
  it('TileCatalog reports its enforced byte total alongside the counts', () => {
    const c = new TileCatalog()
    expect(c.getStateBreakdown().bytes).toBe(0)
    // It rides on the existing diagnostics breakdown rather than a new getter:
    // that breakdown already reports cached/loading for inspectPipeline, and a
    // count without its cost is what #1355 exists to fix.
    expect(Object.keys(c.getStateBreakdown()).sort()).toEqual(['bytes', 'cached', 'loading'])
  })

  it('a store whose arenas were never created reports 0, not its reservations', () => {
    // All three arenas are lazily built. Reporting their would-be CAPACITY
    // before creation would show 192 MB resident on a map that never drew a
    // polygon — the opposite of what a memory readout is for.
    const dev = mockDevice()
    const store = new GpuTileStore(dev, new WebGpuDevice(dev))
    expect(arenaByteTotals(store)).toEqual({ live: 0, capacity: 0 })
  })

  it('sums the created arenas, so a live one is not hidden by two null ones', () => {
    // The 0-case above passes just as well for a function that returns a
    // constant. This is the half that pins the summation itself.
    expect(
      arenaByteTotals({
        polyVertexArenaOrNull: () => ({ liveUsedBytes: 100, capacityBytes: 1000 }),
        polyIndexArenaOrNull: () => null,
        zBufferArenaOrNull: () => ({ liveUsedBytes: 7, capacityBytes: 70 }),
      }),
    ).toEqual({ live: 107, capacity: 1070 })
  })
})
