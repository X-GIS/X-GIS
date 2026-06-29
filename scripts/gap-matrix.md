# X-GIS Mapbox Support Gap Matrix

## Runtime capability gaps

Properties where the runtime currently degrades or drops a specific value-form.

| Layer | Property | Variant | Note |
|---|---|---|---|
| fill | fill-opacity | data-driven | Per-feature opacity not threaded through renderer |
| fill | fill-antialias | constant | false branch not implemented; pipeline always uses MSAA |
| fill | fill-pattern | data-driven | Expression form of fill-pattern (per-feature sprite name) not threaded through IR |
| line | line-pattern | data-driven | Expression form not threaded through IR |
| symbol | text-opacity | data-driven | Per-feature alpha path deferred |
| symbol | text-pitch-alignment | constant | Runtime never projects labels onto ground plane |
| symbol | icon-opacity | zoom-interp | Per-feature alpha attr path deferred |
| symbol | icon-opacity | data-driven | Per-feature alpha path deferred |
| symbol | icon-size | data-driven | Worker per-feature evaluator pending |
| symbol | symbol-sort-key | data-driven | Expression flattens to 0; per-feature key plumbing pending |
| fill-extrusion | fill-extrusion-pattern | data-driven | Expression form not threaded through IR |
| raster | raster-opacity | data-driven | Data-driven not applicable to raster tiles |
| heatmap | heatmap-color | constant | Custom density→colour ramp not yet baked into the LUT; the runtime default Mapbox ramp is applied. |

## Spec-coverage status breakdown

| Status | Count |
|---|---:|
| supported | 175 |
| partial | 18 |
| unsupported | 42 |
| na | 7 |
| **total** | **242** |

## High-impact unsupported entries

Properties marked `unsupported` with `impact: high` — these are the most visible gaps to close next.

| Property | Note |
|---|---|
| symbol (icon-only) | No text-field → skipped. Awaits Batch 2 (sprite atlas). |
| image | Sprite atlas (Batch 2). |

## Partial entries

Properties marked `partial` — converter accepts but runtime degrades. These need either runtime extension or downgrading to `unsupported`.

