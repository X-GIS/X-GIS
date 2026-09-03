// ═══ #2384 F-4 — a template change must drop the old source's tiles ═══
//
// Three facts composed into visible wrong pixels:
//
//   1. `setUrlTemplate` cleared `failedTiles` on a URL change but not `tileCache`;
//   2. the cache key is `z/x/y` with NO url in it, so the old source's tile and
//      the new source's tile are the same key;
//   3. visible tiles are exempt from eviction (`evictToBudget` filters
//      `visibleKeys`), so what was on screen was exactly what could never be
//      reclaimed.
//
// Change a live map's raster template and the draw path's `tileCache.get(key)`
// returned the PREVIOUS source's texture — and kept returning it for as long as
// the tile stayed visible. The hillshade twin was identical.
//
// The assertions are about RELEASE, not just about the map being empty: a bare
// `cache.clear()` would satisfy "the cache is empty" while stranding every GPU
// texture — in an ownership series, the defect this track exists to remove.
// In-flight loads are the second facet: a request issued against the OLD url
// that resolves after the swap lands under the same key, so a flush alone would
// let stale imagery back in through the door.

import { describe, it, expect } from 'vitest'
import { RasterRenderer } from './raster-renderer'
import { HillshadeRenderer } from './hillshade-renderer'
import { DemTileStore } from './dem-tile-store'
import type { RhiDevice, RhiTexture } from '@xgis/rhi'

/** Records texture destruction so the test can tell RELEASED from merely dropped. */
function recordingRhi() {
  const destroyed: RhiTexture[] = []
  const rhi = {
    destroyTexture: (t: RhiTexture) => void destroyed.push(t),
    createTexture: () => ({ __tex: true }) as unknown as RhiTexture,
    createSampler: () => ({}),
    destroySampler: () => {},
    createBuffer: () => ({}),
    destroyBuffer: () => {},
    createBindGroup: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipeline: () => ({}),
    destroyPipeline: () => {},
    createView: () => ({}),
    writeBuffer: () => {},
    backend: 'webgpu',
    caps: {},
  }
  return { rhi: rhi as unknown as RhiDevice, destroyed }
}

const tile = (tag: string) => ({
  texture: { __tag: tag } as unknown as RhiTexture,
  bytes: 1024,
  lastUsedFrame: 0,
  firstShownMs: -1,
})

/** Seed a renderer's private cache + in-flight ledger without booting a GPU:
 *  what is under test is the swap bookkeeping, not any draw. */
function seeded(renderer: object) {
  const cache = new Map<string, ReturnType<typeof tile>>([
    ['0/0/0', tile('a')],
    ['1/0/0', tile('b')],
  ])
  const aborted: string[] = []
  const loading = new Map<string, { abort: () => void }>([
    ['2/1/1', { abort: () => void aborted.push('2/1/1') }],
  ])
  const clearedFailures: number[] = []
  Object.assign(renderer, {
    tileCache: cache,
    loadingTiles: loading,
    _cachedBytes: 2048,
    // The backoff ledger the URL-change branch ALREADY cleared before this fix —
    // stubbed so a missing member cannot make the arms below fail for a reason
    // that is not the defect.
    failedTiles: { clearAll: () => void clearedFailures.push(1) },
  })
  return { cache, loading, aborted, clearedFailures }
}

type Swappable = { setUrlTemplate(url: string, scheme?: undefined): void }

/** `swap` receives setUrlTemplate; `store` owns the residency this asserts about.
 *  They are the same object for raster and DIFFERENT for hillshade, whose DEM
 *  residency lives in `DemTileStore` (#2268) — so the hillshade row exercises the
 *  delegation too, and a renderer that stopped forwarding would red here. */
type Subject = { swap: Swappable; store: object }

/** Both sources carry the same defect and take the same fix, so both are driven
 *  through one table — a fix applied to only one would red here. */
const RENDERERS: Array<[string, () => Subject]> = [
  [
    'RasterRenderer',
    () => {
      const r = Object.create(RasterRenderer.prototype) as object
      return { swap: r as Swappable, store: r }
    },
  ],
  [
    'HillshadeRenderer -> DemTileStore',
    () => {
      const dem = Object.create(DemTileStore.prototype) as object
      const r = Object.create(HillshadeRenderer.prototype) as object
      Object.assign(r, { dem })
      // The store reaches its draper through a THUNK, not a stored reference
      // (#1578 replaces the draper on every quality flip) — so the seam the test
      // fills is a function, matching how the renderer actually constructs it.
      Object.assign(dem, { draperOf: () => undefined })
      return { swap: r as Swappable, store: dem }
    },
  ],
]

