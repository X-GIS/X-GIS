// #1397 — the extrusion light is VIEWPORT-anchored, so it rotates with the map.
//
// Mapbox `light.anchor` defaults to `viewport`: the light is fixed to the
// SCREEN, so turning the map has to turn the light with it. MapLibre does that
// in `fillExtrusionUniformValues` — `mat3.fromRotation(lightMat,
// transform.bearingInRadians)` premultiplied into `u_lightpos` before it
// reaches the shader. X-GIS packed the raw light, so the lit and unlit wall
// sets stayed pinned to true north and every wall the camera faced darkened to
// the shading floor as soon as the map was rotated.
//
// DIRECTION OF ROTATION. X-GIS's light lane is (East, North, Up) dotted against
// a face normal built in the vertex's own ENU frame, while MapLibre's is a tile
// frame whose y axis points SOUTH; the two do not correspond by a clean
// component swap, so the sign here was settled by MEASUREMENT rather than by
// deriving the frame map. Over London at z16/pitch 59.4, buildings-only,
// mean |Δ| per channel against MapLibre:
//
//   bearing 90, un-rotated (pre-fix)          9.28   mean-RGB gap 12.5
//   bearing 90, rotated by +bearing            8.76   mean-RGB gap 13.7
//   bearing 90, rotated by −bearing            5.82   mean-RGB gap  0.5   ← this
//   bearing 0 (rotation is a no-op)            4.88   mean-RGB gap  1.5
//
// and bearings 45 / 225 land at 6.36 / 7.55, i.e. inside the un-rotated
// bearing-0 band rather than spiking the way a 90°-wrong light would.
//
// The test pins the rotation as a pure function of bearing — the renderer's
// uniform write itself needs a GPU, so this mirrors its math (a divergence
// between the two is caught by the London render gate, not here).

import { describe, it, expect } from 'vitest'

const DEG2RAD = Math.PI / 180

/** The renderer's light packing (vector-tile-renderer.ts, `light_dir_ecef`,
 *  flat arm) in its (East, North, Up) frame. */
function lightENU(
  position: [number, number, number],
  bearingDeg: number,
): [number, number, number] {
  const [lRad, lAz, lPol] = position
  // sphericalToCartesian — azimuth +90° so 0° points north (MapLibre's).
  const lAzR = (lAz + 90) * DEG2RAD
  const lPolR = lPol * DEG2RAD
  const LE0 = lRad * Math.cos(lAzR) * Math.sin(lPolR)
  const LN0 = lRad * Math.sin(lAzR) * Math.sin(lPolR)
  const LU = lRad * Math.cos(lPolR)
  const bR = bearingDeg * DEG2RAD
  const bC = Math.cos(bR)
  const bS = Math.sin(bR)
  return [LE0 * bC + LN0 * bS, -LE0 * bS + LN0 * bC, LU]
}

const DEFAULT_LIGHT: [number, number, number] = [1.15, 210, 30]

