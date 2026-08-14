// ═══ Shader DSL — the neutral emit walk ═══
//
// ONE tree-walk over Expr / Stmt, shared by every backend. It is target-neutral:
// the only target-specific decisions are delegated to the Backend (type/literal/
// intrinsic spelling + the handful of divergent statement/declaration fragments
// in `backend.ts`). Backends provide those fragments; they do NOT re-implement
// the control-flow walk (no duplicated if/for/switch/return logic that can drift).

import type { Backend } from './backend'
import type { Expr, Stmt, ModuleDecl } from './ir'
import { stageOf } from './ir'
import { fragmentRequires, type EmitFragment } from './fragment'
import { validate } from './passes/validate'
import { assertCaps, assertBuiltins } from './passes/required-caps'
import { lowerModule } from './passes/match-lower'
import { fp64Lower, type Fp64Flavor } from './passes/fp64-lower'
import { autoVars, optimizeAt, type OptLevel } from './passes/opt'
import { mapExpr, mapStmt } from './passes/opt/ir-transform'
import { reflect, type Reflection } from './reflect'

const pad = (depth: number): string => '  '.repeat(depth)

/** How much parenthesis an expression carries.
 *  - `'full'` (default) — every binop/unop/compare/logical is wrapped, no
 *    precedence assumed. The historical emit, byte-for-byte.
 *  - `'minimal'` — parens are omitted where operator precedence already implies
 *    the same parse. Build-time, opt-in: it changes the emitted bytes (and so
 *    every committed golden / baked artifact), never the parse tree. */
export type ParenMode = 'full' | 'minimal'

// Precedence used by 'minimal'. DELIBERATELY the INTERSECTION of what WGSL and
// GLSL ES 3.00 both define the same way — multiplicative over additive, unary
// over both. Everything else is 0, meaning "always parenthesize": WGSL does not
// give `&`/`|`/`^`, the shifts, the relational ops or `&&`/`||` a chaining
// precedence at all (mixing them without parens is a compile ERROR there, not a
// precedence question), so a table that ranked them would be inventing a rule
// one of the two targets does not have.
const PREC_UNARY = 4
const PREC_ATOM = 5
const precOf = (bop: string): number =>
  bop === '*' || bop === '/' || bop === '%' ? 3 : bop === '+' || bop === '-' ? 2 : 0

export function emitExpr(e: Expr, be: Backend, parens: ParenMode = 'full'): string {
  // `need` is the lowest precedence this POSITION accepts unparenthesized.
  // A binop's LEFT child accepts its own precedence (left-associative, so
  // `a-b-c` re-parses identically); its RIGHT child demands strictly more, which
  // is what keeps `a-(b-c)` and `a+(b+c)` parenthesized — reassociating those is
  // a different float result, not a spelling change.
  const go = (x: Expr, need: number): string => {
    const wrap = (s: string, prec: number): string => (prec < need ? `(${s})` : s)
    const full = parens === 'full'
    const r = (y: Expr) => go(y, full ? 0 : 1)
    switch (x.op) {
      case 'binop': {
        if (full) return `(${r(x.a)} ${x.bop} ${r(x.b)})`
        const p = precOf(x.bop)
        if (p === 0) return `(${r(x.a)} ${x.bop} ${r(x.b)})`
        return wrap(`${go(x.a, p)} ${x.bop} ${go(x.b, p + 1)}`, p)
      }
      case 'unop':
        // `-` binds tighter than any binary operator, so the operand must be an
        // ATOM to lose its parens: `-(a*b)` is not `-a*b`, and `-(-a)` would
        // spell `--a`, which is a decrement in GLSL.
        if (full) return `(-${r(x.a)})`
        return wrap(`-${go(x.a, PREC_ATOM)}`, PREC_UNARY)
      case 'compare':
        return `(${r(x.a)} ${x.cop} ${r(x.b)})`
      case 'logical':
        return `(${r(x.a)} ${x.lop} ${r(x.b)})`
      default:
        // Leaves never wrap — every one of them already spells as a single
        // postfix/primary term. They still choose their CHILDREN's positions:
        // an argument sits inside `(…)` or after a `,`, so it accepts anything
        // (`need` 1), while a `.field` / `[i]` BASE must be a primary — the
        // corpus really does contain `((h*h)*(i-(h*2.))).y`, and `a*b.y` is a
        // different expression.
        return emitLeaf(
          x,
          be,
          (y) => r(y),
          (y) => go(y, full ? 0 : PREC_ATOM),
        )
    }
  }
  return go(e, 0)
}

