// ═══ Shader DSL — function/statement builder ═══
//
// The imperative authoring surface: Builder (collects Stmt nodes via
// let/var/assign/if/for/switch/ret/…), the IfChain helper, and the fn /
// computeFn / entryFn / module assemblers. Imports types + nodes + node.

import { type ShaderType, type KeyOf, type ScalarKey } from './types'
import type { Stmt, Expr, BinOp, FuncDecl, ModuleDecl } from './nodes'
import { Node, type ArithArg, type NodeLike, lift, f32, i32, u32, callFn, installStmtSink } from './node'

export type ParamSpec = Record<string, ShaderType>
/** An entry-point param carrying a stage attribute — `builtin('vertex_index', u32T)` /
 *  `location(0, vec4fT)` (the SAME FieldSpec the ioStruct fields use). A plain ShaderType value is
 *  an ordinary param. Lets one `fn()` author both helpers and `@vertex`/`@fragment`/`@compute`
 *  entries from a single param record. */
type ParamAttr = { readonly type: ShaderType; readonly attr: string }
export type FnParamSpec = Record<string, ShaderType | ParamAttr>
type ParamTypeOf<E> = E extends ParamAttr ? E['type'] : E extends ShaderType ? E : never
type ParamNodes<P extends FnParamSpec> = { [K in keyof P]: Node<KeyOf<ParamTypeOf<P[K]>>> }

export class Builder {
  readonly stmts: Stmt[] = []

  // The auto-name counter is SHARED across a function's nested sub-builders (see
  // child()), so an omitted binding name gets a function-unique `_v{n}`. A per-block
  // counter would restart at _v0 inside each If/Loop body, letting an inner _v0 shadow
  // an outer one — and the outer binding's varref (captured at author time) would then
  // mis-resolve to the inner shadow. Function-scoped uniqueness rules that out. The
  // counter is per-function (reset on each root Builder), so the emit stays deterministic
  // across rebuilds — required by the byte-identical WGSL snapshot gates.
  constructor(private readonly autoNames: { n: number } = { n: 0 }) {}

  /** A nested-scope (If/Loop/Switch body) builder that SHARES this builder's
   *  auto-name counter, keeping `_v{n}` unique across the whole function. */
  child(): Builder { return new Builder(this.autoNames) }

  private autoName(): string { return `_v${this.autoNames.n++}` }

  private push(s: Stmt): void { this.stmts.push(s) }

  /** Immutable binding — `let name = expr;`. The name is OPTIONAL: omit it and the
   *  binding takes a function-unique auto name (`_v0`, `_v1`, …) — for when the JS
   *  const already carries the meaning (`const lon = let(expr)`) and repeating it as a
   *  string is redundant; the tradeoff is an opaque WGSL name. Returns a varref Node
   *  of the bound value's key. */
  let<K extends string>(value: Node<K>): Node<K>
  let<K extends string>(name: string, value: Node<K>): Node<K>
  let<K extends string>(nameOrValue: string | Node<K>, maybeValue?: Node<K>): Node<K> {
    const named = typeof nameOrValue === 'string'
    const name = named ? nameOrValue : this.autoName()
    const value = (named ? maybeValue : nameOrValue) as Node<K>
    this.push({ s: 'let', name, expr: value.expr })
    return new Node<K>({ op: 'varref', type: value.type, name })
  }

  /** Mutable binding — `var name: T = init?;`. The name is OPTIONAL (see let). */
  var<T extends ShaderType>(type: T, init?: Node<KeyOf<T>>): Node<KeyOf<T>>
  var<T extends ShaderType>(name: string, type: T, init?: Node<KeyOf<T>>): Node<KeyOf<T>>
  var<T extends ShaderType>(nameOrType: string | T, typeOrInit?: T | Node<KeyOf<T>>, maybeInit?: Node<KeyOf<T>>): Node<KeyOf<T>> {
    const named = typeof nameOrType === 'string'
    const name = named ? nameOrType : this.autoName()
    const type = (named ? typeOrInit : nameOrType) as T
    const init = (named ? maybeInit : typeOrInit) as Node<KeyOf<T>> | undefined
    this.push({ s: 'var', name, type, init: init?.expr })
    return new Node<KeyOf<T>>({ op: 'varref', type, name })
  }

