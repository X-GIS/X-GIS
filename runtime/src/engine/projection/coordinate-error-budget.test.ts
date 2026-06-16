import { describe, it, expect } from 'vitest'

// ═══ Coordinate error budget — PRE-OBSERVATION precision gate ═══
//
// The H2 fill-vs-outline bug (#387→#389→#392) was a PRECISION bug: the pre-#392
// polygon fill arm stored ABSOLUTE lon/lat degrees in f32 and re-projected, so a
// single f32 holding |merc_x|≈1.4e7 m at Seoul had ~1.7 m granularity → ~30 px of
// fill/outline split at z20.55. It took three tries (two wrong roots) because it
// was chased by render-and-eyeball — yet it has a CLOSED FORM and was catchable at
// DESIGN, with no GPU, no screenshot, over the WHOLE zoom×lon domain.
//
// This gate is that closed form, made executable (see skill: render-error-budget).
// For each coordinate path it computes, over a dense zoom×lon grid:
//   • the EMPIRICAL f32 error: the path simulated in f32 (Math.fround every op,
//     the SAME ops the shader runs) minus the f64 truth — a dense sample of the
//     MATH, not pixels.
//   • the ANALYTIC bound: dominant-magnitude · f32-ulp · pxPerM(zoom) — the
//     leading-order "physics" of the error.
// It asserts the SHIPPING paths (tile-local, DSFUN) stay sub-pixel at every zoom
// BY CONSTRUCTION, while the pre-#392 abs-degree path provably EXCEEDS tolerance at
// deep zoom (H2 as a computed design-level fact, derivable before any pixel exists).
// No GPU, no raster — runs in the normal vitest CI job.
//
// SCOPE — what this gate IS and is NOT. It is a CLOSED-FORM proof about the storage
// FRAME: abs-degree is provably lossy, tile-local provably sub-px. It does NOT read
// the shader, so it does NOT detect a regression that reverts the emitted arm — that
// guard is the real-GPU token-pin in _polygon-fill-flat-parity.spec.ts (#393). The
// two are COMPLEMENTARY: #393 = "the live shader still computes the right position";
// this = "the frame the shader was migrated TO is provably the right one." Its value
// is design-time: had this budget existed when the fill arm was written, the 56 px
// number below would have rejected abs-degree at design, with no user report.
//
// AXIS — the dominant H2 displacement is the x-axis (lon → merc_x, PURE MULTIPLIES,
// so Math.fround-per-op is a faithful f32 model). merc_y is the same ~1e7 magnitude
// (same storage-ulp budget) and empirically similar (abs-degree y ≈ 41 px at z20.55),
// but its log/tan is a transcendental whose f32 grain this CPU model would only
// approximate — so the rigorous gate stays on the faithfully-modelled x-axis.

const R = 6378137
const DEG2RAD = Math.PI / 180
const TILE_SIZE = 512 // Web-Mercator px tiles (MapLibre parity)
const ULP_F32 = 2 ** -23 // f32 relative grain (consecutive-float spacing / value)
const LAT_LIM = 85.051129

// The shader's TRUNCATED f32 constants (snapshot proj_mercator) — using the exact
// same truncated values the GPU does keeps the simulation faithful.
const DEG2RAD_F32 = Math.fround(0.01745329)
const R_F32 = Math.fround(6378137)

const f = Math.fround
const mercX64 = (lon: number): number => lon * DEG2RAD * R
const pxPerM = (zoom: number): number => (TILE_SIZE * 2 ** zoom) / (2 * Math.PI * R)
function splitF64(x: number): [number, number] {
  const h = f(x)
  return [h, f(x - h)]
}

const PX_TOL = 0.5 // sub-pixel coincidence target (fill must sit on the outline)
const VIEW_ZOOMS = [14, 16, 18, 20, 20.55, 22] // includes the reported z20.55 over-zoom
const TILE_ZOOM = 14 // OFM maxzoom — the over-zoom PARENT tile that stretches at z20.55

/** Slippy z14 tile west-lon containing `lon` (the over-zoom parent), + its span. */
function tileLonBand(lon: number, z: number): { west: number; span: number } {
  const n = 2 ** z
  const tx = Math.floor(((lon + 180) / 360) * n)
  const west = (tx / n) * 360 - 180
  return { west, span: 360 / n }
}