/** The non-operator half of the walk. `arg` renders a child in a position that
 *  accepts any operator; `base` one that demands a primary. */
function emitLeaf(
  e: Exclude<Expr, { op: 'binop' | 'unop' | 'compare' | 'logical' }>,
  be: Backend,
  r: (x: Expr) => string,
  base: (x: Expr) => string,
): string {
  switch (e.op) {
    case 'lit':
      return be.literal(e.value, e.type)
    case 'constref':
    case 'overrideref':
    case 'externref':
    case 'param':
    case 'varref':
      // `overrideref` (#923) emits as the bare name on BOTH backends — the WGSL
      // `override` identifier and the GLSL `#define` macro share the declared name.
      // `externref` (#1713) likewise: its per-target spelling was already resolved into
      // `.name` by `spellExterns` during lowering, so the walk stays target-neutral.
      return e.name
    case 'call':
      return be.intrinsic(e.fn, e.args.map(r))
    case 'member':
      return `${base(e.base)}.${e.field}`
    case 'construct':
      return `${be.typeName(e.type)}(${e.args.map(r).join(', ')})`
    // select(false, true, cond) — the writer owns the spelling (WGSL select() vs
    // GLSL ternary). Args passed in WGSL's (false, true, cond) order.
    case 'select':
      return be.intrinsic('select', [r(e.ifFalse), r(e.ifTrue), r(e.cond)])
    case 'index':
      return `${base(e.base)}[${r(e.idx)}]`
    // matchExpr is consumed by the neutral pre-emit pass (passes/match-lower.ts)
    // before emit. If one leaks through, that pass was bypassed — fail loudly.
    case 'matchExpr':
      throw new Error(
        'shader-dsl: matchExpr Expr leaked into emitExpr — lowerModule should have hoisted it',
      )
  }
}

export function emitStmt(s: Stmt, depth: number, be: Backend, parens: ParenMode = 'full'): string {
  const p = pad(depth)
  const r = (x: Expr) => emitExpr(x, be, parens)
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
        lines.push(emitBody(arm.body, depth + 1, be, parens))
      })
      if (s.elseBody) {
        lines.push(`${p}} else {`)
        lines.push(emitBody(s.elseBody, depth + 1, be, parens))
      }
      lines.push(`${p}}`)
      return lines.filter((l) => l.length > 0).join('\n')
    }
    case 'for': {
      const init = forHeader(s.init, be, parens)
      const update = forHeader(s.update, be, parens)
      return `${p}for (${init}; ${r(s.cond)}; ${update}) {\n${emitBody(s.body, depth + 1, be, parens)}\n${p}}`
    }
    case 'placeholder':
      return `${p}${be.placeholderStmt(s.tag)}`
    case 'raw':
      return `${p}${be.rawStmt(s)}`
    case 'switch': {
      const lines: string[] = [`${p}${be.switchHead(r(s.scrut))}`]
      for (const c of s.cases) {
        lines.push(`${pad(depth + 1)}case ${be.caseLabel(c.value, s.scrut.type)}: {`)
        lines.push(emitBody(c.body, depth + 2, be, parens))
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
      if (s.defaultBody) lines.push(emitBody(s.defaultBody, depth + 2, be, parens))
      lines.push(`${pad(depth + 1)}}`)
      lines.push(`${p}}`)
      return lines.join('\n')
    }
  }
}

export function emitBody(
  body: readonly Stmt[],
  depth: number,
  be: Backend,
  parens: ParenMode = 'full',
): string {
  return body.map((s) => emitStmt(s, depth, be, parens)).join('\n')
}

