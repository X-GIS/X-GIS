// ═══ Shader DSL — CPU (f64) backend ═══
//
// Tree-walk interpreter over the SAME IR the WGSL backend emits. This is the
// generated replacement for the hand-maintained projection-wgsl-mirror.ts:
// it runs the identical operation tree in f64 with Math.* (no fround), so it
// reproduces the mirror's numbers (AC2-spike (a): ≤1mm vs canonical).
//
// Module-level consts use their cpuValue (full-precision Math.PI / Math.PI/180)
// so the projection math matches the f64 mirror, while the WGSL backend emits
// the truncated shader constants — the two-tolerance reality, structural.
//
// Vectors are number[] (mutable, by reference so `p.x = …` assigns in place).
// Performance: tree-walk is ample for the tile-selection / raster / label
// consumers (O(hundreds) calls/frame); the perf-critical js-source backend
// (new Function) is a Phase-1 concern, not this.

import type { Expr, Stmt, ModuleDecl, BinOp } from '../ir'

export type CpuValue = number | boolean | number[] | CpuStruct
export interface CpuStruct { [k: string]: CpuValue }

interface Ctx {
  consts: Map<string, number>
  fns: Record<string, (...args: CpuValue[]) => CpuValue>
  bindings: Record<string, CpuValue>
}

export interface CpuModule {
  fns: Record<string, (...args: CpuValue[]) => CpuValue>
  /** Inject a storage/uniform binding value (e.g. the shapes/segments arrays
   *  for sdf_shape) before invoking a fn that reads it. */
  setBinding(name: string, value: CpuValue): void
}

const FIELD_IDX: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 }

const isArr = Array.isArray

function scalarBin(bop: BinOp, a: number, b: number): number {
  switch (bop) {
    case '+': return a + b
    case '-': return a - b
    case '*': return a * b
    case '/': return a / b
    case '%': return a % b
  }
}

function applyBin(bop: BinOp, a: CpuValue, b: CpuValue): CpuValue {
  if (isArr(a) && isArr(b)) return a.map((x, i) => scalarBin(bop, x as number, b[i] as number))
  if (isArr(a)) return a.map((x) => scalarBin(bop, x as number, b as number))
  if (isArr(b)) return b.map((y) => scalarBin(bop, a as number, y as number))
  return scalarBin(bop, a as number, b as number)
}

// ── Builtins (vec-aware where WGSL is component-wise) ──
type Builtin = (...args: CpuValue[]) => CpuValue
const map1 = (f: (x: number) => number): Builtin => (x) => (isArr(x) ? x.map((v) => f(v as number)) : f(x as number))

const BUILTINS: Record<string, Builtin> = {
  sin: map1(Math.sin), cos: map1(Math.cos), tan: map1(Math.tan),
  asin: map1(Math.asin), acos: map1(Math.acos), atan: map1(Math.atan),
  exp: map1(Math.exp), log: map1(Math.log), log2: map1(Math.log2), sqrt: map1(Math.sqrt),
  floor: map1(Math.floor), ceil: map1(Math.ceil), abs: map1(Math.abs),
  atan2: (y, x) => Math.atan2(y as number, x as number),
  min: (a, b) => (isArr(a) || isArr(b) ? applyMinMax(Math.min, a, b) : Math.min(a as number, b as number)),
  max: (a, b) => (isArr(a) || isArr(b) ? applyMinMax(Math.max, a, b) : Math.max(a as number, b as number)),
  // clamp ordering mirrors projection-wgsl-mirror.ts: max(lo, min(hi, x)).
  clamp: (x, lo, hi) => clampVal(x, lo as number, hi as number),
  mix: (a, b, t) => mixVal(a, b, t as number),
  smoothstep: (e0, e1, x) => {
    const t = clampVal((x as number - (e0 as number)) / ((e1 as number) - (e0 as number)), 0, 1) as number
    return t * t * (3 - 2 * t)
  },
  length: (v) => Math.sqrt((v as number[]).reduce((s, c) => s + (c as number) * (c as number), 0)),
  dot: (a, b) => (a as number[]).reduce((s, c, i) => s + (c as number) * ((b as number[])[i] as number), 0),
  f32: (x) => Number(x),
  i32: (x) => Math.trunc(x as number),
  u32: (x) => Math.trunc(x as number) >>> 0,
  // pack a vec4<f32> (each in [0,1]) into u32 RGBA8; component 0 → low byte.
  pack4x8unorm: (v) => {
    const a = v as number[]
    const q = (x: number): number => Math.round(Math.max(0, Math.min(1, x)) * 255) & 0xff
    return (q(a[0]) | (q(a[1]) << 8) | (q(a[2]) << 16) | (q(a[3]) << 24)) >>> 0
  },
  // GPU-only stubs. textureSample needs the GPU's sampler/atlas; fwidth needs
  // neighbouring fragments — neither is computable in this per-invocation
  // interpreter. They exist so a shader that references them still COMPILES on
  // the CPU side (e.g. for a vertex-only eval); a real headless renderer would
  // replace these. No current CPU consumer evaluates a fragment that uses them.
  textureSample: () => [0, 0, 0, 1],
  fwidth: () => 0,
}

