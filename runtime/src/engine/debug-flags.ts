// Centralised URL-flag debug toggles. Read once at module load
// (matches the existing `?safe=1` / `?gpuprof=1` / `?picking=1`
// pattern). Adding a new debug flag means: extend `readDebugFlag`
// and re-export.
//
// These are *page-load* toggles — runtime mutation isn't supported
// because most affect pipeline construction and would require
// rebuilding every renderer. To change a flag, reload the page.

function readDebugFlag(): string | null {
  if (typeof window === 'undefined') return null
  try { return new URL(window.location.href).searchParams.get('debug') }
  catch { return null }
}

const FLAG = readDebugFlag()

/** `?debug=overdraw` — paint a per-pixel fragment-count heatmap
 *  instead of the normal scene. Every draw outputs a constant
 *  contribution into an `r16float` accumulator with additive blend;
 *  a final compose pass applies a colormap LUT and writes to the
 *  swapchain. Forces `msaa=1` and `picking=false` (`quality.ts`
 *  handles those overrides). Slow paths (translucent line MAX
 *  blend, OIT extrude fill) collapse onto the main debug pipeline
 *  in v1 — fidelity adequate; if a renderer is missing the toggle,
 *  its draws simply contribute nothing to the count. */
export const DEBUG_OVERDRAW: boolean = FLAG === 'overdraw'

if (DEBUG_OVERDRAW && typeof window !== 'undefined') {
  console.info('[X-GIS] debug=overdraw active — picking + MSAA forced off, scene replaced with fragment-count heatmap')
}

/** Format of the overdraw accumulator render target. r16float lets
 *  per-pixel fragment counts grow well beyond the [0, 1] range that
 *  the bgra8unorm swapchain would clip; ~65 k max before overflow,
 *  which is far above any realistic frame's overdraw. Shared by
 *  every renderer's debug pipeline. */
export const OVERDRAW_ACCUM_FORMAT: GPUTextureFormat = 'r16float'

/** Constant fragment-shader output for additive accumulation. Every
 *  fragment writes 1.0 to the red channel; the compose pass divides
 *  by an exposure constant before applying the colormap. */
export const OVERDRAW_FS_SOURCE = /* wgsl */ `
@fragment
fn fs_overdraw() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.0, 0.0, 0.0);
}
`

/** Blend state — pure additive on the red channel. Alpha is also
 *  summed defensively in case future code reads it. */
export const OVERDRAW_BLEND_STATE: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
}

/** Depth-stencil state for debug pipelines — depth ALWAYS, no
 *  writes, no stencil. Counts SUBMITTED overdraw (every fragment
 *  contributes), the same convention MapLibre's `--debug overdraw`
 *  uses. Counting only depth-tested (visible) overdraw would
 *  require mirroring each pipeline's depth state, which inflates
 *  the variant matrix for marginal extra accuracy in a 2D map. */
export const OVERDRAW_DEPTH_STENCIL: GPUDepthStencilState = {
  format: 'depth24plus-stencil8',
  depthCompare: 'always',
  depthWriteEnabled: false,
  stencilFront: { compare: 'always', passOp: 'keep' },
  stencilBack: { compare: 'always', passOp: 'keep' },
  stencilWriteMask: 0x00,
  stencilReadMask: 0x00,
}
