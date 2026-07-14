// ═══ Retained-particle-flow packer (the wind-map field) ═══
//
// Sibling of retained-arrow-packer.ts / retained-circle-packer.ts. Turns a ParticleFlowDrawSpec —
// whose `data` is the PER-GU field (design §2.1) — into the two GPU-bound typed arrays the
// retained-particle shader reads: the `feat` buffer (per-PARTICLE origin + direction tip + drift
// params, PARTICLE_RETAINED_FEAT layout) and the `tint` buffer (rgba). Every accessor runs EXACTLY
// ONCE here (add()/update(), never per frame).
//
// DENSITY ∝ VOLUME is a PACK-TIME allocation (design §2.3, §3.2): the fixed total N particles are
// distributed across the gu cells ∝ their RAW outflow volume (a busier gu seeds MORE particles),
// with a per-cell floor so the quietest gu still shows motion. This is the honest visual encoding
// of volume for a flow field (what wind maps use) — the shader never sees the volume, only the
// per-particle origin + direction. The seeding is DETERMINISTIC (a seeded PRNG, not Math.random)
// so a given spec always packs the identical particles — a prerequisite for the §5 pinned-`t`
// deterministic-probe gate (the whole frame is then a pure function of the seed + `t`).
//
// Seeding is CENTROID + bounded jitter (design §5-Q5): each particle's origin is the gu centroid
// displaced by a uniform-disc random offset within `seedRadiusMeters`. Its DIRECTION tip is that
// jittered origin stepped one bearing-step along the gu outflow direction — the arrow's #825
// two-point trick, so the drift direction is geographic. Position packing reuses the SAME ECEF/
// Mercator DSFUN math as the point/icon/arrow/circle packers.

import { worldCopyMercX } from '../render/point-feature-packer'
import { parseHexColor } from '../feature-helpers'
import { EARTH, lonLatToECEF } from '@xgis/shared'
import {
  PARTICLE_RETAINED_FEAT,
  PARTICLE_RETAINED_TINT_STRIDE,
} from '../shaders/dsl/particle-retained-feat-layout'
import type { ParticleFlowDrawSpec, IconColor, Position, Packed } from './graphics-types'

const F = PARTICLE_RETAINED_FEAT.slot
const STRIDE = PARTICLE_RETAINED_FEAT.stride
const DEG2RAD = Math.PI / 180
const TAU = Math.PI * 2
const MERC_LAT_LIMIT = 85.051129
const R_MERC = EARTH.sphereR // web-Mercator sphere radius (matches the point/icon/arrow/circle packers)
/** Metres per degree of latitude (≈ WGS84 mean) — the jitter/seed radius conversion. */
const M_PER_DEG = 111320
/** Tip offset from the origin along the bearing, in degrees — small, so the projected screen
 *  direction is the LOCAL tangent (magnitude is irrelevant; the shader normalises it). Mirrors
 *  the arrow packer's TIP_STEP_DEG. */
const TIP_STEP_DEG = 0.02

// Design §2.3 / §5 recommended defaults (each overridable per spec).
const DEFAULT_PARTICLE_COUNT = 4096 // N_cap — the legible Seoul field (§2.3)
const DEFAULT_MAX_PARTICLES = 16384 // hard ceiling, 2¹⁴ (§2.3)
const DEFAULT_MIN_PER_CELL = 8 // n_floor — quietest gu still shows motion (§5-Q4)
const DEFAULT_SEED_RADIUS_M = 1200 // centroid jitter radius (§5-Q5)
const DEFAULT_DRIFT_PX = 40 // drift length over one lifetime
const DEFAULT_LIFETIME_S = 2.5 // drift-and-respawn period
const DEFAULT_RADIUS_PX = 2 // disc radius (small dots read as flow)
const DEFAULT_SEED = 1 // deterministic PRNG seed (§5 reproducibility)

function resolve<T, D>(acc: Packed<T, D> | undefined, d: D, i: number): T | undefined {
  return typeof acc === 'function' ? (acc as (d: D, i: number) => T)(d, i) : acc
}

function normColor(c: IconColor | undefined): [number, number, number, number] {
  if (c === undefined) return [1, 1, 1, 1]
  if (typeof c === 'string') {
    const parsed = parseHexColor(c)
    return parsed ? [parsed[0], parsed[1], parsed[2], parsed[3]] : [1, 1, 1, 1]
  }
  return [c[0], c[1], c[2], c[3] ?? 1]
}

