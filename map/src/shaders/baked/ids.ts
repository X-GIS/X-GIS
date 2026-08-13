// ═══ Baked shaders — the id GRAMMAR both halves share (#1678 phase A / #1679 phase B) ═══
//
// A baked source is addressed by a string id, and the two halves must agree on that
// string exactly: the bake half (`registry.ts`) writes it into the artifact index, the
// consume half (`seed-hillshade.ts`, and from #1679 the emit seam's call sites) looks a
// source up by it. They cannot agree by importing each other — `registry.ts` pulls in
// EVERY dsl emitter, which is precisely the module graph the bake exists to keep OUT of
// the runtime bundle, so the consume side must never reach it at runtime.
//
// The spelling therefore lives here, and ONLY here. Phase A left two authorities — this
// leaf spelled hillshade while `registry.ts` documented the full grammar in prose and
// built every other id inline — and increment 1 of #1679 closes that: `registry.ts` now
// CALLS the builders below.
//
// KEEP THIS FILE AN IMPORT-FREE LEAF. That property is what makes it cheap for either
// side to depend on; an import added here is a back door around Gate 9 of
// `map/src/architecture-invariants.test.ts` (which guards `registry.ts`, not this file),
// so `ids.test.ts` asserts the leaf property directly rather than trusting this comment.
//
// ── THE GRAMMAR ──
//
//     wgsl/<family>[/m<flag>][/pick|nopick]
//     glsl/<family>[/m<flag>][/pick|nopick]/<stage>[/<entry>]
//
//   <family>  the dsl module's family name (`hillshade`, `polygon`, `line`, `raster`,
//             `under-occluder`, `line-composite`, `heatmap-accum`, …).
//   m<flag>   hillshade's specialised method fragment, `m0`…`m4`. hillshade ONLY.
//   pick      the pick-pass dimension, `pick` | `nopick`. A family without that
//             dimension emits NO token for it — tokens are appended CONDITIONALLY,
//             never interpolated from a possibly-`undefined` value (see `joinId`).
//   <stage>   `vertex` | `fragment` — GLSL only, and always present: a WGSL module
//             carries both stages, a GLSL one spells one `main` per stage.
//   <entry>   the spelled `main`, appended ONLY for the families whose module declares
//             several entries per stage and where the draper therefore chooses one:
//             polygon (`vs_main` / `vs_main_ecef`; `fs_fill` / `fs_fill_pattern` /
//             `fs_stroke`) and line (`vs_line`; `fs_line` / `fs_line_pattern` /
//             `fs_line_max`).
//
//   Examples: `wgsl/hillshade/m3/pick`, `glsl/hillshade/m3/pick/fragment`, `wgsl/text`,
//   `glsl/heatmap-blur/vertex`, `glsl/raster/pick/fragment`,
//   `glsl/polygon/nopick/fragment/fs_stroke`, `glsl/line/pick/fragment/fs_line_pattern`.
//
// ── THE ENTRY HAZARD, and the construction that removes it ──
//
// An id that says `fs_stroke` while the thunk beside it emits `fs_fill` serves one
// shader's bytes under another's name — wrong pixels, and no gate downstream can see it.
// The construction that makes that unrepresentable is ONE VALUE driving both: the entry
// PAIRS (`POLY_FILL` / `POLY_PATTERN` / `POLY_STROKE`) and line's stage ARGUMENTS
// (`LINE_VERTEX`, `LINE_FRAGMENT_PATTERN`, …) are handed to the emitter and to the id
// builder on the same line, and they are typed against the closed unions below — so
// polygon's deliberately-excluded extruded entries are not merely un-baked, they are
// UNTYPEABLE.

// ── Token alphabet ──

/** GLSL spells one `main` per stage, so a GLSL id always names one. */
export type BakedStage = 'vertex' | 'fragment'
export const BAKED_STAGES: readonly BakedStage[] = ['vertex', 'fragment']

/** The pick-pass dimension's full domain. */
export const PICK_STATES: readonly boolean[] = [false, true]

/** Every id is a `/`-joined token list, and an ABSENT axis contributes NO token: it is
 *  filtered out here, never interpolated. `${undefined}` is the trap this exists to make
 *  unrepresentable — it stringifies to the literal `"undefined"`, which reads as a
 *  perfectly good token and collapses distinct shaders onto one key. (That is exactly
 *  how `shaderRequestKey`'s unconditional `methodFlag` interpolation would fold
 *  polygon's five stage entries onto a single key — see #1679's rejected alternatives.) */
const joinId = (...tokens: readonly (string | undefined)[]): string =>
  tokens.filter((t): t is string => t !== undefined).join('/')

/** The pick token, or none when the family has no pick dimension. */
const pickTag = (pick: boolean | undefined): string | undefined =>
  pick === undefined ? undefined : pick ? 'pick' : 'nopick'

