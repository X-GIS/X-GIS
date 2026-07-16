// ═══ Shader DSL — CPU (f64) js-source backend ═══
//
// The perf-critical twin of the tree-walk interpreter (oracle.ts). Same IR,
// same op-library (cpu-runtime.ts), but instead of RE-WALKING the IR on every
// call it walks the IR ONCE at compile time and emits a JS source string per
// fn, then `new Function`s it. The recursive per-node `evalExpr` dispatch + the
// per-`call` argument-array allocation (the ~40 %-of-frame / GC-churn hot spot
// the profile flagged at high pitch, #1162) collapse into straight-line JS with
// real local variables.
//
// ─── BIT-IDENTITY CONTRACT (the whole point) ───
// compileModuleJs(m).fns.f(args) === compileModule(m).fns.f(args), Object.is per
// element, for ALL inputs. This holds BY CONSTRUCTION, not by tuning:
//   • the emitted code runs the IDENTICAL f64 Math.* op tree (no fround) — vector
//     / matrix / builtin ops call the SAME cpu-runtime helpers the interpreter
//     calls (applyBin / matVec / matMul / BUILTINS), so there is literally no
//     second implementation to drift;
//   • scalar arithmetic is inlined to the same JS operators scalarBin uses
//     (`+ - * / %`, `>>> 0`-normalised bitwise, i32-aware `>>`);
//   • consts embed their cpuValue / evaluate their valueExpr through the same
//     op tree; literals embed round-trip-exact (incl. -0 / NaN / ±Infinity);
//   • the flat per-call env is modelled as function-scope JS locals (one JS var
//     per distinct IR name — same clobber semantics as the interpreter's single
//     Map), and value references (number[] vectors, struct objects) are shared
//     exactly as the interpreter shares them, so member-mutation aliasing is
//     preserved rather than approximated.
// cpu-codegen.test.ts differential-gates this over every construct; the map
// package gates it over the whole PROJECTION_MODULE with boundary + seeded-random
// sweeps. The f64-ALGEBRA caveat (oracle.ts header) applies verbatim — this is
// still NOT an f32 GPU-precision oracle.
//
// HYBRID FALLBACK: if a fn body hits an IR construct that cannot be emitted
// semantically-identically (raw/placeholder Stmt, an lvalue shape with no
// expression form), that ONE fn falls back to the interpreter (the module is a
// hybrid); the rest still run compiled. A `new Function` failure (a CSP
// `unsafe-eval` host) throws so the caller can fall the whole module back to the
// interpreter.

import type { Expr, Stmt, ModuleDecl, StructDecl, ShaderType, BinOp } from './ir'
import { validate } from './passes/validate'
import { autoVars } from './passes/opt'
import {
  type CpuValue,
  FIELD_IDX,
  applyBin,
  matVec,
  matMul,
  BUILTINS,
  GPU_STUBS,
} from './cpu-runtime'
import { compileModule, type CpuModule } from './oracle'

/** Sentinel: a per-fn body used an IR construct the codegen can't emit
 *  bit-identically. Caught by compileModuleJs → that fn falls back to the
 *  interpreter (hybrid module). Never escapes this module. */
class CodegenUnsupported extends Error {}

const q = (s: string): string => JSON.stringify(s)

/** Emit a JS numeric/boolean literal that reads back to the EXACT same value.
 *  ECMAScript Number→string (radix 10) is the shortest round-trip form, so
 *  String(finite) parses back identically; -0 / NaN / ±Infinity are handled
 *  explicitly (String(-0) === "0" would lose the sign). */
function jsNum(v: number | boolean): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Number.isNaN(v)) return 'NaN'
  if (v === Infinity) return 'Infinity'
  if (v === -Infinity) return '-Infinity'
  if (Object.is(v, -0)) return '-0'
  return String(v)
}

/** A value whose runtime shape is number[] (interpreter `isArr(v)` true):
 *  vec / vec64 / mat / array. Scalars, f64 (a native JS number here), bool are not. */
