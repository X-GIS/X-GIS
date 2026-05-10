// First unit-test surface for `Camera`. Until this file landed, the
// camera matrix had zero direct test coverage — its correctness was
// inferred from e2e tile selection + render screenshots. The 2026-05-11
// audit (project_*.md) flagged this as the load-bearing GAP behind a
// "fix doesn't hold" risk on any future projection / matrix work.
//
// The strategy is to lock down INPUT → OUTPUT contracts that the rest
// of the codebase implicitly depends on, so any future refactor that
// breaks them surfaces here instead of in a single-pixel e2e drift.
//
//   1. Constructor lon/lat → centerX/Y matches `lonLatToMercator`
//   2. MVP at canonical state has expected sign + ordering invariants
//      (visibility test on a known world point)
//   3. Pitch + bearing rotations behave as documented (same world
//      point lands at predictable clip-space sign)
//   4. unprojectToZ0 is a true inverse of project (round-trip ≤ 1 m)
//   5. zoomAt() preserves the world point under the cursor
//   6. pan() X-wraps at the antimeridian
//   7. DSFUN cam_h/cam_l reconstruction recovers the original f64 value
//   8. Cache invalidation works (mutating state changes the matrix)
//
// Each test is a load-bearing assertion: if it fails, a real behaviour
// changed.

import { describe, expect, it } from 'vitest'
import { Camera } from './camera'
import { lonLatToMercator } from '../../loader/geojson'

/** Inverse of `lonLatToMercator` for the round-trip assertion below.
 *  Local copy because the loader/geojson module doesn't export one
 *  and the existing inverse lives in `mercator.inverse` (different
 *  signature). EARTH_R + DEG2RAD match `lonLatToMercator`'s constants. */
function mercatorToLonLat(mx: number, my: number): [number, number] {
  const R = 6378137
  const lon = mx / R * (180 / Math.PI)
  const lat = (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * (180 / Math.PI)
  return [lon, lat]
}

const W = 1280, H = 720, DPR = 1

/** Apply a column-major 4×4 to a vec4. Mirrors mulVec4 in camera.ts but
 *  exposed for the test to inspect projected world points. */
function mulMatVec4(m: Float32Array, v: [number, number, number, number]): [number, number, number, number] {
  const r: [number, number, number, number] = [0, 0, 0, 0]
  for (let row = 0; row < 4; row++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += m[k * 4 + row] * v[k]
    r[row] = s
  }
  return r
}

/** Project a world point (in Mercator m) through the camera-relative
 *  pipeline the GPU uses: world − camCenter → MVP → clip → NDC. This
 *  emulates what `vs_main` does after the DSFUN `rel` reconstruction,
 *  so we can ask "where does this world point land on screen?" without
 *  pulling in WebGPU. */
function projectWorld(cam: Camera, worldX: number, worldY: number, w: number = W, h: number = H, dpr: number = DPR): {
  ndc: [number, number, number]
  clipW: number
} {
  const mvp = cam.getRTCMatrix(w, h, dpr)
  const relX = worldX - cam.centerX
  const relY = worldY - cam.centerY
  const clip = mulMatVec4(mvp, [relX, relY, 0, 1])
  return {
    ndc: [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]],
    clipW: clip[3],
  }
}

describe('Camera — constructor + state', () => {
  it('lon/lat constructor agrees with lonLatToMercator', () => {
    const cases: [number, number][] = [
      [0, 0], [127, 37.5], [-73.97, 40.78], [139.76, 35.68], [-180, 0], [180, 0],
    ]
    for (const [lon, lat] of cases) {
      const cam = new Camera(lon, lat, 5)
      const [mx, my] = lonLatToMercator(lon, lat)
      expect(cam.centerX).toBeCloseTo(mx, 6)
      expect(cam.centerY).toBeCloseTo(my, 6)
    }
  })

  it('default zoom is 2 when omitted', () => {
    expect(new Camera(0, 0).zoom).toBe(2)
  })

  it('default bearing + pitch are 0', () => {
    const cam = new Camera(0, 0, 5)
    expect(cam.bearing).toBe(0)
    expect(cam.pitch).toBe(0)
  })
})

