// ═══ Shader DSL — lint rule registry ═══
//
// Each rule is a self-contained LintRule. To add a rule (the 100th as easily as the
// 7th): write one here (or in its own file) and append it to RULES. The engine walks
// the IR once and dispatches to whichever handler each rule implements — a rule that
// only inspects expressions (mixed-scalar) implements `Expr`; a whole-function rule
// (single-exit) implements `Func`; a module-shape rule (dup-name) implements `Module`.
// No rule re-walks the tree.

import type { Stmt, ShaderType } from '../../ir'
import { typeKey } from '../../ir'
import type { LintRule } from './engine'
import { checkSingleExit } from '../single-exit'

// ── dup-struct / dup-func — duplicate top-level names ──
const dupStruct: LintRule = {
  id: 'dup-struct',
  description: 'duplicate struct name',
  severity: 'error',
  create: (ctx) => ({
    Module(m) {
      const seen = new Set<string>()
      for (const s of m.structs) {
        if (seen.has(s.name)) ctx.report(`duplicate struct '${s.name}'`)
        seen.add(s.name)
      }
    },
  }),
}

const dupFunc: LintRule = {
  id: 'dup-func',
  description: 'duplicate function name',
  severity: 'error',
  create: (ctx) => ({
    Module(m) {
      const seen = new Set<string>()
      for (const f of m.funcs) {
        if (seen.has(f.name)) ctx.report(`duplicate function '${f.name}'`)
        seen.add(f.name)
      }
    },
  }),
}

// ── binding-collision — (group,binding) uniqueness ──
const bindingCollision: LintRule = {
  id: 'binding-collision',
  description: '(group,binding) slot uniqueness',
  severity: 'error',
  create: (ctx) => ({
    Module(m) {
      const slots = new Map<string, string>()
      for (const b of m.bindings) {
        const key = `${b.group}:${b.binding}`
        const prev = slots.get(key)
        if (prev !== undefined) {
          ctx.report(`binding collision @group(${b.group}) @binding(${b.binding}) — '${b.name}' vs '${prev}'`)
        }
        slots.set(key, b.name)
      }
    },
  }),
}

// ── all-paths-return (RULE c) — a non-void fn must return on every path ──
function alwaysReturns(body: readonly Stmt[]): boolean {
  if (body.some((s) => s.s === 'raw' || s.s === 'placeholder')) return true
  if (body.length === 0) return false
  return stmtTerminates(body[body.length - 1])
}
function stmtTerminates(s: Stmt): boolean {
  switch (s.s) {
    case 'return': return true
    case 'discard': return true
    case 'if':
      return s.elseBody !== undefined
        && s.arms.every((arm) => alwaysReturns(arm.body))
        && alwaysReturns(s.elseBody)
    case 'switch':
      return s.defaultBody !== undefined
        && s.cases.every((c) => alwaysReturns(c.body))
        && alwaysReturns(s.defaultBody)
    default:
      return false
  }
}
const allPathsReturn: LintRule = {
  id: 'all-paths-return',
  description: 'a non-void fn must return on every path',
  severity: 'error',
  create: (ctx) => ({
    Func(f) {
      if (f.ret.kind !== 'void' && !alwaysReturns(f.body)) {
        ctx.report(`fn '${f.name}' returns non-void but a code path falls through without return`, { fn: f.name })
      }
    },
  }),
}

// ── single-exit (RULE s) — MISRA-C 15.5, one return at the end ──
const singleExit: LintRule = {
  id: 'single-exit',
  description: 'MISRA-C Rule 15.5 — a single point of exit (one return, as the final statement)',
  severity: 'error',
  create: (ctx) => ({
    Func(f) {
      for (const msg of checkSingleExit(f)) ctx.report(msg, { fn: f.name })
    },
  }),
}

// ── mixed-scalar (RULE t) — no implicit int↔float binop ──
const SHIFT_OPS = new Set(['<<', '>>'])
function mixedScalar(a: ShaderType, b: ShaderType): boolean {
  if (a.kind !== 'scalar' || b.kind !== 'scalar') return false
  if (a.scalar === 'bool' || b.scalar === 'bool') return false
  return a.scalar !== b.scalar
}
const mixedScalarRule: LintRule = {
  id: 'mixed-scalar',
  description: 'no implicit int/float (nor i32/u32) binop — WGSL rejects it',
  severity: 'error',
  // Just an Expr handler — the engine's single walk visits every sub-expression, so
  // this rule needs no recursion of its own (contrast the old hand-rolled walker).
  create: (ctx) => ({
    Expr(e, fn) {
      if (e.op === 'binop' && !SHIFT_OPS.has(e.bop) && mixedScalar(e.a.type, e.b.type)) {
        ctx.report(
          `mixed-scalar binop in fn '${fn.name}': ${typeKey(e.a.type)} ${e.bop} ${typeKey(e.b.type)} — WGSL has no implicit int/float conversion`,
          { fn: fn.name },
        )
      }
    },
  }),
}

