// ═══ Shader DSL — seeded, typed random-IR generator (#2406, direction record D6.1) ═══
//
// Every other "property" test in this package randomises INPUTS over a fixed kernel. This
// generates the KERNEL: whole `ModuleDecl`s, deterministic from a seed, type-correct by
// construction so `validate()` accepts them, and shaped to reach the constructs the
// compiler's defects actually lived in.
//
// It is a fuzz CORPUS, not a fuzz ENGINE: no shrinking, no coverage feedback. A failure is
// reproduced by its seed, which is what a regression test needs — and `describeCorpus`
// exists so a green run can be checked for having generated anything at all. A generator
// that silently stopped emitting integer division would report zero divergences forever
// (CLAUDE.md §12 — validate the instrument against a known positive before believing a zero).
//
// NOT generated, deliberately: `raw` / `placeholder` statements and `hostBlock` / `externVar`
// (opaque by construction — they have no CPU semantics to differentiate against), textures
// and samplers (they need GPU stubs, not values), and `f64` (its own lowering pass owns it).

import type { Expr, Stmt, ModuleDecl, FuncDecl, ShaderType, BinOp, CmpOp } from '../ir/index.js'
import { f32T, i32T, u32T, boolT, vec2fT, vec3fT, vec4fT } from '../ir/index.js'

/** Deterministic PRNG — mulberry32. Same seed, same module, on every machine and run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** What the generator was asked to build. Every field has a defaulted, DOCUMENTED value —
 *  a caller narrowing one (integers only, say) is bisecting a failure, not configuring. */
export interface GenOptions {
  /** Functions per module (default 6). */
  readonly funcs?: number
  /** Statements in a function body, before the mandatory `return` (default 5). */
  readonly stmts?: number
  /** Maximum expression nesting (default 3). Depth 0 is a leaf. */
  readonly depth?: number
  /** Maximum BLOCK nesting — `if` / `for` / `switch` inside each other (default 2). */
  readonly nest?: number
  /** Types a generated function may take and return (default: all scalars + f32 vectors). */
  readonly types?: readonly ShaderType[]
}

const SCALARS: readonly ShaderType[] = [f32T, i32T, u32T]
const DEFAULT_TYPES: readonly ShaderType[] = [...SCALARS, vec2fT, vec3fT, vec4fT]

const isF32 = (t: ShaderType): boolean =>
  (t.kind === 'scalar' && t.scalar === 'f32') || (t.kind === 'vec' && t.elem === 'f32')
/** A type PREDICATE, not a boolean: every caller then reads `t.scalar` under the narrowing. */
const isInt = (
  t: ShaderType,
): t is Extract<ShaderType, { kind: 'scalar' }> & { scalar: 'i32' | 'u32' } =>
  t.kind === 'scalar' && (t.scalar === 'i32' || t.scalar === 'u32')
const isVec = (t: ShaderType): boolean => t.kind === 'vec'
const arity = (t: ShaderType): number => (t.kind === 'vec' ? t.n : 1)

// Builtins split by the argument shape they accept, so a call is type-correct by construction.
// Only value-returning, side-effect-free, CPU-defined ones — the oracle is the contract.
const F32_UNARY = [
  'sin',
  'cos',
  'tan',
  'atan',
  'sinh',
  'tanh',
  'exp',
  'log2',
  'sqrt',
  'exp2',
  'inverseSqrt',
  'trunc',
  'round',
  'floor',
  'ceil',
  'abs',
  'sign',
  'fract',
  'radians',
  'degrees',
] as const
const F32_BINARY = ['atan2', 'pow', 'step', 'min', 'max'] as const
const F32_TERNARY = ['mix', 'clamp', 'smoothstep'] as const
const INT_UNARY = ['abs', 'sign'] as const
const INT_BINARY = ['min', 'max'] as const
/** Vector → scalar f32. Only on f32 vectors; `dot`'s CPU form reduces to a number. */
const VEC_REDUCE = ['length'] as const

const F32_BINOPS: readonly BinOp[] = ['+', '-', '*', '/']
// Integer ops carry WGSL's own semantics (wrap, truncating `/`, `x/0 = x`, `x%0 = 0`) — the
// exact surface #2274 got wrong, so `/` and `%` are generated on purpose, over divisors that
// CAN be zero.
const INT_BINOPS: readonly BinOp[] = ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']
const CMPS: readonly CmpOp[] = ['<', '<=', '>', '>=', '==', '!=']

