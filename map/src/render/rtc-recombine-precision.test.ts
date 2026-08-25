// ═══ #2042 INC-1 — in-VS RTC recombination: whole-domain precision bound ═══
//
// The polygon VS can derive the RTC offset from the ABSOLUTE anchors instead
// of the CPU-packed difference (cam_ecef_center_h.w flag, polygon.ts):
//
//   legacy     off = (ecefH, ecefL)            — CPU: f64 subtract, THEN split
//   recombine  off = (tileH − camH, tileL − camL) — VS: split first, f32 subtract
//
// Both feed the same summation (`ecef_rtc + offH + offL`). This test models
// the shader's f32 chain exactly (Math.fround per op — WGSL/GLSL require
// correctly-rounded add/sub, which fround-of-f64-difference reproduces) and
// bounds the divergence against the f64 truth, converted to SCREEN PIXELS at
// the nearest distance the tile selector can put that tile.
//
// Error anatomy (why the bound holds whole-domain):
//   • hi − hi: both inputs are exact f32; the f32 subtract is correctly
//     rounded ⇒ |err| ≤ ulp(|off|)/2 ≈ |off|·2⁻²⁵. NEAR the camera the
//     inputs are within 2× of each other per component ⇒ Sterbenz: EXACT.
//   • lo − lo: |lo| ≤ |ecef|·2⁻²⁵ ≈ 0.4 m ⇒ absolute err ≤ ~2.4e-8 m.
//   • split residue (x − (H+L)): ≤ 0.5·ulp(L) ≈ 1e-8 m per anchor.
// Pixel conversion: a translation ε at view distance d subtends
// ε·PX_PER_RAD/d pixels (PX_PER_RAD = H/(2·tan(fov/2)) = 1080 px / 60° ≈ 935).
// The selector ties d to the drawn tile: a tile's screen footprint is capped
// by MAX_UNDERZOOM stretch (≤ 2³× ⇒ ≤ ~2048 px ≈ 2.2 rad·d), so
// d ≥ ~0.4·extent; and geometrically d ≥ |off| − 2·extent (the anchor is the
// SW corner, a visible vertex at most a stretched diagonal away). With
// |off|/d so bounded, err_px ≤ ~ulp-relative(2⁻²⁴)·(|off|/d)·935 ≲ 1e-3.
//
// The flag ships default-OFF; this bound is what lets the §5 A/B parity spec
// treat flag-on frames as pixel-comparable, and is the precision precondition
// for the Frame/Show/Tile block split (docs/plans/2026-08-24-uniform-block-split.md).

import { describe, it, expect } from 'vitest'
import { computeTileCameraAnchor, clampMercLat } from './tile-camera-anchor'
import { activeBody, EARTH } from '@xgis/shared'

const DEG2RAD = Math.PI / 180
const f = Math.fround
/** 1080-px viewport at 60° vertical fov: pixels subtended per radian. */
const PX_PER_RAD = 1080 / (2 * Math.tan((30 * Math.PI) / 180))

/** f64 reference ECEF of a clamped lon/lat on the WGS84 ellipsoid — the same
 *  formula/op-order as the authority (tile-camera-anchor.ts). */
function refEcef(lonDeg: number, latDeg: number): [number, number, number] {
  const R = activeBody().sphereR
  const E2 = EARTH.e2
  const latR = clampMercLat(latDeg) * DEG2RAD
  const lonR = lonDeg * DEG2RAD
  const s = Math.sin(latR)
  const c = Math.cos(latR)
  const N = R / Math.sqrt(1 - E2 * s * s)
  return [N * c * Math.cos(lonR), N * c * Math.sin(lonR), N * (1 - E2) * s]
}

/** deterministic PRNG (mulberry32) — reproducible sweep, no Math.random. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Case = { west: number; south: number; camLon: number; camLat: number; zoom: number }

/** Sweep: for each tile zoom, cameras in three selector-real regimes —
 *  inside the tile (near/Sterbenz), a few tiles away (adjacent), and global
 *  (the far pitch-fan / low-zoom regime). */
