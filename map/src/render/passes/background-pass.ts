// ═══ Bucket 0: background / coverage pass ═══
//
// Runs FIRST in the chain (before opaque) and owns the colour-target
// clear. This is the redesign's "every pixel has a defined source"
// coverage layer (docs/redesign/VISION.md §4, §5 gap #1): before any
// geometry draws, ONE pass decides what fills the whole viewport, so the
// region OUTSIDE the world band (low-zoom letterbox, the sky above a
// pitched horizon, the area around a shrunk disc) is never an accidental
// black void.
//
// Per-projection coverage (`backgroundClearValue`):
//   • Flat / cylindrical (mercator 0 / equirect 1 / natural_earth 2 /
//     oblique_mercator 6 — worldBand ≠ 'sphere-full') → the style
//     `background-color`. The whole viewport is the background; the
//     inside-band synthetic earth-surface redraws the same colour on top
//     (seamless). This DELIBERATELY reverses the iter-196 black-outside-
//     world MapLibre-parity convention for CORE/SHOWCASE (VISION §1).
//   • Disc / globe (orthographic 3 / azimuthal 4 / stereographic 5 /
//     globe 7 — worldBand 'sphere-full') → defined pure-black space. The
//     atmosphere limb-glow is a separate, deferred pass (VISION §2.3).
//   • ?debug=overdraw → the r16float accumulator clears to 0.
//   • Flat projection with no `background` block → defined black.
//
// #777 I-E — the pass's FIRST DRAW: after the clear, an optional
// `background-pattern` sprite is tiled over the whole viewport (a fullscreen
// quad with analytic wrapped UV). The pipeline is a self-contained dual-source
// DSL module (shaders/dsl/background-pattern.ts) built through the RHI-typed
// seam (ctx.rhi.createPipeline) so F3/F4 run it on WebGL2 unchanged. No
// pattern (or a not-yet-loaded / missing sprite) → clear-only, byte-identical.
//
// Depth / stencil / pick clears STAY with the opaque first sub-pass (they
// are bucket-1 concerns). This pass is never the LAST colour writer, so it
// never claims `resolveTarget` — the resolveOwner chain (opaque /
// composite / points) and the label pass own the MSAA resolve unchanged.

import { DEBUG_OVERDRAW } from '../../debug-flags'
import { worldBandForProjType } from '@xgis/geo'
import { wrapWebGpuPass } from '@xgis/rhi-webgpu'
import { emitGlslModule } from '@xgis/shader-dsl'
import type {
  RhiDevice,
  RhiPipeline,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiTextureFormat,
} from '@xgis/rhi'
import { resolveColorShape, resolveNumberShape } from '../paint-shape-resolve'
import type { FrameContext } from '../frame-context'
import { unwrapProjection } from '../projection-token'
import type { SceneView } from '../scene-view'
import {
  buildBackgroundPatternModule,
  emitBackgroundPatternWgsl,
} from '../../shaders/dsl/background-pattern'
import type { RenderPass, BackgroundPassHost } from './pass'

/** RGBA in straight-alpha unit floats (0..1), as `XGISMap._backgroundColor`
 *  stores it. */
type Rgba = readonly [number, number, number, number]

/** 3 × vec4f = 48 B: rect (atlas-UV bbox), params (tile px + viewport px),
 *  misc (opacity, …). Matches the `BgPattern` uniform in the DSL module. */
const BG_PATTERN_UNIFORM_BYTES = 48

/** Pure, fully-unit-testable: pick the whole-viewport clear colour for a
 *  frame from the resolved projection kind + style background. Kept a free
 *  function (not inline) so its branches are gated by behaviour, not by a
 *  brittle source-text regex. */
export function backgroundClearValue(
  projType: number,
  bg: Rgba | null,
  overdraw: boolean,
): { r: number; g: number; b: number; a: number } {
  // Overdraw accumulator must start at 0 — an a:1 clear would bias every
  // pixel with one synthetic background fragment before any real draw.
  if (overdraw) return { r: 0, g: 0, b: 0, a: 0 }
  // Disc / globe: pure-black space (atmosphere is a separate deferred pass).
  if (worldBandForProjType(projType) === 'sphere-full') return { r: 0, g: 0, b: 0, a: 1 }
  // Flat / cylindrical: the style background fills the whole viewport.
  if (bg) return { r: bg[0], g: bg[1], b: bg[2], a: bg[3] }
  // Flat with no `background` block declared → defined black.
  return { r: 0, g: 0, b: 0, a: 1 }
}

/** The RHI resources for one `background-pattern` draw (a pipeline + a bind
 *  group over the sprite atlas), or `null` when there is no pattern to draw. */
