// TEMP PROBE (#834 M5 final) — dual-backend capture of OFM Bright at Tokyo
// z14 for the §5 pixel-diff. Network-dependent (style + tiles via proxy) —
// local only, not a CI spec.

import { test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'

// Outbound HTTPS in this environment goes through the agent proxy; the
// browser must be pointed at it explicitly (env proxies are ignored by
// Chromium under Playwright) and the proxy's MITM cert accepted. Vite stays
// direct via the bypass list.
// Playwright wipes test-results/ on EVERY run — copy the captures out before
// running any other spec, or they're gone.
const OUT = 'test-results/bright-gl2'

async function shoot(page: import('@playwright/test').Page, gl2: boolean): Promise<Buffer> {
  await page.setViewportSize({ width: 900, height: 700 })
  const tileReqs = new Set<string>()
  page.on('request', (r) => {
    const m = r.url().match(/\/ofm-mirror\/(tiles\/.+\.pbf|fonts\/.+\.pbf)/)
    if (m) tileReqs.add(m[1])
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text()))
      errors.push(m.text().slice(0, 200))
  })
  await page.goto(
    `/demo.html?id=ofm_bright_local&e2e=1${gl2 ? '&forcegl2=1' : ''}#14/35.68/139.76/0/0`,
    { waitUntil: 'domcontentloaded' },
  )
  try {
    await page.waitForFunction(() => (window as any).__xgisReady === true, { timeout: 60_000 })
  } catch (e) {
    console.log(`NOT-READY(${gl2 ? 'gl2' : 'gpu'})`, JSON.stringify(errors.slice(0, 10)))
    throw e
  }
  // Long settle: style fetch + tile fetch + glyph/sprite + SwiftShader compile.
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(6000)
    await page.evaluate(() => (window as any).__xgisMap?.invalidate?.())
  }
  await page.waitForTimeout(2000)
  console.log(`ERRORS(${gl2 ? 'gl2' : 'gpu'})`, JSON.stringify(errors.slice(0, 3)))
  writeFileSync(`${OUT}/requests-${gl2 ? 'gl2' : 'gpu'}.txt`, [...tileReqs].sort().join('\n'))
  // Canvas pixels ONLY via toBlob — an element screenshot composites any DOM
  // painted over the canvas (the demo log overlay captures the forcegl2 boot
  // console.warn and poisons the bottom-right diff tiles). Invalidate + two
  // rAFs first so the presented frame is fresh at read time.
  const b64 = await page.evaluate(async () => {
    ;(window as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
    const canvas = document.querySelector('canvas')!
    const blob = await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob returned null'))), 'image/png'),
    )
    const u8 = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000)
      s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
    return btoa(s)
  })
  return Buffer.from(b64, 'base64')
}

test('bright dual capture', async ({ page, context }) => {
  test.setTimeout(540_000)
  mkdirSync(OUT, { recursive: true })
  writeFileSync(`${OUT}/webgl2.png`, await shoot(page, true))
  const p2 = await context.newPage()
  writeFileSync(`${OUT}/webgpu.png`, await shoot(p2, false))
  console.log('captured')
})
