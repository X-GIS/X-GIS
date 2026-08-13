// ═══ Baked shaders — the CLOSED SET key list (#1678 phase A of #1484) ═══
//
// Every shader a draper builds UNCONDITIONALLY — i.e. whose parameters are known
// without any runtime style / feature data — enumerated once, as data. This file is
// the ONE authority: the generator (map/scripts/bake-shaders.ts) walks it to produce
// the committed artifacts, the sync gate (baked-sync.test.ts) walks it to prove the
// artifacts still equal a live emit, and the consume half looks a source up by `id`.
// A shader that is NOT here is not baked — the variant-carrying polygon / line /
// point emits (PolygonVariantSpec, LineVariantSpec, PointVariantSpec) and the
// coverage ramp (buildCoverageModule takes a CoverageFilterFn) stay runtime-emitted
// by construction, because their inputs are style-derived.
//
// WHY a key list rather than "walk the dsl directory": the closed set is a property
// of the CALL SITES, not of the emitters. `emitLineGlsl` can spell four stages and
// two pick states; which of those a draper actually asks for is what makes the set
// closed, and only an explicit list can state it. Growth is therefore a reviewed
// diff here, never an accident.
//
// EMITTER CHOICE — each `emit()` calls the SAME thing the draper calls, so the baked
// bytes are the bytes the pipeline would have compiled. For hillshade that is not a dsl
// emitter at all but `emitFor` (the emit pool's one dispatch), and for raster it is
// `emitGlslStages` rather than the per-stage form, because that is what those two call
// sites spell. Where a family ships both a per-stage and a both-stages emitter and its
// draper uses the both-stages one (`emitPolygonGlslStages`, `emitIconGlslStages`, …),
// the per-stage form is used because one id == one source; those two forms are pinned
// byte-identical by `map/src/render/material/glsl-stage-entry-parity.test.ts`, so that
// substitution — and ONLY that one — is free.
//
// EMIT OPTIONS — no call site in map/src passes `GlslEmitOptions` / `EmitOptions`
// today (surveyed at 13394b71: every `emitGlslModule` / `emitGlslStages` /
// `emitModule` call in map/src is one- or two-arg). The registry therefore carries
// NO options dimension. If a draper ever starts passing one, the options become part
// of the key and this list grows a field — the sync gate goes red first, because the
// live emit will no longer match the baked bytes.
//
// BODY / PROJECTION DEPENDENCE — the emitted sources embed EARTH_R / EARTH_E2 /
// WGS84_A / WGS84_E2 as literals and splice in the host-injected projection graph, so
// a bake is only valid for the body + projection table it was produced under. Both
// are stamped into the artifact `meta` (see `currentBakedMeta`) and gated.

import { emitGlslStages } from '@xgis/shader-dsl'
import {
  PROJECTION_CONSTS,
  getProjectionWgslConsts,
  getProjectionWgslFns,
} from '../dsl/projections'
import { ECEF_CONSTS } from '../dsl/ecef'
// hillshade goes through `emitFor` — the ONE dispatch the worker and the main-thread
// fallback already share — rather than through the dsl emitters directly. Re-spelling
// its body here would make the registry a THIRD copy of that dispatch, and the copy
// that drifts is the one nothing renders. See the hillshade rows in `buildKeys`.
import { emitFor } from '../emit/shader-emit-request'
import { buildRasterModule, emitRasterWgsl } from '../dsl/raster'
import { buildUnderOccluderModule, emitUnderOccluderWgsl } from '../dsl/under-occluder'
import { emitPolygonGlsl, emitPolygonWgsl } from '../dsl/polygon'
import { emitLineWgsl } from '../dsl/line'
import { emitLineGlsl, emitCompositeGlsl } from '../dsl/line-glsl'
import { emitCompositeWgsl } from '../dsl/line-composite'
import { emitPointGlsl, emitPointWgsl } from '../dsl/point'
import { emitIconGlsl, emitIconWgsl } from '../dsl/icon'
import { emitTextGlsl, emitTextWgsl } from '../dsl/text'
import { emitCircleRetainedGlsl, emitCircleRetainedWgsl } from '../dsl/circle-retained'
import { emitIconRetainedGlsl, emitIconRetainedWgsl } from '../dsl/icon-retained'
import { emitArrowRetainedGlsl, emitArrowRetainedWgsl } from '../dsl/arrow-retained'
import { emitParticleRetainedGlsl, emitParticleRetainedWgsl } from '../dsl/particle-retained'
import { emitArrowRetainedAdvectedGlsl, emitArrowRetainedAdvectedWgsl } from '../dsl/arrow-advected'
import { emitSceneUpscaleGlsl, emitSceneUpscaleWgsl } from '../dsl/scene-upscale'
import { emitFlowAdvectGlsl, emitFlowAdvectWgsl } from '../dsl/flow-advect'
import { emitHeatmapAccumGlsl, emitHeatmapAccumWgsl } from '../dsl/heatmap-accum'
import { emitHeatmapBlurGlsl, emitHeatmapBlurWgsl } from '../dsl/heatmap-blur'
import { emitHeatmapComposeGlsl, emitHeatmapComposeWgsl } from '../dsl/heatmap-compose'
// The hillshade ids are spelled by the shared LEAF `ids.ts`, not here: the consume
// half addresses baked sources by those exact strings and cannot import this file
// (it would drag every dsl emitter above into the runtime bundle). One authority for
// the string, reachable from both sides. See ids.ts.
import { HILLSHADE_METHOD_FLAGS, hillshadeGlslId, hillshadeWgslId, pickTag } from './ids'