| Property | Impact | Note |
|---|---|---|
| raster-dem | medium | Source registered, no hillshade renderer yet (Batch 4). |
| symbol-sort-key | medium | Constant numeric value plumbed end-to-end (iter 399-405). Runtime collision pass sorts CollisionItems by sortKey ascending — lower wins. Expression form (`["get", "rank"]`) flattens to 0 with a warning. |
| text-overlap | low | MapLibre overlap-policy enum (never / always / cooperative). always → label-allow-overlap; never → default; cooperative approximated as always (priority-aware collision pending) + warning. Wins over legacy text-allow-overlap when both declared. |
| text-pitch-alignment | medium | Converter emits, runtime ignores — labels never project onto ground plane. Iter 10 surfaced an explicit warning when `map` is authored (the gap-revealing case) so authors of pitched-view styles see the diagnostic. `viewport` and `auto` match X-GIS' billboard-rendering default and stay silent. |
| fill-antialias | low | Default `true` byte-identical (current render path). Geometric fill-edge AA in X-GIS comes from pipeline MSAA, not a per-fragment coverage smoothstep, so it is not per-layer disable-able. The `false` opt-out IS now wired: the converter emits a `fill-antialias-false` flag (paint.ts) → ShowCommand.fillAntialias → the polygon uniform's spare cam_ecef_off_h.w lane → the fs_fill fragment gates the only fill-alpha smoothstep it has (the sphere-rim hemisphere fade, polygon_rim_alpha) on the flag, giving a hard rim edge. On flat-Mercator the rim factor is already 1.0 so `false` is visually inert there; it bites on the curved-globe/azimuthal rim. OFM liberty `landcover_wood`/`grass`/`ice` set `false`. |
| icon-translate | low | CSS-px viewport offset for icons (independent of text-translate). Constant [dx, dy] form wired end-to-end: converter emits `label-icon-translate-{x,y}-N` (layers-symbol.ts) → LabelDef.iconTranslateX/Y → dispatchIcon adds it (× dpr) to the icon anchor before IconStage.addIcon (label-pass.ts), alongside icon-offset. Default [0,0] = no-op. Non-constant (expression / interpolate) form still warns + drops. |
| circle-blur | low | Constant numeric form extends the point fragment smoothstep AA band via circle_params.z in the point uniform (layers-circle.ts). Zoom-interp / data-driven forms warn + drop — need a per-feature feat_data slot for per-feature blur. |
| circle-translate-anchor | low | viewport (spec default) is the only honoured mode — X-GIS point renderer always applies the translate in viewport/NDC space. 'map'-anchor (world-space shift) is unsupported and warns + drops. The anchor no-op suppression (when circle-translate is absent) mirrors fill-translate-anchor behaviour. |
| heatmap-color | medium | Density → colour ramp. The runtime applies its default Mapbox ramp; a custom `interpolate` over `heatmap-density` is not yet baked into the LUT (converter warns). |
| rgb / rgba | low | Constant channels only — hex-encoded at convert time. Per-channel v8 literal-wrap (`["literal", N]`) accepted. |
| hsl / hsla | low | Constant channels only — converted via CSS hsl()/hsla() and re-hexed at convert time. Per-channel v8 literal-wrap accepted. |
| interpolate (cubic-bezier) | low | Numeric-valued zoom AND data-driven interpolates densify at compile time into a piecewise-linear approximation (6 samples per segment, CSS bezier-eased via Newton-Raphson). Runtime sees a longer linear stop list and visually approximates the bezier curve. Non-numeric values (colour stops) still warn and fold to pure linear. Iter 60-62 landings. |
| format | low | Span texts concatenated via xgis concat(); per-span opts (font-scale / text-color / text-font / vertical-align) dropped — X-GIS labels render with one style per layer. Iter 25 added per-section partial-drop semantics: when one section fails to convert (e.g. uses an unsupported accessor), surviving sections still concat — only ALL-sections-fail returns null. Pre-fix any single failure bailed the whole format expression and dropped the label silently. |
| collator | low | Locale-aware comparator as the trailing 4th arg of ==/!=/</<=/>/>=. Constant collator options (case-sensitive / diacritic-sensitive / locale) are fully supported: comparisonHandler lowers `["==", a, b, ["collator", opts]]` to the `collator_cmp` CPU builtin (eval/collator.ts) backed by Intl.Collator. Non-constant (per-feature expression) options fall back to byte-exact compare with a warning; a STANDALONE `["collator", …]` (not on a comparison) still warns (no value alone). |
| resolved-locale | low | Returns the BCP-47 tag a collator resolves to. Constant collator locale supported: resolvedLocaleHandler lowers `["resolved-locale", ["collator", opts]]` to the `resolved_locale` CPU builtin (Intl.Collator.resolvedOptions().locale). Non-constant collator options warn + drop. |
| array | low | Type-assertion drops to value pass-through (X-GIS arrays carry no per-element type tag, so the spec's "abort if not array" semantic is lost; in paint/filter use a non-array would null-cascade anyway). |
| distance | low | Shortest distance (metres) between the feature and a target GeoJSON. Point/MultiPoint feature-geometry vs any target is supported on GeoJSON sources: distanceHandler decomposes the constant target into points/segments/polygons (compile time) and lowers to the `distance(get("$geometry"), …)` CPU builtin (eval/distance.ts), which uses a cheap-ruler (latitude-corrected planar) metre metric and treats inside-polygon as 0. Deferred (return null): LineString/Polygon feature-geometry and MVT/PMTiles tile-coordinate sources (the worker filter path does not inject `$geometry`). |
| within | low | Geometry-containment filter. Point/MultiPoint tested-geometry vs Polygon/MultiPolygon argument is fully supported on GeoJSON sources: the converter lowers ["within", poly] to `within(get("$geometry"), <coords>)` (expr-lookup.ts withinHandler) and applyFilter injects the `$geometry` reserved key; the CPU even-odd containment test (eval/within.ts) honours holes + MultiPolygon. Deferred (return false): LineString/Polygon tested-geometry (needs segment-vs-ring intersection) and MVT/PMTiles tile-coordinate sources (the worker filter path does not inject `$geometry`, and the polygon arg would need lng/lat→tile reprojection). |
