// ═══ Shader DSL — semantic diff over IR + reflection (#1714) ═══
//
// Compares two modules at the layer a REVIEWER cares about — interface, resources,
// constants, control-flow shape — instead of at the byte layer, where constant
// folding, CSE, auto-vars, declaration order and generated temp names dominate the
// diff and a semantic regression is indistinguishable from a formatting change.
//
// Input is a ModuleDecl, never emitted text: the whole point is to compare ABOVE the
// noise the backends and optimizer passes introduce. Byte-level comparison already
// has an owner (examples/emit-goldens.test.ts).
//
// NO `target` OPTION, deliberately. #1714 proposed one, for a cross-backend arm
// asserting "the GLSL emit and the WGSL emit agree". That arm is vacuous as written:
// reflect() takes a ModuleDecl and never a backend (reflect.ts), so both sides of
// that comparison are the same value and it can never go red. The real cross-backend
// question — does each backend's emitted SOURCE agree with the reflection describing
// it — needs to read emitted text and is tracked separately on that issue.
//
// `ignore` carries 'names' and 'declOrder' and NOT the proposed 'temporaries'. An
// optimizer-introduced temporary is either just a local name (already covered by
// 'names') or a real change to the statement tree — and a knob that discards the
// latter would hide exactly the regressions this exists to catch. A flag that cannot
// distinguish the states it claims to control is the §12 "assertion that failed
// either way" at the API layer, so it is absent rather than accepted-and-ignored.
//
// CLASSIFICATION, NOT A BLIND IGNORE (#1806). A consumer's parity gate compares the
// DEV module against the PRODUCTION one, and the production emit runs semantics-
// preserving IR transforms (`inline()`, `mangle()`) — so the optimizer's own rewrite
// lands in `controlFlow`/`constants` and spends the same mismatch budget a real
// backend regression does. `transforms` answers that BY CONSTRUCTION: declare the
// plugins that were actually applied and each one is RE-RUN on both modules; whatever
// difference it removes is reported under `semanticsPreservingTransform` — naming the
// plugin, the bucket, and the fact lines — and whatever survives stays fail-able.
//
// REJECTED — recognising an inline / CSE / temp-var rewrite from the SHAPE of the diff
// lines. That is a heuristic over the exact evidence a real regression also produces:
// a genuine control-flow change looks like an inline, so it would launder precisely the
// mismatches this file exists to catch. Re-running the declared pass cannot, because a
// difference is excused only when the pass itself reproduces it. The classification is
// therefore never stronger than the pass's own semantics-preservation contract, which
// is where it belongs — inline-linear.ts states that contract and its own suite pins it
// against the CPU oracle.
//
// BOTH SIDES are transformed, not just `a`. A parity harness must answer the same for
// (dev, prod) and (prod, dev), and the passes are fixed points on their own output —
// `inlineLinearAll` leaves nothing inlinable behind, `mangleModule` re-mangles to the
// same positional names — so re-running one on an already-transformed side is a no-op.
// That is also what keeps a PROD-vs-PROD comparison (the cross-backend arm, where both
// sides already ran the plugins) fully fail-able: neither side moves, so every backend
// difference stays in the four buckets.

import { typeKey, type ShaderType } from './ir/types'
import {
  stageOf,
  type ConstDecl,
  type Expr,
  type FuncDecl,
  type ModuleDecl,
  type Stmt,
} from './ir/nodes'
import { reflect } from './reflect'
import type { EmitPlugin } from './emit'

/** An axis of difference `semanticDiff` can be told to disregard.
 *
 *  - `'names'` — the spelling of every INTERNAL identifier: helper function names,
 *    non-binding struct names, module const names, and function-scoped params/locals.
 *    Deliberately the same partition `mangleModule` is free to rewrite; ABI names
 *    (entry points and their params, binding names, binding struct names, struct
 *    FIELD names, override names, intrinsic call ids) are compared either way,
 *    because a host binds by them.
 *  - `'declOrder'` — the position of a declaration or statement within its list. */
export type SemanticAspect = 'names' | 'declOrder'

