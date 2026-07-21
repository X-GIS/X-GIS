// ═══ #1246 — flat-projection stroke width must be projection-invariant ═══
//
// Bug: on every NON-Mercator flat projection (equirectangular, natural_earth,
// stereographic, …) a stroke authored `line-width: W` collapsed to ~W·cosφ. The
// flat display MVP maps projected metres → pixels at the SINGLE Mercator 1/mpp
// for ALL flat projTypes, so `finalize_corner` reprojecting the tile-local
// Mercator half-width offset shrinks it by the Merc→projection Jacobian J
// (equirect N–S: J = cosφ) — the stroke renders J× too thin. Mercator (J = 1)
// is correct and must stay byte-identical.
//
// Fix (line.ts VS clamp, flat branch): measure J on-screen as the ratio of the
// Mercator-passthrough size of the across offset to its finalize_corner-
// reprojected size, then widen ONLY the clip-space quad's across by 1/J. The FS
// coverage isocontour (perpM = halfWm, TRUE Mercator metres via world_local)
// then lands at the widened physical quad edge, so the DISPLAYED width is
// projection-invariant with the fragment shader byte-unchanged.
//
// Two gates below:
//   1. NUMERIC (records outputs) — reconstructs the shader's exact
//      mercDist/projDist ratio via the CPU projection mirror and pins that the
//      pre-fix displayed width == W·J (the collapse) and the post-fix widthScale
//      = 1/J restores W for equirect + stereographic, and is a ~no-op on
//      Mercator and near the equator.
//   2. EMISSION (fail-before / pass-after) — the WGSL + GLSL twin line VS must
//      emit the flat width-ratio correction: the across-only widen driven by a
//      length(merc)/length(proj) screen-size ratio, distinct from the old
//      targetNdc/viewport_height clamp (which now lives on the globe arm only).

import { describe, it, expect } from 'vitest'
import { emitLineWgsl } from './line'
import { emitLineGlsl } from './line-glsl'
import { projectGeomCpu } from './cpu-projections'

