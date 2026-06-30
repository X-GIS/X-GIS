// Non-Mercator z=0 disc render scale — FAITHFUL flat-path FRAMING gate.
//
// FRAMING gate — pairs with the RENDER fix. A headed real-GPU screenshot
// (2026-05-31) first proved the flat non-Mercator z0 p0 render was ~100% BLACK
// (zero map geometry drawn) for BOTH ortho AND azi, and that the 2·R cap made
// NO pixel difference (cap-on ≡ cap-off). Root cause was NOT framing but tile
// SELECTION: ortho/azi are sphere-routed (globeVisibleTiles), which returned
// ZERO tiles at z0/maxZ=0 off-centre (the z0 root tile couldn't subdivide and
// its corner samples missed the visible cap → 0 draws). Fixed in globe.ts
// (emit the focal-point tile unconditionally; see globe-z0-focal-tile.test.ts).
// AFTER that fix the headed render shows a full ortho disc, and THIS gate
// verifies the disc fills the canvas (the 2·R framing cap). The two fixes are
// complementary: globe.ts makes the tiles draw, the cap makes them fill.
//
// Memory project_non_merc_z0_disc_render_fail_2026_05_20: ortho / azi / stereo
// / oblique at z=0 + pitch=0 were reported to render a small disc (~32%
// canvas). This gate measures that span through the ACTUAL production flat
// path so it red-flags the FRAMING regression and goes green only when the
// framing fix ships (it has — commit fc0fc19d).
//
// PRIOR GATE WAS MIS-MEASURING (master-plan 2.1, workflow w8z8we8k4): it fed
// `mercatorToECEFSphere(lon·π/180·R, 0, 0) − getECEFCenter()` (an ECEF sphere
// vertex) into the flat MVP. That is NEITHER production path — the flat path
// feeds the shader `flat_rel` = `project_geom(lon,lat) − project(clon,clat)`
// (raw 2D forward metres), and the ECEF path feeds true ECEF vertices through
// `getECEFFrameView`. The ECEF-vertex-through-flat-MVP feed projected to 0 px
// for every projType, so the old `it.fails` "passed" for the WRONG reason and
// additionally mis-marked 4/5/6 as expected-fail when they actually fill.
//
// FAITHFUL feed (this file): `projectGeomCpu(pt,lon,lat,clon,clat,refLon) −
// projectCpu(pt,clon,clat,clon,clat)` — the CPU mirror of the shader flat_rel
// — through `getViewForProjection(pt).matrix`, exactly as the polygon/line VS
// does (`mvp · vec4(flat_rel.x, flat_rel.y, 0, 1)`).
//
// MEASURED z0 spans (lon ±89.9 rim, 800-px canvas, camera at 0/0):
//   pt0 mercator 399.6px (50%, the in-band control)   pt3 ortho 254.6px (32%)
//   pt4 azi 399.6px (50%)   pt5 stereo 508.4px (64%)   pt6 oblique 399.6px (50%)
// => the disc-fill bug is ORTHOGRAPHIC-ONLY. ortho clamps its limb at rho=R so
// its 2R disc fills only 0.64× the Mercator control in the 40-Mm flat view;
// azi/stereo/oblique map lon±89.9 to ≥10 Mm and already fill ≥ the control
// (their visible disc extends past lon±89.9 to the cull rim, so this is a
// conservative lower bound for them). The 2.1 fix (commit fc0fc19d) is an
// ortho-only flat MVP VIEW-HEIGHT CAP at 2·EARTH_R (flatViewHeightCapM,
// projections-table) — NOT a flat_rel scale (a constant scale would over-size
// ortho ~3× at high zoom; the cap is naturally zoom-gated) and NOT the
// per-projType stereographic framing the antipode-extent analysis feared. The
// cap makes ortho's limb (lon±90) land at the canvas edge, ≈ 2× the Mercator
// control at z0. See .omc/research/p2-2.1-z0-disc-probe-2026-05-31.md.

import { describe, it, expect } from 'vitest'
import { Camera } from '@xgis/engine'
import { projectGeomCpu, projectCpu } from '../shaders/dsl/cpu-projections'

const W = 800, H = 800, DPR = 1

// Apply column-major 4x4 to a vec4 → vec4.
function mulMat4Vec4(
  m: Float32Array | ArrayLike<number>,
  v: [number, number, number, number],
): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0]
  for (let r = 0; r < 4; r++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += m[k * 4 + r] * v[k]
    out[r] = s
  }
  return out
}

