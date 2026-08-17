// Centralised URL-flag debug toggles. Read once at module load
// (matches the existing `?safe=1` / `?gpuprof=1` / `?picking=1`
// pattern). Adding a new debug flag means: extend `readDebugFlag`
// and re-export.
//
// These are *page-load* toggles — runtime mutation isn't supported
// because most affect pipeline construction and would require
// rebuilding every renderer. To change a flag, reload the page.

import { QUALITY, resolveQuality, updateQuality } from '@xgis/engine'
import { emitOverdrawFsWgsl } from './shaders/dsl/overdraw-fs'

function readDebugFlag(param = 'debug'): string | null {
  if (typeof window === 'undefined') return null
  try {
    return new URL(window.location.href).searchParams.get(param)
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

/** Whether the overdraw heatmap is ACTIVE this frame — the single authority every
 *  draw-layer consumer must call instead of reading `DEBUG_OVERDRAW` directly (#1594).
 *  The mode's compose pass is raw WebGPU (P6), so it cannot run at all on an
 *  `executionModel: 'immediate'` device (WebGL2) — the URL flag alone is not enough,
 *  the DEVICE must agree. A pure function of the live caps, not a value latched once:
 *  `map.run()` re-boot replaces `host.ctx` (and its device) wholesale, so a constant
 *  captured at an earlier device-selection time would go stale across a re-boot. */
export function isOverdrawActive(caps: { executionModel: string }): boolean {
  return DEBUG_OVERDRAW && caps.executionModel !== 'immediate'
}

/** Bring the boot-time `?debug=overdraw` quality clamp in line with the DEVICE (#1615).
 *
 *  `resolveQuality()` runs at module load, so the only thing it can ask about the mode is
 *  the URL — no `RhiDevice`, no caps, and engine must not import map to reach
 *  `isOverdrawActive` anyway. It therefore clamps `{ msaa: 1, picking: false }` from the
 *  flag ALONE, which is right for boot and wrong forever after on a device that cannot run
 *  the mode: `?debug=overdraw&picking=1` on WebGL2 (`executionModel: 'immediate'`) renders
 *  the ordinary scene with picking silently off, and nothing ever revisits it. Every other
 *  consumer of the flag asks `isOverdrawActive(caps)` per read; this one value is latched,
 *  so it needs an explicit correction instead.
 *
 *  `picking` is re-derived from the resolver with the debug override lifted — the URL's own
 *  answer, not a guess — so `?picking=1` is honoured and a boot with no picking flag stays
 *  off. `msaa` is deliberately NOT restored: its clamp is a pipeline-variant-matrix cost
 *  argument (a debug mode does not earn 4× variants of every pipeline), not a capability
 *  one, so it holds on both devices and on neither device does raising it buy anything.
 *
 *  A pure function of the caps handed in, like `isOverdrawActive` itself: called once per
 *  device boot, it re-settles across a `map.run()` re-boot that lands on a different
 *  backend rather than fossilising the first device's answer. Idempotent — a second call
 *  with the same caps changes nothing. */
export function reconcileOverdrawQualityClamp(caps: { executionModel: string }): void {
  // No flag, no clamp to correct — and no touching a `picking` the host may have set
  // itself through `map.setQuality()`.
  if (!DEBUG_OVERDRAW) return
  const picking = isOverdrawActive(caps) ? false : resolveQuality(false).picking
  if (QUALITY.picking === picking) return
  updateQuality({ picking })
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

/** `?animt=<seconds>` (URL, page-load) — PIN the particle-flow animation clock to a fixed value
 *  instead of the live `performance.now()`. The candidate-(b) particle position is a pure function
 *  of `(seed, t)` (design §3.2), so a pinned `t` makes the whole frame byte-reproducible — the §5
 *  deterministic-probe seam (`animt=0.25/0.5/0.75` sweeps the phase for a directional pixel-diff).
 *  A page-load URL flag read at module load, like the rest of this file. */
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
 *  reload — the `__xgisDisableLabels` global-mirror pattern, label-pass.ts), then the page-load
 *  `?animt` URL param. The graphics manager falls back to `performance.now()` when this returns null. */
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

/** `?nobake=1` — boot-time opt-OUT of the committed shader bake (#1678), so the closed-set
 *  artifact is ignored and every shader is emitted at runtime as it was before the bake.
 *
 *  Read PER CALL, not latched into a module const like `DEBUG_OVERDRAW`: this one is asked
 *  once per device boot (`seedBakedShaders`), and `map.run()` can re-boot against a changed
 *  URL. Same non-latched shape as `animTimePinnedSeconds` / `sceneScalePinned`.
 *
 *  It exists for the render gate: `playground/e2e/_1678-hillshade-bake-hash-gate.spec.ts`
 *  renders the same hillshade scene twice, once served from the artifact and once with this
 *  flag set, and requires the two canvases to hash EQUAL. Without a way to turn the bake off
 *  there is no control arm, and "the baked bytes are the bytes that would have been emitted"
 *  would be an assertion about the artifact only, never about the frame. */
export function bakedShadersDisabled(): boolean {
  return readDebugFlag('nobake') === '1'
}

/** Format of the overdraw accumulator render target. r16float lets
 *  per-pixel fragment counts grow well beyond the [0, 1] range that
 *  the bgra8unorm swapchain would clip; ~65 k max before overflow,
 *  which is far above any realistic frame's overdraw. Shared by
 *  every renderer's debug pipeline. */
export const OVERDRAW_ACCUM_FORMAT: GPUTextureFormat = 'r16float'

let _overdrawFsSource: string | undefined

/** Constant fragment-shader output for additive accumulation. Every
 *  fragment writes 1.0 to the red channel; the compose pass divides
 *  by an exposure constant before applying the colormap. WGSL emitted
 *  from the polygon DSL — see shaders/dsl/overdraw-fs.ts.
 *
 *  MEMOISED ACCESSOR, not a module const (#1473 residue): as a `const` this ran the
 *  emit at IMPORT time, and this module is imported by most of the render tree — so
 *  every boot, on either backend, paid for one WGSL fragment shader before a device
 *  existed, and `?debug=overdraw` is off in all of them. The mode is dormant but not
 *  dead (its compose pass is WebGPU-only, `isOverdrawActive`), so the source stays;
 *  it is now produced on first ask and cached. */
export function overdrawFsSource(): string {
  return (_overdrawFsSource ??= emitOverdrawFsWgsl())
}

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
