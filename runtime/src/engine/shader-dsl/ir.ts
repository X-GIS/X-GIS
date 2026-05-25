// ═══ Shader DSL — IR core + authoring API ═══
//
// In-house, zero-dep, TSL-inspired TypeScript shader DSL. A shader is
// authored as a typed node graph (expression chaining + an imperative
// statement-list builder for control flow). The graph IS the IR; two
// backends lower it:
//   - backend-wgsl.ts  → WGSL string for createShaderModule (real-time GPU)
//   - backend-cpu.ts   → f64 tree-walk interpreter (replaces the hand-
//                         maintained projection-wgsl-mirror.ts; same numbers)
//
// Design (locked in the deep-interview + consensus plan):
//   - Imperative statement-list IR (NOT a pure value-DAG): control flow is
//     first-class ($let/$var/$assign/$if/$for/$switch/$return/$break/$discard)
//     because the line/SDF shaders are imperative. TSL chaining is for
//     EXPRESSIONS only.
//   - Every expression node carries a ShaderType; type inference makes a
//     WGSL type error a TS error (vec3+vec2 etc.) — the AC4 gate.
//   - Module-level consts carry a per-backend value. PI/DEG2RAD differ
//     between WGSL (truncated 3.14159265 / 0.01745329, matching the current
//     shader) and CPU (full-precision Math.PI / Math.PI/180, matching the
//     mirror). This encodes the two-tolerance f32/f64 reality structurally:
//     cpu-f64 reproduces the mirror @≤1mm; cpu-f64↔WGSL stays @100m.
//
// See ralplan-wgsl-tsl-shader-dsl.md (Phase 0) + the deep-interview spec.

// ── Types ──

export type Scalar = 'f32' | 'i32' | 'u32' | 'bool'

export type ShaderType =
  | { readonly kind: 'scalar'; readonly scalar: Scalar }
  | { readonly kind: 'vec'; readonly n: 2 | 3 | 4; readonly elem: 'f32' | 'i32' | 'u32' }
  | { readonly kind: 'struct'; readonly name: string }
  | { readonly kind: 'array'; readonly elem: ShaderType }
  | { readonly kind: 'void' }

export const f32T: ShaderType = { kind: 'scalar', scalar: 'f32' }
export const i32T: ShaderType = { kind: 'scalar', scalar: 'i32' }
export const u32T: ShaderType = { kind: 'scalar', scalar: 'u32' }
export const boolT: ShaderType = { kind: 'scalar', scalar: 'bool' }
export const vec2fT: ShaderType = { kind: 'vec', n: 2, elem: 'f32' }
export const vec3fT: ShaderType = { kind: 'vec', n: 3, elem: 'f32' }
export const vec4fT: ShaderType = { kind: 'vec', n: 4, elem: 'f32' }
export const vec3uT: ShaderType = { kind: 'vec', n: 3, elem: 'u32' }
export const vec4uT: ShaderType = { kind: 'vec', n: 4, elem: 'u32' }
export const voidT: ShaderType = { kind: 'void' }
export const structT = (name: string): ShaderType => ({ kind: 'struct', name })
export const arrayT = (elem: ShaderType): ShaderType => ({ kind: 'array', elem })

export function typeKey(t: ShaderType): string {
  switch (t.kind) {
    case 'scalar': return t.scalar
    case 'vec': return `vec${t.n}<${t.elem}>`
    case 'struct': return `struct:${t.name}`
    case 'array': return `array<${typeKey(t.elem)}>`
    case 'void': return 'void'
  }
}

export function typeEq(a: ShaderType, b: ShaderType): boolean {
  return typeKey(a) === typeKey(b)
}

const isVec = (t: ShaderType): t is Extract<ShaderType, { kind: 'vec' }> => t.kind === 'vec'
const isScalar = (t: ShaderType): t is Extract<ShaderType, { kind: 'scalar' }> => t.kind === 'scalar'

// ── Expression nodes ──

export type BinOp = '+' | '-' | '*' | '/' | '%'
export type CmpOp = '<' | '>' | '<=' | '>=' | '==' | '!='
export type LogOp = '&&' | '||'

