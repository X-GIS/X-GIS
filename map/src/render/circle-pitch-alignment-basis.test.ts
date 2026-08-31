// ═══ #2118 — the point VS's ground basis IS `groundBasisAt`, not a second opinion ═══
//
// `circle-pitch-alignment: map` lays the circle's disc in the ground plane, which
// is the same question `text-pitch-alignment: map` answers for a glyph quad. That
// question has ONE authority in this repo: `map/src/text/ground-basis.ts`. The
// point path cannot CALL it — `groundBasisAt` is CPU code over `project(lon,lat)`
// callbacks, and a per-point CPU basis would mean repacking feat_data every frame,
// which is exactly what `redrawTilePointsCached` exists to avoid — so the
// construction is TRANSCRIBED into WGSL instead.
//
// This gate is what keeps "transcribed" from decaying into "re-derived". It
// re-evaluates the shader's arithmetic in TypeScript over a camera lattice and
// asserts it equals the CPU authority's answer AT THE SAME GROUND POINT. If the
// two ever disagree, the point path has grown its own opinion about how the ground
// plane looks from here, and that is the drift both modules' headers forbid.
//
// THREE THINGS IT PINS THAT NOTHING ELSE CAN SEE:
//
//  1. THE Y CONVENTION. The point VS works in the quad-expansion px space, whose y
//     is UP (it feeds `offsetPx * (2/W, 2/H)` straight into NDC); `groundBasisAt`
//     composes `projectFlatRtc`, whose y is DOWN. The two bases are therefore
//     related by the similarity diag(1,−1)·B·diag(1,−1): the OFF-diagonal terms
//     flip sign, the diagonal does not. Getting this wrong mirrors the ellipse
//     under bearing — invisible at bearing 0, invisible at pitch 0, and wrong
//     everywhere else. The lattice below carries non-zero bearings for this reason.
//  2. THE ANALYTIC JACOBIAN. The shader does NOT take finite differences: on the
//     flat path `M · (rel, 0, 1)` is linear in rel, so ∂clip/∂rel_x is exactly M's
//     column 0. The CPU authority DOES take finite differences (δ = 1e-8°). Their
//     agreement here is what says the closed form is the same derivative, not a
//     different one that happens to look similar.
//  3. PARAMETERIZATION INVARIANCE. `groundBasisAt` differentiates w.r.t. lon/lat
//     DEGREES; the shader differentiates w.r.t. MERCATOR METRES. Those disagree by
//     the merc Jacobian K — and the basis does not care, because
//     (J·K)·(J₀·K)⁻¹ = J·J₀⁻¹. Their agreement across latitude is that identity
//     being real rather than assumed.
//
// FAIL-BEFORE, and WHICH HALF OF THIS FILE CATCHES WHAT — the split is the whole
// design, because the arithmetic suite runs a CPU MIRROR and therefore CANNOT see
// an edit to point.ts at all (measured: the y-flip below left all 16 rows green
// before the source gate was widened to cover the Jacobian lines):
//   · swap the `lc`/`lb` operands in the CPU mirror's 2×2 solve → the arithmetic
//     rows go red against `groundBasisAt`; the source gate stays green.
//   · flip a `.mul(hh)` to `.mul(hh.neg())` in point.ts         → the SOURCE gate
//     goes red naming the exact line; the arithmetic rows stay green.
//   · read `mvp` where the pitch-0 half reads `mvp0` in point.ts → the source gate
//     goes red. On the GPU that cut makes the basis the identity forever, i.e. the
//     feature silently does nothing and no frame throws — which is why it is
//     pinned by NAME here and re-measured on SwiftShader by the e2e gate.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { Camera } from '../camera'
import { Pitch0Unprojector, makeGroundProjector } from '../camera/pitch0-unproject'
import { groundBasisAt } from '../text/ground-basis'

const W = 1200
const H = 800
const DPR = 1

/** The point VS's basis arithmetic, re-evaluated on the CPU.
 *
 *  Term for term what `vs_point` computes: the two screen Jacobians in the
 *  quad-expansion px space (x right, **y UP**), then ΔP·ΔP₀⁻¹ in
 *  `groundBasisAt`'s operand order. `mvp` is column-major, so column 0 is
 *  elements 0..3 and column 1 is elements 4..7 — the same indexing
 *  `projectFlatRtc` uses (`cw = mvp[3]*x + mvp[7]*y + mvp[15]`). */