/** One generated module plus what it actually contains — the instrument's own self-report. */
export interface Corpus {
  readonly module: ModuleDecl
  readonly seed: number
  /** Construct counts, for asserting the generator still reaches what it claims to. */
  readonly features: Readonly<Record<string, number>>
}

class Gen {
  private n = 0
  readonly features: Record<string, number> = {}

  constructor(private readonly rnd: () => number) {}

  private mark(f: string): void {
    this.features[f] = (this.features[f] ?? 0) + 1
  }
  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rnd() * xs.length)]!
  }
  private chance(p: number): boolean {
    return this.rnd() < p
  }
  /** Function-unique binding name — `no-shadowed-local` (#2341) is a CORE gate, so a
   *  generator that reused a name would be emitting INVALID modules, not finding bugs. */
  private fresh(): string {
    return `g${this.n++}`
  }
  private resetNames(): void {
    this.n = 0
  }

  private literal(t: ShaderType): Expr {
    if (t.kind === 'scalar' && t.scalar === 'bool')
      return { op: 'lit', type: t, value: this.chance(0.5) }
    if (isInt(t)) {
      // Small magnitudes keep products inside the wrap window most of the time, and 0 is
      // over-weighted: it is the divisor that separates WGSL's `x/0 = x` from JS's Infinity.
      const pool = [0, 0, 1, 2, 3, 7, -1, -5, 255, 65535]
      const v = this.pick(pool)
      return { op: 'lit', type: t, value: t.scalar === 'u32' ? v >>> 0 : v | 0 }
    }
    const pool = [0, 1, -1, 0.5, -0.25, 2, 3.5, 1e-3, 1e3, Math.PI]
    const v = this.pick(pool)
    if (isVec(t))
      return {
        op: 'construct',
        type: t,
        args: Array.from({ length: arity(t) }, () => this.literal(f32T)),
      }
    return { op: 'lit', type: t, value: v }
  }

  /** An in-scope value of exactly `t`, or a literal when scope offers none. */
  private leaf(
    t: ShaderType,
    scope: ReadonlyArray<{ name: string; type: ShaderType; op: 'param' | 'varref' }>,
  ): Expr {
    const same = scope.filter((v) => typeKey(v.type) === typeKey(t))
    if (same.length > 0 && this.chance(0.7)) {
      const v = this.pick(same)
      return { op: v.op, type: v.type, name: v.name } as Expr
    }
    return this.literal(t)
  }

  private boolExpr(depth: number, scope: Scope, fns: readonly FuncSig[]): Expr {
    const t = this.pick(SCALARS)
    const a = this.expr(t, depth - 1, scope, fns)
    const b = this.expr(t, depth - 1, scope, fns)
    const cmp: Expr = { op: 'compare', type: boolT, cop: this.pick(CMPS), a, b }
    if (depth > 1 && this.chance(0.3)) {
      this.mark('logical')
      return {
        op: 'logical',
        type: boolT,
        lop: this.chance(0.5) ? '&&' : '||',
        a: cmp,
        b: this.boolExpr(depth - 1, scope, fns),
      }
    }
    return cmp
  }

  /** An expression of EXACTLY `t`. Every arm preserves the type, so `validate()` passes and
   *  the generator tests semantics rather than the type checker. */
  expr(t: ShaderType, depth: number, scope: Scope, fns: readonly FuncSig[]): Expr {
    if (t.kind === 'scalar' && t.scalar === 'bool')
      return this.boolExpr(Math.max(depth, 1), scope, fns)
    if (depth <= 0) return this.leaf(t, scope)

    const arms: Array<() => Expr> = []

    arms.push(() => {
      const bop = this.pick(isInt(t) ? INT_BINOPS : F32_BINOPS)
      if (isInt(t) && (bop === '/' || bop === '%')) this.mark(`int${bop}`)
      if (isInt(t) && (bop === '<<' || bop === '>>')) this.mark('intShift')
      else if (isInt(t)) this.mark('intArith')
      // A shift count must be u32 on both targets; everything else is same-typed.
      const b =
        bop === '<<' || bop === '>>'
          ? ({ op: 'lit', type: u32T, value: Math.floor(this.rnd() * 34) } as Expr) // >31 included: the wrap case
          : this.expr(t, depth - 1, scope, fns)
      return { op: 'binop', type: t, bop, a: this.expr(t, depth - 1, scope, fns), b }
    })

    arms.push(() => {
      this.mark('select')
      return {
        op: 'select',
        type: t,
        cond: this.boolExpr(depth - 1, scope, fns),
        ifTrue: this.expr(t, depth - 1, scope, fns),
        ifFalse: this.expr(t, depth - 1, scope, fns),
      }
    })

    if (isF32(t)) {
      arms.push(() => {
        this.mark('builtin')
        const k = this.rnd()
        const [fn, n] =
          k < 0.5
            ? [this.pick(F32_UNARY), 1]
            : k < 0.8
              ? [this.pick(F32_BINARY), 2]
              : [this.pick(F32_TERNARY), 3]
        // smoothstep/mix/clamp take same-typed args on both targets; scalars broadcast is
        // NOT generated, so the emit is always spellable.
        return {
          op: 'call',
          type: t,
          fn,
          args: Array.from({ length: n as number }, () => this.expr(t, depth - 1, scope, fns)),
        }
      })
    }
    if (isInt(t)) {
      arms.push(() => {
        this.mark('intBuiltin')
        // `abs`/`sign` on u32 are meaningless (and `abs(INT_MIN)` is the wrap case on i32).
        const unary = t.scalar === 'i32'
        const [fn, n] =
          unary && this.chance(0.4) ? [this.pick(INT_UNARY), 1] : [this.pick(INT_BINARY), 2]
        return {
          op: 'call',
          type: t,
          fn,
          args: Array.from({ length: n as number }, () => this.expr(t, depth - 1, scope, fns)),
        }
      })
      arms.push(() => {
        // Cross-kind conversion — a bit reinterpretation between i32 and u32, and a
        // truncation from f32. Both are places the CPU tier and the GPU can disagree.
        this.mark('convert')
        const from = this.chance(0.5) ? f32T : t.scalar === 'i32' ? u32T : i32T
        return {
          op: 'call',
          type: t,
          fn: t.scalar === 'i32' ? 'i32' : 'u32',
          args: [this.expr(from, depth - 1, scope, fns)],
        }
      })
    }
    if (isVec(t)) {
      arms.push(() => {
        this.mark('construct')
        return {
          op: 'construct',
          type: t,
          args: Array.from({ length: arity(t) }, () => this.expr(f32T, depth - 1, scope, fns)),
        }
      })
    }
    if (t.kind === 'scalar' && t.scalar === 'f32') {
      arms.push(() => {
        this.mark('swizzle')
        const src = this.pick([vec2fT, vec3fT, vec4fT] as const)
        const field = this.pick(['x', 'y', 'z', 'w'].slice(0, arity(src)))
        return { op: 'member', type: f32T, base: this.expr(src, depth - 1, scope, fns), field }
      })
      arms.push(() => {
        this.mark('reduce')
        const src = this.pick([vec2fT, vec3fT, vec4fT] as const)
        return {
          op: 'call',
          type: f32T,
          fn: this.pick(VEC_REDUCE),
          args: [this.expr(src, depth - 1, scope, fns)],
        }
      })
    }

    const callable = fns.filter((f) => typeKey(f.ret) === typeKey(t))
    if (callable.length > 0) {
      arms.push(() => {
        this.mark('callFn')
        const f = this.pick(callable)
        return {
          op: 'call',
          type: t,
          fn: f.name,
          args: f.params.map((p) => this.expr(p, depth - 1, scope, fns)),
        }
      })
    }

    return this.pick(arms)()
  }

  /** A statement list. `inLoop` gates `break` / `continue`, which are invalid outside one.
   *  `nest` is the BLOCK budget, deliberately separate from the expression `depth`: a `for`
   *  whose body may hold a `for` recurses on blocks, not on operators, so one counter cannot
   *  bound both (it did not — the first version recursed until the stack gave out). */
  private stmts(
    count: number,
    depth: number,
    scope: Scope,
    fns: readonly FuncSig[],
    inLoop: boolean,
    nest: number,
  ): Stmt[] {
    const out: Stmt[] = []
    for (let i = 0; i < count; i++) {
      // Past the block budget only NON-nesting statements are legal moves.
      const k = nest <= 0 ? this.rnd() * 0.5 : this.rnd()
      if (k < 0.3) {
        const t = this.pick(DEFAULT_TYPES)
        const name = this.fresh()
        out.push({ s: 'let', name, expr: this.expr(t, depth, scope, fns) })
        scope.push({ name, type: t, op: 'varref' })
        this.mark('let')
      } else if (k < 0.5) {
        const t = this.pick(DEFAULT_TYPES)
        const name = this.fresh()
        out.push({ s: 'var', name, type: t, init: this.expr(t, depth, scope, fns) })
        scope.push({ name, type: t, op: 'varref' })
        this.mark('var')
        // A mutation right after, so copy-prop / const-prop have a moving target to respect.
        if (this.chance(0.6)) {
          const target: Expr = { op: 'varref', type: t, name }
          if (this.chance(0.5)) {
            out.push({ s: 'assign', target, expr: this.expr(t, depth, scope, fns) })
            this.mark('assign')
          } else {
            const bop = this.pick(
              isInt(t) ? INT_BINOPS.filter((b) => b !== '<<' && b !== '>>') : F32_BINOPS,
            )
            out.push({ s: 'assignOp', target, bop, expr: this.expr(t, depth, scope, fns) })
            this.mark('assignOp')
          }
        }
      } else if (k < 0.68) {
        this.mark('if')
        out.push({
          s: 'if',
          arms: [
            {
              cond: this.boolExpr(depth, scope, fns),
              body: this.stmts(2, depth - 1, [...scope], fns, inLoop, nest - 1),
            },
          ],
          elseBody: this.chance(0.6)
            ? this.stmts(2, depth - 1, [...scope], fns, inLoop, nest - 1)
            : undefined,
        })
      } else if (k < 0.85) {
        this.mark('for')
        const iName = this.fresh()
        const trips = 3 + Math.floor(this.rnd() * 3)
        const iRef: Expr = { op: 'varref', type: i32T, name: iName }
        const inner: Scope = [...scope, { name: iName, type: i32T, op: 'varref' }]
        let body: Stmt[]
        if (nest > 0 && this.chance(0.5)) {
          // The ACCUMULATOR LOOP, emitted deliberately rather than hoped for. A `continue`
          // is only observable when something AFTER it in the loop body changes a value the
          // function returns — and a `switch` arm only runs when the scrutinee hits its
          // case. The first version of this generator satisfied neither: its scrutinee was
          // an arbitrary truncated float (so the arms were dead) and the switch was often
          // the last statement in the body (so `continue` and falling through agreed). It
          // generated 39 `continue`s inside switches and could not see #2275 reverted.
          // Here the scrutinee IS the loop counter, so cases 0/1/2 all execute, and the
          // accumulate lands after the switch, so skipping it is visible in the result.
          this.mark('accumulatorLoop')
          const accType = this.pick(SCALARS)
          const accName = this.fresh()
          // Declared in the ENCLOSING scope and pushed there, so the function's later
          // statements — the mandatory `return` above all — can read what the loop wrote.
          out.push({
            s: 'var',
            name: accName,
            type: accType,
            init: this.expr(accType, 1, scope, fns),
          })
          scope.push({ name: accName, type: accType, op: 'varref' })
          inner.push({ name: accName, type: accType, op: 'varref' })
          const acc: Expr = { op: 'varref', type: accType, name: accName }
          const mkArm = (tag: 'continue' | 'break' | 'plain'): Stmt[] => {
            const arm: Stmt[] = [
              { s: 'assignOp', target: acc, bop: '+', expr: this.expr(accType, 1, inner, fns) },
            ]
            if (tag !== 'plain') {
              this.mark(tag === 'continue' ? 'switchContinue' : 'switchBreak')
              arm.push({ s: tag })
            }
            return arm
          }
          body = [
            {
              s: 'switch',
              scrut: iRef,
              cases: [
                { value: 0, body: mkArm('continue') },
                { value: 1, body: mkArm('break') },
                { value: 2, body: mkArm('plain') },
              ],
              defaultBody: mkArm('continue'),
            },
            // Skipped on every `continue` above — this is what makes the propagation visible.
            { s: 'assignOp', target: acc, bop: '*', expr: this.expr(accType, 1, inner, fns) },
          ]
          this.mark('switch')
        } else {
          body = this.stmts(2, depth - 1, inner, fns, true, nest - 1)
        }
        out.push({
          s: 'for',
          init: { s: 'var', name: iName, type: i32T, init: { op: 'lit', type: i32T, value: 0 } },
          cond: {
            op: 'compare',
            type: boolT,
            cop: '<',
            a: iRef,
            b: { op: 'lit', type: i32T, value: trips },
          },
          update: {
            s: 'assign',
            target: iRef,
            expr: {
              op: 'binop',
              type: i32T,
              bop: '+',
              a: iRef,
              b: { op: 'lit', type: i32T, value: 1 },
            },
          },
          body,
        })
      } else if (inLoop && k < 0.93) {
        // `switch` with `break` / `continue` arms. #2275 was exactly this: the interpreter
        // swallowed a `continue` raised inside a switch case, so the loop kept executing the
        // rest of the body. Generated only inside a loop, where `continue` is legal.
        this.mark('switch')
        const scrut: Expr = {
          op: 'call',
          type: i32T,
          fn: 'i32',
          args: [this.expr(f32T, Math.max(depth - 1, 0), scope, fns)],
        }
        const mkArm = (): Stmt[] => {
          const body = this.stmts(1, depth - 1, [...scope], fns, true, nest - 1)
          const j = this.rnd()
          if (j < 0.4) {
            this.mark('switchContinue')
            body.push({ s: 'continue' })
          } else if (j < 0.7) {
            this.mark('switchBreak')
            body.push({ s: 'break' })
          }
          return body
        }
        out.push({
          s: 'switch',
          scrut,
          cases: [0, 1, 2].map((value) => ({ value, body: mkArm() })),
          defaultBody: mkArm(),
        })
      } else if (inLoop) {
        this.mark(this.chance(0.5) ? 'break' : 'continue')
        out.push(this.chance(0.5) ? { s: 'break' } : { s: 'continue' })
      }
    }
    return out
  }

  func(
    name: string,
    ret: ShaderType,
    paramTypes: readonly ShaderType[],
    opts: Required<Pick<GenOptions, 'stmts' | 'depth' | 'nest'>>,
    fns: readonly FuncSig[],
  ): FuncDecl {
    this.resetNames()
    const params = paramTypes.map((type) => ({ name: this.fresh(), type }))
    const scope: Scope = params.map((p) => ({ name: p.name, type: p.type, op: 'param' as const }))
    const body = this.stmts(opts.stmts, opts.depth, scope, fns, false, opts.nest)
    body.push({ s: 'return', expr: this.expr(ret, opts.depth, scope, fns) })
    return { name, params, ret, body, attrs: [] }
  }
}