/** The four fail-able buckets, in report order. Single authority: `diffBuckets` builds
 *  its result by iterating this, so a bucket that is added to {@link SemanticDiff} and
 *  not to this list fails to typecheck rather than going silently uncompared. */
const BUCKETS = ['interface', 'resources', 'constants', 'controlFlow'] as const

/** Which fail-able bucket of {@link SemanticDiff} a difference belongs to. */
export type SemanticBucket = (typeof BUCKETS)[number]

/** Options for {@link semanticDiff}. */
export interface SemanticDiffOptions {
  /** Axes to disregard. Defaults to `['names', 'declOrder']`. Pass `[]` to compare
   *  identifier spelling and declaration order too. */
  readonly ignore?: readonly SemanticAspect[]
  /** The semantics-preserving IR transforms the production side was built with — pass
   *  the SAME `plugins` array the emit call was given (`[inline(), ...obfuscate()]`).
   *  Each is re-run, in order, on BOTH modules; a difference it removes is reported
   *  under {@link SemanticDiff.semanticsPreservingTransform} instead of spending the
   *  mismatch budget of the four fail-able buckets. A plugin with no `transformIR` (a
   *  text-stage pass such as `minify()`) is skipped — this comparator never reads
   *  emitted text. Absent or empty ⇒ every difference stays fail-able, unchanged.
   *
   *  `transformIR` is run here on the modules you passed in, so it must be PURE
   *  (module → module) — as every plugin shipped on `/emit-prod` is. */
  readonly transforms?: readonly EmitPlugin[]
}

/** One classified difference: an axis of the diff that a DECLARED transform reproduces,
 *  and which therefore left the fail-able buckets. This is the provenance a parity
 *  report keeps so a reviewer can see WHY a difference was excused. */
export interface TransformFinding {
  /** The declared plugin's own `name` — `'inline'`, `'mangle'`, whatever it calls
   *  itself. Attribution is per plugin, not per chain: a later plugin is credited only
   *  with what it removed on top of the earlier ones. */
  readonly transform: string
  /** The bucket these facts were in before this transform ran. */
  readonly bucket: SemanticBucket
  /** The fact lines the transform accounts for, verbatim and `-`/`+` prefixed exactly
   *  as the fail-able buckets spell them, so a report can print them side by side. */
  readonly facts: readonly string[]
}

/** The four fail-able buckets of difference, plus the classified ones. Each fail-able
 *  entry is a fact line prefixed `-` (present in `a`, absent from `b`) or `+` (the
 *  reverse). All four empty ⇒ the modules agree on everything this comparator inspects
 *  — see {@link isSemanticallyEqual}. */
export interface SemanticDiff {
  /** Entry-point signatures and the vertex attribute layout. */
  readonly interface: readonly string[]
  /** Bind groups, std140/std430 struct layouts, and required capabilities. */
  readonly resources: readonly string[]
  /** Module consts, pipeline overrides, and the multiset of numeric literals in
   *  function bodies. A literal's VALUE is reported here and nowhere else — the
   *  control-flow skeleton elides it — so changing a constant and changing the shape
   *  of the code around it are distinguishable. */
  readonly constants: readonly string[]
  /** Per-statement control-flow skeleton, one line per statement, addressed by path. */
  readonly controlFlow: readonly string[]
  /** Differences a transform declared in {@link SemanticDiffOptions.transforms}
   *  reproduces on both sides, and which therefore left the four buckets above. Empty
   *  unless `transforms` is passed, so a caller that does not opt in sees exactly the
   *  fail-able set it saw before. {@link isSemanticallyEqual} deliberately does not
   *  consult it: an optimizer rewriting its own input is not a regression, and the
   *  point is that it stops spending the budget one does. */
  readonly semanticsPreservingTransform: readonly TransformFinding[]
}

/** True when every FAIL-ABLE bucket of `d` is empty — the modules agree modulo the
 *  transforms that were declared. `semanticsPreservingTransform` is not consulted, for
 *  the reason its own doc gives; read it when you want to review what was excused. */
export const isSemanticallyEqual = (d: SemanticDiff): boolean =>
  d.interface.length === 0 &&
  d.resources.length === 0 &&
  d.constants.length === 0 &&
  d.controlFlow.length === 0

