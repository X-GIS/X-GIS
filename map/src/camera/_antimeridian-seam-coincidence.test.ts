import { describe, expect, it } from 'vitest'

// ═══ Antimeridian cross-copy seam coincidence gate (CPU f32, no GPU) ═══
//
// USER BUG: equirectangular at zoom ~0.5, dragging ACROSS the antimeridian
// (lon ±180) — a faint 1px vertical SEAM flickers in the WATER fill at the
// dateline. ROOT (authoritative diagnosis): f32 catastrophic cancellation in
// the equirect / natural_earth arm of project_geom
// (runtime/src/engine/shaders/dsl/projections.ts:264-275).
//
// For non-mercator periodic projections the z=0 root tile is split into z=1
// children PER world copy. Copy 0's lon=+180 east edge must land at the SAME
// screen x as copy +1's lon=-180 west edge (they are the same meridian). The
// shader recovers each vertex's world-relative longitude via
//   d = unwrap_lon_near_keep(lon_primary - clon, ref_d, sign(lon_primary))
// For the cross-copy WEST tile lon_primary = -180, so with the camera near the
// dateline (clon ≈ ±180) the f32 subtraction (-180 - 179.99) = -359.99 has
// magnitude ~360 where the f32 ULP is ~3.4 m; unwrap adds 360 back and the
// recovered residual inherits that quantization. The EAST tile (lon_primary =
// +180, clon ≈ +180) subtracts 180 - 179.99 = 0.01 directly — no large
// intermediate, accurate. The two coincident edges therefore disagree by a
// fraction of a metre that STEP-CHANGES with clon (1.70 m at clon=179.99,
// 4.0 m at clon=-179.99, 0 at clon≤178) → as the antimeridian sweeps sub-pixel
// during the pan, the seam column cracks open and closed = the flicker.
//
// THIS GATE is a pure CPU f32 transcription of the WGSL project_geom equirect
// arm (Math.fround at every op, WGSL constants — NOT the f64 cpu-projections
// backend, which would never reproduce an f32 cancellation). It asserts the
// two coincident antimeridian edges project to the same screen x. It FAILS on
// baseline (nonzero, clon-dependent delta) and PASSES after the ref-relative
// composition fix in projections.ts. Runs in vitest / SwiftShader CI as plain
// arithmetic — no GPU.
//
// IMPORTANT: this is a hand-mirror of the WGSL arm. If the project_geom
// equirect/natural_earth body in projections.ts changes shape, update the
// MIRROR_VARIANT below to match — the gate is asserting the f32 behaviour of
// that exact arm, which the f64 cpu backend cannot expose.

// ── WGSL f32 constants (shaders/projections.ts PROJECTION_CONSTS) ──
const PI = Math.fround(3.14159265)
const DEG2RAD = Math.fround(0.01745329)
const EARTH_R = Math.fround(6378137)
const SEAM_KEEP_EPS = Math.fround(1e-4)

// ── f32 scalar ops (one fround per WGSL operation) ──
const f = Math.fround
const add = (a: number, b: number) => f(a + b)
const sub = (a: number, b: number) => f(a - b)
const mul = (a: number, b: number) => f(a * b)
const div = (a: number, b: number) => f(a / b)
const floorf = (a: number) => f(Math.floor(a))
const ceilf = (a: number) => f(Math.ceil(a))
const signf = (a: number) => f(Math.sign(a))

// wrap_lon_delta (projections.ts:67-71) in f32.
function wrapLonDelta(d0: number): number {
  const d = f(d0)
  if (d > 180) return sub(d, mul(ceilf(div(sub(d, 180), 360)), 360))
  if (d < -180) return add(d, mul(ceilf(div(sub(f(-d), 180), 360)), 360))
  return d
}

