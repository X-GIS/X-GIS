// #1081 — perspective-ratio distance attenuation for labels / icons.
//
// MapLibre shrinks far symbols by a perspective ratio
//   clamp(0.5 + 0.5·(cameraToCenterDistance / cameraToAnchorDistance), …)
// so far symbols contract toward 0.5× and near ones grow, and collision on the
// scaled boxes thins the far field. X-GIS had ZERO such code (grep-confirmed on
// label-pass / text-stage / icon-stage). makeLabelProjectors now computes, per
// anchor, `perspectiveScale = clamp(0.5 + 0.5·(wCenter / wAnchor), 0.5, 1.3)`,
// where wCenter is the camera-centre anchor's clip-w (= mvp[15]; the label MVP is
// the RTC/focus-relative matrix, so the centre anchor sits at the RTC origin) and
// wAnchor the anchor's clip-w (∝ view distance). text-stage folds it into `sizePx`
// (the single quad authority — collision box AND draw quad), icon-stage into the
// icon `sizeScale` (draw quad AND obstacle). This suite pins the projector math.
//
// The issue's illustrative "far → 0.5–0.75×" band is the deep far-field the FLAT
// pitched map reaches (its far edge recedes far past the centre depth) — pinned in
// the FLAT suite below (far 0.5–0.75, near clamps to 1.3, centre exactly 1.0). On
// the pinned z2 GLOBE the sphere BOUNDS the far distance and the horizon cull drops
// everything past the limb, so the deepest VISIBLE anchor (the north limb, ~5°
// past centre here) is only ~0.99×, and the attenuation shows mainly as NEAR-side
// GROWTH toward 1.3 — the geometry-correct globe behaviour, pinned here.
import { describe, it, expect } from 'vitest'
import { Camera } from './camera'
import { makeLabelProjectors } from './render-loop-helpers'
import { buildGlobeMatrix } from '@xgis/geo'

type V3 = readonly [number, number, number]

describe('makeLabelProjectors — globe perspective distance attenuation (#1081)', () => {
  const PW = 860,
    PH = 720
  // The task's pinned camera. Use the RTC (focus-relative) matrix + focus = the
  // look-at target — EXACTLY the live label pass's wiring (label-pass.ts passes
  // getViewForProjection's RTC matrix + getECEFCenter) — so wCenter = mvp[15] is
  // the camera-centre SURFACE anchor's clip-w (the absolute matrix would put
  // mvp[15] at Earth-centre and give centre-scale 1.013, not 1.0).
  const view = buildGlobeMatrix(0, 20, 2, 85, 0, PW, PH)
  const proj = makeLabelProjectors(
    view.rtcMatrix,
    PW,
    PH,
    undefined,
    view.eye as V3,
    view.target as V3,
    false,
  )
  // Scale AT a lon/lat anchor: project it (sets the scratch out-value), then read
  // the projector's perspectiveScale(). null when the anchor is off-screen/culled
  // (the horizon cull returns before perspScale is set, so only VISIBLE anchors —
  // the ones that actually draw — are collected).
  const scaleAt = (lon: number, lat: number): number | null => {
    const p = proj.projectLonLat(lon, lat)
    return p ? proj.perspectiveScale() : null
  }
  // Sweep the lon=0 tilt meridian (the eye's X-Z plane at bearing 0 → the screen
  // vertical) for the visible anchors and their scales.
  const onScreen: Array<{ lat: number; scale: number }> = []
  for (let lat = -80; lat <= 89; lat += 1) {
    const s = scaleAt(0, lat)
    if (s !== null) onScreen.push({ lat, scale: s })
  }

  it('FAIL-BEFORE: a real per-anchor scale SPREAD exists (pre-#1081 every symbol was 1.0)', () => {
    expect(onScreen.length).toBeGreaterThan(20)
    const scales = onScreen.map((a) => a.scale)
    // A genuine near↔far spread — pre-fix this was identically 0 (no attenuation).
    expect(Math.max(...scales) - Math.min(...scales)).toBeGreaterThan(0.15)
    // The clamp invariant holds for every VISIBLE anchor.
    for (const s of scales) {
      expect(s).toBeGreaterThanOrEqual(0.5)
      expect(s).toBeLessThanOrEqual(1.3)
    }
  })

  it('near anchor GROWS into [0.95,1.3]; far near-horizon anchor SHRINKS below it', () => {
    // near = smallest clip-w (highest scale) = closest to the tilted eye (south,
    // near the sub-eye point); far = largest clip-w (lowest scale) = the north limb.
    const near = onScreen.reduce((a, b) => (b.scale > a.scale ? b : a))
    const far = onScreen.reduce((a, b) => (b.scale < a.scale ? b : a))
    // Near anchor grows into the task's [0.95, 1.3] band (measured ~1.19).
    expect(near.scale).toBeGreaterThanOrEqual(0.95)
    expect(near.scale).toBeLessThanOrEqual(1.3)
    // Far near-horizon anchor is attenuated below the near one AND below the
    // centre's 1.0 (measured ~0.99 — the sphere + horizon cull bound the far
    // distance on the z2 globe; the FLAT suite reaches the deep 0.5–0.75 band).
    expect(far.scale).toBeLessThan(1.0)
    expect(far.scale).toBeGreaterThan(0.5)
    expect(near.scale - far.scale).toBeGreaterThan(0.15)
    // Geometry sanity: the near anchor sits SOUTH (toward the tilted eye), the far
    // one NORTH (toward the receding limb).
    expect(near.lat).toBeLessThan(far.lat)
  })

  it('projectLonLatCopies tuple slot 3 == perspectiveScale() (per-copy carry is consistent)', () => {
    const copies = proj.projectLonLatCopies(0, -30)
    expect(copies.length).toBe(1) // the globe collapses ±360° world copies to one
    expect(copies[0]![2]).toBeCloseTo(proj.perspectiveScale(), 10)
  })

  it('projectLonLat RETURN TYPE is unchanged — perspectiveScale is a side-channel only', () => {
    // The scratch out-value must not perturb positions: a caller that never reads
    // perspectiveScale() gets the exact pre-#1081 [x,y] tuple.
    const p = proj.projectLonLat(0, 20)
    expect(p).not.toBeNull()
    expect(p!.length).toBe(2)
  })

  it('pitch 0: the nadir centre AND a near-centre anchor are within 0.05 of 1 (no nadir attenuation)', () => {
    const v0 = buildGlobeMatrix(0, 20, 2, 0, 0, PW, PH)
    const p0 = makeLabelProjectors(
      v0.rtcMatrix,
      PW,
      PH,
      undefined,
      v0.eye as V3,
      v0.target as V3,
      false,
    )
    const s0 = (lon: number, lat: number): number => {
      const p = p0.projectLonLat(lon, lat)
      if (!p) throw new Error(`(${lon},${lat}) culled`)
      return p0.perspectiveScale()
    }
    expect(s0(0, 20)).toBeCloseTo(1, 3) // dead-centre = the ratio 1 exactly
    expect(Math.abs(s0(0, 20) - 1)).toBeLessThan(0.05)
    expect(Math.abs(s0(0, 35) - 1)).toBeLessThan(0.05) // a near-centre anchor too
  })
})

