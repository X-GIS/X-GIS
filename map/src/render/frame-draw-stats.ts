// ═══ FrameDrawStats — per-frame draw stats / diagnostics ═══
//
// Extracted from VectorTileRenderer (Cluster G per
// docs/architecture/design/vtr-decomposition.md §4 Step 2). This owner
// holds the per-frame draw accumulators, the render-scoped dedup map,
// the tile-drop warning dedup set, the per-decision counts, and the
// draw-order trace stash. It touches ZERO GPU state — it only counts
// and records — which makes it a pure read-out surface (design §2
// Cluster G). The hot-loop dedup `.has()`/`.set()` and the accumulator
// increments stay at their original call sites in renderTileKeys via
// the `hasDrawn`/`markDrawn` verbs below, so the Korea fill-drop dedup
// key (§5.2) and the exact accumulator arithmetic are preserved.
//
// VTR keeps thin public forwarders (getDrawStats / getTileLoadDiagnostic
// / getLastDecisionCounts) so external consumers (render-loop stats
// panel, __xgisMap diagnostics) are unchanged.

export class FrameDrawStats {
  // Per-frame draw stats
  private renderedDraws = new Map<
    number | string,
    { polyCount: number; lineCount: number; vertexCount: number }
  >()
  // DIAG: filled in by render() at the start of each show, read by
  // renderTileKeys when pushing per-tile drawIndexed entries into the
  // trace. Both fields are flag-gated and zero-cost when the trace
  // isn't armed.
  private lastTraceSlice: string | null = null
  private lastTracePhase: string | null = null
  /** Deduped tile-drop warnings. Key format: "<reason>:<z>/<x>/<y>". Once
   *  per session per key; prevents flood when panning/zooming over an area
   *  that has no data at the current level. */
  private tileDropWarnings = new Set<string>()
  private _missedTiles = 0 // tiles with no fallback this frame
  /** Per-decision counts from the last render() call. Always tracked
   *  (cheap — Map of ~7 string keys). Exposed via
   *  `getLastDecisionCounts()` for inspector / console diagnosis.
   *  Reset on every render() entry. */
  private _lastDecisionCounts: Map<string, number> = new Map()

  /** Frame-scoped accumulators (reset in beginFrame, updated in
   *  render). renderedDraws can't be reused for `tilesVisible`
   *  because multiple render() calls within a frame must each clear
   *  their own dedup set (drawKey collision would mute subsequent
   *  layers' draws of the SAME world-tile + worldOff). These
   *  counters track the FRAME total across all layer renders. */
  private _frameTilesVisible = 0
  /** iter 142 diagnostic — raw globeVisibleTiles() output length for
   *  the most recent non-Mercator selection this frame (0 for the
   *  Mercator/SSE path). Splits the non-Merc render-fail repro into
   *  (a) selection returned empty vs (c) selected-but-culled: if
   *  this is >0 while tilesVisible==0, selection is fine and the
   *  fault is downstream; if this is 0, globeVisibleTiles itself
   *  returned nothing. See project_non_mercator_systemic_2026_05_19. */
  private _frameGlobeTilesSelected = 0
  private _frameDrawCalls = 0
  private _frameTriangles = 0
  private _frameLines = 0
  private _frameVertices = 0
  /** Per-zoom drawn-tile count for the inspector's "drawn by zoom"
   *  display. Distinguishes tiles ACTUALLY rendered this frame from
   *  tiles merely retained in gpuCache. The zoom keyspace is small
   *  (~22 zoom levels max) so a Map cleared each frame is cheap. */
  private _frameDrawnByZoom: Map<number, number> = new Map()

  /** Reset the per-frame accumulators. Called once per frame by VTR's
   *  beginFrame. Does NOT clear renderedDraws — that is render-scoped
   *  (multiple render() calls within one frame each clear their own
   *  dedup set via resetRenderedDraws). */
  beginFrame(): void {
    this._missedTiles = 0
    this._frameTilesVisible = 0
    this._frameGlobeTilesSelected = 0
    this._frameDrawCalls = 0
    this._frameTriangles = 0
    this._frameLines = 0
    this._frameVertices = 0
    this._frameDrawnByZoom.clear()
  }

  /** Clear the render-scoped dedup map. Called at the start of each
   *  render() (per ShowCommand), NOT per frame. */
  resetRenderedDraws(): void {
    this.renderedDraws.clear()
  }

