// Compiler property × value-form matrix: every (layer-type, property,
// value-form) cell that the runtime claims to support (via
// runtime/capabilities.ts) must compile WITHOUT a warning.
//
// Catches the regression class where a converter pass silently
// stops handling, say, line-color zoom-interp, and the breakage
// only surfaces at runtime as "no colour rendered" on the
// affected layers.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

interface MatrixCell {
  layerType: string
  property: string
  valueForm: 'constant' | 'zoom-interp' | 'data-driven'
  // Sample value for each form
  value: unknown
}

const NUMERIC_CONSTANT = 5
const NUMERIC_ZOOM_INTERP = ['interpolate', ['linear'], ['zoom'], 5, 1, 15, 10]
const NUMERIC_DATA_DRIVEN = ['case', ['==', ['get', 'class'], 'motorway'], 4, 1]
const COLOR_CONSTANT = '#ff0000'
const COLOR_ZOOM_INTERP = ['interpolate', ['linear'], ['zoom'], 5, '#ff0000', 15, '#00ff00']
const COLOR_DATA_DRIVEN = ['case', ['==', ['get', 'class'], 'motorway'], '#ff0000', '#888']
// Densification value-forms (iter 60-62) — exercise the compile-time
// approximations for cubic-bezier eased curves + Lab/LCh perceptual
// colour-space interpolation across zoom + data-driven inputs. Each
// must compile without fatal warnings even though spec-coverage marks
// the operators as `partial`.
const NUMERIC_ZOOM_BEZIER = [
  'interpolate',
  ['cubic-bezier', 0.42, 0, 0.58, 1],
  ['zoom'],
  5,
  1,
  15,
  10,
]
const COLOR_ZOOM_LAB = ['interpolate-lab', ['linear'], ['zoom'], 5, '#ff0000', 15, '#00ff00']
const COLOR_ZOOM_HCL = ['interpolate-hcl', ['linear'], ['zoom'], 5, '#ff0000', 15, '#00ff00']
const NUMERIC_DATA_BEZIER = [
  'interpolate',
  ['cubic-bezier', 0.25, 0.1, 0.25, 1],
  ['get', 'mag'],
  0,
  1,
  10,
  20,
]
const COLOR_DATA_LAB = ['interpolate-lab', ['linear'], ['get', 'idx'], 0, '#000', 1, '#fff']