function isArrayValued(t: ShaderType): boolean {
  return t.kind === 'vec' || t.kind === 'vec64' || t.kind === 'mat' || t.kind === 'array'
}
const isI32 = (t: ShaderType): boolean => t.kind === 'scalar' && t.scalar === 'i32'
const isF32 = (t: ShaderType): boolean => t.kind === 'scalar' && t.scalar === 'f32'

/** The zero value literal for a `var` with no initializer — mirrors
 *  cpu-runtime `zeroOf` (vec/vec64 → N zeros, mat → N² zeros, struct → {},
 *  everything else → 0). */
function zeroLit(t: ShaderType): string {
  if (t.kind === 'vec' || t.kind === 'vec64') return `new Array(${t.n}).fill(0)`
  if (t.kind === 'mat') return `new Array(${t.n * t.n}).fill(0)`
  if (t.kind === 'struct') return '{}'
  return '0'
}

/** Module-scope codegen state shared by every fn. */
interface ModCtx {
  structs: Map<string, StructDecl>
  /** const name → its JS local id in the factory (`$C_<i>`). */
  constId: Map<string, string>
  /** override name → its JS local id in the factory (`$O_<i>`). */
  overrideId: Map<string, string>
}

/** Per-fn codegen state: the flat env → JS locals mapping + the hoist list. */
interface FnCtx {
  mod: ModCtx
  /** IR name (param OR let/var) → JS identifier. Params pre-seeded to `$a<i>`;
   *  a `let`/`var` of a NEW name allocates `$v<n>` (hoisted). A repeat name maps
   *  to the SAME id — the interpreter's single flat Map has no shadowing, so
   *  same-name = same slot here too. */
  varId: Map<string, string>
  /** `$v` locals to declare at the top of the fn body (function-scope, flat). */
  hoisted: string[]
  n: number
}

function declareVar(name: string, S: FnCtx): string {
  let id = S.varId.get(name)
  if (id === undefined) {
    id = `$v${S.n++}`
    S.varId.set(name, id)
    S.hoisted.push(id)
  }
  return id
}

function readVar(name: string, S: FnCtx): string {
  const id = S.varId.get(name)
  if (id !== undefined) return id
  // Not a param/local ⇒ a storage/uniform binding (setBinding). The interpreter
  // resolves env first, then ctx.bindings; a declared local always shadows.
  return `$.bindings[${q(name)}]`
}

