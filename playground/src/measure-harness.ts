// ═══ In-page measurement harness (`?measure=<scenario>`) ═══
//
// Purpose: let a HUMAN on real hardware produce the same numbers a headless
// SwiftShader probe produces, so render defects can be attributed to the
// platform instead of argued from screenshots (#2053: every residual symptom
// in the cloud container traced to SwiftShader's transcendental error — the
// hardware half of the comparison had no instrument until this).
//
// One authority, two consumers:
//   • a user opens  /demo.html?id=<demo>&e2e=1&adaptive=0&measure=proj-parity
//     and clicks "Copy report" — the JSON goes back into the issue/chat;
//   • an e2e probe drives the same URL headlessly and reads
//     `window.__xgisMeasureReport` when `__xgisMeasureDone` flips true.
//
// The capture reads the CANVAS via toBlob (the captureMapSnapshot readback
// pattern — diagnostics.ts): pure map pixels, no DOM chrome compositing, so
// none of the overlay-pollution the capture-canvas skill exists to prevent
// can occur here by construction.
//
// Inert unless `?measure=` is present: demo-runner dynamic-imports this
// module only when the param is set, so normal demos load zero extra bytes.

interface MeasureCell {
  slug: string
  proj: string
  lon: number
  lat: number
  zoom: number
}

interface ColorClass {
  name: string
  /** Short display char for run patterns ('B', 'W', …). */
  ch: string
  test: (r: number, g: number, b: number) => boolean
}

interface Scenario {
  name: string
  cells: MeasureCell[]
  /** Fractional row positions (of canvas height) to cross-section. */
  rows: number[]
  /** Stroke color classes (runs are reported per class pattern). */
  strokes: ColorClass[]
  /** Fill classes — the rightmost matching pixel per row is the visible
   *  fill edge (the seaward-most fill pixel not covered by a stroke). */
  fills: ColorClass[]
  /** Per-cell convergence budget (ms). Hardware converges in <1s; the same
   *  scenario under SwiftShader legitimately needs tens of seconds. */
  convergeBudgetMs: number
}

// Demotiles palette (style.json): coastline #198EC8, countries-boundary
// white, S.Korea fill #D6C7FF, background/water #D8F2FF.
const DEMOTILES_STROKES: ColorClass[] = [
  {
    name: 'coastline-blue',
    ch: 'B',
    test: (r, g, b) => b > 150 && g > 100 && r < 120 && !(r > 190 && g > 230),
  },
  { name: 'boundary-white', ch: 'W', test: (r, g, b) => r > 235 && g > 235 && b > 235 },
]
const DEMOTILES_FILLS: ColorClass[] = [
  {
    name: 'country-fill',
    ch: 'F',
    // Any of the demotiles country fill hues: distinctly non-water, non-white,
    // non-stroke — saturated pastel with r,g in the fill band. Matches the
    // lavender/green/orange family without enumerating every ADM0 color.
    test: (r, g, b) => {
      const water = r > 200 && g > 228 && b > 240
      const white = r > 235 && g > 235 && b > 235
      const stroke = b > 150 && g > 100 && r < 120
      return !water && !white && !stroke && r > 120 && r + g + b > 420
    },
  },
]

