// Fail-before / pass-after regression tests for three camera bugs:
//   #8  Globe pan bearing: Rot(-θ) → Rot(+θ)
//   #6  Disc pole-ward zoom drift via Mercator clamp
//   #2  discDragAnchorAt / panDiscToScreenAnchor round-trip

import { describe, it, expect } from 'vitest'
import { Camera } from '../camera'
import { panGlobeToScreenAnchor } from '../globe-anchor'

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeGlobeCamera(lon = 0, lat = 0, zoom = 4): Camera {
  const cam = new Camera(lon, lat, zoom)
  cam.globeMode = true
  cam.projType = 7
  return cam
}

function makeDiscCamera(lon = 0, lat = 0, zoom = 2, projType = 3): Camera {
  // Clamp lat to ±85.051129 for the Mercator constructor; then override
  // centerLatDeg directly to simulate setCenter([lon, lat]) for pole-ward
  // centres (|lat| > 85.05) — exactly as the Map does via setCenter which
  // writes centerLatDeg directly past the Mercator saturation limit.
  const clampedLat = Math.max(-85.051129, Math.min(85.051129, lat))
  const cam = new Camera(lon, clampedLat, zoom)
  cam.projType = projType // 3=ortho, 4=azimuthal_eq, 5=stereo
  // For pole-ward centres (|lat|>85.05), override centerLatDeg directly.
  // centerY stays at the Mercator-saturated value (the same as setCenter does).
  if (Math.abs(lat) > 85.051129) {
    cam.centerLatDeg = lat
  }
  return cam
}

const W = 800, H = 600, DPR = 1

// ─── #8 Globe pan bearing rotation direction ──────────────────────────────────
//
// At bearing=90° (east up), a rightward screen drag (dx>0, dy=0) should move
// the camera so the latitude increases (the globe rotates northward from the
// viewer's perspective — a rightward push on a 90°-bearing globe slides the
// surface DOWN, so the camera centre moves UP/northward).
//
// Ground-truth: panGlobeToScreenAnchor (the verified anchor path) produces a
// positive dLat for a rightward delta at bearing=90.  The old Rot(-θ) formula
// produced gdy = -dx*sb+dy*cb = -dx*1+0 = -dx (negative for positive dx),
// i.e. equator-ward — the WRONG direction.  Rot(+θ) gives gdy = dx*sb+dy*cb
// = dx*1+0 = dx (positive) — correct.
//
// Test: camera at lat=0, bearing=90°; pan(50,0,...) must produce centerLatDeg>0.

describe('#8 globe pan bearing rotation direction', () => {
  it('rightward drag at bearing=90 moves center northward (Rot+θ), not southward', () => {
    const cam = makeGlobeCamera(0, 0, 4)
    cam.bearing = 90

    cam.pan(50, 0, W, H)

    // With Rot(-θ): gdy = -50*sin(π/2)+0 = -50 → centerLatDeg < 0 (WRONG)
    // With Rot(+θ): gdy = 50*sin(π/2)+0  = +50 → centerLatDeg > 0 (CORRECT)
    expect(cam.centerLatDeg).toBeGreaterThan(0)
  })

  it('delta direction at bearing=90 matches panGlobeToScreenAnchor ground-truth', () => {
    // Capture the anchor (lon,lat) at the screen centre BEFORE pan
    // then feed it to panGlobeToScreenAnchor and observe the same direction.
    const camRef = makeGlobeCamera(0, 0, 4)
    camRef.bearing = 90
    // Simulate: anchor at centre pixel, then cursor moves 50px right
    const anchorLon = 0, anchorLat = 0
    const cursorX = (W / 2 + 50) * DPR, cursorY = (H / 2) * DPR
    panGlobeToScreenAnchor(camRef, anchorLon, anchorLat, cursorX, cursorY, W, H, DPR)
    // panGlobeToScreenAnchor rotates centre so anchor point comes under cursor.
    // A 50px rightward move of the cursor means the anchor is now to the left of
    // centre → centre must have shifted rightward in screen space → northward in
    // map space at bearing=90.
    expect(camRef.centerLatDeg).toBeGreaterThan(0)

    // Now camera.pan must agree in sign with the reference.
    const camTest = makeGlobeCamera(0, 0, 4)
    camTest.bearing = 90
    camTest.pan(50, 0, W, H)
    expect(Math.sign(camTest.centerLatDeg)).toBe(Math.sign(camRef.centerLatDeg))
  })
})