function emitExpr(e: Expr, S: FnCtx): string {
  switch (e.op) {
    case 'lit':
      return jsNum(e.value)
    case 'constref': {
      const id = S.mod.constId.get(e.name)
      if (id === undefined) throw new CodegenUnsupported(`unknown const ${e.name}`)
      return id
    }
    case 'overrideref': {
      const id = S.mod.overrideId.get(e.name)
      if (id === undefined) throw new CodegenUnsupported(`unknown override ${e.name}`)
      return id
    }
    case 'param':
    case 'varref':
      return readVar(e.name, S)
    case 'binop':
      return emitBinop(e, S)
    case 'unop': {
      const a = emitExpr(e.a, S)
      return isArrayValued(e.a.type) ? `$.negVec(${a})` : `(-${a})`
    }
    case 'compare': {
      const a = emitExpr(e.a, S)
      const b = emitExpr(e.b, S)
      const f32 = isF32(e.a.type)
      switch (e.cop) {
        case '<':
          return `(${a} < ${b})`
        case '>':
          return `(${a} > ${b})`
        case '<=':
          return `(${a} <= ${b})`
        case '>=':
          return `(${a} >= ${b})`
        case '==':
          return f32 ? `(Math.fround(${a}) === Math.fround(${b}))` : `(${a} === ${b})`
        case '!=':
          return f32 ? `(Math.fround(${a}) !== Math.fround(${b}))` : `(${a} !== ${b})`
      }
      throw new CodegenUnsupported(`compare ${e.cop}`)
    }
    case 'logical': {
      const a = emitExpr(e.a, S)
      const b = emitExpr(e.b, S)
      // Operands are bool-typed, so JS `&&`/`||` returns the same boolean the
      // interpreter does (`a ? evalB : false` / `a ? true : evalB`), lazily.
      return e.lop === '&&' ? `(${a} && ${b})` : `(${a} || ${b})`
    }
    case 'call': {
      const args = e.args.map((a) => emitExpr(a, S))
      if (BUILTINS[e.fn]) return `$.B[${q(e.fn)}](${args.join(', ')})`
      if (GPU_STUBS[e.fn]) return `$.gpuStub(${[q(e.fn), ...args].join(', ')})`
      // User fn — dispatched through $.F so a compiled fn can call a fn that fell
      // back to the interpreter (and vice versa).
      return `$.F[${q(e.fn)}](${args.join(', ')})`
    }
    case 'member': {
      const base = emitExpr(e.base, S)
      if (isArrayValued(e.base.type)) {
        if (e.field.length > 1) {
          const idx = [...e.field].map((c) => FIELD_IDX[c])
          if (idx.some((i) => i === undefined)) throw new CodegenUnsupported(`swizzle .${e.field}`)
          return `$.swiz(${base}, [${idx.join(', ')}])`
        }
        const i = FIELD_IDX[e.field]
        if (i === undefined) throw new CodegenUnsupported(`field .${e.field}`)
        return `(${base})[${i}]`
      }
      return `(${base})[${q(e.field)}]`
    }
    case 'construct':
      return emitConstruct(e, S)
    case 'select':
      return `(${emitExpr(e.cond, S)} ? ${emitExpr(e.ifTrue, S)} : ${emitExpr(e.ifFalse, S)})`
    case 'index':
      return `(${emitExpr(e.base, S)})[${emitExpr(e.idx, S)}]`
    case 'matchExpr': {
      // Evaluate the scrutinee once (IIFE arg), then a lazy nested ternary picks
      // the matching case's expr or the default — same no-fall-through, only the
      // matched arm evaluated. `$m` cannot collide with $a/$v/$C/$O ids.
      let expr = emitExpr(e.default, S)
      for (let i = e.cases.length - 1; i >= 0; i--) {
        expr = `($m === ${jsNum(e.cases[i]![0])} ? ${emitExpr(e.cases[i]![1], S)} : ${expr})`
      }
      return `(($m) => ${expr})(${emitExpr(e.scrutinee, S)})`
    }
  }
}

function emitBinop(e: Extract<Expr, { op: 'binop' }>, S: FnCtx): string {
  const a = emitExpr(e.a, S)
  const b = emitExpr(e.b, S)
  // mat*vec / mat*mat / vec*mat dispatched by STATIC type, exactly as the
  // interpreter dispatches (values are type-blind number[] at runtime).
  if (
    e.bop === '*' &&
    e.a.type.kind === 'mat' &&
    (e.b.type.kind === 'vec' || e.b.type.kind === 'vec64')
  )
    return `$.matVec(${a}, ${b})`
  if (e.bop === '*' && e.a.type.kind === 'mat' && e.b.type.kind === 'mat')
    return `$.matMul(${a}, ${b})`
  if (e.bop === '*' && e.a.type.kind === 'vec' && e.b.type.kind === 'mat') return `$.vecMatThrow()`
  const i32 = isI32(e.a.type)
  // Either operand a vector ⇒ component-wise (with scalar broadcast) via the
  // shared applyBin — the SAME function the interpreter uses.
  if (isArrayValued(e.a.type) || isArrayValued(e.b.type))
    return `$.applyBin(${q(e.bop)}, ${a}, ${b}, ${i32})`
  // Both scalar — inline to scalarBin's exact JS ops.
  return emitScalarBin(e.bop, a, b, i32)
}

