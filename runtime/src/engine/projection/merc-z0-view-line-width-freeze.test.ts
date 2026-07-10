// Issue #739 — flat Mercator z0..z0.5: the view-height cap (the "freeze")
// holds the MVP scale constant below z* = log2(canvasHeightCss/512), while the
// line-width path consumes UNCAPPED camera.zoom for its `mpp` factor. The two
// consumers disagree about what a sub-cap zoom means, so a CONSTANT-width line
// changes on-screen pixel width across z0..z0.5 while the view stays put.
//
// This is the unit-level harness the issue's "suggested next probe" asks for:
//   1. buildRTCMatrix yields an IDENTICAL MVP at z0 vs z0.5 on a tall viewport
//      (rawViewHeightMeters differs but the cap saturates both) — proves H1,
//      the freeze is a saturation CAP (refutes H2's quantize theory).
//   2. camera.zoom is genuinely 0 vs 0.5 (refutes H4's min-zoom-clamp theory).
//   3. A constant-width line's on-screen pixel width must be EQUAL at z0 and
//      z0.5. The single-authority effective mpp (camera.effectiveMpp — the world
//      scale the capped MVP actually uses) makes it so; the pre-fix uncapped
//      `WORLD_MERC/TILE_PX/2^zoom` diverges by 2^0.5 ≈ 1.41x (the bug).
//
// NOTE ON THE FREEZE BEING INTENTIONAL: the cap is NOT a pure defect. It holds
// the low-zoom altitude at the world-fit value so (a) perspective stays sane at
// pitch>0 (merc-z0-pitch-perspective.test.ts) and (b) the ortho disc frames the
// canvas (non-merc-z0-disc.test.ts) — the "regime MapLibre operates in at low
// zoom". So the fix is NOT to unfreeze the view (that regresses both gates);
// it is to make every zoom-scaled consumer read the SAME effective world scale
// the frozen MVP uses, so on-screen sizes stop diverging from the view.

import { describe, it, expect } from 'vitest'
import { Camera } from '@xgis/map'
import { WORLD_MERC, TILE_PX } from '@xgis/geo'

// A tall full-window viewport: z* = log2(1080/512) ≈ 1.08, so BOTH z0 and z0.5
// fall inside the frozen (sub-cap) band. dpr=1 keeps CSS px == device px.
const W = 1920,
  H = 1080,
  DPR = 1

/** Screen-X (px) of a world offset (dxMeters, 0) at the camera centre through
 *  the production flat Mercator MVP (pitch=0, bearing=0). Column-major
 *  M · (dx, 0, 0, 1). */
function screenX(m: Float32Array | ArrayLike<number>, dx: number): number {
  const clipX = m[0] * dx + m[12]
  const clipW = m[3] * dx + m[15]
  return (clipX / clipW + 1) * 0.5 * W
}

/** View scale S = screen pixels per world metre (x) at the camera centre. This
 *  is the term that multiplies world-space line width to yield on-screen px. */
function viewScaleX(cam: Camera): number {
  const m = cam.getViewForProjection(0, W, H, DPR).matrix
  const D = 1000 // 1 km probe offset — tiny vs the ~40 Mm view, so linear
  return (screenX(m, D) - screenX(m, 0)) / D
}

function flatMercCam(zoom: number): Camera {
  const cam = new Camera(0, 0, zoom)
  cam.projType = 0
  cam.bearing = 0
  cam.globeMode = false
  return cam
}