/** Screen-X (px) of (lon, 0) through the FAITHFUL flat path: the flat_rel CPU
 *  mirror fed into the production flat MVP, with camera centred at (0, 0).
 *  Returns null if the point is behind the camera. */
function flatScreenX(cam: Camera, projType: number, lon: number): number | null {
  const [vx, vy] = projectGeomCpu(projType, lon, 0, 0, 0, 0)
  const [cx, cy] = projectCpu(projType, 0, 0, 0, 0)
  const mvp = cam.getViewForProjection(projType, W, H, DPR).matrix
  const clip = mulMat4Vec4(mvp, [vx - cx, vy - cy, 0, 1])
  if (clip[3] <= 1e-6) return null
  return (clip[0] / clip[3] + 1) * 0.5 * W
}

/** z0/pitch0 disc span (px) between the lon ±89.9 rim for a flat-routed
 *  projType. */
function flatDiscSpan(projType: number): number | null {
  const cam = new Camera(0, 0, 0)
  cam.pitch = 0
  cam.bearing = 0
  cam.projType = projType
  cam.globeMode = false
  cam.globeOrtho = projType >= 3 && projType <= 5
  const east = flatScreenX(cam, projType, +89.9)
  const west = flatScreenX(cam, projType, -89.9)
  if (east == null || west == null) return null
  return Math.abs(east - west)
}

describe('non-Merc z=0 disc render scale (faithful flat path)', () => {
  // In-band faithfulness control: the Mercator flat path frames lon ±89.9
  // (±10.01 Mm of the 40-Mm view) at ≈50% of the canvas. The mis-measuring
  // ECEF-vertex feed projected this to 0 px — so this bound proves the gate
  // is now feeding the real flat_rel path.
  const mercSpan = flatDiscSpan(0)
  it('mercator (control) flat disc spans ≈ half the canvas (proves faithful feed)', () => {
    expect(mercSpan, 'mercator control span null — flat feed broken').not.toBeNull()
    expect(mercSpan!).toBeGreaterThan(350)
    expect(mercSpan!).toBeLessThan(450)
  })

  // azimuthal_eq / stereographic / oblique_mercator already fill the canvas at
  // least as much as the Mercator control at z0 — they are NOT part of the
  // disc-fill bug (their lon±89.9 rim maps to ≥10 Mm; their true visible disc
  // extends further still). Pass = span ≥ 0.9× the Mercator control.
  for (const projType of [4, 5, 6]) {
    it(`projType=${projType}: flat disc fills ≥ 0.9× the mercator control at z0 p0`, () => {
      const span = flatDiscSpan(projType)
      expect(span, `projType=${projType} span null`).not.toBeNull()
      expect(
        span! / mercSpan!,
        `projType=${projType} disc span ${span!.toFixed(1)}px vs mercator ${mercSpan!.toFixed(1)}px`,
      ).toBeGreaterThanOrEqual(0.9)
    })
  }

  // orthographic WAS the disc-fill bug: its limb clamps at rho=R, so before
  // the 2.1 fix the 2R disc subtended only ~0.64× the Mercator control (254.6px
  // vs 399.6px = 32% of canvas). The 2.1 fix caps ortho's flat MVP view height
  // at 2·EARTH_R (flatViewHeightCapM, projections-table) so the disc fills the
  // canvas at z0 — ortho's lon±90 limb now lands at the canvas edge, ≈ 2× the
  // Mercator control. Naturally zoom-gated: the cap only binds at low zoom, so
  // higher zooms stay byte-identical to the cylindrical projections.
  it('projType=3 (ortho): flat disc fills the canvas (≈2× mercator) at z0 p0 [2.1 fixed]', () => {
    const span = flatDiscSpan(3)
    expect(span, 'ortho span null').not.toBeNull()
    const ratio = span! / mercSpan!
    // Lower bound: the disc must fill (≥0.9× the control). Upper bound pins the
    // 2·EARTH_R cap value: the limb lands at the canvas edge ≈2.0× the control;
    // a cap of EARTH_R (half) would over-fill to ~4× and still pass a one-sided
    // ≥0.9, so bound it ≤2.5 to catch a wrong cap value, not just "bigger".
    expect(
      ratio,
      `ortho disc span ${span!.toFixed(1)}px vs mercator ${mercSpan!.toFixed(1)}px (ratio ${ratio.toFixed(2)}) — should be ≈2× after the 2R cap`,
    ).toBeGreaterThanOrEqual(0.9)
    expect(ratio, `ortho ratio ${ratio.toFixed(2)} over-fills — cap value likely wrong`).toBeLessThanOrEqual(2.5)
  })
})
