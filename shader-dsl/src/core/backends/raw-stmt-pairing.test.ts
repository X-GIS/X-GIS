// ═══ Paired per-target raw statements — fail-before suite (#1671) ═══
//
// Today a `raw` Stmt is WGSL-ONLY by construction: `{ s: 'raw'; wgsl: string }`
// (ir/nodes.ts:143), the Backend contract spells it `rawStmt(wgsl: string)`
// (backend.ts:91), and the GLSL writer fails closed on it (glsl.ts:284-288 —
// UnsupportedFeatureError / SD0030). So the ONE authoring escape hatch the DSL
// offers is a hatch that shuts the WebGL2 backend off entirely: a module that
// needs a hand-written fragment on WGSL cannot ship a GLSL twin of it at all.
//
// #1671 pairs them: the node becomes an AT-LEAST-ONE union of
// `{ wgsl; glsl? }` | `{ wgsl?; glsl }`, each side emitted VERBATIM by its own
// backend, each backend still failing closed when ITS payload is missing.
//
// CASTS: every VALID shape below is now a BARE `Stmt` literal — the paired and
// one-sided forms typecheck without `as unknown as Stmt`, and that bare literal
// IS this file's positive type-level probe (it compiles only because the union
// admits it). A hand-built Stmt literal remains the established idiom for raw
// here (passes/opt/*.test.ts, passes/mangle.test.ts), which keeps the suite
// honest about testing the wire rather than the authoring sugar. The NEGATIVE
// probes (a raw with NO payload) live in the 'type-level contract' block below
// under `@ts-expect-error`, the repo idiom (dx-sweep.test.ts); tsc exercises
// them via `bun run build` — vitest does not typecheck.
//
// ─────────────────────────────────────────────────────────────────────────────
// FAIL-BEFORE TRANSCRIPT (#1671)
// Recorded on unmodified main @ 4d6a7b2a (no source file touched; this test file
// is the only addition). Per test: status + the EXACT reason it lands there.
//
//  1. paired raw → glsl payload verbatim in GLSL output
//     RED. emitGlslModule THROWS before producing any string:
//       UnsupportedFeatureError [SD0030]
//       "glsl-es300: raw WGSL Stmt cannot lower to GLSL (backendOnly:wgsl)"
//     glsl.ts:284 rawStmt is a bare `() => { throw ... }` — it never looks at the
//     Stmt, so a glsl payload sitting right there is unreachable.
//
//  2. paired raw → WGSL side unchanged
//     GREEN (a green-pin, not a red). emit.ts:102 reads `s.wgsl` and wgsl.ts:159
//     returns it, so the extra `glsl` key is inert on the WGSL path. Pre-
//     implementation emit captured byte-for-byte below; the fix must not move a
//     single byte of it.
//
//  3. wgsl-only raw still fails closed on GLSL
//     GREEN. Exactly the throw quoted in (1), code SD0030. Must KEEP passing:
//     pairing must not turn "no glsl payload" into a silent mis-emit.
//
//  4. uncalled wgsl-only-raw helper still fails closed on GLSL
//     GREEN. stageScope (glsl.ts:987) returns null the moment ANY func body has a
//     raw, which disables per-stage reachability filtering and emits EVERY func
//     into the stage — so a helper the entry never calls still reaches rawStmt and
//     still throws. deadFnElim (passes/opt/dce-fns.ts) does not save it either: it
//     bails out of whole-module tree-shaking on any raw for the same reason (a raw
//     may call a helper textually). Pinned because it is the documented consequence
//     of 987 and because #1671 must not silently "fix" it by dropping the helper.
//
//  5. glsl-only raw must fail closed on WGSL (the symmetric arm)
//     RED. Today NOTHING throws. wgsl.ts:159 is `rawStmt: (wgsl) => wgsl`, so an
//     absent payload returns `undefined` and emit.ts:102's template stringifies
//     it into the module body. Pre-implementation emit, verbatim:
//       "@fragment\nfn fs_glsl_only() -> @location(0) vec4<f32> {\n  undefined\n}\n"
//     That is not WGSL; it fails at naga with no line back to the authoring site —
//     the exact failure mode #1672 closed on the builtin surface. The assertion
//     below is the FUTURE contract (throw, message naming the missing wgsl side).
//
//  6. multi-line paired raw → indent prefix on the FIRST line only
//     RED, same SD0030 throw as (1) on the GLSL half. The WGSL half of this test
//     passes today and is asserted FIRST, deliberately: it is the reference the
//     GLSL half must mirror. emit.ts:102 is `${p}${be.rawStmt(...)}` — `p` is
//     prepended to the returned string as a whole, so line 2+ of a multi-line
//     payload lands at column 0. Captured pre-implementation on WGSL:
//       "  let _k = 1.0;\nreturn vec4<f32>(_k, 0.0, 0.0, 1.0);"
//     The GLSL side must land the same shape, not a re-indented one.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { emitGlslModule, emitModule, rawStmt, UnsupportedFeatureError } from '@xgis/shader-dsl'
import { fn, module } from '@xgis/shader-dsl'
import {
  vec4fT,
  f32T,
  structT,
  type Expr,
  type ModuleDecl,
  type StructDecl,
} from '@xgis/shader-dsl'
import type { Stmt } from '../ir'

