import { test, expect } from '@playwright/test'

// ═══ #797 Phase 1 — retained icon batch DRAW-CALL N-independence gate ═══
//
// The retained host-drawing batch (map.graphics.add) projects every icon on the
// GPU from a single instanced draw per visible world copy — so the number of
// DRAW CALLS a frame issues is O(COPIES × batches) and is INDEPENDENT of the
// instance count N. This gate pins that EXACTLY (zero slack): 10k and 100k icons
// at the SAME fixed camera must issue the IDENTICAL draw-call count, and that
// count must be a small O(COPIES) constant — a per-item fallback (one draw per
// icon) would make it N (10 000 / 100 000) and fails on BOTH the equality and the
// small-bound assertion.
//
// This is the architectural companion to _host-retained-icons-perf (which proves
// N-independence via per-frame CPU TIMING with noise slack + the pack-once write
// counters): the draw-call count is the deterministic, zero-slack invariant that
// MAKES the timing flat — no GPU timer, no pixel read, so it runs headless on the
// WebGl2Device (?forcegl2=1) under SwiftShader exactly like the CI render gates.
//
// GraphicsManager.getLastFrameDrawCalls() sums the drapers' REAL pass.draw count
// (returned up from executeItems), reset at the top of every renderRetained frame
// — so a break that issues per-item draws is caught at the true draw site.

// A generous ceiling on the world-copy fan-out — flat Mercator fans to a handful
// of copies at low zoom (never anywhere near a per-item count).
const COPIES_MAX = 16

test('retained icon draw-call count is N-independent (10k === 100k, O(COPIES))', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 600, height: 600 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    // Resource-fetch noise (sandboxed/offline runners reset external fetches) is
    // not a render fault — the bar here is gl.getError + _validationErrors.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text())
  })

  // Camera pinned by hash so COPIES is identical across both measurements.
  await page.goto('/demo.html?id=minimal&forcegl2=1&e2e=1#4/20/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 20000 },
  )
  await page.waitForTimeout(300)

  const result = await page.evaluate(async () => {
    interface Graphics {
      add(spec: unknown): { remove(): void }
      getLastFrameDrawCalls(): number
    }
    const w = window as unknown as {
      __xgisMap?: {
        addImage(name: string, image: ImageData): void
        graphics: Graphics
        invalidate?: () => void
      }
    }
    const map = w.__xgisMap
    if (!map) return { error: 'no __xgisMap' as const }

    // A tiny 8×8 white sprite (tint irrelevant to the draw-call count; small so
    // 100k instances stay light on the software rasteriser — it is ONE draw).
    const px = new Uint8ClampedArray(8 * 8 * 4).fill(255)
    map.addImage('dc-dot', new ImageData(px, 8, 8))

    // Deterministic geo spread (no RNG — vary by index) so instances do not stack.
    const positions = (n: number): Array<[number, number]> => {
      const out: Array<[number, number]> = []
      for (let i = 0; i < n; i++) {
        out.push([((i * 137.508) % 360) - 180, ((i * 61.803) % 140) - 70])
      }
      return out
    }
    const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

    // Add a batch of `n` icons at the fixed view, let it settle over several
    // rendered frames, then read the steady per-frame draw-call count.
    const measure = async (n: number): Promise<number> => {
      const data = positions(n)
      const handle = map.graphics.add({
        type: 'icon',
        data,
        getPosition: (d: [number, number]) => d,
        getImage: 'dc-dot',
        getSize: 1,
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

  console.log(`[#797 P1 draw-call] 10k=${dc10k}  100k=${dc100k}  (COPIES_MAX=${COPIES_MAX})`)

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])

  // The batch actually issued draws (not a vacuous pass on a filtered-empty path).
  expect(dc10k, '10k must issue at least one draw').toBeGreaterThanOrEqual(1)
  expect(dc100k, '100k must issue at least one draw').toBeGreaterThanOrEqual(1)

  // O(COPIES), NOT O(N): a per-item path would be 100 000 here — far above the cap.
  expect(
    dc100k,
    `100k draw calls ${dc100k} must be O(COPIES) ≤ ${COPIES_MAX}, not O(N)`,
  ).toBeLessThanOrEqual(COPIES_MAX)

  // The core invariant — EXACTLY N-independent: identical draw-call count at 10× N.
  expect(dc100k, `draw-call count must be identical at 10k (${dc10k}) and 100k (${dc100k})`).toBe(
    dc10k,
  )
})
