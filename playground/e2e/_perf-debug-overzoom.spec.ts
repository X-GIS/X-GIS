// Performance debugger for over-zoom + pitch + rotation scenarios.
// Captures per-frame timing + draw stats via inspectPipeline poll
// while triggering renders by camera mutation.

import { test, type Page } from '@playwright/test'

const READY_TIMEOUT_MS = 30_000

async function waitForReady(page: Page): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < READY_TIMEOUT_MS) {
    const ready = await page.evaluate(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    )
    if (ready) return
    await page.waitForTimeout(100)
  }
  throw new Error('xgis not ready')
}

test.describe('Performance debug — over-zoom + pitch + rotation', () => {
  test('z=21.6 pitch=69.7 bearing=300 Seoul', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1280, height: 720 })

    await page.goto(
      `/demo.html?id=pmtiles_layered&proj=mercator#21.60/37.51193/127.11208/300.0/69.7`,
      { waitUntil: 'domcontentloaded' },
    )
    await waitForReady(page)
    await page.waitForTimeout(3000) // initial settle

    // Inject the probe AND start collecting frame samples.
    // The probe wraps every VTR.render() and the outer renderFrame()
    // and records timings to window.__perfFrames.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = (window as any).__xgisMap
      if (!map?.vtSources) return
      const samples: Array<{
        type: string
        source?: string
        duration: number
        frameId?: number
      }> = []
      ;(window as unknown as { __perfFrames: typeof samples }).__perfFrames = samples

      // Track tile counts per render via the wrapped render fn below.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__tileCounts = []
      // Wrap each VTR's render + key sub-methods with phase timers.
      for (const [name, entry] of map.vtSources.entries()) {
        const renderer = entry.renderer
        const source = entry.source
        const wrapMethod = (target: object, methodName: string, label: string) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const orig = (target as any)[methodName]
          if (typeof orig !== 'function') return
          const bound = orig.bind(target)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(target as any)[methodName] = function(...args: any[]) {
            const t0 = performance.now()
            const ret = bound.apply(this, args)
            const t1 = performance.now()
            samples.push({
              type: label,
              source: name as string,
              duration: t1 - t0,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              frameId: (this as any).currentFrameId,
            })
            return ret
          }
        }
        wrapMethod(renderer, 'render', 'render')
        wrapMethod(renderer, 'renderTileKeys', 'renderTileKeys')
        wrapMethod(renderer, 'doUploadTile', 'doUploadTile')
        wrapMethod(renderer, 'drainPendingUploads', 'drainPendingUploads')
        wrapMethod(renderer, 'evictGPUTiles', 'evictGPUTiles')
        // Catalog-side calls invoked from render().
        wrapMethod(source, 'requestTiles', 'src.requestTiles')
        wrapMethod(source, 'evictTiles', 'src.evictTiles')
        wrapMethod(source, 'resetCompileBudget', 'src.resetCompileBudget')
        wrapMethod(source, 'compileTileOnDemand', 'src.compileTileOnDemand')
        // LineRenderer per-layer slot (uniform pack + writeBuffer).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lr = (renderer as any).lineRenderer
        if (lr) wrapMethod(lr, 'writeLayerSlot', 'lr.writeLayerSlot')
      }

      // Wrap the outer renderFrame method (private but accessible).
      // Find it by walking instance prototype chain.
      const proto = Object.getPrototypeOf(map)
      const renderFrameDesc = Object.getOwnPropertyDescriptor(proto, 'renderFrame')
        ?? (proto.renderFrame ? { value: proto.renderFrame, writable: true, configurable: true } : null)
      if (renderFrameDesc?.value) {
        const orig = renderFrameDesc.value.bind(map)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(map as any).renderFrame = function(...args: any[]) {
          const t0 = performance.now()
          const ret = orig.apply(this, args)
          const t1 = performance.now()
          samples.push({ type: 'renderFrame', duration: t1 - t0 })
          return ret
        }
      }
    })

    // Drive 30 frames of camera change. Use small bearing tweaks to
    // pass shouldRenderThisFrame's camera-sig diff; camera.zoom +
    // bearing both contribute. Use 200ms gap so each tick gets a
    // full RAF to render.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = (window as any).__xgisMap
      if (!map?.camera) return
      const cam = map.camera
      return new Promise<void>(resolve => {
        let i = 0
        const tick = () => {
          if (i >= 30) { resolve(); return }
          cam.bearing = (cam.bearing + 1) % 360
          i++
          setTimeout(tick, 100) // 100ms per tick — enough for slow frames
        }
        tick()
      })
    })

    // Read the captured samples.
    type Sample = { type: string; source?: string; duration: number; frameId?: number }
    const samples = await page.evaluate(() =>
      (window as unknown as { __perfFrames: Sample[] }).__perfFrames ?? []
    ) as Sample[]
    // Also grab User Timing measures injected by render() source.
    const userMeasures = await page.evaluate(() => {
      return performance.getEntriesByType('measure').map(m => ({
        type: m.name,
        duration: m.duration,
      }))
    })
    samples.push(...userMeasures)
    console.log(`\nTotal samples: ${samples.length}`)
    if (samples.length === 0) {
      // Fallback: maybe renderFrame is called directly via RAF, not
      // via the prototype. Capture by polling getDrawStats instead.
      console.log('No samples captured — render() not invoked or wrapper failed.')
      return
    }

    // Group by type+source and report stats.
    const groups = new Map<string, number[]>()
    for (const s of samples) {
      const key = s.source ? `${s.type}:${s.source}` : s.type
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(s.duration)
    }
    console.log('\n=== Phase timings (ms) ===')
    for (const [key, durations] of groups) {
      const sorted = [...durations].sort((a, b) => a - b)
      const sum = durations.reduce((a, b) => a + b, 0)
      const mean = sum / durations.length
      const p50 = sorted[Math.floor(sorted.length * 0.5)]
      const p95 = sorted[Math.floor(sorted.length * 0.95)]
      const max = sorted[sorted.length - 1]
      console.log(
        `  ${key.padEnd(28)} n=${String(durations.length).padStart(4)} ` +
        `mean=${mean.toFixed(2)} p50=${p50.toFixed(2)} p95=${p95.toFixed(2)} max=${max.toFixed(2)}`,
      )
    }

    // Summarize: per-frame total render budget. Group vtr.render samples
    // by frameId (each frame has 4 vtr.render invocations for pmtiles_
    // layered's 4 ShowCommands), sum to get per-frame VTR cost.
    const byFrame = new Map<number, number>()
    for (const s of samples) {
      if (s.type !== 'vtr.render' || s.frameId === undefined) continue
      byFrame.set(s.frameId, (byFrame.get(s.frameId) ?? 0) + s.duration)
    }
    if (byFrame.size > 0) {
      const totals = [...byFrame.values()].sort((a, b) => a - b)
      const mean = totals.reduce((a, b) => a + b, 0) / totals.length
      const p95 = totals[Math.floor(totals.length * 0.95)]
      const max = totals[totals.length - 1]
      console.log(
        `\nPer-frame VTR sum: n=${totals.length} mean=${mean.toFixed(2)}ms p95=${p95.toFixed(2)} max=${max.toFixed(2)}`,
      )
    }
  })
})
