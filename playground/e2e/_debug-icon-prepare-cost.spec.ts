import { test } from '@playwright/test'

// Throwaway probe: what does the icon path cost per frame DURING MOTION in a
// dense real style, and where does that time go (prepare / computeObstacles /
// setDraws / draw)? Establishes what is worth optimising.
const CAMS = [
  { name: 'seoul-z16', style: 'openfreemap-bright', hash: '#16/37.5665/126.9780' },
  { name: 'seoul-z17-pitch', style: 'openfreemap-liberty', hash: '#17/37.5665/126.9780/0/60' },
  { name: 'tokyo-z15', style: 'openfreemap-liberty', hash: '#15/35.6812/139.7671' },
]

for (const cam of CAMS) {
  test(`icon prepare cost ${cam.name}`, async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1800, height: 900 })
    await page.goto(`/compare.html?style=${cam.style}${cam.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 60_000 },
    )
    await page.waitForTimeout(12_000)
    const stats = await page.evaluate(() => {
      interface Stage {
        prepare: (...a: unknown[]) => void
        computeObstacles: (...a: unknown[]) => unknown[]
        pending: unknown[]
        renderer: { setDraws: (d: unknown[]) => void; draw: (...a: unknown[]) => void }
      }
      const m = (window as unknown as { __xgisMap?: Record<string, unknown> }).__xgisMap
      const stage = m?.iconStage as Stage | undefined
      if (!stage) return { error: 'no iconStage' }
      const proto = Object.getPrototypeOf(stage) as Stage
      const rproto = Object.getPrototypeOf(stage.renderer) as Stage['renderer']
      const acc: Record<string, number[]> = { prepare: [], obstacles: [], setDraws: [], draw: [] }
      const ns: number[] = []
      const collides: number[] = []
      const wrap = <T extends object, K extends keyof T>(
        o: T,
        k: K,
        bucket: string,
      ): (() => void) => {
        const orig = o[k] as unknown as (...a: unknown[]) => unknown
        ;(o[k] as unknown) = function patched(this: unknown, ...args: unknown[]) {
          const t0 = performance.now()
          const r = orig.apply(this, args)
          acc[bucket]!.push(performance.now() - t0)
          return r
        }
        return () => {
          ;(o[k] as unknown) = orig
        }
      }
      const origPrepare = proto.prepare
      proto.prepare = function patched(this: Stage, ...args: unknown[]) {
        ns.push(this.pending.length)
        collides.push(this.pending.filter((p) => (p as { collide?: boolean }).collide).length)
        const t0 = performance.now()
        origPrepare.apply(this, args)
        acc.prepare!.push(performance.now() - t0)
      }
      const un = [
        wrap(proto, 'computeObstacles', 'obstacles'),
        wrap(rproto, 'setDraws', 'setDraws'),
        wrap(rproto, 'draw', 'draw'),
      ]
      // Drive a continuous pan so the label/icon path runs every frame.
      const map = m as unknown as {
        getCenter: () => [number, number]
        jumpTo: (o: Record<string, unknown>) => void
      }
      const base = map.getCenter()
      let t = 0
      let raf = 0
      const step = (): void => {
        t += 1
        map.jumpTo({ center: [base[0] + t * 0.00012, base[1] + t * 0.00006] })
        raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
      const pct = (a: number[], p: number): number =>
        a.length
          ? +a
              .slice()
              .sort((x, y) => x - y)
              [Math.floor((a.length - 1) * p)]!.toFixed(3)
          : 0
      return new Promise((resolve) => {
        setTimeout(() => {
          cancelAnimationFrame(raf)
          proto.prepare = origPrepare
          for (const u of un) u()
          resolve({
            prepares: acc.prepare!.length,
            maxN: Math.max(0, ...ns),
            maxCollide: Math.max(0, ...collides),
            prepare: { p50: pct(acc.prepare!, 0.5), p95: pct(acc.prepare!, 0.95) },
            obstacles: {
              n: acc.obstacles!.length,
              p50: pct(acc.obstacles!, 0.5),
              p95: pct(acc.obstacles!, 0.95),
            },
            setDraws: { p50: pct(acc.setDraws!, 0.5), p95: pct(acc.setDraws!, 0.95) },
            draw: { n: acc.draw!.length, p50: pct(acc.draw!, 0.5), p95: pct(acc.draw!, 0.95) },
          })
        }, 8000)
      })
    })
    console.log(cam.name, JSON.stringify(stats))
  })
}
