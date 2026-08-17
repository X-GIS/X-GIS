// ═══ Heatmap point split for a tiled GeoJSON source ═══
//
// Extracted from SourceManager (on a shrink-only LOC ceiling), where it was
// duplicated verbatim at both sites that tile a GeoJSON source — the initial
// attach and the #1371 in-place re-seed. Two copies of a filter predicate is
// exactly how the two paths drift apart.

import type { GeoJSONFeatureCollection } from '@xgis/data'

/** Record `source`'s Point/MultiPoint features so the heatmap fork in
 *  `rebuildLayers` can still read them.
 *
 *  Tiling moves a GeoJSON source's points into the tile backend and overwrites
 *  its `rawDatasets` entry with the `{ _vectorTile: true }` marker, so the
 *  points have to be preserved here first. Pass the REPROJECTED collection —
 *  the heatmap coordinates must match the tiled output, not the raw input.
 *
 *  Deletes the entry when there are no points, so a re-seed that removes the
 *  last point does not leave the previous data behind. */
export function setHeatmapPoints(
  store: Map<string, GeoJSONFeatureCollection>,
  source: string,
  data: GeoJSONFeatureCollection,
): void {
  const pts = (data.features ?? []).filter(
    (f) => f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint',
  )
  if (pts.length) {
    store.set(source, { type: 'FeatureCollection', features: pts } as GeoJSONFeatureCollection)
  } else {
    store.delete(source)
  }
}
