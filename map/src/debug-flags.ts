// Centralised URL-flag debug toggles. Read once at module load
// (matches the existing `?safe=1` / `?gpuprof=1` / `?picking=1`
// pattern). Adding a new debug flag means: extend `readDebugFlag`
// and re-export.
//
// These are *page-load* toggles — runtime mutation isn't supported
// because most affect pipeline construction and would require
// rebuilding every renderer. To change a flag, reload the page.

import { emitOverdrawFsWgsl } from './shaders/dsl/overdraw-fs'

function readDebugFlag(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return new URL(window.location.href).searchParams.get('debug')
  } catch {
    return null
  }
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
  console.info(
    '[X-GIS] debug=overdraw active — picking + MSAA forced off, scene replaced with fragment-count heatmap',
  )
}

/** `?debug=checker` — keep the legacy analytic red/blue checker as the
 *  sourceless-raster background on the forced-WebGL2 frame, the US-003/
 *  US-004 live-render gate fixture. Production sourceless frames draw
 *  nothing there (WebGPU parity — WebGPU's raster path early-returns when
 *  sourceless, so its frame is blank too; #1041). */
export const DEBUG_RHI_CHECKER: boolean = FLAG === 'checker'

if (DEBUG_RHI_CHECKER && typeof window !== 'undefined') {
  console.info(
    '[X-GIS] debug=checker active — sourceless forced-WebGL2 frame draws the legacy analytic raster checker',
  )
}

/** `?rhichain=1` (URL) OR `globalThis.__xgisRhiChain === true` (global mirror — the
 *  `__xgisDisableLabels` seam pattern, label-pass.ts) — read at module load like the
 *  rest. A distinct URL param, not a `?debug=` value, so it reads its own key. */
function readRhiChainFlag(): boolean {
  if ((globalThis as { __xgisRhiChain?: boolean }).__xgisRhiChain === true) return true
  if (typeof window === 'undefined') return false
  try {
    return new URL(window.location.href).searchParams.get('rhichain') === '1'
  } catch {
    return false
  }
}

/** `?rhichain=1` (or `globalThis.__xgisRhiChain = true`) — #1046 F3 (doc §3-F3): route
 *  the WebGL2 frame through the unified `this._nodes` RenderNode chain instead of the
 *  forced-WebGL2 twin (`renderFrameViaRhi`). DEFAULT-OFF is the kill-switch: the twin
 *  stays the WebGL2 frame until the twin-parity ratchet reads zero on every fixture
 *  (F4 flips the default). No effect on the WebGPU frame — that is already the chain.
 *  The router (render-loop.ts) gates this by the DEVICE's word (`caps.chainFrame` —
 *  Inc-4): the pass bodies are RHI-typed, and WebGl2Device answers false until #991
 *  P4/P5 lands the chain's loop tail, so the flag stays a safe no-op until then. */
export const RHI_CHAIN: boolean = readRhiChainFlag()

if (RHI_CHAIN && typeof window !== 'undefined') {
  console.info(
    '[X-GIS] ?rhichain=1 active — the unified chain routes this WebGL2 frame (#1046 F4 Inc-E2, caps.chainFrame=true). KNOWN GAP: the VT content terminals are still native-bodied, so content-ful styles halt loud after 3 frame failures; reload without ?rhichain for the default twin',
  )
}

/** `?animt=<seconds>` (URL, page-load) — PIN the particle-flow animation clock to a fixed value
 *  instead of the live `performance.now()`. The candidate-(b) particle position is a pure function
 *  of `(seed, t)` (design §3.2), so a pinned `t` makes the whole frame byte-reproducible — the §5
 *  deterministic-probe seam (`animt=0.25/0.5/0.75` sweeps the phase for a directional pixel-diff).
 *  Mirrors the `?rhichain` URL-flag convention. */
function readAnimTUrl(): number | null {
  if (typeof window === 'undefined') return null
  try {
    const v = new URL(window.location.href).searchParams.get('animt')
    if (v === null) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

const ANIM_T_URL: number | null = readAnimTUrl()

if (ANIM_T_URL !== null && typeof window !== 'undefined') {
  console.info(
    `[X-GIS] ?animt=${ANIM_T_URL} active — particle-flow animation clock PINNED (deterministic-probe capture); reload without ?animt for the live clock`,
  )
}

/** The pinned particle animation clock, in seconds, or `null` when the clock runs live. Checks the
 *  live `globalThis.__xgisAnimT` global FIRST (so a probe harness can sweep phases WITHOUT a page
 *  reload — the `__xgisRhiChain` global-mirror pattern), then the page-load `?animt` URL param.
 *  The graphics manager falls back to `performance.now()` when this returns null. */
export function animTimePinnedSeconds(): number | null {
  const live = (globalThis as { __xgisAnimT?: unknown }).__xgisAnimT
  if (typeof live === 'number' && Number.isFinite(live)) return live
  return ANIM_T_URL
}

/** `?scenescale=<v>` (URL, page-load) — PIN the adaptive ladder's scale to a fixed notch
 *  (0 < v ≤ 1) instead of the live controller. The pin lands where the render-loop fork
 *  computes `adaptiveScale`, so each arm applies it exactly as a real ladder notch: the
 *  chain shrinks its SCENE target (the #1429 INC-2 scaled pair + upscale seam), the twin
 *  scales its canvas (design §7). Deterministic e2e seam for the scaled-frame gate — the
 *  ladder otherwise engages only when the host is genuinely too slow, a wall-clock signal
 *  CI cannot fake. Mirrors the `?animt` URL + global-mirror convention. */
function readSceneScaleUrl(): number | null {
  if (typeof window === 'undefined') return null
  try {
    const v = new URL(window.location.href).searchParams.get('scenescale')
    if (v === null) return null
    const n = Number(v)
    return Number.isFinite(n) && n > 0 && n <= 1 ? n : null
  } catch {
    return null
  }
}

const SCENE_SCALE_URL: number | null = readSceneScaleUrl()

if (SCENE_SCALE_URL !== null && typeof window !== 'undefined') {
  console.info(
    `[X-GIS] ?scenescale=${SCENE_SCALE_URL} active — adaptive ladder scale PINNED (deterministic scaled-frame probe); reload without ?scenescale for the live controller`,
  )
}

/** The pinned ladder scale (0 < v ≤ 1), or `null` when the controller runs live. Checks the
 *  live `globalThis.__xgisSceneScale` FIRST (notch sweeps without a reload — the `__xgisAnimT`
 *  pattern), then the page-load `?scenescale` URL param. */
export function sceneScalePinned(): number | null {
  const live = (globalThis as { __xgisSceneScale?: unknown }).__xgisSceneScale
  if (typeof live === 'number' && Number.isFinite(live) && live > 0 && live <= 1) return live
  return SCENE_SCALE_URL
}

/** Format of the overdraw accumulator render target. r16float lets
 *  per-pixel fragment counts grow well beyond the [0, 1] range that
 *  the bgra8unorm swapchain would clip; ~65 k max before overflow,
 *  which is far above any realistic frame's overdraw. Shared by
 *  every renderer's debug pipeline. */
export const OVERDRAW_ACCUM_FORMAT: GPUTextureFormat = 'r16float'

/** Constant fragment-shader output for additive accumulation. Every
 *  fragment writes 1.0 to the red channel; the compose pass divides
 *  by an exposure constant before applying the colormap. WGSL emitted
 *  from the polygon DSL — see runtime/src/engine/shaders/dsl/overdraw-fs.ts. */
export const OVERDRAW_FS_SOURCE = emitOverdrawFsWgsl()

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
