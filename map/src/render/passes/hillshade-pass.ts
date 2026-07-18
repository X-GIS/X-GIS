// ═══ Hillshade pass (#777 Phase II) — raster-dem DEM relief ═══
//
// Draws the DEM-relief overlay AFTER translucent and BEFORE points/labels, so
// the shaded relief lands over the fills but under the labels (design §4 — the
// canonical relief-overlay placement). A mid-chain overlay: it draws into the
// MSAA colour target with load/store (no resolveTarget — the downstream
// points/labels pass owns the resolve), loading the opaque depth so the shader's
// per-fragment hemisphere cull is the only visibility test (the pipeline is
// depthCompare:'always', depthWrite:false).
//
// GATED OFF when no raster-dem source is armed (scene.hasHillshade === false),
// so a style with no hillshade layer allocates nothing and renders byte-
// identically. The per-frame paint (direction / altitude / exaggeration /
// colours / method) is resolved from the active hillshade show's
// paintShapes.hillshade; the DEM decode (encoding / tileSize) was armed once at
// rebuildLayers time (map.ts, from the `_dem` source marker).

import { DEBUG_OVERDRAW } from '../../debug-flags'
import type { FrameContext } from '../frame-context'
import { unwrapProjection } from '../projection-token'
import type { SceneView } from '../scene-view'
import { resolveNumberShape, resolveColorShape } from '../paint-shape-resolve'
import type { RenderPass, HillshadePassHost } from './pass'

type RGBA = readonly [number, number, number, number]

class HillshadePass implements RenderPass {
  readonly label = 'hillshade'

  shouldRun(scene: SceneView): boolean {
    return scene.hasHillshade && !DEBUG_OVERDRAW
  }

  execute(ctx: FrameContext, _scene: SceneView, host: HillshadePassHost): void {
    const hr = host.hillshadeRenderer
    if (!hr || !hr.hasSource()) return
    const z = host.camera.zoom
    const ms = host._elapsedMs

    // Resolve the active hillshade show's paint (constant forms in the MVP;
    // zoom/time shapes resolve transparently if ever plumbed). A default
    // hillshade layer (no authored paint) carries no bundle → the renderer keeps
    // its DEFAULT_PARAMS (+ the armed DEM decode).
    const hs = host._hillshadeShow?.paintShapes.hillshade
    if (hs) {
      // resolveColorShape returns null for a constant shape — read the constant
      // value directly there; only zoom/time shapes go through the resolver.
      const colorOf = (s: (typeof hs)['shadow'], def: RGBA): RGBA =>
        s.kind === 'constant' ? s.value : (resolveColorShape(s, z, ms)?.value ?? def)
      hr.setParams({
        direction: resolveNumberShape(hs.direction, z, ms).value,
        altitude: resolveNumberShape(hs.altitude, z, ms).value,
        anchorMap: hs.anchorMap,
        exaggeration: resolveNumberShape(hs.exaggeration, z, ms).value,
        shadow: colorOf(hs.shadow, [0, 0, 0, 1]),
        highlight: colorOf(hs.highlight, [1, 1, 1, 1]),
        accent: colorOf(hs.accent, [0, 0, 0, 1]),
        method: hs.method,
      })
    }

    const encoder = ctx.encoder
    ctx.passScope('hillshade', () => {
      const hsPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: ctx.colorView,
            // Mid-chain overlay — the downstream points/labels pass owns the
            // MSAA resolve, so this pass writes the multisample target only.
            loadOp: 'load',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: ctx.rt.stencilView!,
          // Load the opaque depth; the hillshade pipeline is depthCompare:'always'
          // + depthWrite:false, so it reads nothing and writes nothing — the
          // per-fragment hemisphere cull (fs_hillshade) is the visibility test.
          // Store so the points pass can load it next.
          depthClearValue: 1.0,
          depthLoadOp: 'load',
          depthStoreOp: 'store',
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'discard',
        },
      })
      const { projType, centerLon, centerLat } = unwrapProjection(ctx.projection)
      hr.render(hsPass, host.camera, projType, centerLon, centerLat, ctx.w, ctx.h, ctx.dpr)
      hsPass.end()
    })
  }
}

/** Stateless singleton — the hillshade DEM-relief pass. */
export const hillshadePass: RenderPass = new HillshadePass()