interface Cell { label: string; lon: number }
const CELLS: Cell[] = [
  { label: 'seoul', lon: 126.87814 },
  { label: 'near-antimeridian', lon: 178.42 }, // larger |merc_x| → larger f32 grain
]

// ── The three coordinate paths, simulated in f32 over the SAME ops the shader runs.
//    Each returns the x-axis displacement ERROR in metres for a vertex at `lon`,
//    inside a tile whose west is `tileWestLon`, with the camera at `camLon`.

/** PRE-#392 fill arm: tail slot stores f32 abs-degree; position = project(deg). */
function absDegreeErrM(lon: number, tileWestLon: number, camLon: number): number {
  const tileMx = mercX64(tileWestLon)
  const camMx = mercX64(camLon)
  const [camH, camL] = splitF64(camMx - tileMx)
  const storedLon = f(lon) // the f32 abs_lon degree slot
  const p2dx = f(f(storedLon * DEG2RAD_F32) * R_F32) // proj_mercator x in f32
  const originX = f(tileMx) // u.tile_origin_merc.x (f32 uniform)
  // vs_main flat arm: rel = ((p2d - origin) - cam_h) - cam_l, all f32
  const relX = f(f(f(p2dx - originX) - camH) - camL)
  const truthRelX = mercX64(lon) - camMx
  return Math.abs(relX - truthRelX)
}

/** #392 fill arm: tail slot stores f32 TILE-LOCAL Mercator; rel = local - cam. */
function tileLocalErrM(lon: number, tileWestLon: number, camLon: number): number {
  const tileMx = mercX64(tileWestLon)
  const camMx = mercX64(camLon)
  const [camH, camL] = splitF64(camMx - tileMx)
  const storedLocal = f(mercX64(lon) - tileMx) // f32 tile-local merc slot
  const relX = f(f(storedLocal - camH) - camL) // vs_main_ecef flat arm
  const truthRelX = mercX64(lon) - camMx
  return Math.abs(relX - truthRelX)
}

/** Line/outline arm: DSFUN hi/lo f32 pair of tile-local merc. */
function dsfunErrM(lon: number, tileWestLon: number, camLon: number): number {
  const tileMx = mercX64(tileWestLon)
  const camMx = mercX64(camLon)
  const [camH, camL] = splitF64(camMx - tileMx)
  const [hi, lo] = splitF64(mercX64(lon) - tileMx)
  const relX = f(f(hi - camH) + f(lo - camL)) // (pos_h - cam_h) + (pos_l - cam_l)
  const truthRelX = mercX64(lon) - camMx
  return Math.abs(relX - truthRelX)
}

type PathFn = (lon: number, tileWestLon: number, camLon: number) => number

/** Worst empirical px error of `path` over the lon band of `cell`'s tile, at `viewZoom`. */
function worstEmpiricalPx(path: PathFn, cell: Cell, viewZoom: number): number {
  const { west, span } = tileLonBand(cell.lon, TILE_ZOOM)
  const camLon = cell.lon
  let worst = 0
  for (let i = 0; i <= 64; i++) {
    const lon = west + (span * i) / 64
    const px = path(lon, west, camLon) * pxPerM(viewZoom)
    if (px > worst) worst = px
  }
  return worst
}

/** Leading-order analytic bound (px): dominant f32 magnitude · ulp · pxPerM. */
function analyticPx(dominantM: number, viewZoom: number): number {
  return dominantM * ULP_F32 * pxPerM(viewZoom)
}