function buildSweep(): Case[] {
  const rnd = mulberry32(0x2042)
  const cases: Case[] = []
  for (const zoom of [0, 2, 5, 8, 11, 14, 17, 20, 22]) {
    const extentDeg = 360 / 2 ** zoom
    for (let i = 0; i < 24; i++) {
      const west = -180 + 360 * rnd()
      const south = -85 + 170 * rnd()
      // near: camera over the tile itself
      cases.push({
        west,
        south,
        camLon: west + extentDeg * rnd(),
        camLat: clampMercLat(south + extentDeg * rnd()),
        zoom,
      })
      // adjacent: within the 8×-stretch footprint
      cases.push({
        west,
        south,
        camLon: west + extentDeg * (rnd() * 16 - 8),
        camLat: clampMercLat(south + extentDeg * (rnd() * 16 - 8)),
        zoom,
      })
      // far: anywhere on the globe (worst |off|)
      cases.push({
        west,
        south,
        camLon: -180 + 360 * rnd(),
        camLat: -85 + 170 * rnd(),
        zoom,
      })
    }
  }
  // Adversarial pins: dateline, poles-clamp, antipode, camera ≈ anchor ± ulp.
  cases.push({ west: 179.999, south: 84.9, camLon: -179.999, camLat: -84.9, zoom: 4 })
  cases.push({ west: -180, south: -85.051129, camLon: 180, camLat: 85.051129, zoom: 1 })
  cases.push({
    west: 139.74609375,
    south: 35.68359375,
    camLon: 139.74609375 + 1e-12,
    camLat: 35.68359375 - 1e-12,
    zoom: 22,
  })
  return cases
}

/** Shader-model recombination: per-component correctly-rounded f32 subtracts
 *  of the already-f32 uniform lanes (exactly what the WGSL/GLSL VS executes). */
function recombine(a: ReturnType<typeof computeTileCameraAnchor>): {
  H: [number, number, number]
  L: [number, number, number]
} {
  return {
    H: [
      f(a.tileEcefXH - a.camEcefXH),
      f(a.tileEcefYH - a.camEcefYH),
      f(a.tileEcefZH - a.camEcefZH),
    ],
    L: [
      f(a.tileEcefXL - a.camEcefXL),
      f(a.tileEcefYL - a.camEcefYL),
      f(a.tileEcefZL - a.camEcefZL),
    ],
  }
}

const norm3 = (x: number, y: number, z: number): number => Math.hypot(x, y, z)

