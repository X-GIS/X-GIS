// ═══ Tile-selection truncation reporting (#1374) ═══
//
// The SSE selector caps how many primary tiles it emits. When that cap bites the
// viewport is genuinely uncovered — tiles the user should see are never
// requested, so they simply do not appear. The selector used to return a short
// array with nothing anywhere saying so, which is exactly how "tiles that should
// be visible are missing" reaches a user with no diagnostic to go on.
//
// The selector reports through a callback rather than logging itself: it is
// content-blind engine code and must not own a UX policy. This module is that
// policy for the map.

/** Caps already reported. Selection runs EVERY frame, so an unthrottled warn
 *  would fire at 60 Hz and bury the console it is trying to inform. The cap is
 *  effectively constant per session, so one line per distinct cap is the whole
 *  signal — a repeat carries no new information. */
const warned = new Set<number>()

/** Warn once per distinct cap that the selection was truncated. */
export function warnSelectionTruncated(emitted: number, cap: number): void {
  if (warned.has(cap)) return
  warned.add(cap)
  console.warn(
    `[X-GIS] tile selection hit its ${cap}-tile emit cap (emitted ${emitted}) — the ` +
      `viewport is NOT fully covered and some visible tiles will be missing. Reduce ` +
      `the scene's tile demand (lower zoom / pitch, fewer sources) or raise the cap.`,
  )
}

/** Test seam — forget which caps have been reported. */
export function _resetTruncationWarningsForTests(): void {
  warned.clear()
}
