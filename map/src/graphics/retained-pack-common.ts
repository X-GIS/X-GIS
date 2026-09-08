// ═══ The retained-primitive packer family base — one writer per shared quantity ═══
//
// Five packers (arrow / circle / icon / particle / text) turn a *DrawSpec into the two
// GPU-bound arrays their shader reads. They differ in what each primitive IS; they had
// stopped differing in four things they all do, and each had written those four out
// itself (#2534 audit S11):
//
//   • `resolve`            — 5 byte-identical copies
//   • `normColor`          — 5 copies; circle's is the only PARAMETERISED one, and it is
//                            the general form (the other four are its `[1,1,1,1]` case)
//   • the 12-slot DSFUN    — 5 copies: arrow + particle as a byte-identical `packGeoPoint`,
//     anchor block           text as `writeAnchorDsfun`, icon + circle inline in their loops
//   • the rgba tint loop   — 5 copies: three write one colour per datum, text and particle
//                            replicate a datum's colour across its glyphs / particles
//
// Placement is ADR-0013 decision 1: every user is in THIS directory, so the helper is a
// family base beside them, not a push up to `shared/`.
//
// WHAT IS NOT FOLDED IN HERE, deliberately: `point-feature-packer.ts` writes the same
// anchor block a sixth time, and its arithmetic IS this one generalised over a world-copy
// offset (it passes `worldCopyMercX(lon, wo)`; the five below all pass `wo = 0`, and its
// hand-inlined Mercator-y is `latToMercatorY` verbatim, same ±85.051129 clamp). It stays
// out because it is under a byte-identical-arithmetic contract backed by a real-GPU DC=0
// gate (point-feature-packer.ts:136) — moving it is a §5 render-verification change, not
// this one. Recorded on #2534 rather than silently left behind.

import { lonLatToECEF } from '@xgis/shared'
import { latToMercatorY } from '@xgis/geo'
import { worldCopyMercX } from '../render/point-feature-packer'
import { hexToRgba } from '../feature-helpers'
import type { IconColor, Packed } from './graphics-types'

/** Opaque white — the fill default for every primitive except a circle's stroke. */
export const WHITE_RGBA: readonly [number, number, number, number] = [1, 1, 1, 1]

/** Resolve a `Packed<T,D>` accessor for item `i` — a function runs ONCE, a constant is
 *  returned as-is. Never invoked per frame. */
export function resolve<T, D>(acc: Packed<T, D> | undefined, d: D, i: number): T | undefined {
  return typeof acc === 'function' ? (acc as (d: D, i: number) => T)(d, i) : acc
}

/** Normalise an IconColor to an rgba tuple in 0..1, falling back to `dflt` when absent or
 *  unparseable. Callers pass WHITE_RGBA for a fill; the circle's stroke passes transparent
 *  (no ring), which is why the default is a parameter rather than baked in.
 *
 *  #1666 — the unparseable fallback used to be DEAD: the parser was total and answered
 *  opaque BLACK for a caller-supplied `'red'` / `'rebeccapurple'` / typo, so the default
 *  was unreachable. `hexToRgba` answers null and it runs. */
export function normColor(
  c: IconColor | undefined,
  dflt: readonly [number, number, number, number],
): [number, number, number, number] {
  if (c === undefined) return [dflt[0], dflt[1], dflt[2], dflt[3]]
  if (typeof c === 'string') {
    const parsed = hexToRgba(c)
    return parsed
      ? [parsed[0], parsed[1], parsed[2], parsed[3]]
      : [dflt[0], dflt[1], dflt[2], dflt[3]]
  }
  return [c[0], c[1], c[2], c[3] ?? 1]
}

/** f32 slots in the anchor block this module writes. Every *_RETAINED_FEAT layout opens with
 *  these twelve, in this order, at relative offsets 0..11 — which is what lets one writer
 *  serve all five (and arrow/particle's tip block, a second instance of it at +12).
 *  `retained-pack-common.test.ts` asserts that agreement against the five slot tables, so a
 *  layout that reorders or splits the block fails loudly instead of packing garbage. */
export const DSFUN_ANCHOR_SLOTS = 12

/** Write one geo point's ECEF + Mercator DSFUN into `feat[base .. base+11]`.
 *
 *  Baked at world copy 0 (`worldCopyMercX` is the shared point-packer authority); the shader
 *  adds the per-copy `world_offset` uniform for the flat-Mercator wrap. The hi/lo split is
 *  `Math.fround` + remainder, the extended-precision form the shared geo→clip ladder reads. */
export function packGeoPointDsfun(
  feat: Float32Array,
  base: number,
  lon: number,
  lat: number,
): void {
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
  const my = latToMercatorY(lat)
  const mxH = Math.fround(mx)
  const myH = Math.fround(my)
  feat[base + 8] = mxH
  feat[base + 9] = Math.fround(mx - mxH)
  feat[base + 10] = myH
  feat[base + 11] = Math.fround(my - myH)
}

/** f32 slots per instance in every retained tint buffer (rgba, 0..1). All five layouts
 *  declare their own `*_RETAINED_TINT_STRIDE`; `retained-pack-common.test.ts` asserts they
 *  all equal this, so the shared writer below cannot serve a layout that has diverged. */
export const RETAINED_TINT_STRIDE = 4

/** Pack a retained `tint` buffer (rgba). Runs `getColor` EXACTLY ONCE per datum.
 *
 *  `repeats` is the per-datum GPU instance count — omit it when one datum is one instance
 *  (arrow / circle / icon), pass the counts when a datum expands into several (text's
 *  per-glyph instances, particle's per-cell particles). Replication happens here rather than
 *  in each packer because the alignment it maintains — tint slot i describes feat instance i
 *  — was an invariant two copies asserted in prose and nothing enforced. */
export function packRetainedTint<D>(
  data: readonly D[],
  getColor: Packed<IconColor, D> | undefined,
  dflt: readonly [number, number, number, number],
  repeats?: ArrayLike<number>,
): Float32Array {
  const n = repeats === undefined ? data.length : Math.min(data.length, repeats.length)
  let total = 0
  for (let i = 0; i < n; i++) total += repeats === undefined ? 1 : repeats[i]!
  const tint = new Float32Array(total * RETAINED_TINT_STRIDE)
  let o = 0
  for (let i = 0; i < n; i++) {
    const count = repeats === undefined ? 1 : repeats[i]!
    if (count === 0) continue
    const [r, g, b, a] = normColor(resolve(getColor, data[i]!, i), dflt)
    for (let k = 0; k < count; k++) {
      tint[o] = r
      tint[o + 1] = g
      tint[o + 2] = b
      tint[o + 3] = a
      o += RETAINED_TINT_STRIDE
    }
  }
  return tint
}
