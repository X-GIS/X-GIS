// #598 — line finalize_corner DSFUN split threading gate.
//
// Before #598, finalize_corner received a pre-summed vec2 `corner = p_h + p_l`
// (tile-local Mercator). For non-Mercator projections it computed:
//
//   absMerc  = corner + tileOrigin
//   absLon   = absMerc.x / (DEG2RAD * EARTH_R)
//   latRad   = inv_merc_lat_rad(absMerc.y)
//   absLat   = degrees(latRad)
//   flatRel  = flat_rel(absLon, absLat, ...)
//
// The fix (#598) passes the endpoint DSFUN split `(p_h, p_l)` and a small
// local `offset` separately, computing:
//
//   absMercY = (p_h.y + tileOrigin.y) + p_l.y + offset.y
//
// Adding tileOrigin to p_h first (both large, compatible f32 magnitude) then
// p_l as a correction is the standard DSFUN reconstruction order. This is the
// same pattern used in endpointCosC and lineRimAlpha.
//
// For the Mercator arm (#proj<0.5), the camera-relative corner is now
// recomputed from the split as `(p_h − cam_h) + (p_l − cam_l) + offset`,
// consistent with lineEndpoint's formula.
//
// This test verifies the CPU-side model of the shader's arithmetic:
//
//   1. The DSFUN reconstruction (hi + lo + origin) matches the reference f64
//      absMerc to within f32 ULP at the absolute-Mercator scale — this bounds
//      the precision of the absLon/absLat conversion.
//
//   2. At high zoom (z=20+) both the old summed path and the new split path
//      round to the same f32 absolute-Mercator value — no regression.
//
//   3. The Mercator camera-relative formula `(p_h − cam_h) + (p_l − cam_l)`
//      reconstructs tile-local metres to sub-mm (same DSFUN contract as
//      lineEndpoint; already covered by dsfun-precision-fuzz.test.ts — here
//      for completeness).
//
// Note: the visible jitter at high zoom in non-Mercator projections comes from
// f32 degree quantisation (ULP at 127° ≈ 1.7 m >> pixel size at z=22 ≈ 18 mm)
// which limits BOTH paths equally. Eliminating that requires a Mercator-space
// flat_rel that avoids the degree conversion — a separate follow-up. This PR
// correctly threads the DSFUN split through finalize_corner so the shader has
// the best possible absMerc before the degree conversion, matching the pattern
// used by endpointCosC and lineRimAlpha.

import { describe, it, expect } from 'vitest'

const A = 6378137  // Web Mercator earth radius (m)

/** Tile extent in Mercator metres at zoom z. */
function tileExtentM(z: number): number {
  return (2 * Math.PI * A) / Math.pow(2, z)
}

/** Deterministic LCG RNG (same shape as dsfun-precision-fuzz.test.ts). */
function makeRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s ^= s << 13; s |= 0
    s ^= s >>> 17
    s ^= s << 5;  s |= 0
    return (s >>> 0) / 0x1_0000_0000
  }
}

const f32 = Math.fround

/**
 * DSFUN split of a tile-local Mercator value (mirrors packDSFUNLineVertices):
 *   local = absMerc − tileOrigin  (f64)
 *   p_h   = fround(local)
 *   p_l   = fround(local − p_h)
 */
function splitTileLocal(absMerc: number, tileOrigin: number): [number, number] {
  const local = absMerc - tileOrigin
  const h = f32(local)
  const l = f32(local - h)
  return [h, l]
}

/**
 * NEW (#598) shader absMercY: `(p_h + tileOrigin) + p_l + offset`.
 * Mirrors finalize_corner's non-Mercator absMercY expression.
 */
function newAbsMercY(p_h: number, p_l: number, tileOrigin: number, offset = 0): number {
  return f32(f32(f32(p_h) + f32(tileOrigin)) + f32(p_l) + f32(offset))
}

/**
 * NEW (#598) camera-relative Mercator X for the Mercator arm:
 *   (p_h − cam_h) + (p_l − cam_l) + offset
 * Mirrors finalize_corner's mercCorner expression.
 */