// ── canonical naming ──────────────────────────────────────────────────────────
//
// Mirrors mangleModule's partition exactly (mangle.ts's header states the ABI
// boundary this derives from): helper fns, non-binding structs, module consts and
// function-scoped names are internal and get positional canonical ids; everything
// else keeps its authored spelling. Positional ids are safe against mangling because
// mangle preserves declaration order, so the i-th internal decl on each side is the
// same decl.

interface Canon {
  readonly fns: ReadonlyMap<string, string>
  readonly structs: ReadonlyMap<string, string>
  readonly consts: ReadonlyMap<string, string>
  readonly locals: ReadonlyMap<string, ReadonlyMap<string, string>>
}

const EMPTY_CANON: Canon = {
  fns: new Map(),
  structs: new Map(),
  consts: new Map(),
  locals: new Map(),
}

/** Names DECLARED by a body — the `let`/`var` binding sites, in source order.
 *  Mirrors mangle's own collector; a Set so a shadowed spelling counts once. */
function declaredNames(body: readonly Stmt[], acc: Set<string>): void {
  for (const s of body) {
    if (s.s === 'let' || s.s === 'var') acc.add(s.name)
    else if (s.s === 'if') {
      for (const a of s.arms) declaredNames(a.body, acc)
      if (s.elseBody) declaredNames(s.elseBody, acc)
    } else if (s.s === 'for') {
      declaredNames([s.init], acc)
      declaredNames(s.body, acc)
    } else if (s.s === 'switch') {
      for (const c of s.cases) declaredNames(c.body, acc)
      if (s.defaultBody) declaredNames(s.defaultBody, acc)
    }
  }
}

function buildCanon(m: ModuleDecl): Canon {
  const bindingStructs = new Set<string>()
  for (const b of m.bindings) if (b.type.kind === 'struct') bindingStructs.add(b.type.name)

  const fns = new Map<string, string>()
  let fi = 0
  for (const f of m.funcs) if (stageOf(f) === undefined) fns.set(f.name, `fn#${fi++}`)

  const structs = new Map<string, string>()
  let si = 0
  for (const s of m.structs) if (!bindingStructs.has(s.name)) structs.set(s.name, `st#${si++}`)

  const consts = new Map<string, string>()
  let ci = 0
  for (const c of m.consts) consts.set(c.name, `k#${ci++}`)

  const locals = new Map<string, ReadonlyMap<string, string>>()
  for (const f of m.funcs) {
    const declared = new Set<string>()
    if (stageOf(f) === undefined) for (const p of f.params) declared.add(p.name)
    declaredNames(f.body, declared)
    const scoped = new Map<string, string>()
    let vi = 0
    for (const name of declared) scoped.set(name, `v#${vi++}`)
    locals.set(f.name, scoped)
  }
  return { fns, structs, consts, locals }
}

/** Canonicalize struct names inside a type, then spell it through `typeKey` — the
 *  single authority for type spelling, so this never becomes a second one. */
const typeSig = (t: ShaderType, c: Canon): string => typeKey(canonType(t, c))

function canonType(t: ShaderType, c: Canon): ShaderType {
  if (t.kind === 'struct') {
    const to = c.structs.get(t.name)
    return to === undefined ? t : { ...t, name: to }
  }
  if (t.kind === 'array') {
    const elem = canonType(t.elem, c)
    return elem === t.elem ? t : { ...t, elem }
  }
  return t
}

/** `reflect()` hands back type strings already spelled by `typeKey`, so a nested
 *  non-binding struct appears there as `struct:<name>`. Rewrite that one token rather
 *  than re-deriving the layout. */
const subStructs = (s: string, c: Canon): string =>
  c.structs.size === 0
    ? s
    : s.replace(/struct:([A-Za-z_][A-Za-z0-9_]*)/g, (all, n: string) => {
        const to = c.structs.get(n)
        return to === undefined ? all : `struct:${to}`
      })

// ── fact extraction ───────────────────────────────────────────────────────────

