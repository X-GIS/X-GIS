// ═══ OD flow-map — daily life rhythm narrative (purpose-colored bands) ═══
//
// Per-feature line WIDTH via stroke-[<expr>] RENDERS (adjudicated by _flowmap-probe style B).
// Per-feature color via match() → BLANK (broken legacy path, style C).
// Solution: magnitude as WIDTH, purpose as COLOR via SEPARATE LAYERS each with
// a constant color — the proven-working path.
//
// Bands (data-driven semantic groups):
//   arcs_commute  purpose 1(출근)+2(통학)   → stroke-orange-400, opacity-85  — MORNING story
//   arcs_shop     purpose 3(쇼핑)+4(여가)   → stroke-cyan-400,   opacity-85  — EVENING story
//   arcs_life     purpose 5,6,7(생활·기타)  → stroke-slate-500,  opacity-25  — BACKGROUND context
//
// Data: only fixture-seoul-od-20260531.odb (~1MB, 98837 flows) carries the
// purpose dimension. The 0529/0530 files are single-dim (~185KB, no purpose flag).
// Single-day 24-hour scrubber is cleaner — no null-fallback path needed.

import type { FeatureCollectionLike, PipelineSink } from '@xgis/pipeline'
import { XGISMap } from '@xgis/runtime'
import { seoulSigunguGazetteer, decodeODB, fromRows, join, odFlow } from '@xgis/pipeline'

const TOP_N_FOCUS = 35 // rows per focus band (commute + shop); ≈70 total for narrative bands
const TOP_N_LIFE = 15 // rows for life/background band — must recede, not dominate
const FIXTURE_DAY = '20260531'
const HOURS = 24

// Width expression: sqrt compresses Seoul OD pop range (hundreds → tens of thousands).
// Tuned so the busiest corridor (pop ~30-50k) lands ≈14-17px; smallest top-30 ≈3px.
const W = 'sqrt(.weight) * 0.07 + 1'

const STYLE = `
background { fill: #020617 }

source gu_bounds {
  type: geojson
  url: "seoul_gu.geojson"
}
layer gu_fill {
  source: gu_bounds
  | fill-slate-900 stroke-slate-700 stroke-1 opacity-90
}

source arcs_commute {
  type: geojson
}
layer arcs_commute_lines {
  source: arcs_commute
  | stroke-orange-400 stroke-[${W}] opacity-85
}

source arcs_shop {
  type: geojson
}
layer arcs_shop_lines {
  source: arcs_shop
  | stroke-cyan-400 stroke-[${W}] opacity-85
}

source arcs_life {
  type: geojson
}
layer arcs_life_lines {
  source: arcs_life
  | stroke-slate-500 stroke-[${W}] opacity-25
}
`

const canvas = document.getElementById('map') as HTMLCanvasElement
const hourLabel = document.getElementById('hour-label')!
const slider = document.getElementById('scrubber') as HTMLInputElement
const playBtn = document.getElementById('play') as HTMLButtonElement
const cbCommute = document.getElementById('cb-commute') as HTMLInputElement
const cbShop = document.getElementById('cb-shop') as HTMLInputElement
const cbLife = document.getElementById('cb-life') as HTMLInputElement
const segSelect = document.getElementById('seg-select') as HTMLSelectElement
const tooltipEl = document.getElementById('tooltip') as HTMLDivElement
const gaz = seoulSigunguGazetteer({ vintage: '2026' })

// Route inline/setSourceData GeoJSON through VirtualPMTiles so LineString arcs
// render (the legacy pool.compile inline path doesn't draw lines; see rebuildLayers).
;(
  window as unknown as { __XGIS_USE_VIRTUAL_INLINE_GEOJSON?: boolean }
).__XGIS_USE_VIRTUAL_INLINE_GEOJSON = true

const map = new XGISMap(canvas, {})
;(window as unknown as { __xgisMap?: unknown }).__xgisMap = map

// ── Hover / picking gate ────────────────────────────────────────────────────
//
// map.setQuality({ picking: true }) enables GPU-readback hit-testing but forces
// MSAA off (the pick texture must be single-sample so IDs are not resolved away),
// which degrades line antialiasing. For the flow-map the AA loss is visible, so
// picking is opt-in via ?hover=1 in the URL.
//
// buildFeatureForEvent is a private method on XGISMap; we reach it via a
// structural cast. For VirtualPMTiles inline-GeoJSON line sources the
// _featureIndex may not carry full properties — if that happens, properties
// will be null/empty and the tooltip is silently suppressed.
const hoverEnabled = new URLSearchParams(location.search).has('hover')

