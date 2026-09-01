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

import type { FrameContext } from '../frame-context'
import { unwrapProjection } from '../projection-token'
import type { SceneView } from '../scene-view'
import { resolveNumberShape, resolveColorShape } from '../paint-shape-resolve'
import type { InputStore } from '../input-store'
import type { HillshadeRenderer } from '../hillshade-renderer'
import { requireRhiFrame, type RenderPass, type HillshadePassHost } from './pass'

type RGBA = readonly [number, number, number, number]

/** Resolve the active hillshade show's paint (direction / altitude / exaggeration
 *  / colours / method) and push it to the renderer. Constant forms in the MVP;
 *  zoom/time shapes resolve transparently if ever plumbed. A default hillshade
 *  layer (no authored paint) carries no bundle → the renderer keeps its
 *  DEFAULT_PARAMS + armed DEM. */
export function applyHillshadePaint(
  hr: HillshadeRenderer,
  hillshadeShow:
    | {
        paintShapes: {
          hillshade?: HillshadeShapesLike
          common?: { opacity: Parameters<typeof resolveNumberShape>[0] }
        }
      }
    | null
    | undefined,
  zoom: number,
  elapsedMs: number,
  /** Live `input` values (#2166). Without it an `input-dependent` opacity
   *  shape — `| opacity-[dim]`, a per-frame constant — takes the per-feature
   *  fallback of 1 and the authored default never reaches the relief. */
  inputs?: InputStore | null,
): void {
  // Layer opacity is a COMMON paint (independent of the hillshade relief bundle) — resolve
  // + set it FIRST, so a default hillshade layer (no authored relief paint, early-returns
  // below) still honours `opacity` like every other layer type (#777 gap).
  const common = hillshadeShow?.paintShapes.common
  if (common) hr.setOpacity(resolveNumberShape(common.opacity, zoom, elapsedMs, inputs).value)

  const hs = hillshadeShow?.paintShapes.hillshade
  if (!hs) return
  // resolveColorShape returns null for a constant shape — read the constant value
  // directly there; only zoom/time shapes go through the resolver.
  const colorOf = (s: HillshadeShapesLike['shadow'], def: RGBA): RGBA =>
    s.kind === 'constant' ? s.value : (resolveColorShape(s, zoom, elapsedMs)?.value ?? def)
  hr.setParams({
    direction: resolveNumberShape(hs.direction, zoom, elapsedMs).value,
    altitude: resolveNumberShape(hs.altitude, zoom, elapsedMs).value,
    anchorMap: hs.anchorMap,
    exaggeration: resolveNumberShape(hs.exaggeration, zoom, elapsedMs).value,
    shadow: colorOf(hs.shadow, [0, 0, 0, 1]),
    highlight: colorOf(hs.highlight, [1, 1, 1, 1]),
    accent: colorOf(hs.accent, [0, 0, 0, 1]),
    method: hs.method,
    // Multidirectional sources 2..4 — already fully-resolved constants in the
    // IR bundle (the converter normalised + truncated them).
    extraSources: (hs.extraSources ?? []).map((s) => ({
      direction: s.direction,
      altitude: s.altitude,
      shadow: s.shadow,
      highlight: s.highlight,
    })),
  })
}

// Structural shape of the compiler's HillshadeShapes (the fields this pass reads),
// kept local so this file doesn't take a value import on @xgis/compiler.
interface HillshadeShapesLike {
  direction: Parameters<typeof resolveNumberShape>[0]
  altitude: Parameters<typeof resolveNumberShape>[0]
  exaggeration: Parameters<typeof resolveNumberShape>[0]
  anchorMap: boolean
  method: string
  shadow: Parameters<typeof resolveColorShape>[0]
  highlight: Parameters<typeof resolveColorShape>[0]
  accent: Parameters<typeof resolveColorShape>[0]
  /** Sources 2..4 (method=multidirectional); absent on pre-multidirectional IR. */
  extraSources?: readonly {
    direction: number
    altitude: number
    shadow: RGBA
    highlight: RGBA
  }[]
}

class HillshadePass implements RenderPass {
  readonly label = 'hillshade'

  shouldRun(scene: SceneView): boolean {
    return scene.hasHillshade && !scene.overdraw
  }

  execute(ctx: FrameContext, scene: SceneView, host: HillshadePassHost): void {
    const hr = host.hillshadeRenderer
    if (!hr || !hr.hasSource()) return
    applyHillshadePaint(hr, host._hillshadeShow, host.camera.zoom, host._elapsedMs, host.inputs)

    // F3b: RHI origination — descriptor-equivalent on WebGPU, executable on
    // WebGL2 after the flip. hr.render takes RhiRenderPass ONLY (narrowed in
    // the F3b review — its former native union hid a backend-keyed re-wrap
    // that double-wrapped the chain's handle on WebGPU).
    const { enc, colorView, stencilView, sceneResolveView } = requireRhiFrame(ctx, 'hillshade')
    ctx.passScope('hillshade', () => {
      const hsPass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: colorView,
            // Mid-chain overlay — a downstream pass (points/labels) usually
            // owns the MSAA resolve. But when hillshade is the LAST colour
            // writer (hillshade-only scene: no points), scene.resolveOwner
            // assigns the resolve HERE — without it the relief lands in the
            // multisample target after the opaque resolve already ran and
            // never reaches the swapchain (black at msaa>1, every backend).
            resolveTarget:
              ctx.useResolve && scene.resolveOwner === 'hillshade' ? sceneResolveView : undefined,
            loadOp: 'load',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: stencilView,
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
      hr.render(
        hsPass,
        host.camera,
        projType,
        centerLon,
        centerLat,
        ctx.scene.w,
        ctx.scene.h,
        host._elapsedMs,
        ctx.scene.dpr,
      )
      hsPass.end()
    })
  }
}

/** Stateless singleton — the hillshade DEM-relief pass. */
export const hillshadePass: RenderPass = new HillshadePass()
