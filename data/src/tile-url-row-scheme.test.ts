// #1985 (ADR-0012 Phase B4) — the row origin at the ONE tile-URL builder.
//
// `tileUrl` is the single authority that turns a template + TileCoord into a request
// URL for every path that reaches it (RasterRenderer.render, HillshadeRenderer.render,
// wmsGetMapUrl). Both halves of this issue live here, so neither renderer can drift
// from the other:
//
//   • `scheme: 'tms'` → `{y}` substitutes the BOTTOM-origin row `2^z − 1 − y`;
//   • `{-y}` → always the bottom-origin row, whatever the scheme is.
//
// SEMANTICS, with sources — the decision this file pins:
//
//   MapLibre GL JS, `src/tile/tile_id.ts`, `CanonicalTileID.url()`:
//     .replace(/{y}/g, String(scheme === 'tms' ? (Math.pow(2, this.z) - this.y - 1) : this.y))
//   …and that is its ONLY scheme branch — MapLibre has no `{-y}` placeholder at all.
//
//   Leaflet, `src/layer/tile/TileLayer.js`, `getTileUrl(coords)`:
//     const invertedY = this._globalTileRange.max.y - coords.y;
//     if (this.options.tms) { data['y'] = invertedY; }
//     data['-y'] = invertedY;
//   `-y` is assigned UNCONDITIONALLY; `tms` only additionally overwrites `y`. So `{-y}`
//   is scheme-INDEPENDENT: it is never "flipped-of-flipped", and it never reverts to the
//   original row inside a tms source.
//
// We take `{y}` from MapLibre and `{-y}` from Leaflet, which is the only combination
// where no case is wrong: `{z}/{x}/{-y}` on an xyz source, `{z}/{x}/{y}` on a tms
// source, and `{z}/{x}/{-y}` on a tms source all name the TMS row of a TMS endpoint.
// The rejected alternative — `{-y}` re-flipping under tms, so it yields the original
// row — matches NEITHER reference renderer and would make the token mean two different
// things depending on a property declared elsewhere in the source block.

import { describe, it, expect } from 'vitest'
import { tileUrl } from './tile-select-helpers'
import type { TileCoord } from './tile-select-types'

const at = (z: number, x: number, y: number): TileCoord => ({ z, x, y, ox: x })

const T = 'https://tiles.example.com/{z}/{x}/{y}.png'
const T_NEG = 'https://tiles.example.com/{z}/{x}/{-y}.png'

describe("#1985 W1 — `scheme: 'tms'` flips the row substituted for {y}", () => {
  it("the issue's witness: z=2, y=1 fetches .../2/1/2.png under tms", () => {
    // 2^2 − 1 − 1 = 2.
    expect(tileUrl(T, at(2, 1, 1), 'tms')).toBe('https://tiles.example.com/2/1/2.png')
  })

  it('the same coord under xyz fetches .../2/1/1.png — the regression guard', () => {
    expect(tileUrl(T, at(2, 1, 1), 'xyz')).toBe('https://tiles.example.com/2/1/1.png')
  })

  it('an omitted scheme is byte-identical to an explicit xyz (the pre-#1985 path)', () => {
    for (const c of [at(0, 0, 0), at(2, 1, 1), at(5, 17, 9), at(14, 8192, 5461)]) {
      expect(tileUrl(T, c)).toBe(tileUrl(T, c, 'xyz'))
    }
  })

  it('the flip is an involution: flipping the tms row back lands on the original', () => {
    // y' = 2^z − 1 − y, so the tms URL for row y equals the xyz URL for row y'.
    for (let z = 0; z <= 8; z++) {
      const n = Math.pow(2, z)
      for (const y of [0, 1, n - 1, Math.floor(n / 2)]) {
        const flipped = n - 1 - y
        expect(tileUrl(T, at(z, 3, y), 'tms')).toBe(tileUrl(T, at(z, 3, flipped), 'xyz'))
      }
    }
  })

  it('z=0 has one row, so tms and xyz agree there', () => {
    expect(tileUrl(T, at(0, 0, 0), 'tms')).toBe(tileUrl(T, at(0, 0, 0), 'xyz'))
  })

  it('EVERY {y} occurrence flips, not just the first (the global-replace contract)', () => {
    expect(tileUrl('https://h/{z}/{x}/{y}/{y}-{x}.png', at(3, 2, 1), 'tms')).toBe(
      'https://h/3/2/6/6-2.png',
    )
  })

  it('x and z are untouched by the scheme', () => {
    expect(tileUrl(T, at(4, 11, 3), 'tms')).toBe('https://tiles.example.com/4/11/12.png')
  })
})

