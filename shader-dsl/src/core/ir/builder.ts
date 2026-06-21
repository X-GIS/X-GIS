// ═══ Shader DSL — function/statement builder ═══
//
// The imperative authoring surface: Builder (collects Stmt nodes via
// let/var/assign/if/for/switch/ret/…), the IfChain helper, and the fn /
// computeFn / entryFn / module assemblers. Imports types + nodes + node.

import { type ShaderType, type KeyOf, type ScalarKey, vec3uT, voidT } from './types'
import type { Stmt, Expr, BinOp, FuncDecl, ModuleDecl, EntryParam } from './nodes'
import { Node, type ArithArg, type NodeLike, lift, f32, i32, u32, callFn } from './node'

export type ParamSpec = Record<string, ShaderType>
type ParamNodes<P extends ParamSpec> = { [K in keyof P]: Node<KeyOf<P[K]>> }

export class Builder {
  readonly stmts: Stmt[] = []

  private push(s: Stmt): void { this.stmts.push(s) }

  /** Immutable binding — `let name = expr;`. Returns a varref Node of the
   *  bound value's key. */
  let<K extends string>(name: string, value: Node<K>): Node<K> {
    this.push({ s: 'let', name, expr: value.expr })
    return new Node<K>({ op: 'varref', type: value.type, name })
  }

