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

/** The per-frame draw totals this module publishes. Named because the shape
 *  was written out inline in BOTH this file and VectorTileRenderer's forwarder
 *  — two verbatim copies of a return type drift the moment a field is added. */
export interface DrawStatsSnapshot {
  drawCalls: number
  vertices: number
  triangles: number
  lines: number
  tilesVisible: number
  missedTiles: number
  globeTilesSelected: number
  /** `[zoom, tilesDrawn]` pairs, ascending by zoom (#1479). Added to the named
   *  shape on adoption: it landed on main as an inline field of this method's
   *  return literal, and the whole point of naming the type is that a new field
   *  is declared ONCE. */
  drawnByZoom: Array<[number, number]>
}

export class FrameDrawStats {
  // Per-frame draw stats
  /** #2309 — TWO-LEVEL and fully numeric: outer by tile key, inner by
   *  `packDrawSubKey(worldOff, visibleKey)`. It was `Map<number | string, …>`
   *  fed by a template literal on the fallback-clip path; measured on OFM
   *  Bright z14.7, 99.2% of `markDrawn` calls keyed it with a string. Two
   *  levels rather than one packed number because both `key` and `visibleKey`
   *  are tile keys and their product overflows f64 — see draw-dedup-key.ts. */
  private renderedDraws = new Map<
    number,
    Map<number, { polyCount: number; lineCount: number; vertexCount: number }>
  >()
  /** Inner maps are retained across `resetRenderedDraws` and cleared in place —
   *  the tile set is stable frame to frame, so this trades a bounded, reused
   *  set of maps for the per-render allocation a fresh outer map would cost.
   *
   *  #2560: retaining them is only free if the reset is proportional to what
   *  was DRAWN, not to what the outer map has accumulated. Nothing removes an
   *  outer entry, so `for (const inner of renderedDraws.values()) inner.clear()`
   *  walked every tile key the renderer had ever drawn, once per `render()` —
   *  and `render()` is per ShowCommand (~106x/frame on OFM Bright), not per
   *  frame. An owner profile measured it at 44.2 ms, against 21.3 ms for the
   *  `hasDrawn` + `markDrawn` pair it exists to serve: the bookkeeping cost
   *  twice the lookups. This list restores the O(drawn) reset. */
  private readonly _dirtyKeys: number[] = []
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
    // Only the keys marked since the last reset can be non-empty: an inner map
    // goes non-empty solely in `markDrawn`, which appends the key exactly when
    // it makes that transition. So clearing this list clears the map, and the
    // walk is proportional to the draws in THIS render rather than to every
    // key the session has accumulated.
    for (let i = 0; i < this._dirtyKeys.length; i++) {
      this.renderedDraws.get(this._dirtyKeys[i]!)?.clear()
    }
    this._dirtyKeys.length = 0
  }

  /** Hot-loop dedup probe. Returns true when `key` has already been
   *  drawn this render() (skip-if-dup at the call site). Keeping this
   *  at the call site preserves the Korea fill-drop drawKey contract. */
  hasDrawn(key: number, sub: number): boolean {
    const inner = this.renderedDraws.get(key)
    return inner !== undefined && inner.has(sub)
  }

  /** Record one drawn tile: mark the dedup key AND fold the per-frame
   *  accumulator increments in the SAME order/arithmetic as the
   *  original inline block. */
  markDrawn(
    key: number,
    sub: number,
    polyIndexCount: number,
    lineIndexCount: number,
    vertexCount: number,
    tz: number | undefined,
  ): void {
    let inner = this.renderedDraws.get(key)
    if (inner === undefined) {
      inner = new Map()
      this.renderedDraws.set(key, inner)
    }
    // The empty→non-empty transition is the only moment a key becomes something
    // the next reset must clear, and it happens at most once per key per render
    // — so this appends each drawn key exactly once, never grows within a
    // render, and is emptied by every reset.
    if (inner.size === 0) this._dirtyKeys.push(key)
    inner.set(sub, {
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
  /** Bulk form for the immediate arm (#1046 Inc-E2b): the *Rhi entries
   *  report missing tiles as a RETURN VALUE; the chain's keep-warm gate reads
   *  THIS counter instead, so the fork folds the sum in here — dropping it
   *  froze a half-loaded frame (the #834 M5 slice-5 incident class). */
  recordMissedTiles(n: number): void {
    this._missedTiles += n
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

  getDrawStats(): DrawStatsSnapshot {
    return {
      drawCalls: this._frameDrawCalls,
      vertices: this._frameVertices,
      triangles: this._frameTriangles,
      lines: this._frameLines,
      tilesVisible: this._frameTilesVisible,
      missedTiles: this._missedTiles,
      globeTilesSelected: this._frameGlobeTilesSelected,
      drawnByZoom: this.drawnByZoom(),
    }
  }

  /** `[zoom, tilesDrawn]` pairs for this frame, ascending by zoom — the
   *  `_frameDrawnByZoom` accumulator as a JSON-safe, ordered array.
   *
   *  This is the DIRECT observable for "how coarse is the tile set", and the
   *  only one that is: `tilesVisible` counts tiles without saying how big they
   *  are, and `triangles` measures the geometry a tile happens to carry, which
   *  is a property of the SOURCE and not of the selection. A synthetic fixture
   *  whose features do not generalise with zoom makes triangles rise as the
   *  horizon coarsens — a coarser tile spans more ground, so it carries more of
   *  a uniformly-dense source than the finer tiles it replaced. That inversion
   *  is what left `_adaptive-quality-ladder-gate` deterministically red (#1479)
   *  while the ladder was working correctly. Zoom cannot invert: coarsening is
   *  DEFINED as a lower drawn zoom. */
  drawnByZoom(): Array<[number, number]> {
    return [...this._frameDrawnByZoom.entries()].sort((a, b) => a[0] - b[0])
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
