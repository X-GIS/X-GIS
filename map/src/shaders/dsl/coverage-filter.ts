// ═══ `filter:` on a coverage layer, compiled ONCE into shader-dsl IR (#1437) ═══
//
// THE FAILURE THIS EXISTS FOR. A coverage layer has TWO draw paths — the colour-ramp drape
// and the sounding numerals — and `filter:` reached only the second (#1407,
// dispatch-coverage-soundings.ts). `filter: .depth > 0` on a `ramp:` layer compiled cleanly
// and painted every valid cell, which is the same silent no-op the binding×source matrix was
// built to end, reproduced one level down.
//
// WHERE THE PREDICATE BELONGS. A predicate is evaluated where its OPERAND lives, because that
// is where filtering removes downstream work:
//
//   * a GeoJSON property lives in a JS object   → CPU; the feature is never uploaded.
//   * an MVT property lives in a decoded tile   → CPU; the feature is never tessellated.
//   * a band value at a SOUNDING CANDIDATE      → CPU; the candidate never enters collision.
//   * a band value at a FRAGMENT                → GPU; the LUT tap and the blend are skipped.
//
// The ramp's operand is a texel. Baking a CPU mask instead would be a full-grid pass over
// 3.5 M cells on the real NOAA Chesapeake cell, re-run on every zoom-dependent change, plus an
// upload — against a handful of ALU ops on a value the ramp already sampled into a register.
// The CPU bake is rejected, not deferred.
//
// WHY THIS IS NOT THE TWIN-DRIFT ARCHETYPE. coverage-ramp.ts warns twice, in that file, that
// "a GPU twin of the same math is this codebase's dominant bug archetype" (§12). Emitting WGSL
// here while `evalFilterTruthy` kept evaluating the same predicate on the CPU would be exactly
// that. So there is ONE compilation, to shader-dsl IR, and the two consumers are the DSL's own
// two backends: the GPU emit (WGSL + GLSL, dual-emit for free) and `compileModuleJs`
// (core/cpu-codegen.ts) under its bit-identity contract. The twin is DERIVED, not written
// twice — which is what the DSL is for.
//
// RAW UNITS, BOTH SIDES. The fragment shader holds `s' ∈ [0,1]` (values are stored
// pre-normalized — coverage-material.ts A3), so the caller denormalizes before calling this
// predicate. Rewriting the predicate's LITERALS into normalized space instead would have saved
// a uniform and created exactly the second authority this design exists to avoid: the CPU side
// evaluates on raw metres, so the GPU side must too.
//
// KNOWN DISAGREEMENT — bounded and intrinsic (do NOT chase these):
//   1. STORAGE dominates. The GPU reads the f16-quantized grid (≤2⁻¹² of range — ~7 mm over a
//      0-30 m Chesapeake range); the CPU sounding path reads the exact f32 via `valueAt`. A
//      value within that band of a threshold can be classified differently.
//   2. ARITHMETIC. `cpu-codegen.ts` states plainly that it is "NOT an f32 GPU-precision
//      oracle" — it runs the f64 op tree. ~1 ulp of f32 at a threshold.
//   3. SAMPLING. Soundings read NEAREST-cell; the ramp reads the validity-weighted BILINEAR
//      `s'`. At a cell boundary a numeral can survive where the ramp discards. That is the two
//      products differing, not the filter — which is why a differential gate must compare
//      evaluator-on-the-same-SCALAR, never evaluator-on-the-same-LOCATION.

