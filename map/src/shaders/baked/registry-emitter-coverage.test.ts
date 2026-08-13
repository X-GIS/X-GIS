// ═══ Baked registry — EMITTER COVERAGE ratchet (#1678 follow-up of #1484) ═══
//
// `baked-sync.test.ts` proves the committed artifacts equal the REGISTRY. Nothing
// proved the registry equals the EMITTERS. That gap is ceiling-dark by construction:
// a family added in 2027 that nobody lists in `BAKED_SHADER_KEYS` is simply never
// baked, and the only symptom is a boot that quietly pays a runtime emit — an id the
// artifact does not carry falls back to the emitter, which is precisely the behaviour
// the bake is an optimisation over. Nothing goes red. This file closes that hole:
// every shader-emitting export of `map/src/shaders/dsl/**` must be COVERED (mapped
// onto a family the closed set actually bakes), a SPELLING TWIN of one, or
// ALLOWLISTED with the reason written down HERE, as data.
//
// It is the #996 class the repo has now paid for twice (path-keyed ratchets that sat
// vacuously green after an extraction), one level up: not "does the gate still see its
// files" but "does the closed set still see the open world".
//
// ── ENUMERATION: the dsl DIRECTORY, not `dsl/index.ts` ──
//
// index.ts is the barrel for consumers OUTSIDE dsl/, and it is a strict SUBSET of the
// emitters: it re-exports 20 modules and omits `arrow-advected`, `flow-advect`,
// `scene-upscale`, `under-occluder`, `oit-compose`, `overdraw-fs` and
// `coverage-filter`. Four of those seven are families `registry.ts` imports by relative
// path precisely BECAUSE the barrel does not carry them. Enumerating from index.ts
// would leave this gate blind to the exact modules the registry had to reach past it
// for. So the authority is the directory's own source: every non-test `.ts` under
// `map/src/shaders/dsl/`, scanned for its exported names.
//
// ── WHAT COUNTS AS A SHADER-EMITTING EXPORT ──
//
// Two name shapes, matched on the EXPORTED identifier:
//   • `emit…Wgsl` / `emit…Glsl` / `emit…GlslStages` — produces a complete, addressable
//     shader source. That is what a baked key stores.
//   • `…Module` — `build…Module(args)` plus the two module CONSTANTS (`compositeModule`,
//     `sceneUpscaleModule`). A module is the authority an emitter is derived from, so a
//     new one is a new bakeable surface even before its emitter exists.
//
// Deliberately NOT counted: the fragment-level string exports (`ECEF_WGSL_CONSTS`,
// `LOG_DEPTH_WGSL_FNS`, `DEQUANT_ECEF_WGSL`, `getProjectionWgsl*`). Those are not
// addressable sources — they are spliced INTO the modules above, so a change to one
// moves a covered module's bytes and `baked-sync.test.ts` fails on the drift. Tracking
// them here would watch the same risk twice under a worse name.
//
// ── GRANULARITY: family, not argument ──
//
// This gate is SYMBOL → FAMILY. It cannot say which ARGUMENTS a draper passes, so it
// does not try: `emitPolygonWgsl` counts as covered because the registry bakes the
// polygon family (its null-variant rows), even though a style-derived
// `PolygonVariantSpec` call is still runtime-emitted. Which argument tuples belong in
// the closed set is the key-SHAPE question phase B (#1679) answers, and it stays
// documented on `BakedShaderKey.id`, where the shape lives. What this gate adds is the
// property that shape question presupposes: that no emitter is missing from the
// conversation entirely.
//
// ── NO EMIT IS EVER CALLED ──
//
// The gate reads NAMES (from source) and FAMILY TOKENS (from `BAKED_SHADER_KEYS`),
// never a shader string, so it needs none of the configure-before-emit setup
// `baked-sync.test.ts` performs, and the optimizer can never slow it down.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BAKED_SHADER_KEYS } from './registry'

const HERE = dirname(fileURLToPath(import.meta.url))
const DSL_DIR = join(HERE, '..', 'dsl')
const REPO_ROOT = join(HERE, '..', '..', '..', '..')

/** The two tracked name shapes (see the header). Anchored, so `emitForFixture` (the
 *  polygon fixture composer), `hillshadeU` and `DEQUANT_ECEF_WGSL` are not swept in. */
const TRACKED_NAME = /^(?:emit[A-Za-z0-9_$]*(?:Wgsl|Glsl|GlslStages)|[A-Za-z0-9_$]*Module)$/

