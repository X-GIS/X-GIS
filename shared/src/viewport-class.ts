// ═══ Viewport class — the single "is this a phone?" authority ═══
//
// Three data-pipeline throttles — GPU-upload concurrency in `uploadBudgetFor`
// and the upload-coordinator per-frame cap (@xgis/map), plus the MVT
// worker-fleet ceiling (@xgis/data) — must agree on ONE definition of "mobile".
// They previously each re-derived it from raw viewport width alone (`<= 900`),
// so a small DESKTOP window (a measured 860px headless/desktop viewport) was
// mistaken for a phone and dropped to phone-grade caps: a 4× upload cliff plus
// worker starvation. This is the shared classifier they all route through, so
// the definition lives in exactly one place (the divergence shape CLAUDE.md
// warns about, resolved by a single authority).

/** Largest CSS-pixel viewport dimension still treated as phone-class. Phones
 *  and small tablets sit at/below this on their narrow axis; laptops and
 *  desktop windows sit above. Necessary — not sufficient (see below). */
const MAX_MOBILE_CSS_DIMENSION = 900

/**
 * True for phone-class viewports: a coarse PRIMARY pointer AND a small CSS
 * dimension. The single authority for the data pipeline's "mobile" throttle.
 *
 * @param cssDimension viewport/canvas extent in CSS pixels — e.g.
 *   `window.innerWidth`, or `Math.max(canvasW, canvasH) / dpr`. Must be CSS px,
 *   never device px: a DPR=3 phone's device-pixel canvas would read as desktop.
 *
 * Semantics:
 *  - `cssDimension <= 900` is NECESSARY but no longer SUFFICIENT.
 *  - Also requires a coarse PRIMARY pointer via `matchMedia('(pointer: coarse)')`.
 *    `(pointer: coarse)` reflects the PRIMARY pointer, so touch LAPTOPS (mouse
 *    primary, touchscreen secondary) report fine and keep the desktop budget —
 *    unlike `navigator.maxTouchPoints`, which misclassifies them. Phones and
 *    tablets report coarse.
 *  - Non-positive `cssDimension` (0 / NaN / undefined width from a not-yet-laid-
 *    out or headless surface) is NEVER phone-class — a missing measurement must
 *    not trip the throttle.
 *  - When `matchMedia` is unavailable (SSR, some Workers, vitest node) it
 *    CONSERVATIVELY falls back to width-only, byte-identical to the pre-
 *    classifier behavior in those environments (they had no pointer signal).
 *
 * Pure w.r.t. its argument + the ambient media query. The MediaQueryList
 * OBJECT is cached (#1177: the per-frame `matchMedia()` CALL — query parse +
 * MQL construction — profiled at ~68 ms/2% during zoom; the old comment's
 * "cheap" claim was refuted by that profile) while `.matches` is read fresh
 * every call: an MQL's `.matches` is LIVE, so device-mode emulation toggling
 * the pointer type is still reflected immediately — no staleness trade.
 */
// Keyed on the matchMedia FUNCTION identity: a real browser never swaps it
// (permanent cache hit), while environments that replace it (test stubs,
// teardown/re-setup) re-derive automatically — the cache is exactly as live
// as the environment.
let mqlSource: typeof matchMedia | null = null
let coarsePointerMql: MediaQueryList | null = null

export function isMobileClassViewport(cssDimension: number): boolean {
  // Necessary size gate; `!(x > 0)` also rejects 0 / NaN / undefined width
  // (which a bare `x <= 900` would wrongly admit).
  if (!(cssDimension > 0) || cssDimension > MAX_MOBILE_CSS_DIMENSION) return false
  // No media-query engine (SSR / Worker / vitest node): width-only fallback,
  // preserving today's behavior where no pointer signal was ever consulted.
  if (typeof matchMedia === 'undefined') return true
  if (mqlSource !== matchMedia) {
    mqlSource = matchMedia
    coarsePointerMql = matchMedia('(pointer: coarse)')
  }
  return coarsePointerMql!.matches
}