  /** Hot-loop dedup probe. Returns true when `key` has already been
   *  drawn this render() (skip-if-dup at the call site). Keeping this
   *  at the call site preserves the Korea fill-drop drawKey contract. */
  hasDrawn(key: number | string): boolean {
    return this.renderedDraws.has(key)
  }

  /** Record one drawn tile: mark the dedup key AND fold the per-frame
   *  accumulator increments in the SAME order/arithmetic as the
   *  original inline block. */
  markDrawn(
    key: number | string,
    polyIndexCount: number,
    lineIndexCount: number,
    vertexCount: number,
    tz: number | undefined,
  ): void {
    this.renderedDraws.set(key, {
      polyCount: polyIndexCount,
      lineCount: lineIndexCount,
      vertexCount,
    })
    // Frame-scoped accumulators (sum across all render() calls
    // within one frame so getDrawStats() reflects the FRAME total
    // for sliced sources rather than the last layer's stats).
    this._frameTilesVisible++
    this._frameVertices += vertexCount
    if (polyIndexCount > 0) {
      this._frameDrawCalls++
      this._frameTriangles += Math.floor(polyIndexCount / 3)
    }
    if (lineIndexCount > 0) {
      this._frameDrawCalls++
      this._frameLines += Math.floor(lineIndexCount / 2)
    }
    if (typeof tz === 'number') {
      this._frameDrawnByZoom.set(tz, (this._frameDrawnByZoom.get(tz) ?? 0) + 1)
    }
  }

  /** A visible tile resolved to 'pending' with no fallback this frame. */
  recordMissedTile(): void {
    this._missedTiles++
  }

  /** iter 142 diagnostic — stash the raw globeVisibleTiles() count. */
  setGlobeTilesSelected(n: number): void {
    this._frameGlobeTilesSelected = n
  }

  /** Reset the per-decision counts at the start of a render() pass. */
  clearDecisionCounts(): void {
    this._lastDecisionCounts.clear()
  }

  /** Increment the count for decision kind `d`. */
  incDecisionCount(d: string): void {
    this._lastDecisionCounts.set(d, (this._lastDecisionCounts.get(d) ?? 0) + 1)
  }

  /** Tile-drop warning dedup probe. */
  hasWarned(key: string): boolean {
    return this.tileDropWarnings.has(key)
  }

  /** Mark a tile-drop warning key as emitted. */
  markWarned(key: string): void {
    this.tileDropWarnings.add(key)
  }

  /** Stash the current slice/phase for the per-tile drawIndexed trace
   *  entries renderTileKeys is about to push. Pass null/null to clear
   *  when the trace isn't armed. */
  setTrace(slice: string | null, phase: string | null): void {
    this.lastTraceSlice = slice
    this.lastTracePhase = phase
  }

  traceSlice(): string | null {
    return this.lastTraceSlice
  }

  tracePhase(): string | null {
    return this.lastTracePhase
  }

  /** Last frame's visible-tile count (needed term in the FLICKER
   *  diagnostic). */
  needed(): number {
    return this._frameTilesVisible
  }

  /** Tiles classified as 'pending' with no fallback this frame (missed
   *  term in the FLICKER diagnostic). */
  missed(): number {
    return this._missedTiles
  }

  getDrawStats(): {
    drawCalls: number
    vertices: number
    triangles: number
    lines: number
    tilesVisible: number
    missedTiles: number
    globeTilesSelected: number
  } {
    return {
      drawCalls: this._frameDrawCalls,
      vertices: this._frameVertices,
      triangles: this._frameTriangles,
      lines: this._frameLines,
      tilesVisible: this._frameTilesVisible,
      missedTiles: this._missedTiles,
      globeTilesSelected: this._frameGlobeTilesSelected,
    }
  }

  /** Diagnostic — per-decision tile count from the last completed
   *  `render()` call. Always populated (small cost, single counter
   *  Map per VTR). Inspector / browser-console consumers query this
   *  to see what each visible tile was resolved as:
   *
   *    primary             — drew via layerCache hit
   *    parent-fallback     — cached ancestor pushed
   *    child-fallback      — deck.gl best-available children stretch
   *    overzoom-parent     — over-zoom fast-path parent at maxLevel
   *    drop-empty-slice    — sliced source: this layer empty here
   *    drop-no-archive     — tile not in archive index
   *    pending             — fetch issued, no fallback found yet
   *    queued-no-fb (BUG)  — uploadTile queued, no fallback (49d4801)
   */
  getLastDecisionCounts(): Record<string, number> {
    return Object.fromEntries(this._lastDecisionCounts)
  }
}