// OFM Positron palette (compiler/src/__tests__/fixtures/openfreemap-positron.json):
// background rgb(242,243,240); water fill rgb(194,200,202); boundary_2 (admin-2 line)
// hsl(0,0%,70%) = rgb(178,178,178) at full opacity past z4; highway_{major,motorway}
// _casing rgb(213,213,213); highway_{major,motorway}_inner #fff past z6; highway_minor
// hsl(0,0%,88%) = rgb(224,224,224). All neutral grays sit close together in 11-19pt
// steps (178→194→213→224→242→255), so windows are hand-tuned to the ACTUAL gaps rather
// than one uniform ±tolerance — casing↔minor is the tightest (11pt) and stays fuzzy by
// construction; water is additionally keyed on its blue-green cast (b−r) since its
// neutral-gray window alone would collide with boundary/casing.
//
// Neutrality threshold tightened to <4 (was <6) — instrument-validation finding
// (2026-08-25, first merc-9.70 run): `park` fill rgb(230,233,229) and `landcover_wood`
// fill rgb(220,224,220) both sit inside the casing/minor R-windows and have a
// max channel delta of exactly 4 (g the odd-channel-out on both), so at <6 tolerance
// a Seoul wood/park polygon read as an 88px-wide "minor road" run — a flooded-positive
// broken ruler, not a zero one, but the same fix: sample real colors, tighten past the
// contaminant. Road/boundary colors are EXACTLY neutral (r=g=b, delta 0) pre-AA, so <4
// excludes both fills (delta 4) while every genuine stroke match (delta 0, or a small
// AA blend toward the near-neutral background) is untouched.
const POSITRON_STROKES: ColorClass[] = [
  {
    name: 'boundary-gray', // boundary_2 ≈ rgb(178,178,178)
    ch: 'D',
    test: (r, g, b) => r > 168 && r < 188 && Math.abs(r - g) < 4 && Math.abs(g - b) < 4,
  },
  {
    name: 'casing-gray', // highway_{major,motorway}_casing rgb(213,213,213)
    ch: 'C',
    test: (r, g, b) => r > 204 && r < 222 && Math.abs(r - g) < 4 && Math.abs(g - b) < 4,
  },
  {
    name: 'inner-white', // highway_{major,motorway}_inner #fff
    ch: 'I',
    test: (r, g, b) => r > 248 && g > 248 && b > 248,
  },
  {
    name: 'minor-gray', // highway_minor ≈ rgb(224,224,224) — a sub-pixel ≈0.42 CSS px
    ch: 'M', // hairline at z9.7 the bake cannot represent; ±8 window per background gap.
    test: (r, g, b) => r > 216 && r < 232 && Math.abs(r - g) < 4 && Math.abs(g - b) < 4,
  },
]
const POSITRON_FILLS: ColorClass[] = [
  {
    name: 'water', // rgb(194,200,202)
    ch: 'A',
    test: (r, g, b) => r > 182 && r < 206 && b - r > 4 && b >= g,
  },
]

// The #2053 repro cells: Korea east coast + Busan, deep past the mirror's
// maxzoom 2 (Δz 5-7), mercator control at the same cameras.
const SCENARIOS: Record<string, Scenario> = {
  'proj-parity': {
    name: 'proj-parity',
    cells: [
      { slug: 'merc-z9-east', proj: 'mercator', lon: 129.35, lat: 37.5, zoom: 9 },
      { slug: 'globe-z9-east', proj: 'globe', lon: 129.35, lat: 37.5, zoom: 9 },
      { slug: 'merc-z7-busan', proj: 'mercator', lon: 129.05, lat: 35.1, zoom: 7 },
      { slug: 'globe-z7-busan', proj: 'globe', lon: 129.05, lat: 35.1, zoom: 7 },
    ],
    rows: [0.33, 0.5, 0.66],
    strokes: DEMOTILES_STROKES,
    fills: DEMOTILES_FILLS,
    convergeBudgetMs: 120_000,
  },
  // Globe rendering-quality probe (INC-1 PROBE phase): OFM Positron at the two
  // user-reported cameras — #9.70/37.54704/126.81412 (native zoom, source maxzoom
  // 14) and #21.10/37.38823/126.9468 (deep overzoom, Δz≈7, #2024 virtual windowed
  // bakes). All-layer vector drape suspect: vector-tile-renderer.ts:3603-3625
  // (`_drapeGlobeFills`/`_drapeStrokes`) rasterizes into fixed 512px DPR-blind
  // single-sample tile bakes on the globe; mercator renders vectors directly.
  // This scenario measures both projections at both cameras so the harness's
  // run/registration numbers can attribute any width or ramp softness to the bake.
  'positron-quality': {
    name: 'positron-quality',
    cells: [
      { slug: 'globe-9.70', proj: 'globe', lon: 126.81412, lat: 37.54704, zoom: 9.7 },
      { slug: 'globe-21.10', proj: 'globe', lon: 126.9468, lat: 37.38823, zoom: 21.1 },
      { slug: 'merc-9.70', proj: 'mercator', lon: 126.81412, lat: 37.54704, zoom: 9.7 },
      { slug: 'merc-21.10', proj: 'mercator', lon: 126.9468, lat: 37.38823, zoom: 21.1 },
    ],
    rows: [0.33, 0.5, 0.66],
    strokes: POSITRON_STROKES,
    fills: POSITRON_FILLS,
    // Generous: SwiftShader globe cells took 120s on the demotiles scenario above;
    // z21.1 overzoom additionally pays the #2024 virtual-bake dispatch per tile.
    convergeBudgetMs: 150_000,
  },
}

