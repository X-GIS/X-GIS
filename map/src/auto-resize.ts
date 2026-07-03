// ═══ Auto resize / DPR tracking (P0-3) ═══
//
// Without this, a CSS container resize or a monitor-swap DPR change while
// the map is IDLE leaves a stretched/blurry canvas until the host calls
// map.resize() manually: resizeCanvas() picks up clientWidth × dpr only
// inside a rendered frame, and the idle skip-gate never schedules one.
//
// Both observers funnel into the EXISTING public resize() path (passed in
// as `onResize`, which just invalidates). The render loop's once-per-rAF
// cadence is the debounce, and the per-frame resizeCanvas() remains the
// single place that actually reconfigures the swapchain — no new resize
// logic lives here.

/** Attach (a) a ResizeObserver on the canvas's parent container (the
 *  canvas itself when unparented — matches what resizeCanvas() measures)
 *  and (b) a matchMedia resolution-change chain that re-arms itself after
 *  every DPR flip (the query literal pins the CURRENT dpr, so each change
 *  needs a fresh MediaQueryList — the standard tracking idiom).
 *
 *  Returns a single detach function for destroy() (teardown mirror:
 *  disconnects the observer + removes the live MQL listener). No-ops and
 *  returns a noop detach in non-browser/test environments. */
export function attachAutoResize(canvas: HTMLCanvasElement, onResize: () => void): () => void {
  let ro: ResizeObserver | null = null
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => onResize())
    ro.observe((canvas.parentElement ?? canvas) as Element)
  }

  let detachDpr: (() => void) | null = null
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    let mql: MediaQueryList
    const onDprChange = (): void => {
      onResize()
      arm()
    }
    const arm = (): void => {
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      // { once } self-removes on fire; arm() re-attaches on the NEW dpr's
      // query, so the chain survives any number of monitor swaps. `?.`
      // tolerates legacy MQLs without addEventListener (old Safari).
      mql.addEventListener?.('change', onDprChange, { once: true })
    }
    arm()
    detachDpr = () => mql.removeEventListener?.('change', onDprChange)
  }

  return () => {
    ro?.disconnect()
    ro = null
    detachDpr?.()
    detachDpr = null
  }
}