export type BakedLanguage = 'glsl' | 'wgsl'
export type BakedStage = 'vertex' | 'fragment'

/** Which ARTIFACT FILE a key is baked into — the download unit, not a taxonomy.
 *
 *  Phase A consumes exactly the hillshade keys (`seed-hillshade.ts`), and a boot that
 *  awaits the whole closed set pays for every family to serve one: measured on the
 *  pre-split artifacts, hillshade is 14.8% of the GLSL bytes and 34.3% of the WGSL.
 *  Splitting the emit by group means the boot's dynamic `import()` names a file that
 *  holds ONLY what it seeds, and the `rest` files — imported by nothing at runtime —
 *  are dropped whole by the bundler.
 *
 *  `rest` still ships, committed and gated: it is the phase-B payload and, until then,
 *  the proof that the OTHER 88 keys have not drifted from their emitters either. A
 *  staleness gate over shaders nobody downloads is cheap; discovering the drift when
 *  phase B wires them up is not. */
export type BakedGroup = 'hillshade' | 'rest'

/** One bakeable shader request.
 *
 *  `id` FORMAT (stable — the consume half addresses sources by it):
 *
 *      <language>/<family>[/<param>…][/<stage>][/<entry>]
 *
 *  - `<language>`  `glsl` | `wgsl`
 *  - `<family>`    the dsl module's family name (`hillshade`, `polygon`, `line`,
 *                  `raster`, `under-occluder`, `line-composite`, `heatmap-accum`, …)
 *  - `<param>`     fixed per-family order, short tokens: `m0`…`m4` (hillshade
 *                  methodFlag), then `pick` | `nopick` for the pick dimension.
 *                  A family without that dimension emits no token for it.
 *  - `<stage>`     `vertex` | `fragment` — GLSL ONLY (a WGSL module carries both).
 *  - `<entry>`     the spelled `main`, appended ONLY for the families whose module
 *                  declares several entries per stage and where the draper therefore
 *                  chooses one: polygon (`vs_main` / `vs_main_ecef`; `fs_fill` /
 *                  `fs_fill_pattern` / `fs_stroke`) and line (`vs_line`; `fs_line` /
 *                  `fs_line_pattern` / `fs_line_max`).
 *
 *  Examples: `glsl/hillshade/m3/pick/fragment`, `wgsl/hillshade/m3/pick`,
 *  `glsl/polygon/nopick/fragment/fs_stroke`, `glsl/line/pick/fragment/fs_line_pattern`,
 *  `glsl/heatmap-blur/vertex`, `wgsl/text`. */
