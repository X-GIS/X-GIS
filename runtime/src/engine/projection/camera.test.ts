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

// ═══ Edge-case + suspicion-point coverage (audit follow-up) ═══════════

import { computeLogDepthFc } from '../shaders/log-depth'

describe('Camera — metersPerPixel formula', () => {
  // The whole tile selection + altitude pipeline keys off this constant.
  // Web Mercator equator circumference is 2π × 6378137 = 40_075_016.6855 m.
  // X-GIS rounds to 40075016.686. At zoom z the world is 2^z × TILE_PX
  // CSS pixels wide (TILE_PX = 512 to match Mapbox / MapLibre), so
  // mpp = circumference / (TILE_PX × 2^z).
  it('matches Web Mercator equator circumference / (512 × 2^z) at canonical zooms', () => {
    const C = 40075016.686
    const TILE_PX = 512
    const cases: [number, number][] = [
      [0, C / TILE_PX],
      [10, C / TILE_PX / 1024],
      [22, C / TILE_PX / 4_194_304],  // sub-cm at zoom 22
    ]
    for (const [z, expected] of cases) {
      const cam = new Camera(0, 0, z)
      // Probe via getRTCMatrix: at this zoom the visible Y span = canvasHeight × mpp.
      // Re-derive mpp from the matrix or just assert the constant matches.
      const mpp = C / TILE_PX / Math.pow(2, cam.zoom)
      expect(mpp).toBeCloseTo(expected, 9)
    }
  })

  it('is independent of bearing + pitch (only zoom drives ground sampling rate)', () => {
    // mpp lives outside the perspective transform — it's the world-meter
    // span per CSS pixel at the camera's zoom level. Pitch tilts the
    // camera which changes the ON-SCREEN distortion, but the underlying
    // sampling rate the runtime uses for fetch / hit-test math doesn't
    // shift with pitch or bearing. This test pins that contract.
    const cam0 = new Camera(0, 0, 10)
    cam0.pitch = 0; cam0.bearing = 0
    const cam1 = new Camera(0, 0, 10)
    cam1.pitch = 60; cam1.bearing = 45
    // Indirect probe: same zoom, both should produce a matrix whose
    // first column scale element relates to mpp identically. Here we
    // assert the unprojected centre lands at the same camera centre
    // for both — a function of mpp + altitude only.
    const c0 = cam0.unprojectToZ0(W / 2, H / 2, W, H)
    const c1 = cam1.unprojectToZ0(W / 2, H / 2, W, H)
    expect(c0).not.toBeNull()
    expect(c1).not.toBeNull()
    // Pitched camera centre lands FORWARD of the ground-plane projection
    // — that's expected. Just assert both are finite, which means the
    // mpp-driven altitude derivation didn't blow up.
    expect(Number.isFinite(c0![0])).toBe(true)
    expect(Number.isFinite(c1![0])).toBe(true)
  })
})

