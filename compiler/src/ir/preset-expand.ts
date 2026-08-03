// ═══ Preset expansion ═══
// Inlines `preset` utility lines into a layer's utility list. Extracted
// from lower.ts (#1536 step 1) so the parameter-substitution machinery
// (step 3) grows here without pressing lower.ts's LOC ceiling.

import type * as AST from '../parser/ast'
import type { Diagnostic } from '../diagnostics/diagnostic'
import { PRESET_ARITY } from '../diagnostics/diagnostic'
import { substituteIdentifiers } from '../expr/substitute'

/** A lowered preset: its `|` utility lines (inlined by expandPresets) + block properties
 *  (coverage paint `ramp:`/`range:`, merged onto a `style:`-referencing layer — #1272 E-②).
 *  `params` carries the declared parameter names of a parameterized preset (#1536). */
export type PresetDef = {
  utilities: AST.UtilityLine[]
  properties: AST.BlockProperty[]
  params?: string[]
}

/** A call-site preset reference: `style: glow(#f59e0b, 4)` or
 *  `apply-glow(#f59e0b, 4)`. `args` absent = the bare zero-arg form. */
export type PresetCall = { name: string; args?: AST.Expr[]; line: number }

/**
 * Resolve a `style:` preset reference into a (possibly instantiated)
 * definition. Zero-param bare references return the stored definition
 * unchanged — byte-for-byte the pre-#1536 behavior. Unknown names return
 * undefined (lower's coverage-paint path treats that as "no preset",
 * matching the old `presetMap.get(ref)` miss).
 */
export function resolveStylePreset(
  presetMap: Map<string, PresetDef>,
  call: PresetCall | undefined,
  diagnostics: Diagnostic[],
): PresetDef | undefined {
  if (!call) return undefined
  const def = presetMap.get(call.name)
  if (!def) return undefined
  return instantiatePreset(call.name, def, call.args, call.line, diagnostics)
}

/**
 * Expand preset references by inlining the preset's utility lines.
 * `styleBase` — the already-resolved `style:` preset's utility lines —
 * is inlined first as the lowest-priority base, then each `apply-<name>`
 * item inline in declaration order; the layer's own items come after
 * (override). Call-form `apply-<name>(args…)` items substitute their
 * arguments into the preset body (#1536).
 */
export function expandPresets(
  utilities: AST.UtilityLine[],
  presetMap: Map<string, PresetDef>,
  diagnostics: Diagnostic[],
  styleBase?: AST.UtilityLine[],
): AST.UtilityLine[] {
  const result: AST.UtilityLine[] = []

  // `style: <name>` — the single-preset base, inlined ahead of everything.
  if (styleBase) result.push(...styleBase)

  for (const line of utilities) {
    const expandedItems: AST.UtilityItem[] = []

    for (const item of line.items) {
      if (item.name.startsWith('apply-') && !item.modifier) {
        const presetName = item.name.slice(6)
        const preset = presetMap.get(presetName)
        if (preset) {
          // Inline preset lines before current line's remaining items
          const inst = instantiatePreset(presetName, preset, item.args, line.line, diagnostics)
          result.push(...inst.utilities)
        } else {
          // Unknown preset name: keep the item so the unknown-utility
          // gate (X-GIS0013) reports it — the pre-#1536 behavior.
          expandedItems.push(item)
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

/**
 * Instantiate one preset reference. The zero-param bare form returns the
 * stored definition as-is (shared nodes — the pre-#1536 fast path); any
 * parameterized form deep-clones the body with call arguments substituted
 * for the declared parameter names. Arity mismatches are X-GIS0014 errors
 * at the call-site line; the definition is then inlined unsubstituted so
 * downstream lowering stays total.
 */
function instantiatePreset(
  name: string,
  def: PresetDef,
  args: AST.Expr[] | undefined,
  callLine: number,
  diagnostics: Diagnostic[],
): PresetDef {
  const params = def.params ?? []

  if (params.length === 0) {
    if (args && args.length > 0) {
      diagnostics.push(
        arityError(
          callLine,
          `Preset \`${name}\` takes no parameters, but ${args.length} argument` +
            `${args.length === 1 ? ' was' : 's were'} passed.`,
          `Declare parameters on the preset (\`preset ${name}(a, …) { … }\`) or drop the arguments.`,
        ),
      )
    }
    return def
  }

  if (!args || args.length !== params.length) {
    const got = args?.length ?? 0
    diagnostics.push(
      arityError(
        callLine,
        `Preset \`${name}\` expects ${params.length} argument${params.length === 1 ? '' : 's'} ` +
          `(${params.join(', ')}), but got ${got}.`,
        `Call it as \`${name}(${params.join(', ')})\`.`,
      ),
    )
    return def
  }

  const bindings = new Map<string, AST.Expr>()
  params.forEach((p, i) => bindings.set(p, args[i]!))

  return {
    utilities: def.utilities.map((l) => substituteUtilityLine(l, bindings)),
    properties: def.properties.map((p) => ({
      ...p,
      value: substituteIdentifiers(p.value, bindings),
    })),
  }
}

function substituteUtilityLine(
  line: AST.UtilityLine,
  bindings: ReadonlyMap<string, AST.Expr>,
): AST.UtilityLine {
  return {
    ...line,
    items: line.items.map((item) => ({
      ...item,
      binding: item.binding ? substituteIdentifiers(item.binding, bindings) : null,
      ...(item.args ? { args: item.args.map((a) => substituteIdentifiers(a, bindings)) } : {}),
    })),
  }
}

function arityError(line: number, message: string, help: string): Diagnostic {
  return { code: PRESET_ARITY, severity: 'error', span: { line, col: 1 }, message, help }
}
