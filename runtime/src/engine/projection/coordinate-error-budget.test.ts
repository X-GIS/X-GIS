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

interface Cell {
  label: string
  lon: number
}
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

// ═══ Raster tile RTC — camera-anchor jitter gate (the satellite z18+ shake) ═══
//
// The raster / hillshade vs_tile subtracted the camera anchor as a SINGLE f32
// (u.cam_ecef_center). At |merc| ≈ 6.1e6 m one f32 ULP is ~0.73 m; as the camera
// PANS, that rounding walks the f32 grid frame-to-frame, so a STATIONARY ground
// point wobbles ±~0.73 m on screen — "지도가 흔들린다": invisible at z12, ~14 px at
// z20.55 over-zoom. The fix ships the anchor DSFUN hi/lo and subtracts hi
// (Sterbenz-exact against the ~6.1e6 m vertex) THEN lo, so the camera term is
// df64-precise and the wobble vanishes — the subtract-then-narrow discipline of
// the shader-dsl fp64-rtc example, brought to the raster path (polygon/line
// already shipped it as cam_ecef_off_h/l and cam_h/cam_l).
//
// This gate is the closed form of that shake: it pans the camera a few metres
// and measures the peak-to-peak SCREEN motion of a stationary vertex — the literal
// definition of jitter — with no GPU. Faithful on the Mercator x-axis (pure
// multiplies), the satellite demo's default projection.

/** Raster flat-Mercator arm, OLD: rel = project(lon) − camF32 (single f32 anchor). */
function rasterMercOldErrM(lon: number, camLon: number): number {
  const p2dx = f(f(f(lon) * DEG2RAD_F32) * R_F32) // proj_mercator x, absolute f32
  const camF32 = f(mercX64(camLon)) // single f32 camera Mercator X (the old anchor)
  const relX = f(p2dx - camF32)
  return relX - (mercX64(lon) - mercX64(camLon)) // signed error vs f64 truth
}

/** Raster flat-Mercator arm, NEW: rel = (project(lon) − camH) − camL (DSFUN hi/lo). */
function rasterMercNewErrM(lon: number, camLon: number): number {
  const p2dx = f(f(f(lon) * DEG2RAD_F32) * R_F32)
  const [camH, camL] = splitF64(mercX64(camLon))
  const relX = f(f(p2dx - camH) - camL)
  return relX - (mercX64(lon) - mercX64(camLon))
}

/** Peak-to-peak screen wobble (px) of a STATIONARY vertex as the camera pans a few
 *  metres. Truth: a smooth pan moves the vertex smoothly, so ANY peak-to-peak in
 *  the f32 position error over that pan IS the jitter the eye reads as shake. The
 *  3 m sweep crosses several ~0.73 m f32 anchor cells, so the single-f32 arm shows
 *  its full-ULP wobble at every view zoom. */
function panJitterPx(
  errFn: (lon: number, camLon: number) => number,
  lon: number,
  camLonBase: number,
  viewZoom: number,
): number {
  const px = pxPerM(viewZoom)
  const SWEEP_M = 3
  const sweepDeg = SWEEP_M / (DEG2RAD * R)
  let lo = Infinity
  let hi = -Infinity
  for (let k = 0; k <= 256; k++) {
    const camLon = camLonBase + (sweepDeg * k) / 256
    const e = errFn(lon, camLon) * px
    if (e < lo) lo = e
    if (e > hi) hi = e
  }
  return hi - lo
}

describe('raster tile RTC — camera-anchor jitter (satellite z18+ shake)', () => {
  const seoul = CELLS[0]!
  it('OLD single-f32 anchor: a stationary vertex SHAKES multiple px at z18+ over-zoom', () => {
    for (const z of [18, 20, 20.55]) {
      const jit = panJitterPx(rasterMercOldErrM, seoul.lon, seoul.lon, z)
      expect(
        jit,
        `old raster jitter ${jit.toFixed(2)}px @ z${z} (must exceed 1px — the visible shake)`,
      ).toBeGreaterThan(1)
    }
  })
  it('NEW DSFUN hi/lo anchor: the SAME vertex is rock-steady (< 0.05px) at every zoom', () => {
    for (const z of VIEW_ZOOMS) {
      const jit = panJitterPx(rasterMercNewErrM, seoul.lon, seoul.lon, z)
      expect(
        jit,
        `new raster jitter ${jit.toExponential(2)}px @ z${z} (must be sub-0.05px — no shake)`,
      ).toBeLessThan(0.05)
    }
  })
  it('the fix removes ≥100× of the pan jitter at the reported z20.55 over-zoom', () => {
    const oldJ = panJitterPx(rasterMercOldErrM, seoul.lon, seoul.lon, 20.55)
    const newJ = panJitterPx(rasterMercNewErrM, seoul.lon, seoul.lon, 20.55)
    expect(oldJ / Math.max(newJ, 1e-9)).toBeGreaterThan(100)
  })
})