function interfaceFacts(m: ModuleDecl, c: Canon): string[] {
  const r = reflect(m)
  const out: string[] = []
  for (const e of r.entries) {
    const inputs = e.inputs.map((i) => subStructs(i, c)).join(',')
    out.push(
      `entry ${e.name} stage=${e.stage} wg=${e.workgroupSize ?? '-'} in=[${inputs}] out=${subStructs(e.output, c)}`,
    )
  }
  if (r.vertex) {
    out.push(`vertex stride=${r.vertex.arrayStride}`)
    for (const a of r.vertex.attributes)
      out.push(`vertex.attr ${a.name} loc=${a.location} ${subStructs(a.type, c)} off=${a.offset}`)
  }
  return out
}

function resourceFacts(m: ModuleDecl, c: Canon): string[] {
  const r = reflect(m)
  const out: string[] = []
  for (const g of r.bindGroups)
    for (const e of g.entries)
      out.push(
        `bind ${e.group}:${e.binding} ${e.name} ${e.space}${e.access ? '/' + e.access : ''} ` +
          `${e.resourceKind} struct=${e.structName ?? '-'} dim=${e.textureDim ?? '-'} elem=${e.textureElem ?? '-'}`,
      )
  for (const [kind, layouts] of [
    ['std140', r.uniforms],
    ['std430', r.storage],
  ] as const)
    for (const l of layouts) {
      out.push(
        `layout ${kind} ${subStructs(`struct:${l.name}`, c)} size=${l.size} align=${l.align}`,
      )
      for (const f of l.fields)
        out.push(
          `field ${l.name}.${f.name} ${subStructs(f.type, c)} off=${f.offset} align=${f.align} size=${f.size}`,
        )
    }
  for (const cap of r.requiredFeatures) out.push(`cap ${cap}`)
  return out
}

/** Literal VALUES, as a multiset — the control-flow skeleton elides them. */
function literalFacts(m: ModuleDecl, c: Canon): string[] {
  const out: string[] = []
  const walkE = (e: Expr): void => {
    if (e.op === 'lit') out.push(`lit ${typeSig(e.type, c)}=${String(e.value)}`)
    for (const sub of subExprs(e)) walkE(sub)
  }
  for (const f of m.funcs) for (const s of f.body) walkStmtExprs(s, walkE)
  return out
}

function constantFacts(m: ModuleDecl, c: Canon): string[] {
  const out: string[] = []
  for (const o of m.overrides ?? [])
    out.push(`override ${o.name} ${typeSig(o.type, c)} = ${String(o.default)}`)
  for (const k of m.consts) out.push(constFact(k, c))
  out.push(...literalFacts(m, c))
  return out
}

const constFact = (k: ConstDecl, c: Canon): string =>
  `const ${c.consts.get(k.name) ?? k.name} ${typeSig(k.type, c)} ` +
  `wgsl=${k.wgslValue} cpu=${k.cpuValue}` +
  (k.valueExpr === undefined ? '' : ` expr=${exprSig(k.valueExpr, c, new Map())}`)

// ── control-flow skeleton ─────────────────────────────────────────────────────

/** Direct sub-expressions of `e`. One place knows the Expr shape, mirroring
 *  collect-refs' single-exhaustive-switch discipline: a new op that carries children
 *  and is not added here shows up as a leaf rather than being silently half-walked. */
function subExprs(e: Expr): readonly Expr[] {
  switch (e.op) {
    case 'call':
    case 'construct':
      return e.args
    case 'binop':
    case 'compare':
    case 'logical':
      return [e.a, e.b]
    case 'unop':
      return [e.a]
    case 'member':
      return [e.base]
    case 'index':
      return [e.base, e.idx]
    case 'select':
      return [e.cond, e.ifTrue, e.ifFalse]
    case 'matchExpr':
      return [e.scrutinee, ...e.cases.map(([, v]) => v), e.default]
    default:
      return [] // lit / constref / overrideref / param / varref
  }
}

