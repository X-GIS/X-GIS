// Grab all console output (including warnings) for the demos whose
// render-verify screenshots showed an error badge. Distinguishes
// genuine actionable warnings from Chrome-noise.

import { test } from '@playwright/test'

const DEMOS = ['continent_match', 'sdf_points', 'animation_pulse', 'categorical', 'minimal']

for (const id of DEMOS) {
  test(`warn-check: ${id}`, async ({ page }) => {
    test.setTimeout(20_000)
    await page.setViewportSize({ width: 1200, height: 700 })
    const msgs: { type: string; text: string }[] = []
    page.on('console', (m) => msgs.push({ type: m.type(), text: m.text() }))
    // Use CDP Network domain — catches ALL requests including workers,
    // subframes, and Image-loader failures that slip past page.on.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Network.enable')
    cdp.on('Network.responseReceived', (e: { response: { status: number; url: string } }) => {
      if (e.response.status >= 400) {
        msgs.push({ type: `http${e.response.status}`, text: e.response.url })
      }
    })
    cdp.on('Network.loadingFailed', (e: { errorText: string; request?: { url?: string } }) => {
      msgs.push({ type: 'loadfail', text: `${e.errorText} ${e.request?.url ?? '?'}` })
    })
    page.on('pageerror', (e) => msgs.push({ type: 'pageerror', text: e.message }))
    page.on('response', (r) => {
      if (r.status() >= 400) msgs.push({ type: 'http' + r.status(), text: `${r.status()} ${r.url()}` })
    })
    page.on('requestfailed', (r) => {
      msgs.push({ type: 'reqfail', text: `${r.failure()?.errorText ?? '?'} ${r.url()}` })
    })
    // Subframe responses are on a separate frame object — attach there too.
    page.context().on('response', (r) => {
      if (r.status() >= 400) msgs.push({ type: 'ctx-http' + r.status(), text: `${r.status()} ${r.url()}` })
    })
    // Hook fetch + XHR to capture URL of any 404 — browser network events
    // from workers and sub-requests sometimes don't surface via page.on.
    await page.addInitScript(() => {
      const origFetch = window.fetch
      window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
        const r = await origFetch.call(this, input as RequestInfo, init)
        if (!r.ok) {
          const url = typeof input === 'string' ? input : (input as URL).toString?.() ?? (input as Request).url
          console.warn(`[TEST-PROBE] fetch ${r.status} ${url}`)
        }
        return r
      }
    })
    await page.goto(`/demo.html?id=${id}&e2e=1`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 15_000 },
    )
    await page.waitForTimeout(800)
    const noise = /\[vite\]|powerPreference|DevTools|Slow network/
    const actionable = msgs.filter(m =>
      (m.type === 'error' || m.type === 'warning' || m.type === 'pageerror' || m.type.startsWith('http') || m.type === 'reqfail' || m.type === 'loadfail') &&
      !noise.test(m.text),
    )
    console.log(`\n=== ${id} (${actionable.length} actionable) ===`)
    for (const m of actionable) console.log(`  [${m.type}] ${m.text.slice(0, 200)}`)
  })
}