type MapWithPick = {
  buildFeatureForEvent: (
    layerId: number,
    featureId: number,
  ) => { properties: Record<string, unknown> } | null
}

const PURPOSE_LABELS: Record<number, string> = {
  1: '출근',
  2: '통학',
  3: '쇼핑',
  4: '여가',
  5: '생활',
  6: '기타',
  7: '기타',
}

type BandRow = { o_code: string; d_code: string; pop: number; purpose: number }
type HourEntry = {
  o_code: string
  d_code: string
  pop: number
  purpose: number
  segment: number // 0=내국인, 1=단기외국인, 2=장기외국인
}

const EMPTY_FC: FeatureCollectionLike = { type: 'FeatureCollection', features: [] }

/** Push a band's rows into the named source. Guards empty rows (fromRows([]) has no
 *  columns → join throws); passes non-empty through the full odFlow pipeline.
 *  origin.name / dest.name from the gazetteer join are emitted as oName / dName
 *  properties so the hover tooltip can display "강남구 → 송파구". */
function applyBand(sourceId: string, rows: BandRow[]): void {
  if (rows.length === 0) {
    ;(map as unknown as PipelineSink).setSourceData(sourceId, EMPTY_FC)
    return
  }
  const t = fromRows(rows, { vintage: gaz.vintage })
  const j = join(join(t, { code: 'o_code', gaz, as: 'origin' }), {
    code: 'd_code',
    gaz,
    as: 'dest',
  })
  odFlow(j, {
    origin: 'origin',
    dest: 'dest',
    weight: 'pop',
    oName: 'origin.name',
    dName: 'dest.name',
    purpose: 'purpose',
  }).apply(map, sourceId)
}