// For-loop header init/update: a var/assign WITHOUT trailing `;` or indentation.
export function forHeader(s: Stmt, be: Backend, parens: ParenMode = 'full'): string {
  const r = (x: Expr) => emitExpr(x, be, parens)
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
  assertBuiltins(be, m) // …and its builtin-vocabulary twin (#1672)
  // matchExpr→{var slot, Stmt.switch} lowering first so the rest of the emitter stays
  // matchExpr-unaware (identity for modules with no matchExpr); fp64Lower then rewrites
  // every f64 into vec2<f32> + df64_* calls (identity for modules with no f64) — HERE,
  // before the optimizer, so every backend lowers identically and the optimizer only
  // sees ordinary vec2/f32 IR plus opaque df64_* calls. Auto-cache (cse, in the
  // WGSL backend's optimize) then hoists any input-only subexpression reused ≥2x into one
  // shared `let`, so authors write plain inline expressions and the reuse is bound for them.
  // `level` overrides the backend's default optimizer tier (used by the measurement A/B and
  // debug emit); omitted → the backend's own `optimize` (= O2 fixpoint), the production path.
  const pre = spellExterns(
    fp64Lower(lowerModule(autoVars(m)), fp64Flavor ? { flavor: fp64Flavor } : undefined),
    be,
  )
  return level === undefined ? be.optimize(pre) : optimizeAt(pre, level)
}

/** Resolve each `externref` to the spelling THIS target's host uses (#1713).
 *
 *  Done as a lowering pass rather than in `emitLeaf` because the spelling lives on the
 *  DECLARATION and the emit walk only ever sees the Expr — threading the module through
 *  the walk to look it up would widen the neutral emitter's contract for one node kind.
 *  Identity for every module with no externs, and for every extern whose host spells it
 *  the same on both targets, so nothing else changes bytes. */
function spellExterns(m: ModuleDecl, be: Backend): ModuleDecl {
  const map = new Map<string, string>()
  for (const e of m.externs ?? []) {
    const to = be.id === 'wgsl' ? e.spelling?.wgsl : e.spelling?.glsl
    if (to !== undefined && to !== e.name) map.set(e.name, to)
  }
  if (map.size === 0) return m
  const rE = (e: Expr): Expr =>
    mapExpr(e, (x) =>
      x.op === 'externref' && map.has(x.name) ? { ...x, name: map.get(x.name)! } : x,
    )
  return { ...m, funcs: m.funcs.map((f) => ({ ...f, body: f.body.map((s) => mapStmt(s, rE)) })) }
}

/** Assemble an ALREADY-lowered module into a target string: the declaration assembly
 *  (consts → structs → bindings → funcs, only non-empty sections), joined `\n\n` with a
 *  trailing newline. Split out of `emitModule` so the string and the reflection can be
 *  derived from the SAME lowered module (see `emitModuleWithReflection`). */
