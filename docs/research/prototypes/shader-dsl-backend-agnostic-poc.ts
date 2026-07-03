/**
 * PROTOTYPE v2 — backend-neutral shader IR (production-shaped, runnable).
 * Standalone, zero-dependency. Does NOT touch the real @xgis/shader-dsl package.
 *   bun run docs/research/prototypes/shader-dsl-backend-agnostic-poc.ts
 *
 * Demonstrates, on real-shaped code, the four claims a professional retargetable
 * shader IR must back:
 *   (1) ONE neutral graph → WGSL *and* GLSL ES 3.00 (writers own the spelling).
 *   (2) Divergent intrinsics handled by a per-backend registry (select, texture…).
 *   (3) Structured entry/IO lowered per target (@builtin/@location ↔ gl_Position/out).
 *   (4) Capability honesty: an unsupported feature is a typed compile-time error,
 *       and a CPU oracle re-derives the same value (differential ground truth).
 *
 * Mirrors the naga/Tint shape (typed IR + per-target Writer + Capabilities).
 */

// ════════════════════════ 1. Neutral IR (no target lexemes) ════════════════════════
type ScalarTy = 'f32' | 'u32' | 'bool'
export type ShaderType =
  | { kind: 'scalar'; scalar: ScalarTy }
  | { kind: 'vec'; n: 2 | 3 | 4; elem: 'f32' | 'u32' }
  | { kind: 'void' }

/** Spelling-free structural key — the IR's notion of type identity (typeEq). */
const canonicalKey = (t: ShaderType): string =>
  t.kind === 'scalar' ? `s:${t.scalar}` : t.kind === 'vec' ? `v:${t.n}:${t.elem}` : 'void'
const typeEq = (a: ShaderType, b: ShaderType) => canonicalKey(a) === canonicalKey(b)

// Neutral aliases — authoring never spells 'vec3<f32>'.
const F32: ShaderType = { kind: 'scalar', scalar: 'f32' }
const Vec2f: ShaderType = { kind: 'vec', n: 2, elem: 'f32' }
const Vec4f: ShaderType = { kind: 'vec', n: 4, elem: 'f32' }
const Vec3f: ShaderType = { kind: 'vec', n: 3, elem: 'f32' }

type IntrinsicId = 'max' | 'log2' | 'pow' | 'select'
export type Expr =
  | { op: 'lit'; type: ShaderType; value: number }
  | { op: 'ref'; type: ShaderType; name: string } // param or local
  | { op: 'binop'; type: ShaderType; bop: '+' | '*'; a: Expr; b: Expr }
  | { op: 'member'; type: ShaderType; base: Expr; field: string }
  | { op: 'construct'; type: ShaderType; args: Expr[] }
  | { op: 'intrinsic'; type: ShaderType; id: IntrinsicId; args: Expr[] }
type Stmt =
  | { s: 'local'; name: string; type: ShaderType; value: Expr }
  | { s: 'ret'; value: Expr }
  | { s: 'store'; target: string; value: Expr } // write an output IO slot

type Param = { name: string; type: ShaderType }
type FuncDecl = { name: string; params: Param[]; ret: ShaderType; body: Stmt[] }

// Structured entry + IO — NO raw attribute strings.
type Stage = 'vertex' | 'fragment' | 'compute'
type IOBuiltin = 'position' | 'vertex_index' | 'frag_depth'
type IOSlot =
  | { name: string; type: ShaderType; bind: { kind: 'builtin'; which: IOBuiltin }; interp?: 'flat' }
  | { name: string; type: ShaderType; bind: { kind: 'location'; index: number }; interp?: 'flat' }
type EntryDecl = { name: string; stage: Stage; inputs: IOSlot[]; outputs: IOSlot[]; body: Stmt[] }

type Capability = 'compute' | 'storageBuffer' | 'msaaTextureLoad'
class Capabilities {
  constructor(private readonly set: ReadonlySet<Capability>) {}
  has(c: Capability) {
    return this.set.has(c)
  }
  /** Does this backend cover everything a module requires? */
  covers(reqs: ReadonlySet<Capability>) {
    return [...reqs].every((c) => this.set.has(c))
  }
  missing(reqs: ReadonlySet<Capability>) {
    return [...reqs].filter((c) => !this.set.has(c))
  }
}
type Module = { funcs?: FuncDecl[]; entries?: EntryDecl[]; requires: ReadonlySet<Capability> }