export interface BakedShaderKey {
  readonly id: string
  readonly language: BakedLanguage
  /** Which committed artifact file carries this key (see `BakedGroup`). */
  readonly group: BakedGroup
  readonly family: string
  /** hillshade only — the specialised `hillshade-method` flag (0…4). */
  readonly methodFlag?: number
  /** Families with a pick-pass variant (hillshade / polygon / line / raster /
   *  under-occluder). Absent where the module has no pick dimension. */
  readonly pick?: boolean
  /** GLSL only. */
  readonly stage?: BakedStage
  /** The spelled `main`, for multi-entry families (see the id format). */
  readonly entry?: string
  /** Produce the source NOW, through the draper's own emitter. Requires
   *  `configureProjections()` (and, for a non-default planet, `applyBodyOption()`)
   *  to have run — the same configure-before-emit contract every draper follows. */
  emit(): string
}

const STAGES: readonly BakedStage[] = ['vertex', 'fragment']
const PICKS: readonly boolean[] = [false, true]

// ── Families with NO parameters: one WGSL module + two GLSL stages ──
// (`icon`/`text`/`point` and the retained-instance drapers, the fullscreen passes,
// and the three heatmap passes. `point` takes a variant seam that is null on every
// unconditional call site, so its baked key carries no param token.)
const SIMPLE_FAMILIES: ReadonlyArray<{
  family: string
  wgsl: () => string
  glsl: (stage: BakedStage) => string
}> = [
  { family: 'icon', wgsl: emitIconWgsl, glsl: emitIconGlsl },
  { family: 'text', wgsl: emitTextWgsl, glsl: emitTextGlsl },
  { family: 'point', wgsl: () => emitPointWgsl(null), glsl: (s) => emitPointGlsl(null, s) },
  { family: 'circle-retained', wgsl: emitCircleRetainedWgsl, glsl: emitCircleRetainedGlsl },
  { family: 'icon-retained', wgsl: emitIconRetainedWgsl, glsl: emitIconRetainedGlsl },
  { family: 'arrow-retained', wgsl: emitArrowRetainedWgsl, glsl: emitArrowRetainedGlsl },
  { family: 'particle-retained', wgsl: emitParticleRetainedWgsl, glsl: emitParticleRetainedGlsl },
  {
    family: 'arrow-retained-advected',
    wgsl: emitArrowRetainedAdvectedWgsl,
    glsl: emitArrowRetainedAdvectedGlsl,
  },
  { family: 'scene-upscale', wgsl: emitSceneUpscaleWgsl, glsl: emitSceneUpscaleGlsl },
  { family: 'flow-advect', wgsl: emitFlowAdvectWgsl, glsl: emitFlowAdvectGlsl },
  { family: 'line-composite', wgsl: emitCompositeWgsl, glsl: emitCompositeGlsl },
  { family: 'heatmap-accum', wgsl: emitHeatmapAccumWgsl, glsl: emitHeatmapAccumGlsl },
  { family: 'heatmap-blur', wgsl: emitHeatmapBlurWgsl, glsl: emitHeatmapBlurGlsl },
  { family: 'heatmap-compose', wgsl: emitHeatmapComposeWgsl, glsl: emitHeatmapComposeGlsl },
]

/** The polygon module's stage entries a draper selects between: flat/ground fill
 *  (`vs_main_ecef` + `fs_fill`), the ground fill-pattern twin (`fs_fill_pattern`,
 *  #1059) and the graticule line overlay (`vs_main` + `fs_stroke`, #1062). The
 *  EXTRUDED entries stay out — WebGL2 fail-closes on them and the WGSL module
 *  already carries them. */
const POLYGON_ENTRIES: Readonly<Record<BakedStage, readonly string[]>> = {
  vertex: ['vs_main_ecef', 'vs_main'],
  fragment: ['fs_fill', 'fs_fill_pattern', 'fs_stroke'],
}

/** emitLineGlsl's stage argument ↔ the `main` it spells (line-glsl.ts:28). */
const LINE_GLSL_STAGES: ReadonlyArray<{
  arg: 'vertex' | 'fragment' | 'fragment-pattern' | 'fragment-max'
  stage: BakedStage
  entry: string
}> = [
  { arg: 'vertex', stage: 'vertex', entry: 'vs_line' },
  { arg: 'fragment', stage: 'fragment', entry: 'fs_line' },
  { arg: 'fragment-pattern', stage: 'fragment', entry: 'fs_line_pattern' },
  { arg: 'fragment-max', stage: 'fragment', entry: 'fs_line_max' },
]