  /** A `var` whose WGSL type is filled in AFTER its branch-assignments are authored — used by
   *  ifExpr/condExpr, where the type is the arms' value type (so the caller writes no type token).
   *  Returns the auto-named varref factory (typed once known) + a `commit(type)` that patches the
   *  emitted decl. The Stmt is pushed NOW (before the branches), patched before the build returns,
   *  so the emit always sees a fully-typed var — the typeless window is internal + synchronous. */
  inferredVar(): { ref: (type: ShaderType) => Node; commit: (type: ShaderType) => void; cancel: () => void } {
    const name = this.autoName()
    const stmt = { s: 'var' as const, name, type: undefined as unknown as ShaderType, init: undefined }
    this.push(stmt as Stmt)
    return {
      ref: (type) => new Node({ op: 'varref', type, name }),
      commit: (type) => { stmt.type = type },
      // Drop the pushed decl — for a Switch used as a STATEMENT (no case returned a value), the
      // reserved var is unused; removing it keeps the emit free of a stray typeless `var`.
      cancel: () => { const i = this.stmts.indexOf(stmt as Stmt); if (i >= 0) this.stmts.splice(i, 1) },
    }
  }

  assign<K extends string>(target: Node<K>, value: Node<K>): void {
    this.push({ s: 'assign', target: target.expr, expr: value.expr })
  }
  assignOp<K extends string>(target: Node<K>, bop: BinOp, value: ArithArg<K>): void {
    this.push({ s: 'assignOp', target: target.expr, bop, expr: lift(value).expr })
  }
  addAssign<K extends string>(target: Node<K>, value: ArithArg<K>): void { this.assignOp(target, '+', value) }

  ret(value?: Node): void { this.push({ s: 'return', expr: value?.expr }) }
  break(): void { this.push({ s: 'break' }) }
  continue(): void { this.push({ s: 'continue' }) }
  discard(): void { this.push({ s: 'discard' }) }
  /** Lay down a `{ s: 'placeholder', tag }` marker — the polygon DSL
   *  composer (emitPolygonWgsl) walks the cloned module and swaps each
   *  tagged placeholder for the variant's return-Stmts. Bare (un-swapped)
   *  placeholders emit `// __placeholder: ${tag}` per the defensive design
   *  in placeholder-stmt.test.ts. */
  placeholder(tag: string): void { this.push({ s: 'placeholder', tag }) }

  /** if / else-if / else chain. Returns a chainer so `.elif().else()` reads
   *  top-to-bottom. The If stmt is pushed on the first call and mutated in
   *  place by subsequent .elif/.else. */
  if(cond: Node<'bool'>, body: (b: Builder) => Node | void): IfChain {
    const arms: Array<{ cond: Expr; body: Stmt[] }> = [{ cond: cond.expr, body: subBody(this, body) }]
    const stmt = { s: 'if' as const, arms, elseBody: undefined as Stmt[] | undefined }
    // Push a mutable-shaped object; the readonly Stmt typing is a compile-time
    // view only — the builder owns construction.
    this.push(stmt as unknown as Stmt)
    return new IfChain(this, arms, (e) => { stmt.elseBody = e })
  }

