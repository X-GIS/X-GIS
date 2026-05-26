// ═══ Common SDF Snippets (DSL-emitted) ═══
//
// Shared signed-distance-field functions used by the line renderer (shield /
// SDF shapes). Re-authored onto the in-house shader DSL — the WGSL is now
// EMITTED from `shader-dsl/sdf.ts` (the same IR PoC-B verified: the cpu
// interpreter reproduces these fns against a hand reference). line-renderer-
// shaders.ts inlines the individual dist/winding fns + the shape structs.

import {
  SDF_WGSL_DIST_TO_SEGMENT,
  SDF_WGSL_DIST_TO_QUADRATIC,
  SDF_WGSL_DIST_TO_CUBIC,
  SDF_WGSL_WINDING_LINE,
  SDF_WGSL_SHAPE,
  SDF_WGSL_SHAPE_STRUCTS,
} from '../shader-dsl'

/** Distance from point to line segment. */
export const WGSL_DIST_TO_SEGMENT = SDF_WGSL_DIST_TO_SEGMENT
/** Distance to quadratic bezier (16-step sample). */
export const WGSL_DIST_TO_QUADRATIC = SDF_WGSL_DIST_TO_QUADRATIC
/** Distance to cubic bezier (24-step sample). */
export const WGSL_DIST_TO_CUBIC = SDF_WGSL_DIST_TO_CUBIC
/** Winding number contribution from a line segment (horizontal ray cast). */
export const WGSL_WINDING_LINE = SDF_WGSL_WINDING_LINE
/** SDF shape sampler — reads from ShapeRegistry storage buffers. */
export const WGSL_SDF_SHAPE = SDF_WGSL_SHAPE
/** Shape storage struct definitions (match the TS layout in sdf-shape.ts). */
export const WGSL_SHAPE_STRUCTS = SDF_WGSL_SHAPE_STRUCTS

/** All SDF distance/winding snippets combined (for line renderer convenience). */
export const WGSL_SDF_ALL =
  WGSL_DIST_TO_SEGMENT +
  WGSL_DIST_TO_QUADRATIC +
  WGSL_DIST_TO_CUBIC +
  WGSL_WINDING_LINE
