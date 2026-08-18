// ═══ wms-xyz-adapter — pure URL-mapping tests (#1478) ═══
//
// OFFLINE ONLY, by design (CLAUDE.md §5 / the issue's own Constraints section):
// no fetch, no live nowCOAST endpoint, no map instance. `wmsGetMapUrl`/
// `wmsRasterTemplate` are pure functions of their inputs, so every assertion here
// is an exact-string comparison against a URL computed independently (by hand,
// re-deriving the Web Mercator bbox formula, not by importing the implementation
// under test) — see the PR description for the derivation.

import { describe, it, expect } from 'vitest'
import { wmsRasterTemplate, wmsGetMapUrl, type WmsAdapterOptions } from './wms-xyz-adapter'

describe('wmsRasterTemplate', () => {
  it('builds a GetMap template with defaults (1.3.0, CRS, 256px, png, transparent)', () => {
    const options: WmsAdapterOptions = {
      baseUrl: 'https://nowcoast.noaa.gov/geoserver/wms',
      layers: 'mrms:conus_base_reflectivity_mosaic',
    }
    expect(wmsRasterTemplate(options)).toBe(
      'https://nowcoast.noaa.gov/geoserver/wms?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&' +
        'LAYERS=mrms%3Aconus_base_reflectivity_mosaic&STYLES=&CRS=EPSG:3857&' +
        'BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image%2Fpng&TRANSPARENT=TRUE',
    )
  })

  it('1.1.1 sends SRS instead of CRS, and honours format/tileSize/styles/transparent', () => {
    const options: WmsAdapterOptions = {
      baseUrl: 'https://example.com/wms',
      layers: 'foo:bar',
      version: '1.1.1',
      format: 'image/jpeg',
      tileSize: 512,
      styles: 'default',
      transparent: false,
    }
    const template = wmsRasterTemplate(options)
    expect(template).toContain('VERSION=1.1.1')
    expect(template).toContain('SRS=EPSG:3857')
    expect(template).not.toContain('CRS=EPSG:3857') // SRS must not also appear as CRS
    expect(template).toContain('WIDTH=512&HEIGHT=512')
    expect(template).toContain('FORMAT=image%2Fjpeg')
    expect(template).toContain('TRANSPARENT=FALSE')
    expect(template).toContain('STYLES=default')
  })

  it('joins onto a baseUrl that already carries a query string with & (not a second ?)', () => {
    const options: WmsAdapterOptions = {
      baseUrl: 'https://example.com/wms?service=WFS&other=1',
      layers: 'x',
    }
    expect(wmsRasterTemplate(options)).toBe(
      'https://example.com/wms?service=WFS&other=1&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&' +
        'LAYERS=x&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&' +
        'FORMAT=image%2Fpng&TRANSPARENT=TRUE',
    )
  })

  describe('malformed options', () => {
    it('throws when baseUrl is missing', () => {
      expect(() => wmsRasterTemplate({ baseUrl: '', layers: 'x' })).toThrow(/baseUrl is required/)
    })

    it('throws when layers is missing', () => {
      expect(() =>
        wmsRasterTemplate({ baseUrl: 'https://example.com/wms', layers: '' }),
      ).toThrow(/layers is required/)
    })

    it('throws on an unsupported WMS version', () => {
      expect(() =>
        wmsRasterTemplate({
          baseUrl: 'https://example.com/wms',
          layers: 'x',
          // @ts-expect-error — deliberately invalid at the type level too
          version: '1.0.0',
        }),
      ).toThrow(/unsupported WMS version/)
    })

    it('throws on a non-positive tileSize', () => {
      expect(() =>
        wmsRasterTemplate({ baseUrl: 'https://example.com/wms', layers: 'x', tileSize: 0 }),
      ).toThrow(/tileSize must be a positive number/)
    })
  })
})

describe('wmsGetMapUrl (tile coord → exact GetMap URL)', () => {
  const nowcoast: WmsAdapterOptions = {
    baseUrl: 'https://nowcoast.noaa.gov/geoserver/wms',
    layers: 'mrms:conus_base_reflectivity_mosaic',
  }

  it('z=0 (the whole world in one tile) — BBOX is the full EPSG:3857 extent', () => {
    expect(wmsGetMapUrl(0, 0, 0, nowcoast)).toBe(
      'https://nowcoast.noaa.gov/geoserver/wms?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&' +
        'LAYERS=mrms%3Aconus_base_reflectivity_mosaic&STYLES=&CRS=EPSG:3857&' +
        'BBOX=-20037508.342789244,-20037508.342789236,20037508.342789244,20037508.342789244&' +
        'WIDTH=256&HEIGHT=256&FORMAT=image%2Fpng&TRANSPARENT=TRUE',
    )
  })

  it('max x/y at z=2 (bottom-right corner tile, x=y=3 of 0..3)', () => {
    expect(wmsGetMapUrl(2, 3, 3, nowcoast)).toBe(
      'https://nowcoast.noaa.gov/geoserver/wms?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&' +
        'LAYERS=mrms%3Aconus_base_reflectivity_mosaic&STYLES=&CRS=EPSG:3857&' +
        'BBOX=10018754.171394622,-20037508.342789236,20037508.342789244,-10018754.171394624&' +
        'WIDTH=256&HEIGHT=256&FORMAT=image%2Fpng&TRANSPARENT=TRUE',
    )
  })

  it('origin tile (x=0,y=0) at the same z=2, for contrast with the max-corner tile', () => {
    expect(wmsGetMapUrl(2, 0, 0, nowcoast)).toBe(
      'https://nowcoast.noaa.gov/geoserver/wms?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&' +
        'LAYERS=mrms%3Aconus_base_reflectivity_mosaic&STYLES=&CRS=EPSG:3857&' +
        'BBOX=-20037508.342789244,10018754.171394624,-10018754.171394622,20037508.342789244&' +
        'WIDTH=256&HEIGHT=256&FORMAT=image%2Fpng&TRANSPARENT=TRUE',
    )
  })

  it('interior tile at z=4, with a non-default version/format/tileSize/styles/transparent', () => {
    const options: WmsAdapterOptions = {
      baseUrl: 'https://example.com/wms',
      layers: 'foo:bar',
      version: '1.1.1',
      format: 'image/jpeg',
      tileSize: 512,
      styles: 'default',
      transparent: false,
    }
    expect(wmsGetMapUrl(4, 9, 5, options)).toBe(
      'https://example.com/wms?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=foo%3Abar&' +
        'STYLES=default&SRS=EPSG:3857&' +
        'BBOX=2504688.5428486555,5009377.08569731,5009377.085697311,7514065.62854596&' +
        'WIDTH=512&HEIGHT=512&FORMAT=image%2Fjpeg&TRANSPARENT=FALSE',
    )
  })

  it('propagates wmsRasterTemplate validation (malformed options) for a bad tileSize', () => {
    const badOptions: WmsAdapterOptions = { baseUrl: 'https://x/wms', layers: 'x', tileSize: -1 }
    expect(() => wmsGetMapUrl(0, 0, 0, badOptions)).toThrow(/tileSize must be a positive number/)
  })
})
