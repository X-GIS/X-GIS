// ═══ On-site mobile performance scoreboard (?perf=1) ═══
//
// Mobile testers can't open DevTools or paste console snippets. This is the
// on-SCREEN equivalent of the _perf-mobile-passes scoreboard: a tap-to-run
// panel that drives a fixed camera animation, then shows — and one-tap COPIES
// — frame-time percentiles, draw stats, the GPU timestamp breakdown, and the
// per-pass CPU encode times. The tester taps "측정", pans nothing, then taps
// "복사" and pastes the report back.
//
// Mounted from demo-runner when the URL carries `?perf=1`. Pair with
// `?gpuprof=1` to also populate the GPU-side timing (the timestamp-query timer
// is only constructed when gpuprof is set). `?perf=1` alone still gives frame
// percentiles + per-pass CPU + draw stats, which is enough to rank the passes.
//
// Pure diagnostic UI — reads the map's public getCamera()/invalidate()/stats/
// gpuTimer surface and the __xgisPerfPhases global. Touches no render code.

interface PerfCamera { zoom: number; centerX: number; centerY: number; pitch: number; bearing: number }
interface PerfMap {
  getCamera(): PerfCamera
  invalidate(): void
  stats?: { drawCalls: number; triangles: number; lines: number; tilesVisible: number }
  gpuTimer?: { getBreakdown(): Record<string, number[]>; resetTimings?: () => void } | null
}
interface PerfPhasesAPI {
  getPhaseAverages: () => Array<{ name: string; meanMs: number; perFrameMs: number; samples: number }>
  resetPhaseTimings: () => void
  setEnabled: (b: boolean) => void
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

/** Drive one camera animation for `durationMs`, mutating the live camera via
 *  `update(t)` each rAF tick, and return the per-frame deltas (ms). */
function runScenario(map: PerfMap, durationMs: number, update: (t: number, cam: PerfCamera) => void): Promise<number[]> {
  const cam = map.getCamera()
  const frames: number[] = []
  return new Promise<number[]>((resolve) => {
    const start = performance.now()
    let last = start
    const tick = (): void => {
      const now = performance.now()
      frames.push(now - last)
      last = now
      const elapsed = now - start
      if (elapsed >= durationMs) { resolve(frames); return }
      update(elapsed / durationMs, cam)
      map.invalidate()
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

function summarise(frames: number[]): string {
  const t = frames.slice(2) // drop warmup
  if (t.length === 0) return 'no frames'
  const p50 = pct(t, 50), p95 = pct(t, 95), p99 = pct(t, 99)
  const worst = t.reduce((a, b) => Math.max(a, b), 0)
  const fps = p50 > 0 ? (1000 / p50).toFixed(0) : '--'
  return `p50=${p50.toFixed(1)} p95=${p95.toFixed(1)} p99=${p99.toFixed(1)} worst=${worst.toFixed(0)}  (~${fps}fps, ${t.length}f)`
}

/** Build the full copyable text report after the scenarios have run. */
function buildReport(map: PerfMap, zoomLine: string, pitchLine: string): string {
  const dpr = window.devicePixelRatio || 1
  const canvas = document.querySelector('canvas')
  const cw = canvas?.width ?? 0, ch = canvas?.height ?? 0
  const clientW = canvas?.clientWidth ?? 0, clientH = canvas?.clientHeight ?? 0
  const effDpr = clientW > 0 ? (cw / clientW).toFixed(2) : '?'

  const phases = (window as unknown as { __xgisPerfPhases?: PerfPhasesAPI }).__xgisPerfPhases
  const passes = (phases?.getPhaseAverages?.() ?? []).filter(p => p.name.startsWith('encoder.pass.'))
  const opaqueGroups = passes.filter(p => /encoder\.pass\.opaque/.test(p.name)).length
  const translucent = passes.filter(p => /encoder\.pass\.translucent/.test(p.name)).length

  const gpu = map.gpuTimer?.getBreakdown?.() ?? {}
  const gpuLine = Object.entries(gpu).map(([k, ns]) => {
    const ms = ns.map(n => n / 1e6).sort((a, b) => a - b)
    return ms.length ? `${k}=${pct(ms, 50).toFixed(2)}/${pct(ms, 95).toFixed(2)}` : ''
  }).filter(Boolean).join('  ') || '(없음 — URL에 &gpuprof=1 추가)'

  const s = map.stats
  const drawLine = s
    ? `calls=${s.drawCalls} tris=${s.triangles} lines=${s.lines} tiles=${s.tilesVisible}`
    : '(없음)'

  const lines: string[] = []
  lines.push('=== X-GIS 성능 측정 (mobile scoreboard) ===')
  lines.push(`기기   DPR=${dpr} effDPR=${effDpr}  뷰포트=${clientW}x${clientH}  캔버스=${cw}x${ch}`)
  lines.push(`UA     ${navigator.userAgent}`)
  lines.push('')
  lines.push(`프레임  zoom+pan : ${zoomLine}`)
  lines.push(`프레임  pitch    : ${pitchLine}`)
  lines.push(`draw    ${drawLine}`)
  lines.push(`gpu ms (p50/p95)  ${gpuLine}`)
  lines.push('')
  lines.push(`패스 구성: opaque 패스 ${opaqueGroups}개, translucent 패스 ${translucent}개`)
  lines.push('per-pass CPU encode (perFrame ms, 큰 순):')
  if (passes.length === 0) {
    lines.push('  (없음 — perf-marks 미활성. ?perf=1 또는 ?gpuprof=1 로 로드했는지 확인)')
  } else {
    for (const p of passes) lines.push(`  ${p.perFrameMs.toFixed(3).padStart(8)}  ${p.name.replace('encoder.pass.', '')}`)
  }
  return lines.join('\n')
}

export function installPerfOverlay(map: PerfMap): void {
  // Arm the per-pass CPU marks (idempotent). The GPU timer is only built when
  // ?gpuprof=1 was set at boot — surfaced in the report if missing.
  ;(window as unknown as { __xgisPerfPhases?: PerfPhasesAPI }).__xgisPerfPhases?.setEnabled?.(true)

  document.getElementById('xgis-perf-overlay')?.remove()
  const panel = document.createElement('div')
  panel.id = 'xgis-perf-overlay'
  panel.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;z-index:10001;'
    + 'background:rgba(0,0,0,0.86);color:#e8e8e8;'
    + 'font:11px/1.35 monospace;padding:8px 10px;'
    + 'max-height:48vh;overflow:auto;-webkit-overflow-scrolling:touch;'
    + 'border-top:1px solid #444;'
  document.body.appendChild(panel)

  const bar = document.createElement('div')
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap;'
  const mkBtn = (label: string): HTMLButtonElement => {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText =
      'font:bold 12px/1 monospace;padding:8px 12px;border-radius:6px;'
      + 'border:1px solid #666;background:#1f6feb;color:#fff;touch-action:manipulation;'
    return b
  }
  const runBtn = mkBtn('▶ 측정 (12초)')
  const copyBtn = mkBtn('📋 복사')
  const closeBtn = mkBtn('✕')
  closeBtn.style.background = '#444'
  copyBtn.style.background = '#2da44e'
  const live = document.createElement('span')
  live.style.cssText = 'margin-left:auto;color:#9fd3ff;'
  bar.append(runBtn, copyBtn, closeBtn, live)

  const pre = document.createElement('pre')
  pre.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;'
  pre.textContent = '«측정»을 눌러 6초 zoom+pan + 6초 pitch 를 돌립니다.\nGPU 시간까지 보려면 URL 에 &gpuprof=1 을 붙여 다시 로드하세요.'
  panel.append(bar, pre)

  let report = ''
  // Live frame-time readout from rAF (updates whether or not a benchmark runs).
  let lastT = performance.now()
  const liveTick = (): void => {
    const now = performance.now()
    const dt = now - lastT
    lastT = now
    if (dt > 0) live.textContent = `~${(1000 / dt).toFixed(0)} fps (live)`
    requestAnimationFrame(liveTick)
  }
  requestAnimationFrame(liveTick)

  runBtn.addEventListener('click', () => {
    void (async () => {
      runBtn.disabled = true
      const phases = (window as unknown as { __xgisPerfPhases?: PerfPhasesAPI }).__xgisPerfPhases
      phases?.setEnabled?.(true)
      phases?.resetPhaseTimings?.()
      map.gpuTimer?.resetTimings?.()

      const base = map.getCamera()
      const x0 = base.centerX
      pre.textContent = '측정 중… zoom+pan (6초)'
      const zoom = await runScenario(map, 6000, (t, cam) => {
        const ph = t < 0.5 ? t * 2 : (1 - t) * 2
        cam.zoom = 10 + ph * 4
        cam.centerX = x0 + ph * 200000
      })
      pre.textContent = '측정 중… pitch (6초)'
      const pitch = await runScenario(map, 6000, (t, cam) => {
        const ph = t < 0.5 ? t * 2 : (1 - t) * 2
        cam.pitch = ph * 70
      })

      report = buildReport(map, summarise(zoom), summarise(pitch))
      pre.textContent = report
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
