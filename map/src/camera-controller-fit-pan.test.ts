// ═══ CameraController: fitBounds lat-axis + panBy wrap/clamp ═══
//
// Bug #1: fitBounds derived fit-zoom from lonSpan only — a tall/portrait bbox
//   (e.g. [[126,33],[127,38]] = 1° lon × 5° lat on 800×600) was zoomed in
//   too far: the lat span was NOT constraining zoom, clipping top/bottom.
//   Fix: also compute a lat-axis fit-zoom (in Mercator-Y space vs cssHeight)
//   and take zoom=min(lonFitZoom, latFitZoom).
//
// Bug #5: panBy fast-path (no maxBounds) did centerX+=dxMap; centerY-=dyMap
//   with no X-wrap (±WORLD_MERC/2) and no Y-clamp (±MAX_Y), so a large pan
//   past the antimeridian/pole drifted unboundedly. Fix mirrors Camera.pan.

import { describe, expect, it, beforeEach } from 'vitest'
import { Camera } from '@xgis/engine'
import { CameraController, type CameraControllerDeps } from './camera-controller'
import { WORLD_MERC } from '@xgis/engine'

// ── helpers ──────────────────────────────────────────────────────────────────

const EARTH_RADIUS = 6378137
const DEG2RAD = Math.PI / 180
const MAX_Y = 20037508.34 // Camera.MAX_Y = WORLD_MERC/2 ≈ 20037508.34

/** Project lat (degrees) → Mercator-Y meters (same formula as mercator.forward) */
function latToMercY(lat: number): number {
  const clampedLat = Math.max(-85.051129, Math.min(85.051129, lat))
  return Math.log(Math.tan(Math.PI / 4 + (clampedLat * DEG2RAD) / 2)) * EARTH_RADIUS
}

const TILE_PX = 512 // X-GIS tile pixel size

/**
 * Expected lat-fit zoom: the zoom at which the Mercator-Y span of [s,n]
 * exactly fills cssHeightPx. Matches the formula: mpp = WORLD_MERC/TILE_PX/2^z,
 * ySpan = cssHeightPx * mpp → z = log2(WORLD_MERC * cssHeightPx / (TILE_PX * ySpan))
 */
function expectedLatFitZoom(s: number, n: number, cssHeightPx: number): number {
  const yN = latToMercY(n)
  const yS = latToMercY(s)
  const ySpan = Math.max(1e-9, yN - yS)
  return Math.max(0.5, Math.log2((WORLD_MERC * cssHeightPx) / (TILE_PX * ySpan)))
}

function expectedLonFitZoom(w: number, e: number, cssWidthPx: number): number {
  const lonSpan = Math.max(1e-9, e - w)
  const degPerPx = lonSpan / cssWidthPx
  return Math.max(0.5, Math.log2(360 / (degPerPx * 256)) - 1)
}

/** Build a CameraController with a 800×600 CSS canvas (DPR=1). */
function makeController(
  cssW = 800,
  cssH = 600,
): {
  ctrl: CameraController
  cam: Camera
} {
  const cam = new Camera()
  // Inject a mock canvas that looks like a DPR=1 device (canvas.width=CSS px)
  const mockCanvas = { width: cssW, height: cssH } as unknown as HTMLCanvasElement
  const deps: CameraControllerDeps = {
    invalidate: () => {},
    getCanvas: () => mockCanvas,
    getCtxCanvas: () => mockCanvas,
  }
  const ctrl = new CameraController(cam, deps)
  return { ctrl, cam }
}

// ── Bug #1: fitBounds latitude ignored ───────────────────────────────────────

describe('Bug #1: fitBounds picks the MORE CONSTRAINING axis (lon vs lat)', () => {
  it('tall bbox [[126,33],[127,38]] on 800×600 → zoom is lat-constrained, not lon-constrained', () => {
    // lon span = 1°, lat span = 5° — on an 800×600 CSS canvas the lat axis
    // is the tighter constraint, so the fit-zoom must equal the lat-fit zoom.
    const { ctrl } = makeController(800, 600)
    ctrl.fitBounds([
      [126, 33],
      [127, 38],
    ])

    const z = ctrl.getCameraState().zoom
    const lonZ = expectedLonFitZoom(126, 127, 800)
    const latZ = expectedLatFitZoom(33, 38, 600)
    const expectedZ = Math.min(lonZ, latZ)

    // The lat-zoom must be tighter (lower) than lon-zoom for this test to be
    // meaningful — assert that invariant first so the test fails meaningfully
    // if the numbers change.
    expect(latZ).toBeLessThan(lonZ)

    // FAIL-BEFORE: before the fix, z === lonZ (lat ignored); after the fix
    // z === expectedZ === latZ.
    expect(z).toBeCloseTo(expectedZ, 3)
  })

  it('wide bbox [[0,0],[90,1]] on 800×600 → zoom is lon-constrained', () => {
    // lon span = 90°, lat span = 1° — lon axis is the tighter constraint.
    const { ctrl } = makeController(800, 600)
    ctrl.fitBounds([
      [0, 0],
      [90, 1],
    ])

    const z = ctrl.getCameraState().zoom
    const lonZ = expectedLonFitZoom(0, 90, 800)
    const latZ = expectedLatFitZoom(0, 1, 600)

    expect(lonZ).toBeLessThan(latZ) // lon is tighter — test invariant
    expect(z).toBeCloseTo(Math.min(lonZ, latZ), 3) // should equal lonZ
  })

  it('after fitBounds on tall bbox, center lat is the bbox midpoint', () => {
    const { ctrl } = makeController(800, 600)
    ctrl.fitBounds([
      [126, 33],
      [127, 38],
    ])
    const state = ctrl.getCameraState()
    expect(state.center[1]).toBeCloseTo((33 + 38) / 2, 3)
    expect(state.center[0]).toBeCloseTo((126 + 127) / 2, 3)
  })
})

