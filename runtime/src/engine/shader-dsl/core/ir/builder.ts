// ═══ Shader DSL — function/statement builder ═══
//
// The imperative authoring surface: Builder (collects Stmt nodes via
// let/var/assign/if/for/switch/ret/…), the IfChain helper, and the fn /
// computeFn / entryFn / module assemblers. Imports types + nodes + node.

import { type ShaderType, type KeyOf, type ScalarKey, vec3uT, voidT } from './types'
import type { Stmt, Expr, BinOp, FuncDecl, ModuleDecl, EntryParam } from './nodes'
import { Node, type ArithArg, lift, f32, i32, u32 } from './node'

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
  discard(): void { this.push({ s: 'discard' }) }

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

function subBody(fn: (b: Builder) => void): Stmt[] {
  const b = new Builder()
  fn(b)
  return b.stmts
}

/** Author a function. The body callback receives the builder + typed param
 *  Nodes (each keyed by its ShaderType). Returns a FuncDecl for the module. */
export function fn<P extends ParamSpec>(
  name: string,
  params: P,
  ret: ShaderType,
  body: (b: Builder, p: ParamNodes<P>) => void,
): FuncDecl {
  const paramList = Object.entries(params).map(([n, type]) => ({ name: n, type }))
  const paramNodes = Object.fromEntries(
    paramList.map((p) => [p.name, new Node({ op: 'param', type: p.type, name: p.name })]),
  ) as ParamNodes<P>
  const b = new Builder()
  body(b, paramNodes)
  return { name, params: paramList, ret, body: b.stmts }
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
  body(b, gid)
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
  body: (b: Builder, p: EntryParamNodes<P>) => void,
  retAttr?: string,
): FuncDecl {
  const paramNodes: Record<string, Node> = {}
  for (const p of params) paramNodes[p.name] = new Node({ op: 'param', type: p.type, name: p.name })
  const b = new Builder()
  body(b, paramNodes as EntryParamNodes<P>)
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
