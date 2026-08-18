// ═══ Atmosphere pass (#1258) ═══
//
// The screen-space limb-glow gradient background-pass.ts's own header names as "a separate,
// deferred pass". Runs immediately after `background` (before any geometry draws) so the
// gradient sits strictly BEHIND the earth surface in painter's order — `background` clears
// to pure black on globe-class projections already; this pass draws the glow on top of that
// black, and every later pass then draws the actual planet over both.
//
// GATED on `scene.hasAtmosphere`, itself `_atmosphere !== null && camera.globeMode`: the
// style flag alone is not enough. `worldBandForProjType() === 'sphere-full'` (background-
// pass.ts's own gate) ALSO covers the untitled orthographic/azimuthal/stereographic disc
// projections (3/4/5), which render through the FLAT 2D matrix (`Camera.getViewForProjection`
// — "3D (globe 7 / tilted azimuthal → globeMode): the ECEF MVP" vs the flat branch otherwise).
// This pass's ray-sphere math is 3D ECEF camera math; run it against a flat 2D disc's world
// space and the ray/eye/up numbers describe a camera that is not the one on screen. `camera.
// globeMode` is the SAME boolean `getViewForProjection` itself branches on, so the two can
// never disagree about which matrix is live this frame.

import { localFrame } from '@xgis/geo'
import type { RhiBuffer } from '@xgis/engine'
import { uniformBlock, type UniformBlockOf } from '@xgis/engine'
import type { FrameContext } from '../frame-context'
import { unwrapProjection } from '../projection-token'
import type { SceneView } from '../scene-view'
import { requireRhiFrame, type RenderPass, type AtmospherePassHost } from './pass'
import { AtmosphereDraper } from '../material/atmosphere-material'
import { atmosphereCameraRays } from '../atmosphere-uniform'
import { atmosphereU } from '../../shaders/dsl/atmosphere'

interface AtmosphereEntry {
  draper: AtmosphereDraper
  buf: RhiBuffer
  format: string
  sampleCount: number
}

class AtmospherePass implements RenderPass {
  readonly label = 'atmosphere'

  // Per-host GPU state (draper + its uniform buffer), like SceneUpscalePass's own
  // per-map WeakMap — this is a module-level singleton pass, shared by every XGISMap.
  private readonly _entries = new WeakMap<AtmospherePassHost, AtmosphereEntry>()
  // ONE CPU staging block, rewritten every frame (single-threaded frame build — the same
  // shared-scratch contract `globeEyeUniform` documents for its own per-frame tuple).
  private readonly _block: UniformBlockOf<typeof atmosphereU> = uniformBlock(atmosphereU)

  shouldRun(scene: SceneView): boolean {
    return scene.hasAtmosphere
  }

  execute(ctx: FrameContext, _scene: SceneView, host: AtmospherePassHost): void {
    const atmosphere = host._atmosphere
    // shouldRun already requires this; kept as a self-contained guard (flow-pass.ts's own
    // precedent — a pass body should not assume the caller's gate is the only path to it).
    if (!atmosphere || !host.camera.globeMode) return
    const { projType, centerLon, centerLat } = unwrapProjection(ctx.projection)
    const frame = host.camera.getViewForProjection(
      projType,
      ctx.scene.w,
      ctx.scene.h,
      ctx.scene.dpr,
    )
    const rays = atmosphereCameraRays(frame.matrix)
    // A degenerate (near-orthographic) matrix this frame — no usable camera ray field to draw
    // with. The globe orbit camera's `ortho` arm is a telephoto, not a true parallel
    // projection (unproject-dsl.ts's header), so this is not expected to be reached live.
    if (!rays) return
    const up = localFrame(centerLon, centerLat).up
    const { enc, colorView } = requireRhiFrame(ctx, 'atmosphere')
    let entry = this._entries.get(host)
    if (!entry || entry.format !== host.ctx.format || entry.sampleCount !== ctx.sampleCount) {
      entry = {
        draper: new AtmosphereDraper(host.ctx.rhi, host.ctx.format, ctx.sampleCount),
        buf: host.ctx.rhi.createBuffer({
          size: this._block.byteLength,
          usage: 'uniform',
          writable: true,
        }),
        format: host.ctx.format,
        sampleCount: ctx.sampleCount,
      }
      this._entries.set(host, entry)
    }
    this._block.write({
      ray_bl: [rays.dirs[0][0], rays.dirs[0][1], rays.dirs[0][2], 0],
      ray_br: [rays.dirs[1][0], rays.dirs[1][1], rays.dirs[1][2], 0],
      ray_tl: [rays.dirs[2][0], rays.dirs[2][1], rays.dirs[2][2], 0],
      ray_tr: [rays.dirs[3][0], rays.dirs[3][1], rays.dirs[3][2], 0],
      eye: [rays.eye[0], rays.eye[1], rays.eye[2], 0],
      up: [up[0], up[1], up[2], 0],
      inner_color: atmosphere.innerColor,
      outer_color: atmosphere.outerColor,
    })
    host.ctx.rhi.writeBuffer(entry.buf, 0, this._block.buffer)
    ctx.passScope('atmosphere', () => {
      // Never claims resolveTarget — like `background`, this is not the last colour writer
      // this frame; `loadOp: 'load'` preserves the background clear the glow draws over.
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      })
      entry!.draper.draw(pass, entry!.buf)
      pass.end()
    })
  }
}

/** Stateless singleton — the globe atmosphere / limb-glow pass. */
export const atmospherePass: RenderPass = new AtmospherePass()
