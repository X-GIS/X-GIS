// Byte gate for the raster-family GPU texture caches (#1352).
//
// THE BUG THIS PINS: RasterRenderer and HillshadeRenderer bounded tileCache by
// ENTRY COUNT only (MAX_CACHED_TILES = 256) while creating each texture at the
// DECODED BITMAP's actual dimensions — never at the source's declared tileSize,
// which is used only for the LOD zoom bias. Per-entry cost is therefore
// publisher-controlled and a count cap cannot bound the total: 256 entries of a
// 2048² satellite source is 4 GB with tileCache.size reporting a healthy 256
// throughout. The two renderers hold independent caches, so a style using both
// doubles it.
//
// THE FIX: a `_cachedBytes` accumulator maintained by the single insert
// authority (_cacheTile) and by evictTiles, with beginFrame()/evictTiles
// draining on `count > cap || bytes > byteCap` and RE-TESTING the budget each
// step — byte pressure can demand far more evictions than a count overflow
// implies, and at 40 huge tiles the count cap does not fire at all.
//
// HOW THIS TEST WORKS: both renderers' constructors are just
// `device/rhi/format = ctx.*` with no GPU work (raster-renderer.ts:330,
// hillshade-renderer.ts:373), so a mock ctx reaches the REAL cache and the REAL
// evictTiles. `_rasterDraper`/`_hillshadeDraper` stay undefined, so the
// `?.dropTexture` inside the loop is an inert no-op.

import { describe, expect, it, vi, afterEach } from 'vitest'
import type { GPUContext } from '@xgis/rhi-webgpu'
import { RasterRenderer } from './raster-renderer'
import { HillshadeRenderer } from './hillshade-renderer'
import { maxRasterCachedBytes, textureBytesOf, type LoadedTexture } from './raster-cache-budget'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubViewport(width: number, pointer: 'coarse' | 'fine'): void {
  vi.stubGlobal('window', { innerWidth: width })
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('coarse') ? pointer === 'coarse' : pointer === 'fine',
    media: q,
  }))
}

interface MockTexture {
  destroyed: boolean
  destroy(): void
}
function mockTexture(): MockTexture {
  const t: MockTexture = {
    destroyed: false,
    destroy() {
      t.destroyed = true
    },
  }
  return t
}

/** `backend: 'webgpu'` so evictTiles takes the `texture.destroy()` arm. */
function mockCtx(): GPUContext {
  return {
    device: {} as GPUDevice,
    rhi: { backend: 'webgpu', destroyTexture() {} },
    format: 'bgra8unorm',
  } as unknown as GPUContext
}

/** The private surface both renderers share. TS `private` is not a runtime
 *  barrier, and reaching the real loop is the whole point of this file. */
interface CachePrivates {
  _cacheTile(key: string, loaded: LoadedTexture): void
  evictTiles(visibleKeys: Set<string>): void
  tileCache: Map<string, { bytes: number }>
  _cachedBytes: number
}
const privatesOf = (r: RasterRenderer | HillshadeRenderer): CachePrivates =>
  r as unknown as CachePrivates

/** Admit `n` tiles of `dim`² through the renderer's real insert path. */
function admit(r: CachePrivates, n: number, dim: number): MockTexture[] {
  const textures: MockTexture[] = []
  for (let i = 0; i < n; i++) {
    const texture = mockTexture()
    textures.push(texture)
    r._cacheTile(`${dim}/${i}`, {
      texture: texture as unknown as GPUTexture,
      bytes: textureBytesOf(dim, dim, true),
    })
  }
  return textures
}

