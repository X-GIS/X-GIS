// ═══ The coverage `filter:` predicate, run on the CPU — same IR, other backend (#1437) ═══
//
// The sounding arm and the ramp drape must agree about what a layer's `filter:` means. They
// evaluate it in different places by design (a candidate cell here, a fragment there — the
// operand decides), so the only way to keep them from drifting is for there to be nothing to
// drift: `compileCoverageFilter` produces ONE shader-dsl predicate, the drape emits it as
// WGSL/GLSL, and this module runs the very same IR through the DSL's own CPU backend
// (`compileModuleJs`, bit-identical to the `compileModule` interpreter by contract).
//
// That is deliberately not "an evaluator that happens to match". coverage-ramp.ts warns twice
// that a GPU twin of CPU math is this codebase's dominant bug archetype; the DSL exists so the
// twin can be DERIVED instead of written.
//
// CACHED BY AST IDENTITY. A compiled scene hands the same `filter` object to every frame's
// dispatch, so a WeakMap keyed on it compiles once per style and lets the entry go when the
// scene does. Compiling per frame would put a parser walk plus a `new Function` in the label
// pass's hot path.

import { compileModuleJs, compileModule, type CpuModule } from '@xgis/shader-dsl'
import type * as AST from '@xgis/compiler'
import { compileCoverageFilter, coverageFilterModule, COVERAGE_FILTER_FN } from './coverage-filter'

/** What one compiled clause needs at call time: the band to read out of a cell's property bag
 *  and the compiled module to run. `null` marks a clause this path cannot serve, so the caller
 *  falls back once instead of re-attempting the compile every frame. */
type Entry = { band: string; fns: CpuModule['fns'] } | null

const CACHE = new WeakMap<object, Entry>()

function entryFor(filter: { ast: unknown }): Entry {
  const key = filter as object
  const hit = CACHE.get(key)
  if (hit !== undefined) return hit
  const compiled = compileCoverageFilter(filter.ast as AST.Expr)
  let entry: Entry = null
  if (compiled.ok) {
    const mod = coverageFilterModule(compiled)
    // The js-source backend, with the interpreter as the CSP fallback — the same pairing
    // cpu-projections.ts uses, and for the same reason: `new Function` is blocked on an
    // `unsafe-eval` host, and the interpreter is the reference implementation anyway.
    let fns: CpuModule['fns']
    try {
      fns = compileModuleJs(mod).fns
    } catch {
      fns = compileModule(mod).fns
    }
    entry = { band: compiled.band, fns }
  }
  CACHE.set(key, entry)
  return entry
}

/**
 * A cell predicate for a coverage layer's `filter:`, or `null` when the clause is outside the
 * compilable subset (or absent) and the caller should use the general AST evaluator.
 *
 * `zoom` is bound at build time rather than read per cell: it is constant across one dispatch,
 * and threading it through every call would put an argument in the loop for a value that
 * cannot change inside it.
 *
 * A cell whose bag has no numeric value for the band fails the predicate. That is the honest
 * reading — a filter over a band this cell does not carry is not satisfied — and it matches
 * the drape, where a cell with no valid value is discarded before the predicate is even
 * reached.
 */
export function coverageCellPredicate(
  filter: { ast: unknown } | null | undefined,
  zoom: number,
): ((props: Record<string, unknown>) => boolean) | null {
  if (!filter?.ast) return null
  const entry = entryFor(filter)
  if (!entry) return null
  const { band, fns } = entry
  const fn = fns[COVERAGE_FILTER_FN]
  if (!fn) return null
  return (props) => {
    const v = props[band]
    if (typeof v !== 'number' || Number.isNaN(v)) return false
    return fn(v, zoom) as boolean
  }
}