  /** C-style for: `for (var name = init; name <cond>; name = name+step)`.
   *  A numeric / omitted step is typed to the loop var's scalar so a u32/i32
   *  counter emits `i + 1u` / `i + 1` (not `i + 1.0`, which naga/tint reject). */
  forRange<K extends string>(init: Node<K>, cond: (i: Node<K>) => Node<'bool'>, body: (b: Builder, i: Node<K>) => Node | void, step?: Node<ScalarKey> | number): void
  forRange<K extends string>(name: string, init: Node<K>, cond: (i: Node<K>) => Node<'bool'>, body: (b: Builder, i: Node<K>) => Node | void, step?: Node<ScalarKey> | number): void
  forRange<K extends string>(
    a: string | Node<K>,
    b: Node<K> | ((i: Node<K>) => Node<'bool'>),
    c: ((i: Node<K>) => Node<'bool'>) | ((b: Builder, i: Node<K>) => Node | void),
    d?: ((b: Builder, i: Node<K>) => Node | void) | Node<ScalarKey> | number,
    e?: Node<ScalarKey> | number,
  ): void {
    const named = typeof a === 'string'
    const name = named ? a : this.autoName()
    const init = (named ? b : a) as Node<K>
    const cond = (named ? c : b) as (i: Node<K>) => Node<'bool'>
    const body = (named ? d : c) as (b: Builder, i: Node<K>) => Node | void
    const step = (named ? e : d) as Node<ScalarKey> | number | undefined
    const i = new Node<K>({ op: 'varref', type: init.type, name })
    const litOf = (v: number): Node => {
      if (init.type.kind === 'scalar' && init.type.scalar === 'u32') return u32(v)
      if (init.type.kind === 'scalar' && init.type.scalar === 'i32') return i32(v)
      return f32(v)
    }
    const stepNode = step === undefined ? litOf(1) : typeof step === 'number' ? litOf(step) : step
    const initStmt: Stmt = { s: 'var', name, type: init.type, init: init.expr }
    const updateStmt: Stmt = { s: 'assign', target: i.expr, expr: i.add(stepNode as ArithArg<K>).expr }
    this.push({ s: 'for', init: initStmt, cond: cond(i).expr, update: updateStmt, body: subBody(this, (b) => body(b, i)) })
  }

  switch(scrut: Node<ScalarKey>, cases: Array<[number, (b: Builder) => Node | void]>, defaultBody?: (b: Builder) => Node | void): void {
    this.push({
      s: 'switch',
      scrut: scrut.expr,
      cases: cases.map(([value, fn]) => ({ value, body: subBody(this, fn) })),
      defaultBody: defaultBody ? subBody(this, defaultBody) : undefined,
    })
  }
}

export class IfChain {
  constructor(
    private readonly parent: Builder,
    private readonly arms: Array<{ cond: Expr; body: Stmt[] }>,
    private readonly setElse: (body: Stmt[]) => void,
  ) {}
  elif(cond: Node<'bool'>, body: (b: Builder) => Node | void): IfChain {
    this.arms.push({ cond: cond.expr, body: subBody(this.parent, body) })
    return this
  }
  else(body: (b: Builder) => Node | void): void {
    this.setElse(subBody(this.parent, body))
  }
}

// ── Ambient current-builder stack (C2) ──
// The free functions below (Let / Var / If / Loop / assign / …) push onto the
// INNERMOST active scope, so authoring no longer threads a `Builder` param per
// nesting level (the cb→d→cb2→e proliferation that caused the documented
// line.ts:721-726 shadowing bug). push/pop is exception-safe (try/finally) — a
// throw mid-body must not leak the stack into the next shader. This is a pure
// authoring-surface change: it emits the same Stmt[] as the passed-builder API.
const scopeStack: Builder[] = []

function currentBuilder(): Builder {
  const b = scopeStack[scopeStack.length - 1]
  if (b === undefined) {
    throw new Error('shader-dsl: no active builder — call Let/Var/If/Loop/… inside an fn / If / Loop body')
  }
  return b
}

function withScope<T>(b: Builder, run: () => T): T {
  scopeStack.push(b)
  try { return run() } finally { scopeStack.pop() }
}