interface RowMeasure {
  yCss: number
  /** Rightmost visible fill pixel (CSS px), null when no fill on the row. */
  fillEdgeXCss: number | null
  /** Merged stroke runs, left→right: [x0Css, x1Css, pattern] with pattern one
   *  char per device pixel from the stroke classes ('B'/'W'). */
  runs: Array<[number, number, string]>
  /** fillEdge − center(first run), CSS px — the registration number. Positive
   *  = fill edge seaward (rightward) of the stroke center. */
  registrationCss: number | null
}

interface CellReport {
  slug: string
  proj: string
  camera: { lon: number; lat: number; zoom: number }
  convergedMs: number
  residualPendingUploads: number
  residualPendingLoads: number
  rows: RowMeasure[]
}

interface MeasureReport {
  harness: 'measure-harness/1'
  scenario: string
  startedAt: string
  userAgent: string
  backend: string
  adapter: unknown
  dpr: number
  canvasCss: { w: number; h: number }
  cells: CellReport[]
}

type MapLike = {
  setProjection?: (name: string) => void
  jumpTo?: (o: {
    center?: [number, number]
    zoom?: number
    bearing?: number
    pitch?: number
  }) => void
  setCenter?: (lon: number, lat: number) => void
  setZoom?: (z: number) => void
  setBearing?: (b: number) => void
  setPitch?: (p: number) => void
  invalidate?: () => void
  hasPendingSourceWork?: () => boolean
  vtSources?: Map<
    string,
    {
      renderer: { getPendingUploadCount?: () => number }
      source: { getPendingLoadCount?: () => number }
    }
  >
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

function pendingCounts(m: MapLike): { uploads: number; loads: number } {
  let uploads = 0
  let loads = 0
  if (m.vtSources) {
    for (const [, s] of m.vtSources) {
      uploads += s.renderer.getPendingUploadCount?.() ?? 0
      loads += s.source.getPendingLoadCount?.() ?? 0
    }
  }
  return { uploads, loads }
}

/** Converge: source work drained AND upload/load counters at zero for 5
 *  consecutive frames, or the budget elapses (residuals are REPORTED, not
 *  hidden — a non-zero residual means the frame is not the converged frame). */
async function converge(m: MapLike, budgetMs: number): Promise<number> {
  const t0 = performance.now()
  let stable = 0
  while (performance.now() - t0 < budgetMs) {
    const { uploads, loads } = pendingCounts(m)
    const busy = (m.hasPendingSourceWork?.() ?? false) || uploads > 0 || loads > 0
    stable = busy ? 0 : stable + 1
    if (stable >= 5) break
    // Keep frames flowing while work is pending — render-on-demand drains
    // uploads per frame; an idle rAF loop is what froze the #2053 fallback
    // frames under SwiftShader.
    if (busy) m.invalidate?.()
    await nextFrame()
    await sleep(30)
  }
  return Math.round(performance.now() - t0)
}

async function readCanvas(canvas: HTMLCanvasElement): Promise<ImageData> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/png')
  })
  if (!blob) throw new Error('canvas.toBlob returned null')
  const bmp = await createImageBitmap(blob)
  const off = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = off.getContext('2d')
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable')
  ctx.drawImage(bmp, 0, 0)
  return ctx.getImageData(0, 0, bmp.width, bmp.height)
}

