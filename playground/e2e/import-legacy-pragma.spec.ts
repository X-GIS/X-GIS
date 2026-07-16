// Gate: legacy hand-off sources WITHOUT the `xgis 1` version pragma still run.
//
// The mandatory version pragma (#1064/#1115, 2026-07-14) makes the parser
// hard-error (X-GIS0008) on pragma-less sources. Any style converted or
// stored BEFORE that date — sessionStorage `__xgisImportSource`, `#src=`
// bookmarks, a surviving editor buffer — died at ?id=__import with a cryptic
// ParseError (user report 2026-07-16). The playground intake now migrates
// such sources by prepending `xgis 1` (demo-runner.ts ensureVersionPragma);
// the LIBRARY parser stays strict by design.
//
// Fail-before: without the shim, this spec's __import boot shows the error
// overlay with X-GIS0008 and never reaches __xgisReady.

import { test, expect } from '@playwright/test'

// The minimal demo's source with its pragma stripped — a faithful stand-in
// for a pre-2026-07-14 converter output (those never used pruned constructs).
const LEGACY_SOURCE = `/* legacy: converted before the version pragma existed */
source world {
  type: geojson
  url: "ne_110m_countries.geojson"
}

layer countries {
  source: world
  | fill-stone-200 stroke-stone-400 stroke-1
}
`

test('legacy pragma-less __import source still mounts (migration shim)', async ({ page }) => {
  test.setTimeout(90_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text().slice(0, 300)}`)
  })

  await page.addInitScript((src) => {
    sessionStorage.setItem('__xgisImportSource', src)
    sessionStorage.setItem('__xgisImportLabel', 'Legacy import')
  }, LEGACY_SOURCE)

  await page.goto('/demo.html?id=__import', { waitUntil: 'domcontentloaded' })
  const ready = await page
    .waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true, {
      timeout: 45_000,
    })
    .then(() => true)
    .catch(() => false)

  const overlayMsg = await page.evaluate(
    () => document.getElementById('error-msg')?.textContent?.slice(0, 200) ?? '',
  )
  const parseErrors = errors.filter((e) => /X-GIS0008|ParseError/i.test(e))
  console.log(
    `[legacy-pragma] ready=${ready} overlay="${overlayMsg}" parseErrors=${parseErrors.length}`,
  )
  for (const e of parseErrors.slice(0, 3)) console.log('   ' + e)

  expect(ready, 'legacy pragma-less import must still reach __xgisReady').toBe(true)
  expect(parseErrors, 'no X-GIS0008 ParseError for a migrated legacy source').toEqual([])
})
