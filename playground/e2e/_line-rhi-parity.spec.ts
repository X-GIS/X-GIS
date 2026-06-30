import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-baseline__')

type W = { __xgisReady?: boolean }

// P1.5 — the SDF line draw is now UNCONDITIONALLY on the RHI Material seam (LineDraper /
// LineCompositeDraper). The raw GPURenderPipelines + the __xgisLineViaRhi opt-out flag are deleted;
// the RHI path was proven pixel-identical to the old raw path (DC=0) across opaque / translucent-MAX
// / composite / pick-MRT / bundle before the flip. This now smoke-tests that the line + composite
// render the all-renderers stress scene through the RHI seam without GPU/validation errors.
test('line RHI seam: stress scene renders error-free', async ({ page }) => {
  test.setTimeout(45_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  await page.setViewportSize({ width: 600, height: 600 })
  await page.goto('/demo.html?id=fixture_stress_all_renderers&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as W).__xgisReady === true, null, { timeout: 25_000 })
  await page.waitForTimeout(4000)
  writeFileSync(join(OUT, 'line-rhi-seam.png'), await page.locator('#map').screenshot())

  expect(errors.length).toBe(0)
})