// ── CPU reconstruction of the shader's flat width scale ──────────────────────
//
// finalize_corner converts a tile-local Mercator corner → abs Mercator → lon/lat
// → project_geom(projType). The flat MVP then applies the SAME Mercator 1/mpp to
// every flat projType, so the on-screen size of an offset is proportional to the
// magnitude of its projection-space delta. widthScale = |Δmerc| / |Δproj| (both
// through that shared scale) = 1/J — exactly the shader's mercDist/projDist.
const R = 6378137
const DEG = 180 / Math.PI
function invMercLatDeg(y: number): number {
  return (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * DEG
}
/** widthScale (= 1/J) for a Mercator-metre across offset at abs Mercator (mx,my). */
function widthScale(projType: number, mx: number, my: number, dxm: number, dym: number): number {
  const clon = 0
  const clat = invMercLatDeg(my)
  const toLL = (x: number, y: number): [number, number] => [
    x / R / (Math.PI / 180),
    invMercLatDeg(y),
  ]
  const [lonA, latA] = toLL(mx, my)
  const [lonB, latB] = toLL(mx + dxm, my + dym)
  const refLon = lonA
  const pA = projectGeomCpu(projType, lonA, latA, clon, clat, refLon)
  const pB = projectGeomCpu(projType, lonB, latB, clon, clat, refLon)
  const projDelta = Math.hypot(pB[0] - pA[0], pB[1] - pA[1])
  const mercDelta = Math.hypot(dxm, dym)
  return mercDelta / projDelta
}

const OWNER_LAT = 66.69669
const OWNER_MY = R * Math.log(Math.tan(Math.PI / 4 + OWNER_LAT / DEG / 2))
const OWNER_MX = 0
const D = 3 // 3 Merc-metre probe offset (sub-tile; J is locally constant)

describe('#1246 flat width scale — numeric (CPU projection Jacobian)', () => {
  const cosPhi = Math.cos(OWNER_LAT / DEG)
  const rows: string[] = []

  it('Mercator (projType 0) width scale is 1 in every direction (no-op)', () => {
    for (const [dx, dy, dir] of [
      [0, D, 'ns'],
      [D, 0, 'ew'],
    ] as const) {
      const s = widthScale(0, OWNER_MX, OWNER_MY, dx, dy)
      rows.push(`mercator ${dir}: widthScale=${s.toFixed(4)} (J=${(1 / s).toFixed(4)})`)
      expect(Math.abs(s - 1)).toBeLessThan(1e-3)
    }
  })

  it('equirectangular N–S collapses by cosφ; widthScale restores it (1/cosφ)', () => {
    const sNs = widthScale(1, OWNER_MX, OWNER_MY, 0, D)
    const jNs = 1 / sNs
    rows.push(
      `equirect ns: J=${jNs.toFixed(4)} cosφ=${cosPhi.toFixed(4)} widthScale=${sNs.toFixed(4)}`,
    )
    // The measured N–S Jacobian is cos(latitude) — the documented collapse.
    expect(Math.abs(jNs - cosPhi)).toBeLessThan(2e-3)
    // widthScale = 1/J restores unit displayed width: J · widthScale == 1.
    expect(Math.abs(jNs * sNs - 1)).toBeLessThan(1e-6)
    expect(sNs).toBeGreaterThan(2.5) // 1/cos(66.7°) ≈ 2.53
  })

  it('stereographic is isotropic; widthScale restores unit width both axes', () => {
    const sNs = widthScale(5, OWNER_MX, OWNER_MY, 0, D)
    const sEw = widthScale(5, OWNER_MX, OWNER_MY, D, 0)
    rows.push(`stereographic ns: widthScale=${sNs.toFixed(4)} ew: widthScale=${sEw.toFixed(4)}`)
    // Restores width (J·widthScale == 1) in both directions by construction.
    for (const s of [sNs, sEw]) expect(s).toBeGreaterThan(0)
    // Isotropic conformal disc: N–S and E–W scale agree at the point.
    expect(Math.abs(sNs - sEw) / sNs).toBeLessThan(0.05)
  })

  it('near the equator the correction is a near-no-op (cosφ ≈ 1)', () => {
    const eqMy = R * Math.log(Math.tan(Math.PI / 4 + 0.5 / DEG / 2))
    const sNs = widthScale(1, 0, eqMy, 0, D)
    rows.push(`equirect@eq ns: widthScale=${sNs.toFixed(5)}`)
    expect(Math.abs(sNs - 1)).toBeLessThan(2e-3)
  })

  it('records the width-scale table', () => {
    console.log('#1246 width-scale table:\n  ' + rows.join('\n  '))
    expect(rows.length).toBeGreaterThan(0)
  })
})

// ── EMISSION: the flat width-ratio correction must be in the shader ──────────
describe('#1246 flat width correction is emitted (WGSL + GLSL twin)', () => {
  const wgsl = emitLineWgsl(false)
  const wgslPick = emitLineWgsl(true)
  const glslVert = emitLineGlsl(false, 'vertex')
  const vsOf = (w: string) => w.slice(w.indexOf('fn vs_line'), w.indexOf('fn fs_line'))

  it('emits a screen-size RATIO length(merc)/length(proj) for the flat width scale — absent pre-fix', () => {
    // The flat branch derives widthScale = mercDist / projDist where BOTH the
    // numerator AND denominator are `length(...)` of an NDC delta — a
    // length-over-length ratio, `length(_) / length(_)`, inside ONE statement.
    // The pre-fix clamp had NO length/length ratio anywhere (its scale was
    // `(… / layer.viewport_height) / screenDist`, i.e. const / length — and the
    // inlined screenDist appears twice only ACROSS an `if (… > 1e-8) {`). So we
    // require the two `length(` to be ADJACENT (only the ratio's operands between
    // them — no `>`, `{`, `}`, `;`): TRUE post-fix, FALSE pre-fix.
    // WGSL: slice out the vs_line body; GLSL: the vertex stage IS the VS.
    const ratio = /length\([^;{}>]*\)\s*\/\s*length\(/
    for (const [src, label] of [
      [vsOf(wgsl), 'wgsl'],
      [vsOf(wgslPick), 'wgsl-pick'],
      [glslVert, 'glsl'],
    ] as const) {
      expect(src.length, label).toBeGreaterThan(0)
      expect(src, label).toMatch(ratio)
    }
  })

  it('the flat branch still routes through finalize_corner (both probe + final)', () => {
    const vs = vsOf(wgsl)
    expect(vs).toContain('tile.proj_params.x < 6.5')
    // Two clamp probes (base, base+across) + the final-clip corner = ≥ 3 calls.
    const n = (vs.match(/finalize_corner\(/g) ?? []).length
    expect(n).toBeGreaterThanOrEqual(3)
  })

  it('the old flat targetNdc/viewport clamp no longer scales the flat quad', () => {
    // viewport_height now feeds ONLY the globe (proj_params.x ≥ 6.5) arm. There
    // must be exactly ONE `/ layer.viewport_height` (globe targetNdc), and it
    // must sit AFTER the flat `< 6.5` branch closes — i.e. not the flat scaler.
    const vs = vsOf(wgsl)
    const vpDivs = (vs.match(/\/ layer\.viewport_height/g) ?? []).length
    expect(vpDivs).toBe(1)
  })

  it('both variants stay structurally balanced', () => {
    for (const w of [wgsl, wgslPick]) {
      const lp = w.slice(w.indexOf('struct TileUniforms'))
      expect((lp.match(/{/g) ?? []).length).toBe((lp.match(/}/g) ?? []).length)
      expect((lp.match(/\(/g) ?? []).length).toBe((lp.match(/\)/g) ?? []).length)
    }
  })
})
