// Runtime capability flags — per property × value-form what the
// renderer actually honours. Pairs with compiler/src/convert/
// spec-coverage.ts to detect silent drops: compiler accepts the
// property as "supported" but runtime ignores or partial-handles it.
//
// Mapping convention: layer.property:variant where variant is one of:
//   * 'constant'     — single literal value
//   * 'zoom-interp'  — interpolate-by-zoom (PropertyShape variant)
//   * 'data-driven'  — per-feature expression (case / match / get)
//
// Set to false ONLY when the runtime path drops or silently degrades
// the input. Phase 3.1+ landings flip flags true as the gaps close.

export interface RuntimeCapability {
  property: string
  layerType: string
  variant: 'constant' | 'zoom-interp' | 'data-driven'
  supported: boolean
  /** When false, brief reason for the gap. */
  note?: string
}

export const RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = [
  // Fill
  { property: 'fill-color',          layerType: 'fill', variant: 'constant',    supported: true },
  { property: 'fill-color',          layerType: 'fill', variant: 'zoom-interp', supported: true },
  { property: 'fill-color',          layerType: 'fill', variant: 'data-driven', supported: true },
  { property: 'fill-opacity',        layerType: 'fill', variant: 'constant',    supported: true },
  { property: 'fill-opacity',        layerType: 'fill', variant: 'zoom-interp', supported: true },
  { property: 'fill-opacity',        layerType: 'fill', variant: 'data-driven', supported: false, note: 'Per-feature opacity not threaded through renderer' },
  { property: 'fill-antialias',      layerType: 'fill', variant: 'constant',    supported: false, note: 'false branch not implemented; pipeline always uses MSAA' },
  { property: 'fill-translate',      layerType: 'fill', variant: 'constant',    supported: true },
  { property: 'fill-translate',      layerType: 'fill', variant: 'zoom-interp', supported: true,  note: 'WS-1 — per-frame: fillTranslate{X,Y}Shape resolved each frame in resolveShow (resolveNumberShape) → VTR NDC bake.' },
  { property: 'line-translate',      layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-translate',      layerType: 'line', variant: 'zoom-interp', supported: true,  note: 'WS-1 — per-frame via strokeTranslate{X,Y}Shape (mirrors fill-translate, resolved in resolveShow).' },
  { property: 'fill-extrusion-translate', layerType: 'fill-extrusion', variant: 'constant',    supported: true },
  { property: 'fill-extrusion-translate', layerType: 'fill-extrusion', variant: 'zoom-interp', supported: true,  note: 'WS-1 — routes through the fill-translate path; same per-frame resolve, applied in the extrude VS u.fill_translate.' },
  // iter-181/182/183/184 Stage 2 — UV-tiled sprite atlas sampled in
  // fs_fill_pattern with world-anchored UV. Constant string sprite
  // name only; expression form still warns at convert.
  { property: 'fill-pattern',        layerType: 'fill', variant: 'constant',    supported: true },
  { property: 'fill-pattern',        layerType: 'fill', variant: 'data-driven', supported: false, note: 'Expression form of fill-pattern (per-feature sprite name) not threaded through IR' },

  // Line
  { property: 'line-color',          layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-color',          layerType: 'line', variant: 'zoom-interp', supported: true },
  { property: 'line-color',          layerType: 'line', variant: 'data-driven', supported: true },
  { property: 'line-width',          layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-width',          layerType: 'line', variant: 'zoom-interp', supported: true },
  { property: 'line-width',          layerType: 'line', variant: 'data-driven', supported: true },
  { property: 'line-opacity',        layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-opacity',        layerType: 'line', variant: 'zoom-interp', supported: true },
  { property: 'line-blur',           layerType: 'line', variant: 'constant',    supported: true,  note: 'Strict-zero NOT honoured yet (1.5px soft fade at blur=0)' },
  { property: 'line-dasharray',      layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-dasharray',      layerType: 'line', variant: 'zoom-interp', supported: true,  note: 'WS-1 — PropertyShape<number[]> resolved per frame (resolveArrayShape STEP, Mapbox dash is interpolated:false) in resolveShow → VTR prefers ResolvedShow.dashArray.' },
  { property: 'line-gap-width',      layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-gap-width',      layerType: 'line', variant: 'zoom-interp', supported: true },
  { property: 'line-offset',         layerType: 'line', variant: 'constant',    supported: true },
  // iter-185 Stage 2 — UV-tiled sprite atlas sampled in fs_line_pattern
  // with world-anchored UV. Stage 2.1 along-line UV pending.
  { property: 'line-pattern',        layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-pattern',        layerType: 'line', variant: 'data-driven', supported: false, note: 'Expression form not threaded through IR' },

  // Symbol (text)
  { property: 'text-color',          layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-color',          layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'text-color',          layerType: 'symbol', variant: 'data-driven', supported: true },
  { property: 'text-opacity',        layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-opacity',        layerType: 'symbol', variant: 'zoom-interp', supported: true,  note: 'WS-1 — LabelShapes.opacity PropertyShape resolved per frame in render-loop-helpers (resolveNumberShape into resolvedColor.a + halo.a). Iter 113.' },
  { property: 'text-opacity',        layerType: 'symbol', variant: 'data-driven', supported: false, note: 'Per-feature alpha path deferred' },
  { property: 'text-halo-color',     layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-halo-color',     layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'text-halo-width',     layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-halo-width',     layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'text-pitch-alignment', layerType: 'symbol', variant: 'constant',   supported: false, note: 'Runtime never projects labels onto ground plane' },

  // Symbol (icon)
  { property: 'icon-opacity',        layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'icon-opacity',        layerType: 'symbol', variant: 'zoom-interp', supported: false, note: 'Per-feature alpha attr path deferred' },
  { property: 'icon-opacity',        layerType: 'symbol', variant: 'data-driven', supported: false, note: 'Per-feature alpha path deferred' },
  { property: 'icon-size',           layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'icon-size',           layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'icon-size',           layerType: 'symbol', variant: 'data-driven', supported: false, note: 'Worker per-feature evaluator pending' },
  { property: 'symbol-sort-key',     layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'symbol-sort-key',     layerType: 'symbol', variant: 'data-driven', supported: false, note: 'Expression flattens to 0; per-feature key plumbing pending' },

  // Circle
  { property: 'circle-radius',       layerType: 'circle', variant: 'constant',    supported: true },
  { property: 'circle-radius',       layerType: 'circle', variant: 'zoom-interp', supported: true },
  { property: 'circle-radius',       layerType: 'circle', variant: 'data-driven', supported: true },
  { property: 'circle-color',        layerType: 'circle', variant: 'constant',    supported: true },
  { property: 'circle-color',        layerType: 'circle', variant: 'zoom-interp', supported: true },
  { property: 'circle-color',        layerType: 'circle', variant: 'data-driven', supported: true },

  // Fill-extrusion
  { property: 'fill-extrusion-color',  layerType: 'fill-extrusion', variant: 'constant',    supported: true },
  { property: 'fill-extrusion-color',  layerType: 'fill-extrusion', variant: 'zoom-interp', supported: true },
  { property: 'fill-extrusion-height', layerType: 'fill-extrusion', variant: 'constant',    supported: true },
  { property: 'fill-extrusion-height', layerType: 'fill-extrusion', variant: 'zoom-interp', supported: true },
  { property: 'fill-extrusion-height', layerType: 'fill-extrusion', variant: 'data-driven', supported: true },
  { property: 'fill-extrusion-base',   layerType: 'fill-extrusion', variant: 'constant',    supported: true },
  { property: 'fill-extrusion-opacity', layerType: 'fill-extrusion', variant: 'constant',   supported: true },
  { property: 'fill-extrusion-vertical-gradient', layerType: 'fill-extrusion', variant: 'constant', supported: true, note: 'Phase 9 vertical gradient lighting honoured (commit 2026-05-18).' },
  // iter-186 Stage 2 — extruded variant of fillPipelinePattern;
  // fragment shares fs_fill_pattern with the ground path. Walls lose
  // the wall_shade lighting in this Stage 2 cut (Stage 2.1 follow-up).
  { property: 'fill-extrusion-pattern', layerType: 'fill-extrusion', variant: 'constant', supported: true, note: 'Walls + roofs sample atlas via fs_fill_pattern; wall_shade lighting deferred to Stage 2.1' },
  { property: 'fill-extrusion-pattern', layerType: 'fill-extrusion', variant: 'data-driven', supported: false, note: 'Expression form not threaded through IR' },

  // Fill outline (lowers to stroke- utilities in xgis)
  { property: 'fill-outline-color',  layerType: 'fill', variant: 'constant',    supported: true },
  { property: 'fill-outline-color',  layerType: 'fill', variant: 'zoom-interp', supported: true },

  // Line layout
  { property: 'line-cap',            layerType: 'line', variant: 'constant',    supported: true,  note: 'butt / round / square literal only' },
  { property: 'line-join',           layerType: 'line', variant: 'constant',    supported: true,  note: 'miter / round / bevel literal only' },
  { property: 'line-miter-limit',    layerType: 'line', variant: 'constant',    supported: true },

  // Symbol layout — common
  { property: 'symbol-placement',    layerType: 'symbol', variant: 'constant',  supported: true,  note: 'point / line / line-center literal' },
  { property: 'symbol-spacing',      layerType: 'symbol', variant: 'constant',  supported: true },

  // Symbol text layout
  { property: 'text-field',          layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-field',          layerType: 'symbol', variant: 'data-driven', supported: true },
  { property: 'text-font',           layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-size',           layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-size',           layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'text-size',           layerType: 'symbol', variant: 'data-driven', supported: true,  note: 'sizeExpr per-feature evaluation' },
  { property: 'text-max-width',      layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-line-height',    layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-letter-spacing', layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-letter-spacing', layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'text-justify',        layerType: 'symbol', variant: 'constant',    supported: true,  note: 'auto / left / center / right literal' },
  { property: 'text-anchor',         layerType: 'symbol', variant: 'constant',    supported: true,  note: '9-way enum literal' },
  { property: 'text-variable-anchor', layerType: 'symbol', variant: 'constant',   supported: true },
  { property: 'text-variable-anchor-offset', layerType: 'symbol', variant: 'constant', supported: true },
  { property: 'text-radial-offset',  layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-offset',         layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-rotate',         layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-padding',        layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-padding',        layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'text-transform',      layerType: 'symbol', variant: 'constant',    supported: true,  note: 'uppercase / lowercase / none literal' },
  { property: 'text-allow-overlap',  layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-ignore-placement', layerType: 'symbol', variant: 'constant',  supported: true },
  { property: 'text-rotation-alignment', layerType: 'symbol', variant: 'constant', supported: true, note: 'map / viewport / auto literal' },
  { property: 'text-keep-upright',   layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-translate',      layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-halo-blur',      layerType: 'symbol', variant: 'constant',    supported: true,  note: 'IR exposes PropertyShape; non-constant emits warn until shape-resolve lands' },

  // Symbol icon layout
  { property: 'icon-image',          layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'icon-image',          layerType: 'symbol', variant: 'data-driven', supported: true,  note: 'match/case via label-icon-image-[<expr>] (iter 490)' },
  { property: 'icon-rotate',         layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'icon-anchor',         layerType: 'symbol', variant: 'constant',    supported: true,  note: '9-way enum literal' },
  { property: 'icon-offset',         layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'icon-rotation-alignment', layerType: 'symbol', variant: 'constant', supported: true, note: 'map / viewport / auto literal (iter 506)' },

  // Circle (remaining)
  { property: 'circle-opacity',      layerType: 'circle', variant: 'constant',    supported: true },
  { property: 'circle-opacity',      layerType: 'circle', variant: 'zoom-interp', supported: true },
  { property: 'circle-stroke-color', layerType: 'circle', variant: 'constant',    supported: true },
  { property: 'circle-stroke-color', layerType: 'circle', variant: 'zoom-interp', supported: true },
  { property: 'circle-stroke-width', layerType: 'circle', variant: 'constant',    supported: true },
  { property: 'circle-stroke-width', layerType: 'circle', variant: 'zoom-interp', supported: true },
  { property: 'circle-stroke-opacity', layerType: 'circle', variant: 'constant',  supported: true,  note: 'Folds into stroke-color hex alpha at compile time (iter 4)' },
  { property: 'circle-stroke-opacity', layerType: 'circle', variant: 'zoom-interp', supported: true,  note: 'Resolved per frame by PointRenderer.updateDynamicSizes and multiplied into the baked stroke alpha (feat_data slot 8) — WS-1 part 4' },
  { property: 'circle-translate',    layerType: 'circle', variant: 'constant',    supported: true },
  { property: 'circle-translate',    layerType: 'circle', variant: 'zoom-interp', supported: true,  note: 'WS-1 — per-frame via circleTranslate{X,Y}Shape resolved in PointRenderer.updateDynamicSizes into the point frame uniform.' },

  // Background (top-level directive in xgis)
  { property: 'background-color',    layerType: 'background', variant: 'constant',  supported: true },
  { property: 'background-color',    layerType: 'background', variant: 'zoom-interp', supported: true,  note: 'WS-1 — interpolate(zoom, …) fill resolves per frame: flat via the background-pass clear, sphere via the synthetic earth-surface show paintShapes.fill' },
  { property: 'background-opacity',  layerType: 'background', variant: 'constant',  supported: true,  note: 'Folds into background-color hex alpha (iter 47)' },
  { property: 'background-opacity',  layerType: 'background', variant: 'zoom-interp', supported: true,  note: 'WS-1 — opacity: interpolate(zoom, …) resolves per frame and multiplies into the background clear alpha' },

  // Raster (remaining tracks supported by raster-renderer)
  { property: 'raster-opacity',      layerType: 'raster', variant: 'data-driven', supported: false, note: 'Data-driven not applicable to raster tiles' },
] as const

/** Lookup a (layerType, property, variant) tuple. Returns undefined
 *  when not catalogued — caller may treat that as "unknown" but the
 *  drift test gates a missing entry as well. */
export function runtimeCapability(
  layerType: string,
  property: string,
  variant: RuntimeCapability['variant'],
): RuntimeCapability | undefined {
  return RUNTIME_CAPABILITIES.find(
    c => c.layerType === layerType && c.property === property && c.variant === variant,
  )
}

/** Subset of capability rows where the runtime is known to drop or
 *  degrade the input. Useful for surfacing the gap matrix in docs
 *  or as a regression watch list. */
export function runtimeGaps(): readonly RuntimeCapability[] {
  return RUNTIME_CAPABILITIES.filter(c => !c.supported)
}
