// ═══ rasterCoverZoom — tileSize-aware raster cover-zoom gate ═══
//
// The camera zoom is the Mapbox/MapLibre 512-px-tile convention (camera.ts
// TILE_PX = 512): at zoom Z one z=Z tile spans 512 CSS px. MapLibre's
// Transform#coveringZoomLevel for a raster source is
//   round(zoom + log2(512 / tileSize))
// so a 256-px XYZ source (OSM / Esri / terrarium — the de-facto standard)
// fetches z+1 and each tile spans 256 CSS px (1 texel : 1 CSS px). The old
// `round(zoom)` selection rendered every 256-px raster one LOD low — the
// user-visible "raster tiles look blurry / low-res" bug this gate pins.

import { describe, it, expect } from 'vitest'
import { rasterCoverZoom } from './raster-renderer'

describe('rasterCoverZoom', () => {
  it('256-px tiles cover at z+1 (MapLibre coveringZoomLevel parity)', () => {
    expect(rasterCoverZoom(0, 256)).toBe(1)
    expect(rasterCoverZoom(3, 256)).toBe(4)
    expect(rasterCoverZoom(12.5, 256)).toBe(14) // round(12.5 + 1)
    expect(rasterCoverZoom(12.49, 256)).toBe(13)
  })

  it('512-px tiles keep the legacy round(zoom) selection', () => {
    expect(rasterCoverZoom(0, 512)).toBe(0)
    expect(rasterCoverZoom(3.4, 512)).toBe(3)
    expect(rasterCoverZoom(3.5, 512)).toBe(4)
    expect(rasterCoverZoom(12.5, 512)).toBe(13)
  })

  it('sampling density: one 256-px tile at z+1 spans 256 CSS px (1:1 texels)', () => {
    // World width in CSS px at zoom Z is 512·2^Z; at tile z there are 2^z
    // tiles across, so one tile spans 512·2^(Z−z) CSS px. For the 256 bias
    // (z = Z+1 at integer Z) that is 256 CSS px — exactly the texture size.
    const Z = 5
    const z = rasterCoverZoom(Z, 256)
    const tileSpanCssPx = 512 * Math.pow(2, Z - z)
    expect(tileSpanCssPx).toBe(256)
  })

  it('clamps to the [0, 18] pyramid', () => {
    expect(rasterCoverZoom(-2, 256)).toBe(0)
    expect(rasterCoverZoom(0, 512)).toBe(0)
    expect(rasterCoverZoom(18.4, 256)).toBe(18)
    expect(rasterCoverZoom(25, 512)).toBe(18)
  })
})

// ── Source-level maxzoom (the 404 class) ──
//
// A dataset has a deepest REAL level, and asking past it is a guaranteed 404 — not a
// tile that merely takes a while. The AWS terrarium bucket stops at z15, and the +1
// bias above means a 256-px source outruns it from about camera z14.5, so EVERY visible
// tile fails. Verified against the reported failure and its own lineage:
//
//   terrarium/16/13651/25075  -> 404
//   terrarium/15/6825/12537   -> 200, 101 540 bytes
//   terrarium/14/3412/6268    -> 200, 112 775 bytes
//
// Clamping keeps requesting the deepest real level and lets it draw magnified — MapLibre's
// Transform#coveringZoomLevel behaviour. #1405's backoff then goes back to being a safety
// net for genuinely-missing tiles instead of the only defence against a storm the selector
// itself created.
describe('rasterCoverZoom — source maxzoom', () => {
  it('clamps to the dataset depth instead of asking for tiles that cannot exist', () => {
    // The exact case reported: camera past terrarium's z15 on a 256-px source.
    expect(rasterCoverZoom(15, 256)).toBe(16) // before: the 404
    expect(rasterCoverZoom(15, 256, 15)).toBe(15) // after: the deepest REAL level
    expect(rasterCoverZoom(17, 256, 15)).toBe(15) // and it stays there, over-zoomed
    expect(rasterCoverZoom(22, 256, 15)).toBe(15)
  })

  it('leaves every source that declares nothing exactly as it was', () => {
    // The whole change must be inert for the sources already working — undefined is
    // unbounded, which is what every style says today.
    for (const z of [0, 3, 7, 12.5, 14, 18, 25])
      for (const ts of [256, 512])
        expect(rasterCoverZoom(z, ts, undefined)).toBe(rasterCoverZoom(z, ts))
  })

  it('still honours the pyramid cap when a source claims to go deeper', () => {
    // A style may declare maxzoom 22; the selector's own [0,18] ceiling still wins, so a
    // bogus declaration cannot push the pyramid past what the rest of the engine expects.
    expect(rasterCoverZoom(25, 512, 22)).toBe(18)
  })

  it('does not raise the zoom — a shallow camera is unaffected by a deep source', () => {
    // Clamping is a MAXIMUM, not a target: at z3 a maxzoom-15 source still covers at z4.
    expect(rasterCoverZoom(3, 256, 15)).toBe(4)
  })

  it('a maxzoom BELOW the camera floor still yields a valid level', () => {
    // maxzoom 0 is legal (a single world tile) and must not produce a negative zoom.
    expect(rasterCoverZoom(9, 256, 0)).toBe(0)
  })
})