export type Expr =
  | { readonly op: 'lit'; readonly type: ShaderType; readonly value: number | boolean }
  | { readonly op: 'constref'; readonly type: ShaderType; readonly name: string }
  | { readonly op: 'param'; readonly type: ShaderType; readonly name: string }
  | { readonly op: 'varref'; readonly type: ShaderType; readonly name: string }
  | { readonly op: 'binop'; readonly type: ShaderType; readonly bop: BinOp; readonly a: Expr; readonly b: Expr }
  | { readonly op: 'unop'; readonly type: ShaderType; readonly a: Expr }
  | { readonly op: 'compare'; readonly type: ShaderType; readonly cop: CmpOp; readonly a: Expr; readonly b: Expr }
  | { readonly op: 'logical'; readonly type: ShaderType; readonly lop: LogOp; readonly a: Expr; readonly b: Expr }
  | { readonly op: 'call'; readonly type: ShaderType; readonly fn: string; readonly args: readonly Expr[] }
  | { readonly op: 'member'; readonly type: ShaderType; readonly base: Expr; readonly field: string }
  | { readonly op: 'construct'; readonly type: ShaderType; readonly args: readonly Expr[] }
  | { readonly op: 'select'; readonly type: ShaderType; readonly cond: Expr; readonly ifTrue: Expr; readonly ifFalse: Expr }
  | { readonly op: 'index'; readonly type: ShaderType; readonly base: Expr; readonly idx: Expr }

// ── Statement nodes ──

export type Stmt =
  | { readonly s: 'let'; readonly name: string; readonly expr: Expr }
  | { readonly s: 'var'; readonly name: string; readonly type: ShaderType; readonly init?: Expr }
  | { readonly s: 'assign'; readonly target: Expr; readonly expr: Expr }
  | { readonly s: 'assignOp'; readonly target: Expr; readonly bop: BinOp; readonly expr: Expr }
  | { readonly s: 'if'; readonly arms: ReadonlyArray<{ readonly cond: Expr; readonly body: readonly Stmt[] }>; readonly elseBody?: readonly Stmt[] }
  | { readonly s: 'return'; readonly expr?: Expr }
  | { readonly s: 'for'; readonly init: Stmt; readonly cond: Expr; readonly update: Stmt; readonly body: readonly Stmt[] }
  | { readonly s: 'switch'; readonly scrut: Expr; readonly cases: ReadonlyArray<{ readonly value: number; readonly body: readonly Stmt[] }>; readonly defaultBody?: readonly Stmt[] }
  | { readonly s: 'break' }
  | { readonly s: 'discard' }

// ── Module-level declarations ──

export interface ConstDecl {
  readonly name: string
  readonly type: ShaderType
  /** Value emitted by the WGSL backend (the truncated shader constant). */
  readonly wgslValue: number
  /** Value used by the CPU backend (full-precision, matching the mirror). */
  readonly cpuValue: number
}

export interface StructField { readonly name: string; readonly type: ShaderType }
export interface StructDecl { readonly name: string; readonly fields: readonly StructField[] }

export type AddressSpace = 'uniform' | 'storage'
export interface BindingDecl {
  readonly group: number
  readonly binding: number
  readonly name: string
  readonly space: AddressSpace
  /** storage access — read | read_write (ignored for uniform). */
  readonly access?: 'read' | 'read_write'
  readonly type: ShaderType
}

export interface FuncDecl {
  readonly name: string
  readonly params: readonly { name: string; type: ShaderType; builtin?: string }[]
  readonly ret: ShaderType
  readonly body: readonly Stmt[]
  /** Stage / pipeline attributes emitted before `fn` (e.g. `@compute`,
   *  `@workgroup_size(64)`). Empty for ordinary helper functions. */
  readonly attrs?: readonly string[]
}

export interface ModuleDecl {
  readonly consts: readonly ConstDecl[]
  readonly structs: readonly StructDecl[]
  readonly bindings: readonly BindingDecl[]
  readonly funcs: readonly FuncDecl[]
}

// ── Authoring: the Node wrapper (TSL-style chaining over an Expr) ──

/** Anything acceptable where a Node is expected — a Node, or a number that
 *  is auto-lifted to an f32 literal (the projection math is f32-dominant). */
export type NodeLike = Node | number

function lift(x: NodeLike): Node {
  return typeof x === 'number' ? new Node({ op: 'lit', type: f32T, value: x }) : x
}