// ════════════════════════ 2. Authoring layer (typed, fluent, target-free) ══════════
class Node {
  constructor(readonly expr: Expr) {}
  get type() {
    return this.expr.type
  }
  private bin(bop: '+' | '*', o: Node | number) {
    return new Node({ op: 'binop', type: this.type, bop, a: this.expr, b: lift(o, this.type).expr })
  }
  add(o: Node | number) {
    return this.bin('+', o)
  }
  mul(o: Node | number) {
    return this.bin('*', o)
  }
  private comp(f: string) {
    const elem: ShaderType =
      this.type.kind === 'vec' ? { kind: 'scalar', scalar: this.type.elem } : F32
    return new Node({ op: 'member', type: elem, base: this.expr, field: f })
  }
  get x() {
    return this.comp('x')
  }
  get y() {
    return this.comp('y')
  }
  get z() {
    return this.comp('z')
  }
  get w() {
    return this.comp('w')
  }
}
const lift = (v: Node | number, t: ShaderType) =>
  v instanceof Node ? v : new Node({ op: 'lit', type: t, value: v })
const f32 = (v: number) => new Node({ op: 'lit', type: F32, value: v })
const vecN = (t: ShaderType, ...a: (Node | number)[]) =>
  new Node({ op: 'construct', type: t, args: a.map((x) => lift(x, F32).expr) })
const vec3 = (...a: (Node | number)[]) => vecN(Vec3f, ...a)
const vec4 = (...a: (Node | number)[]) => vecN(Vec4f, ...a)
const intr = (id: IntrinsicId, type: ShaderType, ...args: Node[]) =>
  new Node({ op: 'intrinsic', type, id, args: args.map((a) => a.expr) })
const max = (a: Node, b: Node | number) => intr('max', a.type, a, lift(b, a.type))
const log2 = (a: Node) => intr('log2', a.type, a)
const pow = (a: Node, b: Node) => intr('pow', a.type, a, b)
/** cond ? t : f — neutral; writers lower to WGSL select(f,t,cond) or GLSL ternary. */
const select = (cond: Node, t: Node, f: Node) => {
  if (!typeEq(t.type, f.type)) throw new Error('select: branch type mismatch')
  return intr('select', t.type, f, t, cond)
}

class Builder {
  stmts: Stmt[] = []
  let_(name: string, value: Node) {
    this.stmts.push({ s: 'local', name, type: value.type, value: value.expr })
    return new Node({ op: 'ref', type: value.type, name })
  }
  store(slot: string, value: Node) {
    this.stmts.push({ s: 'store', target: slot, value: value.expr })
  }
  ret(value: Node) {
    this.stmts.push({ s: 'ret', value: value.expr })
  }
}
function fn(
  name: string,
  params: Record<string, ShaderType>,
  ret: ShaderType,
  build: (b: Builder, p: Record<string, Node>) => void,
): FuncDecl {
  const ps = Object.entries(params).map(([n, type]) => ({ name: n, type }))
  const args = Object.fromEntries(
    ps.map((p) => [p.name, new Node({ op: 'ref', type: p.type, name: p.name })]),
  )
  const b = new Builder()
  build(b, args)
  return { name, params: ps, ret, body: b.stmts }
}
function entry(
  name: string,
  stage: Stage,
  io: { inputs: IOSlot[]; outputs: IOSlot[] },
  build: (b: Builder, inp: Record<string, Node>) => void,
): EntryDecl {
  const inp = Object.fromEntries(
    io.inputs.map((s) => [s.name, new Node({ op: 'ref', type: s.type, name: s.name })]),
  )
  const b = new Builder()
  build(b, inp)
  return { name, stage, inputs: io.inputs, outputs: io.outputs, body: b.stmts }
}
const builtin = (which: IOBuiltin, name: string, type: ShaderType): IOSlot => ({
  name,
  type,
  bind: { kind: 'builtin', which },
})
const location = (
  index: number,
  name: string,
  type: ShaderType,
  o?: { flat?: boolean },
): IOSlot => ({
  name,
  type,
  bind: { kind: 'location', index },
  interp: o?.flat ? 'flat' : undefined,
})