describe('#1985 W2 — `{-y}` is the bottom-origin row, independent of the scheme', () => {
  it('substitutes the flipped row in an xyz source (Leaflet: -y is always inverted)', () => {
    expect(tileUrl(T_NEG, at(2, 1, 1), 'xyz')).toBe('https://tiles.example.com/2/1/2.png')
  })

  it('substitutes the flipped row with NO scheme declared at all', () => {
    expect(tileUrl(T_NEG, at(2, 1, 1))).toBe('https://tiles.example.com/2/1/2.png')
  })

  it('stays the flipped row in a tms source — never flipped-of-flipped', () => {
    // The rejected alternative would produce .../2/1/1.png here.
    expect(tileUrl(T_NEG, at(2, 1, 1), 'tms')).toBe('https://tiles.example.com/2/1/2.png')
  })

  it('{y} and {-y} resolve to the SAME value inside one tms template (Leaflet tms:true)', () => {
    expect(tileUrl('https://h/{z}/{y}/{-y}.png', at(3, 0, 2), 'tms')).toBe('https://h/3/5/5.png')
  })

  it('{y} and {-y} DIFFER inside one xyz template', () => {
    expect(tileUrl('https://h/{z}/{y}/{-y}.png', at(3, 0, 2), 'xyz')).toBe('https://h/3/2/5.png')
  })

  it('the {-y} token cannot be corrupted by the {y} pass, in either order', () => {
    // `/\{y\}/` cannot match inside `{-y}` — the `{` is followed by `-`. Pinned so a
    // future re-order of the replace chain cannot silently produce `{-2}`.
    const out = tileUrl('https://h/{-y}/{y}/{-y}.png', at(4, 0, 3), 'xyz')
    expect(out).toBe('https://h/12/3/12.png')
    expect(out).not.toContain('{')
    expect(out).not.toContain('-y')
  })

  it('EVERY {-y} occurrence substitutes (global replace, like its siblings)', () => {
    expect(tileUrl('https://h/{-y}/{-y}/{-y}.png', at(2, 0, 0), 'xyz')).toBe('https://h/3/3/3.png')
  })
})

describe('#1985 W3 — nothing else in tileUrl changes shape', () => {
  it('a template with no y token at all is unaffected by the scheme', () => {
    const s = 'https://h/static.png'
    expect(tileUrl(s, at(2, 1, 1), 'tms')).toBe(s)
    expect(tileUrl(s, at(2, 1, 1), 'xyz')).toBe(s)
  })

  it('{ratio} still substitutes to the 1x empty string alongside a tms flip', () => {
    expect(tileUrl('https://h/{z}/{x}/{y}{ratio}.png', at(2, 1, 1), 'tms')).toBe(
      'https://h/2/1/2.png',
    )
  })

  it('{bbox-epsg-3857} is GEOGRAPHIC — the scheme must not move it', () => {
    // MapLibre computes the bbox from `this.y` directly, never the flipped row: the box
    // is where the tile IS, not how the server numbers its rows. A scheme that leaked
    // into the bbox would silently fetch a WMS image for the wrong latitude band.
    const s = 'https://h/wms?BBOX={bbox-epsg-3857}'
    expect(tileUrl(s, at(2, 1, 1), 'tms')).toBe(tileUrl(s, at(2, 1, 1), 'xyz'))
  })
})