function emitScalarBin(bop: BinOp, a: string, b: string, i32: boolean): string {
  switch (bop) {
    case '+':
      return `(${a} + ${b})`
    case '-':
      return `(${a} - ${b})`
    case '*':
      return `(${a} * ${b})`
    case '/':
      return `(${a} / ${b})`
    case '%':
      return `(${a} % ${b})`
    case '&':
      return `((${a} & ${b}) >>> 0)`
    case '|':
      return `((${a} | ${b}) >>> 0)`
    case '^':
      return `((${a} ^ ${b}) >>> 0)`
    case '<<':
      return `((${a} << ${b}) >>> 0)`
    case '>>':
      return i32 ? `(${a} >> ${b})` : `(${a} >>> ${b})`
  }
}

function emitConstruct(e: Extract<Expr, { op: 'construct' }>, S: FnCtx): string {
  if (e.type.kind === 'array') return `[${e.args.map((a) => emitExpr(a, S)).join(', ')}]`
  if (e.type.kind === 'struct') {
    const decl = S.mod.structs.get(e.type.name)
    if (decl === undefined) throw new CodegenUnsupported(`struct ${e.type.name} not declared`)
    const fields = decl.fields.map((f, i) => `${q(f.name)}: ${emitExpr(e.args[i]!, S)}`)
    return `{ ${fields.join(', ')} }`
  }
  // Vector: WGSL splat (single scalar arg fills all N) vs flatten (scalars +
  // spread vec args), matching the interpreter's out.length===1 check.
  const n = e.type.kind === 'vec' || e.type.kind === 'vec64' ? e.type.n : 0
  if (e.args.length === 1 && !isArrayValued(e.args[0]!.type))
    return `$.splat(${n}, ${emitExpr(e.args[0]!, S)})`
  const parts = e.args.map((a) =>
    isArrayValued(a.type) ? `...(${emitExpr(a, S)})` : emitExpr(a, S),
  )
  return `[${parts.join(', ')}]`
}

/** Assignment as an EXPRESSION (no trailing `;`) — used for for-loop updates
 *  and, with `;` appended, for statements. Mirrors setLValue. */
function emitAssignExpr(target: Expr, valueStr: string, S: FnCtx): string {
  if (target.op === 'varref' || target.op === 'param') {
    const id = S.varId.get(target.name) ?? declareVar(target.name, S)
    return `${id} = ${valueStr}`
  }
  if (target.op === 'member') {
    const base = emitExpr(target.base, S)
    if (isArrayValued(target.base.type)) {
      const i = FIELD_IDX[target.field]
      if (i === undefined) throw new CodegenUnsupported(`assign .${target.field}`)
      return `(${base})[${i}] = ${valueStr}`
    }
    return `(${base})[${q(target.field)}] = ${valueStr}`
  }
  if (target.op === 'index') {
    return `(${emitExpr(target.base, S)})[${emitExpr(target.idx, S)}] = ${valueStr}`
  }
  throw new CodegenUnsupported(`assignment target ${target.op}`)
}

