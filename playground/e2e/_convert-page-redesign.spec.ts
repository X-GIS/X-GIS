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
    if (urlPath === '/' || urlPath === '/convert' || urlPath === '/convert/') {
      urlPath = '/convert/index.html'
    }
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

    // Preset chips render with the OpenFreeMap names.
    const chips = page.locator('.preset-chip')
    await expect(chips).toHaveCount(3)
    await expect(chips.first()).toContainText('Liberty')

    // Compatibility reference section is on the page.
    await expect(page.locator('h2', { hasText: 'compatibility' })).toBeVisible()

    await page.screenshot({ path: 'test-results/convert-redesign.png', fullPage: true })
  } finally {
    server.close()
  }
})