/** `export const|function|class|let NAME` at statement position. */
const DIRECT_EXPORT = /^export\s+(?:async\s+)?(?:const|function|class|let)\s+([A-Za-z0-9_$]+)/gm
/** `export { A, B as C }` — the BOUND name is what a consumer imports, so `as C` wins. */
const BRACE_EXPORT = /^export\s*\{([^}]*)\}/gm

function dslSourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
        out.push(p)
    }
  }
  walk(DSL_DIR)
  return out.sort()
}

/** Every exported identifier of `src` that matches a tracked name shape. */
function trackedExportsOf(src: string): string[] {
  const names: string[] = []
  for (const m of src.matchAll(DIRECT_EXPORT)) names.push(m[1])
  for (const m of src.matchAll(BRACE_EXPORT))
    for (const clause of m[1].split(',')) {
      const parts = clause.trim().split(/\s+as\s+/)
      const bound = parts[parts.length - 1]?.trim()
      if (bound) names.push(bound)
    }
  return names.filter((n) => TRACKED_NAME.test(n))
}

/** symbol → the file it is exported from (repo-relative), for the failure messages. */
function scanDsl(): Map<string, string> {
  const found = new Map<string, string>()
  for (const abs of dslSourceFiles()) {
    const rel = relative(REPO_ROOT, abs).split('\\').join('/')
    for (const name of trackedExportsOf(readFileSync(abs, 'utf8'))) found.set(name, rel)
  }
  return found
}

// ── The mapping: emitter → the registry FAMILY that bakes it ──
//
// A family token is a `BakedShaderKey.family` value, and it is what makes this table
// survive phase B: whatever key SHAPE the closed set grows (options, entries, variant
// tokens), the family token is the thing that says "this emitter's output is in the
// artifact". Several symbols legitimately share a family — a WGSL emitter, its GLSL
// twin and the module they are derived from are one bakeable surface.
const COVERED_BY: Readonly<Record<string, string>> = {
  emitArrowRetainedAdvectedWgsl: 'arrow-retained-advected',
  emitArrowRetainedAdvectedGlsl: 'arrow-retained-advected',
  buildArrowRetainedAdvectedModule: 'arrow-retained-advected',
  emitArrowRetainedWgsl: 'arrow-retained',
  emitArrowRetainedGlsl: 'arrow-retained',
  buildArrowRetainedModule: 'arrow-retained',
  emitCircleRetainedWgsl: 'circle-retained',
  emitCircleRetainedGlsl: 'circle-retained',
  buildCircleRetainedModule: 'circle-retained',
  emitFlowAdvectWgsl: 'flow-advect',
  emitFlowAdvectGlsl: 'flow-advect',
  emitHeatmapAccumWgsl: 'heatmap-accum',
  emitHeatmapAccumGlsl: 'heatmap-accum',
  buildHeatmapAccumModule: 'heatmap-accum',
  emitHeatmapBlurWgsl: 'heatmap-blur',
  emitHeatmapBlurGlsl: 'heatmap-blur',
  emitHeatmapComposeWgsl: 'heatmap-compose',
  emitHeatmapComposeGlsl: 'heatmap-compose',
  // hillshade is baked THROUGH `emitFor` (registry.ts's "EMITTER CHOICE" note — the emit
  // pool's one dispatch is the hillshade draper's call site), and `emitFor` calls exactly
  // these two. The family token is what ties them to the artifact; the route there is an
  // implementation detail of the registry row.
  emitHillshadeWgsl: 'hillshade',
  buildHillshadeModule: 'hillshade',
  emitIconRetainedWgsl: 'icon-retained',
  emitIconRetainedGlsl: 'icon-retained',
  buildIconRetainedModule: 'icon-retained',
  emitIconWgsl: 'icon',
  emitIconGlsl: 'icon',
  emitCompositeWgsl: 'line-composite',
  emitCompositeGlsl: 'line-composite',
  compositeModule: 'line-composite',
  emitLineWgsl: 'line',
  emitLineGlsl: 'line',
  buildLineModule: 'line',
  emitParticleRetainedWgsl: 'particle-retained',
  emitParticleRetainedGlsl: 'particle-retained',
  buildParticleRetainedModule: 'particle-retained',
  emitPointWgsl: 'point',
  emitPointGlsl: 'point',
  buildPointModule: 'point',
  emitPolygonWgsl: 'polygon',
  emitPolygonGlsl: 'polygon',
  buildPolygonModule: 'polygon',
  emitRasterWgsl: 'raster',
  buildRasterModule: 'raster',
  emitSceneUpscaleWgsl: 'scene-upscale',
  emitSceneUpscaleGlsl: 'scene-upscale',
  sceneUpscaleModule: 'scene-upscale',
  emitTextWgsl: 'text',
  emitTextGlsl: 'text',
  emitUnderOccluderWgsl: 'under-occluder',
  buildUnderOccluderModule: 'under-occluder',
}

