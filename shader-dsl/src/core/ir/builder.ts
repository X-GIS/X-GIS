// ═══ Shader DSL — function/statement builder ═══
//
// The imperative authoring surface: Builder (collects Stmt nodes via
// let/var/assign/if/for/switch/ret/…), the IfChain helper, and the fn /
// computeFn / entryFn / module assemblers. Imports types + nodes + node.

import { type ShaderType, type KeyOf, type ScalarKey, voidT } from './types'
import {
  type Stmt,
  type Expr,
  type BinOp,
  type FuncDecl,
  type ModuleDecl,
  type ConstDecl,
  type OverrideDecl,
  type StructDecl,
  type BindingDecl,
  ASSEMBLED_AS,
} from './nodes'
import {
  Node,
  ReadonlyNode,
  isNodeValue,
  type ArithArg,
  type NodeLike,
  lift,
  f32,
  i32,
  u32,
  callFn,
  overrideRef,
  installStmtSink,
} from './node'
import { dslError } from '../diagnostics/error'
import { captureLoc, recordLoc } from '../diagnostics/loc'

export type ParamSpec = Record<string, ShaderType>
/** An entry-point param carrying a stage attribute — `builtin('vertex_index', u32T)` /
 *  `location(0, vec4fT)` (the SAME FieldSpec the ioStruct fields use). A plain ShaderType value is
 *  an ordinary param. Lets one `fn()` author both helpers and `@vertex`/`@fragment`/`@compute`
 *  entries from a single param record. */
type ParamAttr = {
  readonly type: ShaderType
  readonly attr: string
  // Structured IO fields (#740 R3 / #763 S5) — sot's builtin()/location() set these;
  // fn() threads them into FuncDecl.params so reflect() sees vertex attributes
  // WITHOUT re-parsing the attr string.
  readonly location?: number
  readonly builtin?: string
  readonly interpolate?: string
}
/** A structDecl / ioStruct HANDLE used directly as a param spec value (#740 R6):
 *  `fn({ in: PointOut }, ({ in }) => in.uv…)` — the body receives the TYPED field
 *  proxy, retiring the `PointOut.of(p.in)` re-assertion at every consumer. */
type StructParamHandle = { readonly type: ShaderType; of(node: ReadonlyNode): object }
export type FnParamSpec = Record<string, ShaderType | ParamAttr | StructParamHandle>
type ParamTypeOf<E> = E extends ParamAttr
  ? E['type']
  : E extends StructParamHandle
    ? E['type']
    : E extends ShaderType
      ? E
      : never
/** Body-side param values. Params are READ-ONLY in WGSL — the node type is
 *  `ReadonlyNode`, so `p.lon.assign(…)` is a tsc error (#763 G3; the runtime
 *  never guarded this: auto-vars skips param roots and the emitted assign
 *  died in the driver). Struct-handle params receive the handle's READ view. */
