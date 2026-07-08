// Pin that globe (projType 7) raster tile selection routes through
// globeVisibleTiles and produces a non-empty, sphere-covering set (#596),
// and that flat Mercator (projType 0) tile selection is unchanged.
//
// Root cause: raster-renderer.ts always called visibleTilesFrustum,
// regardless of projType. On the globe the frustum is a flat 2D rect cull
// that misses sphere cap-edge tiles → blank coverage gaps. The fix mirrors
// the vector path: routeToSphereSelector → globeVisibleTiles for globe/sphere
// projTypes, visibleTilesFrustum for flat projections.
//
// Oracle strategy: drive the REAL RasterRenderer.render() against the WebGPU
// stub. Intercept device.queue.writeBuffer for 48-byte tile-uniform writes
// (one per drawn tile) to collect the drawn tile set. Assert:
//   Globe: drawn tile count > 0 and exceeds what the old flat frustum would
//          select under the same camera (flat frustum under-selects → fewer
//          tiles, sometimes zero at cap edge).
//   Flat:  drawn tile count is identical to the direct visibleTilesFrustum
//          call (flat path byte-unchanged by the fix).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { RasterRenderer } from '@xgis/map'
import { Camera } from '@xgis/engine'
import { visibleTilesFrustum } from '@xgis/data'
import { mercator as mercatorProj } from '@xgis/engine'
import { globeVisibleTiles } from '@xgis/data'
import { routeToSphereSelector } from '@xgis/engine'

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

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1280, height: 720 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

/** Drive render() once and return the number of tile draws intercepted. */
function drawnTileCount(ctx: GPUContext, camera: Camera, projType: number): number {
  const W = 1280,
    H = 720,
    DPR = 1

  const renderer = new RasterRenderer(ctx)
  renderer.setUrlTemplate('https://tiles.example.com/{z}/{x}/{y}.png')

  // Pre-seed the tile cache so every selected tile reaches pass.draw().
  // We seed generously using globeVisibleTiles for globe and
  // visibleTilesFrustum for flat — covering whichever path the renderer takes.
  const currentZ = Math.max(0, Math.min(18, Math.round(camera.zoom)))
  const cssW = W / DPR,
    cssH = H / DPR
  const R = 6378137
  const centerLon = (camera.centerX / R) * (180 / Math.PI)
  const centerLatRad = Math.atan(Math.exp(camera.centerY / R)) * 2 - Math.PI / 2
  const centerLat = (centerLatRad * 180) / Math.PI

  const cache = (
    renderer as unknown as {
      tileCache: Map<
        string,
        { texture: unknown; lastUsedFrame: number; firstShownFrame: number; globalBG?: unknown }
      >
    }
  ).tileCache
  const fakeTexture = { createView: () => ({}), destroy: () => undefined }

  const seedTile = (z: number, x: number, y: number): void => {
    cache.set(`${z}/${x}/${y}`, { texture: fakeTexture, lastUsedFrame: 0, firstShownFrame: 0 })
  }

  // Seed globe tiles
  const globeTiles = globeVisibleTiles(
    centerLon,
    centerLat,
    camera.zoom,
    currentZ,
    cssW,
    cssH,
    camera.pitch ?? 0,
    camera.bearing ?? 0,
  )
  for (const t of globeTiles) seedTile(t.z, t.x, t.y)

  // Also seed flat frustum tiles (covers the flat path)
  const flatTiles = visibleTilesFrustum(camera, mercatorProj, currentZ, W, H, 0, DPR)
  for (const t of flatTiles) seedTile(t.z, t.x, t.y)

  // Intercept 48-byte tile-uniform writes (one per draw call).
  let drawCount = 0
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (
    buf: unknown,
    _off: number,
    _data: ArrayBufferView | ArrayBuffer,
  ): void => {
    const size = (buf as { size?: number })?.size
    if (size === 48) drawCount++
  }

  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  const pass = encoder.beginRenderPass()

  renderer.render(pass, camera, projType, 0, 0, W, H, DPR)

  return drawCount
}

