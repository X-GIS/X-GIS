// Differential extraction test for `computeZoomDirectionPrefetchKeys`
// (engine/tile-decision.ts) — the Tier-2 zoom-direction prefetch tile-set
// math lifted VERBATIM out of VectorTileRenderer.render().
//
// The extraction MUST be byte-faithful: same key set, same order, same
// empties, across every direction/route/pitch branch the inline block
// hit. We pin that by re-implementing the ORIGINAL inline block here
// (`inlineReference`, copied from the pre-extraction render() source)
// and asserting the extracted fn returns the EXACT same array, driven by
// the same live `Camera`, the same real selectors, and the same
// `isCached` predicate.
//
// Why a differential (not golden literals): the frustum selectors call
// `camera.getRTCMatrix` / `unprojectToZ0` (pure matrix math, no GPU), so
// both the reference and the SUT consume the identical camera and must
// agree key-for-key. If the extraction dropped, reordered, or re-routed
// any key, `inlineReference` and `computeZoomDirectionPrefetchKeys`
// diverge and the deep-equal fails.
//
// FAIL-BEFORE: established by perturbing the SUT (e.g. swapping the
// `pitch < 30` selector routing, or flipping the `!isCached` skip to
// `isCached`) — every such mutation makes at least one scenario's array
// differ from `inlineReference`, turning the suite RED. Verified locally
// before finalizing (see the executor report).

import { describe, expect, it } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { Camera } from './projection/camera'
import {
  visibleTilesFrustum, visibleTilesFrustumSampled, makeTileCoord,
} from '../data/tile-select'
import { globeVisibleTiles } from './projection/globe'
import {
  mercator as mercatorProj, getProjection, type Projection, mercatorYToLat,
} from './projection/projection'
import { routeToSphereSelector } from './gpu/gpu-shared'
import { computeZoomDirectionPrefetchKeys } from './tile-decision'

const W = 1024
const H = 768
const DPR = 1
// Same offsetMarginPx magnitude the render() path computes for a typical
// stroked layer — value doesn't matter for parity as long as both sides
// pass the SAME one.
const OFFSET_MARGIN_PX = 6
const MAX_SUB_TILE_Z = 22

/** Build a real Camera (mercator centre over Korea), matching the
 *  tile-selection tests' construction pattern. */
function makeCam(
  zoom: number,
  pitch: number,
  globeMode: boolean,
  lon = 127,
  lat = 37,
  bearing = 0,
): Camera {
  const c = new Camera(lon, lat, zoom)
  c.pitch = pitch
  c.bearing = bearing
  c.globeMode = globeMode
  return c
}

/** EXACT copy of the pre-extraction inline render() block (former VTR
 *  lines ~3252-3306), minus the `cameraIdle && frameCount%6` guard and
 *  the `this.source.prefetchTiles(...)` side effect — those stay inline
 *  at the call site and are out of scope for this math. Returns the
 *  `prefetchKeys` array the old block would have built. */
function inlineReference(
  camera: Camera,
  currentZ: number,
  maxSubTileZ: number,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number,
  selectorProj: Projection,
  offsetMarginPx: number,
  sliceCached: (k: number) => boolean,
): number[] {
  let prefetchZ = -1
  if (camera.zoom > currentZ + 0.5 && currentZ + 1 <= maxSubTileZ) {
    prefetchZ = currentZ + 1
  } else if (camera.zoom < currentZ && currentZ - 1 >= 0) {
    prefetchZ = currentZ - 1
  }
  if (prefetchZ < 0) return []
  const projTypePF = (camera as { projType?: number }).projType ?? 0
  const prefetchTiles = routeToSphereSelector(projTypePF, camera.globeMode)
    ? (() => {
        const R = 6378137
        const lonPF = camera.centerX / R * (180 / Math.PI)
        const latPF = mercatorYToLat(camera.centerY)
        const cssWPF = canvasWidth / dpr
        const cssHPF = canvasHeight / dpr
        return globeVisibleTiles(
          lonPF, latPF, camera.zoom, prefetchZ, cssWPF, cssHPF,
          camera.pitch ?? 0, camera.bearing ?? 0,
        ).map(t => makeTileCoord(t.z, t.x, t.y, 0))
      })()
    : (camera.pitch ?? 0) < 30
    ? visibleTilesFrustumSampled(
        camera, selectorProj, prefetchZ,
        canvasWidth, canvasHeight, offsetMarginPx, dpr,
      )
    : visibleTilesFrustum(
        camera, selectorProj, prefetchZ,
        canvasWidth, canvasHeight, offsetMarginPx, dpr,
      )
  const prefetchKeys: number[] = []
  for (const t of prefetchTiles) {
    const k = tileKey(t.z, t.x, t.y)
    if (!sliceCached(k)) {
      prefetchKeys.push(k)
    }
  }
  return prefetchKeys
}

/** Drive both the reference and the SUT with identical inputs and return
 *  the two arrays for comparison. */