describe('#739 flat Mercator z0..z0.5 view/line-width freeze', () => {
  it('H1: the flat MVP is IDENTICAL at z0 and z0.5 on a tall viewport (frozen scale)', () => {
    const m0 = Array.from(flatMercCam(0).getViewForProjection(0, W, H, DPR).matrix)
    const m05 = Array.from(flatMercCam(0.5).getViewForProjection(0, W, H, DPR).matrix)
    // Every element equal → the view-height cap saturated both zooms to the
    // same world-fit altitude. A quantize (H2) would jump at integer z, not
    // hold a continuous band; a min-zoom clamp (H4) would move the whole camera.
    for (let i = 0; i < 16; i++) {
      expect(m05[i], `MVP[${i}] differs between z0 and z0.5 — not frozen`).toBeCloseTo(m0[i], 10)
    }
  })

  it('H1: the view scale is frozen (equal px-per-metre at z0 and z0.5)', () => {
    expect(viewScaleX(flatMercCam(0.5))).toBeCloseTo(viewScaleX(flatMercCam(0)), 12)
  })

  it('H4 refuted: camera.zoom is genuinely 0 vs 0.5 (no min-zoom clamp)', () => {
    expect(flatMercCam(0).zoom).toBe(0)
    expect(flatMercCam(0.5).zoom).toBe(0.5)
  })

  it('a CONSTANT-width line holds constant on-screen pixel width across z0..z0.5', () => {
    const strokeWidthPx = 4 // constant (non-interpolated) style width
    const cam0 = flatMercCam(0)
    const cam05 = flatMercCam(0.5)

    // The world-space half-width the line shader expands: strokeWidthPx * mpp.
    // Pre-fix, the line path used the UNCAPPED mpp; the fix uses the capped
    // single authority camera.effectiveMpp (the scale the frozen MVP renders at).
    const mppRaw = (z: number) => WORLD_MERC / TILE_PX / Math.pow(2, z)
    const linePxRaw = (cam: Camera, z: number) => strokeWidthPx * mppRaw(z) * viewScaleX(cam)
    const linePxEff = (cam: Camera) => strokeWidthPx * cam.effectiveMpp(0, H, DPR) * viewScaleX(cam)

    // Bug direction (the pre-fix uncapped path): raw mpp makes the z0 line
    // 2^0.5 THICKER than z0.5 — the reported "thinner at 0.5 than at 0".
    expect(linePxRaw(cam0, 0) / linePxRaw(cam05, 0.5)).toBeCloseTo(Math.SQRT2, 3)

    // FIX (was the fail-before): the fixed line path holds constant on-screen px
    // across the frozen band...
    expect(linePxEff(cam0), 'constant-width line still diverges across z0..z0.5').toBeCloseTo(
      linePxEff(cam05),
      6,
    )
    // ...and renders the TRUE width: a constant strokeWidthPx is strokeWidthPx·dpr
    // device px, no longer inflated by 2^(z*-zoom) in the sub-cap band.
    expect(linePxEff(cam0)).toBeCloseTo(strokeWidthPx * DPR, 6)
  })
})

describe('#739 normal (above sub-cap) band is untouched — DC=0 by construction', () => {
  // Above z* the raw view height is below the projType cap, so the flat MVP
  // never saturates and effectiveMpp === the uncapped mpp EXACTLY. The ONLY
  // render-path value #739 changes is this mpp, so a mid-zoom frame (z14) is
  // byte-identical before/after — the fix disturbs ONLY the sub-cap band.
  const rawMpp = (z: number) => WORLD_MERC / TILE_PX / Math.pow(2, z)
  for (const canvasH of [512, 724, 800, 1080, 1440, 2160]) {
    it(`z14 effectiveMpp === raw mpp at H=${canvasH} (cap does not bind)`, () => {
      expect(flatMercCam(14).effectiveMpp(0, canvasH, 1)).toBe(rawMpp(14))
    })
  }

  it('the cap binds ONLY below z* = log2(H/512) — the boundary is exact', () => {
    const canvasH = 1024 // z* = log2(1024/512) = 1.0
    const cam = flatMercCam(0)
    cam.zoom = 0.9 // just below z*: capped (effective < raw)
    expect(cam.effectiveMpp(0, canvasH, 1)).toBeLessThan(rawMpp(0.9))
    cam.zoom = 1.1 // just above z*: uncapped (effective === raw)
    expect(cam.effectiveMpp(0, canvasH, 1)).toBe(rawMpp(1.1))
  })

  it('globe (projType 7) is unchanged — always the uncapped Mercator mpp (scoped out)', () => {
    const cam = flatMercCam(0)
    cam.globeMode = true
    // Even at z0 on a tall viewport the globe path returns the raw mpp: its MVP
    // uses a different (cos-lat) cap that #739 explicitly does not touch.
    expect(cam.effectiveMpp(7, 1080, 1)).toBe(rawMpp(0))
  })
})