function measureRow(img: ImageData, yDev: number, dpr: number, sc: Scenario): RowMeasure {
  const { data, width } = img
  const at = (x: number): [number, number, number] => {
    const i = (yDev * width + x) * 4
    return [data[i], data[i + 1], data[i + 2]]
  }
  const fillXs: number[] = []
  const runs: Array<[number, number, string]> = []
  let runStart = -1
  let pattern = ''
  let gap = 0
  for (let x = 0; x < width; x++) {
    const [r, g, b] = at(x)
    if (sc.fills.some((c) => c.test(r, g, b))) fillXs.push(x)
    const cls = sc.strokes.find((c) => c.test(r, g, b))
    if (cls) {
      if (runStart < 0) runStart = x
      pattern += '.'.repeat(gap) + cls.ch
      gap = 0
    } else if (runStart >= 0) {
      gap++
      if (gap > 3) {
        runs.push([runStart / dpr, (x - gap) / dpr, pattern])
        runStart = -1
        pattern = ''
        gap = 0
      }
    }
  }
  if (runStart >= 0) runs.push([runStart / dpr, (width - 1) / dpr, pattern])
  // Registration anchors to the fill edge ADJACENT to the first stroke run —
  // the last fill pixel at or left of (run end + 6dev px). A row-global
  // rightmost-fill pixel reads a DIFFERENT landmass further right (Busan
  // cells: Japan) and reports geography, not registration.
  let fillEdge: number | null = null
  let registration: number | null = null
  if (runs.length > 0) {
    const [x0, x1] = runs[0]
    const limit = x1 * dpr + 6 * dpr
    for (const fx of fillXs) {
      if (fx <= limit) fillEdge = fx
      else break
    }
    if (fillEdge !== null) {
      registration = Math.round((fillEdge / dpr - (x0 + x1) / 2) * 100) / 100
    }
  } else if (fillXs.length > 0) {
    fillEdge = fillXs[fillXs.length - 1]
  }
  return {
    yCss: Math.round(yDev / dpr),
    fillEdgeXCss: fillEdge === null ? null : Math.round((fillEdge / dpr) * 100) / 100,
    runs: runs.map(([a, b2, p]) => [Math.round(a * 100) / 100, Math.round(b2 * 100) / 100, p]),
    registrationCss: registration,
  }
}

function overlay(): { line: (s: string) => void; done: (report: MeasureReport) => void } {
  const el = document.createElement('div')
  el.id = 'measure-overlay'
  el.style.cssText =
    'position:fixed;top:8px;left:8px;z-index:99999;background:rgba(10,14,24,.92);color:#cde;' +
    'font:12px/1.5 monospace;padding:10px 12px;border-radius:8px;max-width:60ch;white-space:pre-wrap'
  el.textContent = '[measure] starting…\n'
  document.body.appendChild(el)
  return {
    line: (s: string) => {
      el.textContent += s + '\n'
    },
    done: (report: MeasureReport) => {
      const btn = document.createElement('button')
      btn.textContent = 'Copy report JSON'
      btn.style.cssText = 'margin-top:8px;font:inherit;padding:4px 10px;cursor:pointer'
      btn.onclick = () => {
        void navigator.clipboard
          .writeText(JSON.stringify(report, null, 1))
          .then(() => (btn.textContent = 'Copied ✓'))
          .catch((e: unknown) => (btn.textContent = `Copy failed: ${String(e)}`.slice(0, 40)))
      }
      el.appendChild(btn)
    },
  }
}

