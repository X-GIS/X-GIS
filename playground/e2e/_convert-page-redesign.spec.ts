// Visual + smoke check for the redesigned /convert page. Astro
// builds the page into site/dist; we serve it via a tiny static
// server in the test (Playwright's dev-server config points at
// the playground only). Captures one screenshot and asserts the
// preset chip click triggers the conversion path that pre-fills
// the output area.

import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

function staticServer(root: string) {
  return createServer((req, res) => {
    let urlPath = (req.url ?? '/').split('?')[0]
    if (urlPath.endsWith('/')) urlPath += 'index.html'
    const filePath = join(root, urlPath)
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.statusCode = 404; res.end('not found'); return
    }
    const types: Record<string, string> = {
      '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
      '.svg': 'image/svg+xml', '.json': 'application/json',
    }
    res.setHeader('Content-Type', types[extname(filePath)] ?? 'application/octet-stream')
    res.end(readFileSync(filePath))
  })
}

test('convert page redesign: preset chips visible + clickable', async ({ page }) => {
  test.setTimeout(60_000)
  const root = join(process.cwd(), '..', 'site', 'dist')
  if (!existsSync(join(root, 'convert', 'index.html'))) {
    test.skip(true, 'site/dist/convert not built — run `bun run build` in site first')
  }
  const server = staticServer(root)
  await new Promise<void>(r => server.listen(0, () => r()))
  const port = (server.address() as { port: number }).port

  try {
    await page.goto(`http://localhost:${port}/convert/`)
    const chips = page.locator('.preset-chip')
    await expect(chips).toHaveCount(3)
    await expect(chips.first()).toContainText('Liberty')
    await expect(page.locator('h2', { hasText: 'compatibility' })).toBeVisible()
    await page.screenshot({ path: 'test-results/convert-redesign.png', fullPage: true })

    // Homepage check — Mapbox CTA button visible, Why pillars
    // updated to mention `interpolate(zoom, …)`.
    await page.goto(`http://localhost:${port}/`)
    // Element exists in DOM even if hero-fade-up animation hasn't fired.
    await expect(page.locator('a', { hasText: 'Convert from Mapbox' })).toHaveCount(1)
    await expect(page.locator('text=interpolate(zoom')).toHaveCount(1)
    await page.screenshot({ path: 'test-results/site-home.png', fullPage: true })

    // ── New docs pages exist + searchable ──
    // Use a 1440-wide viewport so the xl-only OnThisPage TOC renders
    // and the screenshot reflects the desktop layout.
    await page.setViewportSize({ width: 1440, height: 900 })
    for (const slug of ['quickstart', 'cookbook', 'mapbox', 'functions', 'expressions', 'sources']) {
      await page.goto(`http://localhost:${port}/docs/${slug}/`)
      await expect(page.locator('h1').first()).toBeVisible()
      await page.screenshot({ path: `test-results/docs-${slug}.png`, fullPage: true })
    }
    // OnThisPage TOC + prev/next nav exist on functions page.
    const tocLabel = page.locator('text=On this page')
    await expect(tocLabel).toHaveCount(1)
    const prevNext = page.locator('text=Edit this page on GitHub')
    await expect(prevNext).toHaveCount(1)

    // ── Mobile hamburger drawer screenshot ──
    await page.setViewportSize({ width: 390, height: 844 })  // iPhone 14
    await page.goto(`http://localhost:${port}/docs/cookbook/`)
    await page.screenshot({ path: 'test-results/mobile-docs-cookbook.png', fullPage: false })
    // Open the hamburger drawer.
    await page.locator('#mobile-nav-toggle').click()
    await page.waitForTimeout(400) // let the slide-in finish
    await page.screenshot({ path: 'test-results/mobile-nav-open.png', fullPage: false })
    // The drawer must cover the full viewport (it used to get clipped
    // to the header's bounding box because backdrop-filter created a
    // containing block — see MobileNavDrawer.astro). Spot-check by
    // asserting a deep nav link from the LAST group is visible at
    // the bottom of the drawer.
    await expect(page.locator('#mobile-nav-drawer a', { hasText: 'XGVT spec' })).toBeVisible()
    // And the drawer's documentation group includes the new pages.
    await expect(page.locator('#mobile-nav-drawer a', { hasText: 'Cookbook' })).toBeVisible()
    await expect(page.locator('#mobile-nav-drawer a', { hasText: 'Mapbox migration' })).toBeVisible()

    // Pipeline concept page renders the SVG diagram inline.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`http://localhost:${port}/docs/concepts/pipeline/`)
    const diagram = page.locator('article svg[role="img"]')
    await expect(diagram).toBeVisible()
    await page.screenshot({ path: 'test-results/docs-pipeline.png', fullPage: true })

    // Projections concept page also has an SVG diagram.
    await page.goto(`http://localhost:${port}/docs/concepts/projections/`)
    await expect(page.locator('article svg[role="img"]')).toBeVisible()
    await page.screenshot({ path: 'test-results/docs-projections.png', fullPage: true })

    // API page now has H3 anchors per entry — OnThisPage TOC must
    // surface a deep link (e.g. "XGISMap.run") so a Cmd-K search for
    // it lands on the entry, not the page top.
    await page.goto(`http://localhost:${port}/docs/api/`)
    await expect(page.locator('h3#xgismap-run')).toHaveCount(1)
    await expect(page.locator('aside nav a', { hasText: 'XGISMap.run' })).toBeVisible()
    await page.screenshot({ path: 'test-results/docs-api.png', fullPage: true })

    // Search index covers the new pages.
    await page.goto(`http://localhost:${port}/docs/functions/`)
    const indexJson = await page.locator('#search-index').textContent()
    expect(indexJson, 'search index must include functions page').toContain('Function reference')
    expect(indexJson, 'search index must include expressions page').toContain('Expressions & operators')
    expect(indexJson, 'search index must include sources page').toContain('Source types')

    // Sidebar Language group lists the new pages.
    const sidebarText = await page.locator('aside nav').first().innerText()
    expect(sidebarText).toContain('Functions')
    expect(sidebarText).toContain('Expressions')
    expect(sidebarText).toContain('Sources')
  } finally {
    server.close()
  }
})