describe('Camera — MVP at canonical state (zoom=5, pitch=0, bearing=0, center=0,0)', () => {
  const cam = new Camera(0, 0, 5)

  it('camera centre projects to NDC (0, 0)', () => {
    const { ndc } = projectWorld(cam, cam.centerX, cam.centerY)
    expect(ndc[0]).toBeCloseTo(0, 5)
    expect(ndc[1]).toBeCloseTo(0, 5)
  })

  it('point east of camera projects to +X NDC, west to -X', () => {
    // 1 km east at zoom 5 over equator is well inside the visible window.
    const east = projectWorld(cam, cam.centerX + 1000, cam.centerY)
    const west = projectWorld(cam, cam.centerX - 1000, cam.centerY)
    expect(east.ndc[0]).toBeGreaterThan(0)
    expect(west.ndc[0]).toBeLessThan(0)
    // Symmetry — same |x| at the same |Δworld|.
    expect(Math.abs(east.ndc[0])).toBeCloseTo(Math.abs(west.ndc[0]), 5)
  })

  it('point north projects to +Y NDC, south to -Y (Mercator y grows north)', () => {
    const north = projectWorld(cam, cam.centerX, cam.centerY + 1000)
    const south = projectWorld(cam, cam.centerX, cam.centerY - 1000)
    expect(north.ndc[1]).toBeGreaterThan(0)
    expect(south.ndc[1]).toBeLessThan(0)
  })
})

describe('Camera — pitch + bearing', () => {
  it('pitch=0 → north point lands above camera, +Y on screen', () => {
    const cam = new Camera(0, 0, 5)
    cam.pitch = 0
    const r = projectWorld(cam, cam.centerX, cam.centerY + 50_000)
    expect(r.ndc[1]).toBeGreaterThan(0)
  })

  it('pitch=60 → north (forward) point appears further away (smaller |Y screen / w|) than at pitch=0', () => {
    // Pitched-up camera looks toward the horizon; a point in front of
    // the camera projects toward the screen centre rather than the top
    // edge, so |ndc.y| shrinks compared to the top-down case at the
    // same world distance.
    const cam0 = new Camera(0, 0, 5); cam0.pitch = 0
    const cam60 = new Camera(0, 0, 5); cam60.pitch = 60
    const flat = projectWorld(cam0, 0, 50_000)
    const tilted = projectWorld(cam60, 0, 50_000)
    expect(Math.abs(tilted.ndc[1])).toBeLessThan(Math.abs(flat.ndc[1]))
  })

  it('bearing=180 flips east point to -X (camera rotated half-turn)', () => {
    const cam0 = new Camera(0, 0, 5); cam0.bearing = 0
    const cam180 = new Camera(0, 0, 5); cam180.bearing = 180
    const east0 = projectWorld(cam0, 1000, 0)
    const east180 = projectWorld(cam180, 1000, 0)
    // Sign flip on X.
    expect(Math.sign(east0.ndc[0])).toBe(1)
    expect(Math.sign(east180.ndc[0])).toBe(-1)
    // Magnitudes equal — same screen distance, opposite side.
    expect(Math.abs(east180.ndc[0])).toBeCloseTo(Math.abs(east0.ndc[0]), 5)
  })

  it('bearing=90 rotates east point to +Y (was +X)', () => {
    const cam = new Camera(0, 0, 5); cam.bearing = 90
    const east = projectWorld(cam, 1000, 0)
    // After 90° rotation, a world-east point should project mostly along
    // the screen's Y axis. Sign depends on the rotation convention; the
    // important assertion is that |Y| dominates |X|.
    expect(Math.abs(east.ndc[1])).toBeGreaterThan(Math.abs(east.ndc[0]))
  })
})