// ── no-recursion — WGSL has no call stack; a fn must not (directly) call itself ──
const noRecursion: LintRule = {
  id: 'no-recursion',
  description: 'WGSL forbids recursion — a function must not call itself',
  severity: 'error',
  category: 'correctness',
  create: (ctx) => ({
    Expr(e, fn) {
      if (e.op === 'call' && e.fn === fn.name) {
        ctx.report(`fn '${fn.name}' calls itself — WGSL has no recursion`, { fn: fn.name })
      }
    },
  }),
}

// ── no-unreachable-code — a statement after a block terminator is dead ──
function reportUnreachable(body: readonly Stmt[], fnName: string, report: (m: string, o?: { fn?: string }) => void): void {
  body.forEach((s, i) => {
    const terminator = s.s === 'return' || s.s === 'discard' || s.s === 'break' || s.s === 'continue'
    if (terminator && i < body.length - 1) {
      report(`unreachable statement after '${s.s}' in fn '${fnName}'`, { fn: fnName })
    }
    if (s.s === 'if') {
      for (const arm of s.arms) reportUnreachable(arm.body, fnName, report)
      if (s.elseBody) reportUnreachable(s.elseBody, fnName, report)
    } else if (s.s === 'for') {
      reportUnreachable(s.body, fnName, report)
    } else if (s.s === 'switch') {
      for (const c of s.cases) reportUnreachable(c.body, fnName, report)
      if (s.defaultBody) reportUnreachable(s.defaultBody, fnName, report)
    }
  })
}
const noUnreachable: LintRule = {
  id: 'no-unreachable-code',
  description: 'no statements after a return / discard / break / continue in the same block',
  severity: 'error',
  category: 'correctness',
  create: (ctx) => ({ Func(f) { reportUnreachable(f.body, f.name, ctx.report) } }),
}

// ── no-float-eq — exact == / != on floats is unreliable (rounding) ──
const isFloat = (t: ShaderType): boolean => t.kind === 'scalar' && t.scalar === 'f32'
const noFloatEq: LintRule = {
  id: 'no-float-eq',
  description: 'exact == / != on f32 is unreliable — compare within an epsilon',
  severity: 'warning',
  category: 'correctness',
  create: (ctx) => ({
    Expr(e, fn) {
      if (e.op === 'compare' && (e.cop === '==' || e.cop === '!=') && (isFloat(e.a.type) || isFloat(e.b.type))) {
        ctx.report(`f32 '${e.cop}' in fn '${fn.name}' — exact float equality is unreliable`, { fn: fn.name })
      }
    },
  }),
}

// ── cyclomatic-complexity — decision points + 1, warn over a threshold ──
function decisionPoints(body: readonly Stmt[]): number {
  let n = 0
  for (const s of body) {
    if (s.s === 'if') {
      n += s.arms.length
      for (const a of s.arms) n += decisionPoints(a.body)
      if (s.elseBody) n += decisionPoints(s.elseBody)
    } else if (s.s === 'for') {
      n += 1 + decisionPoints(s.body)
    } else if (s.s === 'switch') {
      n += s.cases.length
      for (const c of s.cases) n += decisionPoints(c.body)
      if (s.defaultBody) n += decisionPoints(s.defaultBody)
    }
  }
  return n
}
const cyclomaticComplexity: LintRule = {
  id: 'cyclomatic-complexity',
  description: 'a function with too many branches is hard to verify',
  severity: 'warning',
  category: 'perf',
  create: (ctx) => ({
    Func(f) {
      const max = (ctx.options?.max as number) ?? 20
      const c = decisionPoints(f.body) + 1
      if (c > max) ctx.report(`fn '${f.name}' cyclomatic complexity ${c} > ${max}`, { fn: f.name })
    },
  }),
}

// ── param-count — too many parameters ──
const paramCount: LintRule = {
  id: 'param-count',
  description: 'a function with too many parameters is hard to call correctly',
  severity: 'warning',
  category: 'style',
  create: (ctx) => ({
    Func(f) {
      const max = (ctx.options?.max as number) ?? 6
      if (f.params.length > max) ctx.report(`fn '${f.name}' has ${f.params.length} parameters > ${max}`, { fn: f.name })
    },
  }),
}

/** The registered ruleset. Order is the diagnostic order (module checks, then per-fn
 *  in declaration order). Append new rules here. */
export const RULES: readonly LintRule[] = [
  dupStruct,
  dupFunc,
  bindingCollision,
  allPathsReturn,
  singleExit,
  mixedScalarRule,
  noRecursion,
  noUnreachable,
  noFloatEq,
  cyclomaticComplexity,
  paramCount,
]
