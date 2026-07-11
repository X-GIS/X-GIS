import { describe, it, expect } from 'vitest'
import { emitLineWgsl } from './line'
import { projectGeomCpu, projectCpu } from './cpu-projections'

// ── #598 — non-Mercator high-zoom line jitter: closed-form precision budget ──
//
// The flat non-Mercator branch of the line VS (finalize_corner) used to feed
// the projection an ABSOLUTE longitude reconstructed as `(corner +
// tile_origin_merc) / (DEG2RAD·R)` — a lossy f32 degree at ~127° (ULP ≈ 1.7 m)
// on top of the tile-origin f32 rounding — so `project`'s internal
// radians(abs_lon) − radians(clon) cancellation left the stroke shaking ~2 m at
// deep zoom in ortho/azimuthal/stereo/equirect/natural-earth.
//
// The fix feeds a PRECISE camera-relative longitude instead: `corner − (cam_h +
// cam_l)` is the DSFUN camera-relative tile-local Mercator X (the big tile-origin
// magnitude cancels before f32 — the SAME operands the proven-precise Mercator
// branch uses), so `d_lon = that / (DEG2RAD·R) = abs_lon − clon` to sub-metre
// precision, and the projection is recentred onto clon = 0.
//
// This is an ANALYTIC render-error-budget test (no GPU): a trusted f64 CPU
// projection (cpu-projections.ts, the same graph the shader emits) is the
// reference; the emulated shader forms the fed longitude in f32 the OLD and NEW
// way. Latitude is held exact so the assertion isolates the LONGITUDE round-trip
// the fix removes (the fix does not touch latitude — its Mercator magnitude is
// far smaller, so its residual is already sub-metre; see the total-error case).

