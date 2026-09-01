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
    status: 'supported',
    note: 'Preserved as a leading /* comment */ in the converted xgis, the same channel `name` uses. The spec defines root `metadata` as arbitrary author data that does not affect rendering, so a comment is the whole of the xgis form it can have — but real styles put load-bearing pointers there (the MapLibre demo style carries a MapTiler licence + `openmaptiles:version`), which the pre-#2166 silent drop lost with no warning. Bound to the converter — and to the layer-level `metadata` row, which is NOT preserved — by style-metadata-preserved.test.ts.',
    source: 'mapbox-to-xgis.ts',
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
    note: 'Top-level `transition` `{ duration, delay }` — the cross-fade timing used when a paint value CHANGES at runtime. #2166 took it out of the ignored-roots lump in mapbox-to-xgis.ts because "ignored" OVER-states the loss: it costs a converted style nothing at rest — every value renders exactly as authored — and X-GIS simply steps to a new paint value instead of fading it, there being no per-property transition clock in the runtime. The warning now names the authored duration/delay and says the frame is identical at rest, and a block asking for no animation at all (duration 0, no delay) warns nothing at all, since that IS what X-GIS does; the lump used to fire on it, which was a false positive. Still `unsupported`, and the work is a RUNTIME animation clock, not a converter change. Recorded while adjacent: the per-property `<property>-transition` form inside `paint` is dropped by the same absence and gets no warning of its own — surfaceIgnoredPaint is candidate-list driven, so a paint key that no emitter lists is never examined.',
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
    note: "Mapbox v3 `fog` root. #2166 took it out of the ignored-roots lump in mapbox-to-xgis.ts and gave it a precise warning, because the lump could not say WHICH of three different kinds of key the author wrote. The split is the one docs/plans/2026-08-24-sky-fog.md §5 established, and the warning uses that taxonomy rather than a second one: `range` is DISTANCE-dependent and needs the per-fragment depth pass X-GIS does not have — that one key is what keeps this row `unsupported`. `color` / `high-color` / `space-color` / `horizon-blend` / `star-intensity` are DIRECTION-dependent, i.e. the sky evaluator's job rather than depth's; most of that half already renders under the MapLibre `sky` spelling that setAtmosphere carries (extractMapboxSky, the row below), so the warning points an author who wanted that look at the spelling that renders TODAY. `star-intensity` is the exception inside that half and is pointed at nothing: the atmosphere pass draws no stars, so naming `sky` would be a false promise. `vertical-range` is ALTITUDE-banded and presumes terrain — sky-fog §9.2 assigns it to ADR-0012 D5, so it is neither a depth problem nor expressible as `sky`. Nothing is auto-translated between the two spellings; a real implementation still owes the depth pass for `range` plus a Mapbox-to-MapLibre key mapping for the direction half.",
  },
  {
    name: 'sky',
    status: 'partial',
    impact: 'low',
    note: "MapLibre top-level `sky` root — the zenith-angle sky gradient. DISTINCT from the Mapbox `sky` LAYER TYPE (`{ type: 'sky' }`), which stays unsupported in layer-types.ts; this is the style-root object. #2052 (T5 P1) made it host-applied rather than encoded into xgis source, the same channel `light` uses: extractMapboxSky (playground/src/mapbox-projection.ts) reads it and XGISMap.setAtmosphere({ sky }) carries sky-color / horizon-color / sky-horizon-blend, which the atmosphere pass paints anchored on the GLOBE'S LIMB — so the horizon the gradient references is the one actually being drawn, not a screen-space guess. It leaves the gapFields warn list on that basis, but does NOT become silent: any sub-property outside those three (the below-horizon fog band, the global sky fade) is named individually in a precise partial-sky warning, so a partial root reads as partial instead of as supported. The flat-projection arm is T5 P2.",
    source:
      'playground/src/mapbox-projection.ts extractMapboxSky / map/src/render/passes/atmosphere-pass.ts',
  },
  {
    name: 'terrain',
    status: 'partial',
    impact: 'medium',
    note: "Top-level terrain block `{ source, exaggeration }` — both dialects spell it identically. #2095 (T2 P2) landed the real path: parser/parser-terrain.ts parses it into a terrain statement, convert/terrain.ts validates and converts it, and ir/terrain-block.ts carries it, so the block survives the compile instead of vanishing into the ignored-roots sweep. Its `source` also joins referencedSourceIds, without which a DEM referenced ONLY by terrain was pruned and the emitted block pointed at a source that no longer existed. PARTIAL because the renderer has no VERTEX DISPLACEMENT pass: the DEM feeds hillshade (via the raster-dem source path) and nothing lifts geometry, so the warning says displacement is not applied AND says what the DEM IS used for — accepting the property while rendering flat, with nothing to explain the gap, would be worse than dropping it. This row was left at 'unsupported / Roadmap Batch 4' when #2095 merged; corrected here rather than left to rot beside the sky row this change adds.",
    source: 'parser/parser-terrain.ts / convert/terrain.ts / ir/terrain-block.ts',
  },
  {
    name: 'projection',
    status: 'supported',
    impact: 'low',
    note: 'WS-8 — all 8 X-GIS projections (mercator / equirectangular / natural_earth / orthographic / azimuthal_equidistant / stereographic / oblique_mercator / globe) render and the top-level style-spec `projection` field is now honoured. Same host-integration path as center/zoom: the playground demo-runner + compare-runner read the raw style JSON, map the Mapbox type name (e.g. globe → globe, naturalEarth → natural_earth via setProjection ALIASES) and call XGISMap.setProjection() after runSource(). URL `?proj=` still overrides. Mapbox-only types with no X-GIS equivalent (albers / equalEarth / lambertConformalConic / winkelTripel) warn at setProjection and keep the current projection. Not encoded in the xgis DSL (runtime-only, by design).',
  },
  { name: 'imports', status: 'unsupported', note: 'Mapbox v3 style-import not parsed.' },
]
