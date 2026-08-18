// ═══ Shader DSL — the portable kernel tier analyzer (#1812) ═══
//
// The SINGLE AUTHORITY for what "portable" means on a `@compute` entry. A kernel declared
// `fn(…, { stage: 'compute', portable: true })` promises to emit on BOTH backends — native
// `@compute` on WGSL (zero byte change) and the `lowerComputeToFragment` fragment-GPGPU
// rewrite on GLSL ES 3.00, which WebGL2 dispatches as a fullscreen draw into an R32UI
// target (rhi-webgl2/src/compute-webgl2.ts). This file decides whether a kernel keeps that
// promise, and it is the ONLY place the shape is written down: the GLSL lowering calls it
// for a portable-declared entry instead of re-deriving the checks, and the `portable-kernel`
// lint rule (CORE) calls it so the SAME violations surface at every emit on both writers.
//
// THE TIER (docs/plans/2026-08-18-portable-kernel-tier.md) is exactly `out[gid.x] = f(reads)`:
//   • a `@builtin(global_invocation_id)` param, used only as `.x` (a 1-D linear index),
//   • exactly ONE `read_write` storage binding of `array<u32>` — the R32UI draw buffer,
//   • exactly ONE write to it, a plain store at the invocation index (scatter → violation),
//   • a FIRST `uniform` binding of `vec4<u32>` — the dispatch uniform (.x = invocation
//     count, .y = output-grid width W_out), which is what the lowering reads the row width
//     from,
//   • no `raw` statement anywhere in the entry's call-graph closure: raw text is per-target
//     and opaque to this walk, so it contradicts the portability claim outright.
//
// DELIBERATELY NOT CHECKED: barriers, workgroup memory, and atomics. None of them is
// authorable in the DSL today, so a check for them would be vacuously green — an assertion
// that carries no information (CLAUDE.md §12). They join the list above on the same commit
// that makes them authorable, not before.

import {
  stageOf,
  typeKey,
  type BindingDecl,
  type Expr,
  type FuncDecl,
  type ModuleDecl,
  type Stmt,
} from '../ir/index.js'
import { collectFnRefs, emptyRefSet } from '../ir/collect-refs.js'
import { bodyHasRaw } from './opt/dce.js'

/** An entry parameter as the IR spells it — `FuncDecl['params']` has no name of its own. */
type ParamDecl = FuncDecl['params'][number]

/** `@builtin(x)` in a hand-built `attr` string — the fallback half of the structured-first
 *  read below. Mirrors the GLSL backend's own `BUILTIN_RE`/`ioAttr` (backends/glsl.ts), which
 *  is how `lowerComputeToFragment` resolves the gid param: reading only the structured field
 *  here would report a MISSING gid on a module the lowering happily lowers. */
const BUILTIN_ATTR_RE = /@builtin\((\w+)\)/

/** The builtin a param carries, structured field first and the `attr` string only as the
 *  hand-built-literal fallback — the #740 R3 contract `stageOf` codifies for stages. */
const builtinOf = (p: ParamDecl): string | undefined =>
  p.builtin ?? p.attr?.match(BUILTIN_ATTR_RE)?.[1]

/** `<gid>.x` — the tier's only legal reach for the invocation id. */
const isGidX = (e: Expr, gid: string): boolean =>
  e.op === 'member' && e.field === 'x' && e.base.op === 'param' && e.base.name === gid

/** Is this function a compute entry carrying the `portable` declaration? The predicate the
 *  GLSL auto-path, `emitIdentity` and the lint rule all branch on, so "what counts as a
 *  portable kernel" cannot drift between them.
 *
 *  The stage goes through `stageOf` (#740 R3), never through `f.stage`: `module()` puts the
 *  fn HANDLE — not its decl — into `funcs[]`, and the handle mirrors `attrs` but not the
 *  structured `stage`, so a `f.stage === 'compute'` test is false for every fn()-authored
 *  kernel and would leave the tier dead on its only authoring path. */
