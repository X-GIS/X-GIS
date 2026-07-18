// ═══ Shared scene-renderer builder (#1153 P1, #7) ═══
//
// The GPU-resident renderer set every scene needs, built from one authority so
// run() (.xgis) and runBinary() (.xgb) can never drift. runBinary() historically
// built only a subset (no ShapeRegistry, no LineRenderer, no
// pointRenderer.setShapeRegistry), so after an .xgis→.xgb swap line + shape
// rendering silently pointed at a DESTROYED rhi (or null). Routing both paths
// through buildSceneRenderers closes that gap by construction.
//
// A failed constructor branch yields `null` (matching run()'s original per-block
// try/catch); the caller overwrites its field with that null, which is part of
// the #7 fix — _releaseGpuResources never cleared pointRenderer / shapeRegistry /
// lineRenderer, so a re-run whose ctor fails would otherwise keep the stale
// prior-run instance.

import { xlog } from '@xgis/shared'
import { GPU_PROF, GPUTimer, type GPUContext } from '@xgis/rhi-webgpu'
import { MapRendererContent } from './render/renderer'
import { RasterRenderer } from './render/raster-renderer'
import { HillshadeRenderer } from './render/hillshade-renderer'
import { PointRenderer } from './render/point-renderer'
import { ShapeRegistry } from './text/sdf-shape'
import { HeatmapRenderer } from './render/heatmap-renderer'
import { LineRenderer } from './render/line-renderer'
import type { SceneCommands } from './interpreter'

/** The renderer set a scene mounts on a freshly-published ctx. Non-null fields
 *  always construct; the nullable fields degrade to `null` on a ctor failure
 *  (logged) so a partial GPU init can't wedge the whole map. */
export interface SceneRendererSet {
  renderer: MapRendererContent
  rasterRenderer: RasterRenderer
  hillshadeRenderer: HillshadeRenderer
  gpuTimer: GPUTimer | null
  pointRenderer: PointRenderer | null
  shapeRegistry: ShapeRegistry | null
  heatmapRenderer: HeatmapRenderer | null
  lineRenderer: LineRenderer | null
}

/** Build the common renderer set for `ctx`. `opts.symbols` are the DSL
 *  user-defined symbols (run() only; the binary path passes `undefined`). */
export function buildSceneRenderers(
  ctx: GPUContext,
  opts: { graticuleInitial: boolean; symbols?: SceneCommands['symbols'] },
): SceneRendererSet {
  const renderer = new MapRendererContent(ctx)
  renderer.setGraticuleEnabled(opts.graticuleInitial)
  const rasterRenderer = new RasterRenderer(ctx)
  const hillshadeRenderer = new HillshadeRenderer(ctx)
  const gpuTimer = GPU_PROF ? new GPUTimer(ctx) : null

  let pointRenderer: PointRenderer | null = null
  let shapeRegistry: ShapeRegistry | null = null
  try {
    pointRenderer = new PointRenderer(ctx)
    shapeRegistry = new ShapeRegistry(ctx.rhi)
    // Register user-defined symbols from DSL under the `user:` namespace
    // so they shadow built-ins of the same name instead of being silently
    // dropped by the duplicate-name guard in `addShape`.
    for (const sym of opts.symbols ?? []) {
      for (const path of sym.paths) {
        shapeRegistry.addUserShape(sym.name, path)
      }
    }
    shapeRegistry.uploadToGPU()
    pointRenderer.setShapeRegistry(shapeRegistry)
  } catch (e) {
    xlog.warn('[X-GIS] PointRenderer init failed:', e)
  }
  // Heatmap renderer (Phase R) — owns the accum pipeline + per-layer
  // density buffers; the blur/compose pipelines live in pipeline-factory.
  let heatmapRenderer: HeatmapRenderer | null = null
  try {
    heatmapRenderer = new HeatmapRenderer(ctx)
  } catch (e) {
    xlog.warn('[X-GIS] HeatmapRenderer init failed:', e)
  }

  // SDF line renderer (shared by all VTR instances)
  let lineRenderer: LineRenderer | null = null
  try {
    lineRenderer = new LineRenderer(ctx, renderer.bindGroupLayout)
    if (shapeRegistry) lineRenderer.setShapeRegistry(shapeRegistry)
  } catch (e) {
    xlog.warn('[X-GIS] LineRenderer init failed:', e)
  }

  return {
    renderer,
    rasterRenderer,
    hillshadeRenderer,
    gpuTimer,
    pointRenderer,
    shapeRegistry,
    heatmapRenderer,
    lineRenderer,
  }
}
