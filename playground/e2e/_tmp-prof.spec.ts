import { test } from '@playwright/test'
test('boot breakdown', async ({ page }) => {
  test.setTimeout(300_000)
  const t0 = Date.now()
  const marks: string[] = []
  page.on('console', (m) => {
    const t = m.text()
    if (t.startsWith('[X-GIS]') || t.includes('backend') || t.includes('prewarm'))
      marks.push(`${String(Date.now() - t0).padStart(6)}ms  ${t.slice(0, 110)}`)
  })
  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto('/demo.html?id=s111_live&forcegl2=1&e2e=1', { waitUntil: 'domcontentloaded' })
  marks.push(`${String(Date.now() - t0).padStart(6)}ms  <domcontentloaded>`)
  await page.waitForFunction(() => (window as any).__xgisReady === true, { timeout: 180_000 })
  marks.push(`${String(Date.now() - t0).padStart(6)}ms  <__xgisReady>`)
  console.log('\n=== BOOT TIMELINE ===\n' + marks.join('\n') + '\n')
})
