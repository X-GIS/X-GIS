import type { CoverageEntry } from './types'

// ─── 2. Source types ──────────────────────────────────────────────────
export const SOURCE_TYPES: readonly CoverageEntry[] = [
  {
    name: 'vector (.pmtiles)',
    status: 'supported',
    note: 'Routed to PMTilesBackend.',
    source: 'sources.ts:38',
  },
  {
    name: 'vector (TileJSON)',
    status: 'supported',
    note: 'Runtime fetches manifest then attaches PMTiles backend.',
    source: 'sources.ts:41',
  },
  {
    name: 'pmtiles',
    status: 'supported',
    note: 'Community-extension type ("type":"pmtiles") accepted as a sibling of the .pmtiles-URL detection path.',
    source: 'sources.ts:94',
  },
  {
    name: 'tilejson (explicit)',
    status: 'supported',
    note: 'Third-party convention: `"type":"tilejson"` directly. Routed alongside the `vector` + URL-sniffing path.',
    source: 'sources.ts:105',
  },
  { name: 'raster', status: 'supported', source: 'sources.ts:48' },
  { name: 'geojson (URL)', status: 'supported', source: 'sources.ts:73' },
  {
    name: 'geojson (inline)',
    status: 'supported',
    note: 'Captured via inlineGeoJSON collector → auto-pushed after run().',
    source: 'sources.ts:77',
  },
  {
    name: 'raster-dem',
    status: 'partial',
    impact: 'medium',
    note: '#777 Phase II — source threads encoding / tileSize (+ custom unpack factors); the DEM is fetched + RGBA8-decoded (mapbox / terrarium / custom) in the HillshadeRenderer. End-to-end relief draw pending pass wiring + real-GPU A/B (INC-5/6); terrain vertex displacement is future (II6).',
    source: 'sources.ts',
  },
  {
    name: 'image',
    status: 'unsupported',
    impact: 'low',
    note: 'Single-image source (e.g. user-supplied PNG draped onto a quad). Not in current loader; raster is the closest substitute.',
  },
  {
    name: 'video',
    status: 'unsupported',
    impact: 'low',
    note: 'Streaming video source. Not in current loader.',
  },
]