const CELLS: MatrixCell[] = [
  // fill
  { layerType: 'fill', property: 'fill-color', valueForm: 'constant', value: COLOR_CONSTANT },
  { layerType: 'fill', property: 'fill-color', valueForm: 'zoom-interp', value: COLOR_ZOOM_INTERP },
  { layerType: 'fill', property: 'fill-color', valueForm: 'data-driven', value: COLOR_DATA_DRIVEN },
  { layerType: 'fill', property: 'fill-opacity', valueForm: 'constant', value: 0.5 },
  {
    layerType: 'fill',
    property: 'fill-opacity',
    valueForm: 'zoom-interp',
    value: NUMERIC_ZOOM_INTERP,
  },

  // line
  { layerType: 'line', property: 'line-color', valueForm: 'constant', value: COLOR_CONSTANT },
  { layerType: 'line', property: 'line-color', valueForm: 'zoom-interp', value: COLOR_ZOOM_INTERP },
  { layerType: 'line', property: 'line-color', valueForm: 'data-driven', value: COLOR_DATA_DRIVEN },
  { layerType: 'line', property: 'line-width', valueForm: 'constant', value: NUMERIC_CONSTANT },
  {
    layerType: 'line',
    property: 'line-width',
    valueForm: 'zoom-interp',
    value: NUMERIC_ZOOM_INTERP,
  },
  {
    layerType: 'line',
    property: 'line-width',
    valueForm: 'data-driven',
    value: NUMERIC_DATA_DRIVEN,
  },
  { layerType: 'line', property: 'line-opacity', valueForm: 'constant', value: 0.5 },
  {
    layerType: 'line',
    property: 'line-opacity',
    valueForm: 'zoom-interp',
    value: NUMERIC_ZOOM_INTERP,
  },

  // circle
  {
    layerType: 'circle',
    property: 'circle-radius',
    valueForm: 'constant',
    value: NUMERIC_CONSTANT,
  },
  {
    layerType: 'circle',
    property: 'circle-radius',
    valueForm: 'zoom-interp',
    value: NUMERIC_ZOOM_INTERP,
  },
  {
    layerType: 'circle',
    property: 'circle-radius',
    valueForm: 'data-driven',
    value: NUMERIC_DATA_DRIVEN,
  },
  { layerType: 'circle', property: 'circle-color', valueForm: 'constant', value: COLOR_CONSTANT },
  {
    layerType: 'circle',
    property: 'circle-color',
    valueForm: 'zoom-interp',
    value: COLOR_ZOOM_INTERP,
  },
  {
    layerType: 'circle',
    property: 'circle-color',
    valueForm: 'data-driven',
    value: COLOR_DATA_DRIVEN,
  },

  // fill-extrusion
  {
    layerType: 'fill-extrusion',
    property: 'fill-extrusion-color',
    valueForm: 'constant',
    value: COLOR_CONSTANT,
  },
  {
    layerType: 'fill-extrusion',
    property: 'fill-extrusion-color',
    valueForm: 'zoom-interp',
    value: COLOR_ZOOM_INTERP,
  },
  {
    layerType: 'fill-extrusion',
    property: 'fill-extrusion-height',
    valueForm: 'constant',
    value: 10,
  },
  {
    layerType: 'fill-extrusion',
    property: 'fill-extrusion-height',
    valueForm: 'zoom-interp',
    value: NUMERIC_ZOOM_INTERP,
  },
  {
    layerType: 'fill-extrusion',
    property: 'fill-extrusion-height',
    valueForm: 'data-driven',
    value: NUMERIC_DATA_DRIVEN,
  },

  // Densified curve / colour-space forms (iter 60-62 compile-time
  // approximations). The runtime sees an ordinary linear interpolate
  // with denser stops — these cells exercise the compile-time path
  // that synthesises the dense form.
  {
    layerType: 'line',
    property: 'line-width',
    valueForm: 'zoom-interp',
    value: NUMERIC_ZOOM_BEZIER,
  },
  {
    layerType: 'line',
    property: 'line-width',
    valueForm: 'data-driven',
    value: NUMERIC_DATA_BEZIER,
  },
  { layerType: 'fill', property: 'fill-color', valueForm: 'zoom-interp', value: COLOR_ZOOM_LAB },
  { layerType: 'fill', property: 'fill-color', valueForm: 'zoom-interp', value: COLOR_ZOOM_HCL },
  { layerType: 'fill', property: 'fill-color', valueForm: 'data-driven', value: COLOR_DATA_LAB },
]

function buildStyle(cell: MatrixCell): Record<string, unknown> {
  return {
    version: 8,
    sources: {
      v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] },
    },
    layers: [
      {
        id: 'cell',
        type: cell.layerType,
        source: 'v',
        'source-layer': 'test',
        paint: { [cell.property]: cell.value },
      },
    ],
  }
}

describe('compiler property × value-form matrix', () => {
  for (const cell of CELLS) {
    it(`compiles ${cell.layerType}.${cell.property} (${cell.valueForm}) without dropping`, () => {
      const coverage = { sources: [], layers: [], warnings: [] as string[] }
      const xgis = convertMapboxStyle(buildStyle(cell), { coverage })
      expect(
        xgis.length,
        `${cell.layerType}.${cell.property} produced empty output`,
      ).toBeGreaterThan(50)
      // The property's converter should NOT log "failed to convert"
      // / "Expression not converted" for these supported forms. Other
      // warnings (e.g. partial-drop on unrelated arms) are tolerated.
      const fatalWarn = coverage.warnings.find(
        (w) =>
          w.includes('failed to convert') ||
          w.includes('Expression not converted') ||
          w.includes('depth exceeded'),
      )
      expect(
        fatalWarn,
        `${cell.layerType}.${cell.property} (${cell.valueForm}) fatal warning: ${fatalWarn ?? 'none'}`,
      ).toBeUndefined()
    })
  }

  it('matrix has at least 20 cells (regression: someone deleted CELLS entries)', () => {
    expect(CELLS.length).toBeGreaterThanOrEqual(20)
  })
})