export const isPortableComputeEntry = (f: FuncDecl): boolean =>
  f.portable === true && stageOf(f) === 'compute'

/** What a kernel that IS in the tier gave the analyzer — the three declarations the GLSL
 *  lowering needs, resolved once so a caller never re-finds them. */
export interface PortableKernelFacts {
  readonly ok: true
  /** The `@builtin(global_invocation_id)` param; only its `.x` is in the tier. */
  readonly gid: ParamDecl
  /** The single `read_write` storage binding — the `array<u32>` R32UI draw buffer. */
  readonly outBinding: BindingDecl
  /** The FIRST `uniform` binding: the `vec4<u32>` dispatch uniform (.x = invocation count,
   *  .y = output-grid width W_out). */
  readonly dispatchUniform: BindingDecl
}

/** Why a kernel is NOT in the tier. Every entry is a complete sentence naming the offending
 *  declaration AND the remedy, because it is rendered verbatim into both an SD0111 lint
 *  diagnostic and the GLSL lowering's throw — there is no second place to look it up. */
export interface PortableKernelViolations {
  readonly ok: false
  readonly violations: readonly string[]
}

/** Every write to `name` in `body`, recursing into control flow. A compound `assignOp`
 *  counts as a write: it is a read-modify-write of the output, not the tier's single store,
 *  and counting it is what makes the store check reject it rather than silently miss it. */
function collectWrites(body: readonly Stmt[], name: string, out: Stmt[]): void {
  const root = (e: Expr): Expr => (e.op === 'index' || e.op === 'member' ? root(e.base) : e)
  for (const s of body) {
    if (s.s === 'assign' || s.s === 'assignOp') {
      const target = root(s.target)
      if (target.op === 'varref' && target.name === name) out.push(s)
    } else if (s.s === 'if') {
      for (const a of s.arms) collectWrites(a.body, name, out)
      if (s.elseBody) collectWrites(s.elseBody, name, out)
    } else if (s.s === 'for') {
      collectWrites([s.init, s.update, ...s.body], name, out)
    } else if (s.s === 'switch') {
      for (const c of s.cases) collectWrites(c.body, name, out)
      if (s.defaultBody) collectWrites(s.defaultBody, name, out)
    }
  }
}

/** Does any expression in `body` reference the gid param OTHER than as `<gid>.x`? Mirrors
 *  the lowering's own `rE`, which rewrites `gid.x` and fail-closes on every other reach for
 *  the param — a `.y`/`.z` component, a swizzle, or the whole vector passed to a helper. */
function usesGidBeyondX(body: readonly Stmt[], gid: string): boolean {
  let bad = false
  const walkE = (e: Expr): void => {
    if (bad || isGidX(e, gid)) return
    if (e.op === 'param' && e.name === gid) {
      bad = true
      return
    }
    switch (e.op) {
      case 'member':
        walkE(e.base)
        break
      case 'index':
        walkE(e.base)
        walkE(e.idx)
        break
      case 'binop':
      case 'compare':
      case 'logical':
        walkE(e.a)
        walkE(e.b)
        break
      case 'unop':
        walkE(e.a)
        break
      case 'call':
      case 'construct':
        for (const a of e.args) walkE(a)
        break
      case 'select':
        walkE(e.cond)
        walkE(e.ifTrue)
        walkE(e.ifFalse)
        break
      case 'matchExpr':
        walkE(e.scrutinee)
        for (const [, v] of e.cases) walkE(v)
        walkE(e.default)
        break
      default:
        break // lit / constref / varref / param(non-gid)
    }
  }
  const walkS = (ss: readonly Stmt[]): void => {
    for (const s of ss) {
      switch (s.s) {
        case 'let':
          walkE(s.expr)
          break
        case 'var':
          if (s.init) walkE(s.init)
          break
        case 'assign':
        case 'assignOp':
          walkE(s.target)
          walkE(s.expr)
          break
        case 'return':
          if (s.expr) walkE(s.expr)
          break
        case 'if':
          for (const a of s.arms) {
            walkE(a.cond)
            walkS(a.body)
          }
          if (s.elseBody) walkS(s.elseBody)
          break
        case 'for':
          walkS([s.init])
          walkE(s.cond)
          walkS([s.update])
          walkS(s.body)
          break
        case 'switch':
          walkE(s.scrut)
          for (const c of s.cases) walkS(c.body)
          if (s.defaultBody) walkS(s.defaultBody)
          break
        default:
          break // break / continue / discard / raw / placeholder
      }
    }
  }
  walkS(body)
  return bad
}