// ═══ Raster arm 2 (flat NON-Mercator) — camera-anchor jitter gate ═══
//
// The DSFUN Mercator anchor above (#1308) fixed projType 0 and the ECEF anchor
// fixed globe (7), but the flat NON-Mercator arm (equirect/natural_earth/…/
// oblique, projType 1-6) kept re-projecting a SINGLE-f32 clon/clat (proj_params.
// y/z) as its camera term: at clon ≈ 127° one f32 ULP is ~1.5e-5° ≈ 1.7 m, so as
// the camera panned that rounding walked the f32 grid and the tile sheet SHOOK in
// EVERY non-Mercator projection ("메르카토르에서는 문제 없는데 다른 모든
// 프로젝션에서 흔들려요"). The fix mirrors line/polygon: feed project_geom the
// df64 camera-relative longitude d_lon = (abs_lon − clon_hi) − clon_lo (recentred
// onto clon = 0) and subtract the camera's projected 2D centre in df64.
//
// This gate is the closed form of that shake for the two SEPARABLE projections
// (equirect / natural_earth — whose y is a pure clat term, so BOTH axes go
// rock-steady). Longitude AND latitude pans are measured; no GPU. (The azimuthal/
// oblique arms are non-separable in latitude — the fix pins their dominant
// longitude axis; a whole-earth default zoom keeps the latitude residual
// sub-pixel there — so they are out of this separable-axis gate.)

const radf = (deg: number): number => f(f(deg) * DEG2RAD_F32) // shader radians()
const sgn = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0)
const wrapLonDelta = (d: number): number =>
  d > 180
    ? f(d - f(Math.ceil(f(f(d - 180) / 360)) * 360))
    : d < -180
      ? f(d + f(Math.ceil(f(f(f(-d) - 180) / 360)) * 360))
      : d
const unwrapKeep = (v: number, r: number, ks: number): number =>
  f(v - f(Math.floor(f(f(f(f(v - r) + 180) - f(ks * 1e-4)) / 360)) * 360))

// natural_earth pseudocylindrical scale/offset polynomials (projections.ts).
function neXsYv32(latDeg: number): [number, number] {
  const lat = radf(latDeg),
    l2 = f(lat * lat),
    l4 = f(l2 * l2),
    l6 = f(l2 * l4)
  const xs = f(f(f(0.8707 - f(l2 * 0.131979)) + f(l4 * 0.013791)) - f(l6 * 0.0081435))
  const yv = f(
    lat *
      f(
        1.007226 +
          f(l2 * f(0.015085 + f(l2 * f(f(-0.044475 + f(l2 * 0.028874)) - f(l4 * 0.005916))))),
      ),
  )
  return [xs, yv]
}
function neXsYv64(latDeg: number): [number, number] {
  const lat = latDeg * DEG2RAD,
    l2 = lat * lat,
    l4 = l2 * l2,
    l6 = l2 * l4
  const xs = 0.8707 - l2 * 0.131979 + l4 * 0.013791 - l6 * 0.0081435
  const yv = lat * (1.007226 + l2 * (0.015085 + l2 * (-0.044475 + l2 * 0.028874 - l4 * 0.005916)))
  return [xs, yv]
}

// ── OLD arm 2: flat_rel = project_geom(vertex) − project(clon,clat), single-f32
//    clon/clat. Faithful f32; single world copy (wo = 0, near-camera tiles). ──
function equirectOldRel(lon: number, lat: number, clonR: number, clatR: number): [number, number] {
  const clon = f(clonR),
    clat = f(clatR),
    refLon = lon
  const refD = wrapLonDelta(f(refLon - clon))
  const d = f(unwrapKeep(f(lon - refLon), 0, sgn(lon)) + refD)
  const px = f(radf(d) * R_F32),
    py = f(radf(lat) * R_F32)
  return [f(px - 0), f(py - f(radf(clat) * R_F32))]
}
function neOldRel(lon: number, lat: number, clonR: number, clatR: number): [number, number] {
  const clon = f(clonR),
    clat = f(clatR),
    refLon = lon
  const refD = wrapLonDelta(f(refLon - clon))
  const d = f(unwrapKeep(f(lon - refLon), 0, sgn(lon)) + refD)
  const [xs, yv] = neXsYv32(lat)
  const px = f(f(radf(wrapLonDelta(d)) * xs) * R_F32),
    py = f(yv * R_F32)
  return [f(px - 0), f(py - f(neXsYv32(clat)[1] * R_F32))]
}