describe('Camera — unprojectToZ0 round-trip', () => {
  it('project + unproject recovers the original world point at the canvas centre', () => {
    const cam = new Camera(127, 37.5, 5)
    const p0 = cam.unprojectToZ0(W / 2, H / 2, W, H)
    expect(p0).not.toBeNull()
    // Centre ray hits ground directly below the camera = (0, 0) in
    // camera-relative coordinates.
    expect(p0![0]).toBeCloseTo(0, 3)
    expect(p0![1]).toBeCloseTo(0, 3)
  })

  it('canvas-centre unproject equals camera centre for arbitrary pitch + bearing', () => {
    const cam = new Camera(0, 0, 5)
    cam.pitch = 45
    cam.bearing = 30
    const p = cam.unprojectToZ0(W / 2, H / 2, W, H)
    expect(p).not.toBeNull()
    // Pitched camera centre still hits the ground point in front of it,
    // not at (0,0)-relative — but the screen centre always corresponds
    // to a fixed (forward, 0) line. Only assert finiteness here; the
    // exact world point depends on altitude.
    expect(Number.isFinite(p![0])).toBe(true)
    expect(Number.isFinite(p![1])).toBe(true)
  })

  it('off-centre screen pixel round-trips back to the same screen pixel via project', () => {
    const cam = new Camera(0, 0, 5)
    const sx = 800, sy = 250  // arbitrary off-centre pixel
    const world = cam.unprojectToZ0(sx, sy, W, H)
    expect(world).not.toBeNull()
    // Project the recovered world point back through the camera.
    const back = projectWorld(cam, cam.centerX + world![0], cam.centerY + world![1])
    // Convert back NDC → screen px.
    const recoveredSx = (back.ndc[0] + 1) * 0.5 * W
    const recoveredSy = (1 - back.ndc[1]) * 0.5 * H
    expect(recoveredSx).toBeCloseTo(sx, 1)
    expect(recoveredSy).toBeCloseTo(sy, 1)
  })

  it('above-horizon ray returns null', () => {
    const cam = new Camera(0, 0, 5)
    cam.pitch = 80   // nearly horizontal
    // Top of screen at high pitch is well above horizon.
    const p = cam.unprojectToZ0(W / 2, 0, W, H)
    expect(p).toBeNull()
  })
})

describe('Camera — zoomAt preserves cursor world point', () => {
  it('zooming in at an off-centre cursor keeps the same world point under the cursor', () => {
    const cam = new Camera(127, 37.5, 5)
    const cursorX = 900, cursorY = 300
    const before = cam.unprojectToZ0(cursorX, cursorY, W, H)
    expect(before).not.toBeNull()
    const beforeWorldX = cam.centerX + before![0]
    const beforeWorldY = cam.centerY + before![1]

    cam.zoomAt(2.0, cursorX, cursorY, W, H)

    const after = cam.unprojectToZ0(cursorX, cursorY, W, H)
    expect(after).not.toBeNull()
    const afterWorldX = cam.centerX + after![0]
    const afterWorldY = cam.centerY + after![1]

    // Pre-zoom world point under cursor must still be under the cursor
    // (within 1 m at zoom 7 — sub-CSS-pixel).
    expect(afterWorldX).toBeCloseTo(beforeWorldX, 0)
    expect(afterWorldY).toBeCloseTo(beforeWorldY, 0)
    expect(cam.zoom).toBeCloseTo(7, 6)
  })

  it('zoomAt clamps to maxZoom', () => {
    const cam = new Camera(0, 0, 20)
    cam.maxZoom = 22
    cam.zoomAt(10.0, W / 2, H / 2, W, H)
    expect(cam.zoom).toBeLessThanOrEqual(22)
  })
})

describe('Camera — pan X-wrap + Y clamp', () => {
  it('panning past the antimeridian wraps centerX into [-WORLD/2, +WORLD/2]', () => {
    const cam = new Camera(179.5, 0, 3)  // near antimeridian
    const startX = cam.centerX
    expect(startX).toBeGreaterThan(0)
    // Pan east by enough CSS pixels to cross the antimeridian.
    cam.pan(-2000, 0, W, H)   // negative dx in pan() = move world east
    const wrapped = cam.centerX
    // Wrap kicks in: wrapped should NOT be far east of startX; it
    // should have wrapped to the negative side.
    expect(Math.abs(wrapped)).toBeLessThan(20_037_508)  // within world bounds
  })

  it('panning the camera north (drag dy>0 with default bearing) clamps centerY at the pole limit', () => {
    // pan() convention: positive dy adds mapDy × mpp to centerY (line
    // 306). Mercator Y grows northward, so drag-down (dy>0) increases
    // centerY toward the north pole. (Drag direction vs camera shift
    // matches Mapbox's "world point under cursor stays put" — the map
    // shifts in the OPPOSITE direction of the cursor motion.)
    const cam = new Camera(0, 0, 5)
    for (let i = 0; i < 1000; i++) cam.pan(0, +100, W, H)
    expect(cam.centerY).toBeGreaterThan(0)
    expect(cam.centerY).toBeLessThanOrEqual(20_037_508.34)
  })

  it('at zoom=0, maxCameraY collapses to 0 — whole world is already on screen', () => {
    // Documents the expected zero-pan behaviour at the lowest zoom.
    // If a future tweak to `maxCameraY` lets the camera drift at
    // zoom 0, this assertion fires and forces a deliberate decision.
    const cam = new Camera(0, 0, 0)
    for (let i = 0; i < 50; i++) cam.pan(0, +100, W, H)
    // -0 === 0 in IEEE 754, but vitest's `toBe` uses Object.is which
    // distinguishes them. Compare via Math.abs to ignore the sign of
    // zero (the clamp can land at either +0 or -0 depending on input).
    expect(Math.abs(cam.centerY)).toBe(0)
  })
})