// ── Bug #5: panBy fast-path no wrap/clamp ────────────────────────────────────

describe('Bug #5: panBy fast-path wraps X and clamps Y', () => {
  beforeEach(() => {
    // Ensure window is absent so DPR=1 (node environment)
  })

  it('panBy with huge +X past antimeridian wraps centerX into ±WORLD_MERC/2', () => {
    const { ctrl, cam } = makeController()
    // Start near the antimeridian (east side, ~170°E)
    ctrl.setCenter(170, 0)
    ctrl.setZoom(0) // 1 CSS px ≈ lots of meters at zoom 0

    // At zoom 0: mpp = WORLD_MERC / TILE_PX / 2^0 = 40075016.686 / 512 ≈ 78271
    // WORLD_MERC/2 ≈ 20037508m; push 0.4 * WORLD_MERC in X → should wrap
    const bigDx = 0.4 * WORLD_MERC // in CSS px at zoom 0 → ≈0.4 * WORLD_MERC in merc meters
    ctrl.panBy([bigDx / (WORLD_MERC / TILE_PX / Math.pow(2, 0)), 0])

    // centerX must be within ±WORLD_MERC/2 after the fast-path fix
    expect(cam.centerX).toBeGreaterThanOrEqual(-WORLD_MERC / 2 - 1)
    expect(cam.centerX).toBeLessThanOrEqual(WORLD_MERC / 2 + 1)
  })

  it('panBy with huge -X past antimeridian wraps centerX into ±WORLD_MERC/2', () => {
    const { ctrl, cam } = makeController()
    ctrl.setCenter(-170, 0)
    ctrl.setZoom(0)

    const bigDx = -0.4 * WORLD_MERC
    ctrl.panBy([bigDx / (WORLD_MERC / TILE_PX / Math.pow(2, 0)), 0])

    expect(cam.centerX).toBeGreaterThanOrEqual(-WORLD_MERC / 2 - 1)
    expect(cam.centerX).toBeLessThanOrEqual(WORLD_MERC / 2 + 1)
  })

  it('panBy with huge +Y clamps centerY to ≤ MAX_Y (no pole drift)', () => {
    const { ctrl, cam } = makeController()
    ctrl.setCenter(0, 0)
    ctrl.setZoom(0)

    // Pan south (positive dy moves map down = camera center moves north in mercator Y -)
    // Actually: centerY -= dyMap. Large positive dyMerc → centerY decreases (moves toward -MAX_Y)
    // We want to test clamp. Let's push toward +MAX_Y by panning with negative dy.
    const mpp = WORLD_MERC / TILE_PX / Math.pow(2, 0)
    // Negative CSS dy → dyMap is negative → centerY -= negative → centerY increases
    const bigDy = (-2 * MAX_Y) / mpp
    ctrl.panBy([0, bigDy])

    expect(cam.centerY).toBeLessThanOrEqual(MAX_Y + 1)
    expect(cam.centerY).toBeGreaterThanOrEqual(-MAX_Y - 1)
  })

  it('panBy with huge -Y clamps centerY to ≥ -MAX_Y (no pole drift)', () => {
    const { ctrl, cam } = makeController()
    ctrl.setCenter(0, 0)
    ctrl.setZoom(0)

    const mpp = WORLD_MERC / TILE_PX / Math.pow(2, 0)
    const bigDy = (2 * MAX_Y) / mpp
    ctrl.panBy([0, bigDy])

    expect(cam.centerY).toBeLessThanOrEqual(MAX_Y + 1)
    expect(cam.centerY).toBeGreaterThanOrEqual(-MAX_Y - 1)
  })

  it('panBy without maxBounds (fast path) does NOT change behavior for normal pans', () => {
    // Regression: small pans inside bounds must still work correctly.
    const { ctrl, cam } = makeController()
    ctrl.setCenter(0, 0)
    ctrl.setZoom(5)

    const mpp = WORLD_MERC / TILE_PX / Math.pow(2, 5)
    ctrl.panBy([10, 0]) // pan 10px east
    // dxMerc=10*mpp, bearingRad=0, dxMap=dxMerc, centerX+=dxMap → centerX increases by 10*mpp
    expect(cam.centerX).toBeCloseTo(10 * mpp, 3)
  })
})
