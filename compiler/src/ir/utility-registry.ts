// ═══ Utility micro-grammar — single declarative authority (#1067) ═══
//
// Before #1067 the ~78 utility prefixes were dispatched by ordered
// `startsWith` ladders DUPLICATED across four sites — lower.ts's binding
// registry (lower-bindings-*.ts), lower-label.ts, lower-animation.ts
// (keyframes), and utility-resolver.ts — each re-deriving "is this a known
// prefix?" and "is it animatable?" by hand. Two silent-drop holes lived in
// that duplication: an unknown utility in normal lowering fell through every
// `startsWith` arm with no diagnostic, and keyframe expansion silently
// ignored any utility it didn't recognise (lower-animation.ts).
//
// This module is the ONE table those questions are answered from. Each
// `UtilityDef` is a `{ prefix, valueKind, unit, animatable, appliesTo }`
// record (the shape #1067 specifies). The consumers are GENERATED from it:
//
//   • keyframe validation (lower-animation.ts) — the animatable subset IS
//     `UTILITY_REGISTRY.filter(d => d.animatable)`; an unknown or a
//     non-animatable utility in a `keyframes` block is now an error.
//   • the unknown-utility gate (lower.ts) — a plain utility-form item that
//     matches NO registry entry is an error (X-GIS0013) with nearest-name
//     help, instead of a silent no-op.
//
// The detailed per-property BEHAVIOUR (how `stroke-<n>` becomes a width vs
// `stroke-<color>` a colour, how `size-<n><unit>` parses its unit) stays in
// the handlers — the table is the authority for the PREFIX SET + its
// classification, not a code generator for the arm bodies (§2 simplicity).
//
// LONGEST-MATCH lookup makes the table order-INDEPENDENT: `stroke-dashoffset-`
// wins over `stroke-`, `fill-pattern-` over `fill-`, purely by prefix length —
// no hand-ordered ladder whose arm sequence is load-bearing.
//
// The `label-*` family is represented COARSELY (one `label-` entry): its ~60
// sub-prefixes have their own single authority — lower-label.ts's dispatch
// plus its X-GIS0006 unknown-label catch-all — and enumerating them a second
// time here would recreate exactly the two-authorities drift this table
// exists to remove.

/** How `UtilityDef.prefix` is matched against a utility name. */
export type UtilityMatch = 'prefix' | 'exact'

/** The value a utility carries after its prefix. `expr` is the binding-form
 *  base name (`fill-[…]`, `opacity-[…]`); `composite` is a sub-grammar
 *  (`animation-*`) or a delegated family (`label-*`). */
export type UtilityValueKind =
  'color' | 'number' | 'enum' | 'boolean' | 'expr' | 'string' | 'composite'

/** Unit rule for a `number` utility. `null` = unitless scalar. `size-` takes
 *  an OPTIONAL suffix (px default) — recorded as its default `px`. */
export type UtilityUnit = 'px' | 'm' | 'km' | 'nm' | 'deg' | null

/** Which lowering family owns the utility. */
export type UtilityAppliesTo = 'paint' | 'label' | 'animation'

/** One row of the micro-grammar. */
export interface UtilityDef {
  /** Literal prefix (for `match:'prefix'`) or full name (for `match:'exact'`). */
  prefix: string
  match: UtilityMatch
  valueKind: UtilityValueKind
  unit: UtilityUnit
  /** True iff a `keyframes` block may animate this utility. The six animatable
   *  axes are opacity, fill colour, stroke colour, stroke width, point size,
   *  and stroke dash-offset (lower-animation.ts). */
  animatable: boolean
  appliesTo: UtilityAppliesTo
}

/** Helper to keep the table below terse and aligned. */
function def(
  prefix: string,
  match: UtilityMatch,
  valueKind: UtilityValueKind,
  unit: UtilityUnit,
  animatable: boolean,
  appliesTo: UtilityAppliesTo,
): UtilityDef {
  return { prefix, match, valueKind, unit, animatable, appliesTo }
}