export async function runMeasureHarness(params: URLSearchParams): Promise<void> {
  const scenarioName = params.get('measure') ?? ''
  const sc = SCENARIOS[scenarioName]
  const ui = overlay()
  if (!sc) {
    ui.line(`unknown scenario "${scenarioName}" — have: ${Object.keys(SCENARIOS).join(', ')}`)
    return
  }
  // Wait for map boot.
  const w = window as unknown as {
    __xgisReady?: boolean
    __xgisMap?: MapLike
    __xgisActiveBackend?: string
    __xgisMeasureReport?: MeasureReport
    __xgisMeasureDone?: boolean
  }
  const bootT0 = performance.now()
  while (!w.__xgisReady || !w.__xgisMap) {
    if (performance.now() - bootT0 > 60_000) {
      ui.line('map never became ready (60s) — aborting')
      return
    }
    await sleep(200)
  }
  const m = w.__xgisMap
  const canvas = (m as unknown as { canvas?: HTMLCanvasElement }).canvas ?? null
  const canvasEl = canvas ?? (document.querySelector('#map canvas') as HTMLCanvasElement | null)
  if (!canvasEl) {
    ui.line('no map canvas found — aborting')
    return
  }
  const cssW = canvasEl.clientWidth || canvasEl.width
  const dpr = cssW > 0 ? canvasEl.width / cssW : 1
  let adapter: unknown = null
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu
    const a = (await gpu?.requestAdapter?.()) as { info?: unknown } | null
    adapter = a?.info ?? null
  } catch {
    adapter = null
  }
  const report: MeasureReport = {
    harness: 'measure-harness/1',
    scenario: sc.name,
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    backend: w.__xgisActiveBackend ?? 'unknown',
    adapter,
    dpr,
    canvasCss: { w: cssW, h: canvasEl.clientHeight || canvasEl.height },
    cells: [],
  }
  ui.line(`scenario ${sc.name} · backend=${report.backend} · dpr=${dpr}`)

  for (const cell of sc.cells) {
    ui.line(`▶ ${cell.slug} …`)
    m.setProjection?.(cell.proj)
    if (m.jumpTo) m.jumpTo({ center: [cell.lon, cell.lat], zoom: cell.zoom, bearing: 0, pitch: 0 })
    else {
      m.setCenter?.(cell.lon, cell.lat)
      m.setZoom?.(cell.zoom)
      m.setBearing?.(0)
      m.setPitch?.(0)
    }
    await nextFrame()
    const convergedMs = await converge(m, sc.convergeBudgetMs)
    const residual = pendingCounts(m)
    // Compose the frame the reader sees, then read it back.
    m.invalidate?.()
    await nextFrame()
    await nextFrame()
    const img = await readCanvas(canvasEl)
    const rows = sc.rows.map((f) => measureRow(img, Math.round(img.height * f), dpr, sc))
    report.cells.push({
      slug: cell.slug,
      proj: cell.proj,
      camera: { lon: cell.lon, lat: cell.lat, zoom: cell.zoom },
      convergedMs,
      residualPendingUploads: residual.uploads,
      residualPendingLoads: residual.loads,
      rows,
    })
    const regs = rows.map((r) => r.registrationCss).filter((v): v is number => v !== null)
    ui.line(
      `  converged ${convergedMs}ms (residual up=${residual.uploads} ld=${residual.loads}) · ` +
        `reg=[${regs.join(', ')}]px · runs=${rows.map((r) => r.runs.length).join('/')}`,
    )
  }

  w.__xgisMeasureReport = report
  w.__xgisMeasureDone = true
  console.log('[measure-harness] report:', JSON.stringify(report))
  ui.line('done — copy the report below and paste it back.')
  ui.done(report)
}