// ── the two payloads: the SAME statement, spelled for each target ──
const WGSL_PAYLOAD = 'return vec4<f32>(1.0, 0.0, 0.0, 1.0);'
const GLSL_PAYLOAD = 'return vec4(1.0, 0.0, 0.0, 1.0);'

// minimal typed IR-node builders (the glsl.test.ts idiom — no authoring layer)
const lit = (value: number): Expr => ({ op: 'lit', type: f32T, value })
const v4 = (...args: Expr[]): Expr => ({ op: 'construct', type: vec4fT, args })

/** A single fragment entry with a bare `@location(0)` return, carrying `body`.
 *  Deliberately the smallest module that reaches BOTH writers' statement walk. */
const fragEntry = (name: string, body: readonly Stmt[]): ModuleDecl => ({
  consts: [],
  structs: [],
  bindings: [],
  funcs: [
    {
      name,
      attrs: ['@fragment'],
      stage: 'fragment',
      params: [],
      ret: vec4fT,
      retAttr: '@location(0)',
      body,
    },
  ],
})

// ── #1671's shape: both payloads on one Stmt ──
const pairedMod = (): ModuleDecl =>
  fragEntry('fs_paired', [{ s: 'raw', wgsl: WGSL_PAYLOAD, glsl: GLSL_PAYLOAD }])

// ── today's shape: WGSL payload only ──
const wgslOnlyMod = (): ModuleDecl => fragEntry('fs_wgsl_only', [{ s: 'raw', wgsl: WGSL_PAYLOAD }])

// ── the symmetric arm: GLSL payload only ──
const glslOnlyMod = (): ModuleDecl => fragEntry('fs_glsl_only', [{ s: 'raw', glsl: GLSL_PAYLOAD }])

/** Entry has NO raw; an UNCALLED helper carries a wgsl-only one. */
const uncalledRawHelperMod = (): ModuleDecl => {
  const base = fragEntry('fs_plain', [{ s: 'return', expr: v4(lit(1), lit(0), lit(0), lit(1)) }])
  return {
    ...base,
    funcs: [
      ...base.funcs,
      { name: 'never_called', params: [], ret: f32T, body: [{ s: 'raw', wgsl: 'return 1.0;' }] },
    ],
  }
}

/** A TWO-stage module: a raw-free vertex entry, a fragment entry carrying a
 *  PAIRED raw, and a plain helper (no raw) that NEITHER entry calls. The raw is
 *  paired, so neither backend throws — which is exactly what makes this fixture
 *  able to observe where the helper LANDS. */
const VsOutMin: StructDecl = {
  name: 'VsOutMin',
  fields: [{ name: 'position', type: vec4fT, attr: '@builtin(position)' }],
}
const bothStagesLeakMod = (): ModuleDecl => ({
  consts: [],
  structs: [VsOutMin],
  bindings: [],
  funcs: [
    {
      name: 'vs_plain',
      attrs: ['@vertex'],
      stage: 'vertex',
      params: [],
      // a STRUCT return: GLSL links varyings by NAME, so the writer fails closed
      // on a bare non-struct vertex output (glsl.ts emitGlslEntry).
      ret: structT('VsOutMin'),
      body: [
        { s: 'var', name: 'o', type: structT('VsOutMin') },
        {
          s: 'assign',
          target: {
            op: 'member',
            type: vec4fT,
            base: { op: 'varref', type: structT('VsOutMin'), name: 'o' },
            field: 'position',
          },
          expr: v4(lit(0), lit(0), lit(0), lit(1)),
        },
        { s: 'return', expr: { op: 'varref', type: structT('VsOutMin'), name: 'o' } },
      ],
    },
    {
      name: 'fs_paired_leak',
      attrs: ['@fragment'],
      stage: 'fragment',
      params: [],
      ret: vec4fT,
      retAttr: '@location(0)',
      body: [{ s: 'raw', wgsl: WGSL_PAYLOAD, glsl: GLSL_PAYLOAD }],
    },
    {
      name: 'lonely_helper',
      params: [],
      ret: f32T,
      body: [{ s: 'return', expr: lit(1) }],
    },
  ],
})