async function main(): Promise<void> {
  await map.run(STYLE, import.meta.env.BASE_URL + 'data/')
  map.setCenter(126.99, 37.55)
  map.setZoom(10.2)

  const resp = await fetch(import.meta.env.BASE_URL + `data/fixture-seoul-od-${FIXTURE_DAY}.odb`)
  const odb = decodeODB(await resp.arrayBuffer())

  // Index all rows by hour once at load time. Purpose band filtering happens at
  // render time — ≈4000 rows/hour × 3 band checks is negligible CPU cost.
  const byHour = new Map<number, HourEntry[]>()
  for (let i = 0; i < odb.rowCount; i++) {
    const h = odb.hour[i]!
    let bucket = byHour.get(h)
    if (!bucket) {
      bucket = []
      byHour.set(h, bucket)
    }
    bucket.push({
      o_code: odb.dict[odb.origin[i]!]!,
      d_code: odb.dict[odb.dest[i]!]!,
      pop: odb.pop[i]!,
      purpose: odb.purpose?.[i] ?? 7, // 7=기타 fallback if no purpose column
      segment: odb.segment?.[i] ?? 0, // 0=내국인 fallback if no segment column
    })
  }

  slider.max = String(HOURS - 1)

  function daypart(h: number): string {
    if (h <= 5) return '새벽'
    if (h <= 10) return '아침'
    if (h <= 16) return '낮'
    if (h <= 20) return '저녁'
    return '밤'
  }

  // Track current hour so event listeners can re-render at the right frame.
  let hour = 0

  function renderFrame(h: number): void {
    const allRows = byHour.get(h) ?? []

    // ── Part 2: Segment filter ─────────────────────────────────────────────
    // segment: 0=내국인, 1=단기외국인, 2=장기외국인
    const segVal = segSelect.value
    const rows =
      segVal === 'domestic'
        ? allRows.filter((r) => r.segment === 0)
        : segVal === 'foreign'
          ? allRows.filter((r) => r.segment === 1 || r.segment === 2)
          : allRows

    // Compute band sums (filtered data) to determine the dominant rhythm.
    let sumCommute = 0
    let sumShop = 0
    let sumLife = 0
    for (const r of rows) {
      const p = r.purpose
      if (p === 1 || p === 2) sumCommute += r.pop
      else if (p === 3 || p === 4) sumShop += r.pop
      else if (p === 5 || p === 6 || p === 7) sumLife += r.pop
    }
    const dominant =
      sumCommute >= sumShop && sumCommute >= sumLife
        ? '출근 유입'
        : sumShop >= sumLife
          ? '쇼핑·상권'
          : '생활 이동'

    // One global sort by pop desc; fill each band top-first with per-band caps.
    const sorted = rows.slice().sort((a, b) => b.pop - a.pop)
    const commute: BandRow[] = []
    const shop: BandRow[] = []
    const life: BandRow[] = []

    for (const r of sorted) {
      const p = r.purpose
      if ((p === 1 || p === 2) && commute.length < TOP_N_FOCUS) {
        commute.push({ o_code: r.o_code, d_code: r.d_code, pop: r.pop, purpose: r.purpose })
      } else if ((p === 3 || p === 4) && shop.length < TOP_N_FOCUS) {
        shop.push({ o_code: r.o_code, d_code: r.d_code, pop: r.pop, purpose: r.purpose })
      } else if ((p === 5 || p === 6 || p === 7) && life.length < TOP_N_LIFE) {
        life.push({ o_code: r.o_code, d_code: r.d_code, pop: r.pop, purpose: r.purpose })
      }
      if (commute.length >= TOP_N_FOCUS && shop.length >= TOP_N_FOCUS && life.length >= TOP_N_LIFE)
        break
    }

    // ── Part 1: Band checkbox filter ──────────────────────────────────────
    // Unchecked band → pass [] → applyBand clears its source via EMPTY_FC.
    applyBand('arcs_commute', cbCommute.checked ? commute : [])
    applyBand('arcs_shop', cbShop.checked ? shop : [])
    applyBand('arcs_life', cbLife.checked ? life : [])

    const hh = String(h).padStart(2, '0')
    hourLabel.textContent = `${hh}:00 · ${daypart(h)} — ${dominant}`
    slider.value = String(h)
    map.invalidate()
  }

  renderFrame(hour)
  ;(window as unknown as { __xgisReady?: boolean }).__xgisReady = true

  slider.oninput = () => {
    hour = Number(slider.value)
    renderFrame(hour)
  }

  // Re-render when any band checkbox changes.
  cbCommute.onchange = () => renderFrame(hour)
  cbShop.onchange = () => renderFrame(hour)
  cbLife.onchange = () => renderFrame(hour)

  // Re-render when segment selector changes; log row-count impact for diagnostics.
  segSelect.onchange = () => {
    const all = byHour.get(hour) ?? []
    const domestic = all.filter((r) => r.segment === 0).length
    const foreign = all.filter((r) => r.segment === 1 || r.segment === 2).length
    // eslint-disable-next-line no-console
    console.log(`[seg-filter] h${hour} — 전체:${all.length} 내국인:${domestic} 외국인:${foreign}`)
    renderFrame(hour)
  }

  let timer: ReturnType<typeof setInterval> | null = null
  function play(): void {
    if (timer) return
    playBtn.textContent = '⏸'
    timer = setInterval(() => {
      hour = (hour + 1) % HOURS
      renderFrame(hour)
    }, 600)
  }
  function pause(): void {
    if (timer) clearInterval(timer)
    timer = null
    playBtn.textContent = '▶'
  }
  playBtn.onclick = () => (timer ? pause() : play())
  play() // autostart

  // ── Part 3: Hover tooltip (only active when ?hover=1) ─────────────────────
  if (hoverEnabled) {
    // Disables MSAA — arc antialiasing degrades. Opt-in only. See gate comment above.
    map.setQuality({ picking: true })

    canvas.addEventListener('mousemove', async (e: MouseEvent) => {
      const hit = await map.pickAt(e.clientX, e.clientY)
      if (!hit) {
        tooltipEl.style.display = 'none'
        return
      }
      // Structural cast to access private buildFeatureForEvent.
      const feature = (map as unknown as MapWithPick).buildFeatureForEvent(
        hit.layerId,
        hit.featureId,
      )
      const props = feature?.properties
      if (!props || Object.keys(props).length === 0) {
        // VirtualPMTiles inline sources may not carry properties in _featureIndex.
        // If so, hover is silently disabled rather than showing a blank tooltip.
        tooltipEl.style.display = 'none'
        return
      }
      const oName = String(props.oName ?? '')
      const dName = String(props.dName ?? '')
      const pop = Math.round(Number(props.weight ?? 0)).toLocaleString()
      const purpose = PURPOSE_LABELS[Number(props.purpose ?? 7)] ?? '기타'
      tooltipEl.innerHTML =
        `<strong>${oName || '(코드)'} → ${dName || '(코드)'}</strong><br>` +
        `이동량: ${pop}<br>목적: ${purpose}`
      // Position near cursor, clamped from screen edges.
      const margin = 12
      const tw = tooltipEl.offsetWidth || 180
      const th = tooltipEl.offsetHeight || 60
      tooltipEl.style.left = `${Math.min(e.clientX + margin, window.innerWidth - tw - margin)}px`
      tooltipEl.style.top = `${Math.min(e.clientY + margin, window.innerHeight - th - margin)}px`
      tooltipEl.style.display = 'block'
    })

    canvas.addEventListener('mouseleave', () => {
      tooltipEl.style.display = 'none'
    })
  }
}

void main()
