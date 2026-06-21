// Mapbox `heatmap` layer → xgis heatmap layer (Phase R). The converter
// un-SKIPs heatmap and emits a `heatmap` marker + heatmap-radius/-weight/
// -intensity/-opacity utilities the runtime routes to the HeatmapRenderer.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { convertHeatmapLayer } from '../convert/layers-heatmap'

describe('heatmap layer conversion', () => {
  it('basic heatmap emits a heatmap layer body (not SKIPPED)', () => {
    const style = {
      version: 8,
      sources: { quakes: { type: 'geojson', data: 'quakes.geojson' } },
      layers: [{
        id: 'quake-heat',
        type: 'heatmap',
        source: 'quakes',
        paint: {
          'heatmap-radius': 25,
          'heatmap-weight': 2,
          'heatmap-intensity': 3,
          'heatmap-opacity': 0.8,
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    // sanitizeId maps the `-` in the id to `_`.
    expect(xgis).toContain('layer quake_heat {')
    expect(xgis).not.toContain('SKIPPED')
    // The marker + each scalar paint axis.
    expect(xgis).toContain('heatmap ')      // marker (followed by other utils)
    expect(xgis).toContain('heatmap-radius-25')
    expect(xgis).toContain('heatmap-weight-2')
    expect(xgis).toContain('heatmap-intensity-3')
    expect(xgis).toContain('heatmap-opacity-0.8')
  })

  it('omitted paint props emit Mapbox-spec defaults', () => {
    const warnings: string[] = []
    const out = convertHeatmapLayer(
      { id: 'h', type: 'heatmap', source: 's' } as never,
      warnings,
    )
    expect(out).toContain('layer h {')
    expect(out).toContain('heatmap ')
    expect(out).toContain('heatmap-radius-30')   // spec default
    expect(out).toContain('heatmap-weight-1')
    expect(out).toContain('heatmap-intensity-1')
    expect(out).toContain('heatmap-opacity-1')
  })

  it('zoom-interp radius emits the bracket binding form', () => {
    const warnings: string[] = []
    const out = convertHeatmapLayer(
      {
        id: 'h', type: 'heatmap', source: 's',
        paint: {
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 2, 9, 20],
        },
      } as never,
      warnings,
    )
    expect(out).toContain('heatmap-radius-[')
    expect(out).not.toContain('SKIPPED')
  })

  it('custom heatmap-color warns it falls back to the default ramp', () => {
    const warnings: string[] = []
    convertHeatmapLayer(
      {
        id: 'h', type: 'heatmap', source: 's',
        paint: {
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,255,0)', 1, '#ff0000'],
        },
      } as never,
      warnings,
    )
    expect(warnings.some(w => w.includes('heatmap-color'))).toBe(true)
  })

  it('visibility:none emits visible:false', () => {
    const warnings: string[] = []
    const out = convertHeatmapLayer(
      { id: 'h', type: 'heatmap', source: 's', layout: { visibility: 'none' } } as never,
      warnings,
    )
    expect(out).toContain('visible: false')
  })
})