// Wire the Node lvalue method (`x.set(v)`) to the current scope — installed here so node.ts stays free
// of a builder import.
installStmtSink({
  assign: (target, value) => currentBuilder().assign(target, value),
})

function subBody(parent: Builder, fn: (b: Builder) => Node | void): Stmt[] {
  // child() shares the parent's auto-name counter, so an omitted binding name inside this
  // nested scope keeps incrementing the same `_v{n}` sequence (no inner-shadows-outer).
  const b = parent.child()
  // A control-flow body does NOT capture a native `return value`: `If(c, () => x)` would
  // then be an INVISIBLE early return that reads as fall-through. Early returns are
  // explicit — `ReturnIf(cond, value)` (a guard clause) or `Return()` inside the branch.
  withScope(b, () => fn(b))
  return b.stmts
}

/** A function authored with fn(): it IS a typed CALLABLE — AND it carries the FuncDecl shape
 *  (name/params/ret/body), so it drops straight into `module({ funcs: [foo] })` and `foo.decl`
 *  is the plain FuncDecl. This is the three.js-TSL `Fn` shape (callable + the function node in
 *  one value), so there is no separate callFn('name', …) string call. Two call forms:
 *   - TYPED object-param `foo({ lon, lat })` — TS checks arg names + types + completeness, and
 *     autocompletes the params (positional args can't be typed: an object spec is not an
 *     ordered tuple in TS). The args are mapped to positional order at the call.
 *   - positional `foo(a, b)` — loose (NodeLike), the legacy form; still supported. */
export type FnHandle<P extends FnParamSpec, R extends ShaderType> =
  FuncDecl
  & {
    (args: { readonly [K in keyof P]: Node<KeyOf<ParamTypeOf<P[K]>>> }): Node<KeyOf<R>>
    (...args: NodeLike[]): Node<KeyOf<R>>
  }
  & { readonly decl: FuncDecl }

/** The call-node factory shared by fn()'s handle and externFn(): dispatches the typed
 *  object-param form `f({ a, b })` to positional callFn args (names → declared order), else
 *  passes positional args straight through. ONE implementation guarantees that an extern call
 *  and the real fn's call emit the identical call-by-name node. */
function makeCallFactory<R extends ShaderType>(
  name: string,
  ret: R,
  paramList: ReadonlyArray<{ name: string; type: ShaderType }>,
): (...args: NodeLike[]) => Node<KeyOf<R>> {
  return (...args: NodeLike[]): Node<KeyOf<R>> => {
    // Typed object-param call `f({ lon, lat })` — map the named args to positional order.
    // Distinguished from a single positional Node arg: a params object is a plain object, a
    // Node is a class instance. (callFn then builds the identical call-by-name node.)
    const a0 = args[0]
    if (args.length === 1 && a0 != null && !(a0 instanceof Node) && typeof a0 === 'object' && !Array.isArray(a0)) {
      const obj = a0 as Record<string, NodeLike>
      return callFn(name, ret, ...paramList.map((p) => obj[p.name]))
    }
    return callFn(name, ret, ...args)
  }
}

type FnOpts = {
  allowEarlyReturn?: boolean
  lintDisable?: readonly string[]
  /** Stage — turns this into a pipeline entry point (`@vertex` / `@fragment` /
   *  `@compute @workgroup_size(...)`). Omit for an ordinary helper fn. */
  stage?: 'vertex' | 'fragment' | 'compute'
  /** Workgroup size for a `stage: 'compute'` entry (defaults to 64). */
  workgroupSize?: number
  /** Return-value attribute for a bare (non-struct) stage output — `-> @location(0) vec4<f32>`. */
  retAttr?: string
}
type FnBody<P extends FnParamSpec, R extends ShaderType> = (p: ParamNodes<P>, b: Builder) => Node<KeyOf<R>> | void

