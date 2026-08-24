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
| symbol | symbol-sort-key | data-driven | Expression flattens to 0; per-feature key plumbing pending |
| fill-extrusion | fill-extrusion-pattern | data-driven | Expression form not threaded through IR |
| raster | raster-opacity | data-driven | Data-driven not applicable to raster tiles |
| hillshade | resampling | constant | The single-pass fragment renders the nearest 3×3 decoded-height field; linear decoded-height smoothing is the documented two-pass upgrade. |

## Spec-coverage status breakdown

| Status | Count |
|---|---:|
| supported | 194 |
| partial | 20 |
| unsupported | 18 |
| na | 15 |
| **total** | **247** |

## High-impact unsupported entries

Properties marked `unsupported` with `impact: high` — these are the most visible gaps to close next.

| Property | Note |
|---|---|

## Partial entries

Properties marked `partial` — converter accepts but runtime degrades. These need either runtime extension or downgrading to `unsupported`.

| Property | Impact | Note |
|---|---|---|
| tileSize | medium | Runtime IS tileSize-aware: RasterRenderer defaults to 256 px and biases the raster cover-zoom by log2(512/tileSize) (raster-renderer.ts:93-97, default :274), and the xgis DSL already parses a source-level tileSize: property end-to-end onto SourceDef (compiler/src/ir/lower.ts:201-202), which map.ts wires into setTileSize(). The gap is upstream of all that: the Mapbox-style CONVERTER never emits the style-declared tileSize into the generated xgis source block, so a converted style always falls back to the runtime default regardless of what the style actually said. #1983 tracks adding the emit. Visible today on OFM Liberty's ne2_shaded (tileSize: 256, coincidentally matching the default — the same gap would misrender a genuine 512-px source). |
| minzoom / maxzoom | low | Source-level zoom bounds (distinct from a layer's minzoom/maxzoom). Runtime DOES clamp a maxzoom that reaches it — raster sources thread source.maxzoom through to RasterRenderer.setSourceMaxzoom, capping rasterCoverZoom (map.ts:3743-3745) — and a PMTiles archive / TileJSON manifest already carries its own authoritative minzoom+maxzoom that the runtime reads straight from the archive header / manifest (vector-tile-loader.ts:470-472, :541-543), independent of the style JSON's minzoom/maxzoom fields. The gap is narrower than 'unhonoured': the CONVERTER never emits the STYLE-DECLARED value into the xgis source block, so only a source with no metadata channel of its own (a plain raster/geojson endpoint) loses it. #1983 tracks the emit. No visual difference — out-of-range tiles 404 and fall back to a parent tile, wasteful but not incorrect. |
| symbol (icon-only) | medium | Icon-only symbol layers (no text-field) route to the icon stage (#777 I1/I2, PR #965): constant `icon-image` → `label-icon-image-<name>`; data-driven `icon-image: ["match"|"coalesce"|["image", …]]` → per-feature `label-icon-image-[<expr>]` → IconStage.addIcon. Still partial: the icon LAYOUT tail (icon-text-fit / icon-padding / icon-keep-upright / icon-pitch-alignment) and text/icon halo are deferred to the Phase I remainder. |
| symbol-sort-key | medium | Constant numeric value plumbed end-to-end (iter 399-405). Runtime collision pass sorts CollisionItems by sortKey ascending — lower wins. Expression form (`["get", "rank"]`) flattens to 0 with a warning. |
| text-overlap | low | MapLibre overlap-policy enum (never / always / cooperative). always → label-allow-overlap; never → default; cooperative approximated as always (priority-aware collision pending) + warning. Wins over legacy text-allow-overlap when both declared. |
| text-pitch-alignment | medium | Converter emits, runtime ignores — labels never project onto ground plane (`LabelDef.pitchAlignment` has NO consumer in map/src; the text vertex path emits screen-px quads at z=0). NOT opt-in, and this was under-reported until #777 IV3 was re-scoped: the spec default `auto` matches text-rotation-alignment, whose own `auto` is `map` for line / line-center placement, so EVERY line-placed label resolves to map without authoring anything — 5 text-bearing layers per OFM style (road names, waterway names, along-line shields), 0 of which author the property. The converter now warns on the RESOLVED value, not just an explicit `map`; only an explicit `viewport` (on either knob) or point placement stays silent. Icon-only line layers are excluded — their gap is icon-pitch-alignment. |
| icon-offset | low | Constant numeric [x, y] in CSS px only, split into label-icon-offset-x / -y utilities. Non-constant forms (legacy {stops} or an interpolate expression) warn and drop as of #1977, which moves the conversion into convertIconOffset in layers-helpers.ts. Constant is the overwhelmingly common authoring pattern (no OFM fixture even declares a non-constant icon-offset); 'low' impact reflects how rarely a style zoom-interpolates it. |
| fill-antialias | low | Default `true` byte-identical (current render path). Geometric fill-edge AA in X-GIS comes from pipeline MSAA, not a per-fragment coverage smoothstep, so it is not per-layer disable-able. The `false` opt-out IS now wired: the converter emits a `fill-antialias-false` flag (paint.ts) → ShowCommand.fillAntialias → the polygon uniform's spare cam_ecef_off_h.w lane → the fs_fill fragment gates the only fill-alpha smoothstep it has (the sphere-rim hemisphere fade, polygon_rim_alpha) on the flag, giving a hard rim edge. On flat-Mercator the rim factor is already 1.0 so `false` is visually inert there; it bites on the curved-globe/azimuthal rim. OFM liberty `landcover_wood`/`grass`/`ice` set `false`. |
| icon-translate | low | CSS-px viewport offset for icons (independent of text-translate). Constant [dx, dy] form wired end-to-end: converter emits `label-icon-translate-{x,y}-N` (layers-symbol.ts) → LabelDef.iconTranslateX/Y → dispatchIcon adds it (× dpr) to the icon anchor before IconStage.addIcon (label-pass.ts), alongside icon-offset. Default [0,0] = no-op. #777 I-F: the per-feature EXPRESSION form (case/match/get → [dx,dy]) now lowers to `label-icon-translate-[<expr>]` → LabelDef.iconTranslateExpr → applyFeatureExprs evaluates it per feature into iconTranslateX/Y. Still PARTIAL for one residual sub-form: zoom-`interpolate` of the [dx,dy] tuple snaps to the nearest stop (the runtime evaluate does NOT component-interpolate array-valued stops), so a smoothly zoom-animated translate is approximate. |
| circle-blur | low | Constant numeric form extends the point fragment smoothstep AA band via circle_params.z in the point uniform (layers-circle.ts). Zoom-interp / data-driven forms warn + drop — need a per-feature feat_data slot for per-feature blur. |
| circle-translate-anchor | low | viewport (spec default) is the only honoured mode — X-GIS point renderer always applies the translate in viewport/NDC space. 'map'-anchor (world-space shift) is unsupported and warns + drops. The anchor no-op suppression (when circle-translate is absent) mirrors fill-translate-anchor behaviour. |
| raster-fade-duration | low | Constant-only (#1257). Emits raster-fade-duration-<ms> → paintShapes.raster.fadeDurationMs, overriding the per-tile cross-fade duration (RasterRenderer, runtime default 300ms / XGISMapOptions.rasterFadeDuration) for the authored layer. Zoom-interp / data-driven forms warn and drop. |
| resampling | low | linear (spec default) / nearest DEM sampling. The MVP single-pass fragment renders the nearest 3×3 field (byte-parity with MapLibre nearest); linear decoded-height smoothing is the documented two-pass upgrade. |
| interpolate (cubic-bezier) | low | Numeric-valued AND hex-colour-valued zoom/data-driven interpolates densify at compile time into a piecewise-linear approximation (6 samples per segment, CSS bezier-eased via Newton-Raphson; colour stops sampled in sRGB at the eased fraction). Runtime sees a longer linear stop list and visually approximates the bezier curve. Expression-valued (non-literal) stops still warn and fold to pure linear — eased samples can't be computed at compile time. Iter 60-62 + colour-stop landing. |
| format | low | Span texts concatenated via xgis concat(); per-span TYPOGRAPHY opts (font-scale / text-color / text-font / vertical-align) dropped — X-GIS labels render with one style per layer. Per-section partial-drop semantics: when one section fails to convert (e.g. uses an unsupported accessor), surviving sections still concat — only ALL-sections-fail returns null. An `["image", …]` section IS carried now (#777 I-G): it lowers to the `image(name)` builtin → an inline sprite quad on the text baseline (imageHandler + evaluator; see the `image` row). Still partial only for the typography opts. |
| collator | low | Locale-aware comparator as the trailing 4th arg of ==/!=/</<=/>/>=. Constant collator options (case-sensitive / diacritic-sensitive / locale) are fully supported: comparisonHandler lowers `["==", a, b, ["collator", opts]]` to the `collator_cmp` CPU builtin (eval/collator.ts) backed by Intl.Collator. Non-constant (per-feature expression) options fall back to byte-exact compare with a warning; a STANDALONE `["collator", …]` (not on a comparison) still warns (no value alone). |
| resolved-locale | low | Returns the BCP-47 tag a collator resolves to. Constant collator locale supported: resolvedLocaleHandler lowers `["resolved-locale", ["collator", opts]]` to the `resolved_locale` CPU builtin (Intl.Collator.resolvedOptions().locale). Non-constant collator options warn + drop. |
| array | low | Type-assertion drops to value pass-through (X-GIS arrays carry no per-element type tag, so the spec's "abort if not array" semantic is lost; in paint/filter use a non-array would null-cascade anyway). |
| distance | low | Shortest distance (metres) between the feature and a target GeoJSON. Point/MultiPoint feature-geometry vs any target is supported on GeoJSON sources: distanceHandler decomposes the constant target into points/segments/polygons (compile time) and lowers to the `distance(get("$geometry"), …)` CPU builtin (eval/distance.ts), which uses a cheap-ruler (latitude-corrected planar) metre metric and treats inside-polygon as 0. Deferred (return null): LineString/Polygon feature-geometry and MVT/PMTiles tile-coordinate sources (the worker filter path does not inject `$geometry`). |
| within | low | Geometry-containment filter. Point/MultiPoint tested-geometry vs Polygon/MultiPolygon argument is fully supported on GeoJSON sources: the converter lowers ["within", poly] to `within(get("$geometry"), <coords>)` (expr-lookup.ts withinHandler) and applyFilter injects the `$geometry` reserved key; the CPU even-odd containment test (eval/within.ts) honours holes + MultiPolygon. Deferred (return false): LineString/Polygon tested-geometry (needs segment-vs-ring intersection) and MVT/PMTiles tile-coordinate sources (the worker filter path does not inject `$geometry`, and the polygon arg would need lng/lat→tile reprojection). |
