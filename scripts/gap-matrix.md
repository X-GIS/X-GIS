# X-GIS Mapbox Support Gap Matrix

Generated: 2026-05-18T23:46:40.290Z

## Runtime capability gaps

Properties where the runtime currently degrades or drops a specific value-form.

| Layer | Property | Variant | Note |
|---|---|---|---|
| fill | fill-opacity | data-driven | Per-feature opacity not threaded through renderer |
| fill | fill-antialias | constant | false branch not implemented; pipeline always uses MSAA |
| fill | fill-translate | zoom-interp | Per-frame zoom-interp deferred; last-stop approx only |
| line | line-dasharray | zoom-interp | PropertyShape<array> variant pending |
| symbol | text-opacity | zoom-interp | Fast-path resolves constant only |
| symbol | text-opacity | data-driven | Per-feature alpha path deferred |
| symbol | text-pitch-alignment | constant | Runtime never projects labels onto ground plane |
| symbol | icon-opacity | zoom-interp | Per-feature alpha attr path deferred |
| symbol | icon-opacity | data-driven | Per-feature alpha path deferred |
| symbol | icon-size | data-driven | Worker per-feature evaluator pending |
| symbol | symbol-sort-key | data-driven | Expression flattens to 0; per-feature key plumbing pending |

## Spec-coverage status breakdown

| Status | Count |
|---|---:|
| supported | 126 |
| partial | 22 |
| unsupported | 87 |
| na | 7 |
| **total** | **242** |

## High-impact unsupported entries

Properties marked `unsupported` with `impact: high` — these are the most visible gaps to close next.

| Property | Note |
|---|---|
| symbol (icon-only) | No text-field → skipped. Awaits Batch 2 (sprite atlas). |
| fill-pattern | Batch 2 (bitmap atlas). |
| icon-color | SDF icon tint — needs IconStage vertex tint attribute + fragment tint multiply. Currently surfaces via ignoredText warning; PNG sprite path renders the un-tinted texel. Plan §4 deferred. |
| image | Sprite atlas (Batch 2). |

## Partial entries

Properties marked `partial` — converter accepts but runtime degrades. These need either runtime extension or downgrading to `unsupported`.

| Property | Impact | Note |
|---|---|---|
| projection | low | mercator only; URL `?proj=` provides limited overrides at runtime. |
| raster-dem | medium | Source registered, no hillshade renderer yet (Batch 4). |
| symbol-sort-key | medium | Constant numeric value plumbed end-to-end (iter 399-405). Runtime collision pass sorts CollisionItems by sortKey ascending — lower wins. Expression form (`["get", "rank"]`) flattens to 0 with a warning. |
| text-overlap | low | MapLibre overlap-policy enum (never / always / cooperative). always → label-allow-overlap; never → default; cooperative approximated as always (priority-aware collision pending) + warning. Wins over legacy text-allow-overlap when both declared. |
| text-pitch-alignment | medium | Converter emits, runtime ignores — labels never project onto ground plane. |
| icon-allow-overlap | medium | No icon collision queue yet — every icon places (matches `true` semantics). OFM label_city/town/village/city_capital authoring `true` (4 layers per fixture) renders correctly. `false` would suppress overlapping icons; not implemented (would need icon-side collision bboxes). Iter 495 status review. |
| icon-overlap | medium | MapLibre overlap-policy enum. `always` matches X-GIS default (every icon places). `never`/`cooperative` need icon collision bboxes (deferred). Iter 495 status review. |
| icon-optional | low | Default `false` (icon required for label placement) is X-GIS' current contract — labels with iconImage place when both fit. OFM label_city/town/etc. all author the default. `true` (label may place icon-less) needs icon-side collision arbitration; not implemented. |
| background-color | low | Constant + CSS form only — interpolate-by-zoom of background falls through (rare). |
| fill-antialias | low | Default `true` is X-GIS' permanent contract — fragment shader smoothsteps every fill edge. OFM bright `building` / `road_area_pier` / `road_pier` author `true` explicitly = no-op match. OFM liberty `landcover_wood`/`grass`/`ice` set `false` for a pixel-art look; that opt-out (4 liberty layers) is not yet implemented and renders smooth instead of stepped. Iter 495 status review. |
| fill-translate | low | Constant vec2 + zoom-interp last-stop approx end-to-end. Runtime WGSL u.fill_translate_x/y adds CSS-px offset converted to NDC at vs_main (`clip.xy += u.fill_translate * clip.w`). OFM building-top pseudo-3D roof offset honoured. Full per-frame zoom-interp deferred. Iter 501 + 508 shipped 2026-05-18. |
| line-dasharray | medium | Constant numeric array only — interpolate-by-zoom dasharray not lowered. |
| text-opacity | low | Constant form folded into label-color alpha channel. Zoom-interp / data-driven defer to a per-frame paint shape; non-constant still warns. Iter 488 shipped 2026-05-18. |
| icon-opacity | high | Constant form threads compiler → LabelDef → IconStage.addIcon → per-vertex opacity attribute → fragment alpha multiplier. Zoom-interp / data-driven deferred (per-feature alpha would need iconOpacityExpr path). Iter 492 shipped 2026-05-18. |
| circle-stroke-opacity | low | Constant numeric form folds into stroke-color hex alpha (Plan §4 partial landing). Zoom-interp / data-driven forms still warn + drop — need a dedicated paint shape for per-frame uniform multiplication. |
| rgb / rgba | low | Constant channels only — hex-encoded at convert time. Per-channel v8 literal-wrap (`["literal", N]`) accepted. |
| hsl / hsla | low | Constant channels only — converted via CSS hsl()/hsla() and re-hexed at convert time. Per-channel v8 literal-wrap accepted. |
| interpolate (cubic-bezier) | low | Folded to linear with a warning — no per-stop bezier evaluator yet. |
| interpolate-hcl | low | Approximated as linear-RGB with a warning — no LAB/HCL per-stop evaluator yet. |
| interpolate-lab | low | Approximated as linear-RGB with a warning — no LAB/HCL per-stop evaluator yet. |
| format | low | Span texts concatenated via xgis concat(); per-span opts (font-scale / text-color / text-font / vertical-align) dropped — X-GIS labels render with one style per layer. |
| array | low | Type-assertion drops to value pass-through (X-GIS arrays carry no per-element type tag, so the spec's "abort if not array" semantic is lost; in paint/filter use a non-array would null-cascade anyway). |