describe('raster cache byte budget — the pure ceiling (#1352)', () => {
  it('costs a texture by its DECODED dimensions, which is what the count cap missed', () => {
    // The whole defect in one line: entries are equal, bytes are not.
    //
    // Values include the MIP CHAIN as of #1436 — raster tiles are created with one now, and a
    // cost function that still returned the base level would let the cache sit a third over its
    // ceiling while reporting itself inside it. 4/3 exactly, for a power-of-two square.
    expect(textureBytesOf(256, 256, true)).toBe(349_524)
    expect(textureBytesOf(256, 256, true) / (256 * 256 * 4)).toBeCloseTo(4 / 3, 4)
    expect(textureBytesOf(2048, 2048, true)).toBe(22_369_620)
    // Still ~64x — area still dominates, which is the point. No longer EXACTLY 64: the chain's
    // 1x1 tail does not scale with the base, so the two pyramids differ by 21 texels' worth.
    expect(textureBytesOf(2048, 2048, true) / textureBytesOf(256, 256, true)).toBeCloseTo(64, 3)
  })

  it('leaves ordinary 256² sources governed by the COUNT cap, not throttled by bytes', () => {
    // The byte cap must not become the binding constraint for normal tiles, or
    // it would silently shrink the working set every existing style relies on.
    stubViewport(1440, 'fine')
    expect(256 * textureBytesOf(256, 256, true)).toBeLessThan(maxRasterCachedBytes())
  })

  it('routes the viewport class through isMobileClassViewport, not a raw width', () => {
    // #1350: a small DESKTOP window (fine pointer) must keep the desktop budget.
    stubViewport(860, 'fine')
    const smallDesktop = maxRasterCachedBytes()
    stubViewport(1440, 'fine')
    expect(smallDesktop, '860px + fine pointer is a desktop, not a phone').toBe(
      maxRasterCachedBytes(),
    )

    stubViewport(390, 'coarse')
    expect(maxRasterCachedBytes(), 'a real phone gets a smaller budget').toBeLessThan(smallDesktop)
  })
})

describe.each([
  ['RasterRenderer', () => new RasterRenderer(mockCtx())],
  ['HillshadeRenderer', () => new HillshadeRenderer(mockCtx())],
] as const)('%s bounds its texture cache by BYTES (#1352)', (_name, make) => {
  it('evicts under byte pressure the count cap never sees', () => {
    stubViewport(1440, 'fine')
    const r = privatesOf(make())

    // 40 × 2048² = 640 MB. Forty entries is FAR under the 256 count cap, so a
    // count-only bound evicts nothing and the cache stays hundreds of MB over.
    const textures = admit(r, 40, 2048)
    expect(r.tileCache.size, 'premise: the count cap cannot fire at 40').toBeLessThan(256)
    expect(r._cachedBytes).toBeGreaterThan(maxRasterCachedBytes())

    r.evictTiles(new Set())

    expect(r._cachedBytes, 'must drain to the byte budget').toBeLessThanOrEqual(
      maxRasterCachedBytes(),
    )
    expect(
      textures.some((t) => t.destroyed),
      'evicted textures must be freed, not just dropped',
    ).toBe(true)
    // Accounting must track the map, not drift from it.
    const summed = [...r.tileCache.values()].reduce((a, t) => a + t.bytes, 0)
    expect(r._cachedBytes, '_cachedBytes must equal the sum of what is resident').toBe(summed)
  })

  it('never evicts a texture the current frame is about to sample', () => {
    stubViewport(1440, 'fine')
    const r = privatesOf(make())
    const textures = admit(r, 40, 2048)

    // Every key visible ⇒ nothing is eligible, even though we are way over.
    const allVisible = new Set([...r.tileCache.keys()])
    r.evictTiles(allVisible)

    expect(
      textures.every((t) => !t.destroyed),
      'visible tiles are exempt — freeing one would sample a destroyed texture',
    ).toBe(true)
    expect(r.tileCache.size).toBe(40)
  })

  it('leaves a normal 256² working set completely alone', () => {
    stubViewport(1440, 'fine')
    const r = privatesOf(make())
    const textures = admit(r, 200, 256)

    r.evictTiles(new Set())

    expect(r.tileCache.size, '200 small tiles are under both caps').toBe(200)
    expect(textures.every((t) => !t.destroyed)).toBe(true)
  })
})