// ════════════════════════ 3. Intrinsic registry (per-backend + CPU oracle) ═════════
type Vec = number[]
type IntrinsicDef = {
  wgsl: (a: string[]) => string
  glsl?: (a: string[]) => string // undefined ⇒ unsupported on GLSL ES
  cpu: (...v: (number | Vec)[]) => number | Vec // ground-truth fold
}
const ew = (xs: (number | Vec)[], f: (...n: number[]) => number): number | Vec =>
  xs.every((x) => typeof x === 'number')
    ? f(...(xs as number[]))
    : (xs.map((x) => (Array.isArray(x) ? x : [x])) as Vec[]).reduce(
        (acc, _v, _i, arr) => (arr[0] as Vec).map((_, j) => f(...arr.map((v) => v[j] ?? v[0]))),
        [] as Vec,
      )
const INTRINSICS: Record<IntrinsicId, IntrinsicDef> = {
  max: {
    wgsl: (a) => `max(${a[0]}, ${a[1]})`,
    glsl: (a) => `max(${a[0]}, ${a[1]})`,
    cpu: (a, b) => ew([a, b], Math.max),
  },
  log2: {
    wgsl: (a) => `log2(${a[0]})`,
    glsl: (a) => `log2(${a[0]})`,
    cpu: (a) => ew([a], Math.log2),
  },
  pow: {
    wgsl: (a) => `pow(${a[0]}, ${a[1]})`,
    glsl: (a) => `pow(${a[0]}, ${a[1]})`,
    cpu: (a, b) => ew([a, b], Math.pow),
  },
  // DIVERGENT: WGSL select(falseVal, trueVal, cond); GLSL ES has no select() → ternary.
  select: {
    wgsl: (a) => `select(${a[0]}, ${a[1]}, ${a[2]})`,
    glsl: (a) => `(${a[2]} != 0.0 ? ${a[1]} : ${a[0]})`,
    cpu: (f, t, c) => (c ? t : f),
  },
}

// ════════════════════════ 4. The Backend contract + three writers ══════════════════
class UnsupportedFeatureError extends Error {}
interface Backend {
  readonly id: string
  readonly caps: Capabilities
  typeName(t: ShaderType): string
  literal(v: number, t: ShaderType): string
  intrinsic(id: IntrinsicId, args: string[]): string
  localDecl(name: string, t: ShaderType, init: string): string
  lowerEntry(e: EntryDecl): string
  preamble(): string
}
const f32Lit = (v: number) => (Number.isInteger(v) ? `${v}.0` : `${v}`)

