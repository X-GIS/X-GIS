// #1977 — two silent-drop gaps in the Mapbox → xgis converter:
//   1. icon-offset non-constant forms (legacy {stops:[...]} function OR
//      modern ["interpolate", …] expression) silently became [0,0] with
//      ZERO warning — every other converter gap warns; this one didn't.
//   2. A `mapbox://` scheme URL (source url, sprite, glyphs) is emitted
//      verbatim with ZERO warning. At runtime the fetch can only fail
//      (source-manager.ts prepends baseUrl to any non-http(s) URL; no
//      Mapbox access-token logic exists anywhere), so a converted
//      mapbox.com style renders nothing, silently.
//
// Both are warn-only fixes: the emitted bytes for the affected knob are
// UNCHANGED (icon-offset already dropped to nothing; mapbox:// URLs still
// emit verbatim) — only a diagnostic is added.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function compileSymbol(layout: Record<string, unknown>): { out: string; warnings: string[] } {
  const style = {
    version: 8,
    sources: { v: { type: 'vector' as const, url: 'x.pmtiles' } },
    layers: [
      {
        id: 'sym',
        type: 'symbol' as const,
        source: 'v',
        'source-layer': 'poi',
        layout: { 'icon-image': 'marker', ...layout },
      },
    ],
  }
  const warnings: string[] = []
  const out = convertMapboxStyle(style as never, {
    coverage: { sources: [], layers: [], warnings },
  })
  return { out, warnings }
}