/** The hillshade method token, or none for every other family. */
const methodTag = (methodFlag: HillshadeMethodFlag | undefined): string | undefined =>
  methodFlag === undefined ? undefined : `m${methodFlag}`

/** The optional axes of one id. Absent means "this family has no such dimension", which
 *  the token helpers turn into no token at all. */
interface IdAxes {
  readonly methodFlag?: HillshadeMethodFlag
  readonly pick?: boolean
  readonly entry?: string
}

/** `wgsl/<family>[/m<flag>][/pick|nopick]` — the ONE place the WGSL shape is spelled. */
const wgslId = (family: BakedFamily, axes: IdAxes = {}): string =>
  joinId('wgsl', family, methodTag(axes.methodFlag), pickTag(axes.pick))

/** `glsl/<family>[/m<flag>][/pick|nopick]/<stage>[/<entry>]` — likewise for GLSL. */
const glslId = (family: BakedFamily, stage: BakedStage, axes: IdAxes = {}): string =>
  joinId('glsl', family, methodTag(axes.methodFlag), pickTag(axes.pick), stage, axes.entry)

// ── Families ──

/** Families with NO parameters at all: one WGSL module, two GLSL stages, no pick pass
 *  and no entry choice. (`point` takes a variant seam that is null on every
 *  unconditional call site, so its baked key carries no param token either.) */
export type SimpleFamily =
  | 'icon'
  | 'text'
  | 'point'
  | 'circle-retained'
  | 'icon-retained'
  | 'arrow-retained'
  | 'particle-retained'
  | 'arrow-retained-advected'
  | 'scene-upscale'
  | 'flow-advect'
  | 'line-composite'
  | 'heatmap-accum'
  | 'heatmap-blur'
  | 'heatmap-compose'

export const SIMPLE_FAMILIES: readonly SimpleFamily[] = [
  'icon',
  'text',
  'point',
  'circle-retained',
  'icon-retained',
  'arrow-retained',
  'particle-retained',
  'arrow-retained-advected',
  'scene-upscale',
  'flow-advect',
  'line-composite',
  'heatmap-accum',
  'heatmap-blur',
  'heatmap-compose',
]

/** One module, pick-parameterised, both GLSL stages — no entry choice (the module
 *  declares a single `main` per stage). */
export type PickedModuleFamily = 'raster' | 'under-occluder'
export const PICKED_MODULE_FAMILIES: readonly PickedModuleFamily[] = ['raster', 'under-occluder']

/** Every family the closed set addresses. The three below the two groups above carry
 *  their own axes: hillshade a method flag, polygon and line a stage entry. */
export type BakedFamily = SimpleFamily | PickedModuleFamily | 'hillshade' | 'polygon' | 'line'

// ── hillshade ──

/** hillshade's five specialised method fragments (see `buildHillshadeModule`):
 *  0 standard / 1 basic / 2 combined / 3 igor / 4 multidirectional. */
export type HillshadeMethodFlag = 0 | 1 | 2 | 3 | 4
export const HILLSHADE_METHOD_FLAGS: readonly HillshadeMethodFlag[] = [0, 1, 2, 3, 4]

/** The WGSL module id — one module carries both stages. */
export const hillshadeWgslId = (methodFlag: HillshadeMethodFlag, pick: boolean): string =>
  wgslId('hillshade', { methodFlag, pick })

/** The GLSL id of ONE stage — a GLSL module spells one `main` per stage, so the two
 *  stages of a hillshade pipeline are two ids. */
export const hillshadeGlslId = (
  methodFlag: HillshadeMethodFlag,
  pick: boolean,
  stage: BakedStage,
): string => glslId('hillshade', stage, { methodFlag, pick })

// ── polygon ──

/** The polygon stage entries a draper selects between: flat/ground fill
 *  (`vs_main_ecef` + `fs_fill`), the ground fill-pattern twin (`fs_fill_pattern`, #1059)
 *  and the graticule line overlay (`vs_main` + `fs_stroke`, #1062). The EXTRUDED entries
 *  are absent BY TYPE — WebGL2 fail-closes on them and the WGSL module already carries
 *  them, so a call site cannot even name one here. */
export type PolygonVertexEntry = 'vs_main_ecef' | 'vs_main'
export type PolygonFragmentEntry = 'fs_fill' | 'fs_fill_pattern' | 'fs_stroke'

export const POLYGON_VERTEX_ENTRIES: readonly PolygonVertexEntry[] = ['vs_main_ecef', 'vs_main']
export const POLYGON_FRAGMENT_ENTRIES: readonly PolygonFragmentEntry[] = [
  'fs_fill',
  'fs_fill_pattern',
  'fs_stroke',
]

/** The entry pair of ONE polygon pipeline — the value `emitPolygonGlslStages` takes and
 *  the value `polygonGlslIds` takes, so the bytes and the id cannot disagree. */
