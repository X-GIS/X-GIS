// ═══ Preset expansion ═══
// Inlines `preset` utility lines into a layer's utility list. Extracted
// verbatim from lower.ts (#1536 step 1) so the parameter-substitution
// machinery can grow here without pressing lower.ts's LOC ceiling.

import type * as AST from '../parser/ast'

/** A lowered preset: its `|` utility lines (inlined by expandPresets) + block properties
 *  (coverage paint `ramp:`/`range:`, merged onto a `style:`-referencing layer — #1272 E-②). */
export type PresetDef = { utilities: AST.UtilityLine[]; properties: AST.BlockProperty[] }

/**
 * Expand preset references by inlining the preset's utility lines.
 * A leading `style: <name>` reference (styleRef) is inlined first as
 * the lowest-priority base, then each `apply-<name>` item inline in
 * declaration order; the layer's own items come after (override).
 */
export function expandPresets(
  utilities: AST.UtilityLine[],
  presetMap: Map<string, PresetDef>,
  styleRef?: string,
): AST.UtilityLine[] {
  const result: AST.UtilityLine[] = []

  // `style: <name>` — the single-preset base, inlined ahead of everything.
  if (styleRef) {
    const base = presetMap.get(styleRef)
    if (base) result.push(...base.utilities)
  }

  for (const line of utilities) {
    const expandedItems: AST.UtilityItem[] = []

    for (const item of line.items) {
      if (item.name.startsWith('apply-') && !item.modifier) {
        const presetName = item.name.slice(6)
        const preset = presetMap.get(presetName)
        if (preset) {
          // Inline preset lines before current line's remaining items
          result.push(...preset.utilities)
        }
      } else {
        expandedItems.push(item)
      }
    }

    if (expandedItems.length > 0) {
      result.push({ kind: 'UtilityLine', items: expandedItems, line: line.line })
    }
  }

  return result
}
