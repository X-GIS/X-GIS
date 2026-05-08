// One-shot: dump adapter.features + adapter.limits so we know what
// WebGPU extensions are available on the test rig before deciding
// which ones to wire into the engine.

import { test } from '@playwright/test'
import { writeFileSync } from 'node:fs'

test.describe('GPU adapter capability dump', () => {
  test('list features + key limits', async ({ page }) => {
    test.setTimeout(30_000)
    await page.goto('/demo.html?id=multi_layer&e2e=1', { waitUntil: 'domcontentloaded' })

    const info = await page.evaluate(async () => {
      if (!navigator.gpu) return { error: 'no navigator.gpu' }
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
        ?? await navigator.gpu.requestAdapter()
      if (!adapter) return { error: 'no adapter' }
      const features: string[] = []
      for (const f of adapter.features) features.push(f)
      const lim = adapter.limits
      const limits: Record<string, number> = {}
      for (const k of Object.keys(Object.getPrototypeOf(lim))) {
        const v = (lim as unknown as Record<string, number>)[k]
        if (typeof v === 'number') limits[k] = v
      }
      const adapterInfo = await adapter.requestAdapterInfo?.().catch(() => null)
      return { features: features.sort(), limits, adapterInfo }
    })

    writeFileSync('gpu-features.json', JSON.stringify(info, null, 2))
    console.log('GPU_FEATURES:', JSON.stringify(info.features, null, 2))
    console.log('GPU_ADAPTER:', JSON.stringify(info.adapterInfo, null, 2))
  })
})
