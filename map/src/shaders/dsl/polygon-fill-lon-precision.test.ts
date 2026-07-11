import { describe, it, expect } from 'vitest'
import { emitPolygonWgsl } from './polygon'
import { projectGeomCpu, projectCpu } from './cpu-projections'

// ── #598 — polygon FILL non-Mercator longitude precision (sibling parity) ──
//
// Commit e251b66 made the LINE outline's non-Mercator flat branch precise:
// finalize_corner feeds flat_rel a camera-relative d_lon = (corner − cam_h −
// cam_l)/(DEG2RAD·R) with the projection recentred onto clon = 0, deleting the
// radians(abs_lon) − radians(clon) f32 cancellation. The polygon FILL's disc
// arm (emitPolygonProjectionLadder, projType 1-6) was NOT given the same fix:
// it still fed flat_rel the LOSSY absolute longitude abs_lon = (local_merc +
// tile_origin_merc)/(DEG2RAD·R). The line fix therefore made the OUTLINE more
// precise than its own FILL, converting a previously-COINCIDENT shared jitter
// into a fill≠outline SEAM (~0.4 m, ~3 px at z20) at deep-zoom non-Mercator.
//
// The invariant is NOT "each path is precise" but "sibling paths use the SAME
// arithmetic". This test emulates, in f64 CPU (cpu-projections.ts — the same
// graph the shader emits), the LONGITUDE INPUT each path feeds flat_rel and
// asserts the fill's input coincides with the outline's. Latitude is held exact
// so the assertion isolates the longitude round-trip (#598 leaves latitude
// alone — the abs-degree latitude path is shared identically by fill AND
// outline, a separate GPU-gated epic).

