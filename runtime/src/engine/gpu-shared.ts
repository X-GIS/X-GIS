// ═══ Shared WebGPU Constants & Helpers ═══
// Extracted from repeated patterns across MapRenderer, RasterRenderer,
// PointRenderer, and VectorTileRenderer. Avoids configuration drift.

// ── Blend States ──

/** Standard alpha blending — used by all renderers whose fragment
 *  shader emits NON-premultiplied (rgb, a). The blend factor multiplies
 *  rgb by a at write time. */
export const BLEND_ALPHA: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

/** Premultiplied alpha blending — for fragment shaders that already emit
 *  (rgb*a, a). Using BLEND_ALPHA on premultiplied output multiplies rgb
 *  by alpha a SECOND time, which silently darkens the result. */
export const BLEND_ALPHA_PREMULT: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

/** Max blending — keeps the maximum of src and dst per channel. Used by the
 *  translucent line offscreen pipeline so overlapping segments of a single
 *  layer don't accumulate alpha at corners / self-intersections. The
 *  composite pass then blends the offscreen onto the main target with
 *  per-layer opacity. */
export const BLEND_MAX: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
}

/** Weighted Blended OIT — accumulation channel. Every translucent
 *  fragment contributes (color × α × weight, α × weight) which the
 *  GPU sums into the rgba16float accum target. McGuire-Bavoil's
 *  paper (JCGT 2013) — single-pass, order-independent
 *  approximation that avoids back-to-front sort + depth peeling.
 *  The compose pass divides accum.rgb by accum.a to recover the
 *  weighted-average colour. */
export const BLEND_OIT_ACCUM: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
}

/** Weighted Blended OIT — revealage channel. Each fragment writes
 *  (1 - α) into the single-channel target with multiplicative blend
 *  so the accumulated value is `Π (1 - α_i)` — the fraction of the
 *  background still visible after every translucent layer. The
 *  compose pass uses (1 - revealage) as the alpha for the final
 *  over-blend onto the opaque target. */