function assembleLowered(lowered: ModuleDecl, be: Backend, parens: ParenMode = 'full'): string {
  const parts: string[] = []
  // #923 — specialization-constant declarations lead the module (WGSL `override`
  // lines): they are module-scope constants a later const/fn may reference. Skipped
  // when the module declares none, so override-free emit stays byte-identical.
  if (lowered.overrides?.length && be.emitOverride)
    parts.push(lowered.overrides.map((o) => be.emitOverride!(o)).join('\n'))
  if (lowered.consts.length) parts.push(lowered.consts.map((c) => be.emitConst(c)).join('\n'))
  if (lowered.structs.length) parts.push(lowered.structs.map((s) => be.emitStruct(s)).join('\n\n'))
  if (lowered.bindings.length) parts.push(lowered.bindings.map((b) => be.emitBinding(b)).join('\n'))
  if (lowered.funcs.length)
    parts.push(lowered.funcs.map((f) => be.emitFunc(f, parens)).join('\n\n'))
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
  /** How much parenthesis the expression walk writes: `'full'` (default — the
   *  historical bytes, every operator wrapped) or `'minimal'`, which omits a
   *  paren wherever operator precedence already implies the same parse. A
   *  BUILD-TIME knob like `floatPrecision` (#1673), not a plugin: parenthesis is
   *  an emit decision, not a rewrite of emitted text. Pair it with
   *  `{ plugins: obfuscate() }` for the smallest shipped shader. */
  readonly parens?: ParenMode
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

/** The backend's directive header, ready to PREPEND (#1670). `modulePreamble` returns
 *  bare directive lines with no trailing separator (backend.ts — one contract for every
 *  target); this driver's slot puts a blank line between them and the first declaration,
 *  and contributes nothing at all when the module directs nothing, so an enables-free
 *  emit stays byte-identical. */
function directiveHeader(be: Backend, m: ModuleDecl): string {
  const pre = be.modulePreamble?.(m) ?? ''
  return pre ? `${pre}\n\n` : ''
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
  return directiveHeader(be, m) + applyTextPlugins(assembleLowered(lowered, be, opts?.parens), opts)
}

/** Emit a ModuleDecl as a header-less FRAGMENT for `be` (#1711) — the declaration
 *  assembly without the directive header and, unless `entryPoints` is true, without the
 *  stage entry points. The directives come back as `preamble` lines for the composer to
 *  merge rather than being concatenated into source it would have to strip.
 *
 *  WGSL needs no header/body split beyond this: its only preamble is the `enable`
 *  directives, and it has no stage wrapper — an entry is an ordinary function with an
 *  attribute. GLSL's split is genuinely structural and lives in `emitGlslFragment`.
 *
 *  Unlike `emitFuncs`, this runs the whole pre-emit pipeline (`validate` → `assertCaps` →
 *  `assertBuiltins` → lowering → optimize), so a fragment cannot silently skip the gates
 *  a whole-module emit enforces. That is the reason to prefer it over hand-concatenating
 *  per-declaration emitters. */
export function emitModuleFragment(
  m: ModuleDecl,
  be: Backend,
  opts?: EmitOptions & { entryPoints?: boolean },
): EmitFragment {
  const lowered = applyIRPlugins(lowerForBackend(m, be, undefined, opts?.fp64Flavor), opts)
  const entries = lowered.funcs.filter((f) => stageOf(f) !== undefined)
  const kept =
    opts?.entryPoints === true
      ? lowered.funcs
      : lowered.funcs.filter((f) => stageOf(f) === undefined)
  const pre = be.modulePreamble?.(m) ?? ''
  return {
    source: applyTextPlugins(assembleLowered({ ...lowered, funcs: kept }, be, opts?.parens), opts),
    preamble: pre ? pre.split('\n').filter((l) => l !== '') : [],
    declares: {
      functions: kept.filter((f) => stageOf(f) === undefined).map((f) => f.name),
      structs: lowered.structs.map((s) => s.name),
      bindings: lowered.bindings.map((b) => b.name),
      consts: lowered.consts.map((c) => c.name),
      overrides: (lowered.overrides ?? []).map((o) => o.name),
      entryPoints: entries.map((f) => f.name),
    },
    requires: fragmentRequires(lowered, kept, be.id === 'wgsl' ? 'wgsl' : 'glsl'),
  }
}

/** Emit a ModuleDecl at an explicit optimization level (O0/O1/O2) instead of the
 *  backend's default. `emitModuleAt(m, be, 'O2')` is byte-identical to `emitModule(m, be)`
 *  (both run the full fixpoint); O0 emits the naive lowered module. Used by the emit-size
 *  measurement (measure.ts) to A/B the optimizer and for debug builds. NOTE: the GLSL
 *  backend assembles uniform UBOs via its own emitGlslModule, so this WGSL-style assembly
 *  is for the WGSL backend (and any backend whose bindings need no special assembly). */
export function emitModuleAt(m: ModuleDecl, be: Backend, level: OptLevel): string {
  return directiveHeader(be, m) + assembleLowered(lowerForBackend(m, be, level), be)
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
    code: directiveHeader(be, m) + assembleLowered(lowered, be),
    reflection: reflect(lowered),
  }
}
