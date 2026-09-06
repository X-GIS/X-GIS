// ═══ Preset expansion ═══
// Inlines `preset` utility lines into a layer's utility list. Extracted
// from lower.ts (#1536 step 1) so the parameter-substitution machinery
// (step 3) grows here without pressing lower.ts's LOC ceiling.

import type * as AST from '../parser/ast'
import type { Diagnostic } from '../diagnostics/diagnostic'
import { PRESET_ARITY, UNKNOWN_STYLE_PRESET } from '../diagnostics/diagnostic'
import { substituteIdentifiers } from '../expr/substitute'
import { nearestByEditDistance } from './edit-distance'

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

/** Extract a preset reference NAME from a `style:` property value: a bare
 *  identifier (`style: glow`) or a namespaced field access (`style: ns.glow`
 *  — the splice-rename target `module/resolver.ts`'s `applyNamespace` produces,
 *  literally naming the preset `"ns.glow"` in presetMap). Returns null for any
 *  other expression shape — the existing block-property convention (an
 *  unrecognised shape is silently skipped, not a distinct error; #1606). */
export function presetRefName(expr: AST.Expr): string | null {
  if (expr.kind === 'Identifier') return expr.name
  if (expr.kind === 'FieldAccess' && expr.object?.kind === 'Identifier') {
    return `${expr.object.name}.${expr.field}`
  }
  return null
}

/**
 * Resolve a `style:` preset reference into a (possibly instantiated)
 * definition. Zero-param bare references return the stored definition
 * unchanged — byte-for-byte the pre-#1536 behavior. An unknown name is an
 * X-GIS0027 error (#1606) — a `style:` that names nothing must not compile
 * clean into a silently blank layer.
 */
export function resolveStylePreset(
  presetMap: Map<string, PresetDef>,
  call: PresetCall | undefined,
  diagnostics: Diagnostic[],
): PresetDef | undefined {
  if (!call) return undefined
  const def = presetMap.get(call.name)
  if (!def) {
    const near = nearestPresetName(call.name, presetMap)
    diagnostics.push({
      code: UNKNOWN_STYLE_PRESET,
      severity: 'error',
      span: { line: call.line, col: 1 },
      message: `\`style: ${call.name}\` does not match any declared preset.`,
      ...(near ? { help: `Did you mean \`${near}\`?` } : {}),
    })
    return undefined
  }
  return instantiatePreset(call.name, def, call.args, call.line, diagnostics)
}

/** Nearest declared preset name by edit distance, or null when too far to be
 *  a plausible typo. Keeps this site's own threshold, which is looser than the
 *  X-GIS0012 sites' and scales with the name length rather than stepping at 4. */
function nearestPresetName(name: string, presetMap: Map<string, PresetDef>): string | null {
  return nearestByEditDistance(name, presetMap.keys(), Math.max(2, Math.ceil(name.length / 3)))
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