const f = Math.fround
const R = 6378137
const DEG2RAD = Math.PI / 180
const CSE0_F32 = f(DEG2RAD * R)
const mercX = (lonDeg: number) => lonDeg * DEG2RAD * R
const mercY = (latDeg: number) => R * Math.log(Math.tan(Math.PI / 4 + (latDeg * DEG2RAD) / 2))
const invMercLat = (y: number) => ((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180) / Math.PI

// Disc (ortho 3, azimuthal 4, stereographic 5) + pseudocylindrical (equirect 1,
// natural_earth 2). Globe (7) is 3D-ECEF, not this flat branch. The fix is
// projType-agnostic (it changes only the shared longitude fed to flat_rel), so
// this representative set proves it.
const NON_MERC = [1, 2, 3, 4, 5] as const

interface Scenario {
  pt: number
  clon: number
  clat: number
  tileWest: number
  tileSouth: number
  tileExtentM: number
}

// Emulate the longitude fed to flat_rel by the OUTLINE (line finalize_corner,
// now precise), the pre-fix FILL (absolute degree) and the post-fix FILL
// (camera-relative, recentred). Returns the camera-relative projected position.
// `latExact` isolates the longitude term when true.
function project(
  s: Scenario,
  vLon: number,
  vLat: number,
  mode: 'ideal' | 'fillOld' | 'precise',
  latExact: boolean,
): [number, number] {
  const { pt, clon, clat, tileWest, tileSouth, tileExtentM } = s
  // Renderer frame (vector-tile-renderer.ts): tile origin at the EXACT f64
  // tileMercX; cam_h+cam_l = split(camMercX − tileMercX); tile_origin_merc =
  // fround(tileMercX). The quantized fill VS f32 tail carries local_merc =
  // vertex_merc − tile_origin_merc (same frame as cam — that is what makes the
  // Mercator branch, and now the disc branch, precise).
  const tileMercX = mercX(tileWest)
  const tileMercY = mercY(tileSouth)
  const tileOriginXf32 = f(tileMercX)
  const tileOriginYf32 = f(tileMercY)
  const camMercX = mercX(clon)
  const camRelX = camMercX - tileMercX
  const camH = f(camRelX)
  const camL = f(camRelX - camH)
  const vMercX = mercX(vLon)
  const vMercY = mercY(vLat)
  // local_merc.x / .y (the fill VS's f32 tail slots, DSFUN tile-local Mercator).
  const localMercX = f(vMercX - tileMercX)
  const localMercY = f(vMercY - tileMercY)

  const tileRefLonF32 = f(f(tileOriginXf32 + f(0.5 * tileExtentM)) / CSE0_F32)

  if (mode === 'ideal') {
    const pg = projectGeomCpu(pt, vLon, vLat, clon, clat, vLon)
    const cv = projectCpu(pt, clon, clat, clon, clat)
    return [pg[0] - cv[0], pg[1] - cv[1]]
  }

  // latitude (shared old/new path — abs merc → lat degrees). Exact or f32 as asked.
  const absMercY = f(localMercY + tileOriginYf32)
  const latDeg = latExact ? vLat : f(invMercLat(absMercY))

  if (mode === 'fillOld') {
    // pre-fix FILL: abs_lon = (local_merc.x + tile_origin_merc.x)/(DEG2RAD·R),
    // projected against the tile-ref-lon centred projection (clon unshifted).
    const absMercX = f(localMercX + tileOriginXf32)
    const absLon = f(absMercX / CSE0_F32)
    const pg = projectGeomCpu(pt, absLon, latDeg, clon, clat, absLon)
    const cv = projectCpu(pt, clon, clat, clon, clat)
    return [pg[0] - cv[0], pg[1] - cv[1]]
  }
  // precise — the camera-relative longitude with the projection recentred onto
  // clon = 0. This is the arithmetic the OUTLINE (line finalize_corner) already
  // emits AND the arithmetic the FILL disc arm now emits after the #598 fix, so
  // the two paths are byte-identical by construction.
  const relMercX = f(f(localMercX - camH) - camL)
  const dLon = f(relMercX / CSE0_F32)
  const refLonRel = f(tileRefLonF32 - clon)
  const pg = projectGeomCpu(pt, dLon, latDeg, 0, clat, refLonRel)
  const cv = projectCpu(pt, 0, clat, 0, clat)
  return [pg[0] - cv[0], pg[1] - cv[1]]
}

// Max over a grid of vertices spanning the tile of the distance between the
// fill (`fillMode`) and the outline (always `precise`) projected positions.
function fillOutlineSeam(s: Scenario, fillMode: 'fillOld' | 'precise', latExact: boolean): number {
  const CSE0 = DEG2RAD * R
  let m = 0
  for (let i = 0; i <= 6; i++)
    for (let j = 0; j <= 6; j++) {
      const vLon = s.tileWest + (i / 6) * (s.tileExtentM / CSE0)
      const vLat = invMercLat(mercY(s.tileSouth) + (j / 6) * s.tileExtentM)
      const outline = project(s, vLon, vLat, 'precise', latExact)
      const fill = project(s, vLon, vLat, fillMode, latExact)
      m = Math.max(m, Math.hypot(fill[0] - outline[0], fill[1] - outline[1]))
    }
  return m
}

describe('#598 polygon fill — non-Mercator longitude parity with the outline', () => {
  // A deep-zoom tile at Seoul's longitude (127°), where the Mercator X magnitude
  // (~1.41e7 m) makes the absolute-degree f32 round-trip worst. The camera sits
  // ~4 km west of the tile (a realistic within-viewport offset, past the
  // azimuthal c<1e-4 rad singularity guard).
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

  it('fail-before: the pre-fix fill diverges from the precise outline by a metric seam', () => {
    // The pre-fix fill fed the absolute degree while the (already-fixed) outline
    // feeds the camera-relative delta, so the fill lands >0.2 m off the outline
    // — the fill≠outline seam #598 introduced. The post-fix fill (same
    // arithmetic as the outline) coincides sub-cm.
    for (const z of [16, 18, 20]) {
      const base = zoomTile(z)
      for (const pt of NON_MERC) {
        const s: Scenario = { pt, ...base }
        const seamOld = fillOutlineSeam(s, 'fillOld', /* latExact */ true)
        const seamNew = fillOutlineSeam(s, 'precise', /* latExact */ true)
        // OLD reproduces the defect: fill parts company with its outline.
        expect(seamOld, `pt${pt} z${z} OLD seam`).toBeGreaterThan(0.2)
        // NEW: identical arithmetic to the outline → coincident sub-cm.
        expect(seamNew, `pt${pt} z${z} NEW seam`).toBeLessThan(0.01)
      }
    }
  })
})

describe('#598 polygon fill — emitted WGSL wiring (fails on the pre-fix abs-degree path)', () => {
  const wgsl = emitPolygonWgsl(null, false)
  // The quantized fill VS is the only entry that builds local_merc =
  // vec2(abs_lon, abs_lat) from its f32 tail; slice that function.
  const fillVs = () => {
    const anchor = wgsl.indexOf('vec2<f32>(abs_lon, abs_lat)')
    const start = wgsl.lastIndexOf('\nfn ', anchor)
    return wgsl.slice(start, wgsl.indexOf('\nfn ', anchor + 5))
  }

  it('feeds the disc arm the camera-relative longitude recentred onto clon = 0, like the outline', () => {
    const b = fillVs()
    // flat_rel(((local_merc.x − cam_h.x) − cam_l.x)/(DEG2RAD·R), lat,
    //          vec4(proj.x, 0.0, proj.z, proj.w), (tile_ref_lon − proj.y)) —
    // the SAME camera-relative, clon-recentred form the line finalize_corner
    // emits (\w+ generalizes the CSE-hoisted temp names).
    expect(b).toMatch(
      /flat_rel\(\(\(\(\w+\.x - u\.cam_h\.x\) - u\.cam_l\.x\) \/ \w+\), \w+, vec4<f32>\(u\.proj_params\.x, 0\.0, u\.proj_params\.z, u\.proj_params\.w\), \(\(\(u\.tile_origin_merc\.x \+ \(0\.5 \* u\.tile_extent_m\)\) \/ \w+\) - u\.proj_params\.y\)\)/,
    )
    // and the pre-fix lossy `flat_rel(abs_lon, ...)` disc arm is GONE from the fill VS.
    expect(b).not.toMatch(/flat_rel\(abs_lon,/)
  })

  it('leaves the non-quantized (extruded / vs_main) entries on the shared abs_lon path', () => {
    // The disc arm is shared by VS entries that lack local_merc; those must keep
    // the old abs_lon path (their fill/outline residual is shared there).
    expect(wgsl).toContain('flat_rel(abs_lon, abs_lat, u.proj_params,')
  })
})
