// ═══ Per-tile camera anchor — the SINGLE authority (#1044) ═══
//
// Every path that packs a tile draw's frame uniform needs the same two
// camera-relative anchors:
//
//   • Mercator DSFUN rel (cam_h/cam_l): cameraMerc − tileOriginMerc, split
//     hi/lo so the shader's (pos_h − cam_h) + (pos_l − cam_l) subtraction
//     keeps f64-equivalent precision. worldOff (degrees) shifts the tile
//     for Mercator world copies.
//   • ECEF RTC offset (cam_ecef_off_{h,l}.xyz): tileEcefCenter − cameraCenter
//     on the WGS84 ELLIPSOID (E2 ≠ 0 — the tiler packs vertices via
//     lonLatToECEF on the ellipsoid, and mixing a spherical camera term put
//     the ellipsoid−sphere discrepancy (~21.5 km at Tokyo) into the offset:
//     sub-pixel at z1.5 but thousands of pixels at z14 — the globe
//     blank-tiles fix). ECEF is world-copy-independent on the sphere, so
//     worldOff is NOT applied to this term.
//
// Extracted verbatim from renderTileKeys' per-tile write. The WebGL2 twin
// packs (renderFillsRhi / renderLinesRhi) used to hard-zero the ECEF lanes
// — harmless on flat arms (the VS ignores them there) but on the globe
// every vertex reconstructed against the wrong origin, rendering the whole
// vector layer at a displaced, divergent transform (#1044's measured
// double-image). One authority, three callers — the seam cannot drift
// again (guarded by tile-camera-anchor-authority.test.ts).

import { activeBody, EARTH } from '@xgis/shared'

const DEG2RAD = Math.PI / 180
const MERC_LIMIT = 85.051129

/** Clamp a latitude (degrees) to the Web-Mercator singularity limit
 *  (±85.051129°) — the same clamp every Mercator-metre conversion in the
 *  tile draw path must share (anchor math here; clip_bounds in the caller). */
export const clampMercLat = (v: number): number => Math.max(-MERC_LIMIT, Math.min(MERC_LIMIT, v))

export interface TileCameraAnchor {
  /** Mercator camera-relative DSFUN pair (hi/lo), worldOff applied. */
  camXH: number
  camXL: number
  camYH: number
  camYL: number
  /** Tile origin in Mercator metres (f32-rounded, worldOff applied). */
  tileMercX: number
  tileMercY: number
  /** Ellipsoid-frame ECEF RTC offset, DSFUN hi/lo per axis. */
  ecefXH: number
  ecefXL: number
  ecefYH: number
  ecefYL: number
  ecefZH: number
  ecefZL: number
  /** #2042 INC-1 — the two ABSOLUTE ECEF anchors whose f64 difference IS the
   *  RTC offset above, each split hi/lo. The polygon VS can recombine
   *  `off = (tileH − camH) + (tileL − camL)` in-shader (see the uniform-block
   *  -split plan): the divergence from the CPU-packed pair is ulp-RELATIVE
   *  (≤ |off|·2⁻²³; measured ≤ 2.3e-4 px worst-case whole-domain, bound
   *  1e-3) — rtc-recombine-precision.test.ts. Splitting here keeps this
   *  file the single anchor authority (four callers, one seam). */
  tileEcefXH: number
  tileEcefXL: number
  tileEcefYH: number
  tileEcefYL: number
  tileEcefZH: number
  tileEcefZL: number
  camEcefXH: number
  camEcefXL: number
  camEcefYH: number
  camEcefYL: number
  camEcefZH: number
  camEcefZL: number
}

/** Compute both camera anchors for one tile draw. Pure; call per tile —
 *  the trig cost is negligible next to the uniform write + draw. */
export function computeTileCameraAnchor(
  tileWestDeg: number,
  tileSouthDeg: number,
  worldOffDeg: number,
  camLonDeg: number,
  camLatDeg: number,
): TileCameraAnchor {
  const R = activeBody().sphereR

  // ── Mercator DSFUN rel (worldOff shifts the tile copy) ──
  const tileMercX = (tileWestDeg + worldOffDeg) * DEG2RAD * R
  const tileMercY = Math.log(Math.tan(Math.PI / 4 + (clampMercLat(tileSouthDeg) * DEG2RAD) / 2)) * R
  const camMercX = camLonDeg * DEG2RAD * R
  const camMercY = Math.log(Math.tan(Math.PI / 4 + (clampMercLat(camLatDeg) * DEG2RAD) / 2)) * R
  const camRelX = camMercX - tileMercX // f64 cancellation
  const camRelY = camMercY - tileMercY
  const camXH = Math.fround(camRelX)
  const camYH = Math.fround(camRelY)

  // ── Ellipsoid ECEF RTC: tileEcefCenter − cameraCenter (no worldOff) ──
  const E2 = EARTH.e2
  const tLatR = clampMercLat(tileSouthDeg) * DEG2RAD
  const tLonR = tileWestDeg * DEG2RAD
  const tSin = Math.sin(tLatR)
  const tCos = Math.cos(tLatR)
  const tN = R / Math.sqrt(1 - E2 * tSin * tSin)
  const camLatR = clampMercLat(camLatDeg) * DEG2RAD
  const camLonR = camLonDeg * DEG2RAD
  const camSin = Math.sin(camLatR)
  const camCos = Math.cos(camLatR)
  const cN = R / Math.sqrt(1 - E2 * camSin * camSin)
  const tileX = tN * tCos * Math.cos(tLonR)
  const tileY = tN * tCos * Math.sin(tLonR)
  const tileZ = tN * (1 - E2) * tSin
  const camX = cN * camCos * Math.cos(camLonR)
  const camY = cN * camCos * Math.sin(camLonR)
  const camZ = cN * (1 - E2) * camSin
  const offX = tileX - camX
  const offY = tileY - camY
  const offZ = tileZ - camZ
  const ecefXH = Math.fround(offX)
  const ecefYH = Math.fround(offY)
  const ecefZH = Math.fround(offZ)
  const tileEcefXH = Math.fround(tileX)
  const tileEcefYH = Math.fround(tileY)
  const tileEcefZH = Math.fround(tileZ)
  const camEcefXH = Math.fround(camX)
  const camEcefYH = Math.fround(camY)
  const camEcefZH = Math.fround(camZ)

  return {
    camXH,
    camXL: Math.fround(camRelX - camXH),
    camYH,
    camYL: Math.fround(camRelY - camYH),
    tileMercX: Math.fround(tileMercX),
    tileMercY: Math.fround(tileMercY),
    ecefXH,
    ecefXL: Math.fround(offX - ecefXH),
    ecefYH,
    ecefYL: Math.fround(offY - ecefYH),
    ecefZH,
    ecefZL: Math.fround(offZ - ecefZH),
    tileEcefXH,
    tileEcefXL: Math.fround(tileX - tileEcefXH),
    tileEcefYH,
    tileEcefYL: Math.fround(tileY - tileEcefYH),
    tileEcefZH,
    tileEcefZL: Math.fround(tileZ - tileEcefZH),
    camEcefXH,
    camEcefXL: Math.fround(camX - camEcefXH),
    camEcefYH,
    camEcefYL: Math.fround(camY - camEcefYH),
    camEcefZH,
    camEcefZL: Math.fround(camZ - camEcefZH),
  }
}
