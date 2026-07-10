// ═══ 생활이동 flow-map v2 — "숨쉬는 도시": breathing choropleth + GPU movement vector field ═══
//
// Measured from fixture-seoul-od-20260531.odb (98,837 flows): 54.7% of movement is INTRA-gu,
// so v1's straight centroid arcs (origin==dest ⇒ zero-length ⇒ invisible) drew only 7–11 of 85.
// v2 makes the CITY the canvas.
//
//   LAYER 1  breathing choropleth — each 자치구 coloured by per-hour NET flow (inflow−outflow,
//            inter-gu). 유입 warm(red) ↔ 유출 cool(blue), continuous diverging ramp. Tiled ONCE;
//            each hour recolours via setPaintProperty (never re-tiles) → zero flicker.
//   LAYER 2  movement vector field — the FIRST-CLASS GPU arrow primitive `map.graphics.add(
//            { type: 'arrow' })`: per-gu oriented arrow, geo-anchored + projected ON THE GPU
//            (shader-dsl), N-independent (a camera move rewrites only the frame uniform; an hour
//            change re-packs the 25 instances once). AM the arrows converge on the job centres
//            (commuting in); PM they radiate out to the residential gu (going home).
//
// The arrow is a fixed 25-instance batch (one per 자치구); a weak-outflow hour packs size 0
// (invisible) rather than resizing (the retained batch is fixed-size). Rotation is the OUTFLOW
// screen bearing atan2(-fy, fx) — Mercator is conformal, so the ground bearing IS the screen
// bearing, invariant to pan/zoom (only a camera BEARING change would need a re-pack).
//
// Join is by NAME: seoul_gu.geojson carries 2013 KOSTAT codes (강동구=11250); the odb/gazetteer
// carry 행정표준코드 (강동구=11740). Code spaces disjoint, the 25 names identical.

import type { PipelineSink } from '@xgis/pipeline'
import { XGISMap } from '@xgis/runtime'
import { decodeODB, SEOUL_SIGUNGU } from '@xgis/pipeline'

const FIXTURE_DAY = '20260531'
const HOURS = 24
const ARROW_COLOR = '#fde68a' // luminous amber — the movement field over the diverging fills
const ARROW_MIN_VNORM = 0.12 // below this an arrow packs size 0 (invisible) — keeps the field legible

const CODE_TO_NAME = new Map(SEOUL_SIGUNGU.map((e) => [e.code, e.name]))
const CENTROID = new Map(SEOUL_SIGUNGU.map((e) => [e.name, { lon: e.lon, lat: e.lat }]))
const GU = SEOUL_SIGUNGU.map((e) => e.name) // stable index 0..24 → gu name (also the arrow data)

// ── Diverging ramp: net<0 유출 cool, net>0 유입 warm. Continuous (lerped). ──
type RGB = [number, number, number]
const STOPS: Array<{ t: number; c: RGB }> = [
  { t: -1.0, c: [30, 58, 138] }, // 유출 강 deep blue
  { t: -0.5, c: [59, 130, 246] },
  { t: -0.15, c: [125, 211, 252] },
  { t: 0.0, c: [30, 41, 59] }, // 균형 near-background
  { t: 0.15, c: [253, 186, 116] },
  { t: 0.5, c: [249, 115, 22] },
  { t: 1.0, c: [220, 38, 38] }, // 유입 강 deep red
]
const hex2 = (n: number): string => Math.round(n).toString(16).padStart(2, '0')
function divergingHex(net: number, sat: number): string {
  const n = Math.max(-1, Math.min(1, net / (sat || 1)))
  const t = Math.sign(n) * Math.sqrt(Math.abs(n)) // perceptual expand so diffuse 유출 still reads
  let lo = STOPS[0]!
  let hi = STOPS[STOPS.length - 1]!
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (t >= STOPS[i]!.t && t <= STOPS[i + 1]!.t) {
      lo = STOPS[i]!
      hi = STOPS[i + 1]!
      break
    }
  }
  const f = (t - lo.t) / (hi.t - lo.t || 1)
  return `#${hex2(lo.c[0] + (hi.c[0] - lo.c[0]) * f)}${hex2(lo.c[1] + (hi.c[1] - lo.c[1]) * f)}${hex2(lo.c[2] + (hi.c[2] - lo.c[2]) * f)}`
}