export const BLEND_OIT_REVEALAGE: GPUBlendState = {
  color: { srcFactor: 'zero', dstFactor: 'one-minus-src', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src', operation: 'add' },
}

/** OIT accumulation target format — 16-bit float per channel so
 *  the (color × weight) sum can grow well above 1 without
 *  saturating. */
export const OIT_ACCUM_FORMAT: GPUTextureFormat = 'rgba16float'

/** OIT revealage target format — single 16-bit float. r8unorm
 *  also works at low quality but quantises (1 - α) too coarsely
 *  when many low-α layers stack. */
export const OIT_REVEALAGE_FORMAT: GPUTextureFormat = 'r16float'

// ── Stencil States ──
//
// The polygon pipelines also write depth (`less-equal` test + write) so
// the opaque buffer carries meaningful depth values into the later
// points pass. Without it the depth buffer stayed at the initial clear
// (1.0) and point markers on the back side of a pitched / globe view
// drew through front-facing polygons that should occlude them. For the
// common top-down 2-D map every polygon is at z = 0, so `less-equal`
// still allows painter's order overwrite; the bug only manifests when
// the scene has real depth variation.

/** Stencil write: mark tile areas (compare=always, passOp=replace, mask=0xFF) */
export const STENCIL_WRITE: GPUDepthStencilState = {
  format: 'depth24plus-stencil8',
  depthCompare: 'less-equal',
  depthWriteEnabled: true,
  stencilFront: { compare: 'always', passOp: 'replace' },
  stencilBack: { compare: 'always', passOp: 'replace' },
  stencilWriteMask: 0xFF,
  stencilReadMask: 0xFF,
}

/** Stencil test: only draw where stencil=0 (fallback tiles, not covered by children) */
export const STENCIL_TEST: GPUDepthStencilState = {
  format: 'depth24plus-stencil8',
  depthCompare: 'less-equal',
  depthWriteEnabled: true,
  stencilFront: { compare: 'equal', passOp: 'keep' },
  stencilBack: { compare: 'equal', passOp: 'keep' },
  stencilWriteMask: 0x00,
  stencilReadMask: 0xFF,
}

/** Ground-layer stencil write — same tile-coverage stencil as
 *  STENCIL_WRITE, but depth test + write are off. Used by polygon
 *  fills for layers WITHOUT `extrude:`: every ground polygon sits
 *  at z=0 and trying to disambiguate them with a depth test +
 *  per-layer NDC bias is what produced the "lake hidden under
 *  landuse" symptom — coplanar fragments fought painter's order
 *  through layer_depth_offset, which made the result pitch-
 *  sensitive. With depth disabled, GPU primitive submission order
 *  decides: water → landuse → roads renders bottom-to-top exactly
 *  as the style declares. Stencil stays so sub-tile coverage
 *  masking still works. */
export const STENCIL_WRITE_NO_DEPTH: GPUDepthStencilState = {
  format: 'depth24plus-stencil8',
  depthCompare: 'always',
  depthWriteEnabled: false,
  stencilFront: { compare: 'always', passOp: 'replace' },
  stencilBack: { compare: 'always', passOp: 'replace' },
  stencilWriteMask: 0xFF,
  stencilReadMask: 0xFF,
}

/** Ground-layer stencil test — same fallback semantics as
 *  STENCIL_TEST (only draws where stencil=0), depth test + write
 *  off so painter's order between coplanar ground fragments stays
 *  stable across pitch. */
export const STENCIL_TEST_NO_DEPTH: GPUDepthStencilState = {
  format: 'depth24plus-stencil8',
  depthCompare: 'always',
  depthWriteEnabled: false,
  stencilFront: { compare: 'equal', passOp: 'keep' },
  stencilBack: { compare: 'equal', passOp: 'keep' },
  stencilWriteMask: 0x00,
  stencilReadMask: 0xFF,
}

/** Depth test enabled, depth write disabled, stencil ignored. Used
 *  for SDF line draws so outlines respect 3D building occlusion —
 *  a roof outline behind a foreground building wall fails the
 *  LEQUAL test and gets hidden, instead of always rendering on top
 *  the way `STENCIL_DISABLED` would. Lines themselves don't write
 *  depth so they don't interfere with following draws (e.g. a
 *  building drawn after a same-z=0 line still wins). */
export const DEPTH_READ_ONLY: GPUDepthStencilState = {
  format: 'depth24plus-stencil8',
  depthCompare: 'less-equal',
  depthWriteEnabled: false,
  stencilFront: { compare: 'always', passOp: 'keep' },
  stencilBack: { compare: 'always', passOp: 'keep' },
  stencilWriteMask: 0x00,
  stencilReadMask: 0x00,
  // Pull line depth slightly toward camera so a roof outline coplanar
  // with its own roof fill always wins LEQUAL z-fighting (otherwise
  // float-precision noise makes the same-z outline drop in/out per
  // pixel — visible as a patchy outline). Occlusion against OTHER
  // buildings still works because their walls are far enough in
  // screen-z that a -1 unit bias can't overcome them.
  depthBias: -1,
  depthBiasSlopeScale: -1,
  depthBiasClamp: 0,
}

/** Stencil disabled: always pass, no write (raster tiles, SDF line body) */
export const STENCIL_DISABLED: GPUDepthStencilState = {
  format: 'depth24plus-stencil8',
  depthCompare: 'always',
  depthWriteEnabled: false,
  stencilFront: { compare: 'always', passOp: 'keep' },
  stencilBack: { compare: 'always', passOp: 'keep' },
  stencilWriteMask: 0x00,
  stencilReadMask: 0x00,
}

/** Depth test + write, no stencil — point markers need occlusion when the
 *  camera is pitched so near points draw over far points regardless of the
 *  CPU-side feature order. `less-equal` lets same-depth fragments overwrite
 *  (preserves painter's order for top-down views where all z are equal). */
export const DEPTH_TEST_WRITE: GPUDepthStencilState = {
  format: 'depth24plus-stencil8',
  depthCompare: 'less-equal',
  depthWriteEnabled: true,
  stencilFront: { compare: 'always', passOp: 'keep' },
  stencilBack: { compare: 'always', passOp: 'keep' },
  stencilWriteMask: 0x00,
  stencilReadMask: 0x00,
}

// ── MSAA ──
// Sample count chosen at module load from `quality.ts` (default 4× desktop,
// 1× mobile / `?safe=1` / `?quality=performance|battery` / `?msaa=1|2`).
// Name `MSAA_4X` is historical — the actual count is whatever SAMPLE_COUNT
// resolves to. All render pipelines pick this up at creation; the 1×
// branch in `map.ts:renderFrame` handles the no-resolve direct-to-swapchain
// path.
import { SAMPLE_COUNT } from './gpu'
export const MSAA_STATE: GPUMultisampleState = { count: SAMPLE_COUNT }
/** @deprecated Use `MSAA_STATE` (count is no longer always 4). Alias kept
 *  for back-compat with existing imports. */
export const MSAA_4X = MSAA_STATE

// ── Buffer Helpers ──

/** Create a GPU buffer, write data, return the buffer */
export function uploadBuffer(
  device: GPUDevice,
  data: Float32Array | Uint32Array | Uint8Array,
  usage: GPUBufferUsageFlags,
  label?: string,
): GPUBuffer {
  const buf = device.createBuffer({
    size: Math.max(data.byteLength, 4),
    usage: usage | GPUBufferUsage.COPY_DST,
    label,
  })
  device.queue.writeBuffer(buf, 0, data)
  return buf
}

// ── World Wrapping ──

/** Earth circumference in Mercator meters */
export const WORLD_MERC = 40075016.686

/** World copy offsets: primary + N copies each side. Used as the
 *  Mercator-path enumeration; other projections collapse to a single
 *  world via `worldCopiesFor()`. */
export const WORLD_COPIES = [-2, -1, 0, 1, 2]
const SINGLE_WORLD: readonly number[] = [0]

/** World-copy enumeration gated by projection. Mercator (and only
 *  Mercator) is periodic in lon and uses the full ±2 wrap; every other
 *  projection currently in this codebase (equirect, natural earth,
 *  ortho, azimuthal_equidistant, stereographic, oblique_mercator) either
 *  isn't periodic or doesn't apply the WORLD_MERC offset to its output
 *  in the WGSL `project()` path — so the additional copies overdraw at
 *  the same pixels and waste 4× draws (plus introduce coplanar z-fight).
 *  Returning `[0]` for non-Mercator collapses to a single world.
 *  `projType` is the same `proj_params.x` encoding shaders use:
 *  0 = mercator, 1 = equirect, 2 = natural_earth, 3 = ortho,
 *  4 = azimuthal_equidistant, 5 = stereographic, 6 = oblique_mercator. */
export function worldCopiesFor(projType: number): readonly number[] {
  return projType === 0 ? WORLD_COPIES : SINGLE_WORLD
}

/** Create an empty uniform buffer */
export function createUniformBuffer(device: GPUDevice, size: number, label?: string): GPUBuffer {
  return device.createBuffer({
    size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label,
  })
}