describe('#2042 INC-1 — in-VS RTC recombination precision', () => {
  it('anchor lanes are exact hi/lo splits of the f64 absolute ECEF (lane parity)', () => {
    // The recombination is only as good as its inputs: each absolute anchor
    // lane must be the canonical fround split of the f64 reference — same
    // discipline as tile-camera-anchor-authority.test.ts for the legacy lanes.
    const a = computeTileCameraAnchor(139.74609375, 35.68359375, 0, 139.7671, 35.6812)
    const [tx, ty, tz] = refEcef(139.74609375, 35.68359375)
    const [cx, cy, cz] = refEcef(139.7671, 35.6812)
    expect(a.tileEcefXH).toBe(f(tx))
    expect(a.tileEcefXL).toBe(f(tx - f(tx)))
    expect(a.tileEcefYH).toBe(f(ty))
    expect(a.tileEcefYL).toBe(f(ty - f(ty)))
    expect(a.tileEcefZH).toBe(f(tz))
    expect(a.tileEcefZL).toBe(f(tz - f(tz)))
    expect(a.camEcefXH).toBe(f(cx))
    expect(a.camEcefXL).toBe(f(cx - f(cx)))
    expect(a.camEcefYH).toBe(f(cy))
    expect(a.camEcefYL).toBe(f(cy - f(cy)))
    expect(a.camEcefZH).toBe(f(cz))
    expect(a.camEcefZL).toBe(f(cz - f(cz)))
  })

  it('camera exactly at the anchor recombines to an EXACT zero offset', () => {
    // Identical f64 inputs ⇒ identical splits ⇒ hi−hi = lo−lo = +0 exactly.
    const a = computeTileCameraAnchor(11.25, 47.8125, 0, 11.25, 47.8125)
    const r = recombine(a)
    expect(r.H).toEqual([0, 0, 0])
    expect(r.L).toEqual([0, 0, 0])
    expect([a.ecefXH, a.ecefYH, a.ecefZH]).toEqual([0, 0, 0])
  })

  it('ECEF anchors ignore worldOff — recombination is world-copy invariant', () => {
    const a0 = computeTileCameraAnchor(139.74609375, 35.68359375, 0, 139.7671, 35.6812)
    const a1 = computeTileCameraAnchor(139.74609375, 35.68359375, 360, 139.7671, 35.6812)
    expect(recombine(a1)).toEqual(recombine(a0))
  })

  it('whole-domain sweep: recombined offset within 1e-3 px of the f64 truth AND the legacy pair', () => {
    const R = activeBody().sphereR
    let worstTruthPx = 0
    let worstLegacyPx = 0
    let worstCase = ''
    let worstRel = 0
    let worstSubMeterAbs = 0
    for (const c of buildSweep()) {
      const a = computeTileCameraAnchor(c.west, c.south, 0, c.camLon, c.camLat)
      const [tx, ty, tz] = refEcef(c.west, c.south)
      const [cx, cy, cz] = refEcef(c.camLon, c.camLat)
      const truth: [number, number, number] = [tx - cx, ty - cy, tz - cz]
      const r = recombine(a)
      const rSum: [number, number, number] = [r.H[0] + r.L[0], r.H[1] + r.L[1], r.H[2] + r.L[2]]
      const legacy: [number, number, number] = [
        a.ecefXH + a.ecefXL,
        a.ecefYH + a.ecefYL,
        a.ecefZH + a.ecefZL,
      ]
      const errTruth = norm3(rSum[0] - truth[0], rSum[1] - truth[1], rSum[2] - truth[2])
      const errLegacy = norm3(rSum[0] - legacy[0], rSum[1] - legacy[1], rSum[2] - legacy[2])
      const off = norm3(truth[0], truth[1], truth[2])
      // Nearest distance the selector can draw this tile at (header model):
      // footprint cap (8×-stretch ⇒ d ≥ ~0.4·extent) OR the anchor is far
      // and every visible vertex is ≥ |off| − 2·extent away; 1 m floor.
      const extentM = ((2 * Math.PI * R) / 2 ** c.zoom) * Math.cos(clampMercLat(c.south) * DEG2RAD)
      const d = Math.max(1, 0.4 * extentM, off - 2 * extentM)
      const truthPx = (errTruth * PX_PER_RAD) / d
      const legacyPx = (errLegacy * PX_PER_RAD) / d
      if (truthPx > worstTruthPx) {
        worstTruthPx = truthPx
        worstCase = `z${c.zoom} tile(${c.west.toFixed(3)},${c.south.toFixed(3)}) cam(${c.camLon.toFixed(3)},${c.camLat.toFixed(3)}) |off|=${off.toFixed(0)}m d=${d.toFixed(0)}m err=${errTruth.toExponential(2)}m`
      }
      if (legacyPx > worstLegacyPx) worstLegacyPx = legacyPx
      // The divergence envelope is ULP-RELATIVE, never a fixed absolute
      // floor: err ≤ ulp(|off|)/2 per component (correctly-rounded hi−hi)
      // + the ~2e-8 m lo/split terms. Relative form ⇒ the closer the
      // camera, the smaller the absolute error — the guarantee that
      // flag-on cannot move near geometry (z10+ offsets are sub-mm).
      if (off > 1) worstRel = Math.max(worstRel, errLegacy / off)
      else worstSubMeterAbs = Math.max(worstSubMeterAbs, errLegacy)
    }
    // Measured envelope on the record (the CI log is the durable artifact —
    // compare here first when a future change moves these).
    console.log(
      `[rtc-recombine] worst vs truth ${worstTruthPx.toExponential(2)} px · vs legacy ` +
        `${worstLegacyPx.toExponential(2)} px · rel ${worstRel.toExponential(2)} · ${worstCase}`,
    )
    expect(worstTruthPx, `worst vs truth: ${worstCase}`).toBeLessThan(1e-3)
    expect(worstLegacyPx, 'recombined vs legacy CPU pair (the A/B pixel driver)').toBeLessThan(1e-3)
    expect(worstRel, 'divergence / |off| (ulp-relative envelope)').toBeLessThan(2 ** -22)
    expect(worstSubMeterAbs, 'sub-metre |off| absolute divergence (m)').toBeLessThan(1e-6)
  })
})