type Scope = Array<{ name: string; type: ShaderType; op: 'param' | 'varref' }>
interface FuncSig {
  readonly name: string
  readonly ret: ShaderType
  readonly params: readonly ShaderType[]
}

/** Structural type identity — two ShaderTypes are interchangeable iff this matches. */
function typeKey(t: ShaderType): string {
  return t.kind === 'scalar'
    ? `s:${t.scalar}`
    : t.kind === 'vec'
      ? `v:${t.n}:${t.elem}`
      : `o:${t.kind}`
}

/** Generate one module from `seed`. Same seed ⇒ byte-identical module, forever. */
export function generateModule(seed: number, opts: GenOptions = {}): Corpus {
  const funcs = opts.funcs ?? 6
  const stmts = opts.stmts ?? 5
  const depth = opts.depth ?? 3
  const nest = opts.nest ?? 2
  const types = opts.types ?? DEFAULT_TYPES
  const gen = new Gen(mulberry32(seed))
  const rnd = mulberry32(seed ^ 0x5bf03635)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!

  const decls: FuncDecl[] = []
  const sigs: FuncSig[] = []
  for (let i = 0; i < funcs; i++) {
    const ret = pick(types)
    const params = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(types))
    // Only EARLIER functions are callable, so the call graph is a DAG and `no-recursion` holds.
    decls.push(gen.func(`f${i}`, ret, params, { stmts, depth, nest }, [...sigs]))
    sigs.push({ name: `f${i}`, ret, params })
  }
  return {
    module: { consts: [], structs: [], bindings: [], funcs: decls },
    seed,
    features: { ...gen.features },
  }
}

/** Merge the feature counts of a whole corpus — what the generator actually reached. */
export function describeCorpus(corpora: readonly Corpus[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of corpora)
    for (const [k, v] of Object.entries(c.features)) out[k] = (out[k] ?? 0) + v
  return out
}