describe('coordinate error budget — pre-observation precision gate', () => {
  it('#392 tile-local fill arm: sub-pixel at EVERY zoom, by construction', () => {
    // tile-local magnitude ≤ tile_extent(z14); a single f32 of it is sub-mm, so the
    // px error is bounded by tile_extent·ulp·pxPerM — sub-pixel at every view zoom.
    for (const cell of CELLS) {
      for (const z of VIEW_ZOOMS) {
        const worst = worstEmpiricalPx(tileLocalErrM, cell, z)
        expect(
          worst,
          `tile-local fill split ${worst.toExponential(3)}px @ ${cell.label} z${z} (must be sub-${PX_TOL}px)`,
        ).toBeLessThan(PX_TOL)
      }
    }
  })

  it('DSFUN line/outline arm: sub-pixel at EVERY zoom, by construction', () => {
    for (const cell of CELLS) {
      for (const z of VIEW_ZOOMS) {
        const worst = worstEmpiricalPx(dsfunErrM, cell, z)
        expect(
          worst,
          `DSFUN outline split ${worst.toExponential(3)}px @ ${cell.label} z${z}`,
        ).toBeLessThan(PX_TOL)
      }
    }
  })

  it('pre-#392 abs-degree fill arm: PROVABLY exceeds tolerance at deep zoom (H2, at design)', () => {
    // The bug, as a computed fact. The f32 abs-degree path's split grows with view
    // zoom (the metre error is fixed by the storage frame; pxPerM magnifies it) AND
    // with |lon| (merc_x → 0 near the prime meridian, so the error vanishes there; it
    // is largest where |merc_x| is largest — Seoul lon 127, the real bug locus). By
    // z≥20 it is many pixels — the visible fill/outline displacement, derivable with
    // no GPU and no user report. This is the gate's TEETH: it red-flags the lossy
    // frame at DESIGN. (Reference path; not a shipping arm after #392.)
    const seoul = CELLS[0]
    for (const z of [20, 20.55, 22]) {
      const worst = worstEmpiricalPx(absDegreeErrM, seoul, z)
      expect(
        worst,
        `abs-degree arm should be grossly displaced @ z${z}, got ${worst.toFixed(2)}px`,
      ).toBeGreaterThan(5)
    }
    // And it is DRAMATICALLY worse than the #392 fix at the reported camera —
    // the whole point of the migration, quantified before any pixel exists.
    const lossy = worstEmpiricalPx(absDegreeErrM, seoul, 20.55)
    const fixed = worstEmpiricalPx(tileLocalErrM, seoul, 20.55)
    expect(lossy / Math.max(fixed, 1e-9)).toBeGreaterThan(1000)
  })

  it('closed-form leading term predicts the split to order-of-magnitude (frame decided analytically)', () => {
    // The leading-order physics — dominant magnitude · f32-ulp · pxPerM — predicts the
    // measured f32 error to WITHIN AN ORDER OF MAGNITUDE. That is enough to decide the
    // FRAME at design: abs-degree ≫ 0.5px, tile-local ≪ 0.5px — a ~29000× gap, not a
    // close call. It is NOT a tight coefficient model: the empirical (56.7px) is ~1.7×
    // the leading term (33px) because a SECOND same-order term — the truncated f32
    // constant DEG2RAD_F32 (rel err ~1.4e-7) — adds a comparable contribution the
    // single-dominant-term model omits. So the bracket below is a wide FRAME-SANITY
    // band (confirms order + sign), NOT a claim the exact magnitude is modelled; the
    // precise number is the empirical measurement above. The closed form's job is to
    // make the frame decision derivable without rendering — and it does.
    const seoul = CELLS[0]
    const z = 20.55
    // abs-degree dominant magnitude = the absolute Mercator x it stores (~1.4e7 m).
    const absDom = Math.abs(mercX64(seoul.lon))
    const absAnalytic = analyticPx(absDom, z)
    const absEmpirical = worstEmpiricalPx(absDegreeErrM, seoul, z)
    expect(absEmpirical).toBeGreaterThan(absAnalytic * 0.2)
    expect(absEmpirical).toBeLessThan(absAnalytic * 5)
    // tile-local dominant magnitude = tile extent at z14 (the stored frame's span).
    const tileExtent = (2 * Math.PI * R) / 2 ** TILE_ZOOM
    const tlAnalytic = analyticPx(tileExtent, z)
    const tlEmpirical = worstEmpiricalPx(tileLocalErrM, seoul, z)
    expect(tlEmpirical).toBeLessThan(tlAnalytic * 3)
    // The analytic numbers ARE the design-time verdict: lossy ≫ 0.5px, fixed ≪ 0.5px.
    expect(absAnalytic).toBeGreaterThan(5)
    expect(tlAnalytic).toBeLessThan(PX_TOL)
  })
})
