// ═══ #1605 Phase 0 — the silent half of "no point/line fragment seam" ═══
//
// A `@color`/`@stroke` stage block (#1538) compiles cleanly on ANY layer —
// the AST/IR/X-GIS0020 check are geometry-kind-agnostic — but only the
// polygon fill/stroke path ever reads `show.shaderVariant`. Point and line
// rendering silently paint the flat fallback instead. This is a runtime-only
// check (not a compiler diagnostic) because one layer's source can mix
// Point/LineString/Polygon features, so whether the stage block is "wrong"
// depends on which renderer actually receives features, not on any static
// property of the layer declaration.

import { xlog } from '@xgis/shared'

const warned = new Set<string>()

/** One-time-per-layer dev warning that a stage block on `layerName` is being
 *  silently dropped by `kind` rendering (#1605). Call at the point a layer's
 *  features are actually handed to the point/line renderer. `sink` is
 *  injectable for tests — mirrors `checkPatternParams`'s callback shape
 *  (`line-pattern-guards.ts`) rather than mocking `xlog` directly. */
export function warnStageBlockUnsupported(
  layerName: string,
  kind: 'point' | 'line',
  hasStageExpr: boolean,
  sink: (msg: string) => void = xlog.warn,
): void {
  if (!hasStageExpr) return
  const key = `${kind}:${layerName}`
  if (warned.has(key)) return
  warned.add(key)
  sink(
    `[X-GIS] layer "${layerName}" declares a @color/@stroke stage block, but ${kind} ` +
      `rendering does not consume it yet (#1605) — painting the flat fallback instead.`,
  )
}