// Auto-name counter for fn() calls that omit the name. Advanced ONLY on omission (explicit
// names never consume it). It is process-global + advanced in fn()-call order — deterministic
// for fns authored at module load (fixed ES evaluation order), which is the safe case.
// ⚠️ NOT for snapshot-tested or dynamically re-authored fns: the byte-identical WGSL snapshots
// are baked in one process and checked in another, and a fn referenced by a STRING name
// (externFn('project', …) / a callFn('…') / a placeholder-swap funcs[] lookup) must keep its
// explicit name — an opaque `_fn{n}` would not match. Omit the name only for a fn called
// exclusively through its own imported handle.
let fnAutoId = 0

/** Author a function. The body receives the typed param Nodes FIRST (each keyed by its
 *  ShaderType); the Builder is the optional SECOND arg — TSL-style (three.js Fn passes the
 *  inputs then the node-builder), so a clean body is just `(p) => …` using the ambient
 *  surface (Let/Var/If/Loop/Return + native terminal return) and only reaches for `b` when
 *  it must. The body's native `return` is type-checked against `ret` (`Node<KeyOf<R>>`), so a
 *  wrong-typed return is a compile error. The name is OPTIONAL — omit it for an auto `_fn{n}`
 *  (see fnAutoId caveat; keep it for string-referenced / snapshot-tested / re-authored fns).
 *  Returns an FnHandle — call it directly (`foo(a, b)`), list it in a module (`funcs: [foo]`),
 *  or take `foo.decl`. */
export function fn<P extends FnParamSpec, R extends ShaderType>(params: P, ret: R, body: FnBody<P, R>, opts?: FnOpts): FnHandle<P, R>
export function fn<P extends FnParamSpec, R extends ShaderType>(name: string, params: P, ret: R, body: FnBody<P, R>, opts?: FnOpts): FnHandle<P, R>
export function fn<P extends FnParamSpec, R extends ShaderType>(
  a: string | P,
  b: P | R,
  c: R | FnBody<P, R>,
  d?: FnBody<P, R> | FnOpts,
  e?: FnOpts,
): FnHandle<P, R> {
  const named = typeof a === 'string'
  const name = named ? a : `_fn${fnAutoId++}`
  const params = (named ? b : a) as P
  const ret = (named ? c : b) as R
  const body = (named ? d : c) as FnBody<P, R>
  const opts = (named ? e : d) as FnOpts | undefined
  // A param value is either a plain ShaderType or a FieldSpec `{ type, attr }` (builtin/location)
  // for an entry-point param — the `attr` flows straight to the emitted `@builtin(…)`/`@location(…)`.
  const paramList = Object.entries(params).map(([n, spec]) =>
    'attr' in spec
      ? { name: n, type: spec.type, attr: spec.attr }
      : { name: n, type: spec as ShaderType },
  )
  const paramNodes = Object.fromEntries(
    paramList.map((p) => [p.name, new Node({ op: 'param', type: p.type, name: p.name })]),
  ) as ParamNodes<P>
  const bld = new Builder()
  // A body may `return value` (native TS) for its FINAL return — fn appends the
  // ret Stmt, so authoring reads like a normal function. Early returns inside
  // control flow still use Return() (a native return there only exits the closure).
  const result = withScope(bld, () => body(paramNodes, bld))
  if (result !== undefined) bld.ret(result)
  // stage → pipeline attrs (@vertex / @fragment / @compute @workgroup_size(N)).
  const attrs = opts?.stage === 'compute'
    ? ['@compute', `@workgroup_size(${opts.workgroupSize ?? 64})`]
    : opts?.stage
      ? [`@${opts.stage}`]
      : undefined
  const decl: FuncDecl = { name, params: paramList, ret, body: bld.stmts, attrs, retAttr: opts?.retAttr, allowEarlyReturn: opts?.allowEarlyReturn, lintDisable: opts?.lintDisable }
  // The handle IS the call node factory (shared with externFn); the FuncDecl fields are mixed
  // onto it so it still duck-types as a FuncDecl in a module's funcs[]. `name` is a non-writable
  // function prop, so it is set via defineProperty (Object.assign would throw on it under strict).
  const handle = makeCallFactory(name, ret, paramList) as FnHandle<P, R>
  // enumerable so `{ ...handle }` (e.g. the projection-fn spread) carries the name; a
  // function's own `name` is non-enumerable by default, which would drop it from a spread.
  Object.defineProperty(handle, 'name', { value: name, configurable: true, enumerable: true })
  Object.assign(handle, { params: paramList, ret, body: decl.body, attrs: decl.attrs, retAttr: decl.retAttr, allowEarlyReturn: decl.allowEarlyReturn, lintDisable: decl.lintDisable, decl })
  return handle
}

