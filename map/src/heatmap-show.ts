// Heatmap show → HeatmapRenderer.addLayer, extracted verbatim from the
// map.ts rebuild loop (the loop-top routing rationale lives at the call
// site). Points come ONLY from `heatmapPointData` — the reprojected/seeded
// Point FC preserved at attach/seed time; rawDatasets holds the tiling
// marker, not the features.

import { xlog } from '@xgis/shared'
import type { GeoJSONFeatureCollection } from '@xgis/data'
import type { ShowCommand } from './render/renderer-types'
import type { HeatmapRenderer } from './render/heatmap-renderer'
import { applyFilter } from './feature-helpers'

/** The slice of XGISMap the heatmap show build reads. */
export interface HeatmapShowHost {
  heatmapPointData: Map<string, GeoJSONFeatureCollection>
  heatmapRenderer: HeatmapRenderer | null
  camera: { zoom: number; pitch: number }
}

/** Build one heatmap show's density layer. No-ops when the source's point
 *  FC is absent/empty (geojson still streaming — a later rebuild re-adds). */
export function addHeatmapShowLayer(host: HeatmapShowHost, show: ShowCommand): void {
  const hmSource = host.heatmapPointData.get(show.targetName)
  if (hmSource?.features?.length && host.heatmapRenderer) {
    try {
      const feats = applyFilter(
        hmSource,
        show.filterExpr,
        host.camera.zoom,
        host.camera.pitch,
      ).features
      const t = feats[0]?.geometry?.type
      if (t === 'Point' || t === 'MultiPoint') {
        host.heatmapRenderer.addLayer(
          feats,
          show.heatmapRadius ?? 30,
          show.heatmapWeight ?? 1,
          show.heatmapIntensity ?? 1,
          show.heatmapOpacity ?? 1,
          show.heatmapColorStops,
          null,
        )
      }
    } catch (e) {
      xlog.warn('[X-GIS] heatmap layer build failed:', e)
    }
  }
}
