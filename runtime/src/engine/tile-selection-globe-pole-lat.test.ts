// ═══ Globe tile-selection: centerLatDeg vs mercatorYToLat(centerY) ═══
//
// BUG (fix #3 / HIGH): When the globe camera is placed past 85.051129°
// (centerLatDeg=89, centerY saturated), BOTH the render-selector
// (tile-selection-cache.ts) and the prefetch-selector (tile-decision.ts)
// fed `globeVisibleTiles` the Mercator-bounded lat (~85.05) instead of
// the true lat (89). That makes the selected tile set wrong at the pole.
//
// FAIL-BEFORE: this test asserts that the prefetch path
// (`computeZoomDirectionPrefetchKeys`) uses the true centerLatDeg (89),
// not the saturated mercatorYToLat(centerY) (~85.05). Before the fix the
// assertion fails because the function reads centerY, not centerLatDeg.
//
// PASS-AFTER: after changing both sites to read
//   `representsCenterAs(projType) === 'lat-deg'
//     ? camera.centerLatDeg : mercatorYToLat(camera.centerY)`
// both selectors pass lat≈89 to globeVisibleTiles and the test passes.
//
// CPU-only — no GPU needed.
//
// NOTE: pole-region VISUAL correctness is selection-logic only here.
// A headed-GPU globe-pole screenshot follow-up is warranted to confirm
// the rendered tile set matches the selected one at extreme latitudes.

import { describe, expect, it } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { Camera } from '@xgis/map'
import { CameraController, type CameraControllerDeps } from '@xgis/map'
import { globeVisibleTiles } from '@xgis/data'
import { mercatorYToLat, mercator as mercatorProj } from '@xgis/geo'
import { computeZoomDirectionPrefetchKeys } from '@xgis/map'

const W = 800
const H = 800
const DPR = 1

// zoom=5, currentZ=4 → cameraZoom(5) > currentZ(4) + 0.5 → zoom-in branch → prefetchZ=5.
// At zoom=5 + maxZ=5 the two pole latitudes produce different (but both non-empty) tile sets
// (confirmed by probe: t1=36 t2=36, differ=true).
const ZOOM = 5
const CURRENT_Z = 4
const MAX_SUB_TILE_Z = 22

const MERC_SAT_LAT = 85.051129 // mercatorYToLat saturation ceiling (degrees)
const TRUE_LAT = 89 // pole-ward centre latitude

function makeController(cam: Camera): CameraController {
  const deps: CameraControllerDeps = {
    invalidate: () => {},
    getCanvas: () => {
      throw new Error('not used')
    },
    getCtxCanvas: () => undefined,
  }
  return new CameraController(cam, deps)
}

/** Build a globe camera at lon=0, lat=89 (pole-ward).
 *  After setCenter(0, 89):
 *    cam.centerLatDeg ≈ 89        (the TRUE latitude)
 *    mercatorYToLat(cam.centerY) ≈ 85.051129  (Mercator-saturated) */
function makeGlobeCameraAtPole(): Camera {
  const cam = new Camera(0, 0, ZOOM)
  cam.projType = 7
  cam.globeMode = true
  const ctrl = makeController(cam)
  ctrl.setCenter(0, TRUE_LAT)
  return cam
}

/** Compute the set of tileKeys that globeVisibleTiles returns for a given lat. */
function tileKeysForLat(lat: number): Set<number> {
  const tiles = globeVisibleTiles(0, lat, ZOOM, CURRENT_Z + 1, W / DPR, H / DPR)
  return new Set(tiles.map((t) => tileKey(t.z, t.x, t.y)))
}

// ─── Pre-condition: the two latitudes actually produce different tile sets ────

it('pre-condition: globeVisibleTiles differs between lat=85.05 (saturated) and lat=89 (true pole) at zoom=5', () => {
  const keysAtSat = tileKeysForLat(MERC_SAT_LAT)
  const keysAtTrue = tileKeysForLat(TRUE_LAT)

  // Both must be non-empty (otherwise the zoom is wrong).
  expect(keysAtSat.size, 'saturated-lat tile set must be non-empty').toBeGreaterThan(0)
  expect(keysAtTrue.size, 'true-lat tile set must be non-empty').toBeGreaterThan(0)

  // The sets must differ — otherwise the fix is unobservable at this zoom.
  let anyDiff = false
  for (const k of keysAtTrue)
    if (!keysAtSat.has(k)) {
      anyDiff = true
      break
    }
  if (!anyDiff)
    for (const k of keysAtSat)
      if (!keysAtTrue.has(k)) {
        anyDiff = true
        break
      }
  expect(anyDiff, 'globeVisibleTiles must differ between lat 85.05 and lat 89 at zoom=5').toBe(true)
})

// ─── Camera invariant ─────────────────────────────────────────────────────────

describe('globe pole-lat: prefetch selector uses true centerLatDeg (not saturated mercY)', () => {
  it('camera at lat=89 has centerLatDeg≈89 but mercatorYToLat(centerY)≈85.05 (pre-condition)', () => {
    const cam = makeGlobeCameraAtPole()
    expect(cam.centerLatDeg).toBeCloseTo(TRUE_LAT, 1)
    expect(mercatorYToLat(cam.centerY)).toBeCloseTo(MERC_SAT_LAT, 1)
  })

  // ─── MAIN REGRESSION ──────────────────────────────────────────────────────
  // FAIL-BEFORE: computeZoomDirectionPrefetchKeys reads mercatorYToLat(centerY)
  //   → lat≈85.05 → result matches keysAtSat, NOT keysAtTrue → overlapTrue=0 → FAIL.
  // PASS-AFTER: reads centerLatDeg → lat≈89 → result matches keysAtTrue → PASS.

  it('prefetch key set matches globeVisibleTiles(lat=89), not globeVisibleTiles(lat=85.05)', () => {
    const cam = makeGlobeCameraAtPole()

    const keysAtSat = tileKeysForLat(MERC_SAT_LAT)
    const keysAtTrue = tileKeysForLat(TRUE_LAT)

    const got = computeZoomDirectionPrefetchKeys({
      camera: cam,
      cameraZoom: ZOOM,
      currentZ: CURRENT_Z,
      maxSubTileZ: MAX_SUB_TILE_Z,
      projType: cam.projType,
      globeMode: cam.globeMode,
      centerX: cam.centerX,
      centerY: cam.centerY,
      pitch: 0,
      bearing: 0,
      canvasWidth: W,
      canvasHeight: H,
      dpr: DPR,
      selectorProj: mercatorProj,
      offsetMarginPx: 0,
      isCached: () => false,
    })
    const gotSet = new Set(got)

    // Count overlap with each ground-truth set.
    let overlapTrue = 0
    let overlapSat = 0
    for (const k of gotSet) {
      if (keysAtTrue.has(k)) overlapTrue++
      if (keysAtSat.has(k)) overlapSat++
    }

    // The result must include tiles from the true-lat (89°) selection.
    // Before the fix the function feeds lat≈85.05, so overlapTrue=0 → FAILS here.
    expect(
      overlapTrue,
      'prefetch result must include tiles from the true-lat (89°) selection',
    ).toBeGreaterThan(0)

    // The result must be at least as close to the true-lat set as to the saturated-lat set.
    expect(
      overlapTrue,
      `prefetch must match true-lat (89°) better than saturated-lat (85.05°) — overlapTrue=${overlapTrue} overlapSat=${overlapSat}`,
    ).toBeGreaterThanOrEqual(overlapSat)
  })
})