/** A typed CALL-ONLY handle for a function whose DEFINITION is provided elsewhere — the
 *  forward-declaration ("extern") counterpart to fn(). Use it when the callee cannot be an
 *  importable FnHandle at the CALLER's module-load time. The projection fns (project /
 *  flat_rel / needs_backface_cull / rim_alpha / inv_merc_lat_rad) are built inside
 *  buildProjectionArtifacts AFTER configureProjections() — too late for consumer shader
 *  modules that author their bodies eagerly at import. externFn carries only the SIGNATURE
 *  (name + param types + ret), so a consumer makes a TYPED call now (object-param `f({a,b})`
 *  or positional `f(a,b)`); the body is linked in at emit via the projection module. The
 *  emitted node is callFn(name, ret, …) — byte-identical to the old string call. */
export type ExternFn<P extends ParamSpec, R extends ShaderType> = {
  (args: { readonly [K in keyof P]: Node<KeyOf<P[K]>> }): Node<KeyOf<R>>
  (...args: NodeLike[]): Node<KeyOf<R>>
}
export function externFn<P extends ParamSpec, R extends ShaderType>(name: string, params: P, ret: R): ExternFn<P, R> {
  const paramList = Object.entries(params).map(([n, type]) => ({ name: n, type }))
  return makeCallFactory(name, ret, paramList) as ExternFn<P, R>
}

/** @deprecated fn() now returns a callable FnHandle directly — use fn(). Kept as an alias. */
export const defineFn = fn


/** Assemble a module from its declarations. */
export function module(parts: Partial<ModuleDecl>): ModuleDecl {
  return {
    consts: parts.consts ?? [],
    structs: parts.structs ?? [],
    bindings: parts.bindings ?? [],
    funcs: parts.funcs ?? [],
  }
}

// ── Ambient free-function authoring surface (C2) ──
// Capitalised to avoid JS keyword clashes (If/Loop/Let/Var/Return/Switch); each
// routes to the INNERMOST active scope (currentBuilder), so no `Builder` param is
// threaded per nesting level. The old `cb.let(...)` / `(b) => …` callback API still
// works (both push the same Stmt[]), so shaders migrate function-by-function and the
// emit stays byte-identical. IfChain.elif/.else accept a zero-arg `() => …` body
// (a 0-arg fn is assignable where `(b) => void` is wanted), so chains read clean too.