const guDecls = GU.map(
  (_, i) =>
    `source gu_${i} { type: geojson }\nlayer c${i} { source: gu_${i} | fill-slate-800 opacity-100 }`,
).join('\n')
const STYLE = `
background { fill: #020617 }

${guDecls}

source gu_bounds {
  type: geojson
  url: "seoul_gu.geojson"
}
layer gu_stroke {
  source: gu_bounds
  | stroke-slate-500 stroke-1 opacity-35
}
`

const canvas = document.getElementById('map') as HTMLCanvasElement
const hourLabel = document.getElementById('hour-label')!
const slider = document.getElementById('scrubber') as HTMLInputElement
const playBtn = document.getElementById('play') as HTMLButtonElement
const segSelect = document.getElementById('seg-select') as HTMLSelectElement
const cbField = document.getElementById('cb-field') as HTMLInputElement | null

;(
  window as unknown as { __XGIS_USE_VIRTUAL_INLINE_GEOJSON?: boolean }
).__XGIS_USE_VIRTUAL_INLINE_GEOJSON = true

const map = new XGISMap(canvas, {})
;(window as unknown as { __xgisMap?: unknown }).__xgisMap = map
const sink = map as unknown as PipelineSink

type GuFeature = { type: 'Feature'; properties: { name: string }; geometry: unknown }
type Row = { oName: string; dName: string; pop: number; segment: number }
/** Per-gu outflow: unit screen-bearing components (fx east, fy north) + 0–1 volume (size). */
type Vec = { fx: number; fy: number; vnorm: number }

function daypart(h: number): string {
  if (h <= 5) return '새벽'
  if (h <= 10) return '아침'
  if (h <= 16) return '낮'
  if (h <= 20) return '저녁'
  return '밤'
}

