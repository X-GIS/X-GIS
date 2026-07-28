// ═══ X-GIS RenderLoop — RenderPass interface ═══
//
// The render path is a fixed linear chain of passes (compute → opaque →
// OIT → translucent → points → labels → overdraw-compose), bracketed by
// the renderer's beginFrame/endFrame. Each phase of the engine redesign
// lifts one inline passScope block out of RenderLoop.render into a
// RenderPass: a stateless object that reads the per-frame FrameContext +
// SceneView + the owning map (via the RenderLoopHost view) and emits its
// GPU commands. Behaviour is byte-identical to the inline block — the
// pass owns the SAME encoder calls, only relocated.
//
// Passes are stateless singletons (no per-frame allocation). `shouldRun`
// is the gate the inline `if (...)` used; `execute` is the block body.

import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'
import type {
  BackgroundPassHost,
  OpaquePassHost,
  OitPassHost,
  TranslucentPassHost,
  PointsPassHost,
  HillshadePassHost,
  LabelPassHost,
  OverdrawComposePassHost,
  HeatmapPassHost,
  GraphicsPassHost,
  FlowPassHost,
  SceneUpscalePassHost,
} from './pass-hosts'
// Re-export the per-pass role views so each concrete pass imports its role
// alongside RenderPass from this one module (single import line per pass).
export type {
  BackgroundPassHost,
  OpaquePassHost,
  OitPassHost,
  TranslucentPassHost,
  PointsPassHost,
  HillshadePassHost,
  LabelPassHost,
  OverdrawComposePassHost,
  HeatmapPassHost,
  GraphicsPassHost,
  FlowPassHost,
  SceneUpscalePassHost,
} from './pass-hosts'

/** The owning-map view a pass reaches its renderers / stages / camera
 *  through — the COMPOSITION (intersection) of every per-pass role view.
 *  Each concrete pass narrows its `execute` host param to its own role
 *  (e.g. BackgroundPassHost); the generic `RenderPass.execute` declares
 *  the composed PassHost so the RenderLoop can drive any pass uniformly.
 *  Same member set the loop hands in — a pure TYPE re-grouping. */
export type PassHost = BackgroundPassHost &
  OpaquePassHost &
  OitPassHost &
  TranslucentPassHost &
  PointsPassHost &
  HillshadePassHost &
  LabelPassHost &
  OverdrawComposePassHost &
  HeatmapPassHost &
  GraphicsPassHost &
  FlowPassHost &
  SceneUpscalePassHost

/** One stage of the fixed render-pass chain. */
export interface RenderPass {
  /** Stable name (matches the old passScope label family). */
  readonly label: string
  /** Whether this pass emits anything this frame — the gate the inline
   *  `if (...)` block used. */
  shouldRun(scene: SceneView): boolean
  /** Emit the pass's GPU commands through the RHI frame shell
   *  (`requireRhiFrame(ctx, label)` — every chain pass since #1046 F3b). */
  execute(ctx: FrameContext, scene: SceneView, host: PassHost): void
}

/** F3b bridge for the RHI-ported pass bodies: the frame's RHI encoder + view
 *  handles, non-null-asserted in one place. Under the `__xgisRawFrameShell`
 *  debug escape these are null and a ported body CANNOT run — fail loud naming
 *  the flag rather than render a wrong frame. The unported bodies still honour
 *  the escape; it retires with the F3b FrameContext field collapse. */
export function requireRhiFrame(
  ctx: FrameContext,
  label: string,
): {
  enc: NonNullable<FrameContext['rhiEncoder']>
  screenView: NonNullable<FrameContext['rhiScreenView']>
  colorView: NonNullable<FrameContext['rhiColorView']>
  stencilView: NonNullable<FrameContext['rhiStencilView']>
  /** #1429 INC-2 — where the resolve-owner SCENE pass resolves (the scene
   *  colour while the ladder scales; IDENTITY to `screenView` when not). */
  sceneResolveView: NonNullable<FrameContext['rhiSceneResolveView']>
  /** #1429 INC-2 — the SEAM/OVERLAY colour attachment (the screen-sized
   *  MSAA while scaled; IDENTITY to `colorView` when not). */
  colorViewScreen: NonNullable<FrameContext['rhiColorViewScreen']>
} {
  const { rhiEncoder, rhiScreenView, rhiColorView, rhiStencilView } = ctx
  const { rhiSceneResolveView, rhiColorViewScreen } = ctx
  if (
    !rhiEncoder ||
    !rhiScreenView ||
    !rhiColorView ||
    !rhiStencilView ||
    !rhiSceneResolveView ||
    !rhiColorViewScreen
  )
    throw new Error(
      `[X-GIS] ${label}: this pass runs on the RHI frame shell and cannot execute ` +
        `under __xgisRawFrameShell=true — unset the flag (#1046 F3b)`,
    )
  return {
    enc: rhiEncoder,
    screenView: rhiScreenView,
    colorView: rhiColorView,
    stencilView: rhiStencilView,
    sceneResolveView: rhiSceneResolveView,
    colorViewScreen: rhiColorViewScreen,
  }
}