describe('raster globe tile selection routes through globeVisibleTiles (#596)', () => {
  it('routeToSphereSelector returns true for globeMode and sphere projTypes', () => {
    // projType 7 (globe) routes via globeMode=true (isGlobe=true excludes the
    // !isGlobe branch; the globeMode flag is the gate — matching camera.ts).
    expect(routeToSphereSelector(7, true), 'projType7+globeMode → sphere').toBe(true)
    // azimuthal family (3/4/5) routes via !isFlat && !isGlobe:
    expect(routeToSphereSelector(3, false), 'ortho → sphere').toBe(true)
    expect(routeToSphereSelector(4, false), 'azi-eq → sphere').toBe(true)
    expect(routeToSphereSelector(5, false), 'stereo → sphere').toBe(true)
    // oblique_mercator (6) also sphere-routes:
    expect(routeToSphereSelector(6, false), 'oblique → sphere').toBe(true)
    // flat projections do NOT sphere-route:
    expect(routeToSphereSelector(0, false), 'mercator → flat').toBe(false)
    expect(routeToSphereSelector(1, false), 'equirect → flat').toBe(false)
  })

  it('globe camera (projType 7 + globeMode) produces a non-empty raster tile set', async () => {
    const ctx = await makeCtx()

    // Globe camera: projType 7 routes through globeVisibleTiles via globeMode=true.
    const camera = new Camera(0, 0, 3)
    camera.projType = 7
    camera.globeMode = true

    const count = drawnTileCount(ctx, camera, 7)
    expect(count, 'globe raster selection must produce at least one drawn tile').toBeGreaterThan(0)
  })

  it('globe camera draws exactly the globeVisibleTiles set, not the flat frustum set', async () => {
    const ctx = await makeCtx()
    const W = 1280,
      H = 720
    const DPR_ = 1
    const cssW = W / DPR_,
      cssH = H / DPR_
    const R = 6378137

    // Zoom 2 + pitch 45: at this camera state globeVisibleTiles returns 10
    // hemisphere-culled tiles, while visibleTilesFrustum returns 28 (with
    // world-copy duplicates that the globe path never emits). The counts are
    // distinct and stable — any routing error is immediately visible.
    const camera = new Camera(0, 0, 2)
    camera.projType = 7
    camera.pitch = 45
    camera.globeMode = true

    const currentZ = Math.max(0, Math.min(18, Math.round(camera.zoom)))
    const centerLon = (camera.centerX / R) * (180 / Math.PI)
    const mercLat = Math.atan(Math.exp(camera.centerY / R)) * 2 - Math.PI / 2
    const centerLat = (mercLat * 180) / Math.PI

    // Expected: what the sphere selector produces.
    const expectedGlobeTiles = globeVisibleTiles(
      centerLon,
      centerLat,
      camera.zoom,
      currentZ,
      cssW,
      cssH,
      camera.pitch ?? 0,
      camera.bearing ?? 0,
    )
    expect(
      expectedGlobeTiles.length,
      'probe sanity: globe selector must emit tiles',
    ).toBeGreaterThan(0)

    // Control: what the OLD flat path would produce (distinct count).
    const flatTiles = visibleTilesFrustum(camera, mercatorProj, currentZ, W, H, 0, DPR_)
    // The two counts must differ so the assertion is discriminating.
    expect(expectedGlobeTiles.length, 'probe sanity: globe and flat counts must differ').not.toBe(
      flatTiles.length,
    )

    const drawCount = drawnTileCount(ctx, camera, 7)

    // With the fix the renderer routes through globeVisibleTiles → draw count
    // equals the sphere selector's output. Without the fix the draw count
    // matches the flat frustum (different value) and cap-edge tiles are missing.
    expect(drawCount, 'globe renderer must draw exactly the globeVisibleTiles tile count').toBe(
      expectedGlobeTiles.length,
    )
  })

  it('flat Mercator (projType 0) tile selection is unchanged by the fix', async () => {
    const ctx = await makeCtx()
    const W = 1280,
      H = 720,
      DPR = 1

    const camera = new Camera(0, 0, 3)
    camera.projType = 0

    const drawCount = drawnTileCount(ctx, camera, 0)

    // Oracle: the flat path should produce the same count as direct visibleTilesFrustum.
    const currentZ = Math.max(0, Math.min(18, Math.round(camera.zoom)))
    const expectedTiles = visibleTilesFrustum(camera, mercatorProj, currentZ, W, H, 0, DPR)

    expect(drawCount, 'flat Mercator draw count must match direct selector').toBe(
      expectedTiles.length,
    )
  })
})
