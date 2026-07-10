// ═══ Shader DSL — the neutral emit walk ═══
//
// ONE tree-walk over Expr / Stmt, shared by every backend. It is target-neutral:
// the only target-specific decisions are delegated to the Backend (type/literal/
// intrinsic spelling + the handful of divergent statement/declaration fragments
// in `backend.ts`). Backends provide those fragments; they do NOT re-implement
// the control-flow walk (no duplicated if/for/switch/return logic that can drift).

import type { Backend } from './backend'
import type { Expr, Stmt, ModuleDecl } from './ir'
import { validate } from './passes/validate'
import { assertCaps } from './passes/required-caps'
import { lowerModule } from './passes/match-lower'
import { fp64Lower, type Fp64Flavor } from './passes/fp64-lower'
import { autoVars, optimizeAt, type OptLevel } from './passes/opt'
import { reflect, type Reflection } from './reflect'

const pad = (depth: number): string => '  '.repeat(depth)

export function emitExpr(e: Expr, be: Backend): string {
  const r = (x: Expr) => emitExpr(x, be)
  switch (e.op) {
    case 'lit':
      return be.literal(e.value, e.type)
    case 'constref':
    case 'overrideref':
    case 'param':
    case 'varref':
      // `overrideref` (#923) emits as the bare name on BOTH backends — the WGSL
      // `override` identifier and the GLSL `#define` macro share the declared name.
      return e.name
    case 'binop':
      return `(${r(e.a)} ${e.bop} ${r(e.b)})`
    case 'unop':
      return `(-${r(e.a)})`
    case 'compare':
      return `(${r(e.a)} ${e.cop} ${r(e.b)})`
    case 'logical':
      return `(${r(e.a)} ${e.lop} ${r(e.b)})`
    case 'call':
      return be.intrinsic(e.fn, e.args.map(r))
    case 'member':
      return `${r(e.base)}.${e.field}`
    case 'construct':
      return `${be.typeName(e.type)}(${e.args.map(r).join(', ')})`
    // select(false, true, cond) — the writer owns the spelling (WGSL select() vs
    // GLSL ternary). Args passed in WGSL's (false, true, cond) order.
    case 'select':
      return be.intrinsic('select', [r(e.ifFalse), r(e.ifTrue), r(e.cond)])
    case 'index':
      return `${r(e.base)}[${r(e.idx)}]`
    // matchExpr is consumed by the neutral pre-emit pass (passes/match-lower.ts)
    // before emit. If one leaks through, that pass was bypassed — fail loudly.
    case 'matchExpr':
      throw new Error(
        'shader-dsl: matchExpr Expr leaked into emitExpr — lowerModule should have hoisted it',
      )
  }
}