describe.each(RENDERERS)('#2384 F-4 — %s.setUrlTemplate drops the old source', (_name, make) => {
  it('DESTROYS every cached tile texture, not just the map entries', () => {
    const { rhi, destroyed } = recordingRhi()
    const { swap, store } = make()
    const { cache } = seeded(store)
    Object.assign(store, {
      rhi,
      urlTemplate: 'https://old/{z}/{x}/{y}.png',
      _cachedTemplate: 'https://old/{z}/{x}/{y}.png',
    })
    swap.setUrlTemplate('https://new/{z}/{x}/{y}.png')

    expect(cache.size, 'the old source’s tiles are gone from the cache').toBe(0)
    expect(
      destroyed.map((t) => (t as unknown as { __tag: string }).__tag).sort(),
      'and their GPU textures were RELEASED, not stranded',
    ).toEqual(['a', 'b'])
    expect((store as { _cachedBytes: number })._cachedBytes, 'the byte accumulator resets').toBe(0)
  })

  it('ABORTS loads issued against the old url', () => {
    const { rhi } = recordingRhi()
    const { swap, store } = make()
    const { loading, aborted } = seeded(store)
    Object.assign(store, {
      rhi,
      urlTemplate: 'https://old/{z}/{x}/{y}.png',
      _cachedTemplate: 'https://old/{z}/{x}/{y}.png',
    })
    swap.setUrlTemplate('https://new/{z}/{x}/{y}.png')

    expect(aborted, 'an in-flight old-url read must not land under the new template').toEqual([
      '2/1/1',
    ])
    expect(loading.size, 'and the ledger is emptied').toBe(0)
  })

  it('the rebuildLayers ROUND-TRIP (X -> "" -> X) keeps its tiles', () => {
    // THE case that decides the guard. `rebuildLayers()` resets every raster
    // renderer with `setUrlTemplate('')` before re-arming the live one
    // (map.ts:3485), so a flush keyed on `url !== this.urlTemplate` would
    // destroy every visible tile on each projection change or layer rebuild —
    // a correctness fix paid for with a full re-download of the whole viewport.
    const { rhi, destroyed } = recordingRhi()
    const { swap, store } = make()
    const { cache } = seeded(store)
    const URL = 'https://same/{z}/{x}/{y}.png'
    Object.assign(store, { rhi, urlTemplate: URL, _cachedTemplate: URL })
    swap.setUrlTemplate('') // the reset half of the rebuild
    swap.setUrlTemplate(URL) // re-armed with the SAME source
    expect(cache.size, 'a rebuild must not cost the viewport its tiles').toBe(2)
    expect(destroyed, 'and must destroy nothing').toEqual([])
  })

  it('the round-trip to a DIFFERENT source still drops (X -> "" -> Y)', () => {
    // The mirror of the arm above: the reset must not launder a real swap into
    // a no-op, which is how a naive "ignore empty" guard would fail.
    const { rhi, destroyed } = recordingRhi()
    const { swap, store } = make()
    const { cache } = seeded(store)
    Object.assign(store, {
      rhi,
      urlTemplate: 'https://old/{z}/{x}/{y}.png',
      _cachedTemplate: 'https://old/{z}/{x}/{y}.png',
    })
    swap.setUrlTemplate('')
    swap.setUrlTemplate('https://new/{z}/{x}/{y}.png')
    expect(cache.size, 'the old source’s tiles are gone').toBe(0)
    expect(destroyed, 'and were released').toHaveLength(2)
  })

  it('CONTROL — the SAME url drops nothing (this runs on every rebuildLayers)', () => {
    // Without this the fix could flush unconditionally, destroying the whole
    // cache on every layer rebuild — a correctness win paid for with a
    // per-frame texture churn nobody asked for.
    const { rhi, destroyed } = recordingRhi()
    const { swap, store } = make()
    const { cache, aborted } = seeded(store)
    Object.assign(store, {
      rhi,
      urlTemplate: 'https://same/{z}/{x}/{y}.png',
      _cachedTemplate: 'https://same/{z}/{x}/{y}.png',
    })
    swap.setUrlTemplate('https://same/{z}/{x}/{y}.png')

    expect(cache.size, 'an unchanged template keeps its tiles').toBe(2)
    expect(destroyed, 'and destroys nothing').toEqual([])
    expect(aborted, 'and aborts nothing').toEqual([])
  })
})