export interface PolygonEntries {
  readonly vertex: PolygonVertexEntry
  readonly fragment: PolygonFragmentEntry
}

/** Flat / ground fill. Spells `emitPolygonGlslStages`'s OWN DEFAULTS (`?? 'vs_main_ecef'`,
 *  `?? 'fs_fill'`) explicitly: a call site that passes no entries and a key built from
 *  this const must resolve the same two `main`s, and stating them here is what lets a
 *  gate pin that agreement instead of trusting two `??` in another file. */
export const POLY_FILL: PolygonEntries = { vertex: 'vs_main_ecef', fragment: 'fs_fill' }
/** Ground fill-pattern twin (#1059) — same vertex entry, sprite-sampled fill. */
export const POLY_PATTERN: PolygonEntries = { vertex: 'vs_main_ecef', fragment: 'fs_fill_pattern' }
/** Graticule line overlay (#1062). */
export const POLY_STROKE: PolygonEntries = { vertex: 'vs_main', fragment: 'fs_stroke' }

export const polygonWgslId = (pick: boolean): string => wgslId('polygon', { pick })

/** Split per stage rather than one `(stage, entry)` builder ON PURPOSE: a single builder
 *  would type `entry` as the UNION of both stages' entries, making
 *  `('vertex', 'fs_stroke')` a compilable transposition. Here it does not compile. */
export const polygonGlslVertexId = (pick: boolean, entry: PolygonVertexEntry): string =>
  glslId('polygon', 'vertex', { pick, entry })
export const polygonGlslFragmentId = (pick: boolean, entry: PolygonFragmentEntry): string =>
  glslId('polygon', 'fragment', { pick, entry })

/** Both GLSL ids of one polygon pipeline, from the SAME `PolygonEntries` value the
 *  emitter is handed. */
export const polygonGlslIds = (
  pick: boolean,
  entries: PolygonEntries,
): { vertex: string; fragment: string } => ({
  vertex: polygonGlslVertexId(pick, entries.vertex),
  fragment: polygonGlslFragmentId(pick, entries.fragment),
})

// ── line ──

/** `emitLineGlsl`'s stage ARGUMENT (line-glsl.ts:28). The argument — not an entry name —
 *  is what a line call site already passes to the emitter, so it is the value that also
 *  builds the id: one value, both halves. */
export type LineGlslStageArg = 'vertex' | 'fragment' | 'fragment-pattern' | 'fragment-max'

export const LINE_VERTEX: LineGlslStageArg = 'vertex'
export const LINE_FRAGMENT: LineGlslStageArg = 'fragment'
export const LINE_FRAGMENT_PATTERN: LineGlslStageArg = 'fragment-pattern'
export const LINE_FRAGMENT_MAX: LineGlslStageArg = 'fragment-max'

export const LINE_GLSL_STAGE_ARGS: readonly LineGlslStageArg[] = [
  LINE_VERTEX,
  LINE_FRAGMENT,
  LINE_FRAGMENT_PATTERN,
  LINE_FRAGMENT_MAX,
]

export type LineVertexEntry = 'vs_line'
export type LineFragmentEntry = 'fs_line' | 'fs_line_pattern' | 'fs_line_max'

/** The (stage, `main`) each argument spells. A DISCRIMINATED union, so a row pairing the
 *  vertex stage with a fragment entry does not type-check. */
type LineStageSpell =
  | { readonly stage: 'vertex'; readonly entry: LineVertexEntry }
  | { readonly stage: 'fragment'; readonly entry: LineFragmentEntry }

export const LINE_GLSL_STAGES: Readonly<Record<LineGlslStageArg, LineStageSpell>> = {
  vertex: { stage: 'vertex', entry: 'vs_line' },
  fragment: { stage: 'fragment', entry: 'fs_line' },
  'fragment-pattern': { stage: 'fragment', entry: 'fs_line_pattern' },
  'fragment-max': { stage: 'fragment', entry: 'fs_line_max' },
}

export const lineWgslId = (pick: boolean): string => wgslId('line', { pick })

export const lineGlslId = (pick: boolean, arg: LineGlslStageArg): string => {
  const { stage, entry } = LINE_GLSL_STAGES[arg]
  return glslId('line', stage, { pick, entry })
}

// ── raster / under-occluder ──

export const pickedModuleWgslId = (family: PickedModuleFamily, pick: boolean): string =>
  wgslId(family, { pick })
export const pickedModuleGlslId = (
  family: PickedModuleFamily,
  pick: boolean,
  stage: BakedStage,
): string => glslId(family, stage, { pick })

// ── the parameterless families ──

export const simpleWgslId = (family: SimpleFamily): string => wgslId(family)
export const simpleGlslId = (family: SimpleFamily, stage: BakedStage): string =>
  glslId(family, stage)
