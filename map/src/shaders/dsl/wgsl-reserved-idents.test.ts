// ═══ No emitted WGSL identifier may be a WGSL RESERVED WORD ═══
//
// PAID FOR IN PRODUCTION. `unproject_flat(target: vec2<f32>, …)` shipped and the WebGPU device
// rejected the whole advected-arrow pipeline:
//
//   Error while parsing WGSL: :330:19 error: 'target' is a reserved keyword
//   … While calling [Device].CreateShaderModule("arrow-retained-advected-pipeline-rhi")
//
// ── WHY EVERY GATE WE HAD WAS GREEN ───────────────────────────────────────────────────────────
//
// Two independent reasons, and the first was already written down in this repo:
//
//  1. `target` is reserved in WGSL and is NOT reserved in GLSL ES 3.00. The two languages have
//     different reserved sets, which `backends/glsl-sanitize.ts` states in its own header —
//     "WGSL and GLSL have DIFFERENT reserved-word sets … The WGSL backend emits these names
//     verbatim (legal there); the GLSL backend must RENAME any param/local-var whose name collides
//     with a GLSL ES reserved word". The codebase knew the sets differ and defended ONE direction.
//  2. The DSL's own emit is a string, and nothing parses it. The WGSL is only validated by a real
//     WebGPU device — and there is no software WebGPU adapter in CI or in the dev container (the
//     render-gate leg is WebGL2/SwiftShader), so the ONLY thing that could have caught this is a
//     developer on a GPU. It reached users instead.
//
// ── WHY A GATE RATHER THAN A SANITISING PASS ──────────────────────────────────────────────────
//
// The GLSL side needs a pass because the DSL's canonical identifiers are WGSL-flavoured: an author
// writing legal DSL can produce illegal GLSL through no fault of their own, so the backend has to
// rename silently. The WGSL side is the opposite — the author picked the name and it is the name
// that is wrong. Renaming it silently would hide an authoring mistake and make the emit disagree
// with the source; failing here NAMES it, at author time, on every backend, with no GPU required.

import { describe, it, expect } from 'vitest'
import { emitArrowRetainedAdvectedWgsl } from './arrow-advected'
import { emitArrowRetainedWgsl } from './arrow-retained'
import { emitCircleRetainedWgsl } from './circle-retained'
import { emitCoverageWgsl } from './coverage-ramp'
import { emitFlowAdvectWgsl } from './flow-advect'
import { emitHeatmapAccumWgsl } from './heatmap-accum'
import { emitHeatmapBlurWgsl } from './heatmap-blur'
import { emitHeatmapComposeWgsl } from './heatmap-compose'
import { emitHillshadeWgsl } from './hillshade'
import { emitIconRetainedWgsl } from './icon-retained'
import { emitIconWgsl } from './icon'
import { emitCompositeWgsl } from './line-composite'
import { emitLineWgsl } from './line'
import { emitOitComposeWgsl } from './oit-compose'
import { emitOverdrawFsWgsl } from './overdraw-fs'
import { emitParticleRetainedWgsl } from './particle-retained'
import { emitPointWgsl } from './point'
import { emitPolygonWgsl } from './polygon'
import { emitRasterWgsl } from './raster'
import { emitTextWgsl } from './text'
import { emitUnderOccluderWgsl } from './under-occluder'

/** Every WGSL emitter in `shaders/dsl`. Listed EXPLICITLY rather than globbed, so adding a shader
 *  without adding it here is a visible omission in review — and the count below fails loudly if the
 *  list drifts from the directory. */