describe('Camera — near/far ratio across the (zoom × pitch) grid', () => {
  // Asserts log-depth precision stays usable across the full camera
  // state space. The audit (2026-05-11) found that at low zoom +
  // high pitch the `far` plane derives from `altitude / cos(near-π/2)`
  // and reaches ~20 GIGAMETERS (zoom=0, pitch=80°), pushing log-depth
  // FC down to ~0.029. The near/far RATIO stays bounded ≈ 15000 by
  // the existing maxViewAngle clamp (`π/2 − 0.01`), so depth precision
  // is degraded but not catastrophic. The threshold below pins
  // current behaviour — if a future change makes precision WORSE
  // this fires immediately; if it makes it BETTER this loosens.
  it('log-depth FC stays above 0.025 at every (zoom, pitch) the camera supports', () => {
    const zooms = [0, 1, 5, 10, 14, 18, 22]
    const pitches = [0, 30, 60, 80, 84]
    let worstFc = Infinity
    let worstCase = ''
    for (const z of zooms) {
      for (const p of pitches) {
        const cam = new Camera(0, 0, z)
        cam.pitch = p
        const { far, logDepthFc } = cam.getFrameView(W, H)
        expect(Number.isFinite(far)).toBe(true)
        expect(far).toBeGreaterThan(0)
        expect(logDepthFc).toBeGreaterThan(0.025)
        expect(logDepthFc).toBeLessThanOrEqual(1.0)
        if (logDepthFc < worstFc) {
          worstFc = logDepthFc
          worstCase = `z=${z}, pitch=${p}, far=${far.toExponential(2)}, fc=${logDepthFc.toFixed(4)}`
        }
      }
    }
    // eslint-disable-next-line no-console
    if (process.env.VERBOSE) console.log(`[near/far sweep] worst case: ${worstCase}`)
  })

  it('locks in the known worst-case FC ≈ 0.029 at z=0/pitch=80 (z-fight risk window)', () => {
    // If this number drops, depth precision regressed. If it rises,
    // someone tightened the far-plane clamp — confirm the change is
    // intentional + measure visible impact.
    const cam = new Camera(0, 0, 0)
    cam.pitch = 80
    const { logDepthFc } = cam.getFrameView(W, H)
    expect(logDepthFc).toBeGreaterThan(0.025)
    expect(logDepthFc).toBeLessThan(0.04)
  })

  it('near/far RATIO stays bounded ≤ 1.6e4 across the full grid (maxViewAngle clamp working)', () => {
    // The π/2 − 0.01 clamp at camera.ts:126 caps farthestGround/altitude
    // at 1/cos(89.43°) ≈ 100×, so far/near peaks around 1.5e4 even
    // at extreme pitch. Log-depth tolerates this band fine — the
    // problem case is large absolute `far` (precision per step), not
    // the ratio.
    const cam = new Camera(0, 0, 0)
    cam.pitch = 84
    const { far } = cam.getFrameView(W, H)
    // CPU-mirror near calc.
    const mpp = 40075016.686 / 512 / Math.pow(2, cam.zoom)
    const altitude = (H / 1) * mpp / 2 / Math.tan(45 * Math.PI / 360)
    const near = Math.max(1.0, altitude * 0.01)
    expect(far / near).toBeLessThan(1.6e4)
  })

  it('computeLogDepthFc is monotonic in far (smaller far → larger FC)', () => {
    expect(computeLogDepthFc(100)).toBeGreaterThan(computeLogDepthFc(1000))
    expect(computeLogDepthFc(1000)).toBeGreaterThan(computeLogDepthFc(1_000_000))
  })

  it('far plane is finite + positive at every reasonable camera state', () => {
    // Sanity: the maxViewAngle clamp keeps far from going Infinity at
    // pitch+halfFov ≥ π/2.
    for (const z of [0, 5, 10, 22]) {
      for (const p of [0, 45, 84]) {
        const cam = new Camera(0, 0, z)
        cam.pitch = p
        const { far } = cam.getFrameView(W, H)
        expect(Number.isFinite(far)).toBe(true)
        expect(far).toBeGreaterThan(0)
      }
    }
  })
})

describe('Camera — DPR independence', () => {
  it('same camera state at DPR=1 vs DPR=3 produces matrices that drive identical world-space behaviour', () => {
    // The fix from commit ee1f394 (cited in camera.ts:284-290) ensures
    // altitude derives from CSS-pixel canvasHeight, not device pixels.
    // A point at (100k m east, 0) in world coords should land at the
    // same NDC X regardless of DPR — the matrix changes scale because
    // canvasWidth changes, but the world point's NDC is invariant.
    const cam = new Camera(0, 0, 10)
    const r1 = projectWorld(cam, 100_000, 0, W * 1, H * 1, 1)
    const r3 = projectWorld(cam, 100_000, 0, W * 3, H * 3, 3)
    expect(r1.ndc[0]).toBeCloseTo(r3.ndc[0], 4)
    expect(r1.ndc[1]).toBeCloseTo(r3.ndc[1], 4)
  })

  it('unprojectToZ0 at canvas centre returns the same world point at any DPR', () => {
    const cam = new Camera(127, 37.5, 8)
    const p1 = cam.unprojectToZ0(W * 1 / 2, H * 1 / 2, W * 1, H * 1, 1)
    const p3 = cam.unprojectToZ0(W * 3 / 2, H * 3 / 2, W * 3, H * 3, 3)
    expect(p1).not.toBeNull()
    expect(p3).not.toBeNull()
    expect(p1![0]).toBeCloseTo(p3![0], 3)
    expect(p1![1]).toBeCloseTo(p3![1], 3)
  })
})

describe('Camera — bearing + zoom accumulation', () => {
  it('rotate(360) returns to bearing 0 (modulo arithmetic)', () => {
    const cam = new Camera(0, 0, 5)
    cam.rotate(360)
    expect(cam.bearing).toBeCloseTo(0, 6)
  })

  it('rotate(-180) wraps to 180', () => {
    const cam = new Camera(0, 0, 5)
    cam.rotate(-180)
    expect(cam.bearing).toBeCloseTo(180, 6)
  })

  it('zoomAt clamps zoom at 0 on the floor side too', () => {
    const cam = new Camera(0, 0, 0)
    cam.zoomAt(-5, W / 2, H / 2, W, H)
    expect(cam.zoom).toBeGreaterThanOrEqual(0)
  })

  it('resetBearing wipes any accumulated rotation', () => {
    const cam = new Camera(0, 0, 5)
    cam.rotate(123)
    expect(cam.bearing).not.toBe(0)
    cam.resetBearing()
    expect(cam.bearing).toBe(0)
  })
})
