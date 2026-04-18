// Attribute writeBuffer calls to their target GPU buffer by label.
// Runs the 3 fixtures that dominated the audit's writeBuffer ranking
// (filter_complex, stress_many_layers, translucent_stroke) through a
// short interaction and prints `{ label → { calls, bytes } }` so we
// can see exactly which buffers churn per frame.

import { test } from '@playwright/test'

const TARGETS = ['fixture_filter_complex', 'fixture_stress_many_layers', 'fixture_translucent_stroke'] as const

for (const id of TARGETS) {
  test(`writeBuffer attribution: ${id}`, async ({ page }) => {
    test.setTimeout(30_000)
    await page.setViewportSize({ width: 1200, height: 700 })

    // Install the hook BEFORE any page code runs so the first buffer
    // the runtime creates already goes through our label-tracking
    // createBuffer wrapper. Otherwise every pre-hook buffer bucket
    // labels its writes "(pre-hook)" and the attribution report is
    // dominated by that catch-all.
    await page.addInitScript(() => {
      const gpu = navigator.gpu
      if (!gpu) return
      const origReqDev = gpu.requestDevice
      const origReqAdapter = gpu.requestAdapter.bind(gpu)
      navigator.gpu.requestAdapter = async (...args: Parameters<GPU['requestAdapter']>) => {
        const adapter = await origReqAdapter(...args)
        if (!adapter) return adapter
        const origADev = adapter.requestDevice.bind(adapter)
        adapter.requestDevice = async (...a: Parameters<GPUAdapter['requestDevice']>) => {
          const device = await origADev(...a)
          const labelOf = new WeakMap<GPUBuffer, string>()
          const win = window as unknown as {
            __bufLabels?: WeakMap<GPUBuffer, string>
            __bufStats?: Map<string, { calls: number; bytes: number }>
          }
          win.__bufLabels = labelOf
          win.__bufStats = new Map()

          const origCreate = device.createBuffer.bind(device)
          device.createBuffer = (desc: GPUBufferDescriptor) => {
            const buf = origCreate(desc)
            labelOf.set(buf, desc.label ?? '(unlabeled)')
            return buf
          }

          const origWrite = device.queue.writeBuffer.bind(device.queue)
          device.queue.writeBuffer = ((buf, off, data, dOff, sz) => {
            const l = labelOf.get(buf) ?? '(pre-hook)'
            const entry = win.__bufStats!.get(l) ?? { calls: 0, bytes: 0 }
            entry.calls++
            entry.bytes += sz ?? (data as ArrayBufferView).byteLength ?? 0
            win.__bufStats!.set(l, entry)
            return origWrite(buf, off, data as BufferSource, dOff as number, sz as number)
          }) as typeof device.queue.writeBuffer

          return device
        }
        return adapter
      }
      void origReqDev
    })

    await page.goto(`/demo.html?id=${id}&e2e=1`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 15_000 },
    )
    await page.waitForTimeout(1500)

    // Reset counters after init-load churn so we measure just the
    // interactive window.
    await page.evaluate(() => {
      const win = window as unknown as { __bufStats?: Map<string, { calls: number; bytes: number }> }
      win.__bufStats?.clear()
    })

    const rawReport = await page.evaluate(async () => {
      const win = window as unknown as {
        __xgisMap?: { camera: { zoom: number; centerX: number } }
        __bufStats?: Map<string, { calls: number; bytes: number }>
      }
      await new Promise<void>((resolve) => {
        const R = 6378137
        const map = win.__xgisMap!
        const startX = map.camera.centerX
        const t0 = performance.now()
        function tick() {
          const t = performance.now() - t0
          map.camera.zoom = (t / 1200) * 4
          map.camera.centerX = startX + Math.sin(t / 200) * 20 * Math.PI / 180 * R
          if (t >= 1500) resolve()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })

      return [...(win.__bufStats!).entries()]
        .map(([label, v]) => ({ label, calls: v.calls, bytes: v.bytes }))
        .sort((a, b) => b.bytes - a.bytes)
    })

    console.log(`\n=== ${id} ===`)
    for (const r of rawReport) {
      console.log(`  ${String(r.calls).padStart(4)} calls  ${(r.bytes / 1024).toFixed(1).padStart(8)} KB  ${r.label}`)
    }
  })
}
