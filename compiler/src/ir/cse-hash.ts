// ═══════════════════════════════════════════════════════════════════
// AST expression canonical hashing (P0 Step 3 — CSE foundation)
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 0 component (wild-finding-starlight). Provides a stable,
// kind-aware canonical-string representation of an AST `Expr`. Two
// expressions produce the same string iff they're STRUCTURALLY
// identical — same kinds at every nesting level, same payloads,
// same child order.
//
// Use cases:
//
//   - CSE (common subexpression elimination): a later pass walks the
//     IR's `paintShapes.*` AST, builds a `Map<canonicalKey, sharedNodeId>`,
//     and routes duplicate `get(.class)` / `match(.type, …)` expressions
//     in fill + stroke to the same compute-pass output slot. Without
//     CSE, P4's compute material evaluator runs the same per-feature
//     kernel twice for fill and stroke of the same field.
//
//   - Variant cache key disambiguation: shader-gen already builds a
//     `matchArmsKey` for compound layers (see commit ba348aa); the
//     canonical-string mechanism here is a generalisation — any two
//     compound layers whose match() arms differ by one branch get
//     distinct cache keys without a hand-rolled per-AST-shape
//     comparison.
//
//   - Test invariants: assert IR transformations preserve / collapse
//     expression structure as expected (e.g. const-fold of
//     `rgb(255, 0, 0)` produces a canonical string matching
//     `C(#ff0000)`).
//
// Why a string (vs a 32-bit hash)?
//
//   - Exact equality FOR FREE. A 32-bit FNV-1a would still need a
//     deep structural walk on collision to confirm equality — the
//     string IS that walk's output.
//   - Strings are interpretable: `canonicalExpr({…})` in a debugger
//     prints something readable instead of an opaque integer.
//   - Memory cost is negligible for paint expressions (typical
//     match() with N arms produces a string ≤ 256 chars).
//
// What this module does NOT do:
//
//   - The CSE pass itself. That walks an IR + builds the dedup map.
//     This file just exports the key generator.
//   - Hash-table memoisation. Callers cache strings + lookup as
//     needed.

import type {
  Expr, MatchBlock,
  ArrayAccess, ArrayLiteral, ObjectLiteral, BinaryExpr, BoolLiteral, ColorLiteral,
  ConditionalExpr, FieldAccess, FnCall, Identifier, NumberLiteral,
  PipeExpr, StringLiteral, UnaryExpr,
} from '../parser/ast'

/** Canonical string for one AST expression. Recursive; child
 *  expressions are inlined into the parent string with discriminators
 *  so two kinds whose payloads happen to collide as strings still
 *  hash apart. Format: `<TAG>(<payload>)`. */
export function canonicalExpr(expr: Expr): string {
  switch (expr.kind) {
    case 'NumberLiteral': return canonicalNumber(expr)
    case 'StringLiteral': return canonicalString(expr)
    case 'ColorLiteral':  return `C(${(expr as ColorLiteral).value})`
    case 'BoolLiteral':   return `B(${(expr as BoolLiteral).value ? '1' : '0'})`
    case 'Identifier':    return `I(${(expr as Identifier).name})`
    case 'FieldAccess':   return canonicalField(expr)
    case 'FnCall':        return canonicalFnCall(expr)
    case 'BinaryExpr':    return canonicalBinary(expr)
    case 'UnaryExpr':     return canonicalUnary(expr)
    case 'PipeExpr':      return canonicalPipe(expr)
    case 'ConditionalExpr': return canonicalConditional(expr)
    case 'ArrayLiteral':  return canonicalArrayLit(expr)
    case 'ObjectLiteral': return canonicalObjectLit(expr)
    case 'ArrayAccess':   return canonicalArrayAccess(expr)
    case 'MatchBlock':    return canonicalMatchBlock(expr)
  }
}

function canonicalNumber(n: NumberLiteral): string {
  // Numbers get full precision — different f64 values must hash
  // apart even if they round to the same printed form. Number's
  // toString gives the shortest round-trip representation.
  return `N(${n.value}${n.unit ? `:${n.unit}` : ''})`
}

function canonicalString(s: StringLiteral): string {
  // JSON.stringify quotes + escapes embedded quotes / backslashes
  // so two strings like `a"b` and `a` can't collide via raw concat.
  return `S(${JSON.stringify(s.value)})`
}

function canonicalField(f: FieldAccess): string {
  const obj = f.object ? canonicalExpr(f.object) : '~'
  return `F(${f.field};${obj})`
}

