// ═══ Shader DSL — the f32 oracle mode (#2426, direction record D2.2) ═══
//
// The CPU oracle evaluates in f64 and says so (oracle.ts:20-38). That is the right default —
// it is the ALGEBRA oracle, the reference an implementation is checked against — but it means
// every GPU parity gate has to carry a tolerance wide enough to absorb f32 rounding, and a
// tolerance that wide cannot tell a real algorithmic error from the target's own precision.
//
// This pass makes the SAME IR evaluate as a correctly-rounding f32 machine: every f32-typed
// expression that computes a value is wrapped in `__fround`, so the f64 tree-walk rounds after
// each operation exactly as the GPU does. Overflow to ±Infinity comes for free from
// `Math.fround`.
//
// It runs on the CPU engines only — `compileModule(m, { precision: 'f32' })` and its codegen
// twin — and never before a WGSL/GLSL writer, which would reject `__fround` as unknown.

import type { Expr, ModuleDecl, ShaderType } from '../ir/index.js'
import { mapModuleExprs } from './opt/ir-transform.js'

/** f32 scalar or a vector of f32 — the values the GPU rounds and the host does not. */
const isF32ish = (t: ShaderType): boolean =>
  (t.kind === 'scalar' && t.scalar === 'f32') || (t.kind === 'vec' && t.elem === 'f32')

/** The forms that COMPUTE an f32 value, and therefore need rounding after the fact.
 *
 *  What is missing from this list matters more than what is in it. `varref`, `member` and
 *  `index` all read STORAGE, and storage only ever receives an already-rounded value, because
 *  every `let` initialiser, `var` initialiser and assignment right-hand side is itself one of
 *  the forms below. Rounding a read would be redundant — and worse than redundant: `mapStmt`
 *  rewrites assignment TARGETS too (ir-transform.ts), so wrapping those three would produce
 *  `__fround(x) = …`, which is not an lvalue. None of the forms here can appear as a target
 *  (a parameter cannot: the `ReadonlyNode` contract makes `p.x.assign(…)` a tsc error), so the
 *  rule needs no special case for assignment.
 *
 *  `lit` and `param` are the two the seven copy-pasted `froundWrap`s this pass replaces all
 *  missed: an f32 parameter arrives from JS as an f64 double, and an f32 literal need not be
 *  representable in f32. */
const COMPUTES_VALUE = new Set([
  'binop',
  'unop',
  'call',
  'select',
  'construct',
  'matchExpr',
  'lit',
  'param',
  'constref',
  'overrideref',
])

/** Rewrite `m` so its f32 arithmetic rounds to f32 after every operation. Idempotent. */
export function froundF32(m: ModuleDecl): ModuleDecl {
  return mapModuleExprs(m, (e: Expr): Expr => {
    // `mapExpr` rewrites BOTTOM-UP, so on a second application an existing wrapper's argument
    // is re-wrapped before the wrapper itself is seen. Collapsing `__fround(__fround(x))` here
    // — where the inner one has just been re-created — is what makes the pass exactly
    // idempotent instead of merely value-idempotent (fround(fround(x)) === fround(x), but an
    // IR that grows on every application is a footgun).
    if (e.op === 'call' && e.fn === '__fround') {
      const inner = e.args[0]
      return inner !== undefined && inner.op === 'call' && inner.fn === '__fround' ? inner : e
    }
    if (!isF32ish(e.type) || !COMPUTES_VALUE.has(e.op)) return e
    return { op: 'call', type: e.type, fn: '__fround', args: [e] }
  })
}
