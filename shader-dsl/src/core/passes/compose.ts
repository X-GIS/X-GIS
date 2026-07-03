// ═══ Shader DSL — module composition (placeholder swap) ═══
//
// A first-class, VALIDATED replacement for the per-shader hand-rolled placeholder-swap walk
// (the polygon composer). A base module lays down `placeholder(tag)` Stmts at its variation
// seams; `composeModule(base, swaps)` replaces each with the swap's Stmt list — descending into
// if / for / switch bodies so a placeholder may sit in a nested scope.
//
// The DX win over the bespoke walk is VALIDATION (strict by default): an un-swapped placeholder
// is the silent-on-GPU (`// __placeholder`) / throws-on-CPU footgun, and a typo'd swap key
// silently no-ops — both are now a loud error at compose time instead. Pure: returns a new module.

import type { ModuleDecl, Stmt, FuncDecl } from '../ir'

export interface ComposeOptions {
  /** Allow a placeholder with no matching swap to survive (emits `// __placeholder: <tag>` on the
   *  WGSL side; throws on the CPU oracle). Off by default — an un-swapped placeholder is an error. */
  readonly allowUnswapped?: boolean
}

/** Replace every `placeholder(tag)` Stmt in `stmts` with `swaps[tag]`, recursing into nested bodies.
 *  Records which tags were seen + which swaps fired (for the strict validation in composeModule). */
function swapInBody(
  stmts: readonly Stmt[],
  swaps: Record<string, readonly Stmt[]>,
  seen: Set<string>,
  used: Set<string>,
): Stmt[] {
  const out: Stmt[] = []
  for (const s of stmts) {
    if (s.s === 'placeholder') {
      seen.add(s.tag)
      const replacement = swaps[s.tag]
      if (replacement) {
        used.add(s.tag)
        out.push(...replacement)
      } else out.push(s)
      continue
    }
    if (s.s === 'if') {
      out.push({
        s: 'if',
        arms: s.arms.map((arm) => ({
          cond: arm.cond,
          body: swapInBody(arm.body, swaps, seen, used),
        })),
        elseBody: s.elseBody ? swapInBody(s.elseBody, swaps, seen, used) : undefined,
      })
      continue
    }
    if (s.s === 'for') {
      out.push({ ...s, body: swapInBody(s.body, swaps, seen, used) })
      continue
    }
    if (s.s === 'switch') {
      out.push({
        s: 'switch',
        scrut: s.scrut,
        cases: s.cases.map((c) => ({
          value: c.value,
          body: swapInBody(c.body, swaps, seen, used),
        })),
        defaultBody: s.defaultBody ? swapInBody(s.defaultBody, swaps, seen, used) : undefined,
      })
      continue
    }
    out.push(s)
  }
  return out
}

/** Compose a module by replacing its `placeholder(tag)` Stmts with the swap Stmt lists. Strict by
 *  default: throws if any placeholder is left un-swapped (unless `allowUnswapped`) or any swap key
 *  matches no placeholder (a typo). Returns a new module with the funcs' bodies rewritten; consts /
 *  structs / bindings are unchanged. */
export function composeModule(
  m: ModuleDecl,
  swaps: Record<string, readonly Stmt[]>,
  opts?: ComposeOptions,
): ModuleDecl {
  const seen = new Set<string>()
  const used = new Set<string>()
  const funcs: FuncDecl[] = m.funcs.map((f) => ({
    ...f,
    body: swapInBody(f.body, swaps, seen, used),
  }))

  const unknownKeys = Object.keys(swaps).filter((k) => !used.has(k))
  if (unknownKeys.length) {
    throw new Error(
      `shader-dsl: composeModule swap key(s) match no placeholder: ${unknownKeys.join(', ')} (seen: ${[...seen].join(', ') || 'none'})`,
    )
  }
  if (!opts?.allowUnswapped) {
    const unswapped = [...seen].filter((t) => !used.has(t))
    if (unswapped.length) {
      throw new Error(
        `shader-dsl: composeModule left placeholder(s) un-swapped: ${unswapped.join(', ')} — provide a swap or pass { allowUnswapped: true }`,
      )
    }
  }

  return { ...m, funcs }
}