function shaderBasis(
  mvp: Float32Array,
  mvp0: Float32Array,
  relX: number,
  relY: number,
): [number, number, number, number] {
  const hw = W * 0.5
  const hh = H * 0.5
  const jac = (m: Float32Array): [number, number, number, number] => {
    const cw = m[3]! * relX + m[7]! * relY + m[15]!
    const cx = m[0]! * relX + m[4]! * relY + m[12]!
    const cy = m[1]! * relX + m[5]! * relY + m[13]!
    const inv = 1 / (cw * cw)
    return [
      (m[0]! * cw - cx * m[3]!) * hw * inv,
      (m[1]! * cw - cy * m[3]!) * hh * inv,
      (m[4]! * cw - cx * m[7]!) * hw * inv,
      (m[5]! * cw - cy * m[7]!) * hh * inv,
    ]
  }
  const [la, lb, lc, ld] = jac(mvp)
  const [za, zb, zc, zd] = jac(mvp0)
  const det = za * zd - zc * zb
  return [
    (la * zd - lc * zb) / det,
    (lb * zd - ld * zb) / det,
    (lc * za - la * zc) / det,
    (ld * za - lb * zc) / det,
  ]
}

interface Row {
  readonly name: string
  readonly lon: number
  readonly lat: number
  readonly zoom: number
  readonly pitch: number
  readonly bearing: number
  /** Ground point offset from the camera centre, in DEGREES — the far field is
   *  where pitch-alignment actually differs from a billboard, so the lattice must
   *  leave the screen centre. */
  readonly dLon: number
  readonly dLat: number
}

const LATTICE: readonly Row[] = [
  {
    name: 'z14 pitch60 bearing0 mid-lat centre',
    lon: 2.35,
    lat: 48.86,
    zoom: 14,
    pitch: 60,
    bearing: 0,
    dLon: 0,
    dLat: 0,
  },
  {
    name: 'z14 pitch60 bearing0 far field',
    lon: 2.35,
    lat: 48.86,
    zoom: 14,
    pitch: 60,
    bearing: 0,
    dLon: 0,
    dLat: 0.004,
  },
  {
    name: 'z14 pitch60 bearing37 far field',
    lon: 2.35,
    lat: 48.86,
    zoom: 14,
    pitch: 60,
    bearing: 37,
    dLon: 0.003,
    dLat: 0.004,
  },
  {
    name: 'z14 pitch60 bearing-118 far field',
    lon: 2.35,
    lat: 48.86,
    zoom: 14,
    pitch: 60,
    bearing: -118,
    dLon: -0.002,
    dLat: 0.005,
  },
  {
    name: 'z10 pitch45 bearing215 equator',
    lon: -78.5,
    lat: 0.2,
    zoom: 10,
    pitch: 45,
    bearing: 215,
    dLon: 0.02,
    dLat: 0.03,
  },
  {
    name: 'z6 pitch70 bearing90 high-lat',
    lon: 18.1,
    lat: 69.6,
    zoom: 6,
    pitch: 70,
    bearing: 90,
    dLon: 0.4,
    dLat: 0.3,
  },
  {
    name: 'z18 pitch30 bearing-45 south',
    lon: 151.2,
    lat: -33.87,
    zoom: 18,
    pitch: 30,
    bearing: -45,
    dLon: 0.00012,
    dLat: 0.00009,
  },
  {
    name: 'z4 pitch55 bearing160 low-zoom',
    lon: -100.0,
    lat: 40.0,
    zoom: 4,
    pitch: 55,
    bearing: 160,
    dLon: 1.5,
    dLat: 1.1,
  },
]

