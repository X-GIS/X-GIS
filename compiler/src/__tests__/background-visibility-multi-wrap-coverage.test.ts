// Pin background-layer visibility multi-level wrap unwrap. Pre-fix
// the gate at mapbox-to-xgis.ts only recognised single-level
// ['literal', 'none']; preprocessor-emitted ['literal', ['literal',
// 'none']] left the gate false and the background fill emitted
// despite the author's hide.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('background visibility multi-wrap', () => {
  it('double-wrapped visibility:none suppresses background fill', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        {
          id: 'bg',
          type: 'background',
          layout: { visibility: ['literal', ['literal', 'none']] as unknown },
          paint: { 'background-color': '#fff' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    // Background block should NOT be emitted when visibility:none.
    expect(code).not.toContain('background { fill: #fff }')
  })

  it('single-wrap visibility:none still suppresses (regression guard)', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        {
          id: 'bg',
          type: 'background',
          layout: { visibility: ['literal', 'none'] as unknown },
          paint: { 'background-color': '#fff' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toContain('background { fill: #fff }')
  })

  it('bare visibility:none still suppresses (regression guard)', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        {
          id: 'bg',
          type: 'background',
          layout: { visibility: 'none' },
          paint: { 'background-color': '#fff' },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toContain('background { fill: #fff }')
  })

  it('no visibility key still emits background (regression guard)', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#fff' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('background { fill: #fff }')
  })
})
