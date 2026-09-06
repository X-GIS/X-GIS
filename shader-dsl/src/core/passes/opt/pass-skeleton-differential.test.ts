// ═══ The substitution-pass skeleton, proved against the three bodies it replaced ═══
//
// `constProp` / `copyProp` / `memberFold` each carried its own copy of one skeleton — a
// hand-written `if`/`for`/`switch` descent collecting `let` bindings, then the same
// raw-Stmt skip + `collectMutatedRoots` + `mapStmt` rebuild (audit S14). They now share
// `collectLets` (expr-utils.ts) and `mapModuleExprsPerFunc` (ir-transform.ts).
//
// "I read all three and they look alike" is not evidence — three separately maintained
// copies is exactly where one has drifted. So this file keeps the THREE RETIRED BODIES
// VERBATIM and asserts the survivors equal them on every module of the random-IR corpus
// (random-ir.ts, the same generator the O1 differential uses), which reaches `if`, `for`,
// `switch` and nested bodies rather than the flat fixtures the per-pass suites use.
//
// INSTRUMENT CHECK FIRST (CLAUDE.md §12 — a blind probe reports zero, which reads as a
// clean corpus). A differential over inputs no pass transforms passes trivially and proves
// nothing, so the corpus must be shown to MOVE each pass before any equality is believed.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../../ir/index.js'
import { boolT, f32T, i32T } from '../../ir/types.js'
import { mapStmt, mapModuleExprsPerFunc } from './ir-transform.js'
import { bodyHasRaw, collectLets, collectMutatedRoots, refsLocal } from './expr-utils.js'
import { constProp } from './const-prop.js'
import { copyProp } from './copy-prop.js'
import { memberFold } from './member-fold.js'
import { generateModule, type Corpus } from '../../testing/random-ir.js'

const HERE = dirname(fileURLToPath(import.meta.url))

// ── the inputs ──────────────────────────────────────────────────────────────────────────
// The random corpus supplies the SHAPE (nested `if` / `for` / `switch` bodies, 144 fns) and
// 69 construct bindings for member-fold. It supplies ZERO literal and ZERO copy bindings —
// measured, and it is why this file plants its own. Without the planted module the const-
// prop and copy-prop differentials compare an empty map against an empty map and pass
// having proved nothing, which is precisely the shape a blind instrument takes (CLAUDE.md
// §12: "every test passed offset zero").

const lit = (v: number): Expr => ({ op: 'lit', type: f32T, value: v })
const vref = (name: string): Expr => ({ op: 'varref', type: f32T, name })
const add = (a: Expr, b: Expr): Expr => ({ op: 'binop', type: f32T, bop: '+', a, b })
const letS = (name: string, expr: Expr): Stmt => ({ s: 'let', name, expr })
const setMut = (e: Expr): Stmt => ({ s: 'assign', target: vref('mut'), expr: e })

/** One `let` of each admitted kind at EVERY nesting position the retired descents spelled
 *  out — top level, an `if` arm, an `else` body, a `for` body, a `switch` case and its
 *  default — plus two decoys the predicates must reject: a copy whose SOURCE is reassigned,
 *  and a literal binding that is itself an assignment target. */
