// Background-opacity constant fold (mirror of iter 4 circle-stroke-
// opacity fold). When both background-color hex AND a constant
// numeric background-opacity < 1 are authored, fold the opacity
// into the hex alpha channel so the layer renders at the requested
// alpha. Zoom-interp / data-driven forms still warn.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function build(opacity: unknown) {
  return {
    version: 8,
    sources: {},
    layers: [{
      id: 'bg',
      type: 'background',
      paint: {
        'background-color': '#ff8000',
        'background-opacity': opacity,
      },
    }],
  }
}

describe('background-opacity constant fold', () => {
  it('omitted → emits 6-char hex (alpha=1)', () => {
    const xgis = convertMapboxStyle({
      version: 8, sources: {},
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#ff8000' } }],
    } as never)
    expect(xgis).toContain('background { fill: #ff8000 }')
  })

  it('explicit 1 → no fold, 6-char hex stays', () => {
    const xgis = convertMapboxStyle(build(1) as never)
    expect(xgis).toContain('background { fill: #ff8000 }')
  })

  it('0.5 → folds into 8-char hex with 0x80 alpha', () => {
    const xgis = convertMapboxStyle(build(0.5) as never)
    expect(xgis).toContain('background { fill: #ff800080 }')
  })

  it('0 → fully transparent (8-char hex with 00 alpha)', () => {
    const xgis = convertMapboxStyle(build(0) as never)
    expect(xgis).toContain('background { fill: #ff800000 }')
  })

  it('["literal", 0.5] → unwraps + folds', () => {
    const xgis = convertMapboxStyle(build(['literal', 0.5]) as never)
    expect(xgis).toContain('background { fill: #ff800080 }')
  })

  it('out-of-range >1 clamps to 1 (no alpha fold)', () => {
    const xgis = convertMapboxStyle(build(1.5) as never)
    expect(xgis).toContain('background { fill: #ff8000 }')
  })

  it('negative clamps to 0', () => {
    const xgis = convertMapboxStyle(build(-0.5) as never)
    expect(xgis).toContain('background { fill: #ff800000 }')
  })
})