/** The module functions reachable from `entry` — the entry itself plus the call-graph
 *  closure over the module's OWN fns (builtin names resolve to nothing). The same walk
 *  `stageScope` and the fragment-only-builtin rule use, through the shared `collectFnRefs`
 *  collector, so a `raw` statement two helpers deep is still found. */
function reachableFns(m: ModuleDecl, entry: FuncDecl): FuncDecl[] {
  const byName = new Map(m.funcs.map((f) => [f.name, f]))
  const seen = new Set([entry.name])
  const out = [entry]
  const stack = [entry]
  while (stack.length > 0) {
    const refs = emptyRefSet()
    collectFnRefs(stack.pop()!, refs)
    for (const name of refs.calls) {
      const f = byName.get(name)
      if (f && !seen.has(name)) {
        seen.add(name)
        out.push(f)
        stack.push(f)
      }
    }
  }
  return out
}

/**
 * Decide whether `entry` — a `portable`-declared `@compute` entry of `m` — is inside the
 * gather-only portable kernel tier (#1812), and hand back either the declarations the GLSL
 * lowering needs or every reason it is out.
 *
 * This is the tier's single authority. `backends/glsl.ts`'s `lowerComputeToFragment` calls it
 * for a portable-declared entry instead of re-deriving the shape, and the `portable-kernel`
 * lint rule (registered in `CORE_RULES`, so `validate()` runs it at EVERY emit on BOTH
 * writers) turns each violation into an `SD0111` diagnostic. That is what makes a kernel
 * which would silently fail to lower on WebGL2 fail on WebGPU too, at the same moment, with
 * the same sentence.
 *
 * Every check is derived from what the lowering actually does, so a kernel this returns
 * `ok: true` for is one the lowering can rewrite; the violations are not style opinions.
 * Checks that depend on an earlier one (the gid uses, the store index) are skipped when that
 * one already failed, so the list never cascades into advice about a declaration that is not
 * there.
 *
 * @param m - the module the entry belongs to; its bindings are half of the tier's shape.
 * @param entry - the `portable`-declared compute entry to analyze.
 * @returns `{ ok: true, … }` with the resolved gid param, output binding and dispatch
 * uniform, or `{ ok: false, violations }` with one complete detail+remedy sentence per
 * violated rule.
 */
