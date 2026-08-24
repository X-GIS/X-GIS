import type { CoverageEntry } from './types'

// ─── 2. Source types ──────────────────────────────────────────────────
export const SOURCE_TYPES: readonly CoverageEntry[] = [
  {
    name: 'vector (.pmtiles)',
    status: 'supported',
    note: 'Routed to PMTilesBackend.',
    source: 'sources.ts:277-279',
  },
  {
    name: 'vector (TileJSON)',
    status: 'supported',
    note: 'Runtime fetches manifest then attaches PMTiles backend.',
    source: 'sources.ts:280-303',
  },
  {
    name: 'pmtiles',
    status: 'supported',
    note: 'Community-extension type ("type":"pmtiles") accepted as a sibling of the .pmtiles-URL detection path.',
    source: 'sources.ts:322-336',
  },
  {
    name: 'tilejson (explicit)',
    status: 'supported',
    note: 'Third-party convention: `"type":"tilejson"` directly. Routed alongside the `vector` + URL-sniffing path.',
    source: 'sources.ts:308-321',
  },
  { name: 'raster', status: 'supported', source: 'sources.ts:337-367' },
  { name: 'geojson (URL)', status: 'supported', source: 'sources.ts:473-488' },
  {
    name: 'geojson (inline)',
    status: 'supported',
    note: 'Captured via inlineGeoJSON collector → auto-pushed after run().',
    source: 'sources.ts:489-528',
  },
  {
    name: 'raster-dem',
    status: 'supported',
    note: '#777 Phase II — source threads encoding / tileSize (+ custom unpack factors); the DEM is fetched, RGBA8-decoded (mapbox / terrarium / custom) and drawn as shaded relief by the HillshadeRenderer. Feeds hillshade layers only; 3D terrain vertex displacement is the separate top-level `terrain` row.',
    source: 'sources.ts:368-415',
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
  // ─── Source-level properties ────────────────────────────────────────
  // Per-source JSON fields Mapbox lets ANY of the source TYPES above
  // declare, independent of `type`. Distinct axis from the type rows
  // above, so it gets its own subsection rather than a note bolted onto
  // an unrelated type row.
  {
    name: 'tileSize',
    status: 'partial',
    impact: 'medium',
    note: "Runtime IS tileSize-aware: RasterRenderer defaults to 256 px and biases the raster cover-zoom by log2(512/tileSize) (raster-renderer.ts:93-97, default :274), and the xgis DSL already parses a source-level tileSize: property end-to-end onto SourceDef (compiler/src/ir/lower.ts:201-202), which map.ts wires into setTileSize(). The gap is upstream of all that: the Mapbox-style CONVERTER never emits the style-declared tileSize into the generated xgis source block, so a converted style always falls back to the runtime default regardless of what the style actually said. #1983 tracks adding the emit. Visible today on OFM Liberty's ne2_shaded (tileSize: 256, coincidentally matching the default — the same gap would misrender a genuine 512-px source).",
    source: 'sources.ts:208-213',
  },
  {
    name: 'minzoom / maxzoom',
    status: 'partial',
    impact: 'low',
    note: "Source-level zoom bounds (distinct from a layer's minzoom/maxzoom). Runtime DOES clamp a maxzoom that reaches it — raster sources thread source.maxzoom through to RasterRenderer.setSourceMaxzoom, capping rasterCoverZoom (map.ts:3743-3745) — and a PMTiles archive / TileJSON manifest already carries its own authoritative minzoom+maxzoom that the runtime reads straight from the archive header / manifest (vector-tile-loader.ts:470-472, :541-543), independent of the style JSON's minzoom/maxzoom fields. The gap is narrower than 'unhonoured': the CONVERTER never emits the STYLE-DECLARED value into the xgis source block, so only a source with no metadata channel of its own (a plain raster/geojson endpoint) loses it. #1983 tracks the emit. No visual difference — out-of-range tiles 404 and fall back to a parent tile, wasteful but not incorrect.",
    source: 'sources.ts:138-142',
  },
  {
    name: 'bounds',
    status: 'unsupported',
    impact: 'low',
    note: "Style-declared source.bounds [west, south, east, north] has no xgis DSL grammar at all — lower.ts parses no `bounds` property, so unlike tileSize/minzoom/maxzoom this can't even be hand-authored in xgis today. Vector archives already clip via a separate, working channel: PMTilesBackend.has() gates every tile candidate through tileIntersectsBounds() against the PMTiles header's / TileJSON manifest's OWN bounds (vector-tile-loader.ts:472, :543; pmtiles-backend.ts:232-235), independent of the style JSON's bounds field. The gap is the style-declared override on a source with no such metadata (e.g. a bounded raster endpoint); its out-of-range tiles are requested and 404 — wasteful, not visually wrong. #1984 tracks adding the grammar and threading it through.",
    source: 'sources.ts:150-197',
  },
  {
    name: 'scheme',
    status: 'unsupported',
    impact: 'low',
    note: '"tms" (bottom-left Y origin) vs the default "xyz" (top-left). The converter recognises scheme: "tms" and warns, but the runtime tile selector assumes XYZ unconditionally — no Y-flip path exists anywhere in the fetch/addressing pipeline. Rare in practice (old OSM / Stadia / Stamen TMS mirrors; no OFM or MapLibre-demo style declares it), but when it IS declared every tile for that source renders mirrored on Y. #1985 tracks implementing the flip.',
    source: 'sources.ts:116-128',
  },
]