describe('#1977 — silent gap warnings', () => {
  describe('icon-offset non-constant forms', () => {
    it('legacy {stops:[...]} function form → one warning, no label-icon-offset emitted', () => {
      const { out, warnings } = compileSymbol({
        'icon-offset': {
          stops: [
            [10, [0, 5]],
            [14, [0, 12]],
          ],
        },
      })
      const hits = warnings.filter((w) => /icon-offset/.test(w))
      expect(hits.length).toBe(1)
      expect(hits[0]).toContain('Symbol layer "sym"')
      expect(out).not.toContain('label-icon-offset')
    })

    it('modern ["interpolate", …] expression form → one warning, no label-icon-offset emitted', () => {
      const { out, warnings } = compileSymbol({
        'icon-offset': [
          'interpolate',
          ['linear'],
          ['zoom'],
          10,
          ['literal', [0, 5]],
          14,
          ['literal', [0, 12]],
        ],
      })
      const hits = warnings.filter((w) => /icon-offset/.test(w))
      expect(hits.length).toBe(1)
      expect(out).not.toContain('label-icon-offset')
    })

    it('constant [4, 6] → still emits label-icon-offset-x/-y, zero icon-offset warnings (regression guard)', () => {
      const { out, warnings } = compileSymbol({ 'icon-offset': [4, 6] })
      expect(warnings.filter((w) => /icon-offset/.test(w))).toEqual([])
      expect(out).toContain('label-icon-offset-x-4')
      expect(out).toContain('label-icon-offset-y-6')
    })
  })

  describe('mapbox:// scheme URLs', () => {
    it('vector source url → one warning, url still emitted verbatim (warn-only)', () => {
      const style = {
        version: 8,
        sources: {
          v: { type: 'vector' as const, url: 'mapbox://mapbox.mapbox-streets-v8' },
        },
        layers: [],
      }
      const warnings: string[] = []
      const out = convertMapboxStyle(style as never, {
        coverage: { sources: [], layers: [], warnings },
      })
      const hits = warnings.filter((w) => /mapbox:\/\//.test(w))
      expect(hits.length).toBe(1)
      expect(out).toContain('url: "mapbox://mapbox.mapbox-streets-v8"')
    })

    it('raster source url → one warning, url still emitted verbatim (warn-only)', () => {
      const style = {
        version: 8,
        sources: {
          r: { type: 'raster' as const, url: 'mapbox://mapbox.satellite' },
        },
        layers: [],
      }
      const warnings: string[] = []
      const out = convertMapboxStyle(style as never, {
        coverage: { sources: [], layers: [], warnings },
      })
      const hits = warnings.filter((w) => /mapbox:\/\//.test(w))
      expect(hits.length).toBe(1)
      expect(out).toContain('url: "mapbox://mapbox.satellite"')
    })

    it('raster-dem source url → one warning, url still emitted verbatim (warn-only)', () => {
      // #1977 follow-up: every real Mapbox v11+ terrain style ships a
      // raster-dem source in exactly this shape — this is the real-world
      // hole, not a contrived one.
      const style = {
        version: 8,
        sources: {
          dem: { type: 'raster-dem' as const, url: 'mapbox://mapbox.mapbox-terrain-dem-v1' },
        },
        layers: [
          {
            id: 'hills',
            type: 'hillshade' as const,
            source: 'dem',
          },
        ],
      }
      const warnings: string[] = []
      const out = convertMapboxStyle(style as never, {
        coverage: { sources: [], layers: [], warnings },
      })
      const hits = warnings.filter((w) => /mapbox:\/\//.test(w))
      expect(hits.length).toBe(1)
      expect(out).toContain('url: "mapbox://mapbox.mapbox-terrain-dem-v1"')
    })

    it('explicit "type": "tilejson" source url → one warning, url still emitted verbatim (warn-only)', () => {
      const style = {
        version: 8,
        sources: {
          t: { type: 'tilejson' as const, url: 'mapbox://mapbox.mapbox-streets-v8' },
        },
        layers: [],
      }
      const warnings: string[] = []
      const out = convertMapboxStyle(style as never, {
        coverage: { sources: [], layers: [], warnings },
      })
      const hits = warnings.filter((w) => /mapbox:\/\//.test(w))
      expect(hits.length).toBe(1)
      expect(out).toContain('url: "mapbox://mapbox.mapbox-streets-v8"')
    })

    it('https raster-dem url → zero mapbox warnings (negative guard)', () => {
      const style = {
        version: 8,
        sources: {
          dem: { type: 'raster-dem' as const, url: 'https://example.com/terrain/{z}/{x}/{y}.png' },
        },
        layers: [],
      }
      const warnings: string[] = []
      convertMapboxStyle(style as never, {
        coverage: { sources: [], layers: [], warnings },
      })
      expect(warnings.filter((w) => /mapbox:\/\//.test(w))).toEqual([])
    })

    it('top-level sprite → one warning; topLevel.sprite still collected verbatim', () => {
      const style = {
        version: 8,
        sprite: 'mapbox://sprites/mapbox/streets-v8',
        sources: {},
        layers: [],
      }
      const warnings: string[] = []
      const topLevel: { sprite?: string } = {}
      convertMapboxStyle(style as never, {
        coverage: { sources: [], layers: [], warnings },
        topLevel,
      })
      const hits = warnings.filter((w) => /mapbox:\/\//.test(w))
      expect(hits.length).toBe(1)
      expect(topLevel.sprite).toBe('mapbox://sprites/mapbox/streets-v8')
    })

    it('top-level glyphs → one warning', () => {
      const style = {
        version: 8,
        glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
        sources: {},
        layers: [],
      }
      const warnings: string[] = []
      convertMapboxStyle(style as never, {
        coverage: { sources: [], layers: [], warnings },
      })
      const hits = warnings.filter((w) => /mapbox:\/\//.test(w))
      expect(hits.length).toBe(1)
    })

    it('https TileJSON url + https sprite → zero mapbox warnings (negative guard)', () => {
      const style = {
        version: 8,
        sprite: 'https://example.com/sprites/sprite',
        sources: {
          v: { type: 'vector' as const, url: 'https://example.com/tiles.json' },
        },
        layers: [],
      }
      const warnings: string[] = []
      convertMapboxStyle(style as never, {
        coverage: { sources: [], layers: [], warnings },
      })
      expect(warnings.filter((w) => /mapbox:\/\//.test(w))).toEqual([])
    })
  })
})
