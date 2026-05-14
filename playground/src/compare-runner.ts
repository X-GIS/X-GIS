// MapLibre GL JS ↔ X-GIS side-by-side comparison.
//
// Both engines mount the SAME parsed style.json (MapLibre directly,
// X-GIS via convertMapboxStyle → run()). Camera state is the URL
// hash `#z/lat/lon/bearing/pitch` shared with `demo.html` so deep
// links round-trip. Drag in either pane drives the other through a
// last-write-wins guard.

import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { XGISMap } from '@xgis/runtime'
import { convertMapboxStyle } from '@xgis/compiler'

// ── Style catalogue ─────────────────────────────────────────────────
const STYLES: { id: string; label: string; url: string }[] = [
  { id: 'maplibre-demotiles',   label: 'MapLibre demotiles',   url: 'https://demotiles.maplibre.org/style.json' },
  { id: 'openfreemap-bright',   label: 'OFM Bright',           url: 'https://tiles.openfreemap.org/styles/bright' },
  { id: 'openfreemap-liberty',  label: 'OFM Liberty',          url: 'https://tiles.openfreemap.org/styles/liberty' },
  { id: 'openfreemap-positron', label: 'OFM Positron',         url: 'https://tiles.openfreemap.org/styles/positron' },
]

// ── Hash math ───────────────────────────────────────────────────────
// Copied from demo-runner.ts:604-647 — keep in sync if the demo
// runner changes the convention. The handful of lines are pure +
// trivial enough that a shared module isn't worth the extra coupling.
const R_EARTH = 6378137
const DEG = 180 / Math.PI
const RAD = Math.PI / 180

interface CameraView {
  zoom: number; lat: number; lon: number; bearing: number; pitch: number
}

