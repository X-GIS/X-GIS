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
interface DumpLabel { text: string; anchorX: number; anchorY: number; fontSize: number; slotSize: number; curved: boolean; glyphs: DumpGlyph[] }
interface DumpIcon { name: string; anchorX: number; anchorY: number; drawW: number; drawH: number; centerY: number }
interface DebugMap {
  run(src: string, base: string): Promise<void>
  setGlyphsUrl(u: string): void
  setSpriteUrl(u: string): void
  setLabelDumpFilter(s: string | null): void
  getDumpedLabels(): DumpLabel[] | null
  setIconDumpEnabled?(on: boolean): void
  getDumpedIcons?(): DumpIcon[] | null
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
  map.setIconDumpEnabled?.(true)  // iter-343: capture shield/icon boxes for text-vs-box check
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
// REAL rendered glyph centre-y (matches text-renderer setDraws):
//   y0(top) = offsetY - bearingY*scale - (slotSize - height)*scale/2
//   centre  = y0 + slotSize*scale/2 = offsetY - bearingY*scale + height*scale/2
// where scale = fontSize / rfs. A glyph whose rfs/bearingY differs from
// its line-mates renders at a DIFFERENT y even when its offset y is the
// same — the offset-only check missed this (the 탄 case).
function renderCenterY(g: DumpGlyph, fontSize: number): number {
  const scale = fontSize / (g.rfs || fontSize || 1)
  return g.y - g.bearingY * scale + (g.height * scale) / 2
}

function analyze(l: DumpLabel, icon?: DumpIcon | null): { html: string; bad: boolean } {
  let bad = false
  const out: string[] = []
  out.push(`<span class="hdr">"${l.text.replace(/\n/g, '\\n')}"</span> fs=${l.fontSize.toFixed(1)} slot=${l.slotSize}`)

  // iter-343 — text vs paired ICON (shield/marker box) vertical alignment.
  // The "라벨이랑 뒤 흰색 박스가 안맞아요" class: a shield's number must sit
  // at the box centre. Compute the text ink centre (abs) vs the box centre.
  if (icon) {
    const inkGs = l.glyphs.filter(g => g.cp !== 10 && g.height > 0)
    if (inkGs.length) {
      const centers = inkGs.map(g => l.anchorY + renderCenterY(g, l.fontSize))
      const textCenter = (Math.min(...centers) + Math.max(...centers)) / 2
      const gap = textCenter - icon.centerY
      // tolerate ~quarter font size of drift (sub-pixel + halo).
      const tol = Math.max(2, l.fontSize * 0.25)
      if (Math.abs(gap) > tol) {
        bad = true
        out.push(`  <span class="bad">[텍스트-박스 어긋남 ${gap.toFixed(0)}px] text-center=${textCenter.toFixed(0)} box(${icon.name})-center=${icon.centerY.toFixed(0)}</span>`)
      } else {
        out.push(`  <span class="dim">box ${icon.name} gap=${gap.toFixed(0)}px (ok)</span>`)
      }
    }
  }

  // Logical lines by offset y (what prepare intends). Cluster by a
  // tolerance (¼ fontSize) rather than exact round(y): glyphs on ONE
  // line can carry slightly different baseline y (e.g. mixed-height CJK
  // 여 h22 vs 도 h17), and an exact-key split made the cross-line check
  // false-flag a single line as [줄겹침]. Skip non-rendering glyphs
  // (newline cp10, space, zero-ink): junk bearingY must not pollute.
  const ink = l.glyphs.filter(g => g.cp !== 10 && g.height > 0).sort((a, b) => a.y - b.y)
  const tol = Math.max(2, l.fontSize * 0.25)
  const lines: [number, DumpGlyph[]][] = []
  for (const g of ink) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(g.y - last[1][0]!.y) <= tol) last[1].push(g)
    else lines.push([Math.round(g.y), [g]])
  }

  const lineRenderY: number[] = []
  for (const [oy, gs] of lines) {
    const chars = gs.map(g => String.fromCodePoint(g.cp)).join('')
    // Per-glyph rendered centre y + rfs.
    const rys = gs.map(g => renderCenterY(g, l.fontSize))
    const minRy = Math.min(...rys), maxRy = Math.max(...rys)
    lineRenderY.push((minRy + maxRy) / 2)
    // intra-line x monotonic?
    let mono = true
    for (let i = 1; i < gs.length; i++) if (gs[i]!.x <= gs[i - 1]!.x) mono = false
    if (!mono) bad = true
    // render-y spread within a line should be small (< fontSize). A
    // glyph that jumped to another row blows this up.
    const spread = maxRy - minRy
    const ySpread = spread > l.fontSize * 0.6
    if (ySpread) bad = true
    // rfs uniform within a line?
    const rfsSet = [...new Set(gs.map(g => g.rfs))]
    const rfsMixed = rfsSet.length > 1
    if (rfsMixed) bad = true
    const xr = `${gs[0]!.x.toFixed(0)}→${gs[gs.length - 1]!.x.toFixed(0)}`
    out.push(`  oy=${oy} "${chars}" x:${xr} rdrY:${minRy.toFixed(0)}~${maxRy.toFixed(0)}`
      + (mono ? '' : ' <span class="bad">[x역순]</span>')
      + (ySpread ? ` <span class="bad">[렌더Y이탈 ${spread.toFixed(0)}px]</span>` : '')
      + (rfsMixed ? ` <span class="bad">[rfs혼합 ${rfsSet.join(',')}]</span>` : ''))
  }
  // Cross-line: rendered lines must stay in order (each below previous).
  for (let i = 1; i < lineRenderY.length; i++) {
    if (lineRenderY[i]! <= lineRenderY[i - 1]! + 1) {
      bad = true
      out.push(`  <span class="bad">[줄겹침: line${i} rdrY≈${lineRenderY[i]!.toFixed(0)} ≤ line${i - 1} ${lineRenderY[i - 1]!.toFixed(0)}]</span>`)
    }
  }
  // When bad, dump every glyph's metrics so the anomalous one (wrong
  // bearingY/height/rfs → wrong rendered y) is visible.
  if (bad) {
    for (const g of l.glyphs) {
      if (g.cp === 10) continue
      const ry = renderCenterY(g, l.fontSize)
      out.push(`    <span class="dim">${String.fromCodePoint(g.cp)} oy=${g.y.toFixed(0)} rfs=${g.rfs} bY=${g.bearingY.toFixed(0)} h=${g.height} → rdrY=${ry.toFixed(0)}</span>`)
    }
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
    // Line-following labels (roads/rivers) place glyphs along a curve —
    // the stacked-line analysis doesn't apply. Skip them.
    const pointLabels = labels.filter(l => !l.curved)
    // Pair each point label with its nearest icon (same anchor) so the
    // analyzer can flag text-vs-box (shield) vertical misalignment.
    const icons = map!.getDumpedIcons?.() ?? []
    const nearestIcon = (l: DumpLabel): DumpIcon | null => {
      let best: DumpIcon | null = null, bestD = 1e9
      for (const ic of icons) {
        const d = Math.abs(ic.anchorX - l.anchorX) + Math.abs(ic.anchorY - l.anchorY)
        if (d < bestD) { bestD = d; best = ic }
      }
      return bestD <= 12 ? best : null
    }
    const parts = pointLabels.map(l => analyze(l, nearestIcon(l)))
    const badCount = parts.filter(p => p.bad).length
    panel.innerHTML =
      `<span class="${badCount ? 'bad' : 'ok'}">${labels.length}개 라벨 (점 ${pointLabels.length}/곡선 ${labels.length - pointLabels.length}), 이상 ${badCount}개</span>\n\n` +
      parts.map(p => p.html).join('\n\n')
  }, 250)
}

dumpBtn.addEventListener('click', () => doDump(filterEl.value))
shotBtn.addEventListener('click', () => doDump(''))  // all labels → auto-flag

void mount()