const f = Math.fround
const R = 6378137
const DEG2RAD = Math.PI / 180
const CSE0 = DEG2RAD * R
const CSE0_F32 = f(DEG2RAD * R)
const mercX = (lonDeg: number) => lonDeg * DEG2RAD * R
const mercY = (latDeg: number) => R * Math.log(Math.tan(Math.PI / 4 + (latDeg * DEG2RAD) / 2))
const invMercLat = (y: number) => ((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180) / Math.PI

// Disc (ortho 3, azimuthal 4, stereographic 5) + pseudocylindrical (equirect 1,
// natural_earth 2). Globe (7) is 3D-ECEF, not this flat branch. Oblique (6) is a
// disc-free cylindrical world-copy form; the fix is projType-agnostic (it changes
// only the shared longitude fed to flat_rel), so this representative set proves it.
const NON_MERC = [1, 2, 3, 4, 5] as const

interface Scenario {
  pt: number
  clon: number
  clat: number
  tileWest: number
  tileSouth: number
  tileExtentM: number
}

// Emulate finalize_corner's flat_rel input for one vertex, both OLD and NEW,
// and return the camera-relative projected position each yields against the f64
// CPU projection. `latExact` isolates the longitude term when true.
function project(
  s: Scenario,
  vLon: number,
  vLat: number,
  mode: 'ideal' | 'old' | 'new',
  latExact: boolean,
): [number, number] {
  const { pt, clon, clat, tileWest, tileSouth, tileExtentM } = s
  // Renderer frame (vector-tile-renderer.ts): tile origin at the EXACT f64
  // tileMercX; cam_h+cam_l = split(camMercX − tileMercX); tile_origin_merc =
  // fround(tileMercX). Vertex DSFUN is tile-local relative to the EXACT origin
  // (same frame as cam — that is what makes the Mercator branch precise).
  const tileMercX = mercX(tileWest)
  const tileMercY = mercY(tileSouth)
  const tileOriginXf32 = f(tileMercX)
  const tileOriginYf32 = f(tileMercY)
  const camMercX = mercX(clon)
  const camRelX = camMercX - tileMercX
  const camH = f(camRelX)
  const camL = f(camRelX - camH)
  // tile-local Mercator of the vertex (DSFUN reconstruct → f32 corner).
  const vMercX = mercX(vLon)
  const vMercY = mercY(vLat)
  const cornerX = f(vMercX - tileMercX)
  const cornerY = f(vMercY - tileMercY)

  const tileRefLonF32 = f(f(tileOriginXf32 + f(0.5 * tileExtentM)) / CSE0_F32)

  if (mode === 'ideal') {
    const pg = projectGeomCpu(pt, vLon, vLat, clon, clat, vLon)
    const cv = projectCpu(pt, clon, clat, clon, clat)
    return [pg[0] - cv[0], pg[1] - cv[1]]
  }

  // latitude (shared old/new path — abs merc → lat degrees). Exact or f32 as asked.
  const absMercY = f(cornerY + tileOriginYf32)
  const latDeg = latExact ? vLat : f(invMercLat(absMercY))

  if (mode === 'old') {
    const absMercX = f(cornerX + tileOriginXf32)
    const absLon = f(absMercX / CSE0_F32)
    const pg = projectGeomCpu(pt, absLon, latDeg, clon, clat, absLon)
    const cv = projectCpu(pt, clon, clat, clon, clat)
    return [pg[0] - cv[0], pg[1] - cv[1]]
  }
  // new — precise camera-relative longitude, projection recentred onto clon = 0.
  const relMercX = f(f(cornerX - camH) - camL)
  const dLon = f(relMercX / CSE0_F32)
  const refLonRel = f(tileRefLonF32 - clon)
  const pg = projectGeomCpu(pt, dLon, latDeg, 0, clat, refLonRel)
  const cv = projectCpu(pt, 0, clat, 0, clat)
  return [pg[0] - cv[0], pg[1] - cv[1]]
}

function maxErr(s: Scenario, mode: 'old' | 'new', latExact: boolean): number {
  let m = 0
  // sample a grid of vertices spanning the tile
  for (let i = 0; i <= 6; i++)
    for (let j = 0; j <= 6; j++) {
      const vLon = s.tileWest + (i / 6) * (s.tileExtentM / CSE0)
      const vLat = invMercLat(mercY(s.tileSouth) + (j / 6) * s.tileExtentM)
      const ideal = project(s, vLon, vLat, 'ideal', latExact)
      const got = project(s, vLon, vLat, mode, latExact)
      m = Math.max(m, Math.hypot(got[0] - ideal[0], got[1] - ideal[1]))
    }
  return m
}

describe('#598 finalize_corner — non-Mercator longitude precision', () => {
  // A deep-zoom tile at Seoul's longitude (127°), where the Mercator X magnitude
  // (~1.41e7 m) makes the absolute-degree f32 round-trip worst. The camera sits
  // ~4 km west of the tile (a realistic within-viewport offset, and past the
  // azimuthal c<1e-4 rad singularity guard that would otherwise fold every
  // near-dead-centre vertex to the origin).
  const OFFSET_DEG = 0.05
  const zoomTile = (z: number): Omit<Scenario, 'pt'> => {
    const extentDeg = 360 / Math.pow(2, z)
    return {
      clon: 126.9784,
      clat: 37.5665,
      tileWest: 126.9784 + OFFSET_DEG,
      tileSouth: 37.5665 + OFFSET_DEG,
      tileExtentM: extentDeg * DEG2RAD * R,
    }
  }

  it('the absolute-degree round-trip leaks a metric longitude error the camera-relative path deletes', () => {
    // The OLD longitude error is ZOOM-INDEPENDENT (it is the abs-longitude f32
    // ULP at ~127° ≈ 0.4 m, on top of the tile-origin rounding) — sub-pixel at
    // low zoom but several pixels of visible shake once deep zoom shrinks the
    // metre. The NEW camera-relative delta drops it three orders of magnitude.
    for (const z of [16, 18, 20]) {
      const base = zoomTile(z)
      for (const pt of NON_MERC) {
        const s: Scenario = { pt, ...base }
        const eOld = maxErr(s, 'old', /* latExact */ true)
        const eNew = maxErr(s, 'new', /* latExact */ true)
        // OLD reproduces the bug: the absolute-degree round-trip shakes the stroke.
        expect(eOld, `pt${pt} z${z} OLD`).toBeGreaterThan(0.2)
        // NEW drops to the DSFUN budget — camera-relative longitude, no cancellation.
        expect(eNew, `pt${pt} z${z} NEW`).toBeLessThan(0.01)
        // and it is a large, unambiguous improvement (>20×).
        expect(eNew, `pt${pt} z${z} ratio`).toBeLessThan(eOld * 0.05)
      }
    }
  })

  it('end-to-end (realistic lossy latitude) strictly improves the total error', () => {
    // Latitude keeps the abs-degree path (no linear camera-relative form), so a
    // ~0.4 m residual remains — but removing the (larger) longitude round-trip
    // still cuts the total error at every projType/zoom.
    for (const z of [16, 18, 20]) {
      const base = zoomTile(z)
      for (const pt of NON_MERC) {
        const s: Scenario = { pt, ...base }
        const eOld = maxErr(s, 'old', /* latExact */ false)
        const eNew = maxErr(s, 'new', /* latExact */ false)
        expect(eNew, `pt${pt} z${z} total`).toBeLessThan(eOld * 0.9)
      }
    }
  })
})

describe('#598 finalize_corner — emitted WGSL wiring (fails on the pre-fix abs-degree path)', () => {
  const body = () => {
    const w = emitLineWgsl(false)
    const s = w.indexOf('fn finalize_corner')
    return w.slice(s, w.indexOf('\nfn ', s + 5))
  }

  it('feeds flat_rel the DSFUN camera-relative longitude, not the absolute degree', () => {
    const b = body()
    // camera-relative longitude: corner.x − cam_h.x − cam_l.x (the precise DSFUN delta).
    expect(b).toContain('corner.x - tile.cam_h.x')
    expect(b).toContain('tile.cam_l.x')
    // the old lossy reconstruction `(corner + tile_origin_merc).x / …` for the
    // LONGITUDE must be gone (the abs-merc reconstruction survives only for .y / lat).
    expect(b).not.toContain('(corner + tile.tile_origin_merc).x')
  })

  it('recentres the projection onto clon = 0 (proj_params.y → 0, ref_lon → tile_ref_lon − clon)', () => {
    const b = body()
    // proj_params passed to flat_rel with y zeroed.
    expect(b).toContain(
      'vec4<f32>(tile.proj_params.x, 0.0, tile.proj_params.z, tile.proj_params.w)',
    )
    // ref_lon recentred by subtracting clon.
    expect(b).toContain('- tile.proj_params.y')
  })
})