/** Every Expr directly held by a statement (not descending into nested bodies). */
function walkStmtExprs(s: Stmt, f: (e: Expr) => void): void {
  switch (s.s) {
    case 'let':
      f(s.expr)
      break
    case 'var':
      if (s.init !== undefined) f(s.init)
      break
    case 'assign':
    case 'assignOp':
      f(s.target)
      f(s.expr)
      break
    case 'return':
      if (s.expr !== undefined) f(s.expr)
      break
    case 'if':
      for (const a of s.arms) {
        f(a.cond)
        for (const b of a.body) walkStmtExprs(b, f)
      }
      if (s.elseBody) for (const b of s.elseBody) walkStmtExprs(b, f)
      break
    case 'for':
      walkStmtExprs(s.init, f)
      f(s.cond)
      walkStmtExprs(s.update, f)
      for (const b of s.body) walkStmtExprs(b, f)
      break
    case 'switch':
      f(s.scrut)
      for (const cs of s.cases) for (const b of cs.body) walkStmtExprs(b, f)
      if (s.defaultBody) for (const b of s.defaultBody) walkStmtExprs(b, f)
      break
    default:
      break // break / continue / discard / placeholder / raw
  }
}

/** Structural spelling of an expression: op kinds, operators, types and ABI names.
 *  A literal's VALUE is elided (`lit`) — values live in the `constants` bucket, so a
 *  changed number and a changed shape land in different buckets. */
function exprSig(e: Expr, c: Canon, locals: ReadonlyMap<string, string>): string {
  const t = typeSig(e.type, c)
  const kids = (): string =>
    subExprs(e)
      .map((k) => exprSig(k, c, locals))
      .join(' ')
  switch (e.op) {
    case 'lit':
      return `(lit:${t})`
    case 'constref':
      return `(const ${c.consts.get(e.name) ?? e.name}:${t})`
    case 'overrideref':
      return `(override ${e.name}:${t})`
    // #1713 — a host-provided global's name is ABI (the host's prelude spells it), so it is
    // compared even under `ignore: ['names']`, same as an override.
    case 'externref':
      return `(extern ${e.name}:${t})`
    case 'param':
    case 'varref':
      return `(${e.op} ${locals.get(e.name) ?? e.name}:${t})`
    case 'binop':
      return `(${e.bop}:${t} ${kids()})`
    case 'compare':
      return `(${e.cop}:${t} ${kids()})`
    case 'logical':
      return `(${e.lop}:${t} ${kids()})`
    case 'call':
      return `(call ${c.fns.get(e.fn) ?? e.fn}:${t} ${kids()})`
    case 'member':
      return `(.${e.field}:${t} ${kids()})`
    case 'matchExpr':
      return `(match:${t} [${e.cases.map(([v]) => v).join(',')}] ${kids()})`
    default:
      return `(${e.op}:${t} ${kids()})`
  }
}

function stmtSig(s: Stmt, c: Canon, locals: ReadonlyMap<string, string>): string {
  const E = (e: Expr): string => exprSig(e, c, locals)
  switch (s.s) {
    case 'let':
      return `let ${locals.get(s.name) ?? s.name} = ${E(s.expr)}`
    case 'var':
      return `var ${locals.get(s.name) ?? s.name}: ${typeSig(s.type, c)}${s.init === undefined ? '' : ' = ' + E(s.init)}`
    case 'assign':
      return `assign ${E(s.target)} = ${E(s.expr)}`
    case 'assignOp':
      return `assign${s.bop} ${E(s.target)} = ${E(s.expr)}`
    case 'return':
      return `return${s.expr === undefined ? '' : ' ' + E(s.expr)}`
    case 'if':
      return `if arms=${s.arms.length} else=${s.elseBody ? 'y' : 'n'} conds=[${s.arms.map((a) => E(a.cond)).join(' ')}]`
    case 'for':
      return `for cond=${E(s.cond)}`
    case 'switch':
      return `switch ${E(s.scrut)} cases=[${s.cases.map((k) => k.value).join(',')}] default=${s.defaultBody ? 'y' : 'n'}`
    case 'placeholder':
      return `placeholder ${s.tag}`
    case 'raw':
      return `raw wgsl=${s.wgsl === undefined ? 'n' : 'y'} glsl=${s.glsl === undefined ? 'n' : 'y'}`
    default:
      return s.s // break / continue / discard
  }
}

/** One line per statement, addressed by its path in the tree, so a diff names the
 *  statement that moved rather than reporting one giant per-function blob. */