const WGSL: Backend = {
  id: 'wgsl',
  caps: new Capabilities(new Set(['compute', 'storageBuffer', 'msaaTextureLoad'])),
  typeName: (t) =>
    t.kind === 'scalar' ? t.scalar : t.kind === 'vec' ? `vec${t.n}<${t.elem}>` : 'void',
  literal: (v, t) =>
    t.kind === 'scalar' && t.scalar === 'f32'
      ? f32Lit(v)
      : t.kind === 'scalar' && t.scalar === 'u32'
        ? `${v}u`
        : `${v}`,
  intrinsic: (id, a) => INTRINSICS[id].wgsl(a),
  localDecl: (n, _t, init) => `let ${n} = ${init};`,
  lowerEntry(e) {
    const at = (s: IOSlot) =>
      s.bind.kind === 'builtin'
        ? `@builtin(${s.bind.which})`
        : `${s.interp === 'flat' ? '@interpolate(flat) ' : ''}@location(${s.bind.index})`
    const params = e.inputs.map((s) => `${at(s)} ${s.name}: ${WGSL.typeName(s.type)}`).join(', ')
    const outFields = e.outputs
      .map((s) => `  ${at(s)} ${s.name}: ${WGSL.typeName(s.type)},`)
      .join('\n')
    const stores = e.body
      .filter((x): x is Extract<Stmt, { s: 'store' }> => x.s === 'store')
      .map((x) => `  out.${x.target} = ${emitExpr(x.value, WGSL)};`)
      .join('\n')
    const locals = e.body
      .filter((x): x is Extract<Stmt, { s: 'local' }> => x.s === 'local')
      .map((x) => `  ${WGSL.localDecl(x.name, x.type, emitExpr(x.value, WGSL))}`)
      .join('\n')
    return `struct ${cap(e.name)}Out {\n${outFields}\n}\n@${e.stage} fn ${e.name}(${params}) -> ${cap(e.name)}Out {\n  var out: ${cap(e.name)}Out;\n${locals}\n${stores}\n  return out;\n}`
  },
  preamble: () => '',
}
const GLSL_ES300: Backend = {
  id: 'glsl-es300',
  caps: new Capabilities(new Set()),
  typeName: (t) =>
    t.kind === 'scalar'
      ? { f32: 'float', u32: 'uint', bool: 'bool' }[t.scalar]
      : t.kind === 'vec'
        ? t.elem === 'f32'
          ? `vec${t.n}`
          : `uvec${t.n}`
        : 'void',
  literal: (v, t) => (t.kind === 'scalar' && t.scalar === 'f32' ? f32Lit(v) : `${v}`),
  intrinsic(id, a) {
    const g = INTRINSICS[id].glsl
    if (!g) throw new UnsupportedFeatureError(`intrinsic '${id}' has no glsl-es300 lowering`)
    return g(a)
  },
  localDecl: (n, t, init) => `${GLSL_ES300.typeName(t)} ${n} = ${init};`,
  lowerEntry(e) {
    // GLSL ES has no struct IO: flatten to in/out globals + main() + gl_Position.
    const ins = e.inputs.map(
      (s) =>
        `layout(location=${s.bind.kind === 'location' ? s.bind.index : 0}) in ${GLSL_ES300.typeName(s.type)} ${s.name};`,
    )
    const outs = e.outputs
      .filter((s) => s.bind.kind === 'location')
      .map(
        (s) =>
          `${s.interp === 'flat' ? 'flat ' : ''}out ${GLSL_ES300.typeName(s.type)} v_${s.name};`,
      )
    const body = e.body
      .map((x) =>
        x.s === 'local'
          ? `  ${GLSL_ES300.localDecl(x.name, x.type, emitExpr(x.value, GLSL_ES300))}`
          : x.s === 'store'
            ? `  ${storeTargetGlsl(e, x.target)} = ${emitExpr(x.value, GLSL_ES300)};`
            : '',
      )
      .filter(Boolean)
      .join('\n')
    return `${ins.join('\n')}\n${outs.join('\n')}\nvoid main() {\n${body}\n}`
  },
  preamble: () => '#version 300 es\nprecision highp float;\n',
}
const storeTargetGlsl = (e: EntryDecl, slot: string) => {
  const o = e.outputs.find((s) => s.name === slot)!
  return o.bind.kind === 'builtin'
    ? { position: 'gl_Position', frag_depth: 'gl_FragDepth', vertex_index: '' }[o.bind.which]
    : `v_${slot}`
}

/** CPU oracle — the differential ground truth (a third consumer of the SAME IR). */
function evalCpu(f: FuncDecl, args: Record<string, number | Vec>): number | Vec {
  const env: Record<string, number | Vec> = { ...args }
  const ev = (e: Expr): number | Vec => {
    switch (e.op) {
      case 'lit':
        return e.value
      case 'ref':
        return env[e.name]
      case 'binop': {
        const a = ev(e.a) as number,
          b = ev(e.b) as number
        return e.bop === '+' ? a + b : a * b
      }
      case 'member': {
        const v = ev(e.base) as Vec
        return v[{ x: 0, y: 1, z: 2, w: 3 }[e.field as 'x']]
      }
      case 'construct':
        return e.args.map((x) => ev(x) as number)
      case 'intrinsic':
        return INTRINSICS[e.id].cpu(...e.args.map(ev))
    }
  }
  for (const s of f.body) {
    if (s.s === 'local') env[s.name] = ev(s.value)
    else if (s.s === 'ret') return ev(s.value)
  }
  throw new Error('no return')
}