export function emitStmt(s: Stmt, depth: number, be: Backend): string {
  const p = pad(depth)
  const r = (x: Expr) => emitExpr(x, be)
  switch (s.s) {
    case 'let':
      return `${p}${be.localLet(s.name, s.expr.type, r(s.expr))};`
    case 'var':
      return `${p}${be.localVar(s.name, s.type, s.init !== undefined ? r(s.init) : undefined)};`
    case 'assign':
      return `${p}${r(s.target)} = ${r(s.expr)};`
    case 'assignOp':
      return `${p}${r(s.target)} ${s.bop}= ${r(s.expr)};`
    case 'return':
      return s.expr !== undefined ? `${p}return ${r(s.expr)};` : `${p}return;`
    case 'break':
      return `${p}break;`
    case 'continue':
      return `${p}continue;`
    case 'discard':
      return `${p}discard;`
    case 'if': {
      const lines: string[] = []
      s.arms.forEach((arm, i) => {
        lines.push(`${i === 0 ? `${p}if` : `${p}} else if`} (${r(arm.cond)}) {`)
        lines.push(emitBody(arm.body, depth + 1, be))
      })
      if (s.elseBody) {
        lines.push(`${p}} else {`)
        lines.push(emitBody(s.elseBody, depth + 1, be))
      }
      lines.push(`${p}}`)
      return lines.filter((l) => l.length > 0).join('\n')
    }
    case 'for': {
      const init = forHeader(s.init, be)
      const update = forHeader(s.update, be)
      return `${p}for (${init}; ${r(s.cond)}; ${update}) {\n${emitBody(s.body, depth + 1, be)}\n${p}}`
    }
    case 'placeholder':
      return `${p}${be.placeholderStmt(s.tag)}`
    case 'raw':
      return `${p}${be.rawStmt(s.wgsl)}`
    case 'switch': {
      const lines: string[] = [`${p}${be.switchHead(r(s.scrut))}`]
      for (const c of s.cases) {
        lines.push(`${pad(depth + 1)}case ${be.caseLabel(c.value, s.scrut.type)}: {`)
        lines.push(emitBody(c.body, depth + 2, be))
        // C-style backends (GLSL) fall through without a terminator — append the
        // backend's case break unless the body already ends in return/discard (which
        // would make the break unreachable). WGSL has no caseBreak (no fallthrough).
        const last = c.body[c.body.length - 1]
        if (be.caseBreak && !(last && (last.s === 'return' || last.s === 'discard'))) {
          lines.push(`${pad(depth + 2)}${be.caseBreak}`)
        }
        lines.push(`${pad(depth + 1)}}`)
      }
      lines.push(`${pad(depth + 1)}default: {`)
      if (s.defaultBody) lines.push(emitBody(s.defaultBody, depth + 2, be))
      lines.push(`${pad(depth + 1)}}`)
      lines.push(`${p}}`)
      return lines.join('\n')
    }
  }
}

export function emitBody(body: readonly Stmt[], depth: number, be: Backend): string {
  return body.map((s) => emitStmt(s, depth, be)).join('\n')
}

// For-loop header init/update: a var/assign WITHOUT trailing `;` or indentation.
export function forHeader(s: Stmt, be: Backend): string {
  const r = (x: Expr) => emitExpr(x, be)
  if (s.s === 'var')
    return s.init !== undefined
      ? be.localVar(s.name, s.type, r(s.init))
      : be.localVar(s.name, s.type)
  if (s.s === 'assign') return `${r(s.target)} = ${r(s.expr)}`
  if (s.s === 'assignOp') return `${r(s.target)} ${s.bop}= ${r(s.expr)}`
  throw new Error(`shader-dsl: bad for-header stmt ${s.s}`)
}

// ── Module-level emit (shared driver) ──
// The module assembly pipeline, parameterised by the Backend, lives here ONCE so a
// new backend does not copy it. Per-target spelling (const/struct/binding/func) and
// the emit-time optimisation (`optimize` — the full fixpoint pipeline on both current
// backends, #763 H1) are delegated to the Backend; the validate → assertCaps →
// autoVars → lowerModule → optimize preamble is identical for every target.

/** Run the authored module through the shared pre-emit pipeline for a backend:
 *  validate the AUTHORED shape, fail-closed on unsupported caps, then
 *  `optimize(lowerModule(autoVars(m)))`. Returns the lowered module ready for
 *  per-declaration spelling. (autoVars BEFORE lowerModule — var materialisation is
 *  backend-neutral; cse runs only inside the WGSL backend's `optimize`.) */