type ParamNodes<P extends FnParamSpec> = {
  [K in keyof P]: P[K] extends StructParamHandle
    ? ReturnType<P[K]['of']>
    : ReadonlyNode<KeyOf<ParamTypeOf<P[K]>>>
}

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
  child(): Builder {
    return new Builder(this.autoNames)
  }

  private autoName(): string {
    return `_v${this.autoNames.n++}`
  }

  private push(s: Stmt): void {
    recordLoc(s, captureLoc())
    this.stmts.push(s)
  }

  /** Immutable binding — `let name = expr;`. The name is OPTIONAL: omit it and the
   *  binding takes a function-unique auto name (`_v0`, `_v1`, …) — for when the JS
   *  const already carries the meaning (`const lon = let(expr)`) and repeating it as a
   *  string is redundant; the tradeoff is an opaque WGSL name. Returns a varref Node
   *  of the bound value's key. */
  let<K extends string>(value: ReadonlyNode<K>): ReadonlyNode<K>
  let<K extends string>(name: string, value: ReadonlyNode<K>): ReadonlyNode<K>
  let<K extends string>(
    nameOrValue: string | ReadonlyNode<K>,
    maybeValue?: ReadonlyNode<K>,
  ): ReadonlyNode<K> {
    const named = typeof nameOrValue === 'string'
    const name = named ? nameOrValue : this.autoName()
    const value = (named ? maybeValue : nameOrValue) as ReadonlyNode<K>
    this.push({ s: 'let', name, expr: value.expr })
    return new Node<K>({ op: 'varref', type: value.type, name })
  }

  /** Mutable binding — `var name: T = init?;`. The name is OPTIONAL (see let). */
  var<T extends ShaderType>(type: T, init?: ReadonlyNode<KeyOf<T>>): Node<KeyOf<T>>
  var<T extends ShaderType>(name: string, type: T, init?: ReadonlyNode<KeyOf<T>>): Node<KeyOf<T>>
  var<T extends ShaderType>(
    nameOrType: string | T,
    typeOrInit?: T | ReadonlyNode<KeyOf<T>>,
    maybeInit?: ReadonlyNode<KeyOf<T>>,
  ): Node<KeyOf<T>> {
    const named = typeof nameOrType === 'string'
    const name = named ? nameOrType : this.autoName()
    const type = (named ? typeOrInit : nameOrType) as T
    const init = (named ? maybeInit : typeOrInit) as ReadonlyNode<KeyOf<T>> | undefined
    this.push({ s: 'var', name, type, init: init?.expr })
    return new Node<KeyOf<T>>({ op: 'varref', type, name })
  }

  /** A `var` whose WGSL type is filled in AFTER its branch-assignments are authored — used by
   *  ifExpr/condExpr, where the type is the arms' value type (so the caller writes no type token).
   *  Returns the auto-named varref factory (typed once known) + a `commit(type)` that patches the
   *  emitted decl. The Stmt is pushed NOW (before the branches), patched before the build returns,
   *  so the emit always sees a fully-typed var — the typeless window is internal + synchronous. */
  inferredVar(): {
    ref: (type: ShaderType) => Node
    commit: (type: ShaderType) => void
    cancel: () => void
  } {
    const name = this.autoName()
    const stmt = {
      s: 'var' as const,
      name,
      type: undefined as unknown as ShaderType,
      init: undefined,
    }
    this.push(stmt as Stmt)
    return {
      ref: (type) => new Node({ op: 'varref', type, name }),
      commit: (type) => {
        stmt.type = type
      },
      // Drop the pushed decl — for a Switch used as a STATEMENT (no case returned a value), the
      // reserved var is unused; removing it keeps the emit free of a stray typeless `var`.
      cancel: () => {
        const i = this.stmts.indexOf(stmt as Stmt)
        if (i >= 0) this.stmts.splice(i, 1)
      },
    }
  }

  assign<K extends string>(target: ReadonlyNode<K>, value: ReadonlyNode<K>): void {
    this.push({ s: 'assign', target: target.expr, expr: value.expr })
  }
  assignOp<K extends string>(target: ReadonlyNode<K>, bop: BinOp, value: ArithArg<K>): void {
    this.push({ s: 'assignOp', target: target.expr, bop, expr: lift(value).expr })
  }
  addAssign<K extends string>(target: Node<K>, value: ArithArg<K>): void {
    this.assignOp(target, '+', value)
  }

  ret(value?: ReadonlyNode): void {
    this.push({ s: 'return', expr: value?.expr })
  }
  break(): void {
    this.push({ s: 'break' })
  }
  continue(): void {
    this.push({ s: 'continue' })
  }
  discard(): void {
    this.push({ s: 'discard' })
  }
  /** Lay down a `{ s: 'placeholder', tag }` marker — the polygon DSL
   *  composer (emitPolygonWgsl) walks the cloned module and swaps each
   *  tagged placeholder for the variant's return-Stmts. Bare (un-swapped)
   *  placeholders emit `// __placeholder: ${tag}` per the defensive design
   *  in placeholder-stmt.test.ts. */
  placeholder(tag: string): void {
    this.push({ s: 'placeholder', tag })
  }

  /** if / else-if / else chain. Returns a chainer so `.elif().else()` reads
   *  top-to-bottom. The If stmt is pushed on the first call and mutated in
   *  place by subsequent .elif/.else. */
  if(cond: ReadonlyNode<'bool'>, body: (b: Builder) => ReadonlyNode | void): IfChain {
    const arms: Array<{ cond: Expr; body: Stmt[] }> = [
      { cond: cond.expr, body: subBody(this, body, 'If body') },
    ]
    const stmt = { s: 'if' as const, arms, elseBody: undefined as Stmt[] | undefined }
    // Push a mutable-shaped object; the readonly Stmt typing is a compile-time
    // view only — the builder owns construction.
    this.push(stmt)
    return new IfChain(this, arms, (e) => {
      stmt.elseBody = e
    })
  }

  /** C-style for: `for (var name = init; name <cond>; name = name+step)`.
   *  A numeric / omitted step is typed to the loop var's scalar so a u32/i32
   *  counter emits `i + 1u` / `i + 1` (not `i + 1.0`, which naga/tint reject). */
  forRange<K extends string>(
    init: ReadonlyNode<K>,
    cond: (i: Node<K>) => ReadonlyNode<'bool'>,
    body: (b: Builder, i: Node<K>) => ReadonlyNode | void,
    step?: ReadonlyNode<ScalarKey> | number,
  ): void
  forRange<K extends string>(
    name: string,
    init: ReadonlyNode<K>,
    cond: (i: Node<K>) => ReadonlyNode<'bool'>,
    body: (b: Builder, i: Node<K>) => ReadonlyNode | void,
    step?: ReadonlyNode<ScalarKey> | number,
  ): void
  forRange<K extends string>(
    a: string | ReadonlyNode<K>,
    b: ReadonlyNode<K> | ((i: Node<K>) => ReadonlyNode<'bool'>),
    c: ((i: Node<K>) => ReadonlyNode<'bool'>) | ((b: Builder, i: Node<K>) => ReadonlyNode | void),
    d?: ((b: Builder, i: Node<K>) => ReadonlyNode | void) | ReadonlyNode<ScalarKey> | number,
    e?: ReadonlyNode<ScalarKey> | number,
  ): void {
    const named = typeof a === 'string'
    const name = named ? a : this.autoName()
    const init = (named ? b : a) as ReadonlyNode<K>
    const cond = (named ? c : b) as (i: Node<K>) => ReadonlyNode<'bool'>
    const body = (named ? d : c) as (b: Builder, i: Node<K>) => ReadonlyNode | void
    const step = (named ? e : d) as ReadonlyNode<ScalarKey> | number | undefined
    const i = new Node<K>({ op: 'varref', type: init.type, name })
    const litOf = (v: number): Node => {
      if (init.type.kind === 'scalar' && init.type.scalar === 'u32') return u32(v)
      if (init.type.kind === 'scalar' && init.type.scalar === 'i32') return i32(v)
      return f32(v)
    }
    const stepNode = step === undefined ? litOf(1) : typeof step === 'number' ? litOf(step) : step
    const initStmt: Stmt = { s: 'var', name, type: init.type, init: init.expr }
    const updateStmt: Stmt = {
      s: 'assign',
      target: i.expr,
      // stepNode's exact scalar-vs-K match is enforced at AUTHOR-RUN time (SD0004
      // from binResultType), not by tsc — K is abstract at this generic call site.
      expr: i.add(stepNode as unknown as ArithArg<K>).expr,
    }
    this.push({
      s: 'for',
      init: initStmt,
      cond: cond(i).expr,
      update: updateStmt,
      body: subBody(this, (b) => body(b, i), 'Loop body'),
    })
  }

  switch(
    scrut: ReadonlyNode<ScalarKey>,
    cases: Array<[number, (b: Builder) => ReadonlyNode | void]>,
    defaultBody?: (b: Builder) => ReadonlyNode | void,
  ): void {
    this.push({
      s: 'switch',
      scrut: scrut.expr,
      cases: cases.map(([value, fn]) => ({ value, body: subBody(this, fn, 'Switch case body') })),
      defaultBody: defaultBody ? subBody(this, defaultBody, 'Switch default body') : undefined,
    })
  }
}

export class IfChain {
  constructor(
    private readonly parent: Builder,
    private readonly arms: Array<{ cond: Expr; body: Stmt[] }>,
    private readonly setElse: (body: Stmt[]) => void,
  ) {}
  elif(cond: ReadonlyNode<'bool'>, body: (b: Builder) => ReadonlyNode | void): IfChain {
    this.arms.push({ cond: cond.expr, body: subBody(this.parent, body, 'elif body') })
    return this
  }
  else(body: (b: Builder) => ReadonlyNode | void): void {
    this.setElse(subBody(this.parent, body, 'else body'))
  }
}

// ── Ambient current-builder stack (C2) ──
// The free functions below (Let / Var / If / Loop / assign / …) push onto the
// INNERMOST active scope, so authoring no longer threads a `Builder` param per
// nesting level (the cb→d→cb2→e proliferation that caused the documented
// line.ts:721-726 shadowing bug). push/pop is exception-safe (try/finally) — a
// throw mid-body must not leak the stack into the next shader. This is a pure
// authoring-surface change: it emits the same Stmt[] as the passed-builder API.
// globalThis-backed (#763 D2): a dual-loaded package copy used to get its OWN
// empty stack — `Let` imported from copy B inside a body authored by copy A's
// `fn` threw SD0013 at module load. Sharing the ambient state across copies
// makes the duplication harmless (same pattern as map's __XGIS_PROJECTIONS__).
const scopeStack: Builder[] = ((globalThis as Record<symbol, unknown>)[
  Symbol.for('xgis.shader-dsl.scopeStack')
] ??= []) as Builder[]

// Loud (once) when a second copy loads — the state above makes it SAFE, but a
// duplicated package still doubles load cost and usually means a bundler
// dedupe/config problem worth seeing.
{
  const g = globalThis as Record<symbol, unknown>
  const key = Symbol.for('xgis.shader-dsl.instanceLoaded')
  if (g[key])
    console.warn(
      '[shader-dsl] a second copy of @xgis/shader-dsl was loaded (dual-instance). Ambient state is globalThis-backed so this is safe, but check the bundler/dedupe config — see #763 D2.',
    )
  else g[key] = true
}

function currentBuilder(): Builder {
  const b = scopeStack[scopeStack.length - 1]
  if (b === undefined) {
    throw dslError('SD0013')
  }
  return b
}

function withScope<T>(b: Builder, run: () => T): T {
  scopeStack.push(b)
  try {
    return run()
  } finally {
    scopeStack.pop()
  }
}