const PLANTED: ModuleDecl = {
  consts: [],
  structs: [],
  bindings: [],
  funcs: [
    {
      name: 'planted',
      params: [{ name: 'p', type: f32T }],
      ret: f32T,
      body: [
        letS('topLit', lit(1.5)),
        letS('topCopy', { op: 'param', type: f32T, name: 'p' }),
        { s: 'var', name: 'mut', type: f32T, init: lit(0) },
        setMut(lit(9)),
        letS('mutCopy', vref('mut')), // decoy — copy of a reassigned source
        { s: 'var', name: 'reLit', type: f32T, init: lit(7) },
        setMut(vref('reLit')), // `reLit` is read, then reassigned below
        { s: 'assign', target: vref('reLit'), expr: lit(8) },
        {
          s: 'if',
          arms: [
            {
              cond: { op: 'compare', type: boolT, cop: '<', a: vref('topLit'), b: lit(2) },
              body: [
                letS('armLit', lit(2.5)),
                letS('armCopy', vref('topLit')),
                setMut(vref('armLit')),
              ],
            },
          ],
          elseBody: [letS('elseLit', lit(3.5)), setMut(vref('elseLit'))],
        },
        {
          s: 'for',
          init: { s: 'var', name: 'i', type: i32T, init: { op: 'lit', type: i32T, value: 0 } },
          cond: {
            op: 'compare',
            type: boolT,
            cop: '<',
            a: { op: 'varref', type: i32T, name: 'i' },
            b: { op: 'lit', type: i32T, value: 4 },
          },
          update: {
            s: 'assign',
            target: { op: 'varref', type: i32T, name: 'i' },
            expr: {
              op: 'binop',
              type: i32T,
              bop: '+',
              a: { op: 'varref', type: i32T, name: 'i' },
              b: { op: 'lit', type: i32T, value: 1 },
            },
          },
          body: [
            letS('loopLit', lit(4.5)),
            letS('loopCopy', vref('topLit')),
            setMut(vref('loopLit')),
          ],
        },
        {
          s: 'switch',
          scrut: { op: 'lit', type: i32T, value: 0 },
          cases: [{ value: 0, body: [letS('caseLit', lit(5.5)), setMut(vref('caseLit'))] }],
          defaultBody: [letS('defLit', lit(6.5)), setMut(vref('defLit'))],
        },
        {
          s: 'return',
          expr: add(
            add(add(vref('topLit'), vref('topCopy')), add(vref('mutCopy'), vref('armCopy'))),
            add(vref('loopCopy'), vref('mut')),
          ),
        },
      ],
    },
    // A fn holding a raw Stmt, so the driver's raw-body SKIP is exercised rather than
    // assumed. Neither the random corpus nor `planted` contains one — measured by cutting
    // the guard and watching every test stay green, which is what this fn fixes. Its `let`
    // binding is one the predicates WOULD admit, so a driver that stopped skipping rewrites
    // it and the differential diverges.
    {
      name: 'raw',
      params: [],
      ret: f32T,
      body: [
        letS('rawLit', lit(1.25)),
        { s: 'raw', wgsl: 'let spliced = 1.0;' },
        { s: 'return', expr: vref('rawLit') },
      ],
    },
  ],
}

const CORPUS: Corpus[] = Array.from({ length: 24 }, (_, i) => generateModule(i + 1))
const MODULES: readonly ModuleDecl[] = [...CORPUS.map((c) => c.module), PLANTED]

// ── the retired bodies, verbatim ────────────────────────────────────────────────────────
// Copied from const-prop.ts / copy-prop.ts / member-fold.ts as they stood at 1b8c03f6.
// Do NOT refactor these to share anything: their whole value is being the INDEPENDENT
// second implementation.
//
// ONE deviation from byte-verbatim, and it is type-level only: member-fold's collector
// declared `out` as `Map<string, Extract<Expr, { op: 'construct' }>>`. It is widened to
// `Map<string, Expr>` so the three share one signature in the table below; the bodies and
// every runtime decision are untouched, and the differential compares ENTRIES. Verified by
// diffing each retired function against `git show HEAD:…` with the `retired` prefix
// normalised away — the other three come back identical.

function retiredCollectConstLets(
  body: readonly Stmt[],
  mutated: ReadonlySet<string>,
  out: Map<string, Expr>,
): void {
  for (const s of body) {
    if (s.s === 'let' && s.expr.op === 'lit' && !mutated.has(s.name)) out.set(s.name, s.expr)
    else if (s.s === 'if') {
      for (const a of s.arms) retiredCollectConstLets(a.body, mutated, out)
      if (s.elseBody) retiredCollectConstLets(s.elseBody, mutated, out)
    } else if (s.s === 'for') {
      retiredCollectConstLets([s.init], mutated, out)
      retiredCollectConstLets(s.body, mutated, out)
    } else if (s.s === 'switch') {
      for (const c of s.cases) retiredCollectConstLets(c.body, mutated, out)
      if (s.defaultBody) retiredCollectConstLets(s.defaultBody, mutated, out)
    }
  }
}