function bodyLines(
  body: readonly Stmt[],
  path: string,
  c: Canon,
  locals: ReadonlyMap<string, string>,
  out: string[],
): void {
  body.forEach((s, i) => {
    const p = `${path}${i}`
    out.push(`${p} ${stmtSig(s, c, locals)}`)
    if (s.s === 'if') {
      s.arms.forEach((a, ai) => bodyLines(a.body, `${p}.arm${ai}.`, c, locals, out))
      if (s.elseBody) bodyLines(s.elseBody, `${p}.else.`, c, locals, out)
    } else if (s.s === 'for') {
      bodyLines([s.init], `${p}.init.`, c, locals, out)
      bodyLines([s.update], `${p}.update.`, c, locals, out)
      bodyLines(s.body, `${p}.body.`, c, locals, out)
    } else if (s.s === 'switch') {
      s.cases.forEach((k, ki) => bodyLines(k.body, `${p}.case${ki}.`, c, locals, out))
      if (s.defaultBody) bodyLines(s.defaultBody, `${p}.default.`, c, locals, out)
    }
  })
}

function fnHeader(f: FuncDecl, c: Canon, locals: ReadonlyMap<string, string>): string {
  const stage = stageOf(f)
  const params = f.params
    .map(
      (p) =>
        `${stage === undefined ? (locals.get(p.name) ?? p.name) : p.name}:${typeSig(p.type, c)}` +
        `${p.builtin ? '@' + p.builtin : ''}${p.location === undefined ? '' : '@loc' + p.location}`,
    )
    .join(',')
  return `fn ${c.fns.get(f.name) ?? f.name}(${params}) -> ${typeSig(f.ret, c)} stage=${stage ?? '-'}`
}

function controlFlowFacts(m: ModuleDecl, c: Canon): string[] {
  const out: string[] = []
  for (const f of m.funcs) {
    const locals = c.locals.get(f.name) ?? new Map<string, string>()
    const name = c.fns.get(f.name) ?? f.name
    out.push(fnHeader(f, c, locals))
    const lines: string[] = []
    bodyLines(f.body, '', c, locals, lines)
    for (const l of lines) out.push(`${name}#${l}`)
  }
  return out
}

// ── diffing ───────────────────────────────────────────────────────────────────

/** Multiset difference. With order significant each line is index-tagged first, so a
 *  pure reordering shows up as a pair of moves rather than silently cancelling. */
function diffFacts(a: readonly string[], b: readonly string[], ignoreOrder: boolean): string[] {
  const key = (xs: readonly string[]): string[] =>
    ignoreOrder ? [...xs].sort() : xs.map((x, i) => `@${i} ${x}`)
  const left = key(a)
  const right = key(b)
  const counts = new Map<string, number>()
  for (const x of left) counts.set(x, (counts.get(x) ?? 0) + 1)
  for (const x of right) counts.set(x, (counts.get(x) ?? 0) - 1)
  const out: string[] = []
  for (const [line, n] of counts) {
    for (let i = 0; i < n; i++) out.push(`-${line}`)
    for (let i = 0; i < -n; i++) out.push(`+${line}`)
  }
  return out.sort()
}

/** Every fact line of `m`, per bucket. `canonical` is the `'names'` ignore axis. */
function factsOf(m: ModuleDecl, canonical: boolean): Record<SemanticBucket, readonly string[]> {
  const c = canonical ? buildCanon(m) : EMPTY_CANON
  return {
    interface: interfaceFacts(m, c),
    resources: resourceFacts(m, c),
    constants: constantFacts(m, c),
    controlFlow: controlFlowFacts(m, c),
  }
}

/** The four buckets, diffed. */
function diffBuckets(
  a: ModuleDecl,
  b: ModuleDecl,
  canonical: boolean,
  ignoreOrder: boolean,
): Record<SemanticBucket, string[]> {
  const fa = factsOf(a, canonical)
  const fb = factsOf(b, canonical)
  const out = {} as Record<SemanticBucket, string[]>
  for (const k of BUCKETS) out[k] = diffFacts(fa[k], fb[k], ignoreOrder)
  return out
}

