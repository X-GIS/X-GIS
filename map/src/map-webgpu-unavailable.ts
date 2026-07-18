// Default WebGPU-unavailable UX — extracted from map.ts (§2 god-file decomposition).
// Shown when the host did NOT register an onWebGPUUnavailable() handler: renders a
// message in the map container instead of leaving a silent blank canvas (the
// renderer is WebGPU-only, there is no Canvas 2D / WebGL fallback). The host can
// override this by registering onWebGPUUnavailable().

export function showWebGPUUnavailableDefault(canvas: HTMLCanvasElement | null | undefined): void {
  const msg = 'This map requires a WebGPU-capable browser (latest Chrome/Edge, or Safari 18+).'

  console.warn('[X-GIS] ' + msg + ' Register onWebGPUUnavailable() to customize this.')
  if (typeof document === 'undefined') return
  const parent = canvas?.parentElement
  if (!parent || parent.querySelector('[data-xgis-webgpu-unavailable]')) return
  const el = document.createElement('div')
  el.setAttribute('data-xgis-webgpu-unavailable', '')
  el.setAttribute('role', 'alert')
  el.textContent = msg
  el.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'text-align:center;padding:1rem;box-sizing:border-box;' +
    'font:14px/1.5 system-ui,-apple-system,sans-serif;color:#e5e7eb;background:#111827;'
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
  parent.appendChild(el)
}