export function analyzePortableKernel(
  m: ModuleDecl,
  entry: FuncDecl,
): PortableKernelFacts | PortableKernelViolations {
  const violations: string[] = []

  // ── the 1-D invocation index ──
  const gid = entry.params.find((p) => builtinOf(p) === 'global_invocation_id')
  if (!gid) {
    violations.push(
      `the portable compute entry '${entry.name}' has no @builtin(global_invocation_id) parameter — declare one (\`gid: builtin('global_invocation_id', vec3uT)\`) and index the output with \`gid.x\`, the tier's 1-D linear invocation index`,
    )
  } else if (usesGidBeyondX(entry.body, gid.name)) {
    violations.push(
      `'${gid.name}' is used other than as '${gid.name}.x' — the portable tier is 1-D, so derive every index from the linear invocation index \`${gid.name}.x\` (recover a 2-D coordinate from it and the dispatch uniform's row width instead of reading \`.y\`/\`.z\`)`,
    )
  }

  // ── the single u32 output ──
  const rw = m.bindings.filter((b) => b.space === 'storage' && b.access === 'read_write')
  if (rw.length === 0) {
    violations.push(
      `the module declares no read_write storage binding — the portable tier writes its result through exactly one \`storageBuffer(…, 'read_write')\` of \`array<u32>\`, which becomes the R32UI draw buffer the WebGL2 lowering renders into`,
    )
  } else if (rw.length > 1) {
    violations.push(
      `the module declares ${rw.length} read_write storage bindings (${rw.map((b) => `'${b.name}'`).join(', ')}) — the portable tier maps exactly ONE onto the single R32UI draw buffer, so keep one output and move the others into a separate kernel`,
    )
  }

  // ── exactly one plain store, at the invocation index ──
  const outBinding = rw.length === 1 ? rw[0] : undefined
  if (outBinding) {
    const t = outBinding.type
    if (t.kind !== 'array' || t.elem.kind !== 'scalar' || t.elem.scalar !== 'u32')
      violations.push(
        `the read_write storage binding '${outBinding.name}' is ${typeKey(t)} — the portable tier's output must be \`array<u32>\` (the R32UI draw buffer is the only storage-write form WebGL2 has), so pack the value into a u32 (e.g. with pack4x8unorm) before storing it`,
      )
    const writes: Stmt[] = []
    collectWrites(entry.body, outBinding.name, writes)
    const idx = `${gid?.name ?? 'gid'}.x`
    if (writes.length !== 1) {
      violations.push(
        `'${entry.name}' writes to '${outBinding.name}' ${writes.length} time${writes.length === 1 ? '' : 's'} — the portable tier stores exactly once, \`${outBinding.name}[${idx}] = f(reads)\`, so fold the branches into a single value and store it once`,
      )
    } else {
      const store = writes[0]
      if (
        store.s !== 'assign' ||
        store.target.op !== 'index' ||
        gid === undefined ||
        !isGidX(store.target.idx, gid.name)
      )
        violations.push(
          `the write to '${outBinding.name}' is not a plain store at the invocation index — the portable tier is gather-only, so write \`${outBinding.name}[${idx}] = …\` exactly once (a scatter to any other index, or a compound assignment, has no fragment-GPGPU equivalent)`,
        )
    }
  }

  // ── the dispatch uniform ──
  const dispatchUniform = m.bindings.find((b) => b.space === 'uniform')
  if (!dispatchUniform) {
    violations.push(
      `the module declares no uniform binding — the portable tier reads its dispatch uniform from the FIRST uniform binding and it must be \`vec4<u32>\` (.x = invocation count, .y = output-grid width W_out), so declare one`,
    )
  } else if (
    dispatchUniform.type.kind !== 'vec' ||
    dispatchUniform.type.n !== 4 ||
    dispatchUniform.type.elem !== 'u32'
  ) {
    violations.push(
      `the first uniform binding '${dispatchUniform.name}' is ${typeKey(dispatchUniform.type)}, not vec4<u32> — the portable tier reads the dispatch uniform (.x = invocation count, .y = output-grid width W_out) from the FIRST uniform binding, so declare it as vec4<u32> or move it ahead of the others`,
    )
  }

  // ── no raw text anywhere the entry can reach ──
  for (const f of reachableFns(m, entry)) {
    if (bodyHasRaw(f.body))
      violations.push(
        `fn '${f.name}', reachable from the portable compute entry '${entry.name}', contains a \`raw\` statement — raw text is per-target and opaque to this analyzer, so it contradicts the portability claim; express the code in the DSL, or drop \`portable\` and keep the kernel WebGPU-only`,
      )
  }

  if (violations.length > 0) return { ok: false, violations }
  // Reaching here proves each declaration was found and well-shaped: every absent or
  // ill-typed case above pushed a violation.
  return { ok: true, gid: gid!, outBinding: outBinding!, dispatchUniform: dispatchUniform! }
}