function newMercCornerX(p_h: number, p_l: number, cam_h: number, cam_l: number, offset = 0): number {
  return f32(f32(f32(p_h) - f32(cam_h)) + f32(f32(p_l) - f32(cam_l)) + f32(offset))
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('#598 finalize_corner DSFUN split threading', () => {

  it('absMercY = (p_h + tileOrigin) + p_l lands within 1 f32-ULP of f32(absMerc)', () => {
    // Verify the new reconstruction lands at or near the best representable
    // f32 value for the given absMerc. Since tileOrigin and absMerc are both
    // multiples of f32-ULP at their magnitude, the result must equal f32(absMerc).
    const rng = makeRng(0x59800)
    const MY_MAX = Math.PI * A * 0.85

    for (let z = 0; z <= 22; z++) {
      const ext = tileExtentM(z)
      let worst = 0

      for (let i = 0; i < 2_000; i++) {
        const tileOriginY = f32((rng() * 2 - 1) * (MY_MAX - ext))
        // absMerc is tileOrigin + small local value; tileOrigin is already f32.
        const localY = (rng() * 2 - 1) * ext
        const absMercY = tileOriginY + localY  // f64

        const [p_h, p_l] = splitTileLocal(absMercY, tileOriginY)
        const reconstructed = newAbsMercY(p_h, p_l, tileOriginY)

        // The error must be at most 1 ULP of the result (standard DSFUN bound).
        const ulp = Math.abs(reconstructed) / Math.pow(2, 23)
        const err = Math.abs(reconstructed - f32(absMercY))
        if (err > worst) worst = err

        // Allow at most 1 ULP — strict DSFUN contract.
        expect(err).toBeLessThanOrEqual(ulp + Number.EPSILON)
      }
    }
  })

  it('absMercY with offset: small offset does not exceed 1 ULP error', () => {
    // cornerLocal = base + offset (offset = screen-quad half-width, O(1-100 m)).
    // Verify that adding an offset through the new path stays within 1 ULP.
    const rng = makeRng(0x598ff)
    const MY_MAX = Math.PI * A * 0.85
    const ext = tileExtentM(20)  // z=20

    for (let i = 0; i < 5_000; i++) {
      const tileOriginY = f32((rng() * 2 - 1) * (MY_MAX - ext))
      const localY = (rng() * 2 - 1) * ext
      const absMercY = tileOriginY + localY
      const offsetY = f32((rng() * 2 - 1) * 100)  // up to ±100 m offset

      const [p_h, p_l] = splitTileLocal(absMercY, tileOriginY)
      const reconstructed = newAbsMercY(p_h, p_l, tileOriginY, offsetY)

      const reference = f32(f32(absMercY) + offsetY)
      const ulp = Math.abs(reconstructed) / Math.pow(2, 23)
      const err = Math.abs(reconstructed - reference)
      expect(err).toBeLessThanOrEqual(ulp + Number.EPSILON)
    }
  })

  it('Mercator cam-relative corner: (p_h − cam_h) + (p_l − cam_l) sub-mm at z=20', () => {
    // This mirrors the lineEndpoint / dsfun-precision-fuzz contract for the
    // Mercator arm of finalize_corner's mercCorner expression.
    const rng = makeRng(0x598a0)
    const ext = tileExtentM(20)
    const MX_MAX = Math.PI * A

    let worstM = 0
    for (let i = 0; i < 5_000; i++) {
      const tileOriginX = f32((rng() * 2 - 1) * (MX_MAX - ext))
      const absMercX = tileOriginX + (rng() * 2 - 1) * ext

      const [p_h, p_l] = splitTileLocal(absMercX, tileOriginX)
      // cam_h/cam_l split of camera absolute Mercator X
      const camAbsX = absMercX - (rng() * 2 - 1) * 100  // cam ~100 m from vertex
      const cam_h = f32(camAbsX - tileOriginX)
      const cam_l = f32((camAbsX - tileOriginX) - cam_h)

      // Reference: true tile-local relative to camera
      const refRelX = absMercX - camAbsX

      const reconstructed = newMercCornerX(p_h, p_l, cam_h, cam_l)
      const errM = Math.abs(reconstructed - refRelX)
      if (errM > worstM) worstM = errM
    }

    console.log(`[Merc cam-rel z=20] worst: ${(worstM * 1000).toFixed(6)} mm`)
    expect(worstM).toBeLessThan(1e-3)  // sub-mm
  })

  it('both paths agree at z=22 (no regression from ordering change)', () => {
    // At z=22, p_l is sub-nanometre — both orderings round to the same f32.
    // This test documents that the fix does NOT change shader output at high
    // zoom (no unintended regression).
    const rng = makeRng(0x59822)
    const ext = tileExtentM(22)
    const MY_MAX = Math.PI * A * 0.85
    let mismatches = 0

    for (let i = 0; i < 10_000; i++) {
      const tileOriginY = f32((rng() * 2 - 1) * (MY_MAX - ext))
      const localY = (rng() * 2 - 1) * ext
      const absMercY = tileOriginY + localY

      const [p_h, p_l] = splitTileLocal(absMercY, tileOriginY)

      // OLD path: f32(p_h + p_l) + tileOrigin
      const cornerOld = f32(f32(p_h) + f32(p_l))
      const absOld = f32(cornerOld + f32(tileOriginY))

      // NEW path: (p_h + tileOrigin) + p_l
      const absNew = newAbsMercY(p_h, p_l, tileOriginY)

      // At z=22 both must agree (p_l sub-nanometre, below f32 resolution)
      if (absOld !== absNew) mismatches++
    }

    console.log(`[z=22] path agreement mismatches: ${mismatches}/10000`)
    // Both paths give identical results at z=22 — the fix is transparent
    // at high zoom and only improves coarser-zoom tiles.
    expect(mismatches).toBe(0)
  })
})