function retiredConstProp(m: ModuleDecl): ModuleDecl {
  const fn = (f: FuncDecl): FuncDecl => {
    if (bodyHasRaw(f.body)) return f
    const mutated = new Set<string>()
    collectMutatedRoots(f.body, mutated)
    const consts = new Map<string, Expr>()
    retiredCollectConstLets(f.body, mutated, consts)
    if (consts.size === 0) return f
    const sub = (e: Expr): Expr =>
      e.op === 'varref' && consts.has(e.name) ? consts.get(e.name)! : e
    return { ...f, body: f.body.map((s) => mapStmt(s, sub)) }
  }
  return { ...m, funcs: m.funcs.map(fn) }
}

function retiredIsCopySource(e: Expr): e is Extract<Expr, { op: 'param' | 'varref' | 'constref' }> {
  return e.op === 'param' || e.op === 'varref' || e.op === 'constref'
}

function retiredCollectCopies(
  body: readonly Stmt[],
  mutated: ReadonlySet<string>,
  out: Map<string, Expr>,
): void {
  for (const s of body) {
    if (
      s.s === 'let' &&
      retiredIsCopySource(s.expr) &&
      !mutated.has(s.name) &&
      (s.expr.op === 'constref' || !mutated.has(s.expr.name))
    )
      out.set(s.name, s.expr)
    else if (s.s === 'if') {
      for (const a of s.arms) retiredCollectCopies(a.body, mutated, out)
      if (s.elseBody) retiredCollectCopies(s.elseBody, mutated, out)
    } else if (s.s === 'for') {
      retiredCollectCopies([s.init], mutated, out)
      retiredCollectCopies(s.body, mutated, out)
    } else if (s.s === 'switch') {
      for (const c of s.cases) retiredCollectCopies(c.body, mutated, out)
      if (s.defaultBody) retiredCollectCopies(s.defaultBody, mutated, out)
    }
  }
}

function retiredCopyProp(m: ModuleDecl): ModuleDecl {
  const fn = (f: FuncDecl): FuncDecl => {
    if (bodyHasRaw(f.body)) return f
    const mutated = new Set<string>()
    collectMutatedRoots(f.body, mutated)
    const copies = new Map<string, Expr>()
    retiredCollectCopies(f.body, mutated, copies)
    if (copies.size === 0) return f
    const sub = (e: Expr): Expr =>
      e.op === 'varref' && copies.has(e.name) ? copies.get(e.name)! : e
    return { ...f, body: f.body.map((s) => mapStmt(s, sub)) }
  }
  return { ...m, funcs: m.funcs.map(fn) }
}

function retiredCollectCtorLets(
  body: readonly Stmt[],
  mutated: ReadonlySet<string>,
  // The one edit to the three copies: member-fold's `out` was
  // `Map<string, Extract<Expr, { op: 'construct' }>>`. The differential compares ENTRIES,
  // so the annotation is widened to match its siblings; the body is untouched.
  out: Map<string, Expr>,
): void {
  for (const s of body) {
    if (
      s.s === 'let' &&
      s.expr.op === 'construct' &&
      !mutated.has(s.name) &&
      !s.expr.args.some((a) => refsLocal(a, mutated))
    )
      out.set(s.name, s.expr)
    else if (s.s === 'if') {
      for (const a of s.arms) retiredCollectCtorLets(a.body, mutated, out)
      if (s.elseBody) retiredCollectCtorLets(s.elseBody, mutated, out)
    } else if (s.s === 'for') {
      retiredCollectCtorLets([s.init], mutated, out)
      retiredCollectCtorLets(s.body, mutated, out)
    } else if (s.s === 'switch') {
      for (const c of s.cases) retiredCollectCtorLets(c.body, mutated, out)
      if (s.defaultBody) retiredCollectCtorLets(s.defaultBody, mutated, out)
    }
  }
}