function applyMinMax(f: (a: number, b: number) => number, a: CpuValue, b: CpuValue): number[] {
  if (isArr(a) && isArr(b)) return a.map((x, i) => f(x as number, b[i] as number))
  if (isArr(a)) return a.map((x) => f(x as number, b as number))
  return (b as number[]).map((y) => f(a as number, y as number))
}
function clampVal(x: CpuValue, lo: number, hi: number): CpuValue {
  return isArr(x) ? x.map((v) => Math.max(lo, Math.min(hi, v as number))) : Math.max(lo, Math.min(hi, x as number))
}
function mixVal(a: CpuValue, b: CpuValue, t: number): CpuValue {
  if (isArr(a) && isArr(b)) return a.map((x, i) => (x as number) + ((b[i] as number) - (x as number)) * t)
  return (a as number) + ((b as number) - (a as number)) * t
}

function zeroOf(type: { kind: string; n?: number }): CpuValue {
  if (type.kind === 'vec') return new Array(type.n as number).fill(0)
  if (type.kind === 'mat') return new Array((type.n as number) * (type.n as number)).fill(0)
  if (type.kind === 'struct') return {} // fields populated by member assignments
  if (type.kind === 'scalar') return 0
  return 0
}

// mat4x4 (column-major) × vec4 → vec4. result[row] = Σ_col m[col*4+row]*v[col].
function matVec4(m: number[], v: number[]): number[] {
  const out = [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) out[i] = m[i]! * v[0]! + m[4 + i]! * v[1]! + m[8 + i]! * v[2]! + m[12 + i]! * v[3]!
  return out
}

function evalExpr(e: Expr, env: Map<string, CpuValue>, ctx: Ctx): CpuValue {
  switch (e.op) {
    case 'lit': return e.value
    case 'constref': {
      const v = ctx.consts.get(e.name)
      if (v === undefined) throw new Error(`shader-dsl/cpu: unknown const ${e.name}`)
      return v
    }
    case 'param':
    case 'varref': {
      if (env.has(e.name)) return env.get(e.name) as CpuValue
      if (e.name in ctx.bindings) return ctx.bindings[e.name]
      throw new Error(`shader-dsl/cpu: unbound ${e.name}`)
    }
    case 'binop': {
      const av = evalExpr(e.a, env, ctx), bv = evalExpr(e.b, env, ctx)
      // mat4 * vec4 (column-major) — the MVP transform. Dispatched by the
      // operand's static type since values are type-blind number[] at runtime.
      if (e.bop === '*' && e.a.type.kind === 'mat' && e.b.type.kind === 'vec') {
        return matVec4(av as number[], bv as number[])
      }
      return applyBin(e.bop, av, bv)
    }
    case 'unop': {
      const a = evalExpr(e.a, env, ctx)
      return isArr(a) ? a.map((v) => -(v as number)) : -(a as number)
    }
    case 'compare': {
      const a = evalExpr(e.a, env, ctx) as number, b = evalExpr(e.b, env, ctx) as number
      switch (e.cop) {
        case '<': return a < b
        case '>': return a > b
        case '<=': return a <= b
        case '>=': return a >= b
        case '==': return a === b
        case '!=': return a !== b
      }
    }
    // eslint-disable-next-line no-fallthrough
    case 'logical': {
      const a = evalExpr(e.a, env, ctx) as boolean
      if (e.lop === '&&') return a ? (evalExpr(e.b, env, ctx) as boolean) : false
      return a ? true : (evalExpr(e.b, env, ctx) as boolean)
    }
    case 'call': {
      const args = e.args.map((a) => evalExpr(a, env, ctx))
      const b = BUILTINS[e.fn]
      if (b) return b(...args)
      const user = ctx.fns[e.fn]
      if (user) return user(...args)
      throw new Error(`shader-dsl/cpu: unknown fn ${e.fn}`)
    }
    case 'member': {
      const base = evalExpr(e.base, env, ctx)
      if (isArr(base)) {
        // Multi-char swizzle (.rgb / .xy) → a new vector; single → a scalar.
        if (e.field.length > 1) return [...e.field].map((c) => base[FIELD_IDX[c]!] as number)
        return base[FIELD_IDX[e.field]] as CpuValue
      }
      return (base as Record<string, CpuValue>)[e.field]
    }
    case 'construct': {
      // Array literal: keep each element intact (array<vec2,N> → [[x,y],…]).
      if (e.type.kind === 'array') return e.args.map((a) => evalExpr(a, env, ctx)) as CpuValue
      // Vector constructor: flatten scalar/vec args into one component list.
      const out: number[] = []
      for (const a of e.args) {
        const v = evalExpr(a, env, ctx)
        if (isArr(v)) out.push(...(v as number[]))
        else out.push(v as number)
      }
      return out
    }
    case 'select': {
      const c = evalExpr(e.cond, env, ctx) as boolean
      return c ? evalExpr(e.ifTrue, env, ctx) : evalExpr(e.ifFalse, env, ctx)
    }
    case 'index': {
      const base = evalExpr(e.base, env, ctx) as CpuValue[]
      return base[evalExpr(e.idx, env, ctx) as number]
    }
  }
}