export function Let<K extends string>(value: Node<K>): Node<K>
export function Let<K extends string>(name: string, value: Node<K>): Node<K>
export function Let<K extends string>(nameOrValue: string | Node<K>, maybeValue?: Node<K>): Node<K> {
  return typeof nameOrValue === 'string' ? currentBuilder().let(nameOrValue, maybeValue!) : currentBuilder().let(nameOrValue)
}
export function Var<K extends string>(init: Node<K>): Node<K>
export function Var<T extends ShaderType>(type: T, init?: Node<KeyOf<T>>): Node<KeyOf<T>>
export function Var<T extends ShaderType>(name: string, type: T, init?: Node<KeyOf<T>>): Node<KeyOf<T>>
export function Var<T extends ShaderType>(nameOrTypeOrInit: string | T | Node, typeOrInit?: T | Node<KeyOf<T>>, maybeInit?: Node<KeyOf<T>>): Node<KeyOf<T>> {
  // Var(init) — a mutable var seeded from a value infers its WGSL type from that value.
  if (nameOrTypeOrInit instanceof Node) return currentBuilder().var(nameOrTypeOrInit.type, nameOrTypeOrInit) as Node<KeyOf<T>>
  return typeof nameOrTypeOrInit === 'string'
    ? currentBuilder().var(nameOrTypeOrInit, typeOrInit as T, maybeInit)
    : currentBuilder().var(nameOrTypeOrInit, typeOrInit as Node<KeyOf<T>> | undefined)
}
export const assign = <K extends string>(target: Node<K>, value: Node<K>): void => currentBuilder().assign(target, value)
export const assignOp = <K extends string>(target: Node<K>, bop: BinOp, value: ArithArg<K>): void => currentBuilder().assignOp(target, bop, value)
export const addAssign = <K extends string>(target: Node<K>, value: ArithArg<K>): void => currentBuilder().addAssign(target, value)
export const Return = (value?: Node): void => currentBuilder().ret(value)
/** Guard clause — `if (cond) { return value; }`. The readable, EXPLICIT early return:
 *  reads as "return value if cond", unlike `If(cond, () => value)` which looks like a
 *  fall-through. Emits identically to `If(cond, () => Return(value))`. */
export const ReturnIf = (cond: Node<'bool'>, value?: Node): void => {
  currentBuilder().if(cond, (b) => b.ret(value))
}
export const Continue = (): void => currentBuilder().continue()
export const Break = (): void => currentBuilder().break()
export const Discard = (): void => currentBuilder().discard()

/** `if (cond) { body }` over the innermost scope; a body may `return value` for an
 *  early return (same `return` everywhere). Chain `.elif(c, () => …)` / `.else(() => …)`. */
export const If = (cond: Node<'bool'>, body: () => Node | void): IfChain => currentBuilder().if(cond, () => body())

/** C-style for over the innermost scope; the body receives the typed counter Node. */
export function Loop<K extends string>(init: Node<K>, cond: (i: Node<K>) => Node<'bool'>, body: (i: Node<K>) => Node | void, step?: Node<ScalarKey> | number): void
export function Loop<K extends string>(name: string, init: Node<K>, cond: (i: Node<K>) => Node<'bool'>, body: (i: Node<K>) => Node | void, step?: Node<ScalarKey> | number): void
export function Loop<K extends string>(
  a: string | Node<K>,
  b: Node<K> | ((i: Node<K>) => Node<'bool'>),
  c: ((i: Node<K>) => Node<'bool'>) | ((i: Node<K>) => Node | void),
  d?: ((i: Node<K>) => Node | void) | Node<ScalarKey> | number,
  e?: Node<ScalarKey> | number,
): void {
  const named = typeof a === 'string'
  const init = (named ? b : a) as Node<K>
  const cond = (named ? c : b) as (i: Node<K>) => Node<'bool'>
  const body = (named ? d : c) as (i: Node<K>) => Node | void
  const step = (named ? e : d) as Node<ScalarKey> | number | undefined
  if (named) currentBuilder().forRange(a as string, init, cond, (_b, i) => body(i), step)
  else currentBuilder().forRange(init, cond, (_b, i) => body(i), step)
}

/** Immutable fold over a C-style loop — the functional spelling of the `var acc = init; for
 *  (...) { acc = f(acc, i) }` accumulator. The body RETURNS the next accumulator value (no
 *  `Var` + `assign` at the call site); reduce materialises the var + loop + assign internally,
 *  so the emit is byte-identical. Returns the accumulator Node for use after the loop. */
