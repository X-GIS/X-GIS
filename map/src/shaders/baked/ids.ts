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

// ── Download groups: which committed artifact FILE a family's keys land in ──

/** The download unit, not a taxonomy. Three files per language:
 *
 *   * `hillshade` — phase A's pool seeding owns it (`seed-hillshade.ts`), and it stays its
 *                   own file so that path is byte-for-byte unchanged by this split.
 *   * `boot`      — the families a basemap boot genuinely reaches, imported by
 *                   `install.ts` at device attach. Every byte here is downloaded by
 *                   EVERY map, so a family that does not belong costs all of them.
 *   * `lazy`      — reached only if the style asks. Imported by NOBODY today, which is
 *                   what keeps Rollup dropping the file whole; a wrong entry here costs a
 *                   late chunk on the path that needed it, never a wrong pixel (a lookup
 *                   the store cannot serve falls through to the same runtime emit).
 *
 *  The two costs are therefore NOT symmetric — wrong-`lazy` is recoverable at runtime,
 *  wrong-`boot` is bytes every map pays forever — but a wrong-`lazy` is the one that shows
 *  up as a slow frame in production, so a GENUINELY ambiguous family goes in `boot` and
 *  says so in its row below. */
export type BakedGroup = 'hillshade' | 'boot' | 'lazy'

/** Domain of `BakedGroup`, in file-emission order. Lives here with the type rather than in
 *  `bake.ts` so the generator, the gates and the runtime read one list. */
export const BAKED_GROUPS: readonly BakedGroup[] = ['hillshade', 'boot', 'lazy']

/** family → download group. THE authority: `registry.ts` no longer carries a `group` field
 *  per key, so a new family cannot be given a group that contradicts its siblings — it gets
 *  exactly one, here, or `Record<BakedFamily, …>` fails to compile.
 *
 *  Each row states WHAT REACHES IT, read off the call sites (#1679 increment 4's census) —
 *  not guessed from how exotic the family sounds. Two rows came out the opposite way from
 *  the guess, and both are marked. */
export const FAMILY_GROUPS: Readonly<Record<BakedFamily, BakedGroup>> = {
  // Seeded into the emit pool at boot by phase A's separate mechanism. Own file.
  hillshade: 'hillshade',

  // ── boot ──
  // The vector-tile spine. `renderer.ts` builds the fill pipelines at scene construction and
  // `map.run()` PREPENDS the synthetic earth-surface show at sort-order 0 whenever the style
  // declares a background (map.ts:3319), so the polygon fill path draws on frame one of a
  // basemap even before an authored layer resolves.
  polygon: 'boot',
  // Same spine: `LineRenderer` is built with the scene and the VTR hands it every line show.
  line: 'boot',
  // The label / symbol pass. A basemap style without symbol layers is possible but not the
  // shape any real style takes; AMBIGUOUS, and ambiguous goes to boot.
  point: 'boot',
  icon: 'boot',
  text: 'boot',
  // Raster tiles — the satellite/raster basemap path, and the sibling of the hillshade
  // draper's shared TileUniforms. A pure-vector style never draws one: AMBIGUOUS → boot.
  raster: 'boot',
  // The five RETAINED drapers are constructed UNCONDITIONALLY by
  // `GraphicsManager.attachDevice` (graphics-manager.ts:740-745) the moment a device exists,
  // and each constructor emits its shader immediately through `wgslFor` / `glslStagesFor`.
  // So every map pays these five at boot whether or not the host ever calls the drawing API
  // — `particle-retained` and `arrow-retained-advected` included, which is the opposite of
  // what their names suggest and the reason this table was read rather than guessed. (The
  // eagerness is `attachDevice`'s property, so a gate reads it back from that source:
  // install.test.ts's census arm.)
  // Lives and dies with the synthetic earth-surface background (map.ts:1163), i.e. with any
  // style that declares a background fill or pattern — near-universal, but style-driven and
  // globe-only. AMBIGUOUS → boot.
  'under-occluder': 'boot',

  // ── lazy ──
  // The five `map.graphics.*` retained families. Their drapers used to be constructed
  // unconditionally in `GraphicsManager.attachDevice`, which put all five on every boot —
  // 30.9% of the boot group's brotli — for an API a session opts into. Since #1888 each is
  // built on FIRST USE (`RetainedDraperSet`), so adding one circle downloads the
  // circle shader and nothing else. install.test.ts's census derives this classification from
  // where RetainedDraperSet constructs them, in both directions, so these rows cannot drift back
  // while the construction stays lazy.
  'circle-retained': 'lazy',
  'icon-retained': 'lazy',
  'arrow-retained': 'lazy',
  'particle-retained': 'lazy',
  'arrow-retained-advected': 'lazy',
  // `HeatmapRenderer` builds all three passes together, and only when a heatmap layer exists
  // (heatmap-renderer.ts:474). No heatmap layer, no draper, no lookup.
  'heatmap-accum': 'lazy',
  'heatmap-blur': 'lazy',
  'heatmap-compose': 'lazy',
  // `FlowRenderer` builds the advection draper only for a flow source (flow-renderer.ts:219).
  'flow-advect': 'lazy',
  // The scene→screen seam runs only on a SCALED frame (`shouldRun: scene.sceneScaled`,
  // passes/scene-upscale-pass.ts:42) and the draper is built inside that first scaled
  // execute. Render scale is a quality decision, so this can arrive mid-session on a weak
  // device — but never at boot.
  'scene-upscale': 'lazy',
  // The translucent-line composite draper is created inside the DRAW path
  // (`ensureCompositeDraper`, line-renderer.ts:383), reached only by a line show with
  // opacity < 1. The closest call in this group: `line` itself is boot, and a style with a
  // translucent line reaches this on its first such frame. Kept lazy because the
  // construction is demonstrably on the draw path, not on attach.
  'line-composite': 'lazy',
  // (No coverage-ramp row: `buildCoverageModule` takes a `CoverageFilterFn`, so that family
  // is style-parameterised and stays runtime-emitted — it is not in the closed set at all.)
}

/** The download group of one family. */
export const bakedGroupOf = (family: BakedFamily): BakedGroup => FAMILY_GROUPS[family]

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

/** BOTH baked ids of one polygon pipeline — the WGSL module and the two GLSL stages —
 *  from the same `PolygonEntries` value the emitter is handed. Lives here rather than at
 *  the call sites because `vector-tile-renderer.ts` builds four of them and is under a LOC
 *  ceiling: the pairing is the leaf's job, not the god-file's. */
export const polygonIds = (
  pick: boolean,
  entries: PolygonEntries,
): { wgsl: string; glsl: { vertex: string; fragment: string } } => ({
  wgsl: polygonWgslId(pick),
  glsl: polygonGlslIds(pick, entries),
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