function bothPaths(opts: {
  camera: Camera
  currentZ: number
  selectorProj: Projection
  cached?: Set<number>
}): { ref: number[]; got: number[] } {
  const { camera, currentZ, selectorProj } = opts
  const cached = opts.cached ?? new Set<number>()
  const isCached = (k: number): boolean => cached.has(k)
  const ref = inlineReference(
    camera, currentZ, MAX_SUB_TILE_Z, W, H, DPR, selectorProj, OFFSET_MARGIN_PX, isCached,
  )
  const got = computeZoomDirectionPrefetchKeys({
    camera,
    cameraZoom: camera.zoom,
    currentZ,
    maxSubTileZ: MAX_SUB_TILE_Z,
    projType: (camera as { projType?: number }).projType ?? 0,
    globeMode: camera.globeMode,
    centerX: camera.centerX,
    centerY: camera.centerY,
    pitch: camera.pitch ?? 0,
    bearing: camera.bearing ?? 0,
    canvasWidth: W,
    canvasHeight: H,
    dpr: DPR,
    selectorProj,
    offsetMarginPx: OFFSET_MARGIN_PX,
    isCached,
  })
  return { ref, got }
}

describe('computeZoomDirectionPrefetchKeys — byte-faithful extraction of the VTR Tier-2 block', () => {
  it('zoom-in (zoom > currentZ + 0.5), flat mercator route: matches inline + non-empty', () => {
    // zoom 8.7 vs currentZ 8 → prefetchZ = 9 (zoom-in branch).
    const cam = makeCam(8.7, 0, false)
    const selectorProj = mercatorProj
    const { ref, got } = bothPaths({ camera: cam, currentZ: 8, selectorProj })
    expect(got).toEqual(ref)
    // Sanity: the zoom-in branch actually produces tiles at prefetchZ=9,
    // so the parity assertion is meaningful (not vacuously equal-empty).
    expect(got.length).toBeGreaterThan(0)
  })

  it('zoom-out (zoom < currentZ), flat mercator route: matches inline + non-empty', () => {
    // zoom 7.2 vs currentZ 8 → prefetchZ = 7 (zoom-out branch).
    const cam = makeCam(7.2, 0, false)
    const { ref, got } = bothPaths({ camera: cam, currentZ: 8, selectorProj: mercatorProj })
    expect(got).toEqual(ref)
    expect(got.length).toBeGreaterThan(0)
  })

  it('no-direction (currentZ <= zoom <= currentZ + 0.5): empty, matches inline', () => {
    // zoom 8.3 vs currentZ 8 → neither branch fires (not > 8.5, not < 8).
    const cam = makeCam(8.3, 0, false)
    const { ref, got } = bothPaths({ camera: cam, currentZ: 8, selectorProj: mercatorProj })
    expect(got).toEqual([])
    expect(ref).toEqual([])
  })

  it('globe route (globeMode=true): matches inline globeVisibleTiles path + non-empty', () => {
    const cam = makeCam(8.7, 0, true)
    // selectorProj is ignored on the sphere route, but pass the realistic
    // one render() would build so the call shape matches production.
    const selectorProj = mercatorProj
    const { ref, got } = bothPaths({ camera: cam, currentZ: 8, selectorProj })
    expect(got).toEqual(ref)
    expect(got.length).toBeGreaterThan(0)
  })

  it('high-pitch flat route (pitch > 30 → exact frustum, not sampled): matches inline', () => {
    // pitch 45 > 30 → the inline block uses visibleTilesFrustum (exact),
    // NOT visibleTilesFrustumSampled. If the extraction crossed the 30
    // threshold the wrong way, the arrays diverge.
    const cam = makeCam(8.7, 45, false)
    const { ref, got } = bothPaths({ camera: cam, currentZ: 8, selectorProj: mercatorProj })
    expect(got).toEqual(ref)
    expect(got.length).toBeGreaterThan(0)
  })

  it('non-mercator flat selectorProj (equirectangular) zoom-in: matches inline', () => {
    // projType 1 (equirectangular) is flat → flat-selector route with a
    // non-trivial selectorProj, the same getProjection(...) render() builds.
    const cam = makeCam(8.7, 0, false)
    ;(cam as { projType: number }).projType = 1
    const selectorProj = getProjection('equirectangular', cam.centerX / 6378137 * (180 / Math.PI), 37)
    const { ref, got } = bothPaths({ camera: cam, currentZ: 8, selectorProj })
    expect(got).toEqual(ref)
  })

  it('respects isCached: already-cached keys are skipped identically on both paths', () => {
    const cam = makeCam(8.7, 0, false)
    // First, learn the full uncached key set.
    const full = bothPaths({ camera: cam, currentZ: 8, selectorProj: mercatorProj })
    expect(full.got).toEqual(full.ref)
    expect(full.got.length).toBeGreaterThan(1)
    // Now mark the first key as cached — both paths must drop exactly it.
    const cached = new Set<number>([full.got[0]!])
    const { ref, got } = bothPaths({ camera: cam, currentZ: 8, selectorProj: mercatorProj, cached })
    expect(got).toEqual(ref)
    expect(got).not.toContain(full.got[0]!)
    expect(got.length).toBe(full.got.length - 1)
  })

  it('clamps at the LOD floor (currentZ=0 zoom-out → empty) identically', () => {
    // zoom 0 < currentZ would need currentZ>0; at currentZ=0 the zoom-out
    // branch requires currentZ-1 >= 0 → false, so empty regardless.
    const cam = makeCam(0, 0, false)
    cam.zoom = -0.5 // below currentZ=0 but floor guard blocks prefetchZ=-1
    const { ref, got } = bothPaths({ camera: cam, currentZ: 0, selectorProj: mercatorProj })
    expect(got).toEqual([])
    expect(ref).toEqual([])
  })
})
