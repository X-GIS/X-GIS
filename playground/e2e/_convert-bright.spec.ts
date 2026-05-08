// End-to-end: convert OpenFreeMap "bright" Mapbox style → xgis →
// playground. Verifies (1) the converter output is editor-loadable,
// (2) the source compiles via the playground's runSource path, and
// (3) nothing fails silently — collects console.error + page errors
// and asserts the editor isn't empty and the compiler didn't bail.
//
// Note: the "bright" style points at an XYZ MVT URL
// (tiles.openfreemap.org/planet) which X-GIS doesn't render today
// (PMTiles archives only). We DO NOT assert pixels — we assert that
// the page reaches the post-compile state without a swallowed error.

import { test, expect } from '@playwright/test'
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { Lexer } from '../../compiler/src/lexer/lexer'
import { Parser } from '../../compiler/src/parser/parser'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(__dirname, '__convert-fixtures/bright.json'), 'utf8')

test.describe('Mapbox → xgis converter — end-to-end visibility', () => {
  test('OpenFreeMap bright: converts, parses, loads in playground without silent failure', async ({ page }) => {
    test.setTimeout(60_000)

    // ── Step 1: convert (host-side, mirrors what the /convert page does)
    const xgis = convertMapboxStyle(fixture)
    expect(xgis.length).toBeGreaterThan(2000)
    const layerCount = (xgis.match(/^layer /gm) ?? []).length
    expect(layerCount).toBeGreaterThan(50)

    // ── Step 2: parser sanity (we already test this in the converter
    //    suite, but re-check here so a regression is caught at the
    //    end-to-end boundary too).
    const tokens = new Lexer(xgis).tokenize()
    new Parser(tokens).parse()

    // ── Step 3: collect every error channel BEFORE navigation.
    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    const swallowedAlerts: string[] = []
    const allConsole: string[] = []
    page.on('console', m => {
      allConsole.push(`[${m.type()}] ${m.text()}`)
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    const tileJsonLogs: string[] = []
    page.on('console', m => {
      if (m.text().includes('TileJSON attached')) tileJsonLogs.push(m.text())
    })
    page.on('pageerror', e => {
      pageErrors.push(e.message)
    })
    // Some site code calls `window.alert(...)` in lieu of throwing —
    // capture those too so they don't slip past us.
    await page.addInitScript(() => {
      const orig = window.alert.bind(window)
      ;(window as unknown as { __alerts: string[] }).__alerts = []
      window.alert = (msg?: string) => {
        ;(window as unknown as { __alerts: string[] }).__alerts.push(String(msg))
        try { orig(msg) } catch { /* ignore */ }
      }
    })

    // ── Step 4: pre-stash the converted xgis the same way convert.astro
    //    does, then load the playground with ?id=__import.
    await page.addInitScript((src: string) => {
      try {
        sessionStorage.setItem('__xgisImportSource', src)
        sessionStorage.setItem('__xgisImportLabel', 'Bright (OpenFreeMap)')
      } catch { /* ignore */ }
    }, xgis)

    await page.goto('/demo.html?id=__import', { waitUntil: 'domcontentloaded' })

    // Wait for the engine to either reach __xgisReady (success) OR
    // surface an error overlay. Don't fail solely on missing tiles —
    // the bright source points at XYZ MVT which X-GIS can't fetch.
    await Promise.race([
      page.waitForFunction(
        () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
        null,
        { timeout: 30_000 },
      ),
      page.waitForSelector('#error', { state: 'visible', timeout: 30_000 }).catch(() => null),
    ])

    // Settle a moment so any deferred error has a chance to surface.
    await page.waitForTimeout(2_000)

    // ── Step 5: assert the import path was actually taken — the
    //    demo-runner sets the page title from the import label and
    //    swaps the tag chip to "imported" when sessionStorage hand-off
    //    succeeded. Falls through to loadDemo on miss, so these are
    //    sharp signals that the import flow ran.
    const title = await page.title()
    const tagText = await page.locator('#demo-tag').textContent()
    expect(title, 'title should reflect imported source').toContain('Bright (OpenFreeMap)')
    expect(tagText, 'tag chip should show "imported"').toBe('imported')
    // The Monaco editor mirrors its content into the DOM as `.view-line`s
    // — read those to confirm the source is on screen, not just internal.
    const monacoText = await page.locator('.monaco-editor .view-lines').first().innerText()
    expect(monacoText, 'monaco should render the converted source').toContain('landcover_glacier')
    expect(monacoText, 'monaco should reference the converter-emitted source name').toContain('openmaptiles')
    expect(monacoText.length, 'monaco should hold non-trivial content').toBeGreaterThan(50)

    // ── Step 6: surface every error channel.
    const errorBox = await page.locator('#error').isVisible()
    const errorMsg = errorBox ? await page.locator('#error-msg').textContent() : ''
    const alerts = await page.evaluate(
      () => (window as unknown as { __alerts?: string[] }).__alerts ?? [],
    )

    // Filter known-irrelevant noise: WebGPU adapter messages, network
    // failures for the openfreemap XYZ tiles (expected — no MVT
    // backend), favicon 404s, and DevTools deprecation noise.
    const ignorable = (s: string) =>
      /tiles\.openfreemap\.org|favicon|DevTools|Failed to fetch|net::ERR|Adapter|WebGPU adapter/i.test(s)
    const realConsoleErrors = consoleErrors.filter(s => !ignorable(s))
    const realPageErrors = pageErrors.filter(s => !ignorable(s))

    // Report everything, even ignorable, in test output for inspection.
    // eslint-disable-next-line no-console
    console.log('\n=== convert e2e summary ===')
    // eslint-disable-next-line no-console
    console.log('layers:', layerCount, 'monaco chars:', monacoText.length, 'title:', title)
    // eslint-disable-next-line no-console
    console.log('console.error (filtered):', realConsoleErrors.length, '(raw):', consoleErrors.length)
    if (realConsoleErrors.length > 0) {
      // eslint-disable-next-line no-console
      console.log(realConsoleErrors.slice(0, 5).join('\n---\n'))
    }
    if (consoleErrors.length > 0) {
      // eslint-disable-next-line no-console
      console.log('--- raw console.error dump ---')
      // eslint-disable-next-line no-console
      console.log(consoleErrors.join('\n---\n'))
    }
    if (process.env.DEBUG_E2E) {
      // eslint-disable-next-line no-console
      console.log('--- all console (last 15) ---')
      // eslint-disable-next-line no-console
      console.log(allConsole.slice(-15).join('\n'))
    }
    // eslint-disable-next-line no-console
    console.log('TileJSON attaches:', tileJsonLogs.length)
    // eslint-disable-next-line no-console
    console.log('pageerror (filtered):', realPageErrors.length, '(raw):', pageErrors.length)
    if (realPageErrors.length > 0) {
      // eslint-disable-next-line no-console
      console.log(realPageErrors.slice(0, 5).join('\n---\n'))
    }
    // eslint-disable-next-line no-console
    console.log('alerts:', alerts.length, alerts.slice(0, 3))
    // eslint-disable-next-line no-console
    console.log('error overlay visible:', errorBox, errorMsg ? `\n  ${errorMsg.slice(0, 200)}` : '')

    // The compiler / load step itself must not produce a real error.
    // Tile-fetch failures for openfreemap go through ignorable filter.
    expect(realConsoleErrors, 'compile / runtime errors should be empty').toEqual([])
    expect(realPageErrors, 'unhandled page exceptions should be empty').toEqual([])
    expect(alerts, 'silent alerts should not happen').toEqual([])
    expect(errorBox, 'error overlay should not surface').toBe(false)
    // The vector source has type=tilejson and should attach via the
    // TileJSON dispatch path. Without `kind:'tilejson'` plumbed
    // through, attachPMTilesSource fell back to PMTiles archive
    // header parsing and emitted "PMTiles attach failed" — silent
    // because no exception bubbled but also no tiles ever rendered.
    // Asserting the success log catches that regression.
    expect(tileJsonLogs.length, 'TileJSON should attach successfully').toBeGreaterThan(0)
    expect(tileJsonLogs[0], 'TileJSON log should mention vector_layers').toContain('layers:')

    // Save a screenshot so we can eyeball the result regardless of
    // whether it's pixels or just a clear viewport (the converted
    // source's tile URL points at an XYZ MVT, which won't render).
    await page.screenshot({ path: 'test-results/convert-bright.png' })
  })
})
