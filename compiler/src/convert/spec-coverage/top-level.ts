import type { CoverageEntry } from './types'

// ─── 1. Top-level style spec ──────────────────────────────────────────
export const TOP_LEVEL: readonly CoverageEntry[] = [
  { name: 'version', status: 'na', note: 'Spec versioning; ignored.' },
  {
    name: 'name',
    status: 'supported',
    note: 'Emitted as a leading /* comment */ in the converted xgis.',
    source: 'mapbox-to-xgis.ts',
  },
  {
    name: 'metadata',
    status: 'unsupported',
    impact: 'low',
    note: 'Silent drop — informational only in Mapbox.',
  },
  {
    name: 'center',
    status: 'supported',
    note: 'Applied by the demo-runner Mapbox importer after `runSource()` via `Camera.centerX/Y` + `markCameraPositioned()`. URL-hash camera still wins (hash parsing runs first). Compiler does NOT encode camera state into xgis source — top-level camera lives in the runtime, not the DSL.',
  },
  {
    name: 'zoom',
    status: 'supported',
    note: 'Same path as `center` — runtime-side via demo-runner.',
  },
  {
    name: 'bearing',
    status: 'supported',
    note: 'Same path as `center` — runtime-side via demo-runner.',
  },
  {
    name: 'pitch',
    status: 'supported',
    note: 'Same path as `center` — runtime-side via demo-runner.',
  },
  { name: 'sources', status: 'supported', source: 'sources.ts' },
  { name: 'layers', status: 'supported', source: 'layers.ts' },
  {
    name: 'sprite',
    status: 'supported',
    note: 'Importer extracts the URL from raw JSON and forwards to XGISMap.setSpriteUrl(). Runtime IconStage fetches `${url}.json` + `${url}.png` (DPR>=1.5 tries `@2x` first) and renders bitmap icons; SDF icons + icon-text-fit are Phase 2. Unknown icon names dropped silently at prepare-time; iter 526 added IconStage.getMissingIconNames() diagnostic for post-load misses.',
  },
  {
    name: 'glyphs',
    status: 'supported',
    note: 'Importer extracts the URL from raw JSON and forwards to XGISMap.setGlyphsUrl(). Runtime TextStage fetches MapLibre SDF PBFs and upgrades visually when available; Canvas2D fallback stays on for offline / missing-glyph cases. Not encoded in xgis source.',
  },
  {
    name: 'transition',
    status: 'unsupported',
    impact: 'low',
    note: 'Per-property fade-in dropped.',
  },
  {
    name: 'light',
    status: 'supported',
    impact: 'low',
    note: 'WS-9 — custom `light` (position / intensity / color) is now honoured. The extrude shader (vs_main_ecef_extruded) reads intensity from light_dir_ecef.w and colour from light_color_packed (RGBA8) instead of the old baked WGSL consts; the CPU packs the MapLibre default (position [1.15,210°,30°] → (0.288,-0.498,0.996), intensity 0.5, white) when no light is authored, so the default render is byte-identical. Host-applied like projection/camera: the demo-runner + compare-runner parse the top-level `light` block and call XGISMap.setLight(), which the render loop pushes into every VTR each frame. `anchor` is accepted but the directional frame stays the #420 camera-anchor ENU basis (the map/viewport bearing distinction is not yet modelled — invisible on the target corpus, which uses the default anchor). Light affects fill-extrusion only.',
  },
  {
    name: 'fog',
    status: 'unsupported',
    impact: 'low',
    note: 'Mapbox v3 distance-fog gradient. Would need a post-process pass with depth-based mixing.',
  },
  {
    name: 'terrain',
    status: 'unsupported',
    impact: 'medium',
    note: 'Roadmap Batch 4 (raster-dem + hillshade).',
  },
  {
    name: 'projection',
    status: 'supported',
    impact: 'low',
    note: 'WS-8 — all 8 X-GIS projections (mercator / equirectangular / natural_earth / orthographic / azimuthal_equidistant / stereographic / oblique_mercator / globe) render and the top-level style-spec `projection` field is now honoured. Same host-integration path as center/zoom: the playground demo-runner + compare-runner read the raw style JSON, map the Mapbox type name (e.g. globe → globe, naturalEarth → natural_earth via setProjection ALIASES) and call XGISMap.setProjection() after runSource(). URL `?proj=` still overrides. Mapbox-only types with no X-GIS equivalent (albers / equalEarth / lambertConformalConic / winkelTripel) warn at setProjection and keep the current projection. Not encoded in the xgis DSL (runtime-only, by design).',
  },
  { name: 'imports', status: 'unsupported', note: 'Mapbox v3 style-import not parsed.' },
]
