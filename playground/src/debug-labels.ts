// Mobile label-debug page. Mounts X-GIS (single map, touch-interactive)
// with the live OFM Bright style, and surfaces the per-glyph placement
// dump (map.setLabelDumpFilter / getDumpedLabels, iter-327/329) in an
// on-screen panel so a phone-only user can inspect/repro label bugs
// (bilingual line overlap, scatter) without a desktop console.
//
// URL: /debug-labels.html?style=<id|url>#z/lat/lon
//   default style = OFM Bright. Camera persists to the hash.

import { XGISMap } from '@xgis/runtime'
import { convertMapboxStyle } from '@xgis/compiler'

const STYLES: Record<string, string> = {
  'openfreemap-bright': 'https://tiles.openfreemap.org/styles/bright',
  'openfreemap-liberty': 'https://tiles.openfreemap.org/styles/liberty',
  'openfreemap-positron': 'https://tiles.openfreemap.org/styles/positron',
}

const canvas = document.getElementById('map') as HTMLCanvasElement
const statusEl = document.getElementById('status')!
const filterEl = document.getElementById('filter') as HTMLInputElement
const dumpBtn = document.getElementById('dump') as HTMLButtonElement
const shotBtn = document.getElementById('shot') as HTMLButtonElement
const camEl = document.getElementById('cam')!
const panel = document.getElementById('panel')!

interface DumpGlyph { cp: number; x: number; y: number; bearingY: number; height: number; rfs: number }
interface DumpLabel { text: string; anchorX: number; anchorY: number; glyphs: DumpGlyph[] }
interface DebugMap {
  run(src: string, base: string): Promise<void>
  setGlyphsUrl(u: string): void
  setSpriteUrl(u: string): void
  setLabelDumpFilter(s: string | null): void
  getDumpedLabels(): DumpLabel[] | null
  invalidate?(): void
  setSourceData?(id: string, data: unknown): void
  getCamera(): { centerX: number; centerY: number; zoom: number }
  setCenter?(lon: number, lat: number): void
  setZoom?(z: number): void
}

const R_EARTH = 6378137
const DEG = 180 / Math.PI

let map: DebugMap | null = null

function setStatus(s: string): void { statusEl.textContent = s; statusEl.style.display = s ? 'block' : 'none' }

function parseHash(): { zoom: number; lat: number; lon: number } | null {
  const h = location.hash.replace(/^#/, '')
  const p = h.split('/')
  if (p.length < 3) return null
  const zoom = parseFloat(p[0]!), lat = parseFloat(p[1]!), lon = parseFloat(p[2]!)
  if (!isFinite(zoom) || !isFinite(lat) || !isFinite(lon)) return null
  return { zoom, lat, lon }
}

async function mount(): Promise<void> {
  const params = new URLSearchParams(location.search)
  const styleParam = params.get('style') ?? 'openfreemap-bright'
  const url = STYLES[styleParam] ?? (styleParam.startsWith('http') ? styleParam : STYLES['openfreemap-bright']!)

  setStatus('스타일 로딩…')
  let styleJson: { glyphs?: string; sprite?: string }
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    styleJson = await res.json()
  } catch (e) { setStatus(`스타일 실패: ${(e as Error).message}`); return }

  setStatus('변환 + 마운트…')
  const inlineGeoJSON = new Map<string, unknown>()
  let src: string
  try {
    src = convertMapboxStyle(styleJson as Parameters<typeof convertMapboxStyle>[0], { inlineGeoJSON })
  } catch (e) { setStatus(`변환 실패: ${(e as Error).message}`); return }

  try { await (document as { fonts?: { ready?: Promise<unknown> } }).fonts?.ready } catch { /* no-op */ }

  map = new XGISMap(canvas) as unknown as DebugMap
  ;(window as unknown as { __xgisMap?: unknown }).__xgisMap = map
  if (typeof styleJson.glyphs === 'string') map.setGlyphsUrl(styleJson.glyphs)
  if (typeof styleJson.sprite === 'string') map.setSpriteUrl(styleJson.sprite)
  try {
    await map.run(src, location.origin + '/')
  } catch (e) { setStatus(`run() 실패: ${(e as Error).message}`); return }
  for (const [id, data] of inlineGeoJSON) map.setSourceData?.(id, data)

  // Initial camera from hash (default: South Korea z6 — the repro view).
  const view = parseHash() ?? { zoom: 6, lat: 36.5, lon: 127.8 }
  map.setCenter?.(view.lon, view.lat)
  map.setZoom?.(view.zoom)

  // Camera readout + hash persistence. getCamera() returns Mercator
  // metres (centerX/Y); convert to lon/lat for display.
  setInterval(() => {
    const cam = map?.getCamera?.()
    if (!cam || !isFinite(cam.centerX) || !isFinite(cam.centerY)) return
    const lon = (cam.centerX / R_EARTH) * DEG
    const lat = (2 * Math.atan(Math.exp(cam.centerY / R_EARTH)) - Math.PI / 2) * DEG
    const hash = `#${cam.zoom.toFixed(2)}/${lat.toFixed(5)}/${lon.toFixed(5)}`
    camEl.textContent = hash
    history.replaceState(null, '', location.pathname + location.search + hash)
  }, 500)

  setStatus('')
}

