// ═══ On-site overdraw capture (?debug=overdraw) ═══
//
// `?debug=overdraw` replaces the scene with X-GIS's per-pixel fragment-count
// heatmap. Eyeballing that colormap (esp. downscaled in a screenshot) is
// exactly the trap CLAUDE.md §5 warns against — so this overlay reads the
// heatmap back and INVERTS the colormap to real overdraw COUNTS, then reports
// quantitative stats for two camera pitches in one tap:
//
//   tap «측정» → pitch 0° settle+capture → pitch 70° settle+capture → restore.
//
// For each pitch it prints mean / p95 / max overdraw, the % of painted pixels
// over 8×, and a bucket histogram — copyable text. If the browser can't read
// the WebGPU canvas back (toDataURL blank), it falls back to a guided live
// sequence (two prompted screenshots).
//
// Colormap replicated EXACTLY from runtime/src/engine/shaders/dsl/
// overdraw-compose.ts (count→t=count/16; r=clamp(3t−0.5); g=clamp(2.5t)·
// clamp(2−2t); b=clamp(0.6−1.5t); empty pixel = (0.02,0.02,0.04)). Playground
// diagnostic only — no runtime change.

interface OdCamera { zoom: number; centerX: number; centerY: number; pitch: number; bearing: number }
interface OdMap { getCamera(): OdCamera; invalidate(): void }

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

/** count → expected swapchain RGB (0..255), replicating the WGSL colormap. */
function colormapRGB(count: number): [number, number, number] {
  const s = clamp01(count / 16)
  const r = clamp01(3 * s - 0.5)
  const g = clamp01(2.5 * s) * clamp01(2 - 2 * s)
  const b = clamp01(0.6 - 1.5 * s)
  return [r * 255, g * 255, b * 255]
}

const MAX_COUNT = 40
const LUT: Array<[number, number, number]> = []
for (let c = 0; c <= MAX_COUNT; c++) LUT.push(colormapRGB(c))
// Empty-pixel sentinel colour the shader writes where nothing drew.
const BG: [number, number, number] = [0.02 * 255, 0.02 * 255, 0.04 * 255]

/** Nearest overdraw count for a sampled RGB, or null for an empty/background
 *  pixel (excluded from the stats so the histogram is over PAINTED pixels). */
