import { describe, it, expect } from 'vitest'
import { emitRasterWgsl } from './raster'

// Phase-2 PR 2d.3 raster shader — ECEF VS rewrite. The vertex stage uses a
// single ECEF path (lon/lat → lonlat_to_ecef → subtract tile_ecef_center →
// MVP) replacing the old 4-branch projection dispatch. The fragment is
// unchanged: sample + rim fade + log-depth.
describe('Phase-2 raster shader — DSL emission (ECEF VS, PR 2d.3)', () => {
  const noPick = emitRasterWgsl(false)
  const pick = emitRasterWgsl(true)
  const rasterPart = (w: string) => w.slice(w.indexOf('struct Uniforms'))

  it('prepends ECEF consts + lonlat_to_ecef fn + log-depth fns', () => {
    expect(noPick).toContain('lonlat_to_ecef')
    expect(noPick).toContain('fn apply_log_depth')
    expect(noPick).toContain('fn compute_log_frag_depth')
    // ECEF consts: WGS84 semi-major axis
    expect(noPick).toContain('6378137')
  })
  it('prepends PI and DEG2RAD consts (regression: PR 2d.3 WGSL compile fix)', () => {
    // vs_tile uses constRef('PI') and constRef('DEG2RAD'); these must be defined
    // before the DSL-emitted module or WGSL compile fails with "unresolved value".
    expect(noPick).toContain('const PI:')
    expect(noPick).toContain('const DEG2RAD:')
  })
  it('binds u (g0b0) + texture/sampler (g0b1/b2) + tile (g1b0)', () => {
    expect(noPick).toContain('@group(0) @binding(0) var<uniform> u: Uniforms;')
    expect(noPick).toContain('@group(0) @binding(1) var tex: texture_2d<f32>;')
    expect(noPick).toContain('@group(0) @binding(2) var tex_sampler: sampler;')
    expect(noPick).toContain('@group(1) @binding(0) var<uniform> tile: TileUniforms;')
  })
  it('TileUniforms has tile_ecef_center (not tile_rtc)', () => {
    expect(noPick).toContain('tile_ecef_center')
    expect(noPick).not.toContain('tile_rtc')
  })
  it('procedural-grid vertex + single ECEF projection path', () => {
    expect(noPick).toContain('@vertex\nfn vs_tile(@builtin(vertex_index) vid: u32) -> VsOut')
    expect(noPick).toContain('lonlat_to_ecef(')
    // Camera-relative RTC fix: the VS now subtracts the frame cameraCenter
    // (u.cam_ecef_center) rather than the per-tile tile_ecef_center, so the
    // ECEF vertex projects vertex − cameraCenter through the camera-at-origin MVP.
    expect(noPick).toContain('u.cam_ecef_center')
    expect(noPick).toContain('array<u32, 6>')
    // vs_tile branches flat (project / project_geom) vs 3D (ECEF). globe (7)
    // takes the ECEF else, so proj_globe is never CALLED in the VS.
    const vsBody = noPick.slice(noPick.indexOf('@vertex\nfn vs_tile'))
    const vsEnd = vsBody.indexOf('\n@fragment')
    const vsOnly = vsEnd > 0 ? vsBody.slice(0, vsEnd) : vsBody
    expect(vsOnly).not.toContain('proj_globe(')
    expect(vsOnly).toContain('lonlat_to_ecef(') // ECEF else branch retained
  })
  it('vs_tile flat display branches: Mercator (< 0.5) + non-Mercator (< 6.5)', () => {
    // projection-display-layer-restore Phase 2: flat Mercator (proj_params.x
    // < 0.5) reprojects via project(); the other flat projTypes (< 6.5) via
    // the shared flat_rel helper (project_geom − projected camera centre); the
    // 3D ECEF path stays in the final else.
    const vsBody = noPick.slice(noPick.indexOf('@vertex\nfn vs_tile'))
    const vsEnd = vsBody.indexOf('\n@fragment')
    const vsOnly = vsEnd > 0 ? vsBody.slice(0, vsEnd) : vsBody
    expect(vsOnly).toContain('u.proj_params.x < 0.5')              // Mercator fast path
    expect(vsOnly).toContain('u.proj_params.x < 6.5')              // non-Mercator flat
    // Mercator branch CALLS project() with the reconstructed lon/lat and
    // u.proj_params. The lon/lat args are no longer hand `let` names (lon /
    // lat_deg) — the cse auto-cache hoists the reused input-only exprs into
    // shared temps (or inlines a single use), so generalize the first two args
    // to \w+ and pin the call + the stable u.proj_params operand.
    expect(vsOnly).toMatch(/\bproject\([\s\S]*?, u\.proj_params\)/)          // Mercator
    // non-Mercator branch CALLS the shared flat_rel() helper with u.proj_params
    // as the projType arg; the leading lon/lat args are likewise cse/inlined.
    expect(vsOnly).toMatch(/\bflat_rel\([\s\S]*?, u\.proj_params,/)           // non-Mercator (shared helper)
    expect(noPick).toContain('fn flat_rel(')
    expect(noPick).toContain('fn project_geom(')
  })
  it('fragment samples the tile + rim fade + log-depth', () => {
    expect(noPick).toContain('@fragment\nfn fs_tile(input: VsOut) -> RasterFragmentOutput')
    expect(noPick).toContain('textureSample(tex, tex_sampler, input.uv)')
    expect(noPick).toContain('compute_log_frag_depth(input.view_w')
  })
  it('pick variant toggles the pick field + write', () => {
    expect(noPick).not.toContain('pick: vec2<u32>')
    expect(noPick).not.toContain('out.pick')
    expect(pick).toContain('@location(1) @interpolate(flat) pick: vec2<u32>,')
    // pick value is now a field in the RasterFragmentOutput(...) constructor, not an `out.pick =` write.
    expect(pick).toContain('vec2<u32>(0u, 0u)')
  })
  it('both variants are structurally balanced (raster module portion)', () => {
    for (const w of [rasterPart(noPick), rasterPart(pick)]) {
      expect((w.match(/{/g) ?? []).length).toBe((w.match(/}/g) ?? []).length)
      expect((w.match(/\(/g) ?? []).length).toBe((w.match(/\)/g) ?? []).length)
    }
  })

  // ── #595: back-hemisphere raster cull — per-fragment recompute ──
  it('VsOut carries abs_lon + abs_merc_y varyings for per-fragment cos_c (#595)', () => {
    // The VS must pass lon (degrees) and mercYAbs (radians) to the FS so the
    // fragment can recompute cos_c from them rather than interpolating vis
    // across the tile — the interpolated value is a chord not an arc.
    expect(noPick).toContain('abs_lon: f32')
    expect(noPick).toContain('abs_merc_y: f32')
  })
  it('vs_tile does NOT call needs_backface_cull (cull moved to FS, #595)', () => {
    // The per-vertex path is the bug — VS must NOT compute vis via
    // needs_backface_cull; the FS recomputes it per-fragment.
    const vsBody = noPick.slice(noPick.indexOf('@vertex\nfn vs_tile'))
    const vsEnd = vsBody.indexOf('\n@fragment')
    const vsOnly = vsEnd > 0 ? vsBody.slice(0, vsEnd) : vsBody
    expect(vsOnly).not.toContain('needs_backface_cull(')
  })
  it('fs_tile recomputes cos_c per-fragment via needs_backface_cull + discards < 0 (#595)', () => {
    // The FS must call needs_backface_cull with the per-fragment lon/lat
    // (recovered from the abs_lon / abs_merc_y varyings) and discard when < 0.
    expect(noPick).toContain('fn needs_backface_cull(')
    const fsBody = noPick.slice(noPick.indexOf('@fragment\nfn fs_tile'))
    expect(fsBody).toContain('needs_backface_cull(')
    expect(fsBody).toContain('discard')
    // Verify the FS recovers latitude from abs_merc_y via atan/exp (same
    // formula the VS uses to reconstruct latRad from the raster-unit mercYAbs).
    expect(fsBody).toContain('input.abs_merc_y')
    expect(fsBody).toContain('input.abs_lon')
  })
  it('fs_tile uses rim_alpha (per-fragment) not smoothstep(0,0.02,vis) (#595)', () => {
    // After the fix the rim fade is per-fragment via rim_alpha() so it tracks
    // the true cos_c arc; the old smoothstep-on-interpolated-vis is gone.
    expect(noPick).toContain('fn rim_alpha(')
    const fsBody = noPick.slice(noPick.indexOf('@fragment\nfn fs_tile'))
    expect(fsBody).toContain('rim_alpha(')
    // The old interpolated-vis rim path must not survive.
    expect(fsBody).not.toContain('smoothstep(0.0, 0.02, input.vis)')
  })
})

// ── #595: analytic back-face predicate ──
// Verifies needs_backface_cull(projType, lon, lat, clon, clat) returns the
// correct sign via the CPU mirror — the same function the WGSL shader calls.
// This is the ONLY GPU-free gate for the hemisphere predicate; the visual
// confirmation (back hemisphere hidden) is done via headed Chrome.
import { needsBackfaceCullCpu } from './cpu-projections'
import { globeEyeUniform } from '../../render/globe-eye-uniform'

// #600 — the globe(7) arm culls by the EYE-HORIZON cap, so it needs a globe_eye.
// A FAR NADIR eye over (clon, clat) makes the eye direction = the centre normal
// AND horizonCos = R/|eye| → ~0, so eye-horizon(P) = dot(P̂, normalize(center)) −
// ~0 = cosC(P, center) — sign AND magnitude match the pre-#600 center_cos_c
// predicate this #595 block pins. (The pitched-eye behaviour is in
// back-face-cull-comprehensive's #600 discriminating block.)
const EARTH_R = 6378137
function nadirEye(clon: number, clat: number): readonly [number, number, number] {
  const lam = clon * Math.PI / 180, phi = clat * Math.PI / 180, c = Math.cos(phi)
  const s = EARTH_R * 1e6
  return [s * c * Math.cos(lam), s * c * Math.sin(lam), s * Math.sin(phi)]
}
// Globe cull with the far-nadir eye over the camera centre (= the strict
// hemisphere predicate, in eye-horizon form).
const cullGlobe = (lon: number, lat: number, clon: number, clat: number): number =>
  needsBackfaceCullCpu(7, lon, lat, clon, clat, globeEyeUniform(nadirEye(clon, clat)) as [number, number, number, number])

describe('back-face predicate — analytic (CPU mirror, #595)', () => {
  // GLOBE(7) calls route through cullGlobe() (which supplies the #600 eye).
  const MERCATOR = 0
  const ORTHO = 3

  it('globe: point at camera centre (face-on) → positive', () => {
    // Camera at (lon=0, lat=0); point directly facing → cos_c = +1
    const result = cullGlobe(0, 0, 0, 0)
    expect(result).toBeGreaterThan(0)
  })

  it('globe: point at antipode (back-facing) → negative', () => {
    // Camera at (lon=0, lat=0); point at (lon=180, lat=0) → cos_c = -1
    const result = cullGlobe(180, 0, 0, 0)
    expect(result).toBeLessThan(0)
  })

  it('globe: point at ~90° off-axis (near limb) → near zero', () => {
    // lon=90 from camera at lon=0, same lat → cos_c ≈ 0
    const result = cullGlobe(90, 0, 0, 0)
    expect(Math.abs(result)).toBeLessThan(0.01)
  })

  it('mercator (flat): any point → always +1 (no cull)', () => {
    // Flat projections return +1 so the discard is inert there.
    expect(needsBackfaceCullCpu(MERCATOR, 0, 0, 0, 0)).toBeCloseTo(1, 5)
    expect(needsBackfaceCullCpu(MERCATOR, 180, 45, 0, 0)).toBeCloseTo(1, 5)
    expect(needsBackfaceCullCpu(MERCATOR, -90, -60, 20, 10)).toBeCloseTo(1, 5)
  })

  it('orthographic (disc): back hemisphere → negative, front → positive', () => {
    // Ortho uses strict cos_c cull — same semantics as globe.
    expect(needsBackfaceCullCpu(ORTHO, 0, 0, 0, 0)).toBeGreaterThan(0)   // face-on
    expect(needsBackfaceCullCpu(ORTHO, 180, 0, 0, 0)).toBeLessThan(0)    // antipode
  })

  // ── DISCRIMINATING counterexample: per-vertex interpolation leak (#595 v2) ──
  //
  // Tile z=2, lon -180..-90, lat 0..66.51°N; camera clon=0, clat=30, globe (7).
  // The 4 tile corners have cos_c: SW(−180,0)=−0.499, SE(−90,0)=+0.500,
  // NW(−180,66.51)=−0.095, NE(−90,66.51)=+0.750.
  // Bilinear interpolation at the interior point lon=−137.25, lat=41.57
  // (uu=0.375, vv=0.375 within the tile) gives ≈+0.0029 (positive → NOT culled).
  // But the true per-fragment cos_c at that point is ≈−0.144 (negative → CULL).
  // This proves the per-vertex interpolation LEAKS back-hemisphere raster.
  // The per-fragment fix catches it; the per-vertex approach cannot.
  it('DISCRIMINATING counterexample: interior fragment lon=−137.25 lat=41.57 camera clon=0 clat=30 globe → per-fragment cos_c < 0 (must cull), per-vertex bilinear ≈ +0.0029 (would NOT cull)', () => {
    // Per-fragment result (the fix): must be negative → discard. (#600 — globe
    // cull via the far-nadir eye = the strict cosC predicate; value preserved.)
    const perFragment = cullGlobe(-137.25, 41.57, 0, 30)
    expect(perFragment).toBeLessThan(0)
    // Verify the value is approximately −0.144 as computed analytically.
    expect(perFragment).toBeCloseTo(-0.144, 2)

    // Per-vertex bilinear interpolation (the bug): compute cos_c at the 4
    // tile corners and bilinearly interpolate to the interior point.
    const sw = cullGlobe(-180,    0,     0, 30)  // uu=0, vv=1 (south)
    const se = cullGlobe(-90,     0,     0, 30)  // uu=1, vv=1
    const nw = cullGlobe(-180,    66.51, 0, 30)  // uu=0, vv=0 (north)
    const ne = cullGlobe(-90,     66.51, 0, 30)  // uu=1, vv=0

    // uu = (−137.25 − (−180)) / (−90 − (−180)) = 42.75/90 = 0.475
    // vv = 0 → north, 1 → south. lat=41.57 in [0..66.51] → vv = (66.51−41.57)/66.51 = 0.375
    const uu = ((-137.25) - (-180)) / ((-90) - (-180))  // 0.475
    const vv = (66.51 - 41.57) / 66.51                  // 0.375 (north=0, south=1)
    const bilinear = nw * (1 - uu) * (1 - vv)
                   + ne * uu       * (1 - vv)
                   + sw * (1 - uu) * vv
                   + se * uu       * vv
    // The bilinear result is positive (the bug: would NOT discard).
    expect(bilinear).toBeGreaterThan(0)

    // The gap between them proves the interpolation error:
    // per-fragment says CULL; per-vertex says KEEP → limb leak confirmed.
    expect(perFragment).toBeLessThan(0)
    expect(bilinear).toBeGreaterThan(0)
  })
})