describe('makeLabelProjectors — FLAT-path perspective attenuation reaches the far band (#1081)', () => {
  const W = 800,
    H = 600
  // A steeply-pitched flat Mercator view: the far (top-of-screen) field recedes
  // far past the centre depth, so it reaches the issue's illustrative 0.5–0.75×
  // far band (unbounded, unlike the globe's horizon-clamped far field). Mirrors
  // the flat projector the label pass builds (centre lon/lat 0 → merc (0,0), so
  // ccx/ccy = 0 and wCenter = matrix[15]).
  const cam = new Camera(0, 0, 4)
  cam.projType = 0
  cam.pitch = 60
  const view = cam.getViewForProjection(0, W, H, 1)
  const proj = makeLabelProjectors(
    view.matrix,
    W,
    H,
    { projType: 0, ccx: 0, ccy: 0, centerLon: 0, centerLat: 0, visibleWorldCopies: [0] },
    view.eye,
  )
  const scaleAt = (lon: number, lat: number): number | null => {
    const p = proj.projectLonLat(lon, lat)
    return p ? proj.perspectiveScale() : null
  }

  it('centre = 1.0 exactly; far anchor ∈ [0.5,0.75]; near anchor grows into [0.95,1.3]', () => {
    // Dead-centre anchor projects to the RTC origin ⇒ wAnchor = wCenter ⇒ ratio 1.
    const centre = scaleAt(0, 0)
    expect(centre).not.toBeNull()
    expect(centre!).toBeCloseTo(1, 2)
    // Sweep the centre meridian; collect visible scales. North (top, under the
    // pitched north-up view) recedes → far/smallest; south (bottom) → near/largest.
    const scales: number[] = []
    for (let lat = -80; lat <= 85; lat += 0.5) {
      const s = scaleAt(0, lat)
      if (s !== null) scales.push(s)
    }
    expect(scales.length).toBeGreaterThan(20)
    const min = Math.min(...scales),
      max = Math.max(...scales)
    // The far field reaches the issue's illustrative band (measured min ~0.60).
    expect(min).toBeGreaterThanOrEqual(0.5) // clamp floor respected
    expect(min).toBeLessThanOrEqual(0.75) // …and genuinely inside the far band
    // The near field grows into [0.95, 1.3] (measured max = the 1.3 clamp).
    expect(max).toBeGreaterThanOrEqual(0.95)
    expect(max).toBeLessThanOrEqual(1.3)
  })
})
