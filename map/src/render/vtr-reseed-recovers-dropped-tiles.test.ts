// #1728 — `reseedTiles()` must be able to RECOVER a source, not just swap one that is
// already drawing.
//
// The defect: the key set it handed `refreshTiles` was the renderer's GPU-resident set alone.
// `TileCatalog.requestTiles` deliberately skips a cached key and `refreshTiles` is the only
// override, so a key the catalog holds but this renderer does not is unreachable — no path
// will ever ask the new backend to produce it.
//
// That is not a corner: a host that CLEARS a source before refilling it (the ordinary
// setSourceData shape) pushes an empty FeatureCollection, `applyReplacedTiles` drops the now-
// empty tile, and the NEXT push then finds `keys.size === 0` and skips the refresh entirely.
// Measured on the measure-distances demo: two clicks, `reseedTiles keys=1` then
// `reseedTiles keys=0`, the pushed LineString never tiled, and the amber connector never drew
// (`maxRun=8px` against a 170px threshold in `_1235-measure-gate.spec.ts`).
//
// The fix has two halves and BOTH are load-bearing — verified by severing each on its own,
// which makes the two positive arms fail identically (`expected [] to deeply equal [19, 25]`):
// the catalog folds its cached keys into the refresh queue, and the renderer calls
// `refreshTiles` unconditionally instead of guarding on `keys.size > 0`.
//
// Driven through the WebGPU stub so a real VectorTileRenderer + a real TileCatalog are on both
// ends of the seam — the wire under test is `reseedTiles → catalog.refreshTiles →
// requestTiles(force) → backend.loadTile(force)`, and stubbing either end would test the
// test. The renderer's `_store` stays empty on purpose: that IS the state the bug needs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { initGPU } from '@xgis/rhi-webgpu'
import { VectorTileRenderer } from '@xgis/map'
import { TileCatalog, TILE_LAYOUT_VERSION, type TileSource, type TileSourceSink } from '@xgis/data'
import { tileKey } from '@xgis/compiler'

let stub: StubInstallation

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800
      height = 600
      getContext(_t: string): unknown {
        return null
      }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => {
  stub.uninstall()
})

/** Records every loadTile call with its `force` flag. `empty` produces the placeholder an
 *  empty FeatureCollection yields — `acceptResult(key, null)` — which is precisely the cached
 *  state the bug leaves behind and the one that has to be re-producible. */
function fakeBackend(empty: boolean): TileSource & {
  calls: Array<{ key: number; force: boolean }>
} {
  let sink: TileSourceSink | null = null
  const calls: Array<{ key: number; force: boolean }> = []
  return {
    calls,
    meta: {
      bounds: [-180, -85, 180, 85],
      minZoom: 0,
      maxZoom: 14,
      scheme: 'web-mercator-xyz',
      layoutVersion: TILE_LAYOUT_VERSION,
    },
    has: () => true,
    attach: (s) => void (sink = s),
    loadTile: (key, force = false) => {
      calls.push({ key, force })
      if (empty) sink?.acceptResult(key, null)
      else
        sink?.acceptResult(key, {
          vertices: new Float32Array(0),
          dequantScale: 1,
          dequantHalf: 0,
          indices: new Uint32Array(0),
          lineVertices: Float32Array.of(1, 2, 3, 4),
          lineIndices: Uint32Array.of(0, 1),
        })
    },
  }
}

const K1 = tileKey(2, 1, 1)
const K2 = tileKey(2, 1, 2)
const NEVER_REQUESTED = tileKey(2, 3, 3)

async function makeRenderer(): Promise<VectorTileRenderer> {
  const canvas = { width: 1024, height: 720 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return new VectorTileRenderer(await initGPU(canvas))
}

describe('reseedTiles recovers a source with no GPU-resident tiles (#1728)', () => {
  it('refreshes a key the CATALOG caches but this renderer never uploaded', async () => {
    const first = fakeBackend(true) // the empty push: caches the placeholder
    const catalog = new TileCatalog()
    catalog.attachBackend(first)
    catalog.requestTiles([K1, K2])
    // Precondition — the exact state the bug needs: the catalog holds the keys, the renderer
    // holds nothing. Without this the arm below could pass for the pre-fix reason.
    expect([catalog.hasTileData(K1), catalog.hasTileData(K2)]).toEqual([true, true])

    const vtr = await makeRenderer()
    vtr.setSource(catalog)
    expect(vtr.getCacheSize(), 'renderer has no GPU-resident tile').toBe(0)

    // The refilling push: swap in a backend that DOES produce geometry, then re-seed.
    const second = fakeBackend(false)
    catalog.detachBackend(first)
    catalog.attachBackend(second)
    vtr.reseedTiles()

    const forced = second.calls.filter((c) => c.force).map((c) => c.key)
    expect(forced.sort(), 'both cached keys were re-requested, with force').toEqual([K1, K2].sort())
    vtr.destroy()
  })

  it('does not invent a key neither side holds', async () => {
    // Non-vacuity for the arm above: it must be reporting the catalog's cache, not "every key
    // the backend would answer for" (`has: () => true` above answers for all of them).
    const first = fakeBackend(true)
    const catalog = new TileCatalog()
    catalog.attachBackend(first)
    catalog.requestTiles([K1])

    const vtr = await makeRenderer()
    vtr.setSource(catalog)
    const second = fakeBackend(false)
    catalog.detachBackend(first)
    catalog.attachBackend(second)
    vtr.reseedTiles()

    const forced = second.calls.filter((c) => c.force).map((c) => c.key)
    expect(forced).toContain(K1)
    expect(forced, 'a key nobody cached is not re-requested').not.toContain(NEVER_REQUESTED)
    vtr.destroy()
  })

  it('an empty source with nothing cached asks for nothing — no spurious refresh', async () => {
    // The other direction. Recovery must not become "refresh unconditionally": with neither a
    // cache nor GPU tiles there is nothing stale, and the normal per-frame request path serves
    // the source. A refresh here would re-tile keys the camera never asked for.
    const catalog = new TileCatalog()
    const backend = fakeBackend(false)
    catalog.attachBackend(backend)

    const vtr = await makeRenderer()
    vtr.setSource(catalog)
    vtr.reseedTiles()

    expect(backend.calls, 'nothing cached, nothing resident ⇒ no request').toEqual([])
    vtr.destroy()
  })
})
