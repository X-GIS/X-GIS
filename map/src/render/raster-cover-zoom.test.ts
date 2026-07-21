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
