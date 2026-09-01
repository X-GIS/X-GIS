// ═══ MapLibre `sky` root → setAtmosphere({ sky }) extraction (#2052 T5 Phase 1) ═══
//
// `extractMapboxSky` is the host-apply seam the design doc mandates for row 2 — the same
// shape `extractMapboxLight` already uses for `light`, so the xgis grammar gains nothing.
// Two things are pinned here, and the second is the one that carries the phase's invariant:
//
//   1. the three properties this phase CARRIES are lifted, in the units the host wants;
//   2. a style with no `sky` (or a sky whose properties are all expressions / all later
//      phases) returns NULL, so the runner never calls setAtmosphere at all and the frame
//      stays byte-identical. Returning `{}` here would silently switch the sky ON with
//      default colours for every style in the corpus.
//
// `parseCssRGBA` grew an alpha channel for this (light drops it); its own forms are covered
// because a mis-parsed alpha is invisible in a colour that happens to be opaque.

import { describe, it, expect } from 'vitest'
import { extractMapboxSky, extractMapboxLight } from './mapbox-projection'

describe('extractMapboxSky (#2052 Phase 1)', () => {
  it('lifts the three carried properties', () => {
    expect(
      extractMapboxSky({
        sky: {
          'sky-color': '#88C6FC',
          'horizon-color': '#ffffff',
          'sky-horizon-blend': 0.5,
        },
      }),
    ).toEqual({
      color: [0x88 / 255, 0xc6 / 255, 0xfc / 255, 1],
      horizonColor: [1, 1, 1, 1],
      horizonBlend: 0.5,
    })
  })

  it('returns null with no sky block at all — the byte-identity arm', () => {
    expect(extractMapboxSky({ version: 8, layers: [] })).toBeNull()
    expect(extractMapboxSky({ sky: null })).toBeNull()
    expect(extractMapboxSky(null)).toBeNull()
    expect(extractMapboxSky('nonsense')).toBeNull()
  })

  it('returns null for a sky that authors ONLY later-phase properties', () => {
    // A real MapLibre style can carry the below-horizon fog band alone. Phase 1 carries
    // none of it, so there is nothing to apply and the sky must stay OFF rather than come
    // up in default blue.
    expect(
      extractMapboxSky({
        sky: { 'fog-color': '#fff', 'fog-ground-blend': 0.5, 'atmosphere-blend': 0.8 },
      }),
    ).toBeNull()
  })

  it('skips an expression-valued property but keeps its constant siblings', () => {
    expect(
      extractMapboxSky({
        sky: {
          'sky-color': ['interpolate', ['linear'], ['zoom'], 0, '#000', 10, '#fff'],
          'horizon-color': '#102030',
          'sky-horizon-blend': 0.2,
        },
      }),
    ).toEqual({ horizonColor: [0x10 / 255, 0x20 / 255, 0x30 / 255, 1], horizonBlend: 0.2 })
  })

  it('drops a non-finite blend rather than passing NaN to the host', () => {
    expect(extractMapboxSky({ sky: { 'sky-horizon-blend': Number.NaN } })).toBeNull()
    expect(extractMapboxSky({ sky: { 'sky-horizon-blend': '0.5' } })).toBeNull()
  })

  it('carries alpha from every CSS form the sky ramp can be authored in', () => {
    const a = (s: string) => extractMapboxSky({ sky: { 'sky-color': s } })?.color
    expect(a('#0000')).toEqual([0, 0, 0, 0])
    expect(a('#ff000080')).toEqual([1, 0, 0, 0x80 / 255])
    expect(a('rgba(255, 0, 0, 0.25)')).toEqual([1, 0, 0, 0.25])
    expect(a('rgb(255, 0, 0)')).toEqual([1, 0, 0, 1])
    expect(a('white')).toEqual([1, 1, 1, 1])
    expect(a('not-a-colour')).toBeUndefined()
  })
})

describe('extractMapboxLight — unchanged by the RGBA widening', () => {
  it('still yields a 3-channel colour, alpha dropped', () => {
    expect(extractMapboxLight({ light: { color: 'rgba(255, 128, 0, 0.5)' } })).toEqual({
      color: [1, 128 / 255, 0],
    })
    expect(extractMapboxLight({ light: { color: '#fff', intensity: 0.3 } })).toEqual({
      color: [1, 1, 1],
      intensity: 0.3,
    })
    expect(extractMapboxLight({ light: { color: 'bogus' } })).toBeNull()
  })
})