/** Result type of a binary arithmetic op given operand types. vec op scalar
 *  (or vec op same-vec) → vec; scalar op scalar → f32>i32>u32 promotion. A
 *  vec op a different vec is a type error (returned as a poisoned mismatch
 *  that the WGSL/CPU backend never sees because typecheck fails first). */
function binResultType(a: ShaderType, b: ShaderType, ctx: string): ShaderType {
  if (isVec(a) && isVec(b)) {
    if (!typeEq(a, b)) throw new Error(`shader-dsl: ${ctx} on mismatched vectors ${typeKey(a)} vs ${typeKey(b)}`)
    return a
  }
  if (isVec(a) && isScalar(b)) return a
  if (isScalar(a) && isVec(b)) return b
  if (isScalar(a) && isScalar(b)) {
    const order: Scalar[] = ['f32', 'i32', 'u32']
    const as = a.scalar, bs = b.scalar
    if (as === 'bool' || bs === 'bool') throw new Error(`shader-dsl: ${ctx} on bool`)
    return order.indexOf(as) <= order.indexOf(bs) ? a : b
  }
  throw new Error(`shader-dsl: ${ctx} on ${typeKey(a)} / ${typeKey(b)}`)
}

const VEC_FIELD_INDEX: Record<string, number> = { x: 0, y: 1, z: 2, w: 3 }

export class Node {
  constructor(readonly expr: Expr) {}
  get type(): ShaderType { return this.expr.type }

  private bin(bop: BinOp, o: NodeLike): Node {
    const b = lift(o)
    return new Node({ op: 'binop', type: binResultType(this.type, b.type, bop), bop, a: this.expr, b: b.expr })
  }
  add(o: NodeLike): Node { return this.bin('+', o) }
  sub(o: NodeLike): Node { return this.bin('-', o) }
  mul(o: NodeLike): Node { return this.bin('*', o) }
  div(o: NodeLike): Node { return this.bin('/', o) }
  mod(o: NodeLike): Node { return this.bin('%', o) }
  neg(): Node { return new Node({ op: 'unop', type: this.type, a: this.expr }) }

  private cmp(cop: CmpOp, o: NodeLike): Node {
    return new Node({ op: 'compare', type: boolT, cop, a: this.expr, b: lift(o).expr })
  }
  lt(o: NodeLike): Node { return this.cmp('<', o) }
  gt(o: NodeLike): Node { return this.cmp('>', o) }
  le(o: NodeLike): Node { return this.cmp('<=', o) }
  ge(o: NodeLike): Node { return this.cmp('>=', o) }
  eq(o: NodeLike): Node { return this.cmp('==', o) }
  ne(o: NodeLike): Node { return this.cmp('!=', o) }

  and(o: Node): Node { return new Node({ op: 'logical', type: boolT, lop: '&&', a: this.expr, b: o.expr }) }
  or(o: Node): Node { return new Node({ op: 'logical', type: boolT, lop: '||', a: this.expr, b: o.expr }) }

  /** Vector component access — `.x`/`.y`/`.z`/`.w` → elem scalar. */
  comp(field: 'x' | 'y' | 'z' | 'w'): Node {
    const t = this.type
    if (!isVec(t)) throw new Error(`shader-dsl: .${field} on non-vector ${typeKey(t)}`)
    if (VEC_FIELD_INDEX[field] >= t.n) throw new Error(`shader-dsl: .${field} out of range on ${typeKey(t)}`)
    return new Node({ op: 'member', type: { kind: 'scalar', scalar: t.elem }, base: this.expr, field })
  }
  get x(): Node { return this.comp('x') }
  get y(): Node { return this.comp('y') }
  get z(): Node { return this.comp('z') }
  get w(): Node { return this.comp('w') }

  /** Struct field access (type resolved from the registered struct). */
  field(name: string, type: ShaderType): Node {
    return new Node({ op: 'member', type, base: this.expr, field: name })
  }

  /** Array index — base[idx]. elem is the array element type. */
  at(idx: NodeLike, elem: ShaderType): Node {
    return new Node({ op: 'index', type: elem, base: this.expr, idx: lift(idx).expr })
  }

