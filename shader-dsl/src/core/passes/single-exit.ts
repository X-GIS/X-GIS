import type { Expr, FuncDecl, Stmt } from '../ir/nodes.js'

// MISRA-C Rule 15.5 style — a function has a SINGLE point of exit: exactly one
// `return`, as the final statement (no early returns nested in control flow). On
// the GPU this also nudges toward branchless `select()`, which avoids SIMD
// divergence. Kept OFF the runtime emit-validate path (an over-eager return rule
// there once broke real rendering — see the OPACITY incident); run it as a lint
// over authored fns instead.

const countReturns = (stmts: readonly Stmt[]): number => {
  let n = 0
  for (const s of stmts) {
    if (s.s === 'return') n++
    else if (s.s === 'if') {
      for (const a of s.arms) n += countReturns(a.body)
      if (s.elseBody) n += countReturns(s.elseBody)
    } else if (s.s === 'for') n += countReturns(s.body)
    else if (s.s === 'switch') {
      for (const c of s.cases) n += countReturns(c.body)
      if (s.defaultBody) n += countReturns(s.defaultBody)
    }
  }
  return n
}

const hasInjection = (stmts: readonly Stmt[]): boolean =>
  stmts.some(
    (s) =>
      s.s === 'raw' ||
      s.s === 'placeholder' ||
      (s.s === 'if' &&
        (s.arms.some((a) => hasInjection(a.body)) ||
          (s.elseBody ? hasInjection(s.elseBody) : false))) ||
      (s.s === 'for' && hasInjection(s.body)) ||
      (s.s === 'switch' &&
        (s.cases.some((c) => hasInjection(c.body)) ||
          (s.defaultBody ? hasInjection(s.defaultBody) : false))),
  )

/** Single-exit violations for one fn — `[]` when compliant. A value fn must have
 *  exactly one return and it must be the last top-level statement; a void/compute
 *  fn (zero returns) is compliant. A fn carrying a raw/placeholder Stmt is a
 *  composer-injected variant (the polygon fill/stroke return arrives at compose
 *  time) — skipped, exactly as RULE c does. */
export function checkSingleExit(f: FuncDecl): string[] {
  if (f.allowEarlyReturn) return [] // documented MISRA deviation
  if (hasInjection(f.body)) return []
  const total = countReturns(f.body)
  const errs: string[] = []
  if (total > 1) {
    errs.push(
      `fn '${f.name}': single-exit allows ONE return, found ${total} — refactor early returns to select() or a result var`,
    )
  } else if (total === 1) {
    const last = f.body[f.body.length - 1]
    if (!last || last.s !== 'return') {
      errs.push(`fn '${f.name}': the return must be the FINAL statement (no early return)`)
    }
  }
  return errs
}

/** The single-exit SHAPE of a body, for a consumer that must SPELL it rather than
 *  judge it: the statements ahead of the one trailing `return`, plus that return's
 *  expression (absent when the body never returns a value). `undefined` when the
 *  body is not that shape — more than one return anywhere, a return that is not the
 *  final top-level statement, or a `raw`/`placeholder` Stmt, whose opaque text can
 *  carry a `return` this walk cannot see.
 *
 *  Deliberately NOT `checkSingleExit`, which is the LINT face and which a documented
 *  `allowEarlyReturn` deviation waives: a waiver is a statement about style, and it
 *  does not make an early return spellable somewhere a `return` cannot carry a value.
 *  Both faces read the same `countReturns`/`hasInjection`, so they cannot drift on
 *  what counts as a return.
 *
 *  Consumer: the GLSL backend (#1858), which emits such an entry body directly inside
 *  `void main()` — the single exit becomes main's output scatter — instead of wrapping
 *  it in a `<name>_impl` fn that `main()` then calls exactly once. */
export function singleExitBody(
  body: readonly Stmt[],
): { prelude: readonly Stmt[]; ret?: Expr } | undefined {
  if (hasInjection(body)) return undefined
  const total = countReturns(body)
  if (total === 0) return { prelude: body }
  if (total > 1) return undefined
  const last = body[body.length - 1]
  if (last?.s !== 'return') return undefined
  return { prelude: body.slice(0, -1), ...(last.expr !== undefined ? { ret: last.expr } : {}) }
}