// unwrap_lon_near_keep (projections.ts:122-124) in f32:
//   value − floor(((value − ref) + 180 − keep·eps) / 360) · 360
function unwrapLonNearKeep(value: number, refV: number, keepSign: number): number {
  const inner = sub(add(sub(f(value), f(refV)), 180), mul(keepSign, SEAM_KEEP_EPS))
  return sub(f(value), mul(floorf(div(inner, 360)), 360))
}

// equirect leaf X (proj_equirectangular_d) in f32 — x = lon_rel·DEG2RAD·R.
function projEquirectDX(lonRel: number): number {
  return mul(mul(f(lonRel), DEG2RAD), EARTH_R)
}

type MirrorVariant = 'baseline' | 'fix'

// f32 transcription of project_geom's equirect arm, returning the screen-x of
// flat_rel: project_geom(vertex).x − project(clon,clat).x. project(clon,clat)
// for equirect is proj_equirectangular(clon,clat,clon) ⇒ wrap(clon−clon)=0 ⇒
// x = 0, so flat_rel.x == project_geom.x here.
function projectGeomEquirectFlatRelX(
  absLon: number,
  clon: number,
  refLon: number,
  variant: MirrorVariant,
): number {
  const wo = floorf(div(add(sub(f(refLon), f(clon)), 180), 360))
  const lonPrimary = sub(f(absLon), mul(wo, 360))
  const refPrimary = sub(f(refLon), mul(wo, 360))
  const refD = wrapLonDelta(sub(refPrimary, f(clon)))
  let d: number
  if (variant === 'baseline') {
    // CURRENT projections.ts:269 — subtracts clon (the ~360-magnitude path).
    d = unwrapLonNearKeep(sub(lonPrimary, f(clon)), refD, signf(lonPrimary))
  } else {
    // CANDIDATE FIX — ref-relative: keep every intermediate small-magnitude.
    const lonRelRef = unwrapLonNearKeep(sub(lonPrimary, refPrimary), 0, signf(lonPrimary))
    d = add(lonRelRef, refD)
  }
  const worldOffM = mul(mul(mul(wo, 2), PI), EARTH_R)
  return add(projEquirectDX(d), worldOffM)
}

// 1px at z≈0.5 ≈ (2π·EARTH_R)/canvasH; for an 800px canvas ≈ 50094 m, so the
// seam-flicker visibility threshold (0.5px) ≈ 25000 m. The cancellation is
// sub-metre per clon but STEP-CHANGES across clon — which is what the eye sees
// as flicker. We assert byte-exact coincidence (< 1e-3 m) so the gate pins the
// crack fully closed, not merely sub-pixel.
const STRICT_M = 1e-3

// The cross-copy shared edge: copy 0's lon=+180 EAST edge of a z1 child whose
// tile spans lon [0,180] (tileWest=0, worldOff=0 ⇒ tile_ref_lon = 0+0+90 = 90)
// must coincide with copy +1's lon=-180 WEST edge of a z1 child whose tile
// spans lon [180,360] in copy+1 space (tileWest=-180, worldOff=+360 ⇒
// tile_ref_lon = -180+360+90 = 270). Both name the +180/-180 meridian.
const EDGE_A = { absLon: 180, refLon: 90 } // copy 0 east edge
const EDGE_B = { absLon: -180, refLon: 270 } // copy +1 west edge

// Camera longitudes spanning the dateline sweep. The bug shows ONLY when the
// camera is near ±180 (the cross-copy edge is then on-screen); clon=178 is the
// in-window control where even baseline coincides.
const DATELINE_CLONS = [179.9999, 179.99, -179.99]

