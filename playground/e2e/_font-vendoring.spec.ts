// Regression: demo.html + compare.html used to preload
// /fonts/open-sans-latin-variable.woff2 and noto-sans-latin-variable.
// woff2 even though the actual .woff2 files were never vendored. Vite
// served its SPA index.html fallback for those URLs; the browser fed
// the HTML to OTS which rejected with "invalid sfntVersion: 1008813135"
// (bytes `<!DI`) — three warnings per demo, on every load.
//
// This spec asserts the underlying contract regardless of *how* it's
// satisfied: either the woff2 files exist (vendored future), or the
// references were removed (current). What MUST NOT happen is
// referencing-without-providing.

import { test, expect } from '@playwright/test'

test('no font 404 noise on demo.html load', async ({ page }) => {
  test.setTimeout(15_000)
  const otsErrors: string[] = []
  const failedFontReqs: string[] = []
  page.on('console', (m) => {
    const t = m.text()
    if (/OTS parsing error|Failed to decode downloaded font/i.test(t)) {
      otsErrors.push(t)
    }
  })
  page.on('requestfailed', (r) => {
    if (/\/fonts\/.*\.woff2/.test(r.url())) failedFontReqs.push(r.url())
  })
  page.on('response', (r) => {
    if (/\/fonts\/.*\.woff2/.test(r.url()) && r.status() >= 400) {
      failedFontReqs.push(`${r.status()} ${r.url()}`)
    }
  })
  // Also catch "200 but HTML body" — vite SPA fallback — by checking
  // the content-type of any /fonts/*.woff2 response.
  page.on('response', async (r) => {
    if (!/\/fonts\/.*\.woff2/.test(r.url())) return
    const ct = r.headers()['content-type'] ?? ''
    if (!/font|octet-stream/.test(ct)) {
      failedFontReqs.push(`bad-content-type=${ct} ${r.url()}`)
    }
  })

  await page.goto('/demo.html?id=minimal&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 10_000 },
  )
  await page.waitForTimeout(500)

  expect(otsErrors, `OTS errors: ${otsErrors.join('\n')}`).toHaveLength(0)
  expect(failedFontReqs, `Bad font responses: ${failedFontReqs.join('\n')}`).toHaveLength(0)
})
