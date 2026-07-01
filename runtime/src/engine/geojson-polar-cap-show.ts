// ═══ GeoJSON polar-cap show wiring (issue #360 F1) ═══
//
// Mirror of synthetic-earth-surface-show.ts for the per-source polar-cap
// backend. Builds one ShowCommand targeting `capSourceName(sourceName)`; the
// catalog + VectorTileRenderer pair owned by that cap source carries the z=0
// ECEF cap mesh through the standard polygon ECEF pipeline. The cap fill must
// equal the SOURCE LAYER's polygon fill so the cap continues the ocean/land
// surface seamlessly (blue ocean Arctic / green land Antarctica).

import type { ShowCommand } from './render/renderer-types'
import { defaultRasterShapes } from '@xgis/compiler'
import {
  GeoJSONPolarCapBackend,
  capSourceName,
  type CapPoles,
} from '@xgis/data'
import { TileCatalog } from '@xgis/data'
import { VectorTileRenderer } from './render/vector-tile-renderer'
import { worldBandForProjType } from '@xgis/engine'
import { PROJECTION_NAME_TO_TYPE } from '@xgis/engine'
import type { MapRendererContent } from './render/renderer'
import type { LineRenderer } from '@xgis/map'
import type { GPUContext } from '@xgis/engine'
import { parseHexColor } from '@xgis/map'
import type { GeoJSONFeatureCollection } from '@xgis/data'

/** Host hooks the per-source polar-cap install/detach needs from XGISMap. The
 *  `vtSources` / `rawDatasets` Maps are shared by reference; `showCommands` is
 *  read + replaced through the accessor pair so the host's field stays the
 *  authority. */
export interface PolarCapInstallHost {
  ctx: GPUContext
  renderer: MapRendererContent
  lineRenderer: LineRenderer | null
  projectionName: string
  vtSources: Map<string, { source: TileCatalog; renderer: VectorTileRenderer }>
  rawDatasets: Map<string, GeoJSONFeatureCollection>
  /** Mercator clamp-boundary pole(s) each GeoJSON source touches. */
  geojsonCapPoles: Map<string, CapPoles>
  getShowCommands(): ShowCommand[]
  setShowCommands(shows: ShowCommand[]): void
  teardownSource(sourceId: string): void
}

/** Issue #360 F1 — synthesise per-GeoJSON-source polar caps that fill the ±5°
 *  black hole the geojsonvt/MVT pipeline leaves at the pole on sphere-class
 *  projections. For every GeoJSON source whose outer rings touch a Mercator
 *  clamp boundary (recorded in `geojsonCapPoles` at attach time), creates a
 *  dedicated TileCatalog + VectorTileRenderer + GeoJSONPolarCapBackend and
 *  prepends a cap ShowCommand whose fill equals the source layer's polygon
 *  fill. No-op on mercator-class projections; idempotent per source. */
export function installGeoJSONPolarCaps(host: PolarCapInstallHost): void {
  if (!host.renderer || host.geojsonCapPoles.size === 0) return
  const projType = PROJECTION_NAME_TO_TYPE[host.projectionName] ?? 0
  if (worldBandForProjType(projType) === 'mercator-clamped') return
  for (const [sourceName, poles] of host.geojsonCapPoles) {
    const capSrc = capSourceName(sourceName)
    if (host.vtSources.has(capSrc)) continue
    const rgba = resolveSourceFillRgba(host.getShowCommands(), sourceName)
    if (!rgba) continue // no polygon fill layer resolved — nothing to match
    const catalog = new TileCatalog()
    const vtRenderer = new VectorTileRenderer(host.ctx)
    vtRenderer.setBindGroupLayout(host.renderer.bindGroupLayout)
    vtRenderer.setPaletteResources(host.renderer.paletteColorAtlasView, host.renderer.paletteSampler)
    vtRenderer.setSpriteAtlasView(host.renderer.spriteAtlasView)
    vtRenderer.setExtrudedPipelines(host.renderer.fillPipelineExtruded, host.renderer.fillPipelineExtrudedFallback)
    vtRenderer.setGroundPipelines(host.renderer.fillPipelineGround, host.renderer.fillPipelineGroundFallback)
    vtRenderer.setPatternPipelines(host.renderer.fillPipelinePatternGround, host.renderer.fillPipelinePatternGroundFallback)
    vtRenderer.setPatternExtrudedPipelines(host.renderer.fillPipelinePatternExtruded, host.renderer.fillPipelinePatternExtrudedFallback)
    vtRenderer.setOITPipeline(host.renderer.fillPipelineExtrudedOIT)
    if (host.lineRenderer) vtRenderer.setLineRenderer(host.lineRenderer)
    vtRenderer.setSource(catalog)
    const backend = new GeoJSONPolarCapBackend(sourceName, poles, rgba)
    catalog.attachBackend(backend)
    host.vtSources.set(capSrc, { source: catalog, renderer: vtRenderer })
    host.rawDatasets.set(capSrc, { _vectorTile: true } as unknown as GeoJSONFeatureCollection)
    // Prepend the cap show so it dispatches with the background (ahead of the
    // authored ocean/land layers — the cap continues their surface).
    host.setShowCommands([buildGeoJSONPolarCapShow(capSrc, rgba), ...host.getShowCommands()])
  }
}