function buildKeys(): BakedShaderKey[] {
  const keys: BakedShaderKey[] = []

  // hillshade — methodFlag 0…4 × pick, THROUGH `emitFor`. Every other family below
  // calls its dsl emitter because that is what the draper calls; hillshade's draper
  // does not — it asks the emit pool, and the pool's one dispatch is `emitFor`. So
  // `emitFor` is the call site here, and the request object handed to it is the same
  // `ShaderEmitRequest` `hillshade-material.ts` builds. The `wantWgsl` argument is the
  // same device capability split the seeder replays (`seed-hillshade.ts`): the WGSL
  // key asks for the WGSL, the GLSL keys ask for the stages, and neither pays for the
  // other language.
  for (const methodFlag of HILLSHADE_METHOD_FLAGS)
    for (const pick of PICKS) {
      keys.push({
        id: hillshadeWgslId(methodFlag, pick),
        language: 'wgsl',
        group: 'hillshade',
        family: 'hillshade',
        methodFlag,
        pick,
        emit: () => emitFor({ family: 'hillshade', pick, methodFlag }, true).wgsl,
      })
      for (const stage of STAGES)
        keys.push({
          id: hillshadeGlslId(methodFlag, pick, stage),
          language: 'glsl',
          group: 'hillshade',
          family: 'hillshade',
          methodFlag,
          pick,
          stage,
          emit: () => emitFor({ family: 'hillshade', pick, methodFlag }, false)[stage],
        })
    }

  // polygon — the NULL variant (the default-uniform fill / stroke shader), both pick
  // states, every draper-selectable stage entry.
  for (const pick of PICKS) {
    keys.push({
      id: `wgsl/polygon/${pickTag(pick)}`,
      language: 'wgsl',
      group: 'rest',
      family: 'polygon',
      pick,
      emit: () => emitPolygonWgsl(null, pick),
    })
    for (const stage of STAGES)
      for (const entry of POLYGON_ENTRIES[stage])
        keys.push({
          id: `glsl/polygon/${pickTag(pick)}/${stage}/${entry}`,
          language: 'glsl',
          group: 'rest',
          family: 'polygon',
          pick,
          stage,
          entry,
          emit: () => emitPolygonGlsl(null, pick, stage, entry),
        })
  }

  // line — the NULL variant, both pick states; the GLSL twin spells one main per
  // stage so the pattern / max pipelines each carry their own fragment source.
  for (const pick of PICKS) {
    keys.push({
      id: `wgsl/line/${pickTag(pick)}`,
      language: 'wgsl',
      group: 'rest',
      family: 'line',
      pick,
      emit: () => emitLineWgsl(null, pick),
    })
    for (const { arg, stage, entry } of LINE_GLSL_STAGES)
      keys.push({
        id: `glsl/line/${pickTag(pick)}/${stage}/${entry}`,
        language: 'glsl',
        group: 'rest',
        family: 'line',
        pick,
        stage,
        entry,
        emit: () => emitLineGlsl(null, pick, arg),
      })
  }

  // raster + under-occluder — one module each, pick-parameterised, both GLSL stages.
  // BOTH spell `emitGlslStages`, because both drapers do: `raster-material.ts` since the
  // #1473-residue fix in phase A, `under-occluder-renderer.ts` since the same fix reached
  // it (#1679 increment 0 — until then this row spelled the per-stage `emitGlslModule` to
  // copy the draper it had). The two forms are byte-identical — that is exactly what
  // `glsl-stage-entry-parity.test.ts` pins, for both families — but "identical" is a
  // property to be GATED, not a licence for this list to spell something production
  // does not.
  const MODULE_FAMILIES: ReadonlyArray<{
    family: string
    wgsl: (pick: boolean) => string
    glsl: (pick: boolean, stage: BakedStage) => string
  }> = [
    {
      family: 'raster',
      wgsl: emitRasterWgsl,
      glsl: (pick, stage) => emitGlslStages(buildRasterModule(pick))[stage],
    },
    {
      family: 'under-occluder',
      wgsl: emitUnderOccluderWgsl,
      glsl: (pick, stage) => emitGlslStages(buildUnderOccluderModule(pick))[stage],
    },
  ]
  for (const { family, wgsl, glsl } of MODULE_FAMILIES)
    for (const pick of PICKS) {
      keys.push({
        id: `wgsl/${family}/${pickTag(pick)}`,
        language: 'wgsl',
        group: 'rest',
        family,
        pick,
        emit: () => wgsl(pick),
      })
      for (const stage of STAGES)
        keys.push({
          id: `glsl/${family}/${pickTag(pick)}/${stage}`,
          language: 'glsl',
          group: 'rest',
          family,
          pick,
          stage,
          emit: () => glsl(pick, stage),
        })
    }

  for (const { family, wgsl, glsl } of SIMPLE_FAMILIES) {
    keys.push({ id: `wgsl/${family}`, language: 'wgsl', group: 'rest', family, emit: wgsl })
    for (const stage of STAGES)
      keys.push({
        id: `glsl/${family}/${stage}`,
        language: 'glsl',
        group: 'rest',
        family,
        stage,
        emit: () => glsl(stage),
      })
  }

  return keys
}