// ════════════════════════ 5. compile() — one source, any target ════════════════════
const cap = (s: string) => s.replace(/(^|_)(\w)/g, (_, __, c) => c.toUpperCase())
function emitExpr(e: Expr, be: Backend): string {
  switch (e.op) {
    case 'lit':
      return be.literal(e.value, e.type)
    case 'ref':
      return e.name
    case 'binop':
      return `(${emitExpr(e.a, be)} ${e.bop} ${emitExpr(e.b, be)})`
    case 'member':
      return `${emitExpr(e.base, be)}.${e.field}`
    case 'construct':
      return `${be.typeName(e.type)}(${e.args.map((x) => emitExpr(x, be)).join(', ')})`
    case 'intrinsic':
      return be.intrinsic(
        e.id,
        e.args.map((x) => emitExpr(x, be)),
      )
  }
}
function emitFunc(f: FuncDecl, be: Backend): string {
  const params = f.params
    .map((p) =>
      be.id === 'wgsl' ? `${p.name}: ${be.typeName(p.type)}` : `${be.typeName(p.type)} ${p.name}`,
    )
    .join(', ')
  const sig =
    be.id === 'wgsl'
      ? `fn ${f.name}(${params}) -> ${be.typeName(f.ret)}`
      : `${be.typeName(f.ret)} ${f.name}(${params})`
  const body = f.body
    .map((s) =>
      s.s === 'local'
        ? `  ${be.localDecl(s.name, s.type, emitExpr(s.value, be))}`
        : `  return ${emitExpr(s.value, be)};`,
    )
    .join('\n')
  return `${sig} {\n${body}\n}`
}
function compile(m: Module, be: Backend): { backend: string; code: string } {
  const missing = be.caps.missing(m.requires)
  if (missing.length)
    throw new UnsupportedFeatureError(
      `this shader requires { ${missing.join(', ')} } not supported by backend '${be.id}'.`,
    )
  const parts = [
    ...(m.funcs ?? []).map((f) => emitFunc(f, be)),
    ...(m.entries ?? []).map((e) => be.lowerEntry(e)),
  ]
  return { backend: be.id, code: be.preamble() + parts.join('\n\n') + '\n' }
}

// ═══════════════════════════════════ DEMO ══════════════════════════════════════════
// Author once, target-free. Body identical to the real log-depth.ts apply_log_depth.
const applyLogDepth = fn('apply_log_depth', { pos: Vec4f, fc: F32 }, Vec4f, (b, { pos, fc }) => {
  const z = b.let_(
    'z',
    log2(max(f32(1e-6), pos.w.add(1)))
      .mul(fc)
      .mul(pos.w),
  )
  b.ret(vec4(pos.x, pos.y, z, pos.w))
})
const toLinear = fn('to_linear', { c: Vec3f, srgb: F32 }, Vec3f, (b, { c, srgb }) =>
  b.ret(select(srgb, pow(c, vec3(f32(2.2))), c)),
)
const mathMod: Module = { funcs: [applyLogDepth, toLinear], requires: new Set() }

// A real render entry — structured IO, lowered per target.
const vsQuad = entry(
  'vs_quad',
  'vertex',
  {
    inputs: [location(0, 'p', Vec2f)],
    outputs: [builtin('position', 'pos', Vec4f), location(0, 'uv', Vec2f, { flat: false })],
  },
  (b, { p }) => {
    b.store('pos', vec4(p.x, p.y, f32(0), f32(1)))
    b.store('uv', p)
  },
)
const quadMod: Module = { entries: [vsQuad], requires: new Set() }

// A genuinely WebGPU-only shader (compute + storage).
const continentMatch: Module = { funcs: [], requires: new Set(['compute', 'storageBuffer']) }

const hr = (s: string) => console.log(`\n──────── ${s} ────────`)
hr('one source → WGSL')
console.log(compile(mathMod, WGSL).code)
hr('one source → GLSL ES 300')
console.log(compile(mathMod, GLSL_ES300).code)
hr('structured IO → WGSL')
console.log(compile(quadMod, WGSL).code)
hr('structured IO → GLSL ES 300')
console.log(compile(quadMod, GLSL_ES300).code)
hr('differential: CPU oracle re-derives apply_log_depth(pos=[1,2,3,4], fc=0.5)')
console.log('  CPU =', evalCpu(applyLogDepth, { pos: [1, 2, 3, 4], fc: 0.5 }))
hr('capability honesty (WebGL2 + a compute shader)')
try {
  compile(continentMatch, GLSL_ES300)
} catch (e) {
  console.log('  ' + (e as Error).constructor.name + ': ' + (e as Error).message)
}
console.log(
  `  WGSL covers it? ${WGSL.caps.covers(continentMatch.requires)} · GLSL covers it? ${GLSL_ES300.caps.covers(continentMatch.requires)}`,
)