function emitStmt(s: Stmt, S: FnCtx): string {
  switch (s.s) {
    case 'let': {
      const id = declareVar(s.name, S)
      return `${id} = ${emitExpr(s.expr, S)};`
    }
    case 'var': {
      const id = declareVar(s.name, S)
      return `${id} = ${s.init ? emitExpr(s.init, S) : zeroLit(s.type)};`
    }
    case 'assign':
      return `${emitAssignExpr(s.target, emitExpr(s.expr, S), S)};`
    case 'assignOp': {
      const i32 = isI32(s.target.type)
      const val = `$.applyBin(${q(s.bop)}, ${emitExpr(s.target, S)}, ${emitExpr(s.expr, S)}, ${i32})`
      return `${emitAssignExpr(s.target, val, S)};`
    }
    case 'return':
      return s.expr ? `return ${emitExpr(s.expr, S)};` : `return undefined;`
    case 'break':
      return `break;`
    case 'continue':
      return `continue;`
    case 'discard':
      // The interpreter's discard signal propagates out of the fn as `undefined`.
      return `return undefined;`
    case 'if': {
      const parts: string[] = []
      s.arms.forEach((arm, i) => {
        parts.push(
          `${i === 0 ? 'if' : 'else if'} (${emitExpr(arm.cond, S)}) {\n${emitBody(arm.body, S)}\n}`,
        )
      })
      if (s.elseBody) parts.push(`else {\n${emitBody(s.elseBody, S)}\n}`)
      return parts.join(' ')
    }
    case 'for': {
      const init = emitForInit(s.init, S)
      const cond = emitExpr(s.cond, S)
      const update = emitForUpdate(s.update, S)
      return `for (${init}; ${cond}; ${update}) {\n${emitBody(s.body, S)}\n}`
    }
    case 'switch': {
      // Native switch: strict-=== case match + no fall-through (explicit break),
      // which is exactly the interpreter's find-by-value + single-case-body. A
      // `break` inside a case body is consumed by this switch; a `continue` /
      // `return` / discard propagates, same as the interpreter's signals.
      const scrut = emitExpr(s.scrut, S)
      const cases = s.cases.map(
        (c) => `case ${jsNum(c.value)}: {\n${emitBody(c.body, S)}\nbreak;\n}`,
      )
      const dflt = s.defaultBody ? `default: {\n${emitBody(s.defaultBody, S)}\nbreak;\n}` : ''
      return `switch (${scrut}) {\n${cases.join('\n')}\n${dflt}\n}`
    }
    case 'placeholder':
      // Composer must splice before emit; on the CPU path a leak is a bug — fall
      // this fn back to the interpreter (which throws loudly with the tag).
      throw new CodegenUnsupported(`placeholder ${s.tag}`)
    case 'raw':
      // Raw WGSL passthrough is GPU-only — no CPU evaluation. Fall back.
      throw new CodegenUnsupported('raw WGSL Stmt')
  }
}

function emitForInit(s: Stmt, S: FnCtx): string {
  if (s.s === 'let') return `${declareVar(s.name, S)} = ${emitExpr(s.expr, S)}`
  if (s.s === 'var')
    return `${declareVar(s.name, S)} = ${s.init ? emitExpr(s.init, S) : zeroLit(s.type)}`
  throw new CodegenUnsupported(`for-init ${s.s}`)
}

function emitForUpdate(s: Stmt, S: FnCtx): string {
  if (s.s === 'assign') return emitAssignExpr(s.target, emitExpr(s.expr, S), S)
  if (s.s === 'assignOp') {
    const i32 = isI32(s.target.type)
    const val = `$.applyBin(${q(s.bop)}, ${emitExpr(s.target, S)}, ${emitExpr(s.expr, S)}, ${i32})`
    return emitAssignExpr(s.target, val, S)
  }
  throw new CodegenUnsupported(`for-update ${s.s}`)
}

function emitBody(body: readonly Stmt[], S: FnCtx): string {
  return body.map((s) => emitStmt(s, S)).join('\n')
}

/** The runtime object closed over by every generated fn (the factory's `$`). */
interface CodegenRuntime {
  applyBin: typeof applyBin
  matVec: typeof matVec
  matMul: typeof matMul
  B: typeof BUILTINS
  bindings: Record<string, CpuValue>
  /** name → resolved impl (compiled fn or interpreter fallback). Populated after
   *  both halves are built so cross-fn calls see the final table. */
  F: Record<string, (...a: CpuValue[]) => CpuValue>
  splat: (n: number, v: number) => number[]
  swiz: (a: number[], idx: number[]) => number[]
  negVec: (a: number[]) => number[]
  gpuStub: (name: string, ...args: CpuValue[]) => CpuValue
  vecMatThrow: () => never
}