async function main(): Promise<void> {
  await map.run(STYLE, import.meta.env.BASE_URL + 'data/')
  map.setCenter(126.99, 37.55)
  map.setZoom(10.2)

  const [odbBuf, guFC] = await Promise.all([
    fetch(import.meta.env.BASE_URL + `data/fixture-seoul-od-${FIXTURE_DAY}.odb`).then((r) =>
      r.arrayBuffer(),
    ),
    fetch(import.meta.env.BASE_URL + 'data/seoul_gu.geojson').then(
      (r) => r.json() as Promise<{ features: GuFeature[] }>,
    ),
  ])
  const odb = decodeODB(odbBuf)
  const guByName = new Map<string, GuFeature>()
  for (const f of guFC.features) guByName.set(f.properties.name, f)

  // Tile each gu polygon into its own source ONCE. From here on, hours only recolour.
  GU.forEach((name, i) => {
    const feat = guByName.get(name)
    sink.setSourceData(`gu_${i}`, { type: 'FeatureCollection', features: feat ? [feat] : [] })
  })

  const byHour = new Map<number, Row[]>()
  for (let i = 0; i < odb.rowCount; i++) {
    const oName = CODE_TO_NAME.get(odb.dict[odb.origin[i]!]!)
    const dName = CODE_TO_NAME.get(odb.dict[odb.dest[i]!]!)
    if (!oName || !dName) continue
    const h = odb.hour[i]!
    let bucket = byHour.get(h)
    if (!bucket) byHour.set(h, (bucket = []))
    bucket.push({ oName, dName, pop: odb.pop[i]!, segment: odb.segment?.[i] ?? 0 })
  }

  const segMatch = (r: Row, mode: string): boolean =>
    mode === 'all' ? true : mode === 'domestic' ? r.segment === 0 : r.segment !== 0

  function netByGu(h: number, mode: string): Map<string, number> {
    const net = new Map<string, number>()
    for (const r of byHour.get(h) ?? []) {
      if (r.oName === r.dName || !segMatch(r, mode)) continue
      net.set(r.dName, (net.get(r.dName) ?? 0) + r.pop)
      net.set(r.oName, (net.get(r.oName) ?? 0) - r.pop)
    }
    return net
  }

  // Per-gu outflow vector (pop-weighted mean bearing + total outflow volume), keyed by name.
  function computeField(h: number, mode: string, volMax: number): Map<string, Vec> {
    const acc = new Map<string, { vx: number; vy: number; vol: number }>()
    for (const r of byHour.get(h) ?? []) {
      if (r.oName === r.dName || !segMatch(r, mode)) continue
      const o = CENTROID.get(r.oName)
      const d = CENTROID.get(r.dName)
      if (!o || !d) continue
      const cos = Math.cos((o.lat * Math.PI) / 180) || 1
      const dx = (d.lon - o.lon) * cos // ground east
      const dy = d.lat - o.lat // ground north
      const len = Math.hypot(dx, dy) || 1
      const a = acc.get(r.oName) ?? { vx: 0, vy: 0, vol: 0 }
      a.vx += (dx / len) * r.pop
      a.vy += (dy / len) * r.pop
      a.vol += r.pop
      acc.set(r.oName, a)
    }
    const field = new Map<string, Vec>()
    for (const [name, a] of acc) {
      const m = Math.hypot(a.vx, a.vy) || 1
      field.set(name, { fx: a.vx / m, fy: a.vy / m, vnorm: Math.min(1, Math.sqrt(a.vol / volMax)) })
    }
    return field
  }

  // Stable scales across the whole day (seg=all): net saturation + outflow volume max.
  const allAbs: number[] = []
  let volMax = 1
  for (let h = 0; h < HOURS; h++) {
    for (const v of netByGu(h, 'all').values()) allAbs.push(Math.abs(v))
    const vol = new Map<string, number>()
    for (const r of byHour.get(h) ?? [])
      if (r.oName !== r.dName) vol.set(r.oName, (vol.get(r.oName) ?? 0) + r.pop)
    for (const v of vol.values()) if (v > volMax) volMax = v
  }
  allAbs.sort((a, b) => a - b)
  const sat = allAbs[Math.floor(allAbs.length * 0.85)] || 1

  slider.max = String(HOURS - 1)
  let hour = 0
  let fieldOn = cbField?.checked ?? true
  let field: Map<string, Vec> = computeField(hour, segSelect.value, volMax)

  // ── LAYER 2: the GPU movement vector field — a fixed 25-instance arrow batch. Accessors
  // read the live `field`/`fieldOn`; each hour re-packs via handle.update (no per-frame cost). ──
  const arrows = map.graphics.add<string>({
    type: 'arrow',
    data: GU,
    getPosition: (name) => {
      const c = CENTROID.get(name)!
      return [c.lon, c.lat]
    },
    // Geographic bearing of the outflow (0°=north, CW). Projected on the GPU → correct under
    // any camera. f.fx = east component, f.fy = north component.
    getBearing: (name) => {
      const f = field.get(name)
      return f ? (Math.atan2(f.fx, f.fy) * 180) / Math.PI : 0
    },
    // Arrow LENGTH (px) ∝ √outflow-volume; 0 = invisible (weak / field off).
    getSize: (name) => {
      const f = field.get(name)
      return fieldOn && f && f.vnorm >= ARROW_MIN_VNORM ? 14 + 56 * f.vnorm : 0
    },
    getColor: ARROW_COLOR,
    updateTriggers: { rotation: 1, size: 1 },
  })

  function renderFrame(h: number): void {
    const mode = segSelect.value
    const net = netByGu(h, mode)
    let topInName = ''
    let topInVal = 0
    GU.forEach((name, i) => {
      const v = net.get(name) ?? 0
      map.setPaintProperty(`c${i}`, 'fill-color', divergingHex(v, sat))
      if (v > topInVal) {
        topInVal = v
        topInName = name
      }
    })
    // Recompute the field for this hour+segment and re-pack the arrow batch (25 instances).
    field = computeField(h, mode, volMax)
    arrows.update({ triggers: ['rotation', 'size'] })

    const hh = String(h).padStart(2, '0')
    hourLabel.textContent = topInName
      ? `${hh}:00 · ${daypart(h)} — ${topInName} 유입`
      : `${hh}:00 · ${daypart(h)} — 균형`
    slider.value = String(h)
    map.invalidate()
  }

  renderFrame(hour)
  ;(window as unknown as { __xgisReady?: boolean }).__xgisReady = true

  slider.oninput = () => {
    hour = Number(slider.value)
    renderFrame(hour)
  }
  segSelect.onchange = () => renderFrame(hour)
  if (cbField)
    cbField.onchange = () => {
      fieldOn = cbField.checked
      arrows.update({ triggers: ['size'] }) // size 0 hides the field without re-adding the batch
      map.invalidate()
    }

  let timer: ReturnType<typeof setInterval> | null = null
  function play(): void {
    if (timer) return
    playBtn.textContent = '⏸'
    timer = setInterval(() => {
      hour = (hour + 1) % HOURS
      renderFrame(hour)
    }, 900)
  }
  function pause(): void {
    if (timer) clearInterval(timer)
    timer = null
    playBtn.textContent = '▶'
  }
  playBtn.onclick = () => (timer ? pause() : play())
  play()
}

void main()
