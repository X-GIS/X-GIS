import type { FuncDecl, Stmt } from '../ir/nodes'

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