// ═══ #2042 INC-6 — the flat-arm Mercator recombination, same discipline ═══
//
// cam_rel = camMerc − tileOriginMerc(+worldOff), recombined in-VS as
// (camH − originH) + (camL − originL). Same error anatomy as the ECEF case:
// hi−hi correctly rounded (Sterbenz-exact camera-over-tile), lo−lo + split
// residues ≤ ~1e-8 m absolute (|merc| ≤ πR ≈ 2e7 ⇒ |lo| ≤ 2e7·2⁻²⁵ ≈ 0.6 m).
// Pixel conversion is direct on the flat plane: a visible rel spans at most
// the viewport + the 8×-stretch footprint ≈ ~5000 px of Mercator metres, so
// err_px = err_m / mpp ≤ ulp-relative(2⁻²⁴) × ~5000 ≈ 3e-4 whole-domain.
describe('#2042 INC-6 — Mercator cam-rel recombination precision', () => {
  const R = () => activeBody().sphereR
  const rawMercX = (lonDeg: number, worldOffDeg: number): number =>
    (lonDeg + worldOffDeg) * DEG2RAD * R()
  const rawMercY = (latDeg: number): number =>
    Math.log(Math.tan(Math.PI / 4 + (clampMercLat(latDeg) * DEG2RAD) / 2)) * R()

  it('camera exactly at the tile origin recombines to an EXACT zero rel', () => {
    const a = computeTileCameraAnchor(11.25, 47.8125, 0, 11.25, 47.8125)
    expect(f(a.camMercXH - a.tileMercXH) + f(a.camMercXL - a.tileMercXL)).toBe(0)
    expect(f(a.camMercYH - a.tileMercYH) + f(a.camMercYL - a.tileMercYL)).toBe(0)
    expect([a.camXH, a.camXL, a.camYH, a.camYL]).toEqual([0, 0, 0, 0])
  })

  it('whole-domain sweep incl. world copies: ulp-relative vs truth AND the legacy pair', () => {
    let worstRel = 0
    let worstSubMeterAbs = 0
    let worstPx = 0
    let worstCase = ''
    for (const c of buildSweep()) {
      for (const wo of [0, -360, 360]) {
        const a = computeTileCameraAnchor(c.west, c.south, wo, c.camLon, c.camLat)
        // f64 truth — same formulas/op-order as the authority.
        const truthX = rawMercX(c.camLon, 0) - rawMercX(c.west, wo)
        const truthY = rawMercY(c.camLat) - rawMercY(c.south)
        // Shader model: correctly-rounded f32 subtracts of the f32 lanes.
        const rx = f(a.camMercXH - a.tileMercXH) + f(a.camMercXL - a.tileMercXL)
        const ry = f(a.camMercYH - a.tileMercYH) + f(a.camMercYL - a.tileMercYL)
        const legacyX = a.camXH + a.camXL
        const legacyY = a.camYH + a.camYL
        const errTruth = Math.hypot(rx - truthX, ry - truthY)
        const errLegacy = Math.hypot(rx - legacyX, ry - legacyY)
        const rel = Math.hypot(truthX, truthY)
        // Direct flat-plane pixel bound: a rel visible on screen subtends
        // ≤ ~5000 px (viewport + 8×-stretch footprint), so mpp ≥ rel/5000.
        const px = rel > 1 ? (errTruth / rel) * 5000 : 0
        if (px > worstPx) {
          worstPx = px
          worstCase = `z${c.zoom} wo=${wo} |rel|=${rel.toFixed(0)}m err=${errTruth.toExponential(2)}m`
        }
        if (rel > 1) worstRel = Math.max(worstRel, errLegacy / rel)
        else worstSubMeterAbs = Math.max(worstSubMeterAbs, errLegacy)
      }
    }
    console.log(
      `[merc-recombine] worst ${worstPx.toExponential(2)} px · rel ${worstRel.toExponential(2)} · ${worstCase}`,
    )
    expect(worstPx, `worst vs truth: ${worstCase}`).toBeLessThan(1e-3)
    expect(worstRel, 'divergence / |rel| (ulp-relative envelope)').toBeLessThan(2 ** -22)
    expect(worstSubMeterAbs, 'sub-metre |rel| absolute divergence (m)').toBeLessThan(1e-6)
  })
})