// ── The SPELLING-TWIN rule (derived, not listed) ──
//
// `emit<X>GlslStages` returns both GLSL stages from one lowering; `emit<X>Glsl` returns
// one. They are two spellings of the SAME family's source, pinned byte-identical by
// `map/src/render/material/glsl-stage-entry-parity.test.ts`. The registry stores one id
// per source, so it spells whichever form its draper spells, and the other form is then
// an alternative spelling of bytes the artifact already carries — not an uncovered
// surface.
//
// A RULE rather than a dozen allowlist rows, on purpose. A list would need editing every
// time a family gains its stages twin (three arrived while this gate was being written),
// and a list that must be hand-synced is the drift this file exists to stop. The rule is
// also STRICTER than a list: a twin is excused only if a sibling under the same base name
// is genuinely in COVERED_BY, so a stages emitter for an UN-BAKED family is not waved
// through — it fails like any other uncovered emitter.
function twinFamilyOf(sym: string, covered: ReadonlyMap<string, string>): string | undefined {
  if (!sym.startsWith('emit') || !sym.endsWith('GlslStages')) return undefined
  const base = sym.slice(0, -'GlslStages'.length)
  return covered.get(`${base}Glsl`) ?? covered.get(`${base}Wgsl`)
}

// ── The exclusions, as DATA ──
//
// Each of these was prose in `registry.ts`'s header ("`buildCoverageModule` takes a
// `CoverageFilterFn`", "anything the open set owns"). Prose in another file cannot fail;
// a key with its reason beside it can. The reason IS the value — an entry without one is
// not reviewable, and this list is the only place a "no" about baking is recorded.
const ALLOWLIST: Readonly<Record<string, string>> = {
  // ── The OPEN set: bytes derived from runtime style data ──
  // The coverage ramp takes a `CoverageFilterFn` compiled from the layer's style
  // expression, so its source is a function of data that does not exist at build time.
  // This is the boundary the closed set is DEFINED by, not an omission — baking it would
  // mean enumerating every filter a style could express.
  buildCoverageModule: 'open set — parameterised by a CoverageFilterFn compiled from the style',
  emitCoverageWgsl: 'open set — same CoverageFilterFn parameter as buildCoverageModule',
  coverageFilterModule:
    'open set — wraps the compiled style predicate itself (dsl/coverage-filter.ts)',

  // ── Finite, but not a draper's UNCONDITIONAL build (what BAKED_SHADER_KEYS enumerates) ──
  emitOitComposeWgsl:
    'parameterised by (sampleCount, isMsaa) resolved from the live target at pipeline-build ' +
    'time (render/compose-pipelines.ts), not a call-site constant — a phase-B (#1679) keying ' +
    'candidate, not a phase-A omission',
  emitOverdrawFsWgsl:
    'debug-only fullscreen fragment pass (debug-flags.ts OVERDRAW_FS_SOURCE) — a ~20-line ' +
    'module with no projection graph spliced in, so it is not on the first-frame path the ' +
    'bake exists to shorten and baking it would grow the artifact for no boot win',
}

