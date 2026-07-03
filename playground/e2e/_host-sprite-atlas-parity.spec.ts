import { test, expect } from '@playwright/test'

// ═══ #797 Phase 0 — host sprite atlas real-GPU texel gate ═══
//
// The CPU gates (host-image-registry.test.ts / host-sprite-atlas-gpu.test.ts)
// prove the shelf allocator, UV math, and which-upload-branch analytically. The
// ONLY genuinely GPU-dependent new code is the region upload itself
// (queue.writeTexture / copyExternalImageToTexture into the fixed page at an
// origin). This spec drives the ACTUAL HostSpriteAtlasGPU on the real map device
// — map.addImage → hostAtlas().get() (triggers sync → region upload) →
// ensure() (the page texture) → copyTextureToBuffer readback — and asserts the
// packed texels are BYTE-IDENTICAL to the source ImageData. ImageData is
// straight (un-premultiplied) RGBA and the page is rgba8unorm, so the upload is
// a byte copy: DC=0 is exact, not tolerance-bounded (hardware AND SwiftShader).
//
// This is the "a registered sprite renders DC=0" gate's load-bearing half: the
// icon PIPELINE is unchanged (zero renderer changes — proven) and already
// covered (_icon-rhi-parity + the URL icon suites), so correct atlas texels +
// an unchanged pipeline ⇒ host icons render. Objective (exact bytes), so it
// needs no §5 visual read and is SwiftShader-safe for CI.

interface Probe {
  name: string
  w: number
  h: number
  /** Deterministic RGBA pattern the readback must reproduce byte-for-byte. */
  bytes: number[]
}

function makeProbe(name: string, w: number, h: number, seed: number): Probe {
  const bytes: number[] = []
  for (let i = 0; i < w * h; i++) {
    bytes.push((i * 3 + seed) & 0xff) // R
    bytes.push((i * 7 + seed) & 0xff) // G
    bytes.push((i * 13 + seed) & 0xff) // B
    bytes.push(255) // A (opaque — avoids any premultiply ambiguity)
  }
  return { name, w, h, bytes }
}

test.describe('#797 P0 host sprite atlas — real-GPU texel parity', () => {
  test('addImage region-uploads byte-identical texels into the packed page', async ({ page }) => {
    test.setTimeout(60_000)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 25_000 },
    )

    // Two probes of different sizes so the shelf allocator packs them at
    // distinct, non-overlapping origins and both round-trip.
    const probes = [makeProbe('probeA', 8, 8, 0x11), makeProbe('probeB', 12, 6, 0x53)]

    const result = await page.evaluate(async (probes: Probe[]) => {
      const w = window as unknown as {
        __xgisMap?: {
          addImage(name: string, image: ImageData): void
          graphics: {
            hostAtlas(): {
              get(name: string): { x: number; y: number; width: number; height: number } | undefined
              ensure(): GPUTexture
            } | null
          }
          ctx?: { device: GPUDevice }
        }
      }
      const map = w.__xgisMap
      if (!map) return { error: 'no __xgisMap' as const }
      const device = map.ctx?.device
      if (!device) return { error: 'no map device (ctx.device)' as const }

      // Register the probes as host images (straight RGBA ImageData).
      for (const p of probes) {
        const img = new ImageData(new Uint8ClampedArray(p.bytes), p.w, p.h)
        map.addImage(p.name, img)
      }
      const atlas = map.graphics.hostAtlas()
      if (!atlas) return { error: 'no host atlas — attachDevice() not called on run()' as const }

      const out: Array<{
        name: string
        info: { x: number; y: number; width: number; height: number }
        readback: number[]
      }> = []
      for (const p of probes) {
        // get() triggers a dirty-gated sync() → region upload into the page.
        const info = atlas.get(p.name)
        if (!info) return { error: `atlas.get('${p.name}') returned undefined` as const }
        const tex = atlas.ensure()

        // copyTextureToBuffer requires bytesPerRow a multiple of 256.
        const unpadded = p.w * 4
        const bytesPerRow = Math.ceil(unpadded / 256) * 256
        const readBuf = device.createBuffer({
          size: bytesPerRow * p.h,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        const enc = device.createCommandEncoder()
        enc.copyTextureToBuffer(
          { texture: tex, origin: { x: info.x, y: info.y, z: 0 } },
          { buffer: readBuf, bytesPerRow, rowsPerImage: p.h },
          { width: p.w, height: p.h },
        )
        device.queue.submit([enc.finish()])
        await readBuf.mapAsync(GPUMapMode.READ)
        const mapped = new Uint8Array(readBuf.getMappedRange().slice(0))
        // De-pad each row back to a tight w*4 stride.
        const tight: number[] = []
        for (let r = 0; r < p.h; r++) {
          const base = r * bytesPerRow
          for (let c = 0; c < unpadded; c++) tight.push(mapped[base + c])
        }
        readBuf.unmap()
        out.push({ name: p.name, info, readback: tight })
      }
      return { out }
    }, probes)

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
    expect(result, `evaluate failed: ${'error' in result ? result.error : ''}`).not.toHaveProperty(
      'error',
    )
    if ('error' in result) return

    // Byte-exact texel parity + non-overlapping shelf placement.
    const boxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = []
    for (const p of probes) {
      const r = result.out.find((o) => o.name === p.name)
      expect(r, `no readback for ${p.name}`).toBeTruthy()
      if (!r) continue
      expect(r.info.width, `${p.name} width`).toBe(p.w)
      expect(r.info.height, `${p.name} height`).toBe(p.h)
      expect(
        r.readback.length,
        `${p.name} readback length ${r.readback.length} vs ${p.bytes.length}`,
      ).toBe(p.bytes.length)
      // The load-bearing assertion: every uploaded texel byte round-trips.
      let firstMismatch = -1
      for (let i = 0; i < p.bytes.length; i++) {
        if (r.readback[i] !== p.bytes[i]) {
          firstMismatch = i
          break
        }
      }
      expect(
        firstMismatch,
        `${p.name} texel mismatch at byte ${firstMismatch}: got ${r.readback[firstMismatch]} want ${p.bytes[firstMismatch]}`,
      ).toBe(-1)
      boxes.push({ x0: r.info.x, y0: r.info.y, x1: r.info.x + p.w, y1: r.info.y + p.h })
    }
    // Prove the two probes did not overlap on the page (shelf allocator on GPU).
    if (boxes.length === 2) {
      const [a, b] = boxes
      const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
      expect(overlap, `probes overlap: ${JSON.stringify(boxes)}`).toBe(false)
    }
  })
})
