// #777 cluster I-B — icon-keep-upright dispatchIcon rotation fold.
//
// Under symbol-placement=line + icon-rotation-alignment=map, a line-placed icon
// (OFM road_oneway arrows) follows the per-segment tangent. Mapbox
// `icon-keep-upright: true` keeps that icon facing up by flipping a
// downward-pointing tangent 180° into the upright half-plane — the icon twin of
// the text keep-upright flip (text-stage.ts:1500-1530, `midAngle > π/2`).
//
// dispatchIcon is an anon closure inside LabelPass.execute; the fold math is
// extracted to `resolveIconRotateRad` (exported for unit coverage, the
// established label-pass helper pattern) and exercised here directly.
//
// DEFAULT CAUTION: the fold activates ONLY when keepUpright is EXPLICITLY true.
// keepUpright undefined (absent) or false leaves the tangent untouched, so the
// resolved rotateRad is byte-identical to today's always-follow-tangent render.

import { describe, it, expect } from 'vitest'
import { resolveIconRotateRad } from './label-pass'

const DEG = Math.PI / 180
/** Resolved rotateRad back to degrees, normalised to (-180°, 180°]. */
function normDeg(rad: number): number {
  let d = (rad / DEG) % 360
  if (d > 180) d -= 360
  if (d <= -180) d += 360
  return d
}
/** In the upright half-plane the icon "faces up": screen-space angle in (-90°, 90°]. */
function isUpright(rad: number): boolean {
  const d = normDeg(rad)
  return d > -90 && d <= 90
}

describe('resolveIconRotateRad — icon-keep-upright half-plane fold (#777 I-B)', () => {
  it('downward tangent (170°) + keepUpright true → folded into the upright half-plane', () => {
    // FAIL-BEFORE: without the fold the tangent stays 170° (points down) and the
    // resolved angle is NOT upright — this assertion is the red state.
    const rad = resolveIconRotateRad(0, 170, true, true)
    expect(isUpright(rad)).toBe(true)
    // 170° + 180° = 350° ≡ -10° (mod 360): the exact folded rotation.
    expect(rad).toBeCloseTo(350 * DEG, 10)
  })

  it('downward tangent (170°) + keepUpright ABSENT → unchanged (byte-identical default)', () => {
    const rad = resolveIconRotateRad(0, 170, true, undefined)
    expect(rad).toBeCloseTo(170 * DEG, 10)
    // The default follows the tangent even when it points down — NOT upright.
    expect(isUpright(rad)).toBe(false)
  })

  it('downward tangent (170°) + keepUpright false → unchanged (explicit opt-out = default)', () => {
    expect(resolveIconRotateRad(0, 170, true, false)).toBeCloseTo(170 * DEG, 10)
  })

  it('upward tangent (30°) + keepUpright true → NOT folded (already upright)', () => {
    // 30° is inside (-90°, 90°] — the fold is a no-op; only downward tangents flip.
    expect(resolveIconRotateRad(0, 30, true, true)).toBeCloseTo(30 * DEG, 10)
  })

  it('near-vertical-down tangent (-170°) + keepUpright true → folded upright', () => {
    const rad = resolveIconRotateRad(0, -170, true, true)
    expect(isUpright(rad)).toBe(true)
    // -170° + 180° = 10°.
    expect(rad).toBeCloseTo(10 * DEG, 10)
  })

  it('rotation-alignment ≠ map (viewport/point) → no tangent, no fold regardless of flag', () => {
    // A point / viewport icon contributes no tangent; keepUpright can never
    // change its rotation. Resolves to the authored icon-rotate alone.
    expect(resolveIconRotateRad(45, 170, false, true)).toBeCloseTo(45 * DEG, 10)
  })

  it('composes the authored icon-rotate with the folded tangent (road_oneway: rotate 90)', () => {
    // road_oneway authors icon-rotate: 90. With keepUpright folding a 170°
    // tangent → 350°, the composed rotation is (90 + 350)° = 440°.
    expect(resolveIconRotateRad(90, 170, true, true)).toBeCloseTo(440 * DEG, 10)
    // Absent flag: (90 + 170)° = 260° — the un-folded baseline.
    expect(resolveIconRotateRad(90, 170, true, undefined)).toBeCloseTo(260 * DEG, 10)
  })
})