function canonicalFnCall(c: FnCall): string {
  const callee = canonicalExpr(c.callee)
  const args = c.args.map(canonicalExpr).join(',')
  const matchBlock = c.matchBlock ? canonicalMatchBlock(c.matchBlock) : '~'
  return `Fn(${callee};[${args}];${matchBlock})`
}

function canonicalBinary(b: BinaryExpr): string {
  return `Bin(${b.op};${canonicalExpr(b.left)};${canonicalExpr(b.right)})`
}

function canonicalUnary(u: UnaryExpr): string {
  return `Un(${u.op};${canonicalExpr(u.operand)})`
}

function canonicalPipe(p: PipeExpr): string {
  const input = canonicalExpr(p.input)
  const transforms = p.transforms.map(canonicalExpr).join(',')
  return `Pipe(${input};[${transforms}])`
}

function canonicalConditional(c: ConditionalExpr): string {
  return `Cond(${canonicalExpr(c.condition)};${canonicalExpr(c.thenExpr)};${canonicalExpr(c.elseExpr)})`
}

function canonicalArrayLit(a: ArrayLiteral): string {
  return `Arr([${a.elements.map(canonicalExpr).join(',')}])`
}

function canonicalObjectLit(o: ObjectLiteral): string {
  // Keys are JSON-quoted so a key containing `;`/`:` can't collide via
  // raw concat. ObjectLiteral only carries inline GeoJSON (`data: {...}`),
  // which never reaches the evaluator — but canonicalExpr must stay
  // exhaustive over the Expr union.
  const props = o.properties
    .map((p) => `${JSON.stringify(p.key)}:${canonicalExpr(p.value)}`)
    .join(',')
  return `Obj({${props}})`
}

function canonicalArrayAccess(a: ArrayAccess): string {
  return `Idx(${canonicalExpr(a.array)};${canonicalExpr(a.index)})`
}

function canonicalMatchBlock(m: MatchBlock): string {
  // iter-204B — canonical arm sort when SAFE. Mapbox match() spec:
  // arms test in declared order, first-match wins. Position matters
  // ONLY when two arms share the same pattern (which Mapbox spec
  // technically forbids but partial / hand-edited styles may
  // contain) OR when `_` (default) appears mid-list and would
  // shadow later arms.
  //
  // When ALL non-default patterns are unique AND `_` (if present)
  // is at the end, arm order is irrelevant to evaluation — and
  // sorting brings two reordered-but-equivalent matches into a
  // shared canonical string → shared cseId (Phase C.1) → shared
  // compute kernel (Phase C.2). The pre-sort behaviour fell back
  // to the WGSL fingerprint cache for these cases (shader-gen sorts
  // at emit time), which works but costs an extra lower + emit per
  // axis.
  //
  // The unsafe path (duplicate non-default patterns, `_` mid-list)
  // preserves source order — same byte-stable output as pre-204B,
  // so any consumer that asserted on the old format on such inputs
  // sees no change.
  const armStrings = m.arms.map(a => `${a.pattern}->${canonicalExpr(a.value)}`)
  if (canSortArmsSafely(m)) {
    // Pull out the `_` arm if present, sort the rest alphabetically,
    // re-append the default at the tail.
    const sortable: string[] = []
    let defaultArm: string | null = null
    for (let i = 0; i < m.arms.length; i++) {
      if (m.arms[i]!.pattern === '_') defaultArm = armStrings[i]!
      else sortable.push(armStrings[i]!)
    }
    sortable.sort()
    if (defaultArm !== null) sortable.push(defaultArm)
    return `M([${sortable.join(',')}])`
  }
  return `M([${armStrings.join(',')}])`
}

/** True iff sorting non-default arms of `m` would NOT change
 *  evaluation semantics. Two conditions:
 *    1. Non-default patterns are unique (no duplicate-pattern
 *       arms where first wins).
 *    2. `_` (default) appears AT MOST ONCE and only at the LAST
 *       position. A mid-list `_` is technically invalid spec, but
 *       guard defensively — sorting it to the end would change
 *       which arms execute (the default would no longer shadow
 *       later arms).
 *  Conservative: returns false on any ambiguity. */
function canSortArmsSafely(m: MatchBlock): boolean {
  const seen = new Set<string>()
  for (let i = 0; i < m.arms.length; i++) {
    const p = m.arms[i]!.pattern
    if (p === '_') {
      if (i !== m.arms.length - 1) return false
      continue
    }
    if (seen.has(p)) return false
    seen.add(p)
  }
  return true
}

/** True when two expressions canonicalise to the same string —
 *  i.e. they're structurally identical. Convenience around
 *  `canonicalExpr(a) === canonicalExpr(b)`. */
export function exprEqual(a: Expr, b: Expr): boolean {
  return canonicalExpr(a) === canonicalExpr(b)
}