// ── NEW arm 2 impl: project_geom(dLon, lat, clon=0) − df64 camProj0. ──
function equirectNewRel(lon: number, lat: number, clon: number, clat: number): [number, number] {
  const [ch, cl] = splitF64(clon)
  const dLon = f(f(lon - ch) - cl) // (abs_lon − clon_hi) − clon_lo
  const px = f(radf(dLon) * R_F32),
    py = f(radf(lat) * R_F32)
  const [cyh, cyl] = splitF64(clat * DEG2RAD * R) // df64 camProj0.y (f64 truth split)
  return [f(px - 0), f(f(py - cyh) - cyl)]
}
function neNewRel(lon: number, lat: number, clon: number, clat: number): [number, number] {
  const [ch, cl] = splitF64(clon)
  const dLon = f(f(lon - ch) - cl)
  const [xs, yv] = neXsYv32(lat)
  const px = f(f(radf(dLon) * xs) * R_F32),
    py = f(yv * R_F32)
  const [cyh, cyl] = splitF64(neXsYv64(clat)[1] * R) // df64 camProj0.y
  return [f(px - 0), f(f(py - cyh) - cyl)] // camProj0.x = 0; y subtracts df64 camera term
}

// f64 truth: the camera-relative projected position moves SMOOTHLY as the camera
// pans, so any peak-to-peak in the f32 error over a small pan IS the jitter.
function equirectTruth(lon: number, lat: number, clon: number, clat: number): [number, number] {
  return [(lon - clon) * DEG2RAD * R, (lat - clat) * DEG2RAD * R]
}
function neTruth(lon: number, lat: number, clon: number, clat: number): [number, number] {
  return [(lon - clon) * DEG2RAD * neXsYv64(lat)[0] * R, (neXsYv64(lat)[1] - neXsYv64(clat)[1]) * R]
}

type RelFn = (lon: number, lat: number, clon: number, clat: number) => [number, number]
/** Peak-to-peak screen wobble (px) of a stationary vertex as the camera pans 3 m
 *  along `axis`, on the dominant (matching) screen axis. */
function panJitter2D(
  rel: RelFn,
  truth: RelFn,
  lon: number,
  lat: number,
  clonB: number,
  clatB: number,
  z: number,
  axis: 'lon' | 'lat',
): number {
  const px = pxPerM(z),
    sweepDeg = 3 / (DEG2RAD * R)
  const comp = axis === 'lon' ? 0 : 1 // lon-pan wobbles x; lat-pan wobbles y
  let lo = Infinity,
    hi = -Infinity
  for (let k = 0; k <= 256; k++) {
    const clon = clonB + (axis === 'lon' ? (sweepDeg * k) / 256 : 0)
    const clat = clatB + (axis === 'lat' ? (sweepDeg * k) / 256 : 0)
    const e = (rel(lon, lat, clon, clat)[comp] - truth(lon, lat, clon, clat)[comp]) * px
    if (e < lo) lo = e
    if (e > hi) hi = e
  }
  return hi - lo
}

describe('raster arm 2 (flat non-Mercator) — camera-anchor jitter (all-projection shake)', () => {
  // Seoul; a vertex ~half a tile from the camera (frame-stable per vertex).
  const clon = 126.9784,
    clat = 37.5665,
    vlon = clon + 0.0007,
    vlat = clat + 0.0005
  const SEP: ReadonlyArray<[string, RelFn, RelFn, RelFn]> = [
    ['equirectangular', equirectOldRel, equirectNewRel, equirectTruth],
    ['natural_earth', neOldRel, neNewRel, neTruth],
  ]

  it('OLD single-f32 clon/clat: the sheet SHAKES multiple px at z18+ on BOTH pan axes', () => {
    for (const [name, oldRel, , truth] of SEP) {
      for (const z of [18, 20.55]) {
        for (const axis of ['lon', 'lat'] as const) {
          const jit = panJitter2D(oldRel, truth, vlon, vlat, clon, clat, z, axis)
          expect(
            jit,
            `OLD ${name} ${axis}-pan ${jit.toFixed(2)}px @z${z} (must shake >1px)`,
          ).toBeGreaterThan(1)
        }
      }
    }
  })

  it('NEW df64 recentre: the SAME vertex is rock-steady (<0.05px) on BOTH axes, every zoom', () => {
    for (const [name, , newRel, truth] of SEP) {
      for (const z of VIEW_ZOOMS) {
        for (const axis of ['lon', 'lat'] as const) {
          const jit = panJitter2D(newRel, truth, vlon, vlat, clon, clat, z, axis)
          expect(
            jit,
            `NEW ${name} ${axis}-pan ${jit.toExponential(2)}px @z${z} (must be <0.05px)`,
          ).toBeLessThan(0.05)
        }
      }
    }
  })

  it('the fix removes ≥100× of the pan jitter at the reported z20.55 over-zoom', () => {
    for (const [, oldRel, newRel, truth] of SEP) {
      for (const axis of ['lon', 'lat'] as const) {
        const oldJ = panJitter2D(oldRel, truth, vlon, vlat, clon, clat, 20.55, axis)
        const newJ = panJitter2D(newRel, truth, vlon, vlat, clon, clat, 20.55, axis)
        expect(oldJ / Math.max(newJ, 1e-9)).toBeGreaterThan(100)
      }
    }
  })
})
