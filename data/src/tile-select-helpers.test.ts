// ═══ tileUrl — {bbox-epsg-3857} substitution tests (#1478) ═══
//
// Covers the ONE new behaviour added to tileUrl(): the WMS-interop bbox
// placeholder. Pure, offline — no fetch, no network. Expected bbox strings were
// derived independently (re-deriving the Web Mercator tile→bbox formula by hand,
// not by importing tileUrl itself) — see the PR description for the derivation.
// Existing {z}/{x}/{y}/{ratio} substitution is exercised only as a smoke check
// that the new branch didn't regress it — it already has its own coverage
// elsewhere in the raster/hillshade renderer paths.

import { describe, it, expect } from 'vitest'
import { tileUrl } from './tile-select-helpers'

describe('tileUrl — {bbox-epsg-3857}', () => {
  it('leaves an ordinary {z}/{x}/{y} template untouched (no bbox placeholder present)', () => {
    const coord = { z: 5, x: 10, y: 12, ox: 10 }
    expect(tileUrl('https://tiles.example.com/{z}/{x}/{y}.png', coord)).toBe(
      'https://tiles.example.com/5/10/12.png',
    )
  })

  it('substitutes {bbox-epsg-3857} for the z=0 whole-world tile', () => {
    expect(tileUrl('…?BBOX={bbox-epsg-3857}', { z: 0, x: 0, y: 0, ox: 0 })).toBe(
      '…?BBOX=-20037508.342789244,-20037508.342789236,20037508.342789244,20037508.342789244',
    )
  })

  it('substitutes {bbox-epsg-3857} for an interior tile (z=3,x=5,y=2)', () => {
    expect(tileUrl('…?BBOX={bbox-epsg-3857}', { z: 3, x: 5, y: 2, ox: 5 })).toBe(
      '…?BBOX=5009377.085697311,5009377.08569731,10018754.171394622,10018754.171394624',
    )
  })

  it('substitutes {bbox-epsg-3857} for an edge tile (z=1,x=0,y=0)', () => {
    expect(tileUrl('…?BBOX={bbox-epsg-3857}', { z: 1, x: 0, y: 0, ox: 0 })).toBe(
      '…?BBOX=-20037508.342789244,-7.081154551613622e-10,0,20037508.342789244',
    )
  })

  it('substitutes both {z}/{x}/{y} and {bbox-epsg-3857} in the same template', () => {
    expect(
      tileUrl('https://wms.example.com/{z}/{x}/{y}?BBOX={bbox-epsg-3857}', {
        z: 0,
        x: 0,
        y: 0,
        ox: 0,
      }),
    ).toBe(
      'https://wms.example.com/0/0/0?BBOX=' +
        '-20037508.342789244,-20037508.342789236,20037508.342789244,20037508.342789244',
    )
  })
})
