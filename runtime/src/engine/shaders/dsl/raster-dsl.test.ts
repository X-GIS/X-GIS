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
    expect(noPick).toContain('smoothstep(0.0, 0.02, input.vis)')
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

  // ── #595: back-hemisphere raster cull ──
  it('vs_tile threads needs_backface_cull through vis (#595)', () => {
    // needs_backface_cull must be DEFINED (merged from the projection module)
    // and CALLED in the VS body so back-facing raster tile vertices get vis<0.
    expect(noPick).toContain('fn needs_backface_cull(')
    const vsBody = noPick.slice(noPick.indexOf('@vertex\nfn vs_tile'))
    const vsEnd = vsBody.indexOf('\n@fragment')
    const vsOnly = vsEnd > 0 ? vsBody.slice(0, vsEnd) : vsBody
    expect(vsOnly).toContain('needs_backface_cull(')
  })
  it('fs_tile discards when vis < 0 (hemisphere-cull gate for #595)', () => {
    // The FS already had the vis < 0 discard; verify it is still present.
    const fsBody = noPick.slice(noPick.indexOf('@fragment\nfn fs_tile'))
    expect(fsBody).toContain('input.vis < 0.0')
    expect(fsBody).toContain('discard')
  })
})

// ── #595: analytic back-face predicate ──
// Verifies needs_backface_cull(projType, lon, lat, clon, clat) returns the
// correct sign via the CPU mirror — the same function the WGSL shader calls.
// This is the ONLY GPU-free gate for the hemisphere predicate; the visual
// confirmation (back hemisphere hidden) is done via headed Chrome.
import { needsBackfaceCullCpu } from './cpu-projections'

describe('back-face predicate — analytic (CPU mirror, #595)', () => {
  const GLOBE = 7
  const MERCATOR = 0
  const ORTHO = 3

  it('globe: point at camera centre (face-on) → positive', () => {
    // Camera at (lon=0, lat=0); point directly facing → cos_c = +1
    const result = needsBackfaceCullCpu(GLOBE, 0, 0, 0, 0)
    expect(result).toBeGreaterThan(0)
  })

  it('globe: point at antipode (back-facing) → negative', () => {
    // Camera at (lon=0, lat=0); point at (lon=180, lat=0) → cos_c = -1
    const result = needsBackfaceCullCpu(GLOBE, 180, 0, 0, 0)
    expect(result).toBeLessThan(0)
  })

  it('globe: point at ~90° off-axis (near limb) → near zero', () => {
    // lon=90 from camera at lon=0, same lat → cos_c ≈ 0
    const result = needsBackfaceCullCpu(GLOBE, 90, 0, 0, 0)
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
})
