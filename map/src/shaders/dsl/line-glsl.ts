// ═══ Line shader — GLSL ES 3.00 twin (#834 M5 slice 1) ═══
//
// Extracted from line.ts (the arch ratchet caps that file; the twin is a
// separate assembly concern anyway — mirrors emitPolygonGlsl's relationship
// to polygon.ts). The WGSL authority stays in line.ts; this module only
// RE-ASSEMBLES the same decls per stage for the GLSL backend, reusing the
// built module's consts/structs/bindings verbatim so the two backends can
// never disagree about the resource surface.

import { module, emitGlslModule } from '@xgis/shader-dsl'
import { getGpuProjectionFuncs } from './projections'
import { buildLineModule, vsLine, buildFsLine, buildFsLinePattern, fsLineMax } from './line'
import { compositeModule, vsFull, fsFull } from './line-composite'

/** GLSL ES 3.00 twin of the line shader (mirrors emitPolygonGlsl /
 *  emitIconRetainedGlsl). Per-stage module ASSEMBLY (not a post-hoc func
 *  filter): module() collects the kept entry's transitive callees, so the
 *  vertex stage never sees the fragment-only SDF helpers — they contain
 *  `discard`, which GLSL rejects in a vertex shader even when unreached.
 *  'fragment-pattern' emits the fs_line_pattern entry (Mapbox line-pattern;
 *  sprite atlas sample) — GLSL has one `main` per stage, so the pattern
 *  pipeline variant needs its own fragment source rather than an entry-name
 *  override. The three array<Struct> storage buffers (segments / shapes /
 *  shape_segments) lower to R32F data textures via `emulateStorage`. */
export const emitLineGlsl = (
  pickEnabled: boolean,
  stage: 'vertex' | 'fragment' | 'fragment-pattern' | 'fragment-max',
): string => {
  const full = buildLineModule(pickEnabled)
  const entry =
    stage === 'vertex'
      ? vsLine
      : stage === 'fragment-pattern'
        ? buildFsLinePattern(pickEnabled)
        : stage === 'fragment-max'
          ? fsLineMax
          : buildFsLine(pickEnabled)
  return emitGlslModule(
    module({
      consts: full.consts,
      structs: full.structs,
      bindings: full.bindings,
      funcs: [...getGpuProjectionFuncs(), entry],
    }),
    stage === 'vertex' ? 'vertex' : 'fragment',
    { emulateStorage: true },
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
      funcs: [stage === 'vertex' ? vsFull : fsFull],
    }),
    stage,
  )