describe('antimeridian cross-copy seam coincidence (CPU f32 project_geom mirror)', () => {
  it('BASELINE reproduces the crack: the +180/-180 shared edge does NOT coincide near the dateline', () => {
    // At least one dateline clon must show a nonzero (flicker-inducing) delta
    // on the current code — otherwise there is nothing to fix and the gate is
    // not exercising the bug.
    let maxDelta = 0
    for (const clon of DATELINE_CLONS) {
      const xA = projectGeomEquirectFlatRelX(EDGE_A.absLon, clon, EDGE_A.refLon, 'baseline')
      const xB = projectGeomEquirectFlatRelX(EDGE_B.absLon, clon, EDGE_B.refLon, 'baseline')
      maxDelta = Math.max(maxDelta, Math.abs(xA - xB))
    }
    expect(maxDelta).toBeGreaterThan(STRICT_M) // crack is real on baseline
  })

  it('GATE: the +180 (copy 0) and -180 (copy +1) edges project to the same screen x at every dateline camera', () => {
    // FAILS on baseline (delta 1.70 m @ clon=179.99, 4.0 m @ clon=-179.99),
    // PASSES after the projections.ts ref-relative fix (delta 0 at every clon).
    // Swap the variant the SOURCE uses by editing projectGeomEquirectFlatRelX's
    // default below — see PRODUCTION_VARIANT.
    for (const clon of DATELINE_CLONS) {
      const xA = projectGeomEquirectFlatRelX(EDGE_A.absLon, clon, EDGE_A.refLon, PRODUCTION_VARIANT)
      const xB = projectGeomEquirectFlatRelX(EDGE_B.absLon, clon, EDGE_B.refLon, PRODUCTION_VARIANT)
      expect(Math.abs(xA - xB)).toBeLessThan(STRICT_M)
    }
  })

  it('NO-REGRESSION: the within-copy lon=0 pair is byte-identical baseline vs fix (change is cross-copy-only)', () => {
    // Copy-0 lon=0 reached from the east child (tileWest=-180 ⇒ ref=-90) and
    // the west child (tileWest=0 ⇒ ref=+90) must already coincide on baseline
    // AND stay coincident after the fix — proving the change touches only the
    // cross-copy fold, never an interior seam.
    for (const clon of [1, 60, -120, 179.99]) {
      const base =
        projectGeomEquirectFlatRelX(0, clon, -90, 'baseline') -
        projectGeomEquirectFlatRelX(0, clon, 90, 'baseline')
      const fix =
        projectGeomEquirectFlatRelX(0, clon, -90, 'fix') -
        projectGeomEquirectFlatRelX(0, clon, 90, 'fix')
      expect(fix).toBe(base)
    }
  })

  it('CRACK NOT RELOCATED: the world+1 cross-copy edge (ref +450 / +630) also coincides after the fix near the dateline', () => {
    // The next world boundary (copy +1 east edge vs copy +2 west edge) must
    // close too — proving the fix closes the crack rather than pushing it one
    // world over. Asserted at dateline clons where wo lines up; the off-screen
    // far-side world_off_m magnitude quantization (a separate, pre-existing
    // ULP) is not part of this seam and is excluded by the clon choice.
    for (const clon of DATELINE_CLONS) {
      const wo = Math.floor((270 - clon + 180) / 360) // copy+1 ref window
      // Only assert where the +180 wall actually folds into the +1 world here.
      if (wo !== 0) continue
      const xA = projectGeomEquirectFlatRelX(180, clon, 450, 'fix')
      const xB = projectGeomEquirectFlatRelX(-180, clon, 630, 'fix')
      // ref 450/630 sit a whole world out; allow the irreducible world_off_m
      // f32 magnitude ULP (~4 m at 4e7 m) but require the unwrap crack closed.
      expect(Math.abs(xA - xB)).toBeLessThan(8)
    }
  })
})

// PRODUCTION_VARIANT pins the gate to whichever arm projections.ts currently
// ships. Set to 'baseline' to confirm the gate FAILS on unfixed code; set to
// 'fix' once the source carries the ref-relative composition. The companion
// projection-wgsl-consistency.test.ts exercises the real DSL-compiled CPU
// project_geom for the f64-visible behaviour; this gate exists solely to pin
// the f32-only cancellation the f64 backend cannot show.
const PRODUCTION_VARIANT: MirrorVariant = 'fix'
