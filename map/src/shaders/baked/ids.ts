// ═══ Baked shaders — the id spelling BOTH halves share (#1678 phase A of #1484) ═══
//
// A baked source is addressed by a string id, and the two halves must agree on that
// string exactly: the bake half (`registry.ts`) writes it into the artifact index, the
// consume half (`seed-hillshade.ts`) looks a source up by it. They cannot agree by
// importing each other — `registry.ts` pulls in EVERY dsl emitter, which is precisely
// the module graph the bake exists to keep OUT of the runtime bundle, so the seeder
// must never reach it at runtime.
//
// The spelling therefore lives here: a LEAF with no imports, cheap for either side to
// depend on. Re-spelling it on the consume side instead would be two authorities for
// one string — the drift class this repo has paid for repeatedly — and the failure
// would be silent (an id that stops resolving just falls back to a runtime emit).
//
// Scope is deliberately hillshade-only: phase A consumes exactly the hillshade keys.
// The full id grammar (every family, param order, stage / entry tokens) is documented
// on `BakedShaderKey.id` in registry.ts; what is spelled below is the hillshade
// instance of it:
//
//     wgsl/hillshade/m<flag>/<pick|nopick>
//     glsl/hillshade/m<flag>/<pick|nopick>/<vertex|fragment>

/** The pick-dimension token of an id. */
export const pickTag = (pick: boolean): string => (pick ? 'pick' : 'nopick')

/** hillshade's five specialised method fragments (see `buildHillshadeModule`):
 *  0 standard / 1 basic / 2 combined / 3 igor / 4 multidirectional. */
export const HILLSHADE_METHOD_FLAGS: readonly number[] = [0, 1, 2, 3, 4]

/** The WGSL module id — one module carries both stages. */
export const hillshadeWgslId = (methodFlag: number, pick: boolean): string =>
  `wgsl/hillshade/m${methodFlag}/${pickTag(pick)}`

/** The GLSL id of ONE stage — a GLSL module spells one `main` per stage, so the two
 *  stages of a hillshade pipeline are two ids. */
export const hillshadeGlslId = (
  methodFlag: number,
  pick: boolean,
  stage: 'vertex' | 'fragment',
): string => `glsl/hillshade/m${methodFlag}/${pickTag(pick)}/${stage}`
