// ═══ Checked field access against a source schema (#1537) ═══
//
// `.speeed` — one letter off — evaluates to `null` today and flows on
// through coercion, so the map renders plausible-but-wrong output and the
// only person who notices is whoever stares at it. The same failure shape
// the #1066 unknown-function work closed for CALLEES; this closes it for
// FIELDS, for the sources that opt in:
//
//   struct Track { speed: f32, heading: f32, name: string }
//   source ais { type: geojson, url: "ais.geojson", schema: Track }
//
// OPT-IN by construction: a source with no `schema:` keeps fully dynamic
// access, so no existing style changes meaning. A layer is checked only
// when its source names a struct.

import type * as AST from '../parser/ast'
import type { Diagnostic } from '../diagnostics/diagnostic'
import { UNKNOWN_SCHEMA_FIELD } from '../diagnostics/diagnostic'
import {
  CAMERA_ZOOM_KEY,
  CAMERA_PITCH_KEY,
  FEATURE_ID_KEY,
  GEOMETRY_TYPE_KEY,
  GEOMETRY_KEY,
} from '../eval/reserved-keys'

/** The `$`-sigil keys the evaluator injects — never feature properties,
 *  so a schema never has to declare them. Derived from the reserved-keys
 *  authority, not re-listed. */
const RESERVED_EVAL_KEYS: ReadonlySet<string> = new Set([
  CAMERA_ZOOM_KEY,
  CAMERA_PITCH_KEY,
  FEATURE_ID_KEY,
  GEOMETRY_TYPE_KEY,
  GEOMETRY_KEY,
])

/**
 * Check every `.field` access in a schema-annotated layer against its
 * source's declared fields, pushing `X-GIS0019` for each unknown name.
 * Also reports a `schema:` that names no declared struct.
 */
export function validateSchemaFields(program: AST.Program, diagnostics: Diagnostic[]): void {
  const structs = new Map<string, Set<string>>()
  for (const s of program.body) {
    if (s.kind === 'StructStatement') {
      structs.set(s.name, new Set(s.fields.map((f) => f.name)))
    }
  }

  // source name → declared schema name (only sources that opt in).
  const sourceSchema = new Map<string, { schema: string; line: number }>()
  for (const s of program.body) {
    if (s.kind !== 'SourceStatement') continue
    const prop = s.properties.find((p) => p.name === 'schema')
    if (!prop || prop.value.kind !== 'Identifier') continue
    sourceSchema.set(s.name, { schema: prop.value.name, line: prop.line })
    if (!structs.has(prop.value.name)) {
      diagnostics.push({
        code: UNKNOWN_SCHEMA_FIELD,
        severity: 'error',
        span: { line: prop.line, col: 1 },
        message: `Source "${s.name}" declares unknown schema \`${prop.value.name}\`.`,
        help:
          structs.size > 0
            ? `Declared structs: ${[...structs.keys()].map((k) => `\`${k}\``).join(', ')}.`
            : `Declare it with \`struct ${prop.value.name} { … }\`.`,
      })
    }
  }
  if (sourceSchema.size === 0) return

  for (const s of program.body) {
    if (s.kind !== 'LayerStatement') continue
    const srcProp = s.properties.find((p) => p.name === 'source')
    if (!srcProp || srcProp.value.kind !== 'Identifier') continue
    const ref = sourceSchema.get(srcProp.value.name)
    const fields = ref && structs.get(ref.schema)
    if (!fields) continue

    const check = (expr: AST.Expr, line: number): void =>
      walkFields(expr, (field) => {
        if (fields.has(field) || RESERVED_EVAL_KEYS.has(field)) return
        diagnostics.push({
          code: UNKNOWN_SCHEMA_FIELD,
          severity: 'error',
          span: { line, col: 1 },
          message:
            `Layer "${s.name}" reads \`.${field}\`, which schema \`${ref.schema}\` ` +
            `does not declare.`,
          help: nearest(field, fields)
            ? `Did you mean \`.${nearest(field, fields)}\`?`
            : `Declared fields: ${[...fields].map((f) => `\`${f}\``).join(', ')}.`,
        })
      })

    for (const p of s.properties) check(p.value, p.line)
    for (const line of s.utilities) {
      for (const item of line.items) {
        if (item.binding) check(item.binding, line.line)
        if (item.args) for (const a of item.args) check(a, line.line)
      }
    }
  }
}

/** Visit every IMPLICIT field access (`.name`) in an expression. The
 *  explicit-object form (`vec3(…).x`, #1537 component reads) is not a
 *  feature-property read and is skipped. */
function walkFields(expr: AST.Expr, visit: (field: string) => void): void {
  switch (expr.kind) {
    case 'FieldAccess':
      if (expr.object === null) visit(expr.field)
      else walkFields(expr.object, visit)
      break
    case 'FnCall':
      for (const a of expr.args) walkFields(a, visit)
      if (expr.matchBlock) for (const arm of expr.matchBlock.arms) walkFields(arm.value, visit)
      break
    case 'BinaryExpr':
      walkFields(expr.left, visit)
      walkFields(expr.right, visit)
      break
    case 'UnaryExpr':
      walkFields(expr.operand, visit)
      break
    case 'ConditionalExpr':
      walkFields(expr.condition, visit)
      walkFields(expr.thenExpr, visit)
      walkFields(expr.elseExpr, visit)
      break
    case 'ArrayLiteral':
      for (const el of expr.elements) walkFields(el, visit)
      break
    case 'ArrayAccess':
      walkFields(expr.array, visit)
      walkFields(expr.index, visit)
      break
    case 'ObjectLiteral':
      for (const p of expr.properties) walkFields(p.value, visit)
      break
    case 'MatchBlock':
      for (const arm of expr.arms) walkFields(arm.value, visit)
      break
    // Leaf kinds carry no field access.
  }
}

/** Nearest declared field by edit distance, or null when the closest match
 *  is too far to be a plausible typo (mirrors the X-GIS0012 threshold). */
function nearest(name: string, fields: ReadonlySet<string>): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const cand of fields) {
    const d = levenshtein(name, cand)
    if (d < bestDist) {
      bestDist = d
      best = cand
    }
  }
  const threshold = name.length >= 4 ? 2 : 1
  return best !== null && bestDist <= threshold ? best : null
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1)
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[n]
}