export function lowerForBackend(
  m: ModuleDecl,
  be: Backend,
  level?: OptLevel,
  fp64Flavor?: Fp64Flavor,
): ModuleDecl {
  // Validate the AUTHORED module before any lowering (the rules reason about the
  // pre-lower shape — e.g. matchExpr chains, placeholder swap sites).
  validate(m)
  assertCaps(be, m) // principled fail-closed gate
  // matchExpr→{var slot, Stmt.switch} lowering first so the rest of the emitter stays
  // matchExpr-unaware (identity for modules with no matchExpr); fp64Lower then rewrites
  // every f64 into vec2<f32> + df64_* calls (identity for modules with no f64) — HERE,
  // before the optimizer, so every backend lowers identically and the optimizer only
  // sees ordinary vec2/f32 IR plus opaque df64_* calls. Auto-cache (cse, in the
  // WGSL backend's optimize) then hoists any input-only subexpression reused ≥2x into one
  // shared `let`, so authors write plain inline expressions and the reuse is bound for them.
  // `level` overrides the backend's default optimizer tier (used by the measurement A/B and
  // debug emit); omitted → the backend's own `optimize` (= O2 fixpoint), the production path.
  const pre = fp64Lower(lowerModule(autoVars(m)), fp64Flavor ? { flavor: fp64Flavor } : undefined)
  return level === undefined ? be.optimize(pre) : optimizeAt(pre, level)
}

/** Assemble an ALREADY-lowered module into a target string: the declaration assembly
 *  (consts → structs → bindings → funcs, only non-empty sections), joined `\n\n` with a
 *  trailing newline. Split out of `emitModule` so the string and the reflection can be
 *  derived from the SAME lowered module (see `emitModuleWithReflection`). */
function assembleLowered(lowered: ModuleDecl, be: Backend): string {
  const parts: string[] = []
  // #923 — specialization-constant declarations lead the module (WGSL `override`
  // lines): they are module-scope constants a later const/fn may reference. Skipped
  // when the module declares none, so override-free emit stays byte-identical.
  if (lowered.overrides?.length && be.emitOverride)
    parts.push(lowered.overrides.map((o) => be.emitOverride!(o)).join('\n'))
  if (lowered.consts.length) parts.push(lowered.consts.map((c) => be.emitConst(c)).join('\n'))
  if (lowered.structs.length) parts.push(lowered.structs.map((s) => be.emitStruct(s)).join('\n\n'))
  if (lowered.bindings.length) parts.push(lowered.bindings.map((b) => be.emitBinding(b)).join('\n'))
  if (lowered.funcs.length) parts.push(lowered.funcs.map((f) => be.emitFunc(f)).join('\n\n'))
  return parts.join('\n\n') + '\n'
}

/** An emit plugin — the Vite/Webpack-style unit production-emit tooling composes
 *  through. The CORE knows nothing about what a plugin does; the implementations
 *  (mangle/minify — `@xgis/shader-dsl/emit-prod`) live on their own subpath so a
 *  runtime-emit consumer that never imports them bundles ZERO bytes of them.
 *
 *  Two staged hooks, both optional (a plugin may use either or both):
 *   - `transformIR` receives the fully LOWERED module (post match-lower /
 *     fp64Lower / optimize; on GLSL also post reserved-ident sanitisation) and
 *     returns a module the backend can spell. It must be DETERMINISTIC per
 *     module — the GLSL vertex/fragment emits are separate calls that must
 *     agree on every shared name.
 *   - `transformText` receives the assembled string.
 *
 *  Like Vite, hooks fire STAGED across all plugins: every plugin's `transformIR`
 *  runs (in `plugins` order) before the module is assembled, then every plugin's
 *  `transformText` runs (in `plugins` order) on the string. `name` identifies
 *  the plugin (debugging / error context), same as a Vite/Webpack plugin name. */
export interface EmitPlugin {
  readonly name: string
  readonly transformIR?: (lowered: ModuleDecl) => ModuleDecl
  readonly transformText?: (code: string) => string
}

/** Emit configuration — a Vite/Webpack-style `{ plugins: [...] }` bag. A config
 *  object (rather than a bare array) leaves room for future top-level emit
 *  options without another signature change. Absent/empty ⇒ the plain emit,
 *  byte-identical. */
