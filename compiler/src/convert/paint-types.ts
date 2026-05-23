// ═══ Mapbox paint → xgis: shared types ═══
// Type/interface declarations extracted from paint.ts so the paint
// conversion module stays focused on logic. Internal-only types are
// imported via `import type` where needed.

export interface InterpolateZoomShape {
  /** Mapbox interpolate curve. `'linear'` (default) emits the existing
   *  `interpolate(zoom, …)` xgis form; `'exponential'` emits
   *  `interpolate_exp(zoom, base, …)` which the lower pass detects
   *  and stores alongside the stops so the runtime can apply the
   *  same accelerated curve Mapbox would. */
  curve: 'linear' | 'exponential'
  /** Curve base — meaningful only when `curve === 'exponential'`.
   *  Default 1 (= linear) for the linear branch; explicit value for
   *  the exponential branch. */
  base: number
  stops: Array<{ zoom: number; value: unknown }>
}
