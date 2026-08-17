// ═══ Polygon pipelines: the emit seam and the baked key, paired once (#1679 inc 6) ═══
//
// `vector-tile-renderer.ts` builds four polygon pipelines and `graticule-renderer.ts` a
// fifth, and each needs the SAME `PolygonEntries` value in two places: the emitter lowers
// it, and the baked key spells it. Passing them separately is the transposition hazard —
// a key that names `fs_stroke` against a thunk that emits `fs_fill` is a store hit serving
// the wrong program, which compiles and links and paints the wrong thing.
//
// Taking `entries` ONCE and deriving both removes that by construction. It lives here
// rather than in the renderers because vector-tile-renderer.ts is under a LOC ceiling and
// the ratchet's instruction is "extract, don't grow": this is the extraction.

import { emitPolygonGlslStages, emitPolygonWgsl } from '../../shaders/dsl/polygon'
import { POLY_FILL, polygonIds, type PolygonEntries } from '../../shaders/baked/ids'
import { glslStagesFor, wgslFor, type ShaderSourceDevice } from './wgsl-for'

/** `MaterialDesc.shader` for a variant-free polygon pipeline. The WGSL module declares
 *  EVERY entry, so one key serves all three — POLY_FILL is the carrier, not a choice. */
export const polygonShaderFor = (rhi: ShaderSourceDevice, pick: boolean): string =>
  wgslFor(rhi, () => emitPolygonWgsl(null, pick), polygonIds(pick, POLY_FILL).wgsl)

/** Both GLSL halves of a variant-free polygon pipeline, keyed by the same `entries`. */
export const polygonGlslStagesFor = (
  rhi: ShaderSourceDevice,
  pick: boolean,
  entries: PolygonEntries,
): { vsCode?: string; fsCode?: string } =>
  glslStagesFor(
    rhi,
    () => emitPolygonGlslStages(null, pick, entries),
    polygonIds(pick, entries).glsl,
  )