describe('#1397 — viewport-anchored extrusion light rotates with the bearing', () => {
  it('bearing 0 is a no-op — the historical baked default is unchanged', () => {
    const [E, N, U] = lightENU(DEFAULT_LIGHT, 0)
    expect(E).toBeCloseTo(0.2875, 4)
    expect(N).toBeCloseTo(-0.49796, 5)
    expect(U).toBeCloseTo(0.99593, 5)
  })

  it('rotates the horizontal lane by −bearing about Up', () => {
    for (const bearing of [17, 45, 90, 180, 271, 359]) {
      const [E0, N0, U0] = lightENU(DEFAULT_LIGHT, 0)
      const [E, N, U] = lightENU(DEFAULT_LIGHT, bearing)
      const c = Math.cos(-bearing * DEG2RAD)
      const s = Math.sin(-bearing * DEG2RAD)
      // A rotation by −b: (E, N) → (E·c − N·s, E·s + N·c).
      expect(E).toBeCloseTo(E0 * c - N0 * s, 9)
      expect(N).toBeCloseTo(E0 * s + N0 * c, 9)
      expect(U).toBe(U0) // Up is untouched, exactly as MapLibre leaves z
    }
  })

  it('is a rotation — magnitude is bearing-invariant, and 360° is identity', () => {
    const ref = Math.hypot(...lightENU(DEFAULT_LIGHT, 0))
    for (const bearing of [17, 90, 203, 356]) {
      expect(Math.hypot(...lightENU(DEFAULT_LIGHT, bearing))).toBeCloseTo(ref, 9)
    }
    const [E, N] = lightENU(DEFAULT_LIGHT, 360)
    expect(E).toBeCloseTo(0.2875, 6)
    expect(N).toBeCloseTo(-0.49796, 5)
  })

  it('a non-default light position rotates the same way', () => {
    // Only the horizontal lane turns; the polar term rides through untouched.
    const custom: [number, number, number] = [1, 0, 60]
    const [, , U0] = lightENU(custom, 0)
    for (const bearing of [30, 150, 300]) {
      const [E, N, U] = lightENU(custom, bearing)
      expect(U).toBe(U0)
      expect(Math.hypot(E, N)).toBeCloseTo(Math.sin(60 * DEG2RAD), 9)
    }
  })

  it('fail-before witness: the un-rotated light is a quarter-turn off at 90°', () => {
    const [E0, N0] = lightENU(DEFAULT_LIGHT, 0)
    const [E, N] = lightENU(DEFAULT_LIGHT, 90)
    // The pre-fix packing shipped (E0, N0) at EVERY bearing; at 90° that is a
    // full quarter-turn from what the layer should be lit by.
    expect(Math.hypot(E - E0, N - N0)).toBeGreaterThan(0.5)
  })
})

describe('#1397 — the wall vertical gradient counts the extrusion base', () => {
  // MapLibre 5.24 fill_extrusion.vertex.glsl:
  //   directional *= (1 - vg) + vg * clamp((t + base) * pow(height/150, 0.5),
  //                                        mix(0.7, 0.98, 1 - intensity), 1)
  // The `+ base` term is what X-GIS omitted.
  const floorFor = (intensity: number) => 0.7 + (0.98 - 0.7) * (1 - intensity)
  const vgrad = (isTop: number, base: number, height: number, intensity = 0.5) =>
    Math.min(
      1,
      Math.max(floorFor(intensity), (isTop + base) * Math.sqrt(Math.max(height, 0) / 150)),
    )

  it('a ground-level building keeps its darkened wall bottom', () => {
    expect(vgrad(0, 0, 20)).toBeCloseTo(0.84, 6) // floor at intensity 0.5
    expect(vgrad(1, 0, 20)).toBeCloseTo(0.84, 6) // sqrt(20/150) = 0.365 → floor
    expect(vgrad(1, 0, 150)).toBeCloseTo(1, 6)
  })

  it('a FLOATING part gets no bottom darkening — the London Eye case', () => {
    // A rim capsule: base 128 m, absolute top 132 m. (0 + 128)·sqrt(132/150)
    // is far past 1, so both ends clamp to 1 — MapLibre draws no gradient.
    expect(vgrad(0, 128, 132)).toBe(1)
    expect(vgrad(1, 128, 132)).toBe(1)
    // Dropping the base term (the pre-fix spelling) pinned that bottom to the
    // floor instead — an 0.84× darkening MapLibre never applies.
    expect(Math.min(1, Math.max(0.84, 0 * Math.sqrt(132 / 150)))).toBeCloseTo(0.84, 6)
  })

  it('the floor tracks light intensity, as mix(0.7, 0.98, 1 - I)', () => {
    expect(floorFor(0)).toBeCloseTo(0.98, 6)
    expect(floorFor(1)).toBeCloseTo(0.7, 6)
    expect(vgrad(0, 0, 20, 1)).toBeCloseTo(0.7, 6)
  })
})