function parseHash(): CameraView | null {
  const h = location.hash.replace(/^#/, '')
  if (!h) return null
  const parts = h.split('/').map(parseFloat)
  if (parts.length < 3 || parts.some(Number.isNaN)) return null
  const [zoom, lat, lon, bearing = 0, pitch = 0] = parts
  return { zoom, lat, lon, bearing, pitch }
}

function formatHash(v: CameraView): string {
  const tail = (v.bearing || v.pitch) ? `/${v.bearing.toFixed(1)}/${v.pitch.toFixed(1)}` : ''
  return `#${v.zoom.toFixed(2)}/${v.lat.toFixed(5)}/${v.lon.toFixed(5)}${tail}`
}

function xgisCameraToView(map: XGISMap): CameraView {
  const cam = map.getCamera()
  const lon = (cam.centerX / R_EARTH) * DEG
  const lat = (2 * Math.atan(Math.exp(cam.centerY / R_EARTH)) - Math.PI / 2) * DEG
  return { zoom: cam.zoom, lat, lon, bearing: cam.bearing, pitch: cam.pitch }
}

function applyViewToXgis(map: XGISMap, v: CameraView): void {
  const cam = map.getCamera()
  cam.zoom = Math.max(0, Math.min(cam.maxZoom, v.zoom))
  cam.centerX = v.lon * RAD * R_EARTH
  const clampLat = Math.max(-85.051129, Math.min(85.051129, v.lat))
  cam.centerY = Math.log(Math.tan(Math.PI / 4 + clampLat * RAD / 2)) * R_EARTH
  cam.bearing = v.bearing
  cam.pitch = v.pitch
  map.markCameraPositioned()
}

// ── Element refs ────────────────────────────────────────────────────
const styleSelect = document.getElementById('style-select') as HTMLSelectElement
const styleUrlInput = document.getElementById('style-url') as HTMLInputElement
const reloadBtn = document.getElementById('reload-btn') as HTMLButtonElement
const mlContainer = document.getElementById('ml-map') as HTMLDivElement
const xgCanvas = document.getElementById('xg-canv') as HTMLCanvasElement
const hashLabel = document.getElementById('cam-hash') as HTMLSpanElement
const statusLabel = document.getElementById('status-msg') as HTMLSpanElement

// Populate style picker
for (const s of STYLES) {
  const opt = document.createElement('option')
  opt.value = s.id
  opt.textContent = s.label
  styleSelect.appendChild(opt)
}

function pickInitialStyle(): { id: string; url: string } {
  const params = new URLSearchParams(location.search)
  const fromQuery = params.get('style')
  const fromStorage = localStorage.getItem('xgis.compare.style')
  for (const candidate of [fromQuery, fromStorage]) {
    if (!candidate) continue
    const match = STYLES.find(s => s.id === candidate)
    if (match) return { id: match.id, url: match.url }
    // Free-form URL fallback
    if (/^https?:\/\//.test(candidate)) return { id: '__custom__', url: candidate }
  }
  return { id: STYLES[0]!.id, url: STYLES[0]!.url }
}

// ── State ───────────────────────────────────────────────────────────
let mlMap: maplibregl.Map | null = null
let xgMap: XGISMap | null = null
let xgRafId = 0
let lastSyncedHash = ''
let syncSource: 'ml' | 'xg' | null = null

function setStatus(msg: string): void {
  statusLabel.textContent = msg
}

function defaultViewForStyle(): CameraView {
  return { zoom: 2, lat: 20, lon: 0, bearing: 0, pitch: 0 }
}

// ── Mount ────────────────────────────────────────────────────────────
async function mountBoth(url: string): Promise<void> {
  setStatus('Fetching style.json…')

  let styleJson: unknown
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    styleJson = await res.json()
  } catch (e) {
    setStatus(`Style fetch failed: ${(e as Error).message}`)
    return
  }

  const initialView = parseHash() ?? defaultViewForStyle()

  // Tear down any previous instances first
  if (mlMap) { mlMap.remove(); mlMap = null }
  if (xgMap) {
    cancelAnimationFrame(xgRafId)
    xgMap.stop?.()
    xgMap = null
  }
  ;(window as unknown as { __mlReady?: boolean }).__mlReady = false

  // ── MapLibre side ────────────────────────────────────────────────
  setStatus('Mounting MapLibre…')
  mlMap = new maplibregl.Map({
    container: mlContainer,
    style: styleJson as maplibregl.StyleSpecification,
    center: [initialView.lon, initialView.lat],
    zoom: initialView.zoom,
    bearing: initialView.bearing,
    pitch: initialView.pitch,
    hash: false,
    // ML chrome OFF for fair pixel-parity measurement (X-GIS pane has
    // neither attribution nor navigation controls). The compare page
    // is a dev tool; production embeds should opt the controls back in.
    attributionControl: false,
  })
  // No NavigationControl — same rationale as attributionControl above.
  // The top-right `+ / − / compass` widget only existed on the ML side
  // and dominated the pixel-diff with chrome rather than map content.
  ;(window as unknown as { __mlMap?: maplibregl.Map }).__mlMap = mlMap

  mlMap.on('load', () => {
    ;(window as unknown as { __mlReady?: boolean }).__mlReady = true
  })

  mlMap.on('move', () => {
    if (!mlMap || !xgMap) return
    if (syncSource === 'xg') return // currently propagating xg → ml, skip echo
    syncSource = 'ml'
    const c = mlMap.getCenter()
    applyViewToXgis(xgMap, {
      zoom: mlMap.getZoom(),
      lat: c.lat,
      lon: c.lng,
      bearing: mlMap.getBearing(),
      pitch: mlMap.getPitch(),
    })
    // Clear the source flag on the next frame so xg's rAF tick
    // can resume reading without immediately rebounding to ml.
    requestAnimationFrame(() => { if (syncSource === 'ml') syncSource = null })
  })

  // ── X-GIS side ────────────────────────────────────────────────────
  setStatus('Converting + mounting X-GIS…')
  const inlineGeoJSON = new Map<string, unknown>()
  let xgisSrc: string
  try {
    xgisSrc = convertMapboxStyle(styleJson as Parameters<typeof convertMapboxStyle>[0], { inlineGeoJSON })
  } catch (e) {
    setStatus(`convertMapboxStyle failed: ${(e as Error).message}`)
    return
  }

  // Same font-loading prerequisite as demo-runner — see comment there
  // for the rationale. Without this, X-GIS atlas caches glyphs in the
  // host's system fallback before our @font-face WOFF2 lands, and the
  // visual stays "wrong" until eviction.
  try { await document.fonts?.ready } catch { /* no-op */ }
  xgMap = new XGISMap(xgCanvas)
  ;(window as unknown as { __xgisMap?: XGISMap }).__xgisMap = xgMap
  // Forward the style's `glyphs` URL — TextStage uses it to fetch
  // MapLibre SDF PBF glyphs so labels render with the authored font
  // (e.g. "Open Sans Semibold") rather than the host's nearest match.
  // Canvas2D stays the fallback when the network is offline or a
  // requested codepoint isn't in the PBF range.
  const glyphsUrl = (styleJson as { glyphs?: unknown }).glyphs
  if (typeof glyphsUrl === 'string' && glyphsUrl.length > 0) {
    xgMap.setGlyphsUrl(glyphsUrl)
  }
  // Same handoff for the sprite atlas — the runtime IconStage will
  // lazily fetch `${url}.json` + `${url}.png` on its first prepare().
  const spriteUrl = (styleJson as { sprite?: unknown }).sprite
  if (typeof spriteUrl === 'string' && spriteUrl.length > 0) {
    xgMap.setSpriteUrl(spriteUrl)
  }
  try {
    await xgMap.run(xgisSrc, location.origin + '/')
  } catch (e) {
    setStatus(`X-GIS run() failed: ${(e as Error).message}`)
    return
  }
  // Push any inline-geojson sources captured during conversion (mirrors
  // demo-runner's auto-push path).
  for (const [id, data] of inlineGeoJSON) {
    xgMap.setSourceData?.(id, data as Parameters<NonNullable<XGISMap['setSourceData']>>[1])
  }
  // Initial camera (parseHash sets it but convertMapboxStyle's bounds-
  // fit pass may have nudged us — re-apply to be sure).
  applyViewToXgis(xgMap, initialView)

  // X-GIS → MapLibre sync loop (rAF poll; the engine has no event hook
  // for camera writes from the user's pointer driver).
  const tick = () => {
    if (!mlMap || !xgMap) return
    const view = xgisCameraToView(xgMap)
    const hash = formatHash(view)
    if (hash !== lastSyncedHash) {
      lastSyncedHash = hash
      hashLabel.textContent = hash
      // Rate-limited history write (iOS Safari throttles replaceState
      // past 100 calls / 10s).
      if (performance.now() - lastHistoryWrite > 200) {
        lastHistoryWrite = performance.now()
        history.replaceState(null, '', location.pathname + location.search + hash)
      }
      if (syncSource !== 'ml') {
        syncSource = 'xg'
        mlMap.jumpTo({
          center: [view.lon, view.lat],
          zoom: view.zoom,
          bearing: view.bearing,
          pitch: view.pitch,
        })
        requestAnimationFrame(() => { if (syncSource === 'xg') syncSource = null })
      }
    }
    xgRafId = requestAnimationFrame(tick)
  }
  xgRafId = requestAnimationFrame(tick)

  setStatus(`Ready · ${url}`)
}

let lastHistoryWrite = 0

// ── Picker wiring ───────────────────────────────────────────────────
function persistAndLoad(styleId: string, urlOverride?: string): void {
  const url = urlOverride
    ?? STYLES.find(s => s.id === styleId)?.url
    ?? styleId
  if (!url) return
  if (styleId !== '__custom__') {
    localStorage.setItem('xgis.compare.style', styleId)
  }
  const params = new URLSearchParams(location.search)
  if (styleId !== '__custom__') params.set('style', styleId)
  else params.delete('style')
  const search = params.toString()
  history.replaceState(null, '', location.pathname + (search ? '?' + search : '') + location.hash)
  styleUrlInput.value = url
  void mountBoth(url)
}

styleSelect.addEventListener('change', () => {
  persistAndLoad(styleSelect.value)
})

styleUrlInput.addEventListener('change', () => {
  const v = styleUrlInput.value.trim()
  if (!v) return
  if (!/^https?:\/\//.test(v)) {
    setStatus('URL must start with http(s)://')
    return
  }
  persistAndLoad('__custom__', v)
})

reloadBtn.addEventListener('click', () => {
  const url = styleUrlInput.value.trim()
  if (url) void mountBoth(url)
})

// ── Boot ────────────────────────────────────────────────────────────
const initial = pickInitialStyle()
if (initial.id !== '__custom__') styleSelect.value = initial.id
styleUrlInput.value = initial.url
void mountBoth(initial.url)
