// ═══════════════════════════════════════════════════════════════════
// Line-label drop attribution (bounded observability)
// ═══════════════════════════════════════════════════════════════════
//
// "MapLibre labels this road and X-GIS does not" is the recurring parity
// question, and screenshots cannot answer it: a missing label looks the same
// whether the placement walk found no anchor, the #1314 edge inset rejected the
// one it found, the cross-tile dedupe suppressed it, or the collision pass
// dropped it downstream. Three attempts in one session to localise such a drop
// by re-rendering and comparing crops each ended up probing a code path that was
// not the one in play — including a "0 px diff" that meant the patched branch
// never ran, not that the patch had no effect (CLAUDE.md §12).
//
// So the pass counts WHY instead. Every line-label emit attempt lands in exactly
// one bucket, and the buckets sum to the attempts — which is what makes a count
// trustworthy: an unaccounted drop shows up as a mismatch, not as silence.
//
// SRP + FrameDrawStats/TextStageDiagnostics precedent: one owner, verbs at the
// call sites. ZERO influence on draws — a defect here shows up in a counter,
// never in pixels.

/** Why a line-label placement attempt did not become a drawn label — or that it
 *  did. Ordered along the pipeline, so the first non-zero bucket walking down is
 *  the earliest stage that is losing labels. */
export interface LineLabelDropCounts {
  /** The projected run held fewer than two samples: every sample failed to
   *  project, or #1050 broke the run to avoid a phantom chord. The label never
   *  reached the placement walk. */
  runTooShort: number
  /** The walk ran but the world lattice put no stop on this run — `total` clears
   *  the short-line branch yet holds no `phase + k · spacing`. A known gap: see
   *  §4 of docs/plans/2026-07-27-line-label-world-anchored-placement.md. */
  noLatticeStop: number
  /** A stop existed but sampling it fell past the end of the projected polyline
   *  (curved branch only — the walk and the sampler measure the same arc, so
   *  this should stay at 0; a non-zero value means they have drifted apart). */
  offRun: number
  /** #1314 viewport edge inset rejected the anchor as too close to a screen
   *  edge. World-anchored stops land near run starts more often than the old
   *  half-step cadence did, so this is the bucket that grew with INC-1/INC-2. */
  edgeInset: number
  /** Cross-tile dedupe: the same resolved text is already placed nearby. */
  sameTextNearby: number
  /** Icon-only line symbol whose position bucket is already taken (#603). */
  iconDuplicate: number
  /** Reached TextStage / IconStage. NOT the same as visible: the curved
   *  text-max-angle gate and the collision pass can still drop it, and those are
   *  counted by TextStageDiagnostics' submitted-vs-drawn pair. */
  emitted: number
}

const ZERO: LineLabelDropCounts = {
  runTooShort: 0,
  noLatticeStop: 0,
  offRun: 0,
  edgeInset: 0,
  sameTextNearby: 0,
  iconDuplicate: 0,
  emitted: 0,
}

/** Per-frame line-label drop attribution. Reset at frame start by the label
 *  pass; read after a frame to answer "which stage lost this label". */
export class LineLabelDropStats {
  private counts: LineLabelDropCounts = { ...ZERO }

  reset(): void {
    this.counts = { ...ZERO }
  }

  bump(reason: keyof LineLabelDropCounts): void {
    this.counts[reason]++
  }

  /** Snapshot. Copied, so a caller holding it across frames does not observe the
   *  next frame's reset — the counters are a per-frame quantity and a live view
   *  would silently read as zero. */
  snapshot(): LineLabelDropCounts {
    return { ...this.counts }
  }

  /** Attempts that reached the walk, i.e. everything except `runTooShort`.
   *  Exposed because the useful ratio is per-attempt, not per-frame. */
  static attempts(c: LineLabelDropCounts): number {
    return c.noLatticeStop + c.offRun + c.edgeInset + c.sameTextNearby + c.iconDuplicate + c.emitted
  }
}

/** Does the world lattice put no stop on a run of `totalPx`? True only for a run
 *  that CLEARS the short-line branch (which always places at the midpoint) and
 *  still holds no `phase + k · spacing`. Shared by both branches so they cannot
 *  disagree about what "the lattice missed this run" means. */
export function latticeMissesRun(firstStopPx: number, spacingPx: number, totalPx: number): boolean {
  return spacingPx > 0 && totalPx >= spacingPx * 0.5 && firstStopPx > totalPx
}

/** Wrap a placement cull so its rejections are attributed to `edgeInset`.
 *  Keeps `placeLabelsAlongLine` a pure placement function that knows nothing
 *  about diagnostics — the walk's signature does not change. */
export function countedCull(
  stats: LineLabelDropStats,
  cull: (x: number, y: number) => boolean,
): (x: number, y: number) => boolean {
  return (x, y) => {
    if (cull(x, y)) return true
    stats.bump('edgeInset')
    return false
  }
}

/** Wrap a placement emit so successful placements are counted. */
export function countedEmit<A extends unknown[]>(
  stats: LineLabelDropStats,
  emit: (...a: A) => void,
): (...a: A) => void {
  return (...a) => {
    stats.bump('emitted')
    emit(...a)
  }
}
