// ═══ A per-feature colour that did not resolve says so (#1664, #1583-class) ═══
//
// The POINT (`map.ts` evalPerFeatureColor) and ARROW (`arrow-show.ts`) paints resolve a
// data-driven `fill` / `stroke` on the CPU at scene-build time and hand the runtime a baked
// RGBA. When the expression cannot be evaluated the bake falls back to the LAYER CONSTANT,
// which for a data-driven colour is `null` by construction (emit-commands' colorToHex has no
// `data-driven` case — correct, since no single hex exists) — so the dots paint fill_a = 0 and
// the arrows paint flat white. Nothing throws, nothing logs, and the author sees a layer that
// drew the wrong colour rather than one that reported a gap.
//
// #1664 closed the two expressions that were reaching that fallback in shipped styles
// (`gradient(…)`, and any palette token inside a data-driven colour). This is the other half,
// the same bargain `render/rhi-fill-gap-warning.ts` struck for the WebGL2 polygon gap (#1583):
// what remains unevaluable STAYS a fallback — painting a representative colour would misreport
// the data — but it stops being SILENT.
//
// Its own module for the same reason that one is: this is a latched, IO-performing diagnostic,
// and `feature-helpers.ts` ("pure functions … no engine state") forbids it while `map.ts` sits
// on its shrink-only LOC ceiling. Shape and latch follow `stage-block-warning.ts`, the nearest
// sibling — a per-layer Set plus an injectable sink so a test drives the message instead of
// mocking `xlog`.

import { xlog } from '@xgis/shared'

/** Layer:axis keys already reported. Module-scope and STRINGS ONLY — nothing here references a
 *  map, a renderer or a GPU resource, so a destroyed map is not pinned (#1567). */
const warned = new Set<string>()

/** Report, at most once per layer per axis, that a data-driven colour expression produced no
 *  colour for a feature and the paint fell back.
 *
 *  Latched because the caller runs once per FEATURE per scene rebuild: unlatched, a 50k-feature
 *  source would emit 50k identical lines and scroll the message away, which for the author it is
 *  written for is the same as silence. Keyed per layer AND axis — a layer whose fill and stroke
 *  both fail has two problems.
 *
 *  `value` is whatever the evaluator produced: the thrown Error for an unknown callee, or the
 *  non-string result (a number, null) for an expression that evaluated but not to a colour. It is
 *  the single most diagnostic thing available, so it goes in the message verbatim. */
export function warnPerFeatureColorUnresolved(
  layer: string,
  axis: 'fill' | 'stroke',
  value: unknown,
  sink: (msg: string) => void = xlog.warn,
): void {
  const key = `${axis}:${layer}`
  if (warned.has(key)) return
  warned.add(key)
  const detail = value instanceof Error ? value.message : `evaluated to ${JSON.stringify(value)}`
  sink(
    `[X-GIS] layer "${layer}": its per-feature ${axis} expression produced no colour (${detail}), ` +
      `so the point/arrow paint fell back to the layer constant — which a data-driven ${axis} ` +
      `does not have, leaving the feature uncoloured (#1664). Use a colour form the evaluator ` +
      `resolves (\`gradient(…)\`, \`match(…)\` over hex or palette tokens) or a constant ${axis}.`,
  )
}

/** Drop the latch — tests only, so one case's warning cannot silence the next one's. */
export function resetPerFeatureColorWarnings(): void {
  warned.clear()
}