/** Tear down every per-source polar cap (projection changed back to a
 *  mercator-class band). Destroys the GPU resources + drops the cap shows. */
export function detachGeoJSONPolarCaps(host: PolarCapInstallHost): void {
  let removed = false
  for (const sourceName of host.geojsonCapPoles.keys()) {
    const capSrc = capSourceName(sourceName)
    if (!host.vtSources.has(capSrc)) continue
    host.teardownSource(capSrc)
    host.rawDatasets.delete(capSrc)
    removed = true
  }
  if (removed) {
    host.setShowCommands(host.getShowCommands().filter((s) => !s.targetName.endsWith('__polar_cap')))
  }
}

/** Resolve a GeoJSON source's POLYGON fill colour from the active show commands
 *  so the cap can match it. Prefers a per-frame `resolvedFillRgba`, then a
 *  constant `paintShapes.fill`, then the static `fill` hex. Picks the first
 *  show targeting `sourceName` that carries a fill (the polygon fill layer); a
 *  stroke-only layer has `fill === null` and is skipped. Null when none. */
function resolveSourceFillRgba(
  shows: readonly ShowCommand[],
  sourceName: string,
): [number, number, number, number] | null {
  for (const show of shows) {
    if (show.targetName !== sourceName) continue
    if (show.resolvedFillRgba) return show.resolvedFillRgba
    const ps = show.paintShapes?.fill.fill
    if (ps && ps.kind === 'constant') return ps.value as [number, number, number, number]
    if (show.fill) return parseHexColor(show.fill)
  }
  return null
}

/** Construct the cap ShowCommand for a GeoJSON source. `capSrc` is the cap
 *  source name (`capSourceName(sourceName)`); `rgba` is the source layer's
 *  resolved polygon fill in straight-alpha unit floats. */
export function buildGeoJSONPolarCapShow(
  capSrc: string,
  rgba: [number, number, number, number],
): ShowCommand {
  return {
    targetName: capSrc,
    sourceLayer: '',
    layerName: capSrc,
    fill: rgbaToHex(rgba),
    stroke: null,
    strokeWidth: 0,
    projection: 'mercator',
    visible: true,
    opacity: 1,
    extrude: { kind: 'none' },
    extrudeBase: { kind: 'none' },
    resolvedFillRgba: rgba,
    paintShapes: {
      fill: { fill: { kind: 'constant', value: rgba } },
      line: {
        stroke: null,
        strokeWidth: { kind: 'constant', value: 0 },
      },
      circle: { size: null },
      common: { opacity: { kind: 'constant', value: 1 } },
      raster: defaultRasterShapes(),
    },
  }
}

/** Mutate the cap show in-place to point at a new fill colour. Mirrors
 *  updateSyntheticEarthSurfaceShowFill — bumps the legacy hex + the typed
 *  PropertyShape so reference-identity resolveShow caches invalidate. */
export function updateGeoJSONPolarCapShowFill(
  show: ShowCommand,
  rgba: [number, number, number, number],
): void {
  show.fill = rgbaToHex(rgba)
  show.resolvedFillRgba = rgba
  show.paintShapes = {
    ...show.paintShapes,
    fill: { fill: { kind: 'constant', value: rgba } },
  }
}

function rgbaToHex(rgba: [number, number, number, number]): string {
  const r = clamp01ToByte(rgba[0])
  const g = clamp01ToByte(rgba[1])
  const b = clamp01ToByte(rgba[2])
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

function clamp01ToByte(c: number): number {
  if (!Number.isFinite(c)) return 0
  return Math.max(0, Math.min(255, Math.round(c * 255)))
}
