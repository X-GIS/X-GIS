// ═══ Line shader — GLSL ES 3.00 twin (#834 M5 slice 1) ═══
//
// Extracted from line.ts (the arch ratchet caps that file; the twin is a
// separate assembly concern anyway — mirrors emitPolygonGlsl's relationship
// to polygon.ts). The WGSL authority stays in line.ts; this module only
// RE-ASSEMBLES the same decls per stage for the GLSL backend, reusing the
// built module's consts/structs/bindings verbatim so the two backends can
// never disagree about the resource surface.

import { module, emitGlslModule, stageOf } from '@xgis/shader-dsl'
import { buildLineModule, type LineVariantSpec } from './line'
import { compositeModule, vsFullGl, fsFull } from './line-composite'

/** GLSL ES 3.00 twin of the line shader (mirrors emitPolygonGlsl). Reuses
 *  buildLineModule's ALREADY-COMPOSED funcs (the 'line-color-return'
 *  placeholder swapped in — #1605) and filters to the kept stage entry,
 *  rather than re-invoking buildFsLine/etc fresh: a fresh call would produce
 *  an un-composed FnDecl whose shared compute_line_color body still carries
 *  the unswapped placeholder, breaking WebGL2 line rendering entirely (the
 *  bug this rewrite fixes). 'fragment-pattern' emits the fs_line_pattern
 *  entry (Mapbox line-pattern; sprite atlas sample) — GLSL has one `main`
 *  per stage, so the pattern pipeline variant needs its own fragment source
 *  rather than an entry-name override. The three array<Struct> storage
 *  buffers (segments / shapes / shape_segments) lower to R32F data textures
 *  by default. `variant` is null on every call site today (line's
 *  variant seam is WebGPU-only for now, #1605 Phase 3 is the WebGL2 follow-
 *  up) — kept as a param for signature symmetry with emitPolygonGlsl. */
export const emitLineGlsl = (
  variant: LineVariantSpec | null,
  pickEnabled: boolean,
  stage: 'vertex' | 'fragment' | 'fragment-pattern' | 'fragment-max',
): string => {
  const full = buildLineModule(variant, pickEnabled)
  const keep =
    stage === 'vertex'
      ? 'vs_line'
      : stage === 'fragment-pattern'
        ? 'fs_line_pattern'
        : stage === 'fragment-max'
          ? 'fs_line_max'
          : 'fs_line'
  return emitGlslModule(
    {
      ...full,
      funcs: full.funcs.filter((f) => stageOf(f) === undefined || f.name === keep),
    },
    stage === 'vertex' ? 'vertex' : 'fragment',
  )
}

/** GLSL ES 3.00 twin of the translucent-line COMPOSITOR (fullscreen triangle
 *  sampling the MAX-blend offscreen RT — pairs with emitCompositeWgsl). Same
 *  per-stage assembly discipline as emitLineGlsl, reusing the WGSL authority
 *  module's structs/bindings verbatim. No storage buffers → no emulation. */
export const emitCompositeGlsl = (stage: 'vertex' | 'fragment'): string =>
  emitGlslModule(
    module({
      structs: compositeModule.structs,
      bindings: compositeModule.bindings,
      // vsFullGl, not vsFull: a GL FBO stores clip y=-1 at texture row 0
      // (sampled at v=0), the inverse of WebGPU's v=0-at-top — reusing the
      // WGSL uv constants composited the offscreen RT vertically mirrored.
      funcs: [stage === 'vertex' ? vsFullGl : fsFull],
    }),
    stage,
  )