/** Assert a thrown UnsupportedFeatureError and hand back its message for further
 *  matching. `.code` is the stable host-facing contract (SD0030), so it is checked
 *  structurally rather than via a message regex alone. */
const expectSd0030 = (f: () => unknown): string => {
  let caught: unknown
  expect(() => {
    try {
      f()
    } catch (e) {
      caught = e
      throw e
    }
  }).toThrow(UnsupportedFeatureError)
  expect((caught as { code?: string }).code).toBe('SD0030')
  return (caught as Error).message
}

describe('raw Stmt — paired per-target payloads (#1671)', () => {
  // ── (1) RED ──
  it('a paired raw emits the GLSL payload verbatim on the GLSL backend', () => {
    const glsl = emitGlslModule(pairedMod(), 'fragment')
    expect(glsl).toContain(GLSL_PAYLOAD)
    // and the WGSL twin must not leak into the GLSL module — a GLSL compiler
    // would reject `vec4<f32>` outright, so containment alone is not enough.
    expect(glsl).not.toContain(WGSL_PAYLOAD)
  })

  // ── (2) GREEN-PIN (recorded honestly: this arm already passes) ──
  it('the same paired raw leaves the WGSL emit byte-identical', () => {
    const wgsl = emitModule(pairedMod())
    expect(wgsl).toContain(WGSL_PAYLOAD)
    expect(wgsl).not.toContain(GLSL_PAYLOAD)
    // The exact pre-implementation bytes (transcript entry 2). A real before/after
    // equality, not a re-baked snapshot: adding a `glsl` payload must cost the
    // WGSL module zero bytes.
    expect(wgsl).toBe(
      '@fragment\n' +
        'fn fs_paired() -> @location(0) vec4<f32> {\n' +
        `  ${WGSL_PAYLOAD}\n` +
        '}\n',
    )
  })

  // ── (3) GREEN-PIN ──
  it('a wgsl-only raw still fails closed on the GLSL backend', () => {
    const msg = expectSd0030(() => emitGlslModule(wgslOnlyMod(), 'fragment'))
    expect(msg).toMatch(/glsl-es300/)
    // the message must name the MISSING side — "unsupported on GLSL" alone does
    // not tell the author that the fix is to add a `glsl` spelling.
    expect(msg).toMatch(/carries no glsl payload/)
  })

  // ── (4) GREEN-PIN ──
  it('an UNCALLED helper carrying a wgsl-only raw still fails the whole GLSL stage', () => {
    const m = uncalledRawHelperMod()
    // premise, read off the WGSL emit: the entry is raw-free and its body never
    // names the helper, yet the helper itself survives — whole-module tree-
    // shaking simply never runs. deadFnElim (passes/opt/dce-fns.ts) is an
    // available-but-UNWIRED pass, deliberately absent from DEFAULT_PASSES
    // (passes/opt/optimize.ts), so nothing prunes an uncalled fn in the default
    // pipeline. (It would not save the helper even if wired: it bails on any raw
    // for the same reason stageScope does.) Both halves matter: without the
    // survival the GLSL throw below would prove nothing.
    expect(m.funcs[0]!.body.some((s) => s.s === 'raw')).toBe(false)
    const wgsl = emitModule(m)
    expect(wgsl).toContain('fn never_called() -> f32 {')
    const iEntry = wgsl.indexOf('fn fs_plain')
    const iHelper = wgsl.indexOf('fn never_called')
    // guard the slice: a future emit-order change must fail HERE, not silently
    // hand `not.toContain` an empty string and pass vacuously.
    expect(iEntry).toBeGreaterThanOrEqual(0)
    expect(iHelper).toBeGreaterThan(iEntry)
    const entryOnly = wgsl.slice(iEntry, iHelper)
    expect(entryOnly).not.toContain('never_called')
    // The mechanism this arm actually pins: the GLSL backend's stageScope bails
    // to null on any raw in the module → per-stage reachability filtering is
    // off → every func is emitted into the stage → the unreachable helper's raw
    // still reaches rawStmt and still throws.
    const msg = expectSd0030(() => emitGlslModule(m, 'fragment'))
    expect(msg).toMatch(/glsl-es300/)
  })

  // ── (5) RED ──
  it('a glsl-only raw fails closed on the WGSL backend (the symmetric arm)', () => {
    const msg = expectSd0030(() => emitModule(glslOnlyMod()))
    // the message must name the MISSING side, not just "unsupported" — and the
    // throw itself is what makes the old mis-behavior (`undefined` stringified
    // into the module body) unrepresentable.
    expect(msg).toMatch(/carries no wgsl payload/)
  })

  // ── (6) RED ──
  it('a multi-line paired raw carries the indent prefix on the FIRST line only', () => {
    const wgslMulti = 'let _k = 1.0;\nreturn vec4<f32>(_k, 0.0, 0.0, 1.0);'
    const glslMulti = 'float _k = 1.0;\nreturn vec4(_k, 0.0, 0.0, 1.0);'
    const m = (): ModuleDecl =>
      fragEntry('fs_multi', [{ s: 'raw', wgsl: wgslMulti, glsl: glslMulti }])

    // The reference (passes today): emit.ts:102 prepends `p` to the whole string,
    // so only line 1 is indented. Asserted first so the GLSL half below is a
    // mirror of a MEASURED behavior, not of an assumed one.
    expect(emitModule(m())).toContain(`  ${wgslMulti}`)

    // The mirror the fix owes: same first-line-only prefix, GLSL payload.
    expect(emitGlslModule(m(), 'fragment')).toContain(`  ${glslMulti}`)
  })

  // ── (7) the AUTHORING factory — the only vitest coverage rawStmt() has ──
  it('rawStmt() builds a paired node both backends emit from', () => {
    const m = (): ModuleDecl =>
      fragEntry('fs_factory', [rawStmt({ wgsl: WGSL_PAYLOAD, glsl: GLSL_PAYLOAD })])

    const wgsl = emitModule(m())
    expect(wgsl).toContain(WGSL_PAYLOAD)
    expect(wgsl).not.toContain(GLSL_PAYLOAD)

    const glsl = emitGlslModule(m(), 'fragment')
    expect(glsl).toContain(GLSL_PAYLOAD)
    expect(glsl).not.toContain(WGSL_PAYLOAD)
  })

  // ── (7b) the FLUENT twin — Builder.raw must PUSH into the scope, not just
  //        typecheck. A typed-but-unwired Builder method would be exactly the
  //        "diagnostic nothing can reach" pattern; this arm proves the wire. ──
  it('b.raw() inside a fluent fn() body pushes the paired raw Stmt', () => {
    const h = fn('uses_b_raw', {}, (_p, b) => {
      b.raw({ wgsl: WGSL_PAYLOAD, glsl: GLSL_PAYLOAD })
    })
    const m = module({ funcs: [h] })
    const rawNode = m.funcs.find((f) => f.name === 'uses_b_raw')?.body.find((s) => s.s === 'raw')
    expect(rawNode).toBeDefined()
    expect(rawNode).toMatchObject({ s: 'raw', wgsl: WGSL_PAYLOAD, glsl: GLSL_PAYLOAD })
    expect(emitModule(m)).toContain(WGSL_PAYLOAD)
  })

  // ── (8) the DOCUMENTED COST of raw: no GLSL stage scoping, module-wide ──
  it('any raw in the module leaks every helper into EVERY GLSL stage', () => {
    const m = bothStagesLeakMod()
    // `lonely_helper` is called by neither entry, and the vertex entry carries no
    // raw at all — yet stageScope bails to null on the FRAGMENT entry's raw, and
    // that bail is module-wide, so per-stage reachability filtering is off for
    // BOTH stages and every helper is emitted into each one.
    expect(emitGlslModule(m, 'vertex')).toContain('lonely_helper')
    expect(emitGlslModule(m, 'fragment')).toContain('lonely_helper')
    // Entries of the OTHER stage are still dropped before the body walk, so the
    // enforcement is per-stage even though the scoping bail is module-wide.
    expect(emitGlslModule(m, 'vertex')).not.toContain(GLSL_PAYLOAD)
    // This is the documented cost of raw (see AUTHORING): fragment-only
    // machinery (dpdx/fwidth, discard) in ANY helper of a raw-carrying module
    // WILL land in the vertex stage and fail to compile there.
  })

  // ── (9) type-level contract — exercised by tsc (`bun run build`), not vitest ──
  it('a raw with NO payload is unrepresentable (#1671 at-least-one)', () => {
    // @ts-expect-error — a raw with no payload is unrepresentable (#1671 at-least-one)
    const _bare: Stmt = { s: 'raw' }
    // @ts-expect-error — a raw with no payload is unrepresentable (#1671 at-least-one)
    const _empty = rawStmt({})
    void _bare
    void _empty
    // The assertions above are TYPE-level; this keeps the arm non-vacuous at
    // runtime by pinning that the factory does carry the payload through.
    expect(rawStmt({ glsl: GLSL_PAYLOAD })).toEqual({ s: 'raw', glsl: GLSL_PAYLOAD })
  })
})