/** Multiset difference `before \ after` — the lines a step ACCOUNTED FOR. A line the
 *  step introduced (in `after`, not in `before`) is deliberately not credited back:
 *  it stays in the residual, so a transform that makes a comparison worse is reported
 *  rather than excused. */
function accountedFor(before: readonly string[], after: readonly string[]): string[] {
  const remaining = new Map<string, number>()
  for (const x of after) remaining.set(x, (remaining.get(x) ?? 0) + 1)
  const out: string[] = []
  for (const x of before) {
    const n = remaining.get(x) ?? 0
    if (n > 0) remaining.set(x, n - 1)
    else out.push(x)
  }
  return out
}

/**
 * Compare two modules at the IR + reflection layer, ignoring the noise that makes a
 * textual golden diff unreadable after the optimizer and the production emit plugins
 * have run.
 *
 * Reports four buckets — entry/vertex `interface`, bind-group and layout `resources`,
 * `constants` (module consts, overrides, and the multiset of body literals), and the
 * per-statement `controlFlow` skeleton. Empty in all four means the two modules agree
 * on everything a host binds to and everything the code does.
 *
 * The load-bearing invariant, and the reason `'names'` canonicalizes exactly the
 * identifiers `mangleModule` is free to rewrite:
 *
 * ```ts
 * isSemanticallyEqual(semanticDiff(m, mangleModule(m).module)) // always true
 * ```
 *
 * `obfuscate()`'s only IR-stage plugin is `mangle` (the rest transform text), so that
 * invariant is what lets a consumer assert "the production emit is the dev emit,
 * optimized" rather than trusting it.
 *
 * A pass that legitimately changes the program — `inline()`, or const-folding between
 * optimization levels — is NOT expected to be empty here, and that is the point: those
 * rewrite literals and branch structure, which is precisely what this reports. DECLARE
 * such a pass in `transforms` and it is re-run on both modules, so the difference it
 * reproduces moves to `semanticsPreservingTransform` — classified with the plugin that
 * caused it, never silently dropped, and never at the cost of a difference the pass does
 * NOT reproduce, which stays in the four fail-able buckets:
 *
 * ```ts
 * const plugins = [inline(), ...obfuscate()] // the SAME array the prod emit was given
 * const d = semanticDiff(devModule, prodModule, { transforms: plugins })
 * isSemanticallyEqual(d) // true — the optimizer's own rewrite is not a mismatch
 * d.semanticsPreservingTransform // …but it is still reported, per plugin and bucket
 * ```
 *
 * @param a - the reference module.
 * @param b - the module to compare against it.
 * @param opts - axes to disregard, and the production transforms to classify against;
 *   defaults to ignoring `names` and `declOrder` and declaring no transform.
 * @returns the four fail-able buckets, each `-`-prefixed for facts only in `a` and
 *   `+`-prefixed for facts only in `b`, plus whatever a declared transform accounts for.
 */
export function semanticDiff(
  a: ModuleDecl,
  b: ModuleDecl,
  opts?: SemanticDiffOptions,
): SemanticDiff {
  const ignore = new Set<SemanticAspect>(opts?.ignore ?? ['names', 'declOrder'])
  const canonical = ignore.has('names')
  const order = ignore.has('declOrder')

  let ma = a
  let mb = b
  let cur = diffBuckets(ma, mb, canonical, order)

  // Re-run each declared transform on BOTH sides and credit it with the difference it
  // removed. Per step, not per chain: a later plugin is credited only with what it
  // accounted for on top of the earlier ones, so the report names the transform a
  // reviewer has to reason about.
  const classified: TransformFinding[] = []
  for (const t of opts?.transforms ?? []) {
    const apply = t.transformIR
    if (apply === undefined) continue // a text-stage pass moves no IR fact
    ma = apply(ma)
    mb = apply(mb)
    const next = diffBuckets(ma, mb, canonical, order)
    for (const bucket of BUCKETS) {
      const facts = accountedFor(cur[bucket], next[bucket])
      if (facts.length > 0) classified.push({ transform: t.name, bucket, facts })
    }
    cur = next
  }
  return { ...cur, semanticsPreservingTransform: classified }
}