/** The closed set. Sorted by id so the generator's output order is a property of the
 *  data, not of the construction order above. */
export const BAKED_SHADER_KEYS: readonly BakedShaderKey[] = buildKeys().sort((a, b) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
)

/** The keys of ONE committed artifact — i.e. of one (language, group) file. */
export const bakedKeysFor = (
  language: BakedLanguage,
  group: BakedGroup,
): readonly BakedShaderKey[] =>
  BAKED_SHADER_KEYS.filter((k) => k.language === language && k.group === group)

// ── Artifact shape (the committed *.generated.ts modules implement this) ──

/** The four body-routed GPU consts every projection / ECEF shader embeds as a
 *  LITERAL, plus a fingerprint of the host-injected projection graph. A bake is only
 *  valid under the same values — `baked-sync.test.ts` gates both. */
export interface BakedMeta {
  readonly EARTH_R: number
  readonly EARTH_E2: number
  readonly WGS84_A: number
  readonly WGS84_E2: number
  readonly projectionFingerprint: string
}

/** Content-addressed store. `contents` holds each DISTINCT source once (the GLSL
 *  vertex stage is shared verbatim by every hillshade permutation and by raster, so
 *  the set collapses hard); `index` maps every registry id onto its content hash.
 *  Deliberately dumb — a plain object literal a bundler can tree-shake and a human
 *  can diff. */
export interface BakedArtifact {
  readonly meta: BakedMeta
  readonly contents: Readonly<Record<string, string>>
  readonly index: Readonly<Record<string, string>>
}

const constValue = (arr: readonly { name: string; wgslValue: number }[], name: string): number => {
  const c = arr.find((d) => d.name === name)
  if (!c) throw new Error(`baked registry: missing ConstDecl '${name}'`)
  return c.wgslValue
}

/** 64-bit FNV-1a (two 32-bit lanes with different offset bases), hex. Dependency-free
 *  so this runs identically in the browser bundle, the bake script and vitest — and
 *  it is only ever an INDEX: `baked-sync.test.ts` compares the stored bytes against a
 *  live emit, so a hash collision would surface there as a content mismatch, never as
 *  a silently wrong shader. */
export function bakedContentHash(source: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

/** The meta the CURRENT process would bake under. Reads the live ConstDecls (which
 *  `configureBodyConsts` mutates in place) rather than any remembered value, and
 *  fingerprints the projection graph through its EMITTED WGSL — i.e. through exactly
 *  the bytes a table change could push into a baked shader. */
export function currentBakedMeta(): BakedMeta {
  return {
    EARTH_R: constValue(PROJECTION_CONSTS, 'EARTH_R'),
    EARTH_E2: constValue(PROJECTION_CONSTS, 'EARTH_E2'),
    WGS84_A: constValue(ECEF_CONSTS, 'WGS84_A'),
    WGS84_E2: constValue(ECEF_CONSTS, 'WGS84_E2'),
    // The two halves are hashed as ONE string, so they need a separator no shader
    // text can contain — otherwise a const moving into a fn body (or back) is a
    // concatenation the hash cannot tell from the original. NUL is that character:
    // WGSL source is UTF-8 with no NUL, so the domain separation is total. Spelled
    // as the ESCAPE, never as a literal control byte — a raw NUL makes this file
    // `data` to `file(1)` and "binary file matches" to ripgrep, i.e. invisible to
    // grep, which is the discovery path every container session falls back to.
    projectionFingerprint: bakedContentHash(
      `${getProjectionWgslConsts()}\u0000${getProjectionWgslFns()}`,
    ),
  }
}