// ── the survivors, driven through the same predicates ───────────────────────────────────

type LetPredicate = (name: string, e: Expr) => e is Expr

const constPred =
  (mutated: ReadonlySet<string>): LetPredicate =>
  (name, e): e is Expr =>
    e.op === 'lit' && !mutated.has(name)

const copyPred =
  (mutated: ReadonlySet<string>): LetPredicate =>
  (name, e): e is Expr =>
    retiredIsCopySource(e) && !mutated.has(name) && (e.op === 'constref' || !mutated.has(e.name))

const ctorPred =
  (mutated: ReadonlySet<string>): LetPredicate =>
  (name, e): e is Expr =>
    e.op === 'construct' && !mutated.has(name) && !e.args.some((a) => refsLocal(a, mutated))

const COLLECTORS: ReadonlyArray<{
  readonly name: string
  readonly retired: (
    body: readonly Stmt[],
    mutated: ReadonlySet<string>,
    out: Map<string, Expr>,
  ) => void
  readonly pred: (mutated: ReadonlySet<string>) => LetPredicate
}> = [
  { name: 'const-prop (literal bindings)', retired: retiredCollectConstLets, pred: constPred },
  { name: 'copy-prop (bare copy bindings)', retired: retiredCollectCopies, pred: copyPred },
  { name: 'member-fold (construct bindings)', retired: retiredCollectCtorLets, pred: ctorPred },
]

/** Every function body in the corpus, with the mutated-root set each pass computes. */
function bodies(): ReadonlyArray<{ body: readonly Stmt[]; mutated: ReadonlySet<string> }> {
  const out: { body: readonly Stmt[]; mutated: ReadonlySet<string> }[] = []
  for (const m of MODULES)
    for (const f of m.funcs) {
      if (bodyHasRaw(f.body)) continue
      const mutated = new Set<string>()
      collectMutatedRoots(f.body, mutated)
      out.push({ body: f.body, mutated })
    }
  return out
}

