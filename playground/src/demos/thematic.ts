// ═══ Demo Definitions — Thematic / composition demos (outlines, borders, water hierarchy, megacities, animation). ═══
// Faithful per-category fragment of the single DEMOS record (assembled in
// ../demos.ts, which preserves the original insertion order). Demo .xgis
// sources load via the shared loader; ids are unchanged (URL nav depends on
// them). Append-only: a new demo in this category is added HERE.

import { load, type Demo } from './loader'

export const DEMOS_THEMATIC: Record<string, Demo> = {
  continent_outlines: {
    name: 'Continent Outlines',
    tag: 'thematic',
    description:
      'Each continent colored by match(.CONTINENT) with heavy matching outlines — distinct hue per landmass with a darker halo stroke.',
    source: load('continent-outlines.xgis'),
  },

  dashed_borders: {
    name: 'Dashed Borders',
    tag: 'thematic',
    description:
      'Translucent sky-blue country fill with dashed white borders. Mixes polygon fill with stroke-dasharray-8-4 line styling.',
    source: load('dashed-borders.xgis'),
  },

  coastline_10m: {
    name: 'Coastline 10m',
    tag: '10m',
    description:
      'World coastline at 10m resolution, rendered as two stacked line layers — dark shadow stroke + bright cyan body. No polygon fill. Stress test for dense SDF line vertices.',
    source: load('coastline-10m.xgis'),
  },

  water_hierarchy: {
    name: 'Water Hierarchy',
    tag: '10m',
    description:
      'Three-tier blue gradient for ocean, lakes, and rivers. Glow halos on both lakes and rivers give soft water-body ambience against neutral land.',
    source: load('water-hierarchy.xgis'),
  },

  raster_overlay: {
    name: 'Raster + 10m Borders',
    tag: 'raster',
    description:
      'OpenStreetMap basemap with translucent white 10m state boundaries overlaid. Demonstrates raster + vector composition and offscreen MAX-blend compositing over imagery.',
    source: load('raster-overlay.xgis'),
  },

  hillshade_terrarium: {
    name: 'Hillshade: Grand Canyon',
    tag: 'raster',
    description:
      'Shaded relief from LIVE terrain tiles (#777 Phase II): a raster-dem source streams AWS Terrain Tiles (terrarium encoding, {z}/{x}/{y}) into the HillshadeRenderer with authored paint — NW illumination (315°), 0.6 exaggeration, warm shadow/highlight palette. The real-data sibling of fixture_hillshade_local (the offline deterministic gate).',
    source: load('hillshade-terrarium.xgis'),
    zoom: 11,
    center: [-112.14, 36.1],
  },

  terrain_3d: {
    name: 'Terrain: 3D (Grand Canyon)',
    tag: 'raster',
    description:
      'The DEM MOVES the ground, not just shades it (D5 INC-3, #2539): the same live AWS Terrain Tiles as hillshade_terrarium, but `vs_tile` samples elevation per vertex and displaces along the ellipsoid normal — at pitch the ridges have real silhouettes and near faces occlude far ones. Flip between the two demos over the same tiles to see one flat sheet become a landform. The exaggeration buttons drive `setTerrainExaggeration` live; 0 returns the ground to bit-identical flat (the displacement is a multiply by the per-tile gain, so "off" is a multiply by 0.0). Terrain is invisible from straight above, which is why this opens pitched.',
    source: load('terrain-3d.xgis'),
    zoom: 11.5,
    center: [-112.14, 36.1],
    pitch: 65,
    bearing: 20,
    terrainExaggeration: 1.5,
    actions: [
      { label: 'Flat (0×)', run: (m) => m.hillshadeRenderer.setTerrainExaggeration(0) },
      { label: 'Real (1×)', run: (m) => m.hillshadeRenderer.setTerrainExaggeration(1) },
      { label: 'Exaggerated (3×)', run: (m) => m.hillshadeRenderer.setTerrainExaggeration(3) },
    ],
  },

  hillshade_multidir: {
    name: 'Hillshade: multidirectional',
    tag: 'raster',
    description:
      'USGS-style four-light shaded relief: `hillshade-method: multidirectional` averages Lambert sources at 225/270/315/355° so ridges read clearly no matter which way they run (no single-light directional bias). Same Grand Canyon terrain as hillshade_terrarium — flip between the two to see the lighting model change.',
    source: load('hillshade-multidir.xgis'),
    zoom: 11,
    center: [-112.14, 36.1],
  },

  satellite_map: {
    name: 'Satellite Map',
    tag: 'raster',
    description:
      'MapLibre example port (#1192): "Display a satellite map" — Esri World Imagery as a plain raster source (note the ArcGIS {z}/{y}/{x} path order; the tile-URL substitution is order-agnostic). Opens over the Palm Jumeirah, Dubai.',
    source: load('satellite-map.xgis'),
    zoom: 12.5,
    center: [55.138, 25.112],
  },

  satellite_ofm_overlay: {
    name: 'Satellite + OFM roads & labels',
    tag: 'raster',
    description:
      'Raster satellite base with a HAND-PICKED subset of OpenFreeMap vector layers on top — road lines, road names, and place labels only, not the whole ~80-layer style. Declare the openmaptiles vector source yourself and write just the layers you want (layers cannot be cherry-picked out of an `import "url"`); draw order = declaration order, so imagery sits underneath. Opens over Seoul.',
    source: load('satellite-ofm-overlay.xgis'),
    zoom: 13,
    center: [126.978, 37.5665],
  },

  bold_borders: {
    name: 'Bold Borders',
    tag: 'thematic',
    description:
      'High-contrast flat country fill with double-stroke outlines: thick black shadow behind, bright amber foreground. Presentation-ready styling.',
    source: load('bold-borders.xgis'),
  },

  megacities: {
    name: 'Megacities',
    tag: 'point',
    description:
      'Populated places filtered by POP_MAX > 5M. Each city shown as a glowing 500 km halo + billboard pin whose size scales linearly up to 30M population.',
    source: load('megacities.xgis'),
  },

  layered_borders: {
    name: 'Layered Borders',
    tag: 'zoom',
    description:
      'Three-tier admin borders: bold countries (always visible), 50m states (fade in at z3), 10m states (fade in at z6). Drillable hierarchy via zoom-opacity modifiers.',
    source: load('layered-borders.xgis'),
  },

  bucket_order: {
    name: 'Bucket Order (regression)',
    tag: 'line',
    description:
      'Translucent yellow coast declared BEFORE opaque country fill. Bucket scheduler must render opaque first and composite the translucent stroke on top, regardless of declaration order.',
    source: load('bucket-order.xgis'),
  },

  animation_pulse: {
    name: 'Animation: pulse (PR 1)',
    tag: 'animation',
    description:
      'Keyframes block + animation-pulse modifier. Amber coastline fades 100 → 30 → 100 every 1.5s with ease-in-out. First landing of the X-GIS animation system.',
    source: load('animation-pulse.xgis'),
  },

  animation_showcase: {
    name: 'Animation: showcase (PR 3)',
    tag: 'animation',
    description:
      'Full property coverage — fill/stroke color morph, dash-offset marching, cross-property keyframes. Countries heat up, coastline marches, land outline cycles amber↔sky.',
    source: load('animation-showcase.xgis'),
  },

  globe_extrusion: {
    name: 'Globe + Extrusion',
    tag: 'thematic',
    description:
      'MapLibre "Display a globe with a fill extrusion layer" port — countries extrude off the globe with per-feature population heights (fill-extrusion-height-[.POP_EST / 4000000], globe via Demo.projection). Opens filling the frame so the extrusion silhouettes read on the limb.',
    source: load('globe-extrusion.xgis'),
    projection: 'globe',
    zoom: 2.9,
    center: [15, 18],
  },

  coverage_bathymetry: {
    name: 'S-100 Coverage: bathymetry (#1158)',
    tag: 'thematic',
    description:
      'S-100 gridded-coverage read IN PLACE from S-102 HDF5 (ADR-0010) — a synthetic 32×32 bathymetry grid at 50-58°N with a north→south depth ramp, a nodata hole, and 4 known corner cells. Over the ramp it prints SOUNDING NUMERALS (#1366 INC-5): depths straight off the original grid (valueAt, nearest-cell, never interpolated), picked on a screen-space lattice and thinned by the label collision pass — the reading a colour ramp cannot give. Needs NO network, so it is where the sounding render gate actually runs; the numerals read 3/6/12/17/21/26/31/36 north→south and none sits over the nodata hole. getCoverage(...).valueAt returns the same exact positive-down value CPU-side.',
    source: load('coverage-bathymetry.xgis'),
    zoom: 4.6,
    center: [4, 54],
  },

  s111_currents: {
    name: 'NOAA S-111 Currents (#1272)',
    tag: 'thematic',
    description:
      'NOAA S-111 surface currents — a synthetic Chesapeake-shaped tidal field (S-111 HDF5, real S-111 band names/units/-9999 fill): the speed band draws through the viridis coverage ramp (0-2 kn) and the runner overlays drifting particles along the direction band (retained particle-flow, #826). Not real NOAA data; a real NOAA S-111 cell is the SAME HDF5 standard, read in place (ADR-0010).',
    source: load('s111-currents.xgis'),
    zoom: 6.6,
    center: [-76.19, 38.1],
    currents: true,
  },

  s111_live: {
    name: 'NOAA S-111 Live Currents — real S3 stream, engine-resolved viewport (#1453)',
    tag: 'thematic',
    description:
      'LIVE, REAL NOAA S-111 currents — streams real forecast cells straight from the NOAA Open-Data S3 bucket (noaa-s111-pds), read as the S-100 HDF5 standard IN PLACE (ADR-0010, no transcode). The NOAA bucket has no CORS, so the browser reaches it through the vite `/opendata` dev bridge (a CORS-open Cloudflare Worker in prod); `latest.h5` resolves the newest published cycle so the demo never rots. Draws the STRICT OFFICIAL S-111 portrayal — the ENGINE-derived arrow field (`| arrow`, #1333): one band-coloured arrow per grid cell, oriented by the direction band, scaled per the vendored IHO catalogue (docs/standards/s-111), over Esri satellite imagery. Arrows ONLY, no raster fill (the catalogue defines coloured arrows, not a colour area). ANIMATED FLOW: `| particles` (#1333) layers a second, moving reading of the same field on top — small dots drift within their home cell and respawn, so the current visibly flows even with the camera and forecast hour both at rest. FORECAST TIME: a bottom scrubber steps the cell’s hourly groups (setCoverageTime — play/pause + slider). VIEWPORT-DRIVEN, DECLARATIVELY (#1453): the source’s `url:` names a STAC catalogue of the NOAA regional cells, and the ENGINE resolves it — pan across the U.S. coast and the currents follow (Chesapeake cbofs → San Francisco sfbofs → Gulf of Maine gomofs → …), with every cell the view covers drawn TOGETHER rather than one winner, and the renderer’s GPU byte budget bounding what stays resident. That is the same deal `type: raster` has always offered; it replaced 860 lines of app-side mosaic code. Needs network egress + the proxy; falls back to imagery only if a cell can not be reached.',
    source: load('s111-live.xgis'),
    zoom: 7.4,
    center: [-76.1, 37.9],
    currents: true,
    timeControl: true,
  },

  s102_live: {
    name: 'NOAA S-102 Live Bathymetry — real S3 stream, PROJECTED (UTM) cell (#1366)',
    tag: 'thematic',
    description:
      "LIVE, REAL NOAA S-102 bathymetry — streams a real survey cell straight from the NOAA Open-Data S3 bucket (noaa-s102-pds), read as the S-100 HDF5 standard IN PLACE (ADR-0010, no transcode). This is the first demo drawing a PROJECTED coverage: the cell's grid is EPSG:32618 (WGS 84 / UTM 18N) at 16 m spacing with a METRE origin, not degrees. Until #1366 the drape walked a lon/lat rectangle, so such a cell would have been placed as if metres were degrees — off the planet — and the reader refused it rather than mis-render; the drape now reprojects its mesh nodes through the cell's own CRS on the CPU, so the grid lands in Chesapeake Bay. Real NOAA S-102 cells are ALL projected, so this is what makes real bathymetry drawable at all. On top of the ramp it prints SOUNDING NUMERALS (#1366 INC-5) — the reading a colour ramp cannot give: depths straight off the original grid (valueAt, nearest-cell, never interpolated), picked on a screen-space lattice so they thin with scale like a real chart and thinned again by the label collision pass. The bucket has no CORS, so the browser reaches it through the `/opendata` dev bridge (a CORS-open Worker in prod). VIEWPORT-DRIVEN, DECLARATIVELY (#1453): the source's `url:` names NOAA's own S-100 Exchange Catalogue translated to STAC — all 4313 published cells with their envelopes — and the ENGINE resolves it, so panning loads whatever the view covers; S-102 keys are stable (a cell is re-issued in place when its survey updates), so the catalogue's hrefs do not rot either. Needs network egress + the proxy; falls back to imagery only if the cell cannot be reached.",
    source: load('s102-live.xgis'),
    zoom: 10.5,
    center: [-75.75, 37.95],
  },

  coops_currents: {
    name: 'NOAA CO-OPS Live Currents (#1272)',
    tag: 'thematic',
    description:
      'LIVE NOAA tidal currents for the Chesapeake Bay PORTS stations, fetched browser-direct from api.tidesandcurrents.noaa.gov (CORS `*`, no server). The stations are pushed into a declared `stations` source (setSourceData) and speed-coloured by the station_dots layer; one direction arrow per station is drawn on top — all over Esri satellite imagery. Open the JS tab to read the integration recipe verbatim. Needs network egress; the field stays absent offline.',
    source: load('coops-currents.xgis'),
    zoom: 6.7,
    center: [-76.15, 38.2],
    coops: true,
  },
}
