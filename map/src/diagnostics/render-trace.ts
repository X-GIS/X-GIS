// ═══════════════════════════════════════════════════════════════════
// Render Trace (Phase 1 of "X-GIS as a compiler" plan)
// ═══════════════════════════════════════════════════════════════════
//
// Captures the INTENT a frame submits to the GPU — every layer's
// resolved paint state, every label's resolved text/color/halo, every
// tile-LOD decision — as a structured FrameTrace JSON. Two consumers:
//
//   1. vitest invariant tests (compiler/src/__tests__/spec-invariants/)
//      assert on the resolved values WITHOUT firing a WebGPU pass.
//   2. e2e diagnostic specs (playground/e2e/_debug-*.spec.ts) capture
//      a real frame's trace alongside the screenshot for human review.
//
// Why intent-level not pixel-level:
//   - Most spec-compliance bugs surface at IR / paint-resolution / text-
//     submission, NOT at pixel composition. The Mapbox style spec is a
//     contract between authored style.json and a structured intent —
//     pixel diff is downstream noise.
//   - Pixel diff stays as the final safety net (see Step 5 of the plan)
//     for shader / blend / glyph atlas regressions.
//
// Zero production cost:
//   - VTR / LineRenderer / TextStage / bucket-scheduler each carry an
//     optional `traceRecorder?: RenderTraceRecorder` field.
//   - Every emit site guards `if (this.traceRecorder !== null) { ... }`.
//     With recorder=null (the production path), V8 branch-predicts the
//     null check away — measurable cost is 0 across the hot path.
//   - Production build can additionally `--define:__DEV_TRACE__=false`
//     for dead-code elimination of the recorder import.

// ─── Shared atomic types ───────────────────────────────────────────

export type RGBA = readonly [number, number, number, number]

// ─── Layer (fill / stroke) record ──────────────────────────────────

/** One layer's resolved paint state for the current frame. The
 *  `resolved*` fields are the values that actually reach the GPU
 *  after bucket-scheduler ran zoom × time stop evaluation. Tests
 *  assert on these as the canonical "what did we tell the GPU to
 *  paint" answer. */
export interface TraceLayer {
  /** Mapbox / xgis layer id. */
  layerName: string
  /** Bucket classification — same enum the VTR uses. */
  fillPhase: 'fills' | 'strokes' | 'all'
  /** Post-resolution opacity (zoom × time × scalar). */
  resolvedOpacity: number
  /** Post-resolution stroke width in CSS px. */
  resolvedStrokeWidth: number
  /** Post-resolution fill colour, omitted for layers without a fill. */
  resolvedFill?: RGBA
  /** Post-resolution stroke colour, omitted for layers without a stroke. */
  resolvedStroke?: RGBA
  /** Dash array in MERCATOR METRES (already scaled by mpp × line-width
   *  per the Mapbox spec). Omitted for solid strokes. */
  dashArrayMeters?: readonly number[]
  /** AA half-width in CSS px the line shader uses for edge feathering.
   *  Captured so invariant tests can check "AA <= line_width / 2 +
   *  buffer" against the resolved stroke width. */
  aaWidthPx?: number
}

// ─── Label record (point + curve placement) ────────────────────────

export interface TraceLabel {
  /** Mapbox / xgis layer id the label originated from. */
  layerName: string
  /** Final visible string after `text-field` evaluation + transform. */
  text: string
  /** Resolved fill colour applied to the glyph body. */
  color: RGBA
  /** Resolved halo, if the layer authors `text-halo-width > 0`. */
  halo?: {
    color: RGBA
    /** Halo extent in CSS px (BEFORE DPR / scale conversion). */
    width: number
    /** Optional outer fade in CSS px. */
    blur: number
  }
  /** Family component of the CSS font shorthand (e.g. "Open Sans" —
   *  weight / italic peeled off into the next two fields). */
  fontFamily: string
  /** CSS font-weight (100..900). Default 400 if author didn't ask
   *  for a specific weight. */
  fontWeight: number
  /** CSS font-style. */
  fontStyle: 'normal' | 'italic'
  /** Display size in CSS px. */
  sizePx: number
  /** `point` for centroid-anchored, `curve` for along-path. */
  placement: 'point' | 'curve'
  /** `placed` if the label survived collision; `collision-dropped`
   *  if greedy bbox collision evicted it; `out-of-frustum` if it
   *  failed NDC culling. Captured so tests can assert "this label
   *  IS visible" / "this label was dropped". */
  state: 'placed' | 'collision-dropped' | 'out-of-frustum'
  /** Anchor screen position in CSS px (post-projection). For curve
   *  labels this is the FIRST glyph anchor. */
  anchorScreenX: number
  anchorScreenY: number
}

// ─── Tile LOD decision ─────────────────────────────────────────────

export interface TraceTileLOD {
  /** The currentZ (cz) the VTR settled on for the active frame.
   *  Vector-source parity rule (2026-05-15): `cz = floor(camera.zoom)`,
   *  matching MapLibre's `coveringZoomLevel` for tileSize=512 sources. */
  selectedCz: number
  /** Canonical tileKey strings the frame ATTEMPTED to fetch (one per
   *  visible viewport tile at cz). Distinct from cached ancestors. */
  fetchedKeys: readonly string[]
}

