// ═══ #1570 — teardown must CANCEL in-flight work, not merely stop scheduling ═══
//
// `map.destroy()` returned and the network kept working for a map that no longer
// existed. Three subsystems, one shape: teardown stopped SCHEDULING but had no
// cancellation primitive for work already started.
//
// The legs verified here are the ones a unit test can actually reach. The coverage
// read leg is asserted through the map's guarded-fetch seam (its abort signal), the
// tile-fetch leg through the two renderers' new destroy(), and the WebGL2 orphan-
// texture leg through the device's liveness latch. The end-to-end "a destroy
// mid-transfer shows no further GETs in a server log" arm needs a browser and a
// server and is called out as unverified in the PR.

import { describe, it, expect } from 'vitest'
import { RasterRenderer } from './raster-renderer'
import { HillshadeRenderer } from './hillshade-renderer'
import { WebGl2Device } from '@xgis/rhi-webgl2'

/** Both renderers keep `loadingTiles: Map<string, AbortController>` and nothing
 *  fired those controllers on teardown — neither class had a destroy() at all, and
 *  `_releaseGpuResources` never named them. */
function seamOf(r: object): Map<string, AbortController> {
  return (r as unknown as { loadingTiles: Map<string, AbortController> }).loadingTiles
}

describe('#1570 raster/hillshade renderers abort their in-flight tile fetches', () => {
  for (const [name, Ctor] of [
    ['RasterRenderer', RasterRenderer],
    ['HillshadeRenderer', HillshadeRenderer],
  ] as const) {
    it(`${name}.destroy() aborts every loading controller and clears the ledger`, () => {
      // The constructors take a GPUContext they only stash until first render, so an
      // empty object is enough to reach the teardown path under test.
      const r = new (Ctor as unknown as new (ctx: unknown) => object)({} as never)
      const loading = seamOf(r)
      const a = new AbortController()
      const b = new AbortController()
      loading.set('3/1/2', a)
      loading.set('3/1/3', b)

      ;(r as unknown as { destroy(): void }).destroy()

      expect(a.signal.aborted, 'an in-flight leaf fetch is cancelled').toBe(true)
      expect(b.signal.aborted).toBe(true)
      expect(loading.size, 'and the ledger is dropped, not left holding dead entries').toBe(0)
    })
  }
})

describe('#1570 a destroyed WebGl2Device cannot allocate', () => {
  /** A minimal GL stand-in: `destroy()` only touches canvas listeners + the
   *  lose-context extension, and the allocation guard runs before any GL call. */
  function fakeGl(): WebGL2RenderingContext {
    return {
      canvas: undefined,
      getExtension: () => null,
      isContextLost: () => false,
      getSupportedExtensions: () => [],
      getParameter: () => 0,
    } as unknown as WebGL2RenderingContext
  }

  it('createTexture / createBuffer throw after destroy(), naming the reason', () => {
    const dev = new WebGl2Device(fakeGl())
    dev.destroy()
    // WebGL2 has no device OBJECT to invalidate: destroy() loses the CONTEXT, and
    // gpu.ts hands back and RESTORES the same `gl` on a remount — so without a latch
    // a stale device found a LIVE context and allocated into a cache nothing could
    // reach. Failing loud is what the caller's lost-context catch is written for.
    expect(() => dev.createTexture({ width: 4, height: 4, format: 'rgba8unorm' } as never)).toThrow(
      /destroyed device/,
    )
    expect(() => dev.createBuffer({ size: 16, usage: 'vertex' } as never)).toThrow(
      /destroyed device/,
    )
  })

  it('a LIVE device still allocates — the latch is not a blanket refusal', () => {
    const gl = fakeGl()
    const created: unknown[] = []
    ;(gl as unknown as Record<string, unknown>).createTexture = () => {
      const t = {}
      created.push(t)
      return t
    }
    ;(gl as unknown as Record<string, unknown>).bindTexture = () => {}
    ;(gl as unknown as Record<string, unknown>).texImage2D = () => {}
    ;(gl as unknown as Record<string, unknown>).texParameteri = () => {}
    const dev = new WebGl2Device(gl)
    expect(() =>
      dev.createTexture({ width: 4, height: 4, format: 'rgba8unorm' } as never),
    ).not.toThrow()
    expect(created.length).toBe(1)
  })
})
