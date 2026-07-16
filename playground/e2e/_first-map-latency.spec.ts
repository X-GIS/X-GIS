// Diagnostic measurement (not a gate): TIME-TO-FIRST-MAP cold-start breakdown.
//
// Captures, per demo: navigation -> __xgisReady total, the resource waterfall
// (JS chunks / style / sprite / glyphs / tiles: start + duration), and long
// tasks (main-thread blocks >50ms, a proxy for sync compile/pipeline work).
// Pairs with the static startup-latency audit to rank critical-path costs.
//
// Headed real GPU. minimal = offline deterministic; openfreemap_bright = real
// network first-map experience.

import { test } from '@playwright/test'

type Win = Window & { __xgisReady?: boolean; __lt?: Array<{ start: number; dur: number }> }

const DEMOS = ['minimal', 'openfreemap_bright'] as const

for (const id of DEMOS) {
  test(`first-map latency: ${id}`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.addInitScript(() => {
      const w = window as unknown as Win
      w.__lt = []
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__lt!.push({ start: e.startTime, dur: e.duration })
      }).observe({ type: 'longtask', buffered: true })
    })
    await page.setViewportSize({ width: 1024, height: 768 })
    const t0 = Date.now()
    await page.goto(`/demo.html?id=${id}#2/20/10/0/0`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, {
      timeout: 90_000,
    })
    const readyMs = Date.now() - t0

    const data = await page.evaluate(() => {
      const w = window as unknown as Win
      const res = performance
        .getEntriesByType('resource')
        .map((e) => {
          const r = e as PerformanceResourceTiming
          const name = r.name.replace(/^https?:\/\/[^/]+/, '').slice(0, 90)
          return {
            name,
            start: Math.round(r.startTime),
            dur: Math.round(r.duration),
            size: r.transferSize,
          }
        })
        .sort((a, b) => a.start - b.start)
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
      return {
        domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? -1),
        resCount: res.length,
        totalBytes: res.reduce((s, r) => s + (r.size || 0), 0),
        // top-10 longest resources + first tile-ish resource
        slowest: [...res].sort((a, b) => b.dur - a.dur).slice(0, 10),
        firstFew: res.slice(0, 12),
        longTasks: (w.__lt ?? []).map((t) => ({
          start: Math.round(t.start),
          dur: Math.round(t.dur),
        })),
      }
    })

    console.log(
      `\n[first-map ${id}] READY=${readyMs}ms dcl=${data.domContentLoaded}ms resources=${data.resCount} bytes=${(data.totalBytes / 1024).toFixed(0)}KB`,
    )
    const ltTotal = data.longTasks.reduce((s, t) => s + t.dur, 0)
    console.log(
      `[first-map ${id}] longTasks n=${data.longTasks.length} total=${ltTotal}ms :: ${data.longTasks.map((t) => `${t.start}+${t.dur}`).join(' ')}`,
    )
    console.log(`[first-map ${id}] slowest resources:`)
    for (const r of data.slowest)
      console.log(
        `   ${String(r.start).padStart(6)}ms +${String(r.dur).padStart(5)}ms ${((r.size || 0) / 1024).toFixed(0).padStart(6)}KB ${r.name}`,
      )
    console.log(`[first-map ${id}] first resources (waterfall head):`)
    for (const r of data.firstFew)
      console.log(`   ${String(r.start).padStart(6)}ms +${String(r.dur).padStart(5)}ms ${r.name}`)
  })
}