function nearestCount(r: number, g: number, b: number): number | null {
  if (Math.abs(r - BG[0]) < 11 && Math.abs(g - BG[1]) < 11 && Math.abs(b - BG[2]) < 16) return null
  let best = 0, bestD = Infinity
  for (let c = 0; c <= MAX_COUNT; c++) {
    const L = LUT[c]!
    const d = (r - L[0]) ** 2 + (g - L[1]) ** 2 + (b - L[2]) ** 2
    if (d < bestD) { bestD = d; best = c }
  }
  return best
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface CaptureResult { dataUrl: string; counts: number[] }

/** Read the WebGPU canvas back via a 2D canvas (no smoothing, native size)
 *  and stride-sample painted-pixel overdraw counts. Returns null if the
 *  read came back effectively blank (browser can't snapshot the canvas). */
function readCanvas(canvas: HTMLCanvasElement, dataUrl: string, img: HTMLImageElement): CaptureResult | null {
  const c2 = document.createElement('canvas')
  c2.width = canvas.width; c2.height = canvas.height
  const ctx = c2.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(img, 0, 0)
  let data: Uint8ClampedArray
  try { data = ctx.getImageData(0, 0, c2.width, c2.height).data }
  catch { return null }
  const counts: number[] = []
  // Stride so a DPR3 phone (≈2.4M px) samples ≈40k pixels — fast, representative.
  const stride = Math.max(1, Math.round(Math.sqrt((c2.width * c2.height) / 40000)))
  for (let y = 0; y < c2.height; y += stride) {
    for (let x = 0; x < c2.width; x += stride) {
      const i = (y * c2.width + x) * 4
      const cnt = nearestCount(data[i]!, data[i + 1]!, data[i + 2]!)
      if (cnt !== null) counts.push(cnt)
    }
  }
  return { dataUrl, counts }
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

function statsLine(label: string, counts: number[], painted: number, total: number): string {
  if (counts.length === 0) return `${label}: (그려진 픽셀 없음 / 캡처 실패)`
  const sorted = [...counts].sort((a, b) => a - b)
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length
  const over8 = counts.filter((c) => c > 8).length / counts.length * 100
  const cover = total > 0 ? (painted / total) * 100 : 0
  const b = (lo: number, hi: number): number =>
    Math.round(counts.filter((c) => c >= lo && c <= hi).length / counts.length * 100)
  return `${label}: 평균=${mean.toFixed(1)}× p95=${pct(sorted, 95)}× 최대=${sorted[sorted.length - 1]}×  >8×=${over8.toFixed(0)}%  화면덮음=${cover.toFixed(0)}%\n`
    + `        분포  1-2×:${b(1, 2)}%  3-5×:${b(3, 5)}%  6-10×:${b(6, 10)}%  11-16×:${b(11, 16)}%  16×+:${b(16, MAX_COUNT)}%`
}

export function installOverdrawCapture(map: OdMap): void {
  document.getElementById('xgis-overdraw-capture')?.remove()
  const panel = document.createElement('div')
  panel.id = 'xgis-overdraw-capture'
  panel.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;z-index:10002;'
    + 'background:rgba(0,0,0,0.88);color:#e8e8e8;font:11px/1.35 monospace;'
    + 'padding:8px 10px;max-height:60vh;overflow:auto;border-top:1px solid #444;'
  document.body.appendChild(panel)

  const mkBtn = (label: string, bg: string): HTMLButtonElement => {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText = `font:bold 12px/1 monospace;padding:8px 12px;border-radius:6px;`
      + `border:1px solid #666;background:${bg};color:#fff;touch-action:manipulation;`
    return b
  }
  const bar = document.createElement('div')
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap;'
  const runBtn = mkBtn('▶ pitch 0/70 오버드로 측정', '#1f6feb')
  const copyBtn = mkBtn('📋 복사', '#2da44e')
  const closeBtn = mkBtn('✕', '#444')
  bar.append(runBtn, copyBtn, closeBtn)

  const pre = document.createElement('pre')
  pre.style.cssText = 'margin:0 0 6px;white-space:pre-wrap;word-break:break-word;'
  pre.textContent = '«측정»을 누르면 pitch 0° → 70° 를 자동 캡처하고 오버드로 수치(평균/p95/최대/분포)를 뽑습니다.'
  const imgs = document.createElement('div')
  imgs.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;'
  panel.append(bar, pre, imgs)

  let report = ''

  async function captureAt(pitch: number, settleMs: number): Promise<CaptureResult | null> {
    const cam = map.getCamera()
    cam.pitch = pitch
    map.invalidate()
    await delay(settleMs)
    const canvas = document.querySelector('canvas')
    if (!canvas) return null
    let dataUrl = ''
    try { dataUrl = canvas.toDataURL('image/png') } catch { return null }
    if (!dataUrl || dataUrl.length < 1000) return null
    const img = new Image()
    const loaded = await new Promise<boolean>((res) => {
      img.onload = () => res(true); img.onerror = () => res(false); img.src = dataUrl
    })
    if (!loaded) return null
    return readCanvas(canvas, dataUrl, img)
  }

  runBtn.addEventListener('click', () => {
    void (async () => {
      runBtn.disabled = true
      imgs.replaceChildren()
      const base = map.getCamera()
      const z0 = base.zoom, x0 = base.centerX, y0 = base.centerY, p0 = base.pitch, br0 = base.bearing

      pre.textContent = '측정 중… pitch 0° 정착 (4초)'
      const flat = await captureAt(0, 4000)
      pre.textContent = '측정 중… pitch 70° 정착 (4초)'
      const tilt = await captureAt(70, 4000)

      // Restore the starting view.
      const cam = map.getCamera()
      cam.zoom = z0; cam.centerX = x0; cam.centerY = y0; cam.pitch = p0; cam.bearing = br0
      map.invalidate()

      const canvas = document.querySelector('canvas')
      const totalSampled = (r: CaptureResult | null): number => r ? r.counts.length : 0
      if (!flat && !tilt) {
        // Readback unsupported on this browser → guided fallback.
        report = ''
        pre.textContent = '이 브라우저는 캔버스 자동 캡처가 안 됩니다.\n'
          + '아래 버튼으로 pitch 를 바꾸며 각각 직접 스크린샷 해 주세요.'
        const f0 = mkBtn('pitch 0°', '#444'), f70 = mkBtn('pitch 70°', '#444')
        f0.onclick = () => { const c = map.getCamera(); c.pitch = 0; map.invalidate() }
        f70.onclick = () => { const c = map.getCamera(); c.pitch = 70; map.invalidate() }
        imgs.append(f0, f70)
        runBtn.disabled = false
        return
      }

      const lines: string[] = []
      lines.push('=== X-GIS 오버드로 측정 (debug=overdraw) ===')
      lines.push(`DPR=${window.devicePixelRatio || 1}  캔버스=${canvas?.width ?? 0}x${canvas?.height ?? 0}`)
      lines.push(statsLine('pitch 0° (평면)', flat?.counts ?? [], totalSampled(flat), totalSampled(flat)))
      lines.push(statsLine('pitch 70°(기울임)', tilt?.counts ?? [], totalSampled(tilt), totalSampled(tilt)))
      report = lines.join('\n')
      pre.textContent = report

      // Thumbnails (secondary — the numbers above are the verdict).
      for (const [lbl, r] of [['0°', flat], ['70°', tilt]] as const) {
        if (!r) continue
        const wrap = document.createElement('div')
        wrap.style.cssText = 'text-align:center;'
        const im = document.createElement('img')
        im.src = r.dataUrl
        im.style.cssText = 'width:160px;height:auto;border:1px solid #555;display:block;'
        const cap = document.createElement('div'); cap.textContent = `pitch ${lbl}`
        wrap.append(im, cap); imgs.append(wrap)
      }
      runBtn.disabled = false
      runBtn.textContent = '▶ 다시 측정'
    })()
  })

  copyBtn.addEventListener('click', () => {
    const text = report || pre.textContent || ''
    navigator.clipboard?.writeText(text).then(
      () => { copyBtn.textContent = '✓ 복사됨'; setTimeout(() => { copyBtn.textContent = '📋 복사' }, 1500) },
      () => { copyBtn.textContent = '복사 실패 — 길게 눌러 선택' },
    )
  })

  closeBtn.addEventListener('click', () => panel.remove())
}