function basesFor(r: Row): { shader: readonly number[]; cpu: readonly number[] } | null {
  const camera = new Camera(r.lon, r.lat, r.zoom)
  camera.projType = 0
  camera.bearing = r.bearing
  camera.pitch = r.pitch
  const live = camera.getViewForProjection(0, W, H, DPR).matrix
  // The renderer's own pitch-0 producer — the same one `writePointFrameUniform`
  // packs into `mvp_pitch0` and the same one label-pass hands `groundBasisAt`.
  const p0 = new Pitch0Unprojector().matrix(camera, W, H, DPR)
  // `rel` in the point VS's flat-Mercator space: the feature's merc metres minus
  // the camera anchor `cameraAnchorDsfun` packs (camera.centerX/Y for projType 0).
  const ccx = camera.centerX
  const ccy = camera.centerY
  const lon = r.lon + r.dLon
  const lat = r.lat + r.dLat
  // One projector pair, built on the SAME anchor the shader re-centres against,
  // so the two constructions cannot be comparing different ground frames.
  const flat = { projType: 0, ccx, ccy, centerLon: r.lon, centerLat: r.lat }
  const projLive = makeGroundProjector(live, W, H, flat)
  const projP0 = makeGroundProjector(p0, W, H, flat)
  const cpu = groundBasisAt(lon, lat, projLive, projP0)
  if (cpu === null) return null
  const m = projMerc(lon, lat)
  return { shader: shaderBasis(live, p0, m[0] - ccx, m[1] - ccy), cpu }
}

/** The clamped spherical Mercator forward the flat path packs — mirrored here
 *  rather than imported so this file states the exact domain it feeds the shader
 *  mirror, and never silently follows a change in someone else's helper. */
function projMerc(lon: number, lat: number): [number, number] {
  const R = 6378137
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat))
  return [
    (lon * Math.PI * R) / 180,
    R * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)),
  ]
}

describe('#2118 — the point VS ground basis equals groundBasisAt', () => {
  for (const r of LATTICE) {
    it(`${r.name}`, () => {
      const b = basesFor(r)
      expect(b, 'the projector pair produced no basis for this row').not.toBeNull()
      const { shader, cpu } = b!
      // The similarity that turns the CPU's y-DOWN basis into the shader's y-UP
      // one: off-diagonals flip, diagonal does not.
      const expected = [cpu[0]!, -cpu[1]!, -cpu[2]!, cpu[3]!]
      // The tolerance is on the DIMENSIONLESS basis, so it means the same thing at
      // z4 and z18. 2e-4 is the finite-difference floor `groundBasisAt`'s own
      // header measures for δ=1e-8 (worst 1.6e-5 over its sweep) with room for the
      // f32 matrices both sides read; the analytic side contributes no error.
      for (let i = 0; i < 4; i++) {
        expect(shader[i], `basis[${i}]  shader=${shader[i]}  cpu=${expected[i]}`).toBeCloseTo(
          expected[i]!,
          // toBeCloseTo's digits are ABSOLUTE, and the basis is O(1), so 3 digits
          // is a 5e-4 band around a quantity whose interesting deviations (a sign
          // flip, a transposed pair) are O(0.1)–O(1).
          3,
        )
      }
    })
  }

  it('a pitched far-field basis is actually ANISOTROPIC — the lattice can tell a bug from a no-op', () => {
    // Without this the suite above would pass just as well if BOTH sides returned
    // the identity everywhere: agreement between two no-ops is not evidence. Pin
    // that the row the ellipse comes from is genuinely foreshortened — the north
    // axis is visibly shorter than the east one at pitch 60.
    const b = basesFor(LATTICE[1]!)!
    const eastLen = Math.hypot(b.shader[0]!, b.shader[1]!)
    const northLen = Math.hypot(b.shader[2]!, b.shader[3]!)
    expect(northLen).toBeLessThan(eastLen * 0.9)
  })

  it('at pitch 0 the basis is EXACTLY the identity — not merely close', () => {
    // The no-regression rung, and the reason `writePointFrameUniform` suppresses
    // the whole mode on `pitch === 0` rather than trusting a tolerance: at pitch 0
    // the pitch-0 matrix IS the live matrix element for element, so every term in
    // the 2×2 solve reduces to a value IEEE-754 guarantees. Exact equality, no
    // epsilon — if this ever needs a tolerance, the operand order has been
    // "simplified" and the byte-identity claim is gone with it.
    const camera = new Camera(2.35, 48.86, 14)
    camera.projType = 0
    camera.bearing = 37
    camera.pitch = 0
    const live = camera.getViewForProjection(0, W, H, DPR).matrix
    const p0 = new Pitch0Unprojector().matrix(camera, W, H, DPR)
    const m = projMerc(2.35, 48.864)
    const b = shaderBasis(live, p0, m[0] - camera.centerX, m[1] - camera.centerY)
    expect(b).toEqual([1, 0, 0, 1])
  })
})