import {
  fn,
  f32,
  bool,
  f32T,
  boolT,
  module,
  type ReadonlyNode,
  type FnHandle,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import type * as AST from '@xgis/compiler'

/** The predicate function's emitted name — the fragment shader's call site, the CPU backend's
 *  `fns` key, and what the non-vacuity gate greps the emitted source for. */
export const COVERAGE_FILTER_FN = 'cov_filter'

/** The compiled predicate: `cov_filter(v: f32, zoom: f32) -> bool`. A callable handle rather
 *  than a bare `FuncDecl` because the coverage fragment stage CALLS it — the same object is
 *  both the decl the module emits and the call the shader makes, so the two cannot disagree
 *  about the signature. */
export type CoverageFilterFn = FnHandle<{ v: typeof f32T; zoom: typeof f32T }, 'bool'>

export interface CoverageFilterProgram {
  /** The single band the predicate reads. The GPU arm binds ONE data texture, so a predicate
   *  over a band the layer does not drape cannot be served here — see the `bands.size` arms. */
  band: string
  /** Canonical s-expression of the predicate, and the pipeline cache key: two layers with the
   *  same predicate share a pipeline, two different ones cannot collide. It includes the
   *  LITERALS, so changing a threshold rebuilds the pipeline — consistent with the polygon
   *  variant path, which inlines its literals as consts (#1437 records the structure-keyed
   *  upgrade and why nothing needs it yet). */
  key: string
  /** `cov_filter(v: f32, zoom: f32) -> bool`, in RAW band units. */
  decl: CoverageFilterFn
}

export type CoverageFilterResult =
  | ({ ok: true } & CoverageFilterProgram)
  /** Carried, not thrown, so the caller decides whether an uncompilable predicate is fatal
   *  (the ramp arm, which would otherwise paint an unfiltered layer). Silence is the one
   *  outcome this type exists to remove. */
  | { ok: false; reason: string }

/** Numeric binary operators — f32 × f32 → f32. */
const ARITH = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' } as const
/** Comparison operators — f32 × f32 → bool. */
const COMPARE = { '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge', '==': 'eq', '!=': 'ne' } as const

/** A compiled sub-expression: its DSL node and its canonical text (which builds the key). */
type Compiled =
  | { type: 'f32'; node: ReadonlyNode<'f32'>; text: string }
  | { type: 'bool'; node: ReadonlyNode<'bool'>; text: string }

/** Thrown by the walk, caught at the entry point and returned as `{ ok: false }`. Never
 *  escapes this module. */
class Reject extends Error {}

/**
 * Compile a coverage layer's `filter:` AST into one shader-dsl predicate.
 *
 * The compilable subset is closed for a GRID by construction: a coverage band is numeric, so
 * numeric comparison, arithmetic and boolean combination cover every predicate a grid can
 * express. Everything outside it (a string operand, `in`, a function call, a second band) is
 * REJECTED WITH A REASON rather than waved through — a filter that compiles and does nothing
 * is the defect this path exists to close.
 *
 * `zoom` is a parameter rather than a rejected identifier because the sounding arm already
 * threads live camera zoom into its filter; leaving it out of the GPU subset would recreate
 * the very split-brain being removed, one binding down.
 */
export function compileCoverageFilter(ast: AST.Expr): CoverageFilterResult {
  const bands = new Set<string>()
  let key = ''

  const asF32 = (c: Compiled, op: string): ReadonlyNode<'f32'> => {
    if (c.type !== 'f32') throw new Reject(`\`${op}\` wants a number, got a boolean`)
    return c.node
  }
  const asBool = (c: Compiled, op: string): ReadonlyNode<'bool'> => {
    if (c.type !== 'bool') throw new Reject(`\`${op}\` wants a boolean, got a number`)
    return c.node
  }

  const walk = (e: AST.Expr, v: ReadonlyNode<'f32'>, zoom: ReadonlyNode<'f32'>): Compiled => {
    const w = (sub: AST.Expr): Compiled => walk(sub, v, zoom)
    switch (e.kind) {
      case 'NumberLiteral':
        // A unit (`20m`, `3px`) implies a conversion this predicate does not define, and a
        // band's units are whatever its product says. Rejected rather than silently dropped:
        // dropping it would compare metres against pixels and look like it worked.
        if (e.unit !== null) throw new Reject(`a unit (\`${e.unit}\`) has no meaning in a filter`)
        return { type: 'f32', node: f32(e.value), text: numText(e.value) }
      case 'BoolLiteral':
        return { type: 'bool', node: bool(e.value), text: String(e.value) }
      case 'FieldAccess': {
        if (e.object !== null) throw new Reject('only a bare `.band` reference is supported')
        bands.add(e.field)
        return { type: 'f32', node: v, text: `.${e.field}` }
      }
      case 'Identifier':
        if (e.name !== 'zoom') throw new Reject(`unknown identifier \`${e.name}\``)
        return { type: 'f32', node: zoom, text: 'zoom' }
      case 'UnaryExpr': {
        // `!` is REWRITTEN, not emitted: the DSL IR has no logical-not node, and pushing the
        // negation into the operators is total over this subset (every bool here is a
        // comparison, a literal, `&&`, `||` or another `!`) — see `negate`.
        if (e.op === '!') return w(negate(e.operand))
        const o = w(e.operand)
        if (e.op === '-') {
          return { type: 'f32', node: asF32(o, '-').neg(), text: `(- ${o.text})` }
        }
        throw new Reject(`unary \`${e.op}\``)
      }
      case 'BinaryExpr': {
        const l = w(e.left)
        const r = w(e.right)
        const text = `(${e.op} ${l.text} ${r.text})`
        if (e.op in ARITH) {
          const m = ARITH[e.op as keyof typeof ARITH]
          return { type: 'f32', node: asF32(l, e.op)[m](asF32(r, e.op)), text }
        }
        if (e.op in COMPARE) {
          const m = COMPARE[e.op as keyof typeof COMPARE]
          return { type: 'bool', node: asF32(l, e.op)[m](asF32(r, e.op)), text }
        }
        if (e.op === '&&' || e.op === '||') {
          const lb = asBool(l, e.op)
          const rb = asBool(r, e.op)
          return { type: 'bool', node: e.op === '&&' ? lb.and(rb) : lb.or(rb), text }
        }
        throw new Reject(`operator \`${e.op}\``)
      }
      default:
        throw new Reject(`\`${e.kind}\``)
    }
  }

  let decl: CoverageFilterFn
  try {
    // The walk runs INSIDE the body, where `v` / `zoom` are real parameter nodes — there is no
    // placeholder-then-rebind step, and a Reject thrown here propagates out of `fn` because the
    // body is invoked eagerly at declaration time.
    decl = fn(COVERAGE_FILTER_FN, { v: f32T, zoom: f32T }, boolT, ({ v, zoom }) => {
      const root = walk(ast, v, zoom)
      key = root.text
      if (root.type !== 'bool') {
        // A bare numeric predicate (`filter: .depth`) would need the CPU evaluator's "non-zero
        // AND finite" truthiness rule restated in WGSL — a second definition of what a filter
        // MEANS, for a form nobody writes on a grid. Reject with the comparison spelled out.
        throw new Reject('a filter must be a comparison — write `.depth > 0`, not `.depth`')
      }
      return root.node
    })
  } catch (err) {
    if (err instanceof Reject) return { ok: false, reason: err.message }
    throw err
  }

  if (bands.size === 0) {
    return { ok: false, reason: 'the filter reads no band, so it says the same thing everywhere' }
  }
  if (bands.size > 1) {
    // The GPU arm binds ONE data texture (`cov_value`). A second band needs a second binding —
    // real work, tracked in #1437 — and must not be papered over by evaluating this one filter
    // on the CPU, which is how the two paths came to disagree in the first place.
    const names = [...bands].join(', ')
    return { ok: false, reason: `reads ${bands.size} bands (${names}); one is supported` }
  }
  return { ok: true, band: [...bands][0] as string, key, decl }
}

/** Wrap a compiled predicate as a standalone module — the CPU backend's input. The GPU side
 *  splices the SAME `decl` into the coverage module, so there is one authority for both. */
export const coverageFilterModule = (program: CoverageFilterProgram): ModuleDecl =>
  module({ funcs: [program.decl] })

/** Round-trip-exact literal text, so the cache key distinguishes 20 from 20.0000001 and does
 *  not fold -0 into 0 (they compare equal but are not the same literal). */
const numText = (v: number): string => (Object.is(v, -0) ? '-0' : String(v))

/** The comparison each operator becomes under negation. Total on `COMPARE`'s domain — and it
 *  is exact rather than merely opposite because NaN never reaches the predicate: the GPU arm
 *  discards on validity before the call, and the CPU arm's candidates come from valid cells. */
const NEGATED_COMPARE: Record<string, string> = {
  '<': '>=',
  '<=': '>',
  '>': '<=',
  '>=': '<',
  '==': '!=',
  '!=': '==',
}

/**
 * Push a `!` down into the expression, because the DSL IR has no logical-not node.
 *
 * This is a REWRITE rather than a workaround: over the compilable subset every boolean is a
 * comparison, a boolean literal, `&&`, `||`, or another `!`, and each has an exact negation —
 * so the rewrite is total, and anything it cannot negate was not a boolean to begin with and
 * is rejected with the same reason the walk would have given it.
 */
function negate(e: AST.Expr): AST.Expr {
  if (e.kind === 'BoolLiteral') return { kind: 'BoolLiteral', value: !e.value }
  if (e.kind === 'UnaryExpr' && e.op === '!') return e.operand // ¬¬x = x
  if (e.kind === 'BinaryExpr') {
    const flipped = NEGATED_COMPARE[e.op]
    if (flipped) return { kind: 'BinaryExpr', op: flipped, left: e.left, right: e.right }
    // De Morgan — the negation keeps descending rather than needing a not at this level.
    if (e.op === '&&' || e.op === '||') {
      return {
        kind: 'BinaryExpr',
        op: e.op === '&&' ? '||' : '&&',
        left: negate(e.left),
        right: negate(e.right),
      }
    }
  }
  throw new Reject(`\`!\` applied to something that is not a condition (\`${e.kind}\`)`)
}
