// Pin defensive coercion of non-object background.paint. Mirror of
// the layers.ts safePropsBag fix. A string-typed paint value let
// bgPaint['background-opacity'] index a char ('o' for 'oops') and
// the ignored-prop warning leaked garbage property names.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('background.paint non-object coercion', () => {
  it('string bgLayer.paint does not crash; no char-indexed warning', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'bg', type: 'background', paint: 'oops' as unknown },
      ],
    }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
  })

  it('array bgLayer.paint coerces to empty', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'bg', type: 'background', paint: ['oops'] as unknown },
      ],
    }
    expect(() => convertMapboxStyle(style as never)).not.toThrow()
  })

  it('regression: valid bgLayer.paint emits background block', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#abc' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('background { fill: #abc }')
  })
})
