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
    const tileFetches: { url: string; status: number; ok: boolean }[] = []
    page.on('response', async resp => {
      const url = resp.url()
      if (/openfreemap\.org\/.*\.pbf|openfreemap\.org\/.*\.png/i.test(url)) {
        tileFetches.push({ url, status: resp.status(), ok: resp.ok() })
      }
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

    // Navigate to Tokyo z=14 — dense feature area, every layer type
    // has data here (water, roads, buildings, landuse, …). At z=0.5
    // / center 0,0 the default view is mid-ocean and the absence of
    // features is ambiguous (no data vs broken pipeline). z=14 over
    // a major city makes "no features rendered" sharp.
    await page.goto('/demo.html?id=__import#14/35.68/139.76', { waitUntil: 'domcontentloaded' })

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

    // Settle long enough for visible tiles to be requested + rendered
    // (or fail). Background fetches keep going for several seconds.
    await page.waitForTimeout(8_000)

    // Sample the canvas — non-zero pixels means SOMETHING rendered.
    const pixelStats = await page.evaluate(() => {
      const canvas = document.getElementById('map') as HTMLCanvasElement | null
      if (!canvas) return null
      // Read via a 2D scratch canvas — WebGPU canvas can't getImageData
      // directly. drawImage onto a Canvas2D throws if the source has
      // alpha set wrong, so wrap in try.
      try {
        const scratch = document.createElement('canvas')
        scratch.width = 64
        scratch.height = 64
        const ctx = scratch.getContext('2d')
        if (!ctx) return { error: 'no 2d ctx' }
        ctx.drawImage(canvas, 0, 0, 64, 64)
        const data = ctx.getImageData(0, 0, 64, 64).data
        let nonBg = 0
        let uniqueColors = new Set<number>()
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2]
          uniqueColors.add((r << 16) | (g << 8) | b)
          // The bright background is #f8f4f0 — count anything else as
          // foreground. Tolerate small DPR/resampling drift.
          const isBg = Math.abs(r - 0xf8) < 6 && Math.abs(g - 0xf4) < 6 && Math.abs(b - 0xf0) < 6
          if (!isBg) nonBg++
        }
        const sample = data.slice(0, 16)
        return {
          nonBgPixels: nonBg,
          uniqueColors: uniqueColors.size,
          total: 64 * 64,
          sampleColor: `#${[data[0], data[1], data[2]].map(x => x.toString(16).padStart(2, '0')).join('')}`,
          sample: Array.from(sample),
        }
      } catch (e) {
        return { error: (e as Error).message }
      }
    })

    // Also probe what the renderer thinks it's drawing.
    const tileStats = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      const map = w.__xgisMap as Record<string, unknown> | undefined
      const status = document.getElementById('status')?.textContent
      // Inspect all keys on the map for diagnostic helpers.
      const mapKeys = map ? Object.keys(map).slice(0, 30) : []
      const vtSources = map?.vtSources as Map<string, unknown> | undefined
      const vtKeys = vtSources instanceof Map ? [...vtSources.keys()] : null
      // Try reading the inspector if it's set up.
      const inspector = w.__xgisInspector as { lastFrame?: unknown } | undefined
      return {
        status,
        mapKeys,
        vtKeys,
        inspectorLast: inspector?.lastFrame,
      }
    })

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
    console.log('pixel sample:', JSON.stringify(pixelStats))
    // eslint-disable-next-line no-console
    console.log('tile stats:', JSON.stringify(tileStats))
    // eslint-disable-next-line no-console
    console.log('pbf/png fetches:', tileFetches.length)
    for (const f of tileFetches.slice(0, 6)) {
      // eslint-disable-next-line no-console
      console.log(`  ${f.status} ${f.ok ? 'OK ' : 'BAD'} ${f.url}`)
    }
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
    await page.locator('#map').screenshot({ path: 'test-results/convert-bright-map.png' })
  })
})
