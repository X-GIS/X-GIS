// ═══ Shader DSL — member-of-construct fold / scalar replacement (Optimization context) ═══
//
// Reads a component back out of the aggregate that was just built, without the
// aggregate:
//
//   let _cse3 = vec2<f32>(hi, lo);      →   … hi …
//   … _cse3.x …
//
// This is gcc's scalar-replacement-of-aggregates in the one shape this IR actually
// produces. It matters here far more than the C analogue because EVERY df64 helper
// returns a `vec2<f32>(hi, lo)` whose caller immediately takes `.x` / `.y` of it —
// so the pack/unpack round-trip is the dominant redundancy in fp64 code.
//
// WHERE IT IS WIRED, AND WHY NOT IN DEFAULT_PASSES. `passes/force-inline.ts` applies it;
// the O2 list does not. That is the same call `optimize.ts` already makes for `deadFnElim`
// and `unrollLoops` — a byte-perturbing pass stays available-but-unwired — and here the
// numbers make it easy. Measured by instrumenting THIS function over the example corpus
// (not by matching a shape in the emitted text: a text probe is what produced #1972's
// wrong numbers, and re-quoting them would have repeated the mistake):
//
//   fires, default emit                       0     — nothing to fold; df64 is still opaque
//   fires, forceInline('single-call')           31
//   fires, forceInline('all')             2,632
//   arithmetic ops, flattened corpus     15,303 -> 14,619   (-684, -4.5%)
//
// The default path cannot reach a single site, because the round-trips this exists to
// remove are inside df64 helper bodies that are not inlined there. So wiring it into O2
// buys ~0 and costs the whole snapshotted-bytes surface; wiring it into the escape hatch
// whose output it cleans up buys 97% of the win (14,619 vs 14,597 for the full-fixpoint
// variant) and perturbs nothing.
//
// RESOLVING THROUGH THE BINDING IS THE WHOLE PASS. A fold that only matches a
// SYNTACTIC `construct(...).x` finds almost nothing, because the emitter CSEs every
// expression into a `let` chain first — the construct and the member land two
// statements apart, spelled `_cse3.x`. #1972 was opened because a probe that missed
// exactly this reported "0 sites" and read as a clean corpus.
//
// VALUE-SAFE by construction: no arithmetic is performed and no expression moves
// across a statement that writes anything it reads (the binding is a `let`, and a
// name that is ever an assignment target is excluded). It forwards ONE argument into
// ONE use — never the aggregate — so the construct itself is not duplicated; when
// every field has been forwarded the binding is dead and DCE removes it. A field read
// twice forwards its argument twice, which `cse` / `gvn` (later in the same pipeline)
// re-share. Call-bearing arguments are excluded outright (below), so the duplication
// and the sinking this could otherwise do stay confined to pure arithmetic.
//
// CONSERVATIVE EXCLUSIONS — each bails rather than guessing:
//   • MIXED-WIDTH composition. `vec4(v2, x, y)` has 3 args for 4 components, so an
//     arg index is not a component index. Only two arities are unambiguous: one arg
//     per component, or a single SCALAR arg (the splat, `vecN(x)` — which is how
//     fp64-lower's `splatPair` builds a plane). Anything else is left alone.
//   • MULTI-COMPONENT swizzles (`.xy`, `.hi.xz`). A 1:1 fold would have to rebuild a
//     narrower construct; not worth the surface, and `laneSwizzle`'s bases are
//     members rather than constructs anyway.
//   • A struct whose ctor arity does not match its declared field count, or a field
//     the declaration does not name.
//   • A type mismatch between the member and the argument it would become — a
//     belt-and-braces check, since a well-formed construct cannot produce one.
//   • An argument containing a CALL. Forwarding duplicates the argument when two
//     fields are read, and lets DCE sink it into a conditional once the binding is
//     dead — harmless for arithmetic, not for a call, which in this IR can `discard`
//     (that is the whole reason `backends/glsl-legalize.ts` exists, and dropping this
//     exclusion was measured turning eight of its gates red by dissolving the very
//     constructor they hoist). It costs 37 sites corpus-wide — 1.4% of the flattened
//     total — because a flattened df64 body is almost entirely arithmetic.
//   • A `raw` body, whose text can read a name this pass cannot see (as in every
//     other pass here).
//
// Wired into DEFAULT_PASSES (O2) only, alongside `structCtor` — the tier whose
// emitted bytes are already snapshotted. It is a bit-exact value MOVER and would be
// legal at O1; leaving O1's list alone keeps this change to one tier.

