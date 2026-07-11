import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__graphics-retained-circle__')
// Generous world-copy fan-out ceiling — flat Mercator at low zoom fans to a
// handful of copies, never near a per-item count.
const COPIES_MAX = 16

// ═══ #797 — retained CIRCLE primitive gate (real GPU) ═══
//
// map.graphics.add({ type: 'circle' }) is the disc sibling of icon/arrow. This
// verifies on the REAL GPU that it (1) renders visible discs (screenshot for the
// record) and (2) issues a draw-call count that is N-INDEPENDENT — O(COPIES),
// identical at 10k and 100k instances at a fixed camera (a per-item fallback
// would make it N). Circles need NO sprite atlas (procedural SDF), so add()
// works with no prior addImage.
test('retained circle: renders + draw-call N-independent', async ({ page }) => {
  test.setTimeout(120_000)
  mkdirSync(OUT, { recursive: true })
  await page.setViewportSize({ width: 600, height: 600 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text())
  })

  await page.goto('/demo.html?id=minimal&e2e=1#3/20/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 20000 },
  )
  await page.waitForTimeout(400)

  // ── Render a few big, distinct circles (fill + white stroke) and screenshot. ──
  await page.evaluate(async () => {
    interface Graphics {
      add(spec: unknown): { remove(): void }
    }
    const map = (
      window as unknown as { __xgisMap?: { graphics: Graphics; invalidate?: () => void } }
    ).__xgisMap
    if (!map) return
    type C = [number, number, number, string]
    const pts: C[] = [
      [-40, 30, 46, '#ff3b30'],
      [0, 10, 60, '#34c759'],
      [40, -10, 40, '#0a84ff'],
      [-20, -25, 34, '#ffd60a'],
    ]
    map.graphics.add({
      type: 'circle',
      data: pts,
      getPosition: (d: C) => [d[0], d[1]] as [number, number],
      getRadius: (d: C) => d[2],
      getColor: (d: C) => d[3],
      getStrokeColor: '#ffffff',
      getStrokeWidth: 3,
    })
    map.invalidate?.()
  })
  for (let f = 0; f < 8; f++)
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())))
  await page.waitForTimeout(250)
  writeFileSync(join(OUT, 'circle-render.png'), await page.locator('#map').screenshot())

  // ── Draw-call N-independence: 10k vs 100k must be identical + O(COPIES). ──
  const result = await page.evaluate(async () => {
    interface Graphics {
      add(spec: unknown): { remove(): void }
      getLastFrameDrawCalls(): number
    }
    const map = (
      window as unknown as { __xgisMap?: { graphics: Graphics; invalidate?: () => void } }
    ).__xgisMap
    if (!map) return { error: 'no __xgisMap' as const }
    const positions = (n: number): Array<[number, number]> => {
      const out: Array<[number, number]> = []
      for (let i = 0; i < n; i++) out.push([((i * 137.508) % 360) - 180, ((i * 61.803) % 140) - 70])
      return out
    }
    const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    const measure = async (n: number): Promise<number> => {
      const handle = map.graphics.add({
        type: 'circle',
        data: positions(n),
        getPosition: (d: [number, number]) => d,
        getRadius: 5,
        getColor: '#ff3311',
        getStrokeColor: '#ffffff',
        getStrokeWidth: 1,
      })
      map.invalidate?.()
      for (let f = 0; f < 6; f++) await nextFrame()
      await sleep(80)
      const dc = map.graphics.getLastFrameDrawCalls()
      handle.remove()
      map.invalidate?.()
      await nextFrame()
      return dc
    }
    const dc10k = await measure(10_000)
    const dc100k = await measure(100_000)
    return { dc10k, dc100k }
  })
  if ('error' in result) throw new Error(result.error)
  const { dc10k, dc100k } = result
  console.log(`[#797 circle] 10k=${dc10k} 100k=${dc100k} (COPIES_MAX=${COPIES_MAX})`)

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  expect(dc10k, '10k must issue at least one draw').toBeGreaterThanOrEqual(1)
  expect(dc100k, `100k draw calls ${dc100k} must be O(COPIES) ≤ ${COPIES_MAX}`).toBeLessThanOrEqual(
    COPIES_MAX,
  )
  expect(dc100k, `N-independent: 10k(${dc10k}) === 100k(${dc100k})`).toBe(dc10k)
})