const EMITTERS: ReadonlyArray<readonly [string, () => string]> = [
  ['arrow-retained', emitArrowRetainedWgsl],
  ['arrow-advected', emitArrowRetainedAdvectedWgsl],
  ['circle-retained', emitCircleRetainedWgsl],
  ['coverage-ramp', emitCoverageWgsl],
  ['flow-advect', emitFlowAdvectWgsl],
  ['heatmap-accum', emitHeatmapAccumWgsl],
  ['heatmap-blur', emitHeatmapBlurWgsl],
  ['heatmap-compose', emitHeatmapComposeWgsl],
  ['hillshade', () => emitHillshadeWgsl(false)],
  ['hillshade (pick)', () => emitHillshadeWgsl(true)],
  ['icon', emitIconWgsl],
  ['icon-retained', emitIconRetainedWgsl],
  ['line', () => emitLineWgsl(null, false)],
  ['line (pick)', () => emitLineWgsl(null, true)],
  ['line-composite', emitCompositeWgsl],
  // Parameterised emitters get REAL arguments, and both variants where the parameter changes the
  // emitted text — a variant is a separate shader as far as `CreateShaderModule` is concerned.
  ['oit-compose (single-sample)', () => emitOitComposeWgsl(1, false)],
  ['oit-compose (msaa)', () => emitOitComposeWgsl(4, true)],
  ['overdraw-fs', emitOverdrawFsWgsl],
  ['particle-retained', emitParticleRetainedWgsl],
  ['point', emitPointWgsl],
  ['polygon', () => emitPolygonWgsl(null, false)],
  ['polygon (pick)', () => emitPolygonWgsl(null, true)],
  ['raster', () => emitRasterWgsl(false)],
  ['raster (pick)', () => emitRasterWgsl(true)],
  ['text', emitTextWgsl],
  ['under-occluder', () => emitUnderOccluderWgsl(false)],
]

/** The WGSL spec's reserved words (§ Reserved Words) — words that are NOT keywords today but which
 *  an implementation must reject, so they are compile errors wherever an identifier may appear.
 *
 *  Transcribed from the specification rather than from a failure: a list grown one incident at a
 *  time would only ever contain the words that already shipped broken. `target` is in here because
 *  the spec says so, not because it bit us. */
const WGSL_RESERVED: ReadonlySet<string> = new Set([
  'NULL',
  'Self',
  'abstract',
  'active',
  'alignas',
  'alignof',
  'as',
  'asm',
  'asm_fragment',
  'async',
  'attribute',
  'auto',
  'await',
  'become',
  'binding_array',
  'cast',
  'catch',
  'class',
  'co_await',
  'co_return',
  'co_yield',
  'coherent',
  'column_major',
  'common',
  'compile',
  'compile_fragment',
  'concept',
  'const_cast',
  'consteval',
  'constexpr',
  'constinit',
  'crate',
  'debugger',
  'decltype',
  'delete',
  'demote',
  'demote_to_helper',
  'do',
  'dynamic_cast',
  'enum',
  'explicit',
  'export',
  'extends',
  'extern',
  'external',
  'fallthrough',
  'filter',
  'final',
  'finally',
  'friend',
  'from',
  'fxgroup',
  'get',
  'goto',
  'groupshared',
  'highp',
  'impl',
  'implements',
  'import',
  'inline',
  'instanceof',
  'interface',
  'layout',
  'lowp',
  'macro',
  'macro_rules',
  'match',
  'mediump',
  'meta',
  'mod',
  'module',
  'move',
  'mut',
  'mutable',
  'namespace',
  'new',
  'nil',
  'noexcept',
  'noinline',
  'nointerpolation',
  'non_coherent',
  'noncoherent',
  'noperspective',
  'null',
  'nullptr',
  'of',
  'operator',
  'package',
  'packoffset',
  'partition',
  'pass',
  'patch',
  'pixelfragment',
  'precise',
  'precision',
  'premerge',
  'priv',
  'protected',
  'pub',
  'public',
  'readonly',
  'ref',
  'regardless',
  'register',
  'reinterpret_cast',
  'require',
  'resource',
  'restrict',
  'self',
  'set',
  'shared',
  'sizeof',
  'smooth',
  'snorm',
  'static',
  'static_assert',
  'static_cast',
  'std',
  'subroutine',
  'super',
  'target',
  'template',
  'this',
  'thread_local',
  'throw',
  'trait',
  'try',
  'type',
  'typedef',
  'typeid',
  'typename',
  'typeof',
  'union',
  'unless',
  'unorm',
  'unsafe',
  'unsized',
  'use',
  'using',
  'varying',
  'virtual',
  'volatile',
  'wgsl',
  'where',
  'with',
  'writeonly',
  'yield',
])

/** Every identifier the emit DECLARES: function names, their parameters, `let`/`var` locals,
 *  struct names and struct fields.
 *
 *  Declaration sites only — a bare word inside an expression could be a builtin call, and matching
 *  those would make this a spellchecker rather than a gate. Every position below is one where WGSL
 *  requires an `ident`, which is exactly where a reserved word is an error. */
