// P0-7 accessibility baseline — extracted from map.ts (§2 god-file decomposition).
// The renderer is canvas-only with no internal DOM, so the host's <canvas> is the
// keyboard / screen-reader surface. These free functions carry the focus-ring
// stylesheet injection, the canvas ARIA/tabindex wiring, and the keyboard
// pan/zoom handler; XGISMap keeps only thin wrappers that own the handler ref.

import type { CameraController } from './camera-controller'

/** Inject a single shared stylesheet that draws a focus ring on any X-GIS
 *  canvas — only when keyboard-driven (`:focus-visible`), so a pointer click
 *  doesn't show the ring. Module-once via the `injected` guard flag; targets
 *  the `data-xgis-map` marker `setupCanvasA11y` sets, which is stable even if
 *  the host overrides role / aria-label. */
let injected = false
export function injectFocusStyle(): void {
  if (injected) return
  if (typeof document === 'undefined' || !document.head) return
  injected = true
  const style = document.createElement('style')
  style.setAttribute('data-xgis-a11y', '')
  style.textContent =
    'canvas[data-xgis-map]:focus-visible{' + 'outline:3px solid #4d90fe;outline-offset:2px;}'
  document.head.appendChild(style)
}

/** Make the host-supplied canvas focusable (`tabindex=0`), named for assistive
 *  tech (`role="region"` + `aria-label`), marked for the shared focus-ring
 *  stylesheet (`data-xgis-map`), and wire the `keydown` listener. Skipped when
 *  the canvas is not a real DOM element (the unit-test mock is a bare
 *  `{ width, height }` object) — mirrors the `typeof document === 'undefined'`
 *  guard in `showWebGPUUnavailableDefault`. Returns `true` only when the
 *  listener was actually attached, so the caller stores the handler ref (for
 *  destroy-time detach) and injects the focus style ONLY then — preserving the
 *  original guarded-body behaviour (a bare mock never latches `_keyDownHandler`,
 *  so destroy() doesn't call removeEventListener on it). */
export function setupCanvasA11y(
  canvas: HTMLCanvasElement,
  ariaLabel: string | undefined,
  onKeyDown: (e: KeyboardEvent) => void,
): boolean {
  if (typeof document === 'undefined') return false
  if (
    !canvas ||
    typeof canvas.setAttribute !== 'function' ||
    typeof canvas.addEventListener !== 'function'
  )
    return false
  // Focusable + named for assistive tech. Only set tabIndex if the host
  // hasn't already made it focusable, so an embedder's explicit choice
  // (e.g. tabindex=-1 to drive focus programmatically) is preserved.
  if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0
  if (!canvas.hasAttribute('role')) canvas.setAttribute('role', 'region')
  if (!canvas.hasAttribute('aria-label')) canvas.setAttribute('aria-label', ariaLabel ?? 'Map')
  // Marker the shared focus-ring stylesheet targets (independent of the
  // role/aria-label values, which a host may override).
  canvas.setAttribute('data-xgis-map', '')
  canvas.addEventListener('keydown', onKeyDown)
  return true
}

/** Keyboard pan/zoom (P0-7). Arrow keys pan, `+`/`=` zoom in, `-`/`_`
 *  zoom out, Shift accelerates the pan. Routes through the shared
 *  `cameraController` (same path as drag/wheel) so the render-loop
 *  camera-diff fires `move`/`moveend`/`zoom*` for free. `preventDefault`
 *  is called ONLY for keys we act on, and we bail when an unhandled
 *  modifier (Ctrl/Alt/Meta) is held so we don't steal browser shortcuts. */
export function handleMapKeyDown(
  e: KeyboardEvent,
  deps: { destroyed: boolean; camera: CameraController; onInteract: () => void },
): void {
  if (deps.destroyed) return
  // Leave browser / OS chords (Ctrl+, Alt+, Cmd+) alone. Shift is the
  // only modifier we consume (fast pan).
  if (e.ctrlKey || e.altKey || e.metaKey) return
  // prefers-reduced-motion: keyboard pan/zoom are already instant jumps
  // (no transition infra), so there is nothing to suppress; honored here
  // as a forward-looking guard for when easeTo/flyTo gain animation.
  const PAN_PX = 80
  const FAST_PX = 320
  const step = e.shiftKey ? FAST_PX : PAN_PX
  switch (e.key) {
    case 'ArrowUp':
      deps.camera.panBy([0, -step])
      break
    case 'ArrowDown':
      deps.camera.panBy([0, step])
      break
    case 'ArrowLeft':
      deps.camera.panBy([-step, 0])
      break
    case 'ArrowRight':
      deps.camera.panBy([step, 0])
      break
    case '+':
    case '=':
      deps.camera.zoomIn()
      break
    case '-':
    case '_':
      deps.camera.zoomOut()
      break
    default:
      return // not a key we handle — leave default behaviour intact
  }
  e.preventDefault()
  // Mirror the pointer-gesture bookkeeping (onPointerDown): the user has
  // taken control of the camera, so the post-compile bounds auto-fit must
  // not clobber it, and the interaction-DPR path can kick in.
  deps.onInteract()
}
