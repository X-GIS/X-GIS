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

/** Build the full copyable text report after the scenarios have run.
 *  `rotPitchP50` is the measured rAF frame-time median of the (slow) rotate+
 *  pitch scenario — compared against `frame.total` to expose work OUTSIDE the
 *  render loop (tile upload/streaming, rAF scheduling, compositing). */
function buildReport(map: PerfMap, panZoomLine: string, rotPitchLine: string, rotPitchP50: number): string {
  const dpr = window.devicePixelRatio || 1
  const canvas = document.querySelector('canvas')
  const cw = canvas?.width ?? 0, ch = canvas?.height ?? 0
  const clientW = canvas?.clientWidth ?? 0, clientH = canvas?.clientHeight ?? 0
  const effDpr = clientW > 0 ? (cw / clientW).toFixed(2) : '?'

  const phases = (window as unknown as { __xgisPerfPhases?: PerfPhasesAPI }).__xgisPerfPhases
  const all = phases?.getPhaseAverages?.() ?? []
  // getPhaseAverages is already sorted by perFrameMs desc; partition preserves it.
  const passes = all.filter(p => p.name.startsWith('encoder.pass.'))
  const frameStar = all.filter(p => p.name.startsWith('frame.'))
  const other = all.filter(p => !p.name.startsWith('encoder.pass.') && !p.name.startsWith('frame.'))
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
  lines.push(`프레임  pan+zoom     : ${panZoomLine}`)
  lines.push(`프레임  rotate+pitch : ${rotPitchLine}`)
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

  // Frame-stage CPU (frame.prep / encode / submit / total) — the render loop's
  // own decomposition. This is where the non-pass CPU hides.
  lines.push('')
  lines.push('frame 단계 CPU (perFrame ms):')
  if (frameStar.length === 0) {
    lines.push('  (frame.* 마크 없음)')
  } else {
    for (const p of frameStar) lines.push(`  ${p.perFrameMs.toFixed(3).padStart(8)}  ${p.name}`)
  }
  // Localizers, computed from the marks:
  //  • encode − Σpasses isolates the non-pass encode work (buildSceneView /
  //    classify / pumpPrefetch) from the draw-call encode (the passes).
  //  • measured frame − frame.total isolates work OUTSIDE renderFrame (tile
  //    decode/upload, rAF scheduling, compositing).
  const passSum = passes.reduce((a, p) => a + p.perFrameMs, 0)
  const frameEncode = frameStar.find(p => p.name === 'frame.encode')?.perFrameMs ?? 0
  const frameTotal = frameStar.find(p => p.name === 'frame.total')?.perFrameMs ?? 0
  if (frameEncode > 0) {
    lines.push(`  frame.encode=${frameEncode.toFixed(1)} − passes합=${passSum.toFixed(1)}`
      + `  → 비패스 encode(classify/prefetch)≈${(frameEncode - passSum).toFixed(1)}ms`)
  }
  if (frameTotal > 0 && rotPitchP50 > 0) {
    lines.push(`  측정 frame p50=${rotPitchP50.toFixed(1)} − frame.total=${frameTotal.toFixed(1)}`
      + `  → 렌더 밖(업로드/rAF/합성)≈${(rotPitchP50 - frameTotal).toFixed(1)}ms`)
  }

  // Every other marked phase (tile selection / classify / prepare / prefetch),
  // largest first — the prime suspects for the high-pitch CPU spike.
  if (other.length > 0) {
    lines.push('')
    lines.push('기타 단계 CPU (perFrame ms, 큰 순):')
    for (const p of other) lines.push(`  ${p.perFrameMs.toFixed(3).padStart(8)}  ${p.name}`)
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
  const abBtn = mkBtn('▶ GPU/CPU 판정 (6초)')
  const copyBtn = mkBtn('📋 복사')
  const closeBtn = mkBtn('✕')
  closeBtn.style.background = '#444'
  copyBtn.style.background = '#2da44e'
  abBtn.style.background = '#8957e5'
  const live = document.createElement('span')
  live.style.cssText = 'margin-left:auto;color:#9fd3ff;'
  bar.append(runBtn, abBtn, copyBtn, closeBtn, live)

  const pre = document.createElement('pre')
  pre.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;'
  pre.textContent = '«측정»을 눌러 6초 pan+zoom + 6초 rotate+pitch 를 돌립니다 (현재 카메라 기준 — 글로브/평면 모두 OK).\nGPU 시간까지 보려면 URL 에 &gpuprof=1 을 붙여 다시 로드하세요.'
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

      // Snapshot the camera and perturb RELATIVE to it, so the benchmark is
      // meaningful at any starting view — a globe at z≈3 stays a globe (spin
      // exercises the 2-pass sphere render), a street scene at z≈14 pans/zooms
      // streets. The old hard-coded zoom 10→14 zoomed a globe down to mercator
      // and never tested the sphere pass.
      const b0 = map.getCamera()
      const z0 = b0.zoom, x0 = b0.centerX, p0 = b0.pitch, br0 = b0.bearing
      // ~0.4 of the visible width at this zoom (Web-Mercator world circumference
      // is 40,075,016 m); keeps the pan on-screen at z=3 and z=14 alike.
      const panDelta = (40075016.686 / Math.pow(2, z0)) * 0.4

      pre.textContent = '측정 중… pan+zoom (6초)'
      const panZoom = await runScenario(map, 6000, (t, cam) => {
        const ph = t < 0.5 ? t * 2 : (1 - t) * 2
        cam.zoom = Math.max(0, z0 + ph * 2)   // zoom in +2 then back
        cam.centerX = x0 + ph * panDelta
      })
      pre.textContent = '측정 중… rotate+pitch (6초)'
      const rotPitch = await runScenario(map, 6000, (t, cam) => {
        const ph = t < 0.5 ? t * 2 : (1 - t) * 2
        cam.bearing = br0 + t * 360           // full spin — drives the globe sphere pass
        cam.pitch = p0 + ph * 40
      })

      // Restore the starting view (pan/zoom/pitch already returned via the
      // triangle wave; bearing ends a full turn later ≡ br0).
      const camNow = map.getCamera()
      camNow.zoom = z0; camNow.centerX = x0; camNow.pitch = p0; camNow.bearing = br0
      map.invalidate()

      const rotPitchP50 = pct(rotPitch.slice(2), 50)
      report = buildReport(map, summarise(panZoom), summarise(rotPitch), rotPitchP50)
      pre.textContent = report
      runBtn.disabled = false
      runBtn.textContent = '▶ 다시 측정'
    })()
  })

  // One-tap GPU-vs-CPU verdict. Runs the rotate+pitch sweep once while a
  // MessageChannel ping-pong measures how long the MAIN THREAD is unresponsive
  // (busy) per stretch. This is confound-free (no render changes): if the main
  // thread is busy ≈ the whole frame → CPU-bound; if it's busy only ≈
  // renderFrame and idle the rest → the frame is paced to GPU/present →
  // GPU-bound. Settles the 22ms "렌더 밖" gap directly.
  abBtn.addEventListener('click', () => {
    void (async () => {
      abBtn.disabled = true; runBtn.disabled = true
      const b0 = map.getCamera()
      const z0 = b0.zoom, x0 = b0.centerX, y0 = b0.centerY, p0 = b0.pitch, br0 = b0.bearing
      const sweep = (t: number, cam: PerfCamera): void => {
        const ph = t < 0.5 ? t * 2 : (1 - t) * 2
        cam.bearing = br0 + t * 360
        cam.pitch = p0 + ph * 40
      }
      const phases = (window as unknown as { __xgisPerfPhases?: PerfPhasesAPI }).__xgisPerfPhases
      phases?.setEnabled?.(true); phases?.resetPhaseTimings?.()
      map.gpuTimer?.resetTimings?.()

      // Main-thread stall probe: a MessageChannel posts to itself as fast as
      // the event loop allows; the gap between deliveries = main-thread busy
      // time in that interval. Records the gap distribution over the run.
      const ch = new MessageChannel()
      const gaps: number[] = []
      let probing = true
      let lastPing = performance.now()
      ch.port1.onmessage = (): void => {
        const now = performance.now()
        gaps.push(now - lastPing)
        lastPing = now
        if (probing) ch.port2.postMessage(0)
      }
      lastPing = performance.now()
      ch.port2.postMessage(0)

      pre.textContent = '판정 중… rotate+pitch (6초)'
      const frames = await runScenario(map, 6000, sweep)
      probing = false
      ch.port1.close()

      // Restore the view.
      const c = map.getCamera()
      c.zoom = z0; c.centerX = x0; c.centerY = y0; c.pitch = p0; c.bearing = br0
      map.invalidate()

      const fP50 = pct(frames.slice(2), 50)
      const fps = fP50 > 0 ? (1000 / fP50).toFixed(0) : '--'
      const stallP50 = pct(gaps, 50)
      const stallP95 = pct(gaps, 95)
      const stallMax = gaps.reduce((a, b) => Math.max(a, b), 0)
      const frameTotal = (phases?.getPhaseAverages?.() ?? []).find(p => p.name === 'frame.total')?.perFrameMs ?? 0
      const gpu = map.gpuTimer?.getBreakdown?.() ?? {}
      const gpuVals = Object.values(gpu).flat().map(n => n / 1e6).sort((a, b) => a - b)
      const gpuP50 = gpuVals.length ? gpuVals[Math.floor(gpuVals.length * 0.5)]! : 0
      // Decision: is the main thread busy for most of the frame, or idle?
      const busyFrac = fP50 > 0 ? stallMax / fP50 : 0
      const verdict = busyFrac > 0.7
        ? `→ 메인스레드 최대 stall ${stallMax.toFixed(0)}ms ≈ frame ${fP50.toFixed(0)}ms : CPU 바운드(메인스레드가 프레임 내내 바쁨 — renderFrame 밖 JS)`
        : `→ 메인스레드 최대 stall ${stallMax.toFixed(0)}ms ≪ frame ${fP50.toFixed(0)}ms : GPU 바운드(메인은 idle, GPU/present 대기 — DPR/draw/present 쪽)`
      const dpr = window.devicePixelRatio || 1
      const canvas = document.querySelector('canvas')
      report = [
        '=== X-GIS GPU/CPU 판정 (rotate+pitch) ===',
        `기기 DPR=${dpr} 캔버스=${canvas?.width ?? 0}x${canvas?.height ?? 0}`,
        `frame p50=${fP50.toFixed(1)}ms (${fps}fps)`,
        `renderFrame CPU(frame.total)=${frameTotal.toFixed(1)}ms   GPU timestamp p50=${gpuP50.toFixed(1)}ms`,
        `main-thread stall  p50=${stallP50.toFixed(1)}  p95=${stallP95.toFixed(1)}  max=${stallMax.toFixed(1)} ms`,
        verdict,
      ].join('\n')
      pre.textContent = report
      abBtn.disabled = false; runBtn.disabled = false
      abBtn.textContent = '▶ GPU/CPU 다시'
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