// ─── Frame-level wrapper ───────────────────────────────────────────

/** One frame's complete intent snapshot. JSON-serialisable so tests
 *  can snapshot or pretty-print directly. */
export interface FrameTrace {
  /** Fractional camera zoom at frame submission. */
  cameraZoom: number
  /** Camera centre as [lon, lat]. */
  cameraCenter: readonly [number, number]
  /** Camera bearing in degrees, 0-360. 0 = north up. */
  cameraBearing: number
  /** Camera pitch (tilt) in degrees, 0-85. 0 = top-down. */
  cameraPitch: number
  /** Map projection name (e.g. 'mercator', 'equirect'). */
  projection: string
  /** Render target size in physical pixels (canvas.width / height). */
  viewportPx: readonly [number, number]
  /** Device pixel ratio (canvas.width / CSS px width). */
  dpr: number
  /** Tile-LOD selection for the frame. */
  tileLOD: TraceTileLOD
  /** Layer paint state, ordered by ShowCommand declaration order. */
  layers: TraceLayer[]
  /** Labels — both point and curve placement, including dropped. */
  labels: TraceLabel[]
}

// ─── Recorder interface (production-safe) ──────────────────────────

/** Hook surface every render component writes to. Implementations:
 *
 *    `null`                    — production / no-trace path. Branch-
 *                                predicted away in hot loops.
 *    `InMemoryRecorder`        — vitest unit tests. Accumulates into a
 *                                FrameTrace then returns via snapshot().
 *    (future) `JsonStreamRecorder` — Playwright spec, streams to disk
 *                                between frames for replay-style review.
 *
 *  The interface is intentionally small — every new record method
 *  pushes us toward shipping a new GPU-side detail. Avoid bloating
 *  beyond paint / label / tile-LOD until a concrete invariant needs it. */
export interface CameraTraceSnapshot {
  zoom: number
  centerLon: number
  centerLat: number
  bearing: number
  pitch: number
  projection: string
  viewportWidthPx: number
  viewportHeightPx: number
  dpr: number
}

export interface RenderTraceRecorder {
  recordCamera(snap: CameraTraceSnapshot): void
  recordTileLOD(lod: TraceTileLOD): void
  recordLayer(layer: TraceLayer): void
  recordLabel(label: TraceLabel): void
  /** Returns the accumulated trace AND resets internal state so the
   *  recorder can be reused across multiple test frames. */
  snapshot(): FrameTrace
}

// ─── In-memory implementation for vitest / e2e ─────────────────────

/** Default in-memory accumulator. Cheap object allocation; resets on
 *  `snapshot()` so the same instance can drive a multi-frame replay. */
export class InMemoryTraceRecorder implements RenderTraceRecorder {
  private cameraZoom = 0
  private cameraCenter: [number, number] = [0, 0]
  private cameraBearing = 0
  private cameraPitch = 0
  private projection = 'mercator'
  private viewportPx: [number, number] = [0, 0]
  private dpr = 1
  private tileLOD: TraceTileLOD = { selectedCz: 0, fetchedKeys: [] }
  private layers: TraceLayer[] = []
  private labels: TraceLabel[] = []

  recordCamera(snap: CameraTraceSnapshot): void {
    this.cameraZoom = snap.zoom
    this.cameraCenter = [snap.centerLon, snap.centerLat]
    this.cameraBearing = snap.bearing
    this.cameraPitch = snap.pitch
    this.projection = snap.projection
    this.viewportPx = [snap.viewportWidthPx, snap.viewportHeightPx]
    this.dpr = snap.dpr
  }

  recordTileLOD(lod: TraceTileLOD): void {
    this.tileLOD = lod
  }

  recordLayer(layer: TraceLayer): void {
    this.layers.push(layer)
  }

  recordLabel(label: TraceLabel): void {
    this.labels.push(label)
  }

  /** Returns the accumulated trace and resets internal state. */
  snapshot(): FrameTrace {
    const out: FrameTrace = {
      cameraZoom: this.cameraZoom,
      cameraCenter: this.cameraCenter,
      cameraBearing: this.cameraBearing,
      cameraPitch: this.cameraPitch,
      projection: this.projection,
      viewportPx: this.viewportPx,
      dpr: this.dpr,
      tileLOD: this.tileLOD,
      layers: this.layers,
      labels: this.labels,
    }
    this.cameraZoom = 0
    this.cameraCenter = [0, 0]
    this.cameraBearing = 0
    this.cameraPitch = 0
    this.projection = 'mercator'
    this.viewportPx = [0, 0]
    this.dpr = 1
    this.tileLOD = { selectedCz: 0, fetchedKeys: [] }
    this.layers = []
    this.labels = []
    return out
  }
}

/** Convenience factory — caller writes
 *    const rec = createTraceRecorder()
 *    map.setTraceRecorder(rec)
 *  No need to import the class directly. */
export function createTraceRecorder(): RenderTraceRecorder {
  return new InMemoryTraceRecorder()
}