interface PatternDraw {
  pipeline: RhiPipeline
  bindGroup: RhiBindGroup
}

class BackgroundPass implements RenderPass {
  readonly label = 'background'

  // ── background-pattern draw caches (#777 I-E) ──
  // The pattern pipeline + its layout / uniform buffer are built ONCE per
  // device (keyed by format:sampleCount) and reused; a device swap (map.run()
  // re-init) drops them so the next frame rebuilds on the live device — the
  // same self-healing the RenderTargets device guard uses (#737). The bind
  // group is cached per atlas-object identity (stable within a device). All
  // stay null on the clear-only path, so a pattern-less style allocates none.
  private _rhi: RhiDevice | null = null
  private _pipeline: RhiPipeline | null = null
  private _pipelineKey = ''
  private _layout: RhiBindGroupLayout | null = null
  private _uniformBuf: RhiBuffer | null = null
  private _bindGroup: RhiBindGroup | null = null
  private _bindGroupAtlas: unknown = null
  private readonly _uniformScratch = new Float32Array(BG_PATTERN_UNIFORM_BYTES / 4)

  // Always runs — the colour target must be cleared every frame even with
  // no layers, exactly as the opaque first sub-pass did before.
  shouldRun(): boolean {
    return true
  }

  execute(ctx: FrameContext, _scene: SceneView, host: BackgroundPassHost): void {
    // WS-1 — resolve a zoom-interpolated background-color / -opacity to
    // this frame's RGBA before picking the clear colour. `backgroundClearValue`
    // stays a pure function: it receives the already-resolved RGBA. Constant
    // backgrounds skip the resolve (shape === null) and pass `_backgroundColor`
    // through unchanged.
    const colorShape = host._backgroundColorShape
    let bg = host._backgroundColor
    if (colorShape) {
      const resolved = resolveColorShape(colorShape, ctx.camera.zoom, ctx.elapsedMs)
      if (resolved)
        bg = [resolved.value[0], resolved.value[1], resolved.value[2], resolved.value[3]]
    }
    const opacityShape = host._backgroundOpacityShape
    if (opacityShape && bg) {
      const a = resolveNumberShape(opacityShape, ctx.camera.zoom, ctx.elapsedMs).value
      bg = [bg[0], bg[1], bg[2], bg[3] * a]
    }
    const clearValue = backgroundClearValue(
      unwrapProjection(ctx.projection).projType,
      bg,
      DEBUG_OVERDRAW,
    )
    // Resolve the (optional) pattern draw BEFORE the render pass so a missing /
    // not-yet-loaded sprite short-circuits without opening a draw.
    const draw = this.patternDraw(ctx, host)
    ctx.passScope('background', () => {
      const pass = ctx.encoder.beginRenderPass({
        colorAttachments: [
          {
            view: ctx.colorView,
            // Never the last colour writer → no resolveTarget.
            clearValue,
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      // #777 I-E — the FIRST draw: tile the pattern over the just-cleared
      // target. Recorded through the RHI (wrapWebGpuPass) so the dual-source
      // pipeline runs unchanged once F3/F4 flip this pass to WebGL2. Skipped
      // entirely on the clear-only path (draw === null) → byte-identical.
      if (draw) {
        const rp = wrapWebGpuPass(pass)
        rp.setPipeline(draw.pipeline)
        rp.setBindGroup(0, draw.bindGroup)
        rp.draw(3) // oversized fullscreen triangle (vs_full)
      }
      pass.end()
    })
  }

  /** Resolve the `background-pattern` sprite into an RHI pipeline + bind group,
   *  or `null` to skip the draw (no pattern, atlas not loaded yet, sprite name
   *  not in the atlas, or the atlas exposes no RHI twin). MISSING-SPRITE POLICY:
   *  skip the pattern draw for this frame and keep the clear — no fail-loud in
   *  the frame loop. The sprite atlas's `onLanded` hook re-arms the render loop,
   *  so the pattern paints on a later frame once the sprite lands. */
  private patternDraw(ctx: FrameContext, host: BackgroundPassHost): PatternDraw | null {
    const name = host._backgroundPattern
    if (!name) return null
    const iconStage = host.iconStage
    if (!iconStage) return null
    if (iconStage.host.getState().status !== 'loaded') return null
    const info = iconStage.host.get(name)
    if (!info) return null
    const rhiView = iconStage.gpu.rhiView?.()
    const rhiSampler = iconStage.gpu.rhiSampler?.()
    if (!rhiView || !rhiSampler) return null
    const atlas = iconStage.gpu.size()
    if (atlas.width <= 0 || atlas.height <= 0) return null

    // Device-swap self-heal: drop every cached RHI resource built on the old
    // device so the frame never binds a stale-device pipeline (#737 class).
    if (this._rhi !== ctx.rhi) {
      this._rhi = ctx.rhi
      this._pipeline = null
      this._pipelineKey = ''
      this._layout = null
      this._uniformBuf = null
      this._bindGroup = null
      this._bindGroupAtlas = null
    }

    const format = host.ctx.format as RhiTextureFormat
    const pipeline = this.ensurePipeline(ctx.rhi, format, ctx.sampleCount)
    const layout = this._layout!
    const uniformBuf = this._uniformBuf!

    // Pack the uniform. rect = the sprite's atlas-UV bbox (min/max), the same
    // packing the fill-pattern fragment reads; params = the tile size in DEVICE
    // px (sprite CSS size × dpr) + the viewport in device px; misc.x = opacity.
    const s = this._uniformScratch
    s[0] = info.x / atlas.width
    s[1] = info.y / atlas.height
    s[2] = (info.x + info.width) / atlas.width
    s[3] = (info.y + info.height) / atlas.height
    const cssW = info.width / Math.max(info.pixelRatio, 1)
    const cssH = info.height / Math.max(info.pixelRatio, 1)
    s[4] = cssW * ctx.dpr
    s[5] = cssH * ctx.dpr
    s[6] = ctx.w
    s[7] = ctx.h
    // Zoom-interp background-opacity fades the pattern with the clear; a constant
    // opacity is already folded into the fill hex (not reachable here → 1).
    s[8] = opacityShapeValue(host, ctx)
    s[9] = 0
    s[10] = 0
    s[11] = 0
    ctx.rhi.writeBuffer(uniformBuf, 0, s)

    // Bind group cached per atlas-object identity (stable within a device); the
    // uniform buffer identity is stable, so per-frame writeBuffer keeps it valid.
    if (!this._bindGroup || this._bindGroupAtlas !== iconStage.gpu) {
      this._bindGroup = ctx.rhi.createBindGroup(layout, [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 1, resource: { view: rhiView } },
        { binding: 2, resource: { sampler: rhiSampler } },
      ])
      this._bindGroupAtlas = iconStage.gpu
    }
    return { pipeline, bindGroup: this._bindGroup }
  }

  /** Lazily build (and cache) the dual-source pattern pipeline through the RHI.
   *  Keyed by `format:sampleCount` so a swapchain-format or MSAA change rebuilds;
   *  the layout + uniform buffer are device-lifetime (reset by the device-swap
   *  guard in `patternDraw`). */
  private ensurePipeline(
    rhi: RhiDevice,
    format: RhiTextureFormat,
    sampleCount: number,
  ): RhiPipeline {
    const key = `${format}:${sampleCount}`
    if (this._pipeline && this._pipelineKey === key) return this._pipeline
    this._layout ??= rhi.createBindGroupLayout([
      { binding: 0, kind: 'uniform' },
      { binding: 1, kind: 'texture' },
      { binding: 2, kind: 'sampler' },
    ])
    this._uniformBuf ??= rhi.createBuffer({ size: BG_PATTERN_UNIFORM_BYTES, usage: 'uniform' })
    const mod = buildBackgroundPatternModule()
    this._pipeline = rhi.createPipeline({
      code: emitBackgroundPatternWgsl(),
      vsEntry: 'vs_full',
      fsEntry: 'fs_pattern',
      // GLSL twins for the WebGL2 backend (createPipeline picks by backend).
      vsCode: emitGlslModule(mod, 'vertex'),
      fsCode: emitGlslModule(mod, 'fragment'),
      bindGroupLayouts: [this._layout],
      // Straight-alpha over the coverage clear. No depthStencil — the background
      // render pass carries no depth attachment.
      colorTargets: [{ format, blend: 'alpha' }],
      sampleCount,
      label: 'background-pattern',
    })
    this._pipelineKey = key
    return this._pipeline
  }
}

/** This frame's background-opacity multiplier (0..1). A zoom-interp shape
 *  resolves per frame; a constant opacity folded into the fill hex isn't
 *  reachable separately, so the pattern uses 1 (a documented follow-up). */
function opacityShapeValue(host: BackgroundPassHost, ctx: FrameContext): number {
  const shape = host._backgroundOpacityShape
  if (!shape) return 1
  return resolveNumberShape(shape, ctx.camera.zoom, ctx.elapsedMs).value
}

/** Stateless singleton — the background / coverage clear pass. */
export const backgroundPass: RenderPass = new BackgroundPass()