describe('#2118 — the transcribed operand order is intact in the shader source', () => {
  // Mirror of derive-label-bbox.test.ts's source assertion. The arithmetic gate
  // above runs a CPU MIRROR of the shader; this one checks the shader itself still
  // spells the solve the way ground-basis.ts does, because the exact-identity
  // property is a property of the ORDER (`za*zd − zc*zb` over the identically
  // spelled `det`, and a product minus its own commuted self off-diagonal), and a
  // "simplification" would keep the mirror passing while losing it on the GPU.
  const src = readFileSync(new URL('../shaders/dsl/point.ts', import.meta.url), 'utf8')
  // THE JACOBIAN TERMS ARE HERE FOR A MEASURED REASON. The arithmetic suite above
  // runs a CPU MIRROR of the shader, so an edit to point.ts cannot redden it — and
  // that is not a hypothesis: flipping `.mul(hh)` to `.mul(hh.neg())` in the live
  // `lb` term left all 16 rows GREEN on the tree this was written against. A gate
  // that passes identically whether the y convention is right or wrong carries no
  // information about it (CLAUDE.md §12, "the assertion that failed either way"),
  // and the y convention is precisely the thing a transcription of this gets
  // wrong. So every line of the transcription is pinned verbatim, not just the
  // 2×2 solve: the `hw`/`hh` pairing per row, the quotient-rule operand order, and
  // which matrix each half reads.
  const TERMS = [
    'const la = Let(lc0.x.mul(lw).sub(groundClip.x.mul(lc0.w)).mul(hw).mul(lInv))',
    'const lb = Let(lc0.y.mul(lw).sub(groundClip.y.mul(lc0.w)).mul(hh).mul(lInv))',
    'const lc = Let(lc1.x.mul(lw).sub(groundClip.x.mul(lc1.w)).mul(hw).mul(lInv))',
    'const ld = Let(lc1.y.mul(lw).sub(groundClip.y.mul(lc1.w)).mul(hh).mul(lInv))',
    'const za = Let(zc0.x.mul(zw).sub(zclip.x.mul(zc0.w)).mul(hw).mul(zInv))',
    'const zb = Let(zc0.y.mul(zw).sub(zclip.y.mul(zc0.w)).mul(hh).mul(zInv))',
    'const zc = Let(zc1.x.mul(zw).sub(zclip.x.mul(zc1.w)).mul(hw).mul(zInv))',
    'const zd = Let(zc1.y.mul(zw).sub(zclip.y.mul(zc1.w)).mul(hh).mul(zInv))',
    'const hw = Let(viewport.x.mul(0.5))',
    'const hh = Let(viewport.y.mul(0.5))',
    'za.mul(zd).sub(zc.mul(zb))',
    'la.mul(zd).sub(lc.mul(zb)).div(det)',
    'lb.mul(zd).sub(ld.mul(zb)).div(det)',
    'lc.mul(za).sub(la.mul(zc)).div(det)',
    'ld.mul(za).sub(lb.mul(zc)).div(det)',
  ]
  for (const t of TERMS) {
    it(`point.ts still spells ${t}`, () => {
      expect(src).toContain(t)
    })
  }

  it('the CPU mirror above still mirrors these exact lines', () => {
    // The mirror is a second spelling of the same math, which is a liability: if
    // point.ts changes and the mirror does not, the arithmetic suite keeps
    // passing about code that no longer exists. The TERMS list is what ties them
    // together — this row just makes that dependency explicit so a future editor
    // who changes point.ts is told to change `shaderBasis` too.
    expect(TERMS.length).toBeGreaterThanOrEqual(15)
  })

  it('the pitch-0 half reads mvp_pitch0, not mvp', () => {
    // The cut that is invisible in every static read: if `zclip`/`zc0`/`zc1` come
    // off the LIVE matrix the basis is the identity forever, the feature silently
    // does nothing, and no frame throws. Both halves are pinned — the helper's own
    // use of its `mvp0` parameter, AND the call site that decides which uniform is
    // bound to it, because passing `U.field.mvp` there would be the same bug one
    // level up and the helper body would look perfectly correct.
    expect(src).toContain('const zclip = Let(transformMat4(mvp0, relPos))')
    expect(src).toContain('mvp0: U.field.mvp_pitch0,')
  })
})