export function compileModuleJs(m: ModuleDecl, opts?: { gpuStubs?: boolean }): CpuModule {
  // Identical preamble to compileModule so the generated code walks the SAME IR
  // the interpreter would (validate rejects malformed modules; autoVars
  // materialises plain-const assignables into var bindings).
  validate(m)
  const mv = autoVars(m)
  const gpuStubs = opts?.gpuStubs ?? false

  const mod: ModCtx = {
    structs: new Map(mv.structs.map((s) => [s.name, s])),
    constId: new Map(),
    overrideId: new Map(),
  }

  // ── Module-scope decls (consts + overrides) as factory-local `const`s ──
  // A scalar const embeds its full-precision cpuValue; a valueExpr const runs
  // the same op tree (may reference earlier consts). Overrides read as their
  // default (the un-specialized mirror), matching the interpreter.
  const decls: string[] = []
  {
    // A const valueExpr is a pure literal expression (no params / bindings), so a
    // throwaway FnCtx with empty varId is the right compile env; a later const may
    // reference an earlier one via constId.
    const constEnv: FnCtx = { mod, varId: new Map(), hoisted: [], n: 0 }
    mv.consts.forEach((c, i) => {
      const id = `$C_${i}`
      mod.constId.set(c.name, id)
      const rhs = c.valueExpr ? emitExpr(c.valueExpr, constEnv) : jsNum(c.cpuValue)
      decls.push(`const ${id} = ${rhs};`)
    })
    ;(mv.overrides ?? []).forEach((o, i) => {
      const id = `$O_${i}`
      mod.overrideId.set(o.name, id)
      decls.push(`const ${id} = ${jsNum(o.default)};`)
    })
  }

  // ── Per-fn codegen (hybrid: a body that can't be emitted falls back) ──
  const fnSrcs: string[] = []
  const fallbackNames: string[] = []
  for (const f of mv.funcs) {
    try {
      const S: FnCtx = { mod, varId: new Map(), hoisted: [], n: 0 }
      const params = f.params.map((p, i) => {
        const id = `$a${i}`
        S.varId.set(p.name, id)
        return id
      })
      const bodySrc = emitBody(f.body, S)
      const hoist = S.hoisted.length ? `let ${S.hoisted.join(', ')};\n` : ''
      fnSrcs.push(`${q(f.name)}: function(${params.join(', ')}) {\n${hoist}${bodySrc}\n}`)
    } catch (err) {
      if (err instanceof CodegenUnsupported) {
        fallbackNames.push(f.name)
        continue
      }
      throw err
    }
  }

  const factorySrc = `${decls.join('\n')}\nreturn {\n${fnSrcs.join(',\n')}\n};`
  // `new Function` construction is what a CSP `unsafe-eval` host blocks — let it
  // throw so the caller (cpu-projections) can fall the whole module back.
  const factory = new Function('$', factorySrc) as (
    $: CodegenRuntime,
  ) => Record<string, (...a: CpuValue[]) => CpuValue>

  const runtime: CodegenRuntime = {
    applyBin,
    matVec,
    matMul,
    B: BUILTINS,
    bindings: {},
    F: {},
    splat: (n, v) => new Array(n).fill(v),
    swiz: (a, idx) => idx.map((i) => a[i]!),
    negVec: (a) => a.map((v) => -v),
    gpuStub: (name, ...args) => {
      if (!gpuStubs)
        throw new Error(
          `shader-dsl/cpu: '${name}' is GPU-only and not computable here — pass compileModule(m, { gpuStubs: true }) to accept placeholder values (#763 O3)`,
        )
      return GPU_STUBS[name]!(...args)
    },
    vecMatThrow: () => {
      throw new Error('shader-dsl/cpu: vec*mat (row-vector form) is not implemented — use mat*vec')
    },
  }

  const jsFns = factory(runtime)

  // Only build the interpreter twin when a fn actually needs it — its fns supply
  // the fallback bodies AND its own consts/bindings so a fallback fn (and any fn
  // it transitively calls through ITS ctx) runs fully in the interpreter.
  const interp: CpuModule | null = fallbackNames.length ? compileModule(m, opts) : null

  const F: Record<string, (...a: CpuValue[]) => CpuValue> = {}
  for (const f of mv.funcs) {
    F[f.name] = jsFns[f.name] ?? interp!.fns[f.name]!
  }
  runtime.F = F

  return {
    fns: F,
    setBinding: (name, value) => {
      runtime.bindings[name] = value
      interp?.setBinding(name, value)
    },
  }
}