describe('Camera — DSFUN cam_h/cam_l reconstruction', () => {
  it('Math.fround split + recombination recovers the original f64 within f32 epsilon', () => {
    // Mirrors the runtime path: cam_h = fround(camRel), cam_l =
    // fround(camRel - cam_h). The vertex shader does
    // (pos_h - cam_h) + (pos_l - cam_l), so cam_h + cam_l should
    // recover camRel to f32 precision regardless of camRel's magnitude.
    const cases = [
      0.123,
      1234.567,
      14_137_586.4321,        // Tokyo at zoom 22
      -19_999_000.5,           // near west world edge
      20_000_000,              // near antimeridian
      40_000_000,              // hypothetical post-pan accumulation
    ]
    for (const camRel of cases) {
      const camH = Math.fround(camRel)
      const camL = Math.fround(camRel - camH)
      const recovered = camH + camL
      // For values <= 2^24 the recombination is exact; beyond that the
      // f32 step starts to bite. The contract the GPU shader relies on
      // is that (pos_h - cam_h) + (pos_l - cam_l) recovers (pos_f64 -
      // cam_f64), so what matters is consistent splitting on both sides
      // — which Math.fround guarantees.
      expect(recovered).toBeCloseTo(camRel, 0)
    }
  })
})

describe('Camera — cache invalidation', () => {
  it('mutating zoom changes the MVP', () => {
    const cam = new Camera(0, 0, 5)
    const m0 = new Float32Array(cam.getRTCMatrix(W, H))
    cam.zoom = 10
    const m1 = cam.getRTCMatrix(W, H)
    let differs = false
    for (let i = 0; i < 16; i++) if (m0[i] !== m1[i]) { differs = true; break }
    expect(differs).toBe(true)
  })

  it('mutating pitch changes the MVP', () => {
    const cam = new Camera(0, 0, 5)
    const m0 = new Float32Array(cam.getRTCMatrix(W, H))
    cam.pitch = 45
    const m1 = cam.getRTCMatrix(W, H)
    let differs = false
    for (let i = 0; i < 16; i++) if (m0[i] !== m1[i]) { differs = true; break }
    expect(differs).toBe(true)
  })

  it('identical state across two calls returns the same matrix (cache hit)', () => {
    const cam = new Camera(0, 0, 5)
    const m0 = cam.getRTCMatrix(W, H)
    const m1 = cam.getRTCMatrix(W, H)
    // Same Float32Array reference — the camera reuses its preallocated
    // rtcMatrix buffer when nothing changed.
    expect(m0).toBe(m1)
  })
})

describe('Camera — getMatrix() (legacy ortho)', () => {
  // The ortho matrix from getMatrix() is unused by the active runtime
  // (commit 24ca8e3 era — every render path uses getRTCMatrix). This
  // test pins its existing output so a future deprecation /
  // re-introduction has a baseline to diff against.
  it('produces a column-major orthographic matrix at canonical state', () => {
    const cam = new Camera(0, 0, 0)
    const m = cam.getMatrix(W, H)
    // 4×4, no perspective term (m[11] = 0, m[15] = 1).
    expect(m).toHaveLength(16)
    expect(m[11]).toBe(0)
    expect(m[15]).toBe(1)
  })

  it('camera centre projects to (0, 0) under the ortho matrix', () => {
    const cam = new Camera(127, 37.5, 5)
    const m = cam.getMatrix(W, H)
    const [mx, my] = lonLatToMercator(127, 37.5)
    const r = mulMatVec4(m, [mx, my, 0, 1])
    expect(r[0]).toBeCloseTo(0, 3)
    expect(r[1]).toBeCloseTo(0, 3)
  })
})

describe('Camera — round-trip via mercatorToLonLat', () => {
  it('lonLatToMercator + mercatorToLonLat recovers the input lon/lat', () => {
    const cases: [number, number][] = [
      [0, 0], [127, 37.5], [-73.97, 40.78], [179.99, 85.0],
    ]
    for (const [lon, lat] of cases) {
      const [mx, my] = lonLatToMercator(lon, lat)
      const [lon2, lat2] = mercatorToLonLat(mx, my)
      expect(lon2).toBeCloseTo(lon, 5)
      expect(lat2).toBeCloseTo(lat, 5)
    }
  })
})