  /** `this ? a : b` (this is a bool). Mirrors WGSL select(b, a, this). */
  select(a: NodeLike, b: NodeLike): Node {
    if (!typeEq(this.type, boolT)) throw new Error('shader-dsl: .select on non-bool condition')
    const ta = lift(a), tb = lift(b)
    if (!typeEq(ta.type, tb.type)) throw new Error(`shader-dsl: select branches differ ${typeKey(ta.type)} vs ${typeKey(tb.type)}`)
    return new Node({ op: 'select', type: ta.type, cond: this.expr, ifTrue: ta.expr, ifFalse: tb.expr })
  }
}

// ── Literal / ref constructors ──

export const f32 = (v: number): Node => new Node({ op: 'lit', type: f32T, value: v })
export const i32 = (v: number): Node => new Node({ op: 'lit', type: i32T, value: v })
export const u32 = (v: number): Node => new Node({ op: 'lit', type: u32T, value: v })
export const bool = (v: boolean): Node => new Node({ op: 'lit', type: boolT, value: v })

/** A reference to a module-level const (PI, DEG2RAD, EARTH_R, …). */
export const constRef = (name: string, type: ShaderType = f32T): Node =>
  new Node({ op: 'constref', type, name })

/** A function parameter reference. */
export const param = (name: string, type: ShaderType): Node =>
  new Node({ op: 'param', type, name })

/** A module-level binding reference (storage/uniform). */
export const bindingRef = (name: string, type: ShaderType): Node =>
  new Node({ op: 'varref', type, name })

// ── Builtins (free functions) ──

const elemScalarType = (t: ShaderType): ShaderType => (isVec(t) ? { kind: 'scalar', scalar: t.elem } : t)

const call = (fn: string, type: ShaderType, ...args: NodeLike[]): Node =>
  new Node({ op: 'call', type, fn, args: args.map((a) => lift(a).expr) })

// genType in → genType out (component-wise) builtins
const genType1 = (fn: string) => (x: NodeLike): Node => { const n = lift(x); return call(fn, n.type, n) }

export const sin = genType1('sin')
export const cos = genType1('cos')
export const tan = genType1('tan')
export const asin = genType1('asin')
export const acos = genType1('acos')
export const atan = genType1('atan')
export const exp = genType1('exp')
export const log = genType1('log')
export const floor = genType1('floor')
export const ceil = genType1('ceil')
export const abs = genType1('abs')
export const sqrt = genType1('sqrt')

export const atan2 = (y: NodeLike, x: NodeLike): Node => { const n = lift(y); return call('atan2', n.type, n, x) }
export const min = (a: NodeLike, b: NodeLike): Node => { const n = lift(a); return call('min', binResultType(n.type, lift(b).type, 'min'), n, b) }
export const max = (a: NodeLike, b: NodeLike): Node => { const n = lift(a); return call('max', binResultType(n.type, lift(b).type, 'max'), n, b) }
export const clamp = (x: NodeLike, lo: NodeLike, hi: NodeLike): Node => { const n = lift(x); return call('clamp', n.type, n, lo, hi) }
export const mix = (a: NodeLike, b: NodeLike, t: NodeLike): Node => { const n = lift(a); return call('mix', n.type, n, b, t) }
export const smoothstep = (e0: NodeLike, e1: NodeLike, x: NodeLike): Node => { const n = lift(x); return call('smoothstep', elemScalarType(n.type), e0, e1, n) }
export const length = (v: NodeLike): Node => call('length', f32T, v)
export const dot = (a: NodeLike, b: NodeLike): Node => call('dot', f32T, a, b)
/** Pack a vec4<f32> (each component in [0,1]) into a u32 RGBA8. */
export const pack4x8unorm = (v: NodeLike): Node => call('pack4x8unorm', u32T, v)

/** select(cond, ifTrue, ifFalse) — free-function form of Node.select. */
export const select = (cond: Node, ifTrue: NodeLike, ifFalse: NodeLike): Node => cond.select(ifTrue, ifFalse)

// Casts
export const toF32 = (x: NodeLike): Node => call('f32', f32T, x)
export const toI32 = (x: NodeLike): Node => call('i32', i32T, x)
export const toU32 = (x: NodeLike): Node => call('u32', u32T, x)

/** Call a user-defined (authored) function by name. The WGSL backend emits
 *  `name(args)`; the CPU backend dispatches through the compiled fn table. */
