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
//
// #2165 — the §5 witness skew lives HERE, not in a packer. It used to be
// applied by vector-tile-renderer's _writeRtcAnchors, which writes the
// LEGACY monolithic polygon uniform; once #2151 made the split bind the
// shipping default the tile anchors are packed by TileUniformArena instead,
// which reads this anchor straight and never saw the skew. The witness went
// inert under the default bind path — the exact §12 vacuity it exists to
// prevent — and `_rtc-recombine-parity-gate` went red because its cut arm
// could no longer move a pixel. Applying it at the single producer means
// every packer inherits it by construction; there is no second site to drift.

import { activeBody } from '@xgis/shared'

const DEG2RAD = Math.PI / 180
const MERC_LIMIT = 85.051129

/** Clamp a latitude (degrees) to the Web-Mercator singularity limit
 *  (±85.051129°) — the same clamp every Mercator-metre conversion in the
 *  tile draw path must share (anchor math here; clip_bounds in the caller). */
export const clampMercLat = (v: number): number => Math.max(-MERC_LIMIT, Math.min(MERC_LIMIT, v))

/** Test-only witness (the §5 A/B gate's cut-the-mechanism arm): a metre skew
 *  applied to the ABSOLUTE tile anchors — and to those lanes only. The
 *  CPU-packed offset lanes (camXH/L, ecefXH/L) stay clean, so the skew moves
 *  geometry IFF the vertex shader is recombining the absolute pair. That
 *  asymmetry IS the witness: flag ON + skew must change the frame, flag OFF +
 *  skew must not. Default 0 → every lane byte-identical to the unskewed math. */
export const witnessSkew = (): number =>
  (globalThis as { __XGIS_RTC_RECOMBINE_SKEW?: number }).__XGIS_RTC_RECOMBINE_SKEW ?? 0

export interface TileCameraAnchor {
  /** Mercator camera-relative DSFUN pair (hi/lo), worldOff applied. */
  camXH: number
  camXL: number
  camYH: number
  camYL: number
  /** Tile origin in Mercator metres (f32-rounded, worldOff applied). */
  tileMercX: number
  tileMercY: number
  /** #2042 INC-6 — the ABSOLUTE Mercator anchors whose f64 difference IS the
   *  cam rel above, each split hi/lo: tile origin (worldOff applied — per
   *  copy, matching the TileBlock arena key) and camera centre (copy-
   *  independent). The flat-arm analogue of the ECEF pair below: the VS can
   *  recombine `rel = (camH − originH) + (camL − originL)` with the same
   *  ulp-relative envelope (rtc-recombine-precision.test.ts, Mercator
   *  section). tileMercX/Y above stay the single-f32 legacy lanes. */
  tileMercXH: number
  tileMercXL: number
  tileMercYH: number
  tileMercYL: number
  camMercXH: number
  camMercXL: number
  camMercYH: number
  camMercYL: number
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
  // The Mercator basis is spherical (`sphereR`); the ECEF kernel below is the
  // ellipsoid forward and reads `a` / `e2`. Both come from the SAME body — see
  // the ECEF section for why that is the whole point (#2564).
  const body = activeBody()
  const R = body.sphereR

  // ── Mercator DSFUN rel (worldOff shifts the tile copy) ──
  const tileMercX = (tileWestDeg + worldOffDeg) * DEG2RAD * R
  const tileMercY = Math.log(Math.tan(Math.PI / 4 + (clampMercLat(tileSouthDeg) * DEG2RAD) / 2)) * R
  const camMercX = camLonDeg * DEG2RAD * R
  const camMercY = Math.log(Math.tan(Math.PI / 4 + (clampMercLat(camLatDeg) * DEG2RAD) / 2)) * R
  const camRelX = camMercX - tileMercX // f64 cancellation
  const camRelY = camMercY - tileMercY
  const camXH = Math.fround(camRelX)
  const camYH = Math.fround(camRelY)
  // The absolute origin X carries the witness skew; the legacy single-f32
  // lane and the cam-rel pair above are computed from the clean value.
  const skew = witnessSkew()
  const tileMercXW = tileMercX + skew
  const tileMercXH = Math.fround(tileMercXW)
  const tileMercYH = Math.fround(tileMercY)
  const camMercXH = Math.fround(camMercX)
  const camMercYH = Math.fround(camMercY)

  // ── Ellipsoid ECEF RTC: tileEcefCenter − cameraCenter (no worldOff) ──
  // `a` and `e2` are the two fields `lonLatToECEF` reads, taken from the same
  // body it would read them from: this kernel IS that helper inlined, and the
  // equality is the invariant the camera comment below states. #2564 — `e2`
  // used to come from the `EARTH` singleton while the radius followed the
  // active body, so off Earth the anchor was that body's radius wearing
  // Earth's flattening (1261 m horizontal / 5092 m in z at lat 30 on MOON).
  // Inlined rather than calling the helper because this runs per tile and
  // `lonLatToECEF` returns a fresh array per call.
  const A = body.a
  const E2 = body.e2
  const tLatR = clampMercLat(tileSouthDeg) * DEG2RAD
  const tLonR = tileWestDeg * DEG2RAD
  const tSin = Math.sin(tLatR)
  const tCos = Math.cos(tLatR)
  const tN = A / Math.sqrt(1 - E2 * tSin * tSin)
  // The CAMERA term is NOT Mercator-clamped: it must equal lonLatToECEF(cam) —
  // the orbit matrix's RTC origin (buildGlobeFrame reads centerLatDeg, which
  // reaches the pole). Clamping it here put the tile sheet 441 km off the
  // point/label frame at lat 89 (#2315). Only the TILE term keeps the clamp
  // (a Mercator tile edge is never past ±85.051129°).
  const camLatR = camLatDeg * DEG2RAD
  const camLonR = camLonDeg * DEG2RAD
  const camSin = Math.sin(camLatR)
  const camCos = Math.cos(camLatR)
  const cN = A / Math.sqrt(1 - E2 * camSin * camSin)
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
  const tileXW = tileX + skew
  const tileEcefXH = Math.fround(tileXW)
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
    tileMercY: tileMercYH,
    tileMercXH,
    tileMercXL: Math.fround(tileMercXW - tileMercXH),
    tileMercYH,
    tileMercYL: Math.fround(tileMercY - tileMercYH),
    camMercXH,
    camMercXL: Math.fround(camMercX - camMercXH),
    camMercYH,
    camMercYL: Math.fround(camMercY - camMercYH),
    ecefXH,
    ecefXL: Math.fround(offX - ecefXH),
    ecefYH,
    ecefYL: Math.fround(offY - ecefYH),
    ecefZH,
    ecefZL: Math.fround(offZ - ecefZH),
    tileEcefXH,
    tileEcefXL: Math.fround(tileXW - tileEcefXH),
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
