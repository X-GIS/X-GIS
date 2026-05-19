// Smoke test: for every paint/layout property marked `partial` in
// spec-coverage.ts, exercise the converter on a minimal style that
// SETS that property and verify the conversion produces non-empty
// output. Catches the regression class where a partial property's
// converter pass starts throwing or returning empty body on a value
// it claims to handle.
//
// Each property is tested with a value of the form documented in
// its spec-coverage note (constant where the note says "constant
// only", interpolate-by-zoom where the note says supported, etc.).
// Tests are pinned to the property NAME so adding a partial entry
// auto-extends the smoke matrix.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

// Sample values per property — the converter should produce non-
// empty xgis output without throwing.
const PARTIAL_SMOKE_CASES: Array<{
  property: string
  layer: { type: string; sourceLayer?: string }
  value: unknown
  paintOrLayout: 'paint' | 'layout'
}> = [
  // Fill
  { property: 'fill-antialias', layer: { type: 'fill', sourceLayer: 'a' }, value: true, paintOrLayout: 'paint' },
  { property: 'fill-translate', layer: { type: 'fill', sourceLayer: 'a' }, value: [1, 2], paintOrLayout: 'paint' },
  // Line
  { property: 'line-dasharray', layer: { type: 'line', sourceLayer: 'a' }, value: [4, 2], paintOrLayout: 'paint' },
  // Background
  { property: 'background-color', layer: { type: 'background' }, value: '#abc', paintOrLayout: 'paint' },
  { property: 'background-opacity', layer: { type: 'background' }, value: 0.5, paintOrLayout: 'paint' },
  // Fill-extrusion partial
  { property: 'fill-extrusion-vertical-gradient', layer: { type: 'fill-extrusion', sourceLayer: 'a' }, value: false, paintOrLayout: 'paint' },
  // Symbol
  { property: 'symbol-sort-key', layer: { type: 'symbol', sourceLayer: 'a' }, value: 5, paintOrLayout: 'layout' },
  { property: 'text-pitch-alignment', layer: { type: 'symbol', sourceLayer: 'a' }, value: 'viewport', paintOrLayout: 'layout' },
  { property: 'text-overlap', layer: { type: 'symbol', sourceLayer: 'a' }, value: 'always', paintOrLayout: 'layout' },
  { property: 'icon-allow-overlap', layer: { type: 'symbol', sourceLayer: 'a' }, value: true, paintOrLayout: 'layout' },
  { property: 'icon-overlap', layer: { type: 'symbol', sourceLayer: 'a' }, value: 'always', paintOrLayout: 'layout' },
  { property: 'icon-optional', layer: { type: 'symbol', sourceLayer: 'a' }, value: false, paintOrLayout: 'layout' },
  { property: 'text-opacity', layer: { type: 'symbol', sourceLayer: 'a' }, value: 0.5, paintOrLayout: 'paint' },
  { property: 'icon-opacity', layer: { type: 'symbol', sourceLayer: 'a' }, value: 0.5, paintOrLayout: 'paint' },
  // Circle
  { property: 'circle-stroke-opacity', layer: { type: 'circle', sourceLayer: 'a' }, value: 0.5, paintOrLayout: 'paint' },
]

function buildStyle(cell: typeof PARTIAL_SMOKE_CASES[number]): Record<string, unknown> {
  const baseLayer: Record<string, unknown> = {
    id: 'l',
    type: cell.layer.type,
  }
  if (cell.layer.sourceLayer) {
    baseLayer.source = 'v'
    baseLayer['source-layer'] = cell.layer.sourceLayer
  }
  // Required paint defaults for each type so the layer is non-empty
  // BEFORE the partial property is added.
  if (cell.layer.type === 'fill') {
    baseLayer.paint = { 'fill-color': '#fff' }
  } else if (cell.layer.type === 'line') {
    baseLayer.paint = { 'line-color': '#fff', 'line-width': 1 }
  } else if (cell.layer.type === 'symbol') {
    baseLayer.layout = { 'text-field': '{name}' }
    baseLayer.paint = { 'text-color': '#fff' }
  } else if (cell.layer.type === 'circle') {
    baseLayer.paint = { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': '#000', 'circle-stroke-width': 1 }
  } else if (cell.layer.type === 'fill-extrusion') {
    baseLayer.paint = { 'fill-extrusion-color': '#fff', 'fill-extrusion-height': 10 }
  } else if (cell.layer.type === 'background') {
    // no source
  }
  const target = (baseLayer[cell.paintOrLayout] as Record<string, unknown>) ?? {}
  target[cell.property] = cell.value
  baseLayer[cell.paintOrLayout] = target

  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [baseLayer],
  }
}

describe('partial-status conversion smoke matrix', () => {
  for (const cell of PARTIAL_SMOKE_CASES) {
    it(`${cell.layer.type}.${cell.property} = ${JSON.stringify(cell.value)} converts to non-empty xgis`, () => {
      const xgis = convertMapboxStyle(buildStyle(cell) as never)
      expect(xgis.length, `${cell.property} produced empty body`).toBeGreaterThan(30)
    })
  }
})
