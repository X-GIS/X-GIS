// ═══ Line SPLIT-mode module — derived from the legacy module by IR
//     transform (#2042 INC-4c) ═══
//
// The stroke half of the three-range rebind. The line module's group(0)
// block (`TileUniforms`, line.ts) is a BYTE-MIRROR of polygon's `Uniforms`
// — same lanes at the same offsets, size-only pads for the ones the line
// shader never reads — so the polygon partition and the retired-lane
// derivations apply verbatim; only the struct tag differs. The measured
// read set of the shipped variants (null/pick — emitted and enumerated) is
// exactly: mvp, proj_params, globe_eye, log_depth_fc (frame);
// stroke_color, fill_translate_x/y (show); tile_extent_m, clip_bounds
// (tile); cam_h/cam_l, tile_origin_merc, cam_ecef_off_h/l (retired →
// recombined). Everything routes through the shared rewriter; an unmapped
// read throws at build (#600 class).
//
// The pattern fragment (fs_line_pattern) statically samples the sprite
// atlas at group(0) bindings 5/6, which the split layout does not carry —
// pattern strokes stay on the legacy bind (the callers gate on
// patternActive), exactly like pattern fills in INC-4b's first slice.
//
// Same derivation discipline as polygon-split.ts: line.ts is untouched, the
// legacy bytes cannot drift, and the identity-preserving rewrite walker
// (rename-varrefs.ts — the INC-4b vanished-fills contract) keeps the
// optimizer's auto-var correlation intact.

import { emitModule, rewriteExprsInFunc } from '@xgis/shader-dsl'
import { buildLineModule, type LineVariantSpec } from './line'
import { makeSplitRewriteRead } from './polygon-split'
import { tileBlockU } from './tile-block'
import { showBlockU } from './show-block'
import { frameBlockU } from './frame-block'

type ModuleDecl = ReturnType<typeof buildLineModule>

const rewriteRead = makeSplitRewriteRead('TileUniforms')

/** Build the split-mode line module for `variant`/`pickEnabled` by
 *  transforming the legacy module. Pure derivation — line.ts's authored
 *  emit is untouched. */
export function buildLineSplitModule(
  variant: LineVariantSpec | null,
  pickEnabled: boolean,
): ModuleDecl {
  const legacy = buildLineModule(variant, pickEnabled)
  const structs = legacy.structs.map((s) =>
    s.name === 'TileUniforms' ? [frameBlockU.decl, showBlockU.decl, tileBlockU.decl] : [s],
  )
  const bindings = legacy.bindings.flatMap((b) =>
    b.name === 'u' ? [frameBlockU.binding, showBlockU.binding, tileBlockU.binding] : [b],
  )
  return {
    ...legacy,
    structs: structs.flat(),
    bindings,
    funcs: legacy.funcs.map((f) => rewriteExprsInFunc(f, rewriteRead)),
  }
}

/** Split-mode line WGSL emit — the INC-4c stroke rebind's shader source. */
export const emitLineSplitWgsl = (variant: LineVariantSpec | null, pickEnabled: boolean): string =>
  emitModule(buildLineSplitModule(variant, pickEnabled))