describe('baked registry — every dsl emitter is baked or allowlisted (#1678 follow-up)', () => {
  const found = scanDsl()
  const covered = new Map(Object.entries(COVERED_BY))
  const families = new Set(BAKED_SHADER_KEYS.map((k) => k.family))

  // #996 — a source-scan gate whose walk or matcher silently sees nothing passes over an
  // empty set. Probe all three moving parts: the walk reached the tree; the matcher
  // accepts the emitters this whole change exists for AND rejects names that merely look
  // close; the derived twin rule DISTINGUISHES a real twin from a fabricated one.
  it('scanner sanity — the emitters the bake exists for are seen (not vacuous — #996)', () => {
    expect(dslSourceFiles().length).toBeGreaterThan(20)
    for (const sym of [
      'emitHillshadeWgsl', // the one family phase A actually seeds
      'buildHillshadeModule', // …and the module `emitFor` derives it from
      'emitPolygonGlsl', // a variant-carrying family, reached via a stage argument
      'emitUnderOccluderWgsl', // a family `dsl/index.ts` does NOT re-export
      'coverageFilterModule', // a `…Module` export that is not a `build…Module`
      'emitPolygonGlslStages', // the shape the twin rule exists for
    ])
      expect(
        found.has(sym),
        `${sym} is exported by map/src/shaders/dsl but the scan missed it — the walk, the ` +
          `export regexes or TRACKED_NAME broke, and every arm below is passing over a hole`,
      ).toBe(true)

    expect(trackedExportsOf('export function emitForFixture(fx: Fixture): string {}')).toEqual([])
    expect(trackedExportsOf('export const DEQUANT_ECEF_WGSL = emitFunc(fn)')).toEqual([])
    expect(trackedExportsOf('export { HS as hillshadeU }')).toEqual([])
    expect(trackedExportsOf('export const emitFooWgsl = () => ""')).toEqual(['emitFooWgsl'])
    expect(trackedExportsOf('export { emitBarGlsl as emitBazGlsl }')).toEqual(['emitBazGlsl'])

    expect(twinFamilyOf('emitPolygonGlslStages', covered)).toBe('polygon')
    expect(twinFamilyOf('emitNeverHeardOfItGlslStages', covered)).toBeUndefined()
    expect(twinFamilyOf('emitPolygonGlsl', covered)).toBeUndefined()
  })

  it('every shader-emitting dsl export is covered by BAKED_SHADER_KEYS or allowlisted', () => {
    const violations: string[] = []
    for (const [sym, file] of [...found].sort()) {
      const isCovered = covered.has(sym)
      const isTwin = twinFamilyOf(sym, covered) !== undefined
      const isAllowed = sym in ALLOWLIST

      if (isCovered && isAllowed)
        violations.push(
          `${sym} (${file}): claimed by BOTH COVERED_BY and ALLOWLIST — one authority per ` +
            `symbol; delete whichever is wrong`,
        )
      else if (!isCovered && !isTwin && !isAllowed)
        violations.push(
          `${sym} (${file}): emits a shader but is neither baked nor allowlisted — add a ` +
            `registry key for its family (registry.ts's buildKeys), map '${sym}' in COVERED_BY, ` +
            `and re-bake. If it genuinely cannot be baked (style-derived inputs, or a spelling ` +
            `twin of an emitter whose family is NOT in the closed set), add '${sym}' to ` +
            `ALLOWLIST here WITH the reason inline`,
        )
    }
    expect(
      violations,
      `map/src/shaders/dsl holds shader emitters the closed set does not account for. An ` +
        `un-keyed family is invisible by design — a missing id just falls back to a runtime ` +
        `emit, so no other gate in the repo can see this:\n${violations.join('\n')}`,
    ).toEqual([])
  })

  it('every family COVERED_BY names is really in BAKED_SHADER_KEYS', () => {
    const orphans = [...covered]
      .filter(([, family]) => !families.has(family))
      .map(
        ([sym, family]) =>
          `${sym} → '${family}': BAKED_SHADER_KEYS carries no key with that family. Either the ` +
          `family was dropped from the closed set — then ${sym} is UNBAKED, so restore the keys ` +
          `or move it to ALLOWLIST with the reason — or the token was renamed and this value ` +
          `must follow it`,
      )
    expect(
      orphans,
      `COVERED_BY claims coverage the registry does not provide:\n${orphans.join('\n')}`,
    ).toEqual([])
  })

  it('every baked family is named by at least one dsl emitter', () => {
    const named = new Set(covered.values())
    const unmapped = [...families]
      .filter((f) => !named.has(f))
      .sort()
      .map(
        (f) =>
          `'${f}' is baked but no dsl export maps to it — add that emitter's COVERED_BY entry so ` +
          `a later change to it is still watched here. If the family is emitted from outside ` +
          `map/src/shaders/dsl, this gate's enumeration needs widening to reach it`,
      )
    expect(unmapped, `baked families with no emitter mapped:\n${unmapped.join('\n')}`).toEqual([])
  })

  it('COVERED_BY and ALLOWLIST only shrink (a stale entry is the #996 failure mode)', () => {
    const stale = [
      ...Object.keys(COVERED_BY).map((s) => [s, 'COVERED_BY'] as const),
      ...Object.keys(ALLOWLIST).map((s) => [s, 'ALLOWLIST'] as const),
    ]
      .filter(([sym]) => !found.has(sym))
      .map(
        ([sym, where]) =>
          `${sym}: listed in ${where} but map/src/shaders/dsl no longer exports it — DELETE the ` +
          `entry in this same commit. A key-by-name list that outlives its symbols is exactly ` +
          `how a gate goes vacuously green (#996)`,
      )
    expect(stale, `stale coverage entries:\n${stale.join('\n')}`).toEqual([])
  })
})