// ─── #6 Disc pole-ward zoom drift ─────────────────────────────────────────────
//
// For an orthographic camera centred at lat=88° (near the pole), a zoom-in step
// at the screen centre must NOT drag centerLatDeg equator-ward by several degrees.
// The Mercator clamp for centerY at such a high latitude saturates at 85.051129°,
// so feeding that through _carryCenterLatThroughZoom causes a huge equatorial
// pull.  After the fix the centre stays within ±1° of 88°.

describe('#6 disc pole-ward zoom drift', () => {
  it('ortho (projType=3) at lat=88 stays near 88 after a zoom-in step', () => {
    const cam = makeDiscCamera(0, 88, 2, 3)
    expect(cam.centerLatDeg).toBeCloseTo(88, 1)

    // Zoom in 1 step at screen centre
    cam.zoomAt(1, W / 2, H / 2, W, H)

    // Without fix: centerLatDeg drifts to ~84 or lower
    // With fix: stays within 1° of 88
    expect(cam.centerLatDeg).toBeGreaterThan(87)
  })

  it('azimuthal_eq (projType=4) at lat=85 stays near 85 after zoom-in', () => {
    const cam = makeDiscCamera(0, 85, 2, 4)
    cam.zoomAt(1, W / 2, H / 2, W, H)
    expect(cam.centerLatDeg).toBeGreaterThan(84)
  })
})

// ─── #2 discDragAnchorAt / panDiscToScreenAnchor round-trip ──────────────────
//
// discDragAnchorAt(cx,cy,W,H,dpr) unprojection must recover a lon/lat such that
// panDiscToScreenAnchor with that anchor + same cursor returns the camera to
// within ~0.1° of its original position (i.e. the anchor stays under the cursor).

describe('#2 disc drag anchor round-trip', () => {
  // Helper: after capturing an anchor at the cursor, shift the camera by a small
  // delta (simulating a POINTERDOWN then first POINTERMOVE) and verify that
  // panDiscToScreenAnchor brings the anchor back under the cursor.
  function roundTripTest(projType: number, lat: number): void {
    const cam = makeDiscCamera(0, lat, 2, projType)
    const cx = W * DPR * 0.5, cy = H * DPR * 0.5

    // Capture anchor at screen centre
    const anchor = cam.discDragAnchorAt(cx, cy, W, H, DPR)
    expect(anchor).not.toBeNull()

    // Slightly shift the camera (simulates a move event)
    const camBefore = { cx: cam.centerX, cy: cam.centerY, lat: cam.centerLatDeg }
    cam.centerX += 50000 // 50 km shift east
    cam.centerLatDeg += 0.5
    // (centerY is a Mercator mirror — recompute to keep consistent)
    const EARTH_R = 6378137
    const mercLat = Math.max(-85.051129, Math.min(85.051129, cam.centerLatDeg))
    cam.centerY = Math.log(Math.tan(Math.PI / 4 + mercLat * (Math.PI / 180) / 2)) * EARTH_R

    // panDiscToScreenAnchor should converge the anchor back under the cursor
    cam.panDiscToScreenAnchor(anchor!.lon, anchor!.lat, cx, cy, W, H, DPR)

    // After convergence the camera should be close to where it started
    // (within rounding / iteration tolerance)
    expect(Math.abs(cam.centerX - camBefore.cx)).toBeLessThan(5000) // within 5 km
    expect(Math.abs(cam.centerLatDeg - camBefore.lat)).toBeLessThan(0.1)
  }

  it('ortho (projType=3) at lat=0 anchor round-trips under cursor', () => {
    roundTripTest(3, 0)
  })

  it('ortho (projType=3) at lat=45 anchor round-trips under cursor', () => {
    roundTripTest(3, 45)
  })

  it('azimuthal_eq (projType=4) at lat=0 anchor round-trips', () => {
    roundTripTest(4, 0)
  })

  it('stereo (projType=5) at lat=0 anchor round-trips', () => {
    roundTripTest(5, 0)
  })

  it('discDragAnchorAt returns null for non-disc projType (mercator=0)', () => {
    const cam = new Camera(0, 0, 2)
    cam.projType = 0
    const result = cam.discDragAnchorAt(W / 2, H / 2, W, H, DPR)
    expect(result).toBeNull()
  })

  it('panDiscToScreenAnchor is a no-op for non-disc projType', () => {
    const cam = new Camera(0, 0, 2)
    cam.projType = 0
    const cx0 = cam.centerX, cy0 = cam.centerY
    cam.panDiscToScreenAnchor(10, 20, W / 2, H / 2, W, H, DPR)
    expect(cam.centerX).toBe(cx0)
    expect(cam.centerY).toBe(cy0)
  })
})