// ── Dump rendering ──────────────────────────────────────────────────
function lineGroups(g: DumpLabel): Map<number, DumpGlyph[]> {
  const m = new Map<number, DumpGlyph[]>()
  for (const gl of g.glyphs) {
    if (gl.cp === 10) continue
    const key = Math.round(gl.y)
    if (!m.has(key)) m.set(key, [])
    m.get(key)!.push(gl)
  }
  return m
}

function analyze(l: DumpLabel): { html: string; bad: boolean } {
  const groups = [...lineGroups(l).entries()].sort((a, b) => a[0] - b[0])
  let bad = false
  const out: string[] = []
  out.push(`<span class="hdr">"${l.text.replace(/\n/g, '\\n')}"</span> @(${l.anchorX.toFixed(0)},${l.anchorY.toFixed(0)})`)
  for (const [y, gs] of groups) {
    const chars = gs.map(g => String.fromCodePoint(g.cp)).join('')
    // intra-line x monotonic?
    let mono = true
    for (let i = 1; i < gs.length; i++) if (gs[i]!.x <= gs[i - 1]!.x) mono = false
    if (!mono) bad = true
    const xr = `${gs[0]!.x.toFixed(0)}→${gs[gs.length - 1]!.x.toFixed(0)}`
    out.push(`  y=${y} ${mono ? '' : '<span class="bad">[x역순!]</span>'} "${chars}" x:${xr}`)
  }
  // Vertical order: each successive line must be strictly below (y larger).
  for (let i = 1; i < groups.length; i++) {
    if (groups[i]![0] <= groups[i - 1]![0]) { bad = true; out.push(`  <span class="bad">[줄겹침: line${i} y=${groups[i]![0]} ≤ line${i - 1} y=${groups[i - 1]![0]}]</span>`) }
  }
  return { html: out.join('\n'), bad }
}

function doDump(filter: string): void {
  if (!map) return
  map.setLabelDumpFilter(filter)
  map.invalidate?.()
  // Read after a couple frames so prepare runs with the filter armed.
  setTimeout(() => {
    const labels = map!.getDumpedLabels() ?? []
    if (labels.length === 0) {
      panel.innerHTML = `<span class="dim">필터 "${filter || '(전체)'}" 일치 라벨 0개. 맵을 그 라벨이 보이는 위치로 이동 후 다시 DUMP. (라벨 로딩 몇 초 걸릴 수 있음)</span>`
      return
    }
    const parts = labels.map(analyze)
    const badCount = parts.filter(p => p.bad).length
    panel.innerHTML =
      `<span class="${badCount ? 'bad' : 'ok'}">${labels.length}개 라벨, 이상 ${badCount}개</span>\n\n` +
      parts.map(p => p.html).join('\n\n')
  }, 250)
}

dumpBtn.addEventListener('click', () => doDump(filterEl.value))
shotBtn.addEventListener('click', () => doDump(''))  // all labels → auto-flag

void mount()