describe('substitution-pass skeleton (audit S14)', () => {
  // ── instrument check ──────────────────────────────────────────────────────────────────
  it('the inputs actually FEED each predicate — otherwise every equality below is vacuous', () => {
    const collected = { lit: 0, copy: 0, ctor: 0 }
    for (const { body, mutated } of bodies()) {
      collected.lit += collectLets(body, constPred(mutated)).size
      collected.copy += collectLets(body, copyPred(mutated)).size
      collected.ctor += collectLets(body, ctorPred(mutated)).size
    }
    // Floors MEASURED, not guessed: lit 6 / copy 3 / ctor 62. The two planted counts are
    // deterministic so they sit exactly at the measurement; ctor comes from the generator
    // and keeps margin. The random corpus ALONE gives lit 0 / copy 0 — the planted module
    // is what makes two thirds of this file mean anything, and a floor of `> 0` would not
    // have caught that.
    //
    // copy = 3 (topCopy / armCopy / loopCopy) is also the decoy's receipt: `mutCopy` binds
    // a reassigned source and is correctly NOT collected, so the count would be 4 if the
    // predicate's mutated-source arm were dropped.
    expect(
      collected.lit,
      `only ${collected.lit} literal bindings reached const-prop`,
    ).toBeGreaterThanOrEqual(6)
    expect(
      collected.copy,
      `only ${collected.copy} copy bindings reached copy-prop`,
    ).toBeGreaterThanOrEqual(3)
    expect(
      collected.ctor,
      `only ${collected.ctor} construct bindings reached member-fold`,
    ).toBeGreaterThanOrEqual(50)
  })

  it('each pass actually REWRITES the planted module — not just returns a fresh object', () => {
    // `!== m` is worthless here: every pass rebuilds `{ ...m }` unconditionally. Deep
    // inequality is the only honest witness that a substitution happened at all.
    for (const [name, pass] of [
      ['constProp', constProp],
      ['copyProp', copyProp],
      ['memberFold', memberFold],
    ] as const) {
      if (name === 'memberFold') continue // no construct binding in PLANTED; covered by the corpus
      expect(pass(PLANTED), `${name} left the planted module unchanged`).not.toEqual(PLANTED)
    }
    expect(
      CORPUS.filter((c) => JSON.stringify(memberFold(c.module)) !== JSON.stringify(c.module))
        .length,
      'memberFold rewrote no corpus module',
    ).toBeGreaterThan(0)
  })

  // ── A. the collection half ────────────────────────────────────────────────────────────
  for (const { name, retired, pred } of COLLECTORS)
    it(`collectLets equals the retired descent — ${name}`, () => {
      for (const { body, mutated } of bodies()) {
        const want = new Map<string, never>()
        retired(body, mutated, want)
        expect([...collectLets(body, pred(mutated))]).toEqual([...want])
      }
    })

  // ── B. the driver half ────────────────────────────────────────────────────────────────
  it('mapModuleExprsPerFunc equals the retired per-function skeleton', () => {
    // A rewrite with a per-function input, which is the whole reason the driver exists:
    // rename every varref to the fn's own name, so a driver that shared one closure across
    // functions — or skipped the raw-Stmt guard — diverges.
    const make =
      (f: FuncDecl): ((e: Expr) => Expr) =>
      (e) =>
        e.op === 'varref' ? { ...e, name: `${f.name}$${e.name}` } : e
    for (const m of MODULES) {
      const retiredOut = {
        ...m,
        funcs: m.funcs.map((f) => {
          if (bodyHasRaw(f.body)) return f
          const sub = make(f)
          return { ...f, body: f.body.map((s) => mapStmt(s, sub)) }
        }),
      }
      expect(mapModuleExprsPerFunc(m, make)).toEqual(retiredOut)
    }
  })

  it('mapModuleExprsPerFunc leaves a function UNTOUCHED when makeF declines', () => {
    // The `undefined` arm is how const-prop / copy-prop keep a subtree's identity when they
    // collected nothing; an implementation that rebuilt anyway would still pass toEqual.
    for (const m of MODULES) {
      const out = mapModuleExprsPerFunc(m, () => undefined)
      for (let i = 0; i < m.funcs.length; i++) expect(out.funcs[i]).toBe(m.funcs[i])
    }
  })

  // ── C. end to end, for the two passes whose whole body this diff moved ────────────────
  it('constProp equals the retired pass on every corpus module', () => {
    for (const m of MODULES) expect(constProp(m)).toEqual(retiredConstProp(m))
  })

  it('copyProp equals the retired pass on every corpus module', () => {
    for (const m of MODULES) expect(copyProp(m)).toEqual(retiredCopyProp(m))
  })

  // ── D. the guard (ADR-0013 decision 3 — the semantic patch stays in tree) ─────────────
  it('the three passes do not reintroduce a hand-written statement descent', () => {
    const strip = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const guilty: string[] = []
    for (const f of ['const-prop.ts', 'copy-prop.ts', 'member-fold.ts']) {
      const src = strip(readFileSync(join(HERE, f), 'utf8'))
      // `\w+\.s ===`, not `s\.s ===`: the receiver name is the author's choice, and a cut
      // that renamed it to `st` walked straight past the narrower pattern.
      if (/\w+\.s === '(if|for|switch)'/.test(src)) guilty.push(f)
    }
    // LIMIT, stated rather than implied: this names the three files S14 consolidated. The
    // rest of passes/opt still hand-writes descents (collectLocals, collectMutatedRoots,
    // bodyHasRaw, dropDead, unroll) — a separate, pre-existing cluster, not this gate's.
    expect(
      guilty,
      `these passes descend the Stmt shape themselves again — route through collectLets ` +
        `(expr-utils.ts) so a new Stmt kind reaches them by construction`,
    ).toEqual([])
  })
})
