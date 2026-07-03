// ═══ Body — the single planetary-constants authority ═══
//
// X-GIS hardcodes WGS84-Earth constants (semi-major axis, flattening, the
// Mercator world extent) across ~5 packages. This module centralises the
// three independent knobs — equatorial radius `a`, flattening `f`, and the
// spherical-projection basis `sphereR` — into one frozen `Body` so that
// adding another body (Moon / Mars) is a single object, not a ~90-site hunt.
//
// DEPENDENCY-FREE by construction: this module imports nothing. Every one of
// the five consumer packages (@xgis/shared / engine / map / data / compiler)
// can read it without pulling a dependency graph, and the compiler tiler can
// consume it offline. Do NOT add imports here.
//
// ── Byte-identical Earth (the hard guarantee) ──
// The default active body is EARTH, so an unconfigured process renders Earth
// with the EXACT shipped constants and executes zero new math. Two values are
// PINNED, not derived, because deriving them drifts sub-metre and breaks the
// shipped goldens:
//
//   1. `worldMerc` = the pinned literal 40075016.686 — NOT `2·π·a`
//      (= 40075016.68557849). `metersPerPixel = worldMerc / TILE_PX / 2^zoom`
//      feeds every vertex's screen position, so a sub-metre drift there is a
//      coherent DC≠0 shift and breaks camera.test.ts (which asserts
//      40075016.686). EARTH pins the literal; non-Earth bodies derive `2·π·sphereR`
//      (no golden to protect).
//   2. `e2` = `f·(2 − f)` — the SAME expression the retired `ecef.ts` E2 used
//      (= 0.0066943799901413165). This deliberately does NOT equal the GPU-side
//      WGSL `e2` literal; the CPU/GPU divergence is pre-existing and preserved.

/** A celestial body's geodesy constants. Frozen; construct via {@link makeBody}
 *  (non-Earth bodies derive everything) or read the pinned {@link EARTH}. */
export interface Body {
  /** Human-readable id, e.g. `'earth-wgs84'`. */
  readonly name: string
  /** Equatorial (semi-major) radius, metres. [KNOB 1] */
  readonly a: number
  /** Flattening; 0 for a perfect sphere (e.g. the Moon). [KNOB 2] */
  readonly f: number
  /** Spherical-projection basis radius, metres. Earth === `a`, but DISTINCT:
   *  an oblate body may pick a mean radius. [KNOB 3] */
  readonly sphereR: number
  /** First eccentricity squared, `f·(2 − f)` (derived). */
  readonly e2: number
  /** Semi-minor axis, `a·(1 − f)` (derived). */
  readonly b: number
  /** Mean radius `(2a + b) / 3` (derived). */
  readonly meanRadius: number
  /** Web-Mercator world extent, metres. EARTH pins the literal 40075016.686;
   *  other bodies derive `2·π·sphereR`. Never re-derive Earth's from `2·π·a`. */
  readonly worldMerc: number
}

// Earth's two authored WGS84 inputs. Kept as locals so EARTH's derived fields
// reproduce the retired `ecef.ts` A/F/E2 expressions bit-for-bit.
const EARTH_A = 6378137
const EARTH_F = 1 / 298.257223563

/** WGS84 Earth — hand-pinned. `worldMerc` is the shipped literal (see PIN #1);
 *  `e2` / `b` use the same expressions the retired `ecef.ts` constants used. */
export const EARTH: Body = {
  name: 'earth-wgs84',
  a: EARTH_A,
  f: EARTH_F,
  sphereR: EARTH_A,
  e2: EARTH_F * (2 - EARTH_F),
  b: EARTH_A * (1 - EARTH_F),
  meanRadius: (2 * EARTH_A + EARTH_A * (1 - EARTH_F)) / 3,
  worldMerc: 40075016.686,
}

/** Overrides for {@link makeBody}. Both default from `a` / `f`. */
export interface MakeBodyOptions {
  /** Spherical-projection basis; defaults to `a`. */
  readonly sphereR?: number
  /** Mercator world extent; defaults to `2·π·sphereR`. */
  readonly worldMerc?: number
}

/** Build a non-Earth {@link Body}, deriving every field from `a` / `f`.
 *  (Earth is hand-pinned above so its `worldMerc` golden survives — do NOT
 *  route Earth through here.) */
export function makeBody(name: string, a: number, f: number, opts?: MakeBodyOptions): Body {
  const b = a * (1 - f)
  const sphereR = opts?.sphereR ?? a
  return {
    name,
    a,
    f,
    sphereR,
    e2: f * (2 - f),
    b,
    meanRadius: (2 * a + b) / 3,
    worldMerc: opts?.worldMerc ?? 2 * Math.PI * sphereR,
  }
}

/** The Moon — a perfect sphere (f = 0). */
export const MOON: Body = makeBody('moon', 1737400, 0)

/** Mars, IAU 2000 ellipsoid. */
export const MARS_IAU2000: Body = makeBody('mars-iau2000', 3396190, 1 / 169.8)

// ── Process-global active body (mirrors configureProjections) ──
// The active body is PROCESS-GLOBAL, backed by globalThis so it survives module
// duplication in a mixed resolver (the same reason configureProjections does).
// It DEFAULTS to EARTH, so an unconfigured process renders Earth with zero
// setup — the byte-identical guarantee.
type BodyModuleState = { active: Body }
const _state: BodyModuleState = ((globalThis as unknown as { __XGIS_BODY__?: BodyModuleState }).__XGIS_BODY__ ??= { active: EARTH })

/** Set the process-global active body. Construction seam for a non-Earth map. */
export function configureBody(body: Body): void {
  _state.active = body
}

/** The process-global active body. Defaults to {@link EARTH}. */
export function activeBody(): Body {
  return _state.active
}