function setLValue(target: Expr, value: CpuValue, env: Map<string, CpuValue>, ctx: Ctx): void {
  if (target.op === 'varref' || target.op === 'param') { env.set(target.name, value); return }
  if (target.op === 'member') {
    const base = evalExpr(target.base, env, ctx)
    if (isArr(base)) base[FIELD_IDX[target.field]] = value as number
    else (base as Record<string, CpuValue>)[target.field] = value
    return
  }
  if (target.op === 'index') {
    const base = evalExpr(target.base, env, ctx) as CpuValue[]
    base[evalExpr(target.idx, env, ctx) as number] = value
    return
  }
  throw new Error(`shader-dsl/cpu: bad assignment target ${target.op}`)
}

type Signal = { kind: 'normal' } | { kind: 'return'; value: CpuValue | undefined } | { kind: 'break' } | { kind: 'discard' }
const NORMAL: Signal = { kind: 'normal' }

// One flat env per function call (no per-block child scope). This is safe
// because the ONLY way to reference a binding is the Node returned by
// b.let()/b.var()/forRange — the TS host already scopes those lexically, so a
// `var` declared in one branch can't be read from another. (A future
// "read a binding by name" API would expose the divergence from WGSL block
// scoping; don't add one without per-block scopes here.)
function execBody(body: readonly Stmt[], env: Map<string, CpuValue>, ctx: Ctx): Signal {
  for (const s of body) {
    switch (s.s) {
      case 'let': env.set(s.name, evalExpr(s.expr, env, ctx)); break
      case 'var': env.set(s.name, s.init ? evalExpr(s.init, env, ctx) : zeroOf(s.type)); break
      case 'assign': setLValue(s.target, evalExpr(s.expr, env, ctx), env, ctx); break
      case 'assignOp': {
        const cur = evalExpr(s.target, env, ctx)
        setLValue(s.target, applyBin(s.bop, cur, evalExpr(s.expr, env, ctx)), env, ctx)
        break
      }
      case 'return': return { kind: 'return', value: s.expr ? evalExpr(s.expr, env, ctx) : undefined }
      case 'break': return { kind: 'break' }
      case 'discard': return { kind: 'discard' }
      case 'if': {
        let taken = false
        for (const arm of s.arms) {
          if (evalExpr(arm.cond, env, ctx)) {
            const r = execBody(arm.body, env, ctx)
            if (r.kind !== 'normal') return r
            taken = true
            break
          }
        }
        if (!taken && s.elseBody) {
          const r = execBody(s.elseBody, env, ctx)
          if (r.kind !== 'normal') return r
        }
        break
      }
      case 'for': {
        execBody([s.init], env, ctx)
        while (evalExpr(s.cond, env, ctx)) {
          const r = execBody(s.body, env, ctx)
          if (r.kind === 'break') break
          if (r.kind === 'return' || r.kind === 'discard') return r
          execBody([s.update], env, ctx)
        }
        break
      }
      case 'switch': {
        const v = evalExpr(s.scrut, env, ctx) as number
        const hit = s.cases.find((c) => c.value === v)
        const chosen = hit ? hit.body : s.defaultBody
        if (chosen) {
          const r = execBody(chosen, env, ctx)
          if (r.kind === 'return' || r.kind === 'discard') return r
          // 'break' inside a switch case terminates the case (already exits body)
        }
        break
      }
    }
  }
  return NORMAL
}

export function compileModule(m: ModuleDecl): CpuModule {
  const ctx: Ctx = {
    consts: new Map(m.consts.map((c) => [c.name, c.cpuValue])),
    fns: {},
    bindings: {},
  }
  for (const f of m.funcs) {
    ctx.fns[f.name] = (...args: CpuValue[]): CpuValue => {
      const env = new Map<string, CpuValue>()
      f.params.forEach((p, i) => env.set(p.name, args[i]))
      const r = execBody(f.body, env, ctx)
      return r.kind === 'return' ? (r.value as CpuValue) : (undefined as unknown as CpuValue)
    }
  }
  return {
    fns: ctx.fns,
    setBinding: (name, value) => { ctx.bindings[name] = value },
  }
}