export interface EmitOptions {
  readonly plugins?: readonly EmitPlugin[]
  /** Which df64 EFT registry backs f64 lowering: 'float' (default — the
   *  guarded float EFTs, byte-identical emit) or 'integer' (the fast-math-
   *  immune integer primitives — see core/fp64/df64-int.ts; no `_fp64` guard
   *  binding is injected). */
  readonly fp64Flavor?: Fp64Flavor
}

/** Fold every plugin's `transformIR` over the lowered module, in `plugins`
 *  order. Shared by the WGSL driver below and the GLSL backend's own assembly. */
export function applyIRPlugins(lowered: ModuleDecl, opts?: EmitOptions): ModuleDecl {
  let m = lowered
  for (const p of opts?.plugins ?? []) if (p.transformIR) m = p.transformIR(m)
  return m
}

/** Fold every plugin's `transformText` over the emitted string, in `plugins` order. */
export function applyTextPlugins(code: string, opts?: EmitOptions): string {
  let c = code
  for (const p of opts?.plugins ?? []) if (p.transformText) c = p.transformText(c)
  return c
}

/** Emit a ModuleDecl to a target string: shared preamble (`lowerForBackend`) then the
 *  declaration assembly (consts → structs → bindings → funcs, only non-empty sections),
 *  joined `\n\n` with a trailing newline. Each backend's public module entry
 *  (`emitModule` for WGSL) routes through here, so the assembly lives once.
 *  `opts.plugins` run staged around the assembly (all transformIR, then all transformText). */
export function emitModule(m: ModuleDecl, be: Backend, opts?: EmitOptions): string {
  const lowered = applyIRPlugins(lowerForBackend(m, be, undefined, opts?.fp64Flavor), opts)
  // The `enable`-directive header (#628) is derived from the AUTHORED module's opt-in
  // caps (m.enables) — the lowering passes rebuild the module object and do not carry
  // it — and prepended to the assembled declarations. '' for enables-free modules, so
  // their emit stays byte-identical.
  return (be.modulePreamble?.(m) ?? '') + applyTextPlugins(assembleLowered(lowered, be), opts)
}

/** Emit a ModuleDecl at an explicit optimization level (O0/O1/O2) instead of the
 *  backend's default. `emitModuleAt(m, be, 'O2')` is byte-identical to `emitModule(m, be)`
 *  (both run the full fixpoint); O0 emits the naive lowered module. Used by the emit-size
 *  measurement (measure.ts) to A/B the optimizer and for debug builds. NOTE: the GLSL
 *  backend assembles uniform UBOs via its own emitGlslModule, so this WGSL-style assembly
 *  is for the WGSL backend (and any backend whose bindings need no special assembly). */
export function emitModuleAt(m: ModuleDecl, be: Backend, level: OptLevel): string {
  return (be.modulePreamble?.(m) ?? '') + assembleLowered(lowerForBackend(m, be, level), be)
}

/** Emit a ModuleDecl AND recover its pipeline reflection, BOTH derived from the SAME
 *  lowered module (`lowerForBackend(m, be)`) so the emitted string and the reflection
 *  metadata cannot desync. `.code` is byte-identical to `emitModule(m, be)`; `.reflection`
 *  is `reflect()` of the lowered module — equal to `reflect(m)` for f64-free modules
 *  (autoVars/lowerModule/cse rewrite only function BODIES). For a module using f64,
 *  fp64Lower rewrites decl TYPES too (f64 → vec2<f32>), but the BYTE layout is unchanged
 *  by construction — typeLayout gives f64 the same {size 8, align 8} as its lowered
 *  vec2<f32> slot — so reflect(m) and this reflection still report identical offsets;
 *  only the reported type STRING differs ('f64' vs 'vec2<f32>'). */
export function emitModuleWithReflection(
  m: ModuleDecl,
  be: Backend,
): { code: string; reflection: Reflection } {
  const lowered = lowerForBackend(m, be)
  return {
    code: (be.modulePreamble?.(m) ?? '') + assembleLowered(lowered, be),
    reflection: reflect(lowered),
  }
}