// ═══ THE TABLE ═══
// Mirrors the handler arms in lower-bindings-fill/-line/-paint.ts,
// lower-animation.ts and utility-resolver.ts. Longest-match makes the LISTED
// ORDER irrelevant; it is grouped by family only for reading.
export const UTILITY_REGISTRY: readonly UtilityDef[] = [
  // ── fill ──
  def('fill', 'exact', 'expr', null, true, 'paint'), // binding base: fill-[expr]
  def('fill-translate-x-', 'prefix', 'number', 'px', false, 'paint'),
  def('fill-translate-y-', 'prefix', 'number', 'px', false, 'paint'),
  def('fill-translate-anchor-map', 'exact', 'boolean', null, false, 'paint'),
  def('fill-antialias-false', 'exact', 'boolean', null, false, 'paint'),
  def('fill-extrusion-vertical-gradient-false', 'exact', 'boolean', null, false, 'paint'),
  def('fill-extrusion-height-', 'prefix', 'number', 'm', false, 'paint'),
  def('fill-extrusion-base-', 'prefix', 'number', 'm', false, 'paint'),
  def('fill-pattern-', 'prefix', 'string', null, false, 'paint'),
  def('fill-', 'prefix', 'color', null, true, 'paint'), // generic fill colour

  // ── circle ──
  def('circle-translate-x-', 'prefix', 'number', 'px', false, 'paint'),
  def('circle-translate-y-', 'prefix', 'number', 'px', false, 'paint'),
  def('circle-blur-', 'prefix', 'number', null, false, 'paint'),
  def('circle-pitch-scale-map', 'exact', 'boolean', null, false, 'paint'),

  // ── heatmap (heatmap-opacity- is a RAW float, distinct from opacity-) ──
  def('heatmap', 'exact', 'boolean', null, false, 'paint'),
  def('heatmap-radius-', 'prefix', 'number', null, false, 'paint'),
  def('heatmap-weight-', 'prefix', 'number', null, false, 'paint'),
  def('heatmap-intensity-', 'prefix', 'number', null, false, 'paint'),
  def('heatmap-opacity-', 'prefix', 'number', null, false, 'paint'),

  // ── stroke / line ──
  def('stroke', 'exact', 'expr', null, true, 'paint'), // binding base: stroke-[expr]
  def('stroke-butt-cap', 'exact', 'enum', null, false, 'paint'),
  def('stroke-round-cap', 'exact', 'enum', null, false, 'paint'),
  def('stroke-square-cap', 'exact', 'enum', null, false, 'paint'),
  def('stroke-arrow-cap', 'exact', 'enum', null, false, 'paint'),
  def('stroke-miter-join', 'exact', 'enum', null, false, 'paint'),
  def('stroke-round-join', 'exact', 'enum', null, false, 'paint'),
  def('stroke-bevel-join', 'exact', 'enum', null, false, 'paint'),
  def('stroke-miterlimit-', 'prefix', 'number', null, false, 'paint'),
  def('stroke-roundlimit-', 'prefix', 'number', null, false, 'paint'),
  def('stroke-dasharray-', 'prefix', 'number', null, false, 'paint'),
  def('stroke-dashoffset-', 'prefix', 'number', 'm', true, 'paint'), // ANIMATABLE
  def('stroke-inset', 'exact', 'enum', null, false, 'paint'),
  def('stroke-outset', 'exact', 'enum', null, false, 'paint'),
  def('stroke-center', 'exact', 'enum', null, false, 'paint'),
  def('stroke-offset-right-', 'prefix', 'number', null, false, 'paint'),
  def('stroke-offset-left-', 'prefix', 'number', null, false, 'paint'),
  def('stroke-offset-', 'prefix', 'number', null, false, 'paint'),
  def('stroke-pattern-1-', 'prefix', 'composite', null, false, 'paint'),
  def('stroke-pattern-2-', 'prefix', 'composite', null, false, 'paint'),
  def('stroke-pattern-', 'prefix', 'composite', null, false, 'paint'),
  def('stroke-blur-', 'prefix', 'number', null, false, 'paint'),
  def('stroke-gap-', 'prefix', 'number', null, false, 'paint'),
  def('stroke-image-', 'prefix', 'string', null, false, 'paint'),
  def('stroke-translate-x-', 'prefix', 'number', 'px', false, 'paint'),
  def('stroke-translate-y-', 'prefix', 'number', 'px', false, 'paint'),
  def('stroke-translate-anchor-map', 'exact', 'boolean', null, false, 'paint'),
  def('stroke-', 'prefix', 'color', null, true, 'paint'), // generic: width OR colour, ANIMATABLE

  // ── opacity / size ──
  def('opacity', 'exact', 'expr', null, true, 'paint'), // binding base: opacity-[expr]
  def('opacity-', 'prefix', 'number', null, true, 'paint'), // 0..100 integer scale, ANIMATABLE
  def('size', 'exact', 'expr', null, true, 'paint'), // binding base: size-[expr]
  def('size-', 'prefix', 'number', 'px', true, 'paint'), // px default, unit suffix, ANIMATABLE

  // ── raster ──
  def('raster-brightness-min-', 'prefix', 'number', null, false, 'paint'),
  def('raster-brightness-max-', 'prefix', 'number', null, false, 'paint'),
  def('raster-hue-rotate-', 'prefix', 'number', 'deg', false, 'paint'),
  def('raster-saturation-', 'prefix', 'number', null, false, 'paint'),
  def('raster-contrast-', 'prefix', 'number', null, false, 'paint'),
  def('raster-resampling-nearest', 'exact', 'boolean', null, false, 'paint'),

  // ── projection / visibility / geometry-mode / interactivity ──
  def('projection-', 'prefix', 'enum', null, false, 'paint'),
  def('hidden', 'exact', 'boolean', null, false, 'paint'),
  def('visible', 'exact', 'boolean', null, false, 'paint'),
  def('flat', 'exact', 'boolean', null, false, 'paint'),
  def('billboard', 'exact', 'boolean', null, false, 'paint'),
  def('anchor-center', 'exact', 'enum', null, false, 'paint'),
  def('anchor-bottom', 'exact', 'enum', null, false, 'paint'),
  def('anchor-top', 'exact', 'enum', null, false, 'paint'),
  def('shape', 'exact', 'expr', null, false, 'paint'), // binding base: shape-[expr]
  def('shape-', 'prefix', 'string', null, false, 'paint'),
  def('pointer-events-none', 'exact', 'enum', null, false, 'paint'),
  def('pointer-events-auto', 'exact', 'enum', null, false, 'paint'),

  // ── animation (sub-grammar: duration / delay / ease-* / infinite / <name>) ──
  def('animation-', 'prefix', 'composite', null, false, 'animation'),

  // ── label (delegated to lower-label.ts — coarse family entry) ──
  def('label', 'exact', 'expr', null, false, 'label'),
  def('label-', 'prefix', 'composite', null, false, 'label'),
]