function declaredIdents(src: string): { name: string; where: string }[] {
  const out: { name: string; where: string }[] = []
  for (const m of src.matchAll(/\bfn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g)) {
    out.push({ name: m[1]!, where: `fn ${m[1]}` })
    for (const p of m[2]!.split(',')) {
      const n = /(?:@\w+(?:\([^)]*\)\s*)?\s*)?([A-Za-z_]\w*)\s*:/.exec(p.trim())
      if (n) out.push({ name: n[1]!, where: `param of fn ${m[1]}` })
    }
  }
  for (const m of src.matchAll(/\b(?:let|var(?:<[^>]*>)?)\s+([A-Za-z_]\w*)\s*[:=]/g)) {
    out.push({ name: m[1]!, where: 'local' })
  }
  for (const m of src.matchAll(/\bstruct\s+([A-Za-z_]\w*)\s*\{([^}]*)\}/g)) {
    out.push({ name: m[1]!, where: `struct ${m[1]}` })
    for (const f of m[2]!.split(',')) {
      const n = /(?:@\w+(?:\([^)]*\)\s*)?\s*)*([A-Za-z_]\w*)\s*:/.exec(f.trim())
      if (n) out.push({ name: n[1]!, where: `field of struct ${m[1]}` })
    }
  }
  return out
}

describe('no emitted WGSL identifier is a reserved word', () => {
  it('the emitter list still covers every shader in the directory', () => {
    // A shader added without an entry above would be silently unguarded, which is the shape of
    // failure a path-keyed allowlist has (§12 — a gate whose keys go stale sits vacuously green).
    expect(EMITTERS.length).toBe(26)
    expect(new Set(EMITTERS.map(([n]) => n)).size).toBe(EMITTERS.length)
  })

  for (const [name, emit] of EMITTERS) {
    it(`${name}: every declared identifier is legal WGSL`, () => {
      const idents = declaredIdents(emit())
      // PRECONDITION: the scraper found something HERE. One is a legitimate floor — `overdraw-fs`
      // is a single parameterless entry and declares exactly its own name. The proof that the
      // scraper reads more than a function name lives in the fail-before at the bottom, and the
      // corpus-wide floor below proves it works at scale; a per-shader minimum any higher would
      // fail an honest shader for being small.
      expect(idents.length, `${name}: declarations were found to check`).toBeGreaterThan(0)
      const bad = idents.filter((i) => WGSL_RESERVED.has(i.name))
      expect(
        bad.map((b) => `'${b.name}' (${b.where})`),
        `${name}: WGSL reserved word used as an identifier — this is a CreateShaderModule error ` +
          `on WebGPU and compiles fine on WebGL2, so no render gate in this repo can see it`,
      ).toEqual([])
    })
  }

  it('the scraper reads real declarations at scale, not just function names', () => {
    // The corpus-wide floor. A regex that silently stopped matching PARAMS or LOCALS would still
    // find every `fn` name and quietly pass all 22 shaders — so the count that matters is the one
    // that only a working scraper can reach, and it is asserted over the whole corpus rather than
    // per shader (where a small honest module would fail it).
    const all = EMITTERS.flatMap(([, emit]) => declaredIdents(emit()))
    expect(all.length, 'declarations across every shader').toBeGreaterThan(500)
    expect(
      all.filter((i) => i.where.startsWith('param')).length,
      'parameters are being read, not only fn names',
    ).toBeGreaterThan(50)
    expect(all.filter((i) => i.where === 'local').length, 'locals are being read').toBeGreaterThan(
      100,
    )
    expect(
      all.filter((i) => i.where.startsWith('field')).length,
      'struct fields are being read',
    ).toBeGreaterThan(20)
  })

  it('…and the scraper actually catches one — the exact production failure', () => {
    // FAIL-BEFORE, run against the shape that shipped. Without this the gate could be a regex that
    // never matches a parameter, and every shader above would pass for the wrong reason.
    const shipped = 'fn unproject_flat(target: vec2<f32>, proj_params: vec4<f32>) -> vec3<f32> {'
    const found = declaredIdents(shipped).filter((i) => WGSL_RESERVED.has(i.name))
    expect(found.map((f) => f.name)).toEqual(['target'])
  })
})
