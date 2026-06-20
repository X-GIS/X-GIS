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

## Spec-coverage status breakdown

| Status | Count |
|---|---:|
| supported | 150 |
| partial | 18 |
| unsupported | 67 |
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
| icon-allow-overlap | medium | No icon collision queue yet — every icon places (matches `true` semantics). OFM label_city/town/village/city_capital authoring `true` (4 layers per fixture) renders correctly. `false` would suppress overlapping icons; not implemented (would need icon-side collision bboxes). Iter 495 status review. |
| icon-overlap | medium | MapLibre overlap-policy enum. `always` matches X-GIS default (every icon places). `never`/`cooperative` need icon collision bboxes (deferred). Iter 495 status review. |
| icon-optional | low | Default `false` (icon required for label placement) is X-GIS' current contract — labels with iconImage place when both fit. OFM label_city/town/etc. all author the default. `true` (label may place icon-less) needs icon-side collision arbitration; not implemented. |
| fill-antialias | low | Default `true` byte-identical (current render path). Geometric fill-edge AA in X-GIS comes from pipeline MSAA, not a per-fragment coverage smoothstep, so it is not per-layer disable-able. The `false` opt-out IS now wired: the converter emits a `fill-antialias-false` flag (paint.ts) → ShowCommand.fillAntialias → the polygon uniform's spare cam_ecef_off_h.w lane → the fs_fill fragment gates the only fill-alpha smoothstep it has (the sphere-rim hemisphere fade, polygon_rim_alpha) on the flag, giving a hard rim edge. On flat-Mercator the rim factor is already 1.0 so `false` is visually inert there; it bites on the curved-globe/azimuthal rim. OFM liberty `landcover_wood`/`grass`/`ice` set `false`. |
| line-translate-anchor | low | viewport (default) is honoured (matches X-GIS behaviour). map coordinate space for line-translate deferred (no OFM uses). |
| icon-translate | low | CSS-px viewport offset for icons (independent of text-translate). Constant [dx, dy] form wired end-to-end: converter emits `label-icon-translate-{x,y}-N` (layers-symbol.ts) → LabelDef.iconTranslateX/Y → dispatchIcon adds it (× dpr) to the icon anchor before IconStage.addIcon (label-pass.ts), alongside icon-offset. Default [0,0] = no-op. Non-constant (expression / interpolate) form still warns + drops. |
| icon-translate-anchor | low | Only `viewport` (the value matching X-GIS' screen-space icon-translate) is honoured. `map` (world-space offset on bearing) warns + is not implemented. |
| circle-blur | low | Constant numeric form extends the point fragment smoothstep AA band via circle_params.z in the point uniform (layers-circle.ts). Zoom-interp / data-driven forms warn + drop — need a per-feature feat_data slot for per-feature blur. |
| circle-translate-anchor | low | viewport (spec default) is the only honoured mode — X-GIS point renderer always applies the translate in viewport/NDC space. 'map'-anchor (world-space shift) is unsupported and warns + drops. The anchor no-op suppression (when circle-translate is absent) mirrors fill-translate-anchor behaviour. |
| rgb / rgba | low | Constant channels only — hex-encoded at convert time. Per-channel v8 literal-wrap (`["literal", N]`) accepted. |
| hsl / hsla | low | Constant channels only — converted via CSS hsl()/hsla() and re-hexed at convert time. Per-channel v8 literal-wrap accepted. |
| interpolate (cubic-bezier) | low | Numeric-valued zoom AND data-driven interpolates densify at compile time into a piecewise-linear approximation (6 samples per segment, CSS bezier-eased via Newton-Raphson). Runtime sees a longer linear stop list and visually approximates the bezier curve. Non-numeric values (colour stops) still warn and fold to pure linear. Iter 60-62 landings. |
| format | low | Span texts concatenated via xgis concat(); per-span opts (font-scale / text-color / text-font / vertical-align) dropped — X-GIS labels render with one style per layer. Iter 25 added per-section partial-drop semantics: when one section fails to convert (e.g. uses an unsupported accessor), surviving sections still concat — only ALL-sections-fail returns null. Pre-fix any single failure bailed the whole format expression and dropped the label silently. |
| array | low | Type-assertion drops to value pass-through (X-GIS arrays carry no per-element type tag, so the spec's "abort if not array" semantic is lost; in paint/filter use a non-array would null-cascade anyway). |
