// ═══ Visibility pause / resume (#1153 M5) ═══
//
// iOS reclaims GPU resources from a backgrounded tab, and any hidden tab burns
// rAF/CPU for frames nobody sees. This attaches the document/window visibility
// listeners that let the map PARK its render loop while hidden (stop scheduling
// rAF, keep state) and RESUME it on return (re-render + re-arm). All policy —
// what "park" and "resume" actually do, including the deferred device-lost
// recovery — lives in the map (the handlers it passes in); this module is only
// the event plumbing, mirroring auto-resize.ts.

/** Attach visibility listeners and route them to the map's park/resume handlers:
 *   - document 'visibilitychange' → onHidden when hidden, else onVisible
 *   - window 'pagehide'  → onHidden (tab suspend / navigation away)
 *   - window 'pageshow'  → onVisible when the page is visible (bfcache restore
 *     may not fire visibilitychange, so pageshow is the reliable resume signal)
 *
 *  Returns a single detach function for destroy() (removes all three listeners).
 *  No-ops and returns a noop detach in non-DOM / test environments. */
export function attachVisibilityPause(handlers: {
  onHidden: () => void
  onVisible: () => void
}): () => void {
  if (typeof document === 'undefined') return () => {}

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') handlers.onHidden()
    else handlers.onVisible()
  }
  const onPageHide = (): void => handlers.onHidden()
  const onPageShow = (): void => {
    if (document.visibilityState === 'visible') handlers.onVisible()
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  const hasWindow = typeof window !== 'undefined'
  if (hasWindow) {
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
  }

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (hasWindow) {
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  }
}