/** mulberry32 — a tiny deterministic PRNG. Seeded per pack so a given spec always yields the
 *  identical jitter + phase (the §5 pinned-`t` reproducibility contract). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Spread `n` as evenly as possible across `g` cells (Σ = n exactly). The degenerate fallback when
 *  the per-cell floors alone meet/exceed N, or when there is no volume signal at all. */
function evenSplit(n: number, g: number): number[] {
  const base = Math.floor(n / g)
  const rem = n - base * g
  const out = new Array<number>(g)
  for (let i = 0; i < g; i++) out[i] = base + (i < rem ? 1 : 0)
  return out
}

/** The FIXED total particle count for a spec — a spec param (design §2.3 N_cap, clamped to the
 *  ceiling), INDEPENDENT of the field's volume (volume drives the per-gu SPLIT, not the total). The
 *  batch is fixed-size so a per-hour re-pack never resizes (design §5-Q6); the graphics manager
 *  reads this for the batch's draw/instance count. Empty field ⇒ 0 (an empty batch draws nothing). */
export function resolveParticleInstanceCount<D>(spec: ParticleFlowDrawSpec<D>): number {
  if (spec.data.length === 0) return 0
  const cap = Math.max(1, Math.floor(spec.maxParticles ?? DEFAULT_MAX_PARTICLES))
  const want = Math.max(1, Math.floor(spec.particleCount ?? DEFAULT_PARTICLE_COUNT))
  return Math.min(want, cap)
}

/** Per-gu particle counts — the DENSITY ∝ VOLUME allocation (design §2.3). Distributes the fixed
 *  total N ∝ raw volume with a per-cell floor, summing to EXACTLY N (largest-remainder rounding).
 *  Runs getVolume once per cell. Exported so the density gate can assert n_i ∝ vol_i on the packer,
 *  the honest place to check a statistical property (design §3.5). */
export function allocateParticleCounts<D>(spec: ParticleFlowDrawSpec<D>): number[] {
  const cells = spec.data
  const g = cells.length
  const n = resolveParticleInstanceCount(spec)
  if (g === 0 || n === 0) return []
  const floor = Math.max(0, Math.floor(spec.minPerCell ?? DEFAULT_MIN_PER_CELL))
  const vols = cells.map((d, i) => Math.max(0, resolve<number, D>(spec.getVolume, d, i) ?? 0))

  const totalFloor = g * floor
  if (totalFloor >= n) return evenSplit(n, g) // floors alone meet N — spread evenly
  const remaining = n - totalFloor
  const sumV = vols.reduce((a, b) => a + b, 0)
  const counts = new Array<number>(g)
  if (sumV <= 0) {
    const ev = evenSplit(remaining, g) // no volume signal — even split on top of the floor
    for (let i = 0; i < g; i++) counts[i] = floor + ev[i]!
    return counts
  }
  const raw = vols.map((v) => (remaining * v) / sumV)
  let assigned = 0
  for (let i = 0; i < g; i++) {
    counts[i] = floor + Math.floor(raw[i]!)
    assigned += Math.floor(raw[i]!)
  }
  // Distribute the rounding leftover by largest fractional remainder → Σ counts === n exactly.
  const leftover = remaining - assigned
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((x, y) => y.frac - x.frac)
  for (let k = 0; k < leftover; k++) counts[order[k % g]!.i]!++
  return counts
}

/** Write one geo point's ECEF + Mercator DSFUN into feat[base .. base+11] — the 12-slot block
 *  shared by the origin (base 0) and the direction tip (base 12). Mirrors the arrow/point packers. */
function packGeoPoint(feat: Float32Array, base: number, lon: number, lat: number): void {
  const ecef = lonLatToECEF(lon, lat)
  const exH = Math.fround(ecef[0])
  const eyH = Math.fround(ecef[1])
  const ezH = Math.fround(ecef[2])
  feat[base + 0] = exH
  feat[base + 1] = eyH
  feat[base + 2] = ezH
  feat[base + 3] = ecef[0] - exH
  feat[base + 4] = ecef[1] - eyH
  feat[base + 5] = ecef[2] - ezH
  feat[base + 6] = lon
  feat[base + 7] = lat
  const mx = worldCopyMercX(lon, 0)
  const latC = Math.max(-MERC_LAT_LIMIT, Math.min(MERC_LAT_LIMIT, lat))
  const my = Math.log(Math.tan(Math.PI / 4 + (latC * DEG2RAD) / 2)) * R_MERC
  const mxH = Math.fround(mx)
  const myH = Math.fround(my)
  feat[base + 8] = mxH
  feat[base + 9] = Math.fround(mx - mxH)
  feat[base + 10] = myH
  feat[base + 11] = Math.fround(my - myH)
}