export function reduce<K extends string, J extends string>(
  init: Node<K>,
  loopInit: Node<J>,
  cond: (i: Node<J>) => Node<'bool'>,
  body: (acc: Node<K>, i: Node<J>) => Node<K>,
  step?: Node<ScalarKey> | number,
): Node<K> {
  const acc = currentBuilder().var(init.type, init) as Node<K>
  currentBuilder().forRange(loopInit, cond, (_b, i) => {
    currentBuilder().assign(acc, body(acc, i))
  }, step)
  return acc
}

/** Immutable if-expression — the functional spelling of `var v; if (cond) { v = then } else { v =
 *  else }`. Each branch RETURNS its value (no `Var` + `assign` at the call site); ifExpr materialises
 *  the var + if/else internally, so the emit is byte-identical (it does NOT lower to `select`, which
 *  would change the WGSL). Use for a branch-INITIALISED value, not for genuine multi-step mutation. */
export function ifExpr<K extends string>(
  cond: Node<'bool'>,
  thenVal: () => Node<K>,
  elseVal: () => Node<K>,
): Node<K> {
  const b = currentBuilder()
  const iv = b.inferredVar()
  let vt: ShaderType | undefined
  b.if(cond, () => { const val = thenVal(); vt ??= val.type; b.assign(iv.ref(val.type) as Node<K>, val) })
    .else(() => { const val = elseVal(); vt ??= val.type; b.assign(iv.ref(val.type) as Node<K>, val) })
  iv.commit(vt!)
  return iv.ref(vt!) as Node<K>
}

/** N-arm immutable if-expression — `var v; if (c0) { v = e0 } else if (c1) { v = e1 } ... else
 *  { v = eN }`. Each arm RETURNS its value (arms may have intermediate const/Let before the
 *  return); the materialised var + if/elif/else chain is byte-identical to the hand form. The
 *  2-arm `ifExpr` is the single-arm case of this. */
export function condExpr<K extends string>(
  arms: ReadonlyArray<readonly [Node<'bool'>, () => Node<K>]>,
  elseVal: () => Node<K>,
): Node<K> {
  const b = currentBuilder()
  const iv = b.inferredVar()
  let vt: ShaderType | undefined
  const arm = (v: () => Node<K>) => () => { const val = v(); vt ??= val.type; b.assign(iv.ref(val.type) as Node<K>, val) }
  let chain = b.if(arms[0][0], arm(arms[0][1]))
  for (let k = 1; k < arms.length; k++) {
    chain = chain.elif(arms[k][0], arm(arms[k][1]))
  }
  chain.else(arm(elseVal))
  iv.commit(vt!)
  return iv.ref(vt!) as Node<K>
}

/** `switch (scrut) { case n: …; default: … }` as a chainable statement BUILDER — mirrors the
 *  If(…).elif(…).else(…) surface so dispatch reads the known imperative way: forward-declare a
 *  `Var(default)`, then assign it inside the case arms.
 *    const radiusPx = Var(rawRadius)
 *    Switch(sizeMode)
 *      .case(1, () => assign(radiusPx, rawRadius.div(viewport.z)))
 *      .case(2, () => assign(radiusPx, …))
 *      .default(() => {})
 *  Lowers to a real WGSL `switch`. `.case(n, body)` ~ a case label, `.default(body?)` ~ the default arm
 *  (optional) + the terminator. */
export class SwitchChain {
  private readonly cases: Array<[number, () => void]> = []
  constructor(private readonly scrut: Node<ScalarKey>) {}
  case(value: number, body: () => void): SwitchChain {
    this.cases.push([value, body])
    return this
  }
  default(body?: () => void): void {
    currentBuilder().switch(
      this.scrut,
      this.cases.map(([v, f]) => [v, (_b: Builder) => f()] as [number, (bb: Builder) => Node | void]),
      body ? (_b: Builder) => body() : undefined,
    )
  }
}

/** Open a `switch (scrut)` chain — `Switch(scrut).case(n, body)….default(body)`. */
export function Switch(scrut: Node<ScalarKey>): SwitchChain {
  return new SwitchChain(scrut)
}