/**
 * Classify a utility NAME against the registry by LONGEST prefix — so
 * `stroke-dashoffset-5` resolves to `stroke-dashoffset-` (not `stroke-`) and
 * the lookup is independent of the table's declaration order.
 *
 * @returns the matching {@link UtilityDef}, or `undefined` if the name matches
 *   no known prefix (an unknown utility).
 */
export function classifyUtility(name: string): UtilityDef | undefined {
  let best: UtilityDef | undefined
  let bestLen = -1
  for (const d of UTILITY_REGISTRY) {
    const hit = d.match === 'exact' ? name === d.prefix : name.startsWith(d.prefix)
    if (hit && d.prefix.length > bestLen) {
      best = d
      bestLen = d.prefix.length
    }
  }
  return best
}

/** True iff `name` matches any known utility prefix. */
export function isKnownUtility(name: string): boolean {
  return classifyUtility(name) !== undefined
}

// Distinct first hyphen-segments across every registry prefix — the alphabet
// `suggestUtility` matches an unknown name's head against. Each segment maps to
// ONE representative suggestion: the shortest PREFIX-match root for that family
// (so `colr-…` → `fill-`, not `fill-extrusion-height-`), falling back to a bare
// exact utility when the family has no prefix form (`visible`, `anchor-center`).
const FIRST_SEGMENTS: { seg: string; prefix: string }[] = (() => {
  const seen = new Map<string, UtilityDef>()
  for (const d of UTILITY_REGISTRY) {
    const seg = d.prefix.split('-')[0]!
    const cur = seen.get(seg)
    if (cur === undefined) {
      seen.set(seg, d)
      continue
    }
    const better =
      (d.match === 'prefix' && cur.match !== 'prefix') ||
      (d.match === 'prefix' && cur.match === 'prefix' && d.prefix.length < cur.prefix.length)
    if (better) seen.set(seg, d)
  }
  return [...seen.entries()].map(([seg, d]) => ({ seg, prefix: d.prefix }))
})()

/** Levenshtein edit distance (small strings — the utility heads). */
function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  let cur = new Array<number>(n + 1)
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[n]
}

/**
 * Best-effort "did you mean …?" for an unknown utility: the known family
 * prefix whose head is the nearest edit-distance match to the unknown name's
 * head. `opacty-50` → `opacity-`, `colr-red` → `fill-`. Returns `undefined`
 * when nothing is close enough (distance > 3) so the diagnostic can omit help
 * rather than suggest nonsense.
 */
export function suggestUtility(name: string): string | undefined {
  const head = name.split('-')[0] ?? name
  let best: string | undefined
  let bestD = Infinity
  for (const { seg, prefix } of FIRST_SEGMENTS) {
    const d = editDistance(head, seg)
    if (d < bestD) {
      bestD = d
      best = prefix
    }
  }
  return bestD <= 3 ? best : undefined
}
