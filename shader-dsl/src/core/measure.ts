// ═══ Shader DSL — optimizer measurement (Optimization context) ═══
//
// "Measure, don't guess." Optimizer work (apply_log_depth precompute, cse-local, the
// GLSL fixpoint) has historically been justified by textual occurrence counts
// (`grep -o 'sin('`). This module makes that rigorous by measuring two distinct axes
// of an emitted shader and the optimizer's effect on each:
//
//   • OP COUNT — arithmetic + intrinsic-call nodes in the (lowered) IR. This is the
//     GPU-WORK proxy: the optimizer's job is to make the GPU do FEWER operations per
//     invocation. It is value-preserving and work-reducing, so op count is MONOTONE
//     non-increasing O0 → O2. This is the axis worth asserting.
//   • SOURCE SIZE — emitted chars / lines. The compile-time size proxy. It is NOT a
//     proxy for GPU cost and is NOT monotone: CSE hoisting `sin(x)` to `let _cse0 =
//     sin(x)` ADDS source bytes (a let line + a temp name) while REMOVING a GPU op.
//     Reported, never asserted to shrink — the −20-char "regression" is CSE doing its
//     job. (The recurring lesson: bytes saved ≠ work saved.)
//
// Both are compile-time-derivable (no GPU); the real-GPU cycle/timing axis is P3.

import type { ModuleDecl, Expr, Stmt, FuncDecl } from './ir'
import { emitModule, emitModuleAt, lowerWgsl } from './backends/wgsl'

// ── Source size ──

export interface EmitSize {
  /** Emitted source length in characters. */
  readonly chars: number
  /** Emitted source length in lines (`\n`-split). */
  readonly lines: number
}

/** Measure an already-emitted shader string. */
export function emitSize(code: string): EmitSize {
  return { chars: code.length, lines: code.split('\n').length }
}

// ── Operation count (the GPU-work proxy) ──

export interface OpCount {
  /** Intrinsic / user function-call nodes (sin, mix, pack4x8unorm, …) — the transcendental / ALU work. */
  readonly calls: number
  /** Arithmetic nodes: binop (+ − * / …), unop (−x), compare (<,>,==), logical (&&,||). */
  readonly arith: number
  /** calls + arith. */
  readonly total: number
}

function walkExpr(e: Expr, c: { calls: number; arith: number }): void {
  switch (e.op) {
    case 'call':
      c.calls++
      for (const a of e.args) walkExpr(a, c)
      break
    case 'binop':
    case 'compare':
    case 'logical':
      c.arith++
      walkExpr(e.a, c)
      walkExpr(e.b, c)
      break
    case 'unop':
      c.arith++
      walkExpr(e.a, c)
      break
    case 'construct':
      for (const a of e.args) walkExpr(a, c) // a vector ctor is not an ALU op; still recurse its args
      break
    case 'member':
      walkExpr(e.base, c)
      break
    case 'index':
      walkExpr(e.base, c)
      walkExpr(e.idx, c)
      break
    case 'select':
      walkExpr(e.cond, c)
      walkExpr(e.ifTrue, c)
      walkExpr(e.ifFalse, c)
      break
    case 'matchExpr':
      walkExpr(e.scrutinee, c)
      for (const [, v] of e.cases) walkExpr(v, c)
      walkExpr(e.default, c)
      break
    case 'lit':
    case 'constref':
    case 'overrideref': // #923 — a specialization-constant read is a leaf (zero ops)
    case 'param':
    case 'varref':
      break // leaf — no op
    default: {
      const _exhaustive: never = e // a new Expr kind must be classified here, not silently undercounted
      void _exhaustive
    }
  }
}

function walkStmt(s: Stmt, c: { calls: number; arith: number }): void {
  switch (s.s) {
    case 'let':
      walkExpr(s.expr, c)
      break
    case 'var':
      if (s.init !== undefined) walkExpr(s.init, c)
      break
    case 'assign':
    case 'assignOp':
      walkExpr(s.target, c)
      walkExpr(s.expr, c)
      break
    case 'return':
      if (s.expr !== undefined) walkExpr(s.expr, c)
      break
    case 'if':
      for (const arm of s.arms) {
        walkExpr(arm.cond, c)
        for (const b of arm.body) walkStmt(b, c)
      }
      if (s.elseBody) for (const b of s.elseBody) walkStmt(b, c)
      break
    case 'for':
      walkStmt(s.init, c)
      walkExpr(s.cond, c)
      walkStmt(s.update, c)
      for (const b of s.body) walkStmt(b, c)
      break
    case 'switch':
      walkExpr(s.scrut, c)
      for (const cs of s.cases) for (const b of cs.body) walkStmt(b, c)
      if (s.defaultBody) for (const b of s.defaultBody) walkStmt(b, c)
      break
    case 'raw': // opaque WGSL — ops invisible to the IR (documented undercount in countOps)
    case 'break':
    case 'continue':
    case 'discard':
    case 'placeholder':
      break // op-free / opaque
    default: {
      const _exhaustive: never = s // a new Stmt kind must be classified here, not silently undercounted
      void _exhaustive
    }
  }
}

function countFn(f: FuncDecl, c: { calls: number; arith: number }): void {
  for (const s of f.body) walkStmt(s, c)
}

/** Count arithmetic + call operations across every function body of a module. A `raw`
 *  Stmt is opaque (its WGSL ops are invisible to the IR) and contributes 0 — so a module
 *  built on raw blocks (the polygon composer) reports an undercount, not a wrong delta. */
export function countOps(m: ModuleDecl): OpCount {
  const c = { calls: 0, arith: 0 }
  for (const f of m.funcs) countFn(f, c)
  return { calls: c.calls, arith: c.arith, total: c.calls + c.arith }
}

// ── Combined report ──

export interface OptimizerReport {
  /** Source size at O0 vs O2; `saved*` may be NEGATIVE (CSE trades bytes for ops). */
  readonly size: {
    readonly o0: EmitSize
    readonly o2: EmitSize
    readonly savedChars: number
    readonly savedLines: number
  }
  /** Operation count at O0 vs O2; the optimizer never INCREASES either axis. */
  readonly ops: {
    readonly o0: OpCount
    readonly o2: OpCount
    readonly savedCalls: number
    readonly savedArith: number
  }
}

/** A/B a module's WGSL emit between naive (O0) and the production optimizer (O2) on both
 *  axes. The O2 source is the exact production emit (`emitModule`) and the op-counts run on
 *  `lowerWgsl` — the SAME lowering pipeline that emit uses — so the two halves never describe
 *  different modules, and neither measures a path the renderer does not ship. */
export function optimizerReport(m: ModuleDecl): OptimizerReport {
  const sizeO0 = emitSize(emitModuleAt(m, 'O0'))
  const sizeO2 = emitSize(emitModule(m)) // === emitModuleAt(m, 'O2'); use the canonical entry
  const opsO0 = countOps(lowerWgsl(m, 'O0'))
  const opsO2 = countOps(lowerWgsl(m, 'O2'))
  return {
    size: {
      o0: sizeO0,
      o2: sizeO2,
      savedChars: sizeO0.chars - sizeO2.chars,
      savedLines: sizeO0.lines - sizeO2.lines,
    },
    ops: {
      o0: opsO0,
      o2: opsO2,
      savedCalls: opsO0.calls - opsO2.calls,
      savedArith: opsO0.arith - opsO2.arith,
    },
  }
}