/** Pack the per-particle `feat` buffer (jittered origin + direction tip + drift params). Runs
 *  getPosition / getBearing / getVolume once per gu cell; `dpr` scales the px sizes to physical px.
 *  DETERMINISTIC: the seeded PRNG + the fixed cell-then-particle walk order make every pack of the
 *  same spec byte-identical (the §5 reproducibility contract). */
export function packRetainedParticleFeat<D>(
  spec: ParticleFlowDrawSpec<D>,
  dpr: number,
): Float32Array {
  const cells = spec.data
  const counts = allocateParticleCounts(spec)
  const total = counts.reduce((a, b) => a + b, 0)
  const feat = new Float32Array(total * STRIDE)

  const radiusPx = (spec.particleRadiusPx ?? DEFAULT_RADIUS_PX) * dpr
  const driftPx = (spec.driftPx ?? DEFAULT_DRIFT_PX) * dpr
  const lifetime = Math.max(1e-3, spec.lifetimeSeconds ?? DEFAULT_LIFETIME_S)
  const seedRadiusM = Math.max(0, spec.seedRadiusMeters ?? DEFAULT_SEED_RADIUS_M)
  const rng = mulberry32((spec.seed ?? DEFAULT_SEED) >>> 0)

  let p = 0
  for (let c = 0; c < cells.length; c++) {
    const d = cells[c]!
    const pos = resolve<Position, D>(spec.getPosition, d, c)
    const clon = pos ? pos[0] : 0
    const clat = pos ? pos[1] : 0
    const bearing = (resolve<number, D>(spec.getBearing, d, c) ?? 0) * DEG2RAD
    const cosLat = Math.cos(clat * DEG2RAD) || 1
    const cosB = Math.cos(bearing)
    const sinB = Math.sin(bearing)
    for (let k = 0; k < counts[c]!; k++) {
      const o = p * STRIDE
      // Jitter the origin within a disc of seedRadiusM around the centroid (√ for a uniform disc).
      const ang = rng() * TAU
      const r = Math.sqrt(rng()) * seedRadiusM
      const lat = clat + (r * Math.cos(ang)) / M_PER_DEG
      const lon = clon + (r * Math.sin(ang)) / (M_PER_DEG * cosLat)
      packGeoPoint(feat, o + F.ecef_x_h, lon, lat) // origin block (base 0)
      // Tip = origin stepped one bearing-step along the gu outflow direction (0=N, CW). East → lon.
      const tLat = lat + cosB * TIP_STEP_DEG
      const tLon = lon + (sinB * TIP_STEP_DEG) / (Math.cos(lat * DEG2RAD) || 1)
      packGeoPoint(feat, o + F.tip_ecef_x_h, tLon, tLat) // tip block (base 12)
      feat[o + F.radius_px] = radiusPx
      feat[o + F.drift_px] = driftPx
      feat[o + F.lifetime_s] = lifetime
      feat[o + F.phase_norm] = rng() // per-particle birth-time offset ∈ [0, 1)
      p++
    }
  }
  return feat
}

/** Pack the per-particle `tint` buffer (rgba). Each particle inherits its home-gu colour; runs
 *  getColor once per gu cell. Uses the SAME deterministic allocation as the feat pack, so tint slot
 *  i lines up with feat particle i. */
export function packRetainedParticleTint<D>(spec: ParticleFlowDrawSpec<D>): Float32Array {
  const cells = spec.data
  const counts = allocateParticleCounts(spec)
  const total = counts.reduce((a, b) => a + b, 0)
  const tint = new Float32Array(total * PARTICLE_RETAINED_TINT_STRIDE)
  let p = 0
  for (let c = 0; c < cells.length; c++) {
    const [r, g, b, a] = normColor(resolve(spec.getColor, cells[c]!, c))
    for (let k = 0; k < counts[c]!; k++) {
      const o = p * PARTICLE_RETAINED_TINT_STRIDE
      tint[o] = r
      tint[o + 1] = g
      tint[o + 2] = b
      tint[o + 3] = a
      p++
    }
  }
  return tint
}
