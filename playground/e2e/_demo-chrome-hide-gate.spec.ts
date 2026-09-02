// ═══ hideDemoChrome must survive chrome that re-shows itself (#2284) ═══
//
// The playground's in-page error console (`#log-overlay`, demo-runner.ts)
// rewrites its own inline `display` on every console.warn / console.error:
// `repaint()` sets `flex` whenever it holds an entry. `hideDemoChrome` used
// to hide chrome with an inline `display:none`, which that write replaced —
// so a warning landing AFTER the hide (the DEV owner-leak detector, #2266,
// under `__XGIS_INVARIANTS`) re-showed the overlay between two captures of
// `_rtc-recombine-parity-gate`, and the gate hashed the overlay's text
// instead of the canvas (#2284: OFF↔ON diff 12962 px on a 288×55 clip).
//
// This gate exercises that exact mechanism, both halves separately (§12:
// cut the mechanism, and prove the assertion can see it):
//   control — un-hidden, a warning DOES show the overlay, so a `none` later
//             is the hide working, not an overlay that never appears;
//   cut     — after the hide, a warning is still RECORDED and still rewrites
//             the inline display to `flex` (the self-un-hide fired), and the
//             computed display stays `none` (the hide outranked it).

import { test, expect, type Page } from '@playwright/test'
import { hideDemoChrome } from './helpers/visual'

const overlayState = async (page: Page) =>
  await page.evaluate(() => {
    const el = document.getElementById('log-overlay')
    if (!el) throw new Error('#log-overlay missing — demo-runner did not build the overlay')
    return {
      inline: el.style.display,
      computed: getComputedStyle(el).display,
      count: Number(document.getElementById('log-count')?.textContent ?? NaN),
    }
  })

test('#2284 — hideDemoChrome outranks the log overlay re-showing itself on console.warn', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.goto('/demo.html?id=minimal&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 90_000 },
  )
  // Entries the demo may already have logged during boot (a glyph-range
  // fallback, say) — assert on DELTAS so the gate does not depend on them.
  const boot = await overlayState(page)
  expect(Number.isNaN(boot.count)).toBe(false)

  // Control: un-hidden, a warning shows the overlay.
  await page.evaluate(() => console.warn('[chrome-hide-gate] control warn'))
  const shown = await overlayState(page)
  expect(shown).toEqual({ inline: 'flex', computed: 'flex', count: boot.count + 1 })

  await hideDemoChrome(page)
  expect((await overlayState(page)).computed).toBe('none')

  // Cut: the self-un-hide fires (entry recorded, inline display rewritten to
  // flex) and still loses to the hide.
  await page.evaluate(() => console.warn('[chrome-hide-gate] post-hide warn'))
  const afterHide = await overlayState(page)
  expect(afterHide).toEqual({ inline: 'flex', computed: 'none', count: boot.count + 2 })
})