  /** Mutable binding — `var name: T = init?;`. Returns a varref Node. */
  var<T extends ShaderType>(name: string, type: T, init?: Node<KeyOf<T>>): Node<KeyOf<T>> {
    this.push({ s: 'var', name, type, init: init?.expr })
    return new Node<KeyOf<T>>({ op: 'varref', type, name })
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
  if(cond: Node<'bool'>, body: (b: Builder) => void): IfChain {
    const arms: Array<{ cond: Expr; body: Stmt[] }> = [{ cond: cond.expr, body: subBody(body) }]
    const stmt = { s: 'if' as const, arms, elseBody: undefined as Stmt[] | undefined }
    // Push a mutable-shaped object; the readonly Stmt typing is a compile-time
    // view only — the builder owns construction.
    this.push(stmt as unknown as Stmt)
    return new IfChain(arms, (e) => { stmt.elseBody = e })
  }

  /** C-style for: `for (var name = init; name <cond>; name = name+step)`.
   *  A numeric / omitted step is typed to the loop var's scalar so a u32/i32
   *  counter emits `i + 1u` / `i + 1` (not `i + 1.0`, which naga/tint reject). */
  forRange<K extends string>(
    name: string,
    init: Node<K>,
    cond: (i: Node<K>) => Node<'bool'>,
    body: (b: Builder, i: Node<K>) => void,
    step?: Node<ScalarKey> | number,
  ): void {
    const i = new Node<K>({ op: 'varref', type: init.type, name })
    const litOf = (v: number): Node => {
      if (init.type.kind === 'scalar' && init.type.scalar === 'u32') return u32(v)
      if (init.type.kind === 'scalar' && init.type.scalar === 'i32') return i32(v)
      return f32(v)
    }
    const stepNode = step === undefined ? litOf(1) : typeof step === 'number' ? litOf(step) : step
    const initStmt: Stmt = { s: 'var', name, type: init.type, init: init.expr }
    const updateStmt: Stmt = { s: 'assign', target: i.expr, expr: i.add(stepNode as ArithArg<K>).expr }
    this.push({ s: 'for', init: initStmt, cond: cond(i).expr, update: updateStmt, body: subBody((b) => body(b, i)) })
  }

  switch(scrut: Node<ScalarKey>, cases: Array<[number, (b: Builder) => void]>, defaultBody?: (b: Builder) => void): void {
    this.push({
      s: 'switch',
      scrut: scrut.expr,
      cases: cases.map(([value, fn]) => ({ value, body: subBody(fn) })),
      defaultBody: defaultBody ? subBody(defaultBody) : undefined,
    })
  }
}

export class IfChain {
  constructor(
    private readonly arms: Array<{ cond: Expr; body: Stmt[] }>,
    private readonly setElse: (body: Stmt[]) => void,
  ) {}
  elif(cond: Node<'bool'>, body: (b: Builder) => void): IfChain {
    this.arms.push({ cond: cond.expr, body: subBody(body) })
    return this
  }
  else(body: (b: Builder) => void): void {
    this.setElse(subBody(body))
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

function subBody(fn: (b: Builder) => void): Stmt[] {
  const b = new Builder()
  withScope(b, () => fn(b))
  return b.stmts
}

/** Author a function. The body callback receives the builder + typed param
 *  Nodes (each keyed by its ShaderType). Returns a FuncDecl for the module. */
export function fn<P extends ParamSpec>(
  name: string,
  params: P,
  ret: ShaderType,
  body: (b: Builder, p: ParamNodes<P>) => Node | void,
): FuncDecl {
  const paramList = Object.entries(params).map(([n, type]) => ({ name: n, type }))
  const paramNodes = Object.fromEntries(
    paramList.map((p) => [p.name, new Node({ op: 'param', type: p.type, name: p.name })]),
  ) as ParamNodes<P>
  const b = new Builder()
  // A body may `return value` (native TS) for its FINAL return — fn appends the
  // ret Stmt, so authoring reads like a normal function. Early returns inside
  // control flow still use Return() (a native return there only exits the closure).
  const result = withScope(b, () => body(b, paramNodes))
  if (result !== undefined) b.ret(result)
  return { name, params: paramList, ret, body: b.stmts }
}

/** Define a function AND return a typed CALLABLE: `const f = defineFn(...)` then
 *  `f(arg)` produces the call node (no string name at the call site, ret inferred),
 *  and `f.decl` is the FuncDecl for the module. Byte-identical to a separate
 *  `fn('name', …)` + `callFn('name', ret, …)`. */
export function defineFn<P extends ParamSpec, R extends ShaderType>(
  name: string,
  params: P,
  ret: R,
  body: (b: Builder, p: ParamNodes<P>) => Node | void,
): ((...args: NodeLike[]) => Node<KeyOf<R>>) & { readonly decl: FuncDecl } {
  const decl = fn(name, params, ret, body)
  const call = (...args: NodeLike[]): Node<KeyOf<R>> => callFn(name, ret, ...args)
  return Object.assign(call, { decl })
}

/** Author a `@compute @workgroup_size(N)` entry point. The body callback
 *  receives the builder + the `@builtin(global_invocation_id)` Node (vec3<u32>).
 *  Compute entries return void; output is via storage bindings. */
export function computeFn(
  name: string,
  workgroupSize: number,
  gidName: string,
  body: (b: Builder, gid: Node<'vec3<u32>'>) => void,
): FuncDecl {
  const gid = new Node<'vec3<u32>'>({ op: 'param', type: vec3uT, name: gidName })
  const b = new Builder()
  withScope(b, () => body(b, gid))
  return {
    name,
    params: [{ name: gidName, type: vec3uT, builtin: 'global_invocation_id' }],
    ret: voidT,
    body: b.stmts,
    attrs: ['@compute', `@workgroup_size(${workgroupSize})`],
  }
}

/** Maps an entry's param tuple to a name→keyed-Node record, so a `@builtin`
 *  scalar param (e.g. vertex_index: u32) is `Node<'u32'>`, usable as an index. */
type EntryParamNodes<P extends readonly EntryParam[]> = {
  [K in P[number]['name']]: Node<KeyOf<Extract<P[number], { name: K }>['type']>>
}

/** Author a `@vertex` / `@fragment` entry point. Params may carry a `@builtin`
 *  (vertex_index, etc.) or be an I/O struct (the interpolated vertex output);
 *  the body returns the stage's output struct. */
export function entryFn<const P extends readonly EntryParam[]>(
  name: string,
  stage: 'vertex' | 'fragment',
  params: P,
  ret: ShaderType,
  body: (b: Builder, p: EntryParamNodes<P>) => Node | void,
  retAttr?: string,
): FuncDecl {
  const paramNodes: Record<string, Node> = {}
  for (const p of params) paramNodes[p.name] = new Node({ op: 'param', type: p.type, name: p.name })
  const b = new Builder()
  // Native `return value` for the final return (see fn).
  const result = withScope(b, () => body(b, paramNodes as EntryParamNodes<P>))
  if (result !== undefined) b.ret(result)
  return {
    name,
    params: params.map((p) => ({ name: p.name, type: p.type, builtin: p.builtin, location: p.location })),
    ret,
    body: b.stmts,
    attrs: [`@${stage}`],
    retAttr,
  }
}

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

export const Let = <K extends string>(name: string, value: Node<K>): Node<K> => currentBuilder().let(name, value)
export const Var = <T extends ShaderType>(name: string, type: T, init?: Node<KeyOf<T>>): Node<KeyOf<T>> => currentBuilder().var(name, type, init)
export const assign = <K extends string>(target: Node<K>, value: Node<K>): void => currentBuilder().assign(target, value)
export const assignOp = <K extends string>(target: Node<K>, bop: BinOp, value: ArithArg<K>): void => currentBuilder().assignOp(target, bop, value)
export const addAssign = <K extends string>(target: Node<K>, value: ArithArg<K>): void => currentBuilder().addAssign(target, value)
export const Return = (value?: Node): void => currentBuilder().ret(value)
export const Continue = (): void => currentBuilder().continue()
export const Break = (): void => currentBuilder().break()
export const Discard = (): void => currentBuilder().discard()

/** `if (cond) { body }` over the innermost scope; chain `.elif(c, () => …)` / `.else(() => …)`. */
export const If = (cond: Node<'bool'>, body: () => void): IfChain => currentBuilder().if(cond, () => body())

/** C-style for over the innermost scope; the body receives the typed counter Node. */
export const Loop = <K extends string>(
  name: string,
  init: Node<K>,
  cond: (i: Node<K>) => Node<'bool'>,
  body: (i: Node<K>) => void,
  step?: Node<ScalarKey> | number,
): void => currentBuilder().forRange(name, init, cond, (_b, i) => body(i), step)

export const Switch = (
  scrut: Node<ScalarKey>,
  cases: Array<[number, () => void]>,
  defaultBody?: () => void,
): void => currentBuilder().switch(
  scrut,
  cases.map(([v, f]) => [v, (_b: Builder) => f()] as [number, (b: Builder) => void]),
  defaultBody ? (_b: Builder) => defaultBody() : undefined,
)