// Wire the Node lvalue method (`x.assign(v)`) to the current scope — installed here so node.ts stays free
// of a builder import.
installStmtSink({
  assign: (target, value) => currentBuilder().assign(target, value),
})

// ═══ #843 — authoring-error context ═══
// When an author's callback throws (a JS ReferenceError, a sot field typo, …) the
// stack leads with builder internals and the failing fn / statement is invisible.
// Each callback boundary prefixes the SAME error object's message once — symbol-
// tagged so nested scopes don't stack a prefix per level — preserving the error's
// class (instanceof, coded SD#### diagnostics, substring-matching tests all hold).
const AUTHOR_KIND_TAGGED = Symbol('shader-dsl authoring kind tagged')
const AUTHOR_FN_TAGGED = Symbol('shader-dsl authoring fn tagged')

function tagAuthoringError(e: unknown, tag: symbol, prefix: string): void {
  if (e instanceof Error && !(tag in e)) {
    ;(e as unknown as Record<symbol, boolean>)[tag] = true
    e.message = `${prefix}: ${e.message}`
  }
}

function subBody(parent: Builder, fn: (b: Builder) => ReadonlyNode | void, kind?: string): Stmt[] {
  // child() shares the parent's auto-name counter, so an omitted binding name inside this
  // nested scope keeps incrementing the same `_v{n}` sequence (no inner-shadows-outer).
  const b = parent.child()
  // A control-flow body does NOT capture a native `return value`: `If(c, () => x)` would
  // then be an INVISIBLE early return that reads as fall-through. Early returns are
  // explicit — `ReturnIf(cond, value)` (a guard clause) or `Return()` inside the branch.
  withScope(b, () => {
    try {
      return fn(b)
    } catch (e) {
      // innermost statement kind wins (the tag blocks outer scopes' re-prefixing)
      if (kind !== undefined) tagAuthoringError(e, AUTHOR_KIND_TAGGED, `in ${kind}`)
      throw e
    }
  })
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
// R is the RETURN KEY (e.g. 'f32', 'vec2<f32>') — inferred from the body's return Node, so a fn declares
// no return type. The args mapped-type's own K is the PARAM key (unrelated).
/** A forwardable struct field proxy (a handle param / `.of()` view) — accepted
 *  anywhere a struct-typed argument is, via its raw-node `$` accessor. */
type StructArg = { readonly $: ReadonlyNode }

export type FnHandle<P extends FnParamSpec, R extends string> = FuncDecl & {
  /** Typed object-param call — TS checks names, types, completeness. Raw numbers
   *  are accepted and lift to the DECLARED param type (a u32 param gets a u32
   *  literal, not the positional form's blanket f32). Struct-handle params accept
   *  a forwarded field proxy. Args are ReadonlyNode — a call only READS its
   *  arguments, so rvalues (Let() results, expressions) are accepted (#755). */
  (args: {
    readonly [K in keyof P]:
      | ReadonlyNode<KeyOf<ParamTypeOf<P[K]>>>
      | number
      | (P[K] extends StructParamHandle ? StructArg : never)
  }): Node<R>
  /** @deprecated Positional call — `NodeLike[]` checks NOTHING (arity, types,
   *  order all unchecked at the TS level; a lon/lat swap compiles). The
   *  `call-signature` lint rule catches arity/type mismatches at emit time,
   *  but same-type swaps only the object-param form can prevent. (Struct field
   *  proxies are accepted and unwrap to their raw struct-value Node.) */
  (...args: (NodeLike | StructArg)[]): Node<R>
} & { readonly decl: FuncDecl }

/** The call-node factory shared by fn()'s handle and externFn(): dispatches the typed
 *  object-param form `f({ a, b })` to positional callFn args (names → declared order), else
 *  passes positional args straight through. ONE implementation guarantees that an extern call
 *  and the real fn's call emit the identical call-by-name node. */
function makeCallFactory<R extends ShaderType>(
  name: string,
  ret: R,
  paramList: ReadonlyArray<{ name: string; type: ShaderType }>,
  // The callee's decl, when the factory belongs to a real fn() handle (externFn has
  // none). Stamped onto every call node as `declRef` so module() can auto-collect
  // transitive callees and key-naming can re-spell calls. Note the call spells
  // `declRef.name` at BUILD time (not the closed-over `name`): a key-named module
  // may rename the decl AFTER call sites were authored in other fns' bodies —
  // reading through the decl keeps handle-made calls rename-consistent, and the
  // assembly-time rewrite covers nodes built before a rename.
  declRef?: FuncDecl,
): (...args: NodeLike[]) => Node<KeyOf<R>> {
  const mk = (args: NodeLike[]): Node<KeyOf<R>> => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- callFn's own JSDoc: "Kept for the call factories' internal use" — this IS that factory
    const n = callFn(declRef?.name ?? name, ret, ...args)
    if (declRef) (n.expr as { declRef?: FuncDecl }).declRef = declRef
    return n
  }
  // A struct FIELD PROXY (a handle param / a `.of()` view) forwards as its raw
  // struct-value Node via its `$` accessor (#740 R6) — so `helper(p.input)` just
  // works when p.input arrived as a typed handle param.
  // isNodeValue, NOT instanceof (#763 D1): a dual-loaded package splits the
  // prototype identity, and a cross-instance node falling through instanceof
  // was misrouted into the named-args parse (TypeError at load, or a silent
  // mis-swizzle when a param name collides with a component getter).
  const unwrap = (v: unknown): unknown =>
    v !== null && typeof v === 'object' && !isNodeValue(v) && '$' in (v as object)
      ? (v as { $: ReadonlyNode }).$
      : v
  return (...rawArgs: NodeLike[]): Node<KeyOf<R>> => {
    const args = rawArgs.map(unwrap) as NodeLike[]
    // Typed object-param call `f({ lon, lat })` — map the named args to positional order.
    // Distinguished from a single positional Node arg: a params object is a plain object, a
    // Node is a class instance, and a struct field proxy unwraps to one above.
    const a0 = args[0]
    if (
      args.length === 1 &&
      a0 != null &&
      !isNodeValue(a0) &&
      typeof a0 === 'object' &&
      !Array.isArray(a0)
    ) {
      // Principled cast: the preceding typeof / isNodeValue / Array.isArray guards prove
      // a0 is a plain named-args record here; TS can't recover that through the `unwrap`
      // map (args is pinned to NodeLike[]) without widening the public call signature.
      const obj = a0 as unknown as Record<string, NodeLike>
      // A raw number in the object form lifts to the DECLARED param type — the
      // caller named the parameter, so its type is known (unlike the positional
      // form, whose bare numbers can only default-lift). Struct proxies unwrap.
      return mk(
        paramList.map((p) => {
          const v = unwrap(obj[p.name]) as NodeLike
          return typeof v === 'number' ? new Node({ op: 'lit', type: p.type, value: v }) : v
        }),
      )
    }
    return mk(args)
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
  /** Return-value attribute for a bare (non-struct) stage output — `-> @location(0) vec4<f32>`.
   *  Accepts the typed `location(0, T)` FieldSpec too (#763 X3 — its `.attr` is used), and
   *  DEFAULTS to `@location(0)` for a bare non-struct fragment return (every observed site
   *  used exactly that string; omitting it used to die late in the driver). */
  retAttr?: string | { readonly attr: string }
}
// A body may return the raw node OR a struct field proxy (`return o` — #763 X14):
// the proxy forwards `.expr`/`.type` to its base var, so `bld.ret` reads it like
// a node. StructArg is the `{ $: ReadonlyNode }` shape every sot proxy carries.
type FnBody<P extends FnParamSpec, R extends string> = (
  p: ParamNodes<P>,
  b: Builder,
) => ReadonlyNode<R> | StructArg | void

/** Infer a fn's WGSL return type from its body — the type of the value it returns. Used when the author
 *  omits the explicit return-type token. Walks into nested if/for/switch for a body that returns only via
 *  an early `Return(value)` (a guard). voidT when nothing is returned (statement / compute entry). */
function inferReturnType(result: ReadonlyNode | void, stmts: readonly Stmt[]): ShaderType {
  if (result !== undefined) return result.type
  const scan = (ss: readonly Stmt[]): ShaderType | undefined => {
    for (const s of ss) {
      if (s.s === 'return' && s.expr) return s.expr.type
      if (s.s === 'if') {
        for (const arm of s.arms) {
          const t = scan(arm.body)
          if (t) return t
        }
        if (s.elseBody) {
          const t = scan(s.elseBody)
          if (t) return t
        }
      } else if (s.s === 'for') {
        const t = scan(s.body)
        if (t) return t
      } else if (s.s === 'switch') {
        for (const c of s.cases) {
          const t = scan(c.body)
          if (t) return t
        }
        if (s.defaultBody) {
          const t = scan(s.defaultBody)
          if (t) return t
        }
      }
    }
    return undefined
  }
  return scan(stmts) ?? voidT
}

// Auto-name counter for fn() calls that omit the name. Advanced ONLY on omission (explicit
// names never consume it). It is process-global + advanced in fn()-call order — deterministic
// for fns authored at module load (fixed ES evaluation order), which is the safe case.
// ⚠️ The caveat is about a BARE `_fn{n}` reaching emitted WGSL: the byte-identical snapshots
// are baked in one process and checked in another, and a fn referenced by a STRING name
// (externFn('project', …) / a callFn('…') / a placeholder-swap funcs[] lookup) must keep a
// stable explicit name. Two ways to have one (#763 H9): pass the name to fn(), OR list the
// anonymous handle in a `funcs:` KEY-RECORD — the record key deterministically RENAMES the
// decl (and every handle-made call site, via declRef + the assembly rewrite), so fnAutoId
// never reaches the output. Only an anonymous fn used in an ARRAY-form module emits `_fn{n}`.
// globalThis-backed counter (#763 D2) — two copies each starting at `_fn0`
// would collide in the name-keyed module dedup and silently mis-link
// DIFFERENT anonymous fns as one.
const fnAutoState = ((globalThis as Record<symbol, unknown>)[
  Symbol.for('xgis.shader-dsl.fnAutoId')
] ??= { n: 0 }) as { n: number }

/** Author a function. The body receives the typed param Nodes FIRST (each keyed by its
 *  ShaderType); the Builder is the optional SECOND arg — TSL-style (three.js Fn passes the
 *  inputs then the node-builder), so a clean body is just `(p) => …` using the ambient
 *  surface (Let/Var/If/Loop/Return + native terminal return) and only reaches for `b` when
 *  it must. The body's native `return` is type-checked against `ret` (`Node<KeyOf<R>>`), so a
 *  wrong-typed return is a compile error. The name is OPTIONAL — an anonymous handle gets an
 *  auto `_fn{n}` placeholder that a `funcs:` key-record deterministically renames at module
 *  assembly (#763 H9 — the name-once form); keep an EXPLICIT name only where the fn is
 *  referenced by string outside its own handle (externFn / callFn / placeholder-swap lookups)
 *  and no record names it.
 *  Returns an FnHandle — call it directly (`foo(a, b)`), list it in a module (`funcs: [foo]`),
 *  or take `foo.decl`. */
export function fn<P extends FnParamSpec, R extends string>(
  params: P,
  body: FnBody<P, R>,
  opts?: FnOpts,
): FnHandle<P, R>
export function fn<P extends FnParamSpec, R extends string>(
  name: string,
  params: P,
  body: FnBody<P, R>,
  opts?: FnOpts,
): FnHandle<P, R>
export function fn<P extends FnParamSpec, T extends ShaderType>(
  params: P,
  ret: T,
  body: FnBody<P, KeyOf<T>>,
  opts?: FnOpts,
): FnHandle<P, KeyOf<T>>
export function fn<P extends FnParamSpec, T extends ShaderType>(
  name: string,
  params: P,
  ret: T,
  body: FnBody<P, KeyOf<T>>,
  opts?: FnOpts,
): FnHandle<P, KeyOf<T>>
export function fn(
  a: string | FnParamSpec,
  b: FnParamSpec | ShaderType | FnBody<FnParamSpec, string>,
  c?: ShaderType | FnBody<FnParamSpec, string> | FnOpts,
  d?: FnBody<FnParamSpec, string> | FnOpts,
  e?: FnOpts,
): FnHandle<FnParamSpec, string> {
  const named = typeof a === 'string'
  const name = named ? (a as string) : `_fn${fnAutoState.n++}`
  const params = (named ? b : a) as FnParamSpec
  // The slot after params is either the EXPLICIT return type (a ShaderType) or the BODY (a function) when
  // the return type is inferred. A ShaderType is a plain object; the body is a function — that tells them apart.
  const retOrBody = named ? c : b
  const explicitRet = typeof retOrBody === 'function' ? undefined : (retOrBody as ShaderType)
  const inferred = explicitRet === undefined
  const body = (inferred ? retOrBody : named ? d : c) as FnBody<FnParamSpec, string>
  const opts = (named ? (inferred ? d : e) : inferred ? c : d) as FnOpts | undefined
  // A param value is a plain ShaderType, a FieldSpec `{ type, attr }` (builtin/location)
  // for an entry-point param — the `attr` flows straight to the emitted `@builtin(…)`/
  // `@location(…)` — or a structDecl/ioStruct HANDLE (#740 R6), whose param arrives in
  // the body as the TYPED field proxy (no `X.of(p.in)` re-assertion).
  const entries = Object.entries(params).map(([n, spec]) => {
    const isHandle = 'of' in spec && typeof (spec as StructParamHandle).of === 'function'
    const fieldSpec = !isHandle && 'attr' in spec ? (spec as ParamAttr) : undefined
    return {
      name: n,
      type: (isHandle || 'attr' in spec
        ? (spec as ParamAttr | StructParamHandle).type
        : spec) as ShaderType,
      attr: fieldSpec?.attr,
      // #763 S5 — thread the structured IO fields through to FuncDecl.params;
      // dropping them here made reflect() see ZERO vertex attributes for
      // location()-authored entry params (the string fallback was load-bearing).
      location: fieldSpec?.location,
      builtin: fieldSpec?.builtin,
      interpolate: fieldSpec?.interpolate,
      handle: isHandle ? (spec as StructParamHandle) : undefined,
    }
  })
  const paramList = entries.map((p) => ({
    name: p.name,
    type: p.type,
    ...(p.attr !== undefined ? { attr: p.attr } : {}),
    ...(p.location !== undefined ? { location: p.location } : {}),
    ...(p.builtin !== undefined ? { builtin: p.builtin } : {}),
    ...(p.interpolate !== undefined ? { interpolate: p.interpolate } : {}),
  }))
  const paramNodes = Object.fromEntries(
    entries.map((p) => {
      const node = new Node({ op: 'param', type: p.type, name: p.name })
      return [p.name, p.handle ? p.handle.of(node) : node]
    }),
  ) as ParamNodes<FnParamSpec>
  const bld = new Builder()
  // A body may `return value` (native TS) for its FINAL return — fn appends the
  // ret Stmt, so authoring reads like a normal function. Early returns inside
  // control flow still use Return() (a native return there only exits the closure).
  const rawResult = withScope(bld, () => {
    try {
      return body(paramNodes, bld)
    } catch (e) {
      // #843 — outermost authoring context: name the fn whose body threw, once
      // (a nested subBody has already tagged the statement kind by this point).
      tagAuthoringError(e, AUTHOR_FN_TAGGED, `while building fn '${name}'`)
      throw e
    }
  })
  // A struct field proxy returned directly (`return o` — #763 X14) forwards
  // `.expr`/`.type` to its base var, so it reads like a node from here on.
  const result = rawResult as ReadonlyNode | void
  if (result !== undefined) bld.ret(result)
  // Return type: explicit token if given, else inferred from what the body returns.
  const ret = explicitRet ?? inferReturnType(result, bld.stmts)
  // stage → pipeline attrs (@vertex / @fragment / @compute @workgroup_size(N)).
  const attrs =
    opts?.stage === 'compute'
      ? ['@compute', `@workgroup_size(${opts.workgroupSize ?? 64})`]
      : opts?.stage
        ? [`@${opts.stage}`]
        : undefined
  // retAttr: string | FieldSpec, with the fragment default (#763 X3).
  const retAttrRaw = opts?.retAttr
  const retAttr =
    (typeof retAttrRaw === 'string' ? retAttrRaw : retAttrRaw?.attr) ??
    (opts?.stage === 'fragment' && ret.kind !== 'struct' && ret.kind !== 'void'
      ? '@location(0)'
      : undefined)
  const decl: FuncDecl = {
    name,
    params: paramList,
    ret,
    body: bld.stmts,
    attrs,
    // Structured stage (#740 R3) — reflect/backends read these; `attrs` stays the emit spelling.
    stage: opts?.stage,
    workgroupSize: opts?.stage === 'compute' ? (opts.workgroupSize ?? 64) : undefined,
    retAttr,
    allowEarlyReturn: opts?.allowEarlyReturn,
    lintDisable: opts?.lintDisable,
  }
  // The handle IS the call node factory (shared with externFn); the FuncDecl fields are mixed
  // onto it so it still duck-types as a FuncDecl in a module's funcs[]. `name` is a non-writable
  // function prop, so it is set via defineProperty (Object.assign would throw on it under strict).
  const handle = makeCallFactory(name, ret, paramList, decl) as FnHandle<FnParamSpec, string>
  // enumerable so `{ ...handle }` (e.g. the projection-fn spread) carries the name; a
  // function's own `name` is non-enumerable by default, which would drop it from a spread.
  Object.defineProperty(handle, 'name', { value: name, configurable: true, enumerable: true })
  Object.assign(handle, {
    params: paramList,
    ret,
    body: decl.body,
    attrs: decl.attrs,
    retAttr: decl.retAttr,
    allowEarlyReturn: decl.allowEarlyReturn,
    lintDisable: decl.lintDisable,
    decl,
  })
  // Stamp the handle (the object that lands in a module's funcs[] and that the lint
  // engine iterates) with its authored location, so Func-level diagnostics can resolve
  // a file:line:col. No-op unless source tracing is on.
  recordLoc(handle, captureLoc())
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
  /** Typed object-param call — same arg union as FnHandle (#763 X4/#755): args are
   *  READ, so ReadonlyNode (Let() results, params) and raw numbers (lifted to the
   *  declared param type by the shared call factory) are accepted. */
  (args: { readonly [K in keyof P]: ReadonlyNode<KeyOf<P[K]>> | number }): Node<KeyOf<R>>
  (...args: NodeLike[]): Node<KeyOf<R>>
}
export function externFn<P extends ParamSpec, R extends ShaderType>(
  name: string,
  params: P,
  ret: R,
): ExternFn<P, R> {
  const paramList = Object.entries(params).map(([n, type]) => ({ name: n, type }))
  return makeCallFactory(name, ret, paramList) as ExternFn<P, R>
}

// ── module assembly: transitive fn collection + key-naming (#740 R1) ──

/** `module()` input: like Partial<ModuleDecl>, but `funcs` also accepts a
 *  key-named record — `{ vs, fs }` / `{ vs: someHandle }` — where each KEY names
 *  its fn (an anonymous `fn(params, body)` gets its real name here; a named one
 *  is renamed if the key differs, with every handle-made call re-spelled). */
/** A declarator handle accepted by `module({ uses })` (#763 X1) — anything
 *  that carries its own decl/binding: uniformStruct ({struct,binding}),
 *  ioStruct/structDecl ({decl}), constDecl ({decl,node}), storageBuffer
 *  ({binding,+elementDecl for struct elements}), resource ({binding}). */
export type UsesHandle =
  | { readonly struct: StructDecl; readonly binding: BindingDecl }
  | { readonly decl: StructDecl | ConstDecl }
  | { readonly binding: BindingDecl; readonly elementDecl?: StructDecl }

export interface ModuleParts extends Omit<Partial<ModuleDecl>, 'funcs'> {
  readonly funcs?: readonly FuncDecl[] | Readonly<Record<string, FuncDecl>>
  /** Handle list — structs/bindings/consts are DERIVED from these (#763 X1). */
  readonly uses?: readonly UsesHandle[]
}

/** The decl behind a funcs[] item — FnHandle carries `.decl`; a plain FuncDecl is itself. */
const declOf = (f: FuncDecl): FuncDecl => (f as { decl?: FuncDecl }).decl ?? f

/** Visit every call Expr in a body (the collector's only interest — full walk). */
function walkCalls(
  stmts: readonly Stmt[],
  onCall: (e: Extract<Expr, { op: 'call' }>) => void,
): void {
  const expr = (e: Expr): void => {
    switch (e.op) {
      case 'binop':
      case 'compare':
      case 'logical':
        expr(e.a)
        expr(e.b)
        break
      case 'unop':
        expr(e.a)
        break
      case 'call':
        onCall(e)
        for (const a of e.args) expr(a)
        break
      case 'construct':
        for (const a of e.args) expr(a)
        break
      case 'member':
        expr(e.base)
        break
      case 'index':
        expr(e.base)
        expr(e.idx)
        break
      case 'select':
        expr(e.cond)
        expr(e.ifTrue)
        expr(e.ifFalse)
        break
      case 'matchExpr':
        expr(e.scrutinee)
        for (const [, v] of e.cases) expr(v)
        expr(e.default)
        break
      default:
        break // lit / constref / param / varref — leaves
    }
  }
  const stmt = (s: Stmt): void => {
    switch (s.s) {
      case 'let':
        expr(s.expr)
        break
      case 'var':
        if (s.init) expr(s.init)
        break
      case 'assign':
      case 'assignOp':
        expr(s.target)
        expr(s.expr)
        break
      case 'return':
        if (s.expr) expr(s.expr)
        break
      case 'if':
        for (const arm of s.arms) {
          expr(arm.cond)
          arm.body.forEach(stmt)
        }
        s.elseBody?.forEach(stmt)
        break
      case 'for':
        stmt(s.init)
        expr(s.cond)
        stmt(s.update)
        s.body.forEach(stmt)
        break
      case 'switch':
        expr(s.scrut)
        for (const c of s.cases) c.body.forEach(stmt)
        s.defaultBody?.forEach(stmt)
        break
      default:
        break // break / continue / discard / placeholder / raw — no exprs
    }
  }
  stmts.forEach(stmt)
}

/** Normalize `funcs` (array or key-named record) into the ModuleDecl array:
 *  1. Record form: each key names its decl (anonymous fns get their real name;
 *     a differing name is a rename — every handle-made call re-spells via declRef).
 *  2. Transitive collection: fns reached through handle calls (`declRef`) but not
 *     listed are PREPENDED in callee-first (post-order) discovery order — the
 *     authored list keeps its exact order, so existing full lists emit
 *     byte-identically and an entries-only list still satisfies GLSL's
 *     define-before-use. externFn / raw callFn names carry no declRef and are
 *     linked at emit as before. */
function normalizeFuncs(input: ModuleParts['funcs']): FuncDecl[] {
  const record = input !== undefined && !Array.isArray(input)
  let renamed = false
  const authored: FuncDecl[] = record
    ? Object.entries(input as Readonly<Record<string, FuncDecl>>).map(([key, f]) => {
        const d = declOf(f)
        // #763 D4 — a record-form rename mutates the SHARED FuncDecl in place.
        // If this decl already participated in another assembly under a
        // DIFFERENT name, renaming it now silently corrupts that module's
        // re-emit (`fn old` definition vs `new(...)` calls). Fail loud.
        const prev = d[ASSEMBLED_AS]
        if (prev !== undefined && prev !== key) {
          throw new Error(
            `shader-dsl: fn was already assembled as '${prev}' — renaming the shared decl to '${key}' would corrupt the earlier module's re-emit (#763 D4). Author a separate fn (or reuse the key '${prev}').`,
          )
        }
        if (d.name !== key) {
          ;(d as { name: string }).name = key
          // Keep the handle's own (defineProperty'd, enumerable) name in step for spreads.
          if (d !== f)
            Object.defineProperty(f, 'name', { value: key, configurable: true, enumerable: true })
          renamed = true
        }
        // Non-enumerable — the optimizer's fixpoint compares modules via JSON;
        // an enumerable marker would perturb it.
        Object.defineProperty(d, ASSEMBLED_AS, { value: key, configurable: true })
        return f
      })
    : (input ?? []).map((f) => {
        // Array-form assembly pins the CURRENT name for the same reason — a later
        // record-form rename of this decl would corrupt THIS module's re-emit.
        const d = declOf(f)
        Object.defineProperty(d, ASSEMBLED_AS, { value: d.name, configurable: true })
        return f
      })

  // Transitive collection (post-order DFS over declRef edges), skipping listed decls.
  // Dedup is by IDENTITY **and NAME**: module semantics are name-keyed (dup-func is a
  // validation error), and a pass-transformed fn (e.g. the polygon composer's
  // placeholder-swapped copies) is a NEW object whose body still carries declRefs to
  // the ORIGINALS — identity alone would re-collect a fn the module already lists
  // under the same name.
  const listed = new Set(authored.map(declOf))
  const listedNames = new Set(authored.map((f) => declOf(f).name))
  const collected: FuncDecl[] = []
  const visit = (d: FuncDecl): void => {
    walkCalls(d.body, (e) => {
      const callee = e.declRef
      if (!callee || listed.has(callee) || listedNames.has(callee.name)) return
      listed.add(callee)
      listedNames.add(callee.name)
      visit(callee) // callee's own callees first…
      collected.push(callee) // …then the callee (post-order = define-before-use)
    })
  }
  authored.forEach((f) => visit(declOf(f)))
  const funcs = collected.length ? [...collected, ...authored] : authored

  // A rename can postdate call nodes authored in OTHER fn bodies — re-spell them.
  if (renamed) {
    for (const f of funcs) {
      walkCalls(declOf(f).body, (e) => {
        if (e.declRef && e.fn !== e.declRef.name) (e as { fn: string }).fn = e.declRef.name
      })
    }
  }
  return funcs
}

/** Assemble a module from its declarations. `funcs` may be the classic array
 *  (order preserved verbatim; transitively handle-called fns are prepended
 *  callee-first) or a key-named record — see ModuleParts. */
export function module(parts: ModuleParts): ModuleDecl {
  // #763 X1 — `uses:` derives structs/bindings/consts from the HANDLES, which
  // already know their own decls; every module used to restate them by hand,
  // and a forgotten `U.binding` was green through tsc AND validate, dying at
  // pipeline creation. Explicit arrays still work and merge (name-deduped —
  // the dup-struct/dup-func validate rules would reject the overlap).
  // Explicit arrays pass through UNTOUCHED — validate's dup-struct/dup-func
  // rules must still see an author's accidental duplicates. Only the
  // uses-DERIVED decls dedupe against what is already present (an explicit
  // entry + the same handle in `uses` is the legal merge case).
  const consts: ConstDecl[] = [...(parts.consts ?? [])]
  const structs: StructDecl[] = [...(parts.structs ?? [])]
  const bindings: BindingDecl[] = [...(parts.bindings ?? [])]
  const structNames = new Set(structs.map((s) => s.name))
  const constNames = new Set(consts.map((c) => c.name))
  const bindingKeys = new Set(bindings.map((b) => `${b.group}:${b.binding}:${b.name}`))
  const addStruct = (s: StructDecl): void => {
    if (!structNames.has(s.name)) {
      structNames.add(s.name)
      structs.push(s)
    }
  }
  const addConst = (c: ConstDecl): void => {
    if (!constNames.has(c.name)) {
      constNames.add(c.name)
      consts.push(c)
    }
  }
  const addBinding = (b: BindingDecl): void => {
    const k = `${b.group}:${b.binding}:${b.name}`
    if (!bindingKeys.has(k)) {
      bindingKeys.add(k)
      bindings.push(b)
    }
  }
  for (const h of parts.uses ?? []) {
    if ('struct' in h && h.struct)
      addStruct(h.struct) // uniformStruct
    else if ('decl' in h && h.decl && 'fields' in h.decl)
      addStruct(h.decl) // ioStruct / structDecl
    else if ('decl' in h && h.decl) addConst(h.decl as ConstDecl) // constDecl handle
    if ('elementDecl' in h && h.elementDecl) addStruct(h.elementDecl) // storageBuffer's struct element
    if ('binding' in h && h.binding) addBinding(h.binding) // uniformStruct / storageBuffer / resource
  }
  const decl: ModuleDecl = {
    consts,
    structs,
    bindings,
    funcs: normalizeFuncs(parts.funcs),
    // #923 — carry the specialization-constant declarators through (absent ⇒ omit the
    // key, so an override-free module object stays byte-identical to before).
    ...(parts.overrides ? { overrides: parts.overrides } : {}),
  }
  // #628 — carry the opt-in language-feature caps through (absent ⇒ omit the key, so an
  // enables-free module object stays byte-identical to before).
  return parts.enables ? { ...decl, enables: parts.enables } : decl
}

/** Author a module-level constant from an IR VALUE expression — the general
 *  (non-scalar) const form. `value` may be any constant-foldable literal Node:
 *  a vector `vec4(…)`, an `array(…)` literal, a struct constructor, or a scalar.
 *  Emits `const <name>: <type> = <value>;` on WGSL + GLSL and evaluates `value`
 *  on the CPU oracle. For a plain scalar `f32` const that needs the truncated-
 *  vs-full-precision split (e.g. `PI`), author the `{wgslValue, cpuValue}` form
 *  directly instead. */
export function constExpr(name: string, type: ShaderType, value: Node): ConstDecl {
  return { name, type, wgslValue: 0, cpuValue: 0, valueExpr: value.expr }
}

/** A pipeline SPECIALIZATION CONSTANT (#923) handle — `.node` is the opaque READ
 *  (usable in any expression / branch guard); `.decl` goes into
 *  `module({ overrides: [...] })`. */
export interface OverrideHandle<K extends string> {
  readonly node: ReadonlyNode<K>
  readonly decl: OverrideDecl
}

/** Author a pipeline specialization constant (#923): one declarator that lowers to a
 *  WGSL module-scope `override name: type = default;` (host specializes via
 *  `createRenderPipeline({ constants: { name } })`) AND a GLSL `#define` permutation
 *  seam (host specializes by re-emitting with `emitGlslModule(m, stage, { overrideValues })`
 *  per variant — GLSL forbids a prepended `#define`, so the value is spelled and placed
 *  after the `#version` preamble by the emitter). The value is fixed at PIPELINE
 *  CREATION, not module build, so its read stays OPAQUE to the optimizer — a branch
 *  guarded by `q.node` (e.g. `If(q.node.gt(1), …)`) survives every DSL pass and is
 *  eliminated by the DRIVER per variant, giving the classic ubershader mechanism.
 *
 *  WGSL scalars ONLY (bool/i32/u32/f32) — WGSL forbids vec/matrix overrides, so a
 *  non-scalar type is rejected here (SD0014). `f16` slots in once it joins the Scalar
 *  union (gated by the #957 f16 `enable`). */
export function overrideConst<T extends ShaderType>(
  name: string,
  type: T,
  defaultValue: number | boolean,
): OverrideHandle<KeyOf<T>> {
  if (type.kind !== 'scalar') {
    throw dslError('SD0014', `override '${name}': ${type.kind}`)
  }
  return { node: overrideRef(name, type), decl: { name, type, default: defaultValue } }
}

// ── Ambient free-function authoring surface (C2) ──
// Capitalised to avoid JS keyword clashes (If/Loop/Let/Var/Return/Switch); each
// routes to the INNERMOST active scope (currentBuilder), so no `Builder` param is
// threaded per nesting level. The old `cb.let(...)` / `(b) => …` callback API still
// works (both push the same Stmt[]), so shaders migrate function-by-function and the
// emit stays byte-identical. IfChain.elif/.else accept a zero-arg `() => …` body
// (a 0-arg fn is assignable where `(b) => void` is wanted), so chains read clean too.

export function Let<K extends string>(value: ReadonlyNode<K>): ReadonlyNode<K>
export function Let<K extends string>(name: string, value: ReadonlyNode<K>): ReadonlyNode<K>
export function Let<K extends string>(
  nameOrValue: string | ReadonlyNode<K>,
  maybeValue?: ReadonlyNode<K>,
): ReadonlyNode<K> {
  return typeof nameOrValue === 'string'
    ? currentBuilder().let(nameOrValue, maybeValue!)
    : currentBuilder().let(nameOrValue)
}
export function Var<K extends string>(init: ReadonlyNode<K>): Node<K>
export function Var<T extends ShaderType>(type: T, init?: ReadonlyNode<KeyOf<T>>): Node<KeyOf<T>>
export function Var<T extends ShaderType>(
  name: string,
  type: T,
  init?: ReadonlyNode<KeyOf<T>>,
): Node<KeyOf<T>>
/** Named + type-inferred (#763 X9) — the one missing cell of the naming matrix:
 *  `Var('n', init)` mirrors `Let('n', init)`; the mutable form used to force
 *  restating the type token the init already carries. */
export function Var<K extends string>(name: string, init: ReadonlyNode<K>): Node<K>
export function Var<T extends ShaderType>(
  nameOrTypeOrInit: string | T | ReadonlyNode,
  typeOrInit?: T | ReadonlyNode<KeyOf<T>>,
  maybeInit?: ReadonlyNode<KeyOf<T>>,
): Node<KeyOf<T>> {
  // Var(init) — a mutable var seeded from a value infers its WGSL type from that value.
  // Brand probe, not instanceof (#763 D1) — a cross-instance init node must not
  // fall through to the ShaderType arm and declare a garbage-typed var.
  if (isNodeValue(nameOrTypeOrInit))
    return currentBuilder().var(nameOrTypeOrInit.type, nameOrTypeOrInit) as Node<KeyOf<T>>
  if (typeof nameOrTypeOrInit === 'string') {
    // Var(name, init) — the second slot is a NODE, not a ShaderType (#763 X9).
    if (isNodeValue(typeOrInit))
      return currentBuilder().var(nameOrTypeOrInit, typeOrInit.type, typeOrInit) as Node<KeyOf<T>>
    return currentBuilder().var(nameOrTypeOrInit, typeOrInit as T, maybeInit)
  }
  return currentBuilder().var(nameOrTypeOrInit, typeOrInit as Node<KeyOf<T>> | undefined)
}
export const Return = (value?: ReadonlyNode): void => currentBuilder().ret(value)
/** Guard clause — `if (cond) { return value; }`. The readable, EXPLICIT early return:
 *  reads as "return value if cond", unlike `If(cond, () => value)` which looks like a
 *  fall-through. Emits identically to `If(cond, () => Return(value))`. */
export const ReturnIf = (cond: ReadonlyNode<'bool'>, value?: ReadonlyNode): void => {
  currentBuilder().if(cond, (b) => b.ret(value))
}
export const Continue = (): void => currentBuilder().continue()
export const Break = (): void => currentBuilder().break()
export const Discard = (): void => currentBuilder().discard()

/** `if (cond) { body }` over the innermost scope; a body may `return value` for an
 *  early return (same `return` everywhere). Chain `.elif(c, () => …)` / `.else(() => …)`. */
export const If = (cond: ReadonlyNode<'bool'>, body: () => ReadonlyNode | void): IfChain =>
  currentBuilder().if(cond, () => body())

/** C-style for over the innermost scope; the body receives the typed counter Node.
 *  init/step/cond-result are READ positions — they accept `ReadonlyNode` (#763 G4);
 *  the counter handed to the callbacks stays a mutable `Node` (loop-var reassignment
 *  is legal WGSL). */
export function Loop<K extends string>(
  init: ReadonlyNode<K>,
  cond: (i: Node<K>) => ReadonlyNode<'bool'>,
  body: (i: Node<K>) => ReadonlyNode | void,
  step?: ReadonlyNode<ScalarKey> | number,
): void
export function Loop<K extends string>(
  name: string,
  init: ReadonlyNode<K>,
  cond: (i: Node<K>) => ReadonlyNode<'bool'>,
  body: (i: Node<K>) => ReadonlyNode | void,
  step?: ReadonlyNode<ScalarKey> | number,
): void
export function Loop<K extends string>(
  a: string | ReadonlyNode<K>,
  b: ReadonlyNode<K> | ((i: Node<K>) => ReadonlyNode<'bool'>),
  c: ((i: Node<K>) => ReadonlyNode<'bool'>) | ((i: Node<K>) => ReadonlyNode | void),
  d?: ((i: Node<K>) => ReadonlyNode | void) | ReadonlyNode<ScalarKey> | number,
  e?: ReadonlyNode<ScalarKey> | number,
): void {
  const named = typeof a === 'string'
  const init = (named ? b : a) as ReadonlyNode<K>
  const cond = (named ? c : b) as (i: Node<K>) => ReadonlyNode<'bool'>
  const body = (named ? d : c) as (i: Node<K>) => ReadonlyNode | void
  const step = (named ? e : d) as ReadonlyNode<ScalarKey> | number | undefined
  if (named) currentBuilder().forRange(a as string, init, cond, (_b, i) => body(i), step)
  else currentBuilder().forRange(init, cond, (_b, i) => body(i), step)
}

/** Immutable fold over a C-style loop — the functional spelling of the `var acc = init; for
 *  (...) { acc = f(acc, i) }` accumulator. The body RETURNS the next accumulator value (no
 *  `Var` + `assign` at the call site); reduce materialises the var + loop + assign internally,
 *  so the emit is byte-identical. Returns the accumulator Node for use after the loop. */
export function reduce<K extends string, J extends string>(
  init: ReadonlyNode<K>,
  loopInit: ReadonlyNode<J>,
  cond: (i: Node<J>) => ReadonlyNode<'bool'>,
  body: (acc: Node<K>, i: Node<J>) => ReadonlyNode<K>,
  step?: ReadonlyNode<ScalarKey> | number,
): Node<K> {
  const acc = currentBuilder().var(init.type, init) as Node<K>
  currentBuilder().forRange(
    loopInit,
    cond,
    (_b, i) => {
      currentBuilder().assign(acc, body(acc, i))
    },
    step,
  )
  return acc
}

/** Immutable value-by-CONDITION dispatch — `var v; if (c0) v=e0; else if (c1) v=e1; … else v=eN`.
 *  Each arm RETURNS its value; `when` materialises the var + if/elif/else chain internally, so the
 *  emit is byte-identical to the hand form (it does NOT lower to `select`). Two shapes:
 *    when(cond, () => a, () => b)                      — 2-arm
 *    when([[c0, () => e0], [c1, () => e1]], () => eN)  — N-arm (first true condition wins)
 *
 *  The orthogonal value-dispatch surface: `when` for a boolean TEST, `matchExpr`/`Switch` for integer
 *  SCRUTINEE dispatch, `select` for an eager 2-way (both arms evaluated). (Subsumes the former
 *  `ifExpr`/`condExpr`.) Conditions are read positions, so they accept the immutable `ReadonlyNode`. */
export function when<K extends string>(
  cond: ReadonlyNode<'bool'>,
  thenVal: () => ReadonlyNode<K>,
  elseVal: () => ReadonlyNode<K>,
): Node<K>
export function when<K extends string>(
  arms: ReadonlyArray<readonly [ReadonlyNode<'bool'>, () => ReadonlyNode<K>]>,
  elseVal: () => ReadonlyNode<K>,
): Node<K>
export function when<K extends string>(
  a: ReadonlyNode<'bool'> | ReadonlyArray<readonly [ReadonlyNode<'bool'>, () => ReadonlyNode<K>]>,
  b: () => ReadonlyNode<K>,
  c?: () => ReadonlyNode<K>,
): Node<K> {
  const arms: ReadonlyArray<readonly [ReadonlyNode<'bool'>, () => ReadonlyNode<K>]> = Array.isArray(
    a,
  )
    ? a
    : [[a as ReadonlyNode<'bool'>, b]]
  const elseVal = (Array.isArray(a) ? b : c) as () => ReadonlyNode<K>
  const bld = currentBuilder()
  const iv = bld.inferredVar()
  let vt: ShaderType | undefined
  const arm = (v: () => ReadonlyNode<K>) => () => {
    const val = v()
    vt ??= val.type
    currentBuilder().assign(iv.ref(val.type) as Node<K>, val)
  }
  let chain = bld.if(arms[0][0], arm(arms[0][1]))
  for (let k = 1; k < arms.length; k++) chain = chain.elif(arms[k][0], arm(arms[k][1]))
  chain.else(arm(elseVal))
  iv.commit(vt!)
  return iv.ref(vt!) as Node<K>
}

/** @deprecated Use `when(cond, then, else)` — the unified condition-dispatch primitive. */
export function ifExpr<K extends string>(
  cond: ReadonlyNode<'bool'>,
  thenVal: () => ReadonlyNode<K>,
  elseVal: () => ReadonlyNode<K>,
): Node<K> {
  return when(cond, thenVal, elseVal)
}

/** @deprecated Use `when(arms, else)` — the unified condition-dispatch primitive. */
export function condExpr<K extends string>(
  arms: ReadonlyArray<readonly [ReadonlyNode<'bool'>, () => ReadonlyNode<K>]>,
  elseVal: () => ReadonlyNode<K>,
): Node<K> {
  return when(arms, elseVal)
}

/** `switch (scrut) { case n: …; default: … }` as a chainable statement BUILDER — mirrors the
 *  If(…).elif(…).else(…) surface so dispatch reads the known imperative way: forward-declare a
 *  `Var(default)`, then assign it inside the case arms.
 *    const radiusPx = Var(rawRadius)
 *    Switch(sizeMode)
 *      .case(1, () => radiusPx.assign(rawRadius.div(viewport.z)))
 *      .case(2, () => radiusPx.assign(…))
 *      .default(() => {})
 *  Lowers to a real WGSL `switch`. `.case(n, body)` ~ a case label, `.default(body?)` ~ the default arm
 *  (optional) + the terminator. */
export class SwitchChain {
  private readonly cases: Array<[number, () => void]> = []
  constructor(private readonly scrut: ReadonlyNode<ScalarKey>) {}
  case(value: number, body: () => void): SwitchChain {
    this.cases.push([value, body])
    return this
  }
  default(body?: () => void): void {
    currentBuilder().switch(
      this.scrut,
      this.cases.map(
        ([v, f]) => [v, (_b: Builder) => f()] as [number, (bb: Builder) => ReadonlyNode | void],
      ),
      body ? (_b: Builder) => body() : undefined,
    )
  }
}

/** Open a `switch (scrut)` chain — `Switch(scrut).case(n, body)….default(body)`.
 *  The scrutinee is a READ position — `ReadonlyNode`, same as the underlying
 *  `Builder.switch` (#763 G4; the two spellings had drifted apart). */
export function Switch(scrut: ReadonlyNode<ScalarKey>): SwitchChain {
  return new SwitchChain(scrut)
}
