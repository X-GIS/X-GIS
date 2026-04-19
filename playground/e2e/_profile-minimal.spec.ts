import { test } from '@playwright/test'
import { writeFileSync } from 'node:fs'

test.describe('profile minimal @zoom=0', () => {
  test('CPU profile + frame-time stats', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1400, height: 900 })

    const consoleMsgs: string[] = []
    page.on('console', m => {
      const t = `[${m.type()}] ${m.text()}`
      consoleMsgs.push(t)
    })

    await page.goto('/demo.html?id=minimal&e2e=1#0.00/0.00000/148.38849', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 20_000 },
    )

    // Let it settle for a second
    await page.waitForTimeout(1000)

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
    await cdp.send('Profiler.start')

    // Measure frame times over ~3 seconds
    const frameData = await page.evaluate(() => new Promise<{ times: number[]; total: number }>(resolve => {
      const times: number[] = []
      let last = performance.now()
      const start = last
      function tick() {
        const t = performance.now()
        times.push(t - last)
        last = t
        if (t - start < 3000) requestAnimationFrame(tick)
        else resolve({ times, total: t - start })
      }
      requestAnimationFrame(tick)
    }))

    const { profile } = await cdp.send('Profiler.stop')

    writeFileSync('profile-minimal.cpuprofile', JSON.stringify(profile))

    const times = frameData.times
    times.sort((a, b) => a - b)
    const avg = times.reduce((a, b) => a + b, 0) / times.length
    const p50 = times[Math.floor(times.length * 0.5)]
    const p95 = times[Math.floor(times.length * 0.95)]
    const max = times[times.length - 1]
    const fps = 1000 / avg

    const stats = {
      frames: times.length,
      total_ms: frameData.total,
      avg_ms: avg,
      p50_ms: p50,
      p95_ms: p95,
      max_ms: max,
      fps_avg: fps,
    }
    writeFileSync('profile-minimal-stats.json', JSON.stringify(stats, null, 2))
    console.log('FRAME_STATS:', JSON.stringify(stats))

    // Top functions by self-time
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
      .sort((a, b) => b.t - a.t)
      .slice(0, 30)
    console.log('TOP_SELF_TIME:')
    for (const r of ranked) console.log(`  ${r.t.toFixed(0)} us  ${r.name}`)

    // Save console lines (filter to last 200)
    writeFileSync('profile-minimal-console.log', consoleMsgs.slice(-400).join('\n'))
  })
})
