// H2 (debug-toolkit step-1, CPU cross-path) — fill ↔ outline encoding
// coincidence.
//
// Symptom: at deep over-zoom (screen z19.4 over an OFM parent tile at z14)
// a building polygon's OUTLINE renders parallel-offset from its FILL, the
// gap growing ∝ magnification. Both fill and outline derive from the SAME
// clipped ring (compiler unified them in #387), but they are packed by
// DIFFERENT kernels:
//   fill    → packECEFPolygonVertices  (ECEF residual, u16-quantized)
//   outline → packDSFUNLineVertices    (tile-local Mercator metres, DSFUN)
//
// This test is the CPU split of the divergence: decode the SAME source
// vertex back through BOTH kernels to a common frame (lon/lat) and compare.
//   PASS ⇒ the DATA encodings agree → the H2 offset is downstream (the
//          two vertex SHADERs reconstruct world position differently) →
//          escalate to GPU readback-parity (vs_main vs vs_line).
//   FAIL ⇒ the encoding itself drifts the outline off the fill → found,
//          with a witness vertex.
// Either way it is a permanent tripwire: if a future pack change drifts
// fill and outline apart, this fails BEFORE it ships a doubled edge.

import { describe, it, expect } from 'vitest'
import {
  packECEFPolygonVertices,
  packDSFUNLineVertices,
  lonLatToMercF64,
  tileEcefCenterFromMerc,
} from './ecef-packing'
import { dequantVertexF32 } from './dequant-mirror'

// WGS84 + inverse helpers (mirror ecef-precision-fuzz.test.ts exactly).
const A = 6378137
const F = 1 / 298.257223563
const E2 = F * (2 - F)
const DEG2RAD = Math.PI / 180

function mercatorToLonLatRad(mx: number, my: number): [number, number] {
  return [mx / A, 2 * Math.atan(Math.exp(my / A)) - Math.PI / 2]
}

/** WGS84 ECEF (m) → lon/lat (rad) via Bowring (4 iters) — copy of the
 *  ecef-precision-fuzz mirror so this test has no cross-file coupling. */
function ecefToLonLatRad(x: number, y: number, z: number): [number, number] {
  const lon = Math.atan2(y, x)
  const p = Math.hypot(x, y)
  let lat = Math.atan2(z, p * (1 - E2))
  let N = A
  let height = 0
  for (let i = 0; i < 4; i++) {
    const sinLat = Math.sin(lat)
    N = A / Math.sqrt(1 - E2 * sinLat * sinLat)
    height = p / Math.cos(lat) - N
    const newLat = Math.atan2(z, p * (1 - (E2 * N) / (N + height)))
    if (Math.abs(newLat - lat) < 1e-12) {
      lat = newLat
      break
    }
    lat = newLat
  }
  return [lon, lat]
}

// Ground resolution at the render zoom: ~156543.03 / 2^z metres / CSS-px
// (Web-Mercator at the equator). At Seoul (lat≈37.5°) true m/px is ×cos(lat)
// smaller, so the real per-px gate is slightly TIGHTER than this equatorial
// figure — i.e. using the equatorial value is marginally lenient. Immaterial
// here: the measured split is 0.000 px against a 0.25 px gate (3+ orders).
const Z_RENDER = 19.4
const M_PER_PX = 156543.03392 / Math.pow(2, Z_RENDER) // ≈ 0.226 m/px

describe('H2 step-1 — fill ↔ outline encoding coincidence (CPU cross-path)', () => {
  it('Seoul building corner @ parent z14: fill-decode and outline-decode land on the same lon/lat (sub-pixel @ z19.4)', () => {
    // The exact view under investigation: #19.40/37.48381/126.99179.
    const lonDeg = 126.99179,
      latDeg = 37.48381
    const latRad = latDeg * DEG2RAD
    const [mx, my] = lonLatToMercF64(lonDeg, latDeg)

    // Parent tile the OFM source serves (maxzoom 14) — vertex sits inside it.
    const ext = (2 * Math.PI * A) / Math.pow(2, 14)
    const tileMx = mx - ext * 0.3
    const tileMy = my - ext * 0.2
    const tileEcefCenter = tileEcefCenterFromMerc(tileMx, tileMy)

    // FILL path: pack → f32 GPU-faithful dequant → + tile ECEF centre →
    // inverse ECEF → lon/lat. (dequantVertexF32 is the EXACT in-shader VS
    // arithmetic the _dequant-parity gate validates against the real GPU.)
    const qf = packECEFPolygonVertices([mx, my, 0], tileEcefCenter)
    const [ax, ay, az] = dequantVertexF32(qf, 0)
    const [fLon, fLat] = ecefToLonLatRad(
      ax + tileEcefCenter[0],
      ay + tileEcefCenter[1],
      az + tileEcefCenter[2],
    )

    // OUTLINE path: pack → reconstruct tile-local metres (hi+lo) → + tile
    // origin → inverse Mercator → lon/lat. This is the Mercator-metre
    // position the line VS reconstructs BEFORE its own MM→ECEF step.
    // stride-8 input shape (the line kernel's IN_STRIDE; trailing tin/tout
    // slots zeroed) so count===1 and no undefined slot is read.
    const po = packDSFUNLineVertices([mx, my, 0, 0, 0, 0, 0, 0], tileMx, tileMy)
    const oMx = tileMx + po[0]! + po[2]! // mx_h + mx_l + origin
    const oMy = tileMy + po[1]! + po[3]! // my_h + my_l + origin
    const [oLon, oLat] = mercatorToLonLatRad(oMx, oMy)

    // Separation between the two decoded positions, in metres on the ground.
    const dEastM = Math.abs(fLon - oLon) * A * Math.cos(latRad)
    const dNorthM = Math.abs(fLat - oLat) * A
    const splitM = Math.hypot(dEastM, dNorthM)
    const splitPx = splitM / M_PER_PX

    console.log(
      `[H2 step-1] fill↔outline decoded split: ${splitM.toExponential(3)} m = ${splitPx.toFixed(3)} px @ z${Z_RENDER}`,
    )

    // The DATA must agree to well under a pixel at the render zoom. If this
    // fires, the encoding kernels themselves drift fill off outline (the
    // bug is in the data). If it passes, the data is clean and the visible
    // offset is born in the SHADER reconstruction → GPU readback next.
    expect(splitPx).toBeLessThan(0.25)
  })

  // NOTE: an earlier "hypothesis A REFUTED" test lived here, concluding the f32
  // abs_lon/abs_lat fill position was NOT the cause (it measured sub-pixel at a
  // single near-tile point). That refutation was WRONG — it under-measured by
  // probing one point near the tile origin, where the f32-degree grain is
  // small. A real-GPU bisect + independent trace CONFIRMED the f32-degree fill
  // position WAS the ~10 px drift at deep over-zoom (worst-case ~1.35 m at
  // |lon|≈127°). The fix stores TILE-LOCAL Mercator in those slots so the fill
  // position is sub-mm at every zoom (gated by ecef-precision-fuzz AC2c.2.3).
})