import type { Expr, Stmt, ModuleDecl, FuncDecl, StructDecl } from '../../ir/index.js'
import { typeKey } from '../../ir/types.js'
import { mapStmt } from './ir-transform.js'
import { bodyHasRaw, collectMutatedRoots, eachExpr } from './expr-utils.js'

/** Component index of a single-character vector field, or -1. Both spellings the
 *  targets accept — WGSL and GLSL ES 3.00 each allow `xyzw` and `rgba`. */
function componentIndex(field: string): number {
  if (field.length !== 1) return -1
  const i = 'xyzw'.indexOf(field)
  return i >= 0 ? i : 'rgba'.indexOf(field)
}

/** Does `e` call anything? A call can `discard`, so it may be neither duplicated nor
 *  sunk into a conditional — see the call exclusion above. */
function callsAnything(e: Expr): boolean {
  let found = false
  eachExpr(e, (x) => {
    if (x.op === 'call') found = true
  })
  return found
}

/** The argument `base.<field>` reads, when the construct's arity makes that
 *  unambiguous — otherwise undefined (see the exclusions above). */
function pickField(
  base: Extract<Expr, { op: 'construct' }>,
  field: string,
  structs: ReadonlyMap<string, StructDecl>,
): Expr | undefined {
  const t = base.type
  if (t.kind === 'struct') {
    const decl = structs.get(t.name)
    if (decl === undefined || decl.fields.length !== base.args.length) return undefined
    const i = decl.fields.findIndex((f) => f.name === field)
    return i < 0 ? undefined : base.args[i]
  }
  if (t.kind !== 'vec') return undefined
  const i = componentIndex(field)
  if (i < 0 || i >= t.n) return undefined
  // One arg per component: an arity of n admits no sub-vector, but assert scalar
  // anyway so the index-is-component claim is checked rather than inferred.
  if (base.args.length === t.n) {
    const a = base.args[i]!
    return a.type.kind === 'scalar' ? a : undefined
  }
  // The splat: `vecN(x)` fills every component with the one scalar.
  if (base.args.length === 1) {
    const a = base.args[0]!
    return a.type.kind === 'scalar' ? a : undefined
  }
  return undefined
}

/** Collect every `let name = <construct>` (nested bodies included) whose name is
 *  never mutated. Function-wide, exactly as const-prop: binding names are unique
 *  per fn, so no block scoping is needed. */
function collectCtorLets(
  body: readonly Stmt[],
  mutated: ReadonlySet<string>,
  out: Map<string, Extract<Expr, { op: 'construct' }>>,
): void {
  for (const s of body) {
    if (s.s === 'let' && s.expr.op === 'construct' && !mutated.has(s.name)) out.set(s.name, s.expr)
    else if (s.s === 'if') {
      for (const a of s.arms) collectCtorLets(a.body, mutated, out)
      if (s.elseBody) collectCtorLets(s.elseBody, mutated, out)
    } else if (s.s === 'for') {
      collectCtorLets([s.init], mutated, out)
      collectCtorLets(s.body, mutated, out)
    } else if (s.s === 'switch') {
      for (const c of s.cases) collectCtorLets(c.body, mutated, out)
      if (s.defaultBody) collectCtorLets(s.defaultBody, mutated, out)
    }
  }
}

function memberFoldFn(f: FuncDecl, structs: ReadonlyMap<string, StructDecl>): FuncDecl {
  if (bodyHasRaw(f.body)) return f
  const mutated = new Set<string>()
  collectMutatedRoots(f.body, mutated)
  const ctors = new Map<string, Extract<Expr, { op: 'construct' }>>()
  collectCtorLets(f.body, mutated, ctors)

  // `mapExpr` rewrites bottom-up, so `e.base` is already folded when this runs. The
  // binding is resolved HERE rather than by substituting the construct at every
  // varref — that would copy the aggregate into uses this pass cannot remove.
  const sub = (e: Expr): Expr => {
    if (e.op !== 'member') return e
    const base =
      e.base.op === 'construct'
        ? e.base
        : e.base.op === 'varref'
          ? ctors.get(e.base.name)
          : undefined
    if (base === undefined) return e
    const picked = pickField(base, e.field, structs)
    if (picked === undefined || typeKey(picked.type) !== typeKey(e.type)) return e
    return callsAnything(picked) ? e : picked
  }
  return { ...f, body: f.body.map((s) => mapStmt(s, sub)) }
}

/** Fold `<construct>.<field>` — including through the `let` the CSE chain bound the
 *  construct to — down to the argument it reads. Pure (module -> module). */
export function memberFold(m: ModuleDecl): ModuleDecl {
  const structs = new Map(m.structs.map((s) => [s.name, s]))
  return { ...m, funcs: m.funcs.map((fn) => memberFoldFn(fn, structs)) }
}
