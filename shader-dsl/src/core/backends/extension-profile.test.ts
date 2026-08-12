// ═══ WebGL2 extension profile surface — fail-before suite (#1670) ═══
//
// Today a module can declare only the five `Capability` ids of ir/nodes.ts:304
// (`storageBuffer | compute | msaaTextureLoad | f16 | subgroups`), and the GLSL ES
// 3.00 backend declares the EMPTY caps set (glsl.ts:269) — so there is NO way to say
// "this module needs EXT_color_buffer_float" such that the requirement (a) rides in
// the IR, (b) is gated fail-closed per backend, (c) becomes a `#extension` directive
// where GLSL needs one, and (d) is visible to the host through `reflect()` before
// pipeline creation. `Backend.modulePreamble` exists and the WGSL writer implements
// it, but `emitGlslModule` → `assembleGlsl` builds its OWN header parts array
// (glsl.ts:1210-1216) and never calls it.
//
// #1670 closes that: ONE `capProfile` table per backend (neutral id → { directive?,
// hostFeature? }) from whose keys `Capabilities` derives — collapsing the existing
// two-authorities pair `wgslBackend.caps` (wgsl.ts:141-143) + `WGSL_ENABLE`
// (wgsl.ts:105-108) rather than adding a third list — plus a `reflect()`
// `requiredFeatures` field on the always-present-empty-when-unused `overrides` model,
// plus the one-line fp64Lower fix that stops the rebuild dropping `enables`.
//
// CASTS — REMOVED BY THIS COMMIT. The four new ids (`floatRenderTarget` /
// `float32Blend` / `float32Filterable` / `multiview`) were not in the `Capability` union
// at 9b8253bc, so the red run recorded below spelled each through a `futureCap()`
// (`as unknown as Capability`) scaffold: the only thing that stood between "the test is
// red for the right reason" and "the test does not compile". #1670 IS this commit, the
// union now admits all four, and the scaffold is gone — every id here is a BARE LITERAL,
// which makes each call site a positive TYPE-level probe as well as a value one
// (tsconfig.tests.json type-checks this file as the second half of `bun run build`, so a
// rename that dropped an id fails the BUILD here, not merely a test). The
// `FutureReflection` widening shim is gone for the same reason:
// `Reflection.requiredFeatures` is a required field now and is read directly, with the
// `toEqual([])` assertion keeping the value-level check the shim never provided.
//
// The directive-emitting cap is asserted by SLOT + SPELLING, not by extension NAME:
// test 3 matches the token with a regex, pinning the INVARIANTS a directive-carrying cap
// must satisfy (GLSL ES 3.00 §3.4: `#extension` precedes any non-preprocessor token, so
// it is header line index 1, between `#version` and the first `precision` line, spelled
// `#extension <GL_NAME> : require`). The neutral ID is NOT free there — the arm is
// coupled to `multiview`, and only the extension STRING is left open. That string is
// pinned exactly once, in the profile-pin arm (test 9).
//
// ─────────────────────────────────────────────────────────────────────────────
// FAIL-BEFORE TRANSCRIPT (#1670)
// Recorded on the unmodified tree @ 9b8253bc (no source file touched; this test file
// is the only addition). Per test: status + the EXACT reason it lands there.
//
//  1. GLSL accepts a HOST-SIDE cap, byte-identically
//     RED. `emitGlslModule` THROWS before producing any string:
//       UnsupportedFeatureError [SD0030]
//       "backend 'glsl-es300' cannot emit this module — missing capabilities: floatRenderTarget"
//     requiredCaps folds `m.enables` in verbatim (passes/required-caps.ts:28) and
//     glslEs300Backend.caps is `new Capabilities(new Set())` (glsl.ts:269), so EVERY
//     declared cap is missing on GLSL — including the three that need no directive at
//     all because WebGL2 activates them HOST-side (getExtension).
//
//  2. WGSL accepts the same cap with NO enable directive
//     RED. Same SD0030 throw, other backend:
//       "backend 'wgsl' cannot emit this module — missing capabilities: floatRenderTarget"
//     wgsl.ts:141-143 hard-codes the five-id Set. (The no-directive half of the
//     assertion would already hold today if the gate let the module through:
//     WGSL_ENABLE (wgsl.ts:105-108) maps only f16/subgroups, and modulePreamble
//     filters out every unmapped cap — but the gate runs FIRST, in lowerForBackend
//     (emit.ts:163), so nothing reaches the preamble.)
//
//  3. GLSL emits `#extension … : require` at header line index 1
//     RED. Same SD0030 throw ("missing capabilities: multiview"). Even with the gate
//     opened, NOTHING would emit: `assembleGlsl` builds its header parts array
//     literally (glsl.ts:1210-1216 — '#version 300 es', precision float, precision
//     int, optional 'precision highp sampler2DArray;', '') and `modulePreamble` is
//     never called on the GLSL path at all. Pre-implementation header of the same
//     module WITHOUT enables, verbatim (probed at 9b8253bc):
//       0 "#version 300 es"
//       1 "precision highp float;"
//       2 "precision highp int;"
//       3 ""
//     i.e. index 1 is where the directive must land, pushing `precision highp float;`
//     to index 2.
//
//  4. reflect().requiredFeatures is always present
//     RED. `Reflection` (reflect.ts:238-254) has no such field and `reflect()`
//     returns exactly `{ bindGroups, uniforms, storage, vertex?, entries, overrides }`
//     (reflect.ts:342), so the read is `undefined`:
//       expected undefined to deeply equal ArrayContaining [ 'floatRenderTarget' ]
//     Pre-implementation reflection of the enables-free probe module, verbatim:
//       {"bindGroups":[],"uniforms":[],"storage":[],"entries":[{"name":"fs_probe",
//        "stage":"fragment","inputs":[],"output":"vec4<f32>"}],"overrides":[]}
//     Note reflect() does NOT throw on an unknown cap — it never reads `enables` —
//     so this arm is red on the MISSING FIELD, not on the gate. That is the point.
//
//  5. fp64Lower carries `enables` through the rebuild
//     RED. passes/fp64-lower.ts:1126-1127 rebuilds the module as
//       `{ consts, structs, bindings, funcs }` and re-attaches ONLY `overrides`,
//     so `enables` is dropped on every f64 module. Probed at 9b8253bc:
//       fp64Lower(m).enables === undefined   (and the returned object !== m, i.e.
//       the rebuild path really ran — `moduleUsesF64` did not short-circuit)
//     Uses the REAL current cap 'f16' on purpose: no cast, and the arm survives any
//     rename of the new ids. tsc cannot see this loss (`enables` is optional) and no
//     existing test drives an f64 module that also declares enables.
//
//  6. f16 STILL fails closed on GLSL  (GREEN-PIN)
//     GREEN today; must stay green. The single most likely #1670 regression is a
//     capProfile refactor that hands the GLSL backend a row it must not have. Pins
//     the same invariant as passes/required-caps.test.ts:95-97 and
//     backends/enable-directives.test.ts:54-56, locally, next to the new profile.
//
//  7. enables-absent vs enables:[] is byte-identical on BOTH backends  (GREEN-PIN)
//     GREEN today. `module()` attaches the key when `parts.enables` is truthy
//     (ir/builder.ts:1004), so `enables: []` IS carried — and must still contribute
//     zero bytes: requiredCaps adds nothing, WGSL modulePreamble returns '' on an
//     empty directive list (wgsl.ts:225), GLSL emits its fixed header. Guards the
//     profile refactor against an unconditional preamble/section.
//
//  8. WGSL still emits `enable f16;`  (GREEN-PIN)
//     GREEN today (the enable-directives.test.ts:33-35 behavior), duplicated here as
//     a local anchor: collapsing WGSL_ENABLE into capProfile must not lose the one
//     directive the WGSL backend already emits.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { module, fn, vec4, f32T, f64T, arrayT, type Capability, type ModuleDecl } from '../ir'
import { emitModule, wgslBackend } from './wgsl'
import { emitGlslModule, glslEs300Backend } from './glsl'
import { UnsupportedFeatureError } from '../backend'
import { reflect } from '../reflect'
import { emitModuleWithReflection } from '../emit'
import { fp64Lower } from '../passes/fp64-lower'

