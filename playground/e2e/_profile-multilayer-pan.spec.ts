// Profile multi_layer pan after auto-zoom-in then zoom-back-out.
// Uses GPU timestamp-query (?gpuprof=1) so we can see GPU vs CPU
// breakdown — JS-only profiling can't tell whether 22ms frames are
// CPU-bound or GPU-bound.

import { test } from '@playwright/test'
import { writeFileSync } from 'node:fs'

test.describe('profile multi_layer pan @z0 worldwrap', () => {
  test('hi-freq drag with GPU timing', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1400, height: 900 })

    const consoleMsgs: string[] = []
    page.on('console', m => {
      consoleMsgs.push(`[${m.type()}] ${m.text()}`)
    })

    // Demo + quality knobs via env vars so one spec tests many scenarios:
    //   DEMO=night_map            target a different demo (default: multi_layer)
    //   ZOOM=4.5                  override initial zoom (default: 0 — wide view)
    //   QUALITY=performance       apply a quality preset
    //   MSAA=1 | DPR=0.5          individual quality overrides
    const demo = process.env.DEMO ?? 'multi_layer'
    const zoom = process.env.ZOOM ?? '0'
    const flags: string[] = [`id=${demo}`, 'e2e=1', 'gpuprof=1']
    if (process.env.QUALITY) flags.push(`quality=${process.env.QUALITY}`)
    if (process.env.MSAA) flags.push(`msaa=${process.env.MSAA}`)
    if (process.env.DPR) flags.push(`dpr=${process.env.DPR}`)
    if (process.env.ADAPTIVE_DPR) flags.push(`adaptiveDpr=${process.env.ADAPTIVE_DPR}`)
    if (process.env.PICKING === '1') flags.push('picking=1')
    const url = `/demo.html?${flags.join('&')}#${zoom}/0.00000/0.00000`
    console.log(`[spec] loading ${url}`)
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 30_000 },
    )

    const gpuSupported = await page.evaluate(() => {
      const m = (window as any).__xgisMap
      return !!m?.gpuTimer?.enabled
    })
    if (!gpuSupported) {
      console.warn('[spec] GPU timing not supported in this browser/GPU — falling back to CPU only')
    }

    // Let auto-zoom-in (geojson compile + bounds-fit) settle.
    await page.waitForTimeout(6000)

    const map = page.locator('#map')
    const box = await map.boundingBox()
    if (!box) throw new Error('no map bounds')
    const cy = box.y + box.height / 2

    // Zoom OUT — undoes any auto-zoom-in from data load.
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, 200)
      await page.waitForTimeout(50)
    }
    await page.waitForTimeout(2000)

    // Reset GPU timer samples so we only measure the pan window.
    await page.evaluate(() => {
      const m = (window as any).__xgisMap
      m?.gpuTimer?.resetTimings?.()
    })

    const cdp = await page.context().newCDPSession(page)
    // CPU throttling via CDP — CPU_SLOWDOWN=6 simulates a mid-range mobile
    // device. Useful when the desktop test rig is too fast to reveal a
    // CPU-side optimization's impact. Leave unset for normal timing.
    if (process.env.CPU_SLOWDOWN) {
      const rate = Number(process.env.CPU_SLOWDOWN)
      if (Number.isFinite(rate) && rate >= 1) {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate })
        console.log(`[spec] CPU throttled ${rate}×`)
      }
    }
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
    await cdp.send('Profiler.start')

    const result = await page.evaluate(async (args) => {
      const { x0, x1, cy } = args
      const canvas = document.querySelector('#map') as HTMLCanvasElement
      const times: number[] = []
      let last = performance.now()
      const start = last
      let stop = false
      function tick() {
        const t = performance.now()
        times.push(t - last)
        last = t
        if (!stop) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)

      const fire = (type: string, x: number, y: number) => {
        const ev = new PointerEvent(type, {
          pointerId: 1, bubbles: true, cancelable: true,
          clientX: x, clientY: y, pointerType: 'mouse', isPrimary: true,
          button: type === 'pointerdown' ? 0 : -1, buttons: type === 'pointerup' ? 0 : 1,
        })
        canvas.dispatchEvent(ev)
      }

      fire('pointerdown', x0, cy)
      const N = 60
      for (let i = 0; i < N; i++) {
        const x = x0 + (x1 - x0) * (i / (N - 1))
        fire('pointermove', x, cy)
        await new Promise(r => setTimeout(r, 16))
      }
      fire('pointerup', x1, cy)
      await new Promise(r => setTimeout(r, 200))
      fire('pointerdown', x1, cy)
      for (let i = 0; i < N; i++) {
        const x = x1 + (x0 - x1) * (i / (N - 1))
        fire('pointermove', x, cy)
        await new Promise(r => setTimeout(r, 16))
      }
      fire('pointerup', x0, cy)
      await new Promise(r => setTimeout(r, 500))
      stop = true
      const total = performance.now() - start

      // Pull GPU samples accumulated by the GPUTimer ring (in nanoseconds).
      const m = (window as any).__xgisMap
      const gpuNs: number[] = m?.gpuTimer?.getTimings?.() ?? []
      return { times, total, gpuNs, gpuEnabled: !!m?.gpuTimer?.enabled }
    }, { x0: box.x + box.width * 0.85, x1: box.x + box.width * 0.15, cy })

    const { profile } = await cdp.send('Profiler.stop')
    writeFileSync('profile-multilayer-pan.cpuprofile', JSON.stringify(profile))

    // ── CPU frame stats ──
    const cpu = [...result.times].sort((a, b) => a - b)
    const cpuAvg = cpu.reduce((a, b) => a + b, 0) / cpu.length
    const cpuStats = {
      frames: cpu.length,
      total_ms: result.total,
      avg_ms: +cpuAvg.toFixed(2),
      p50_ms: +cpu[Math.floor(cpu.length * 0.5)].toFixed(2),
      p95_ms: +cpu[Math.floor(cpu.length * 0.95)].toFixed(2),
      p99_ms: +cpu[Math.floor(cpu.length * 0.99)].toFixed(2),
      max_ms: +cpu[cpu.length - 1].toFixed(2),
      fps_avg: +(1000 / cpuAvg).toFixed(1),
      slow_frames_gt_16ms: cpu.filter(t => t > 16.7).length,
      slow_frames_gt_33ms: cpu.filter(t => t > 33.3).length,
      slow_frames_gt_50ms: cpu.filter(t => t > 50).length,
    }

    // ── GPU pass stats ──
    let gpuStats: Record<string, unknown> = { enabled: result.gpuEnabled, samples: 0 }
    if (result.gpuNs.length > 0) {
      const gpuMs = result.gpuNs.map(ns => ns / 1e6).sort((a, b) => a - b)
      const gpuAvg = gpuMs.reduce((a, b) => a + b, 0) / gpuMs.length
      gpuStats = {
        enabled: true,
        samples: gpuMs.length,
        avg_ms: +gpuAvg.toFixed(3),
        p50_ms: +gpuMs[Math.floor(gpuMs.length * 0.5)].toFixed(3),
        p95_ms: +gpuMs[Math.floor(gpuMs.length * 0.95)].toFixed(3),
        p99_ms: +gpuMs[Math.floor(gpuMs.length * 0.99)].toFixed(3),
        max_ms: +gpuMs[gpuMs.length - 1].toFixed(3),
        gt_8ms_pct: +(gpuMs.filter(t => t > 8).length / gpuMs.length * 100).toFixed(1),
        gt_16ms_pct: +(gpuMs.filter(t => t > 16).length / gpuMs.length * 100).toFixed(1),
      }
    }

    const stats = { cpu: cpuStats, gpu_first_opaque_pass: gpuStats }
    writeFileSync('profile-multilayer-pan-stats.json', JSON.stringify(stats, null, 2))
    console.log('CPU_STATS:', JSON.stringify(cpuStats))
    console.log('GPU_STATS:', JSON.stringify(gpuStats))

    // Top JS self-time (excluding V8 idle/program/GC)
    const nodes = profile.nodes
    const samples = profile.samples ?? []
    const timeDeltas = profile.timeDeltas ?? []
    const selfTime = new Map<number, number>()
    for (let i = 0; i < samples.length; i++) {
      const id = samples[i]
      const dt = timeDeltas[i] ?? 0
      selfTime.set(id, (selfTime.get(id) ?? 0) + dt)
    }
    const nodeById = new Map<number, any>()
    for (const n of nodes) nodeById.set(n.id, n)
    const ranked = [...selfTime.entries()]
      .map(([id, t]) => {
        const n = nodeById.get(id)
        const cf = n?.callFrame
        return {
          t,
          name: `${cf?.functionName || '(anon)'} @ ${cf?.url?.split('/').slice(-2).join('/') || '?'}:${cf?.lineNumber}`,
        }
      })
      .filter(e => !e.name.includes('?:-1') && !e.name.includes('(idle)') && !e.name.includes('(program)') && !e.name.includes('(garbage'))
      .sort((a, b) => b.t - a.t)
      .slice(0, 30)
    console.log('TOP_SELF_TIME (filtered):')
    for (const r of ranked) console.log(`  ${(r.t / 1000).toFixed(1)} ms  ${r.name}`)

    writeFileSync('profile-multilayer-pan-console.log', consoleMsgs.slice(-400).join('\n'))
  })
})