export const callFn = (name: string, ret: ShaderType, ...args: NodeLike[]): Node =>
  new Node({ op: 'call', type: ret, fn: name, args: args.map((a) => lift(a).expr) })

// Vector constructors
const construct = (type: ShaderType, args: NodeLike[]): Node =>
  new Node({ op: 'construct', type, args: args.map((a) => lift(a).expr) })
export const vec2 = (...a: NodeLike[]): Node => construct(vec2fT, a)
export const vec3 = (...a: NodeLike[]): Node => construct(vec3fT, a)
export const vec4 = (...a: NodeLike[]): Node => construct(vec4fT, a)

// ── Function builder ──

export type ParamSpec = Record<string, ShaderType>
type ParamNodes<P extends ParamSpec> = { [K in keyof P]: Node }

export class Builder {
  readonly stmts: Stmt[] = []
  private uid = 0

  private push(s: Stmt): void { this.stmts.push(s) }

  /** Immutable binding — `let name = expr;`. Returns a varref Node. */
  let(name: string, value: Node): Node {
    this.push({ s: 'let', name, expr: value.expr })
    return new Node({ op: 'varref', type: value.type, name })
  }

  /** Mutable binding — `var name: T = init?;`. Returns a varref Node. */
  var(name: string, type: ShaderType, init?: Node): Node {
    this.push({ s: 'var', name, type, init: init?.expr })
    return new Node({ op: 'varref', type, name })
  }

  /** Fresh unique name (for generated temporaries). */
  tmp(prefix = 't'): string { return `${prefix}_${this.uid++}` }

  assign(target: Node, value: Node): void {
    this.push({ s: 'assign', target: target.expr, expr: value.expr })
  }
  assignOp(target: Node, bop: BinOp, value: Node): void {
    this.push({ s: 'assignOp', target: target.expr, bop, expr: value.expr })
  }
  addAssign(target: Node, value: Node): void { this.assignOp(target, '+', value) }

  ret(value?: Node): void { this.push({ s: 'return', expr: value?.expr }) }
  break(): void { this.push({ s: 'break' }) }
  discard(): void { this.push({ s: 'discard' }) }

  /** if / else-if / else chain. Returns a chainer so `.elif().else()` reads
   *  top-to-bottom. The If stmt is pushed on the first call and mutated in
   *  place by subsequent .elif/.else. */
  if(cond: Node, body: (b: Builder) => void): IfChain {
    const arms: Array<{ cond: Expr; body: Stmt[] }> = [{ cond: cond.expr, body: subBody(body) }]
    const stmt = { s: 'if' as const, arms, elseBody: undefined as Stmt[] | undefined }
    // Push a mutable-shaped object; the readonly Stmt typing is a compile-time
    // view only — the builder owns construction.
    this.push(stmt as unknown as Stmt)
    return new IfChain(arms, (e) => { stmt.elseBody = e })
  }

  /** C-style for: `for (var name = init; name <cond>; name = name+step)`. */
  forRange(
    name: string,
    init: Node,
    cond: (i: Node) => Node,
    body: (b: Builder, i: Node) => void,
    step: Node = f32(1),
  ): void {
    const i = new Node({ op: 'varref', type: init.type, name })
    const initStmt: Stmt = { s: 'var', name, type: init.type, init: init.expr }
    const updateStmt: Stmt = { s: 'assign', target: i.expr, expr: i.add(step).expr }
    this.push({ s: 'for', init: initStmt, cond: cond(i).expr, update: updateStmt, body: subBody((b) => body(b, i)) })
  }

  switch(scrut: Node, cases: Array<[number, (b: Builder) => void]>, defaultBody?: (b: Builder) => void): void {
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
  elif(cond: Node, body: (b: Builder) => void): IfChain {
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
 *  Nodes. Returns a FuncDecl for the module. */
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
  body: (b: Builder, gid: Node) => void,
): FuncDecl {
  const gid = new Node({ op: 'param', type: vec3uT, name: gidName })
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

/** Assemble a module from its declarations. */
export function module(parts: Partial<ModuleDecl>): ModuleDecl {
  return {
    consts: parts.consts ?? [],
    structs: parts.structs ?? [],
    bindings: parts.bindings ?? [],
    funcs: parts.funcs ?? [],
  }
}