/** A trivial fragment module — the smallest shape that emits on BOTH backends, so the
 *  `enables` list is the only variable under test. */
const fragMod = (enables?: readonly Capability[]): ModuleDecl =>
  module({
    enables,
    funcs: [
      fn('fs_probe', {}, () => vec4(1, 0, 0, 1), { stage: 'fragment', retAttr: '@location(0)' }),
    ],
  })

const requiredFeaturesOf = (m: ModuleDecl): readonly Capability[] => reflect(m).requiredFeatures

describe('#1670 — WebGL2 extension profile surface (fail-before)', () => {
  // ── 1. RED — the host-side trio is legal on GLSL and costs zero bytes ──
  // EXT_color_buffer_float / EXT_float_blend / OES_texture_float_linear are activated
  // by the HOST (`gl.getExtension`), never by a token in the shader source. So the
  // GLSL profile must ACCEPT them and emit the module byte-identically — declaring a
  // host-side requirement must not move a single byte of the emitted source.
  it('GLSL accepts a host-side cap and emits byte-identically to the enables-free module', () => {
    const base = emitGlslModule(fragMod(), 'fragment')
    expect(emitGlslModule(fragMod(['floatRenderTarget']), 'fragment')).toBe(base)
    expect(emitGlslModule(fragMod(['float32Blend']), 'fragment')).toBe(base)
    expect(emitGlslModule(fragMod(['float32Filterable']), 'fragment')).toBe(base)
    // …and all three at once, still not one byte.
    expect(
      emitGlslModule(
        fragMod(['floatRenderTarget', 'float32Blend', 'float32Filterable']),
        'fragment',
      ),
    ).toBe(base)
    // Directly, not merely transitively via the byte-identity above (test 7 pins that
    // the enables-free baseline carries no `#extension`, but a reader should not have to
    // chain two arms to learn that a HOST-side cap emits no directive).
    expect(emitGlslModule(fragMod(['floatRenderTarget']), 'fragment')).not.toContain('#extension')
  })

  // ── 2. RED — the same trio on WGSL: accepted, and NOT an `enable` directive ──
  // On WebGPU these are core (float32-blendable / float render targets) or a device
  // FEATURE the host requests at adapter time ('float32-filterable') — none of them is
  // a WGSL `enable`-directive extension, so the WGSL emit must stay byte-identical too.
  it('WGSL accepts a host-side cap without adding an enable directive', () => {
    const base = emitModule(fragMod())
    const withCap = emitModule(fragMod(['floatRenderTarget']))
    expect(withCap).not.toContain('enable ')
    expect(withCap).toBe(base)
    expect(emitModule(fragMod(['float32Blend', 'float32Filterable']))).toBe(base)
  })

  // ── 3. RED — the `#extension` mechanism itself, on the GLSL header ──
  // GLSL ES 3.00 §3.4: an `#extension` directive must precede any non-preprocessor
  // token, so the ONLY legal slot is between `#version` (which must lead the source)
  // and the first `precision` line — parts index 1 (glsl.ts:1210-1216). Asserted as a
  // POSITION + SPELLING invariant rather than an exact extension name, because the
  // implementer may pick a different neutral id / extension than the issue's
  // `multiview` → GL_OVR_multiview2 candidate.
  it('GLSL emits `#extension <NAME> : require` at header line index 1, after #version', () => {
    const lines = emitGlslModule(fragMod(['multiview']), 'fragment').split('\n')
    expect(lines[0]).toBe('#version 300 es')
    // The mechanism: a real GL extension token, `: require` (not `: enable` — a
    // module that DECLARED the cap cannot compile without it).
    expect(lines[1]).toMatch(/^#extension GL_[A-Za-z0-9_]+ : require$/)
    // …and the precision preamble is PUSHED DOWN, not replaced.
    expect(lines[2]).toBe('precision highp float;')
    expect(lines[3]).toBe('precision highp int;')
    // Exactly one directive line for one declared cap — no duplicate, no stray header.
    expect(emitGlslModule(fragMod(['multiview']), 'fragment').match(/^#extension /gm)).toHaveLength(
      1,
    )
  })

  // ── 4. RED — reflect() exposes the requirement to the HOST ──
  // The host must know which extensions/features to activate BEFORE pipeline creation
  // (gl.getExtension / requestDevice({ requiredFeatures })). Modelled on `overrides`
  // (reflect.ts:252-253): ALWAYS present, empty array when the module needs nothing —
  // so a consumer never has to distinguish "no features" from "old reflection shape".
  it('reflect() reports requiredFeatures — present-and-populated, and present-but-EMPTY', () => {
    // arrayContaining, not toContain: a superset is fine (the field also covers the
    // DERIVED caps), and the red reads `expected undefined to deeply equal
    // ArrayContaining [...]` instead of chai's "invalid combination of arguments".
    expect(requiredFeaturesOf(fragMod(['floatRenderTarget']))).toEqual(
      expect.arrayContaining(['floatRenderTarget']),
    )
    // The always-present half — an empty ARRAY, never undefined.
    expect(requiredFeaturesOf(fragMod())).toEqual([])
    expect(requiredFeaturesOf(fragMod([]))).toEqual([])
  })

  // ── 5. RED — fp64Lower must not swallow `enables` ──
  // The pass rebuilds the module literal and re-attaches only `overrides`, so an f64
  // module's declared caps vanish. Invisible to tsc (`enables` is optional) and to
  // every emit path that reads the AUTHORED module — but any #1670 consumer deriving
  // from the LOWERED module (reflection of a lowered module, a GLSL header built
  // inside assembleGlsl, which sees ONLY the lowered module) loses them silently, on
  // f64 modules only. Uses the REAL cap 'f16' so no cast is needed here.
  it('fp64Lower carries `enables` through the f64 rebuild', () => {
    const authored = module({
      enables: ['f16'],
      funcs: [fn('k', { a: f64T, b: f64T }, (p) => p.a.add(p.b))],
    })
    const lowered = fp64Lower(authored)
    // Guard the arm's premise: the pass must NOT have short-circuited via
    // `if (!moduleUsesF64(m)) return m` — otherwise `enables` would survive trivially
    // and this test would prove nothing.
    expect(lowered).not.toBe(authored)
    expect(lowered.enables).toEqual(['f16'])
  })

  // ── 6. GREEN-PIN — f16 stays OUT of the GLSL profile ──
  it('GLSL still fails closed on f16 with SD0030 naming the cap', () => {
    expect(() => emitGlslModule(fragMod(['f16']), 'fragment')).toThrow(UnsupportedFeatureError)
    let caught: unknown
    try {
      emitGlslModule(fragMod(['f16']), 'fragment')
    } catch (e) {
      caught = e
    }
    // `.code` is the stable host-facing contract; the message must NAME the cap so a
    // profile-row deletion is diagnosable (§12 cut-the-mechanism).
    expect((caught as { code?: string }).code).toBe('SD0030')
    expect((caught as { message?: string }).message).toContain('f16')
    // …and subgroups, the other opt-in language cap, likewise.
    expect(() => emitGlslModule(fragMod(['subgroups']), 'fragment')).toThrow(
      UnsupportedFeatureError,
    )
  })

  // ── 7. GREEN-PIN — enables-free byte-neutrality on BOTH backends ──
  it('enables absent vs enables:[] emits byte-identically on WGSL and GLSL', () => {
    expect(emitModule(fragMod([]))).toBe(emitModule(fragMod()))
    expect(emitGlslModule(fragMod([]), 'fragment')).toBe(emitGlslModule(fragMod(), 'fragment'))
    // The GLSL header an extension-free module keeps, spelled out — the baseline the
    // directive of test 3 must push down rather than rewrite.
    expect(
      emitGlslModule(fragMod(), 'fragment').startsWith(
        '#version 300 es\nprecision highp float;\nprecision highp int;\n\n',
      ),
    ).toBe(true)
    expect(emitGlslModule(fragMod(), 'fragment')).not.toContain('#extension')
  })

  // ── 8. GREEN-PIN — the one directive WGSL already emits ──
  it('WGSL still emits `enable f16;` ahead of the declarations', () => {
    expect(emitModule(fragMod(['f16'])).startsWith('enable f16;\n\n')).toBe(true)
  })

  // ── 9. PROFILE PIN — both tables, row for row, value for value ──
  // Every arm above reads the profiles INDIRECTLY, through emit or reflect, and an
  // indirect read cannot see the `hostFeature` column at all: nothing in an emitted
  // string or a neutral reflection id depends on it, so 'EXT_color_buffer_float' could
  // be silently mistyped and every other arm here would stay green. Pinning the whole
  // literal closes that hole and simultaneously pins the two things the mechanism arms
  // deliberately leave open — the exact `GL_OVR_multiview2` spelling, and the ABSENCE of
  // the rows each backend must not have (WGSL multiview; GLSL storageBuffer / compute /
  // msaaTextureLoad / f16 / subgroups), since toEqual is exact.
  it('the GLSL and WGSL capProfiles are pinned row-for-row (incl. the hostFeature column)', () => {
    expect(glslEs300Backend.capProfile).toEqual({
      floatRenderTarget: { hostFeature: 'EXT_color_buffer_float' },
      float32Blend: { hostFeature: 'EXT_float_blend' },
      float32Filterable: { hostFeature: 'OES_texture_float_linear' },
      multiview: { directive: 'GL_OVR_multiview2', hostFeature: 'OVR_multiview2' },
    })
    expect(wgslBackend.capProfile).toEqual({
      storageBuffer: {},
      compute: {},
      msaaTextureLoad: {},
      f16: { directive: 'f16', hostFeature: 'shader-f16' },
      subgroups: { directive: 'subgroups', hostFeature: 'subgroups' },
      floatRenderTarget: {},
      float32Blend: { hostFeature: 'float32-blendable' },
      float32Filterable: { hostFeature: 'float32-filterable' },
    })
  })

  // ── 10. WGSL multiview fails CLOSED ──
  // The WGSL profile's missing `multiview` row is deliberate (WebGPU has no
  // OVR_multiview2), and until now that decision lived only in a comment. Half of what
  // makes the GLSL `#extension` path meaningful is that the other target REFUSES rather
  // than emitting a module the device cannot honour.
  it('WGSL fails closed on multiview, naming the cap', () => {
    expect(() => emitModule(fragMod(['multiview']))).toThrow(/multiview/)
  })

  // ── 11. GLSL directive dedupe ──
  // The sorted+deduped byte order is pinned for WGSL (enable-directives.test.ts:42-47);
  // the GLSL side had no equivalent, so a `#extension` splice that emitted one line per
  // ENTRY rather than per distinct directive would have gone unnoticed.
  it('a repeated cap emits exactly ONE #extension line', () => {
    const glsl = emitGlslModule(fragMod(['multiview', 'multiview']), 'fragment')
    // Presence FIRST, count second: `.match()` answers null when nothing matches, and
    // `toHaveLength` on null reports "Target cannot be null or undefined" — a message
    // that names neither the directive nor the row it came from. Asserting the line
    // itself first means severing the profile's `directive` field fails with the string
    // it severed (§12 — a red must name the mechanism it cut).
    expect(glsl).toContain('#extension GL_OVR_multiview2 : require')
    expect(glsl.match(/^#extension /gm) ?? []).toHaveLength(1)
  })

  // ── 12. requiredFeatures is the UNION of derived + declared, sorted ──
  // The two provenance classes meet only here: `storageBuffer` is inferred from the
  // module's SHAPE (a storage binding) and `f16` is DECLARED. A reflection that reported
  // one class only would still satisfy every other arm in this file.
  const storageF16Mod = (): ModuleDecl =>
    module({
      enables: ['f16'],
      bindings: [
        {
          group: 0,
          binding: 0,
          name: 'buf',
          space: 'storage' as const,
          access: 'read' as const,
          type: arrayT(f32T),
        },
      ],
      funcs: [fn('k', { x: f32T }, f32T, (p, b) => b.ret(p.x.mul(2)))],
    })

  it('reflect() unions the DERIVED and DECLARED caps, sorted', () => {
    expect(requiredFeaturesOf(storageF16Mod())).toEqual(['f16', 'storageBuffer'])
  })

  // ── 13. a cap's IMPLIED dependency rides along ──
  // float32Blend ⇒ floatRenderTarget, because blending INTO a float target needs that
  // target to be color-renderable first — this repo's own WebGL2 device ANDs
  // EXT_color_buffer_float with EXT_float_blend before enabling either
  // (rhi-webgl2/src/rhi-webgl2.ts ~:668-676), and without the former the FBO comes back
  // INCOMPLETE. A host activating off requiredFeatures must get BOTH from declaring one.
  it('declaring float32Blend also requires floatRenderTarget', () => {
    expect(requiredFeaturesOf(fragMod(['float32Blend']))).toEqual([
      'float32Blend',
      'floatRenderTarget',
    ])
  })

  // ── 14. the exact consumer the fp64 `enables` fix protects ──
  // Test 5 pins the pass; THIS pins the thing that pass exists for. emitModuleWithReflection
  // reflects the LOWERED module, so before the fix an f64 module's declared caps were
  // gone from `requiredFeatures` — while the emitted code, derived from the AUTHORED
  // module, still carried `enable f16;`. That split (code says the module needs it, the
  // reflection the host reads says it does not) is precisely the silent failure.
  it('an f64 module keeps its declared cap in BOTH halves of emitModuleWithReflection', () => {
    const m = module({
      enables: ['f16'],
      funcs: [fn('k', { a: f64T, b: f64T }, (p) => p.a.add(p.b))],
    })
    const { code, reflection } = emitModuleWithReflection(m, wgslBackend)
    expect(reflection.requiredFeatures).toContain('f16')
    expect(code.startsWith('enable f16;')).toBe(true)
  })

  // ── 15. TYPE negatives — the union rejects the near-miss spellings ──
  // Never executed; `tsc -p shader-dsl/tsconfig.tests.json` (the second half of
  // `bun run build`) validates each `@ts-expect-error`, which PASSES only if the line
  // below it is genuinely a type error. The two typo classes a neutral-id vocabulary
  // actually attracts: wrong CASE, and a plausible-but-wrong camelCase hump.
  it('a mis-spelled cap id is a COMPILE error, not a silent no-op', () => {
    module({
      funcs: [],
      // @ts-expect-error — all-lowercase: 'floatrendertarget' is not 'floatRenderTarget'.
      enables: ['floatrendertarget'],
    })
    module({
      funcs: [],
      // @ts-expect-error — wrong hump: 'multiView' is not 'multiview'.
      enables: ['multiView'],
    })
  })

  // ── 16. DOC-SYNC RATCHET — AUTHORING.md §10 vs the profiles ──
  // The §10 table is the only place an author learns which id costs what, and a table is
  // exactly the artifact that rots: adding a profile row is a code change no doc gate
  // sees. This asserts the doc MENTIONS every capability id and every concrete
  // directive/hostFeature string both profiles carry — presence, not layout, so
  // rewording the prose is free while dropping a row is not.
  //
  // §12 (path-keyed gates die silently when the thing they key on moves): the section
  // header is asserted to EXIST first, so renaming '## 10.' fails loudly here instead of
  // leaving the arm vacuously green over an empty slice.
  const AUTHORING = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../AUTHORING.md'),
    'utf8',
  )
  const ALL_CAPS: readonly Capability[] = [
    'storageBuffer',
    'compute',
    'msaaTextureLoad',
    'f16',
    'subgroups',
    'floatRenderTarget',
    'float32Blend',
    'float32Filterable',
    'multiview',
  ]

  it('AUTHORING.md §10 names every capability id and every profile string', () => {
    const start = AUTHORING.indexOf('\n## 10.')
    expect(
      start,
      "AUTHORING.md has no '## 10.' section — the ratchet lost its anchor",
    ).toBeGreaterThan(-1)
    const rest = AUTHORING.slice(start + 1)
    const end = rest.indexOf('\n## ')
    const section = end === -1 ? rest : rest.slice(0, end)
    // Non-empty by construction, but assert it: an empty slice would pass nothing below.
    expect(section.length).toBeGreaterThan(200)

    for (const cap of ALL_CAPS) expect(section, `§10 never mentions '${cap}'`).toContain(cap)

    // Both halves of every row in BOTH profiles — the host-activation strings included,
    // which is the half AUTHORING.md's one-per-cell vocabulary used to delete.
    for (const be of [glslEs300Backend, wgslBackend]) {
      for (const [cap, row] of Object.entries(be.capProfile)) {
        for (const s of [row?.directive, row?.hostFeature]) {
          if (s === undefined) continue
          expect(section, `§10 never mentions '${s}' (${be.id} ${cap})`).toContain(s)
        }
      }
    }
  })
})
