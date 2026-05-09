// ═══════════════════════════════════════════════════════════════════
// Text Resolver (Batch 1c-8a)
// ═══════════════════════════════════════════════════════════════════
//
// Closes the loop between IR and the rendered string. Given a
// `TextValue` from a layer's `LabelDef.text` and a feature's
// property bag, returns the display string the GlyphAtlasHost
// rasterises.
//
// Two branches mirror the IR:
//   - `kind: 'expr'`     → evaluate(ast, props) → String(value)
//   - `kind: 'template'` → fold each part:
//        literal → its text
//        interp  → evaluate(ast, props) → formatValue(value, spec)
//      then concat
//
// Falls back gracefully on missing fields / evaluation errors so
// a single bad feature doesn't crash an entire frame's labels.

import { evaluate, formatValue, type TextValue } from '@xgis/compiler'

export type FeatureProps = Record<string, unknown>

/** Resolve a TextValue against a feature's property bag.
 *  Returns the empty string when the value is null/undefined to
 *  match Mapbox's `text-field: null` skip semantics — caller
 *  treats the empty string as "don't render". */
export function resolveText(value: TextValue, props: FeatureProps): string {
  if (value.kind === 'expr') {
    const v = safeEval(value.expr.ast, props)
    if (v === null || v === undefined) return ''
    return String(v)
  }
  // template
  let out = ''
  for (const part of value.parts) {
    if (part.kind === 'literal') {
      out += part.value
      continue
    }
    const v = safeEval(part.expr.ast, props)
    out += formatValue(v, part.spec)
  }
  return out
}

/** Wrap evaluate() so an expression that throws (missing field on
 *  a typed evaluator, divide-by-zero, unknown function) doesn't
 *  blow up the whole label render pass. */
function safeEval(ast: unknown, props: FeatureProps): unknown {
  try {
    return evaluate(ast as never, props)
  } catch {
    return undefined
  }
}
