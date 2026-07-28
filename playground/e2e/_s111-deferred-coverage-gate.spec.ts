// ═══ A coverage source must NOT hold the first frame (#1426) ═══
//
// The bug, stated as an ordering: a `type: coverage` source's cell was read INSIDE run()'s
// load barrier, and the barrier sits in front of `rebuildLayers` + the first `renderLoop()`.
// So on the live NOAA demos the whole map — the satellite basemap under the currents
// included — was black until ~12 MB of S-111 HDF5 had streamed, and a cell that could not be
// reached at all rethrew out of the barrier and aborted the mount, which is the opposite of
// the imagery-only fallback those demos document.
//
// The gate is therefore an ORDER, not a picture: with the cell's bytes held on the wire, the
// map must already be running, its basemap layer armed, and its raster pass out FETCHING
// TILES — a request that can only be issued from inside a rendered frame, which is the
// offline-checkable form of "something was on screen before the cell landed". (This harness
// has no outbound network, so the basemap's own pixels can never arrive here; asserting the
// request rather than the pixel is what keeps the gate honest instead of environmental.)
//
// Release the bytes and the field must then arm ITSELF: the deferred arm re-derives the
// `| arrow` portrayal from the layer's own ShowCommand, and the compiled-arrow batch it
// produces is the engine fork's own product — so a passing run proves the LATE arm is wired,
// not merely that nothing threw.
//
// Runs on the synthetic offline demo (`s111_currents`, a committed local .h5) so the timing
// is ours to control and no NOAA egress is needed; the live demos differ only in the size of
// the payload this spec deliberately stalls. WebGL2 is asserted so a silent backend fallback
// cannot green it (CLAUDE.md §5).

import { test, expect } from '@playwright/test'

/** State + frame, read off the live map. Stashes the frame under `key`; when `prev` names an
 *  earlier stash, also reports the fraction of pixels that CHANGED between the two.
 *
 *  A changed-pixel fraction, not a bigger painted fraction: where the basemap tiles actually
 *  arrive (CI has egress, this sandbox does not) the satellite imagery covers the frame
 *  completely, `painted` saturates at 1.0, and "more pixels are painted after" becomes
 *  unsatisfiable by construction — 1 > 1 is false. That is exactly the count-gate trap §12
 *  warns about, and it cost this spec a red CI run. A directional diff cannot saturate. */
function probe(arg: { key: string; prev?: string }) {
  const w = window as unknown as {
    __frames?: Record<string, Uint8Array>
    __xgisMap?: {
      running?: boolean
      ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } }
      graphics?: { hasRetainedBatches(): boolean }
      rasterRenderer?: { hasSource(): boolean }
      getCoverage(id: string): unknown
    }
  }
  const m = w.__xgisMap
  const gl = m?.ctx?.rhi?.gl
  if (!gl) return { ok: false as const, reason: 'no gl' }
  const W = gl.drawingBufferWidth
  const H = gl.drawingBufferHeight
  const buf = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  let painted = 0
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i]! > 24 || buf[i + 1]! > 24 || buf[i + 2]! > 24) painted++
  }
  w.__frames ??= {}
  const before = arg.prev ? w.__frames[arg.prev] : undefined
  let changed = -1
  if (before && before.length === buf.length) {
    changed = 0
    for (let i = 0; i < buf.length; i += 4) {
      if (
        Math.abs(buf[i]! - before[i]!) > 8 ||
        Math.abs(buf[i + 1]! - before[i + 1]!) > 8 ||
        Math.abs(buf[i + 2]! - before[i + 2]!) > 8
      )
        changed++
    }
  }
  w.__frames[arg.key] = buf
  return {
    ok: true as const,
    backend: m?.ctx?.rhi?.backend,
    running: m?.running === true,
    basemapArmed: m?.rasterRenderer?.hasSource() === true,
    coverage: m?.getCoverage('currents') != null,
    batches: m?.graphics?.hasRetainedBatches() === true,
    painted: painted / (W * H),
    changed: changed < 0 ? -1 : changed / (W * H),
  }
}

test.describe('deferred coverage attach (#1426)', () => {
  test('the map runs and draws BEFORE the coverage cell lands', async ({ page }) => {
    test.setTimeout(120_000)

    // Hold the coverage cell on the wire until this spec lets it go. Everything else —
    // basemap tiles, the style, the shaders — is untouched, so whatever the map manages to
    // do in the meantime is exactly what the deferral bought.
    let release: () => void = () => {}
    const held = new Promise<void>((r) => (release = r))
    let cellRequested = false
    await page.route('**/synthetic-currents.h5*', async (route) => {
      cellRequested = true
      await held
      await route.continue()
    })

    // Every basemap tile the raster pass asks for. Counted from the REQUEST, so the count is
    // unaffected by whether the response can arrive in this sandbox.
    let basemapRequests = 0
    page.on('request', (r) => {
      if (r.url().includes('World_Imagery/MapServer/tile/')) basemapRequests++
    })

    await page.setViewportSize({ width: 900, height: 700 })
    await page.goto('/demo.html?id=s111_currents&forcegl2=1&e2e=1#8/38.1/-76.2', {
      waitUntil: 'domcontentloaded',
    })

    // FAIL-BEFORE: with the read inside the load barrier, run() never resolved while the
    // cell was held, so `__xgisReady` never flipped and this timed out.
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      { timeout: 20_000 },
    )
    // Let the render loop actually tick a few frames with the cell still held.
    await page.waitForTimeout(2000)

    const during = await page.evaluate(probe, { key: 'during' })
    expect(cellRequested, 'the cell WAS requested — the deferral is a delay, not a skip').toBe(true)
    expect(during.ok, during.ok ? '' : during.reason).toBe(true)
    if (!during.ok) return
    // Assert the real backend, or a silent fallback could green the whole spec.
    expect(during.backend).toBe('webgl2')
    // The ordering this whole issue is about.
    expect(during.coverage, 'the cell is still on the wire').toBe(false)
    expect(during.running, 'the render loop is running WITHOUT the cell').toBe(true)
    expect(during.basemapArmed, 'the basemap layer is live without the coverage').toBe(true)
    // …and frames have actually EXECUTED: the raster pass requests its tiles from inside
    // `renderFrame`, so a request is proof the loop drew, not merely that a flag was set.
    // Before the fix the loop had not started at all — zero requests, blank canvas.
    expect(basemapRequests, 'basemap tiles fetched while the cell was outstanding').toBeGreaterThan(
      0,
    )
    // The coverage layer has drawn NOTHING yet: the compiled-arrow batch is produced only by
    // the `| arrow` fork on a resident coverage, so its absence here and presence below is the
    // saturation-proof before/after — true whether or not the basemap's own pixels arrive.
    expect(during.batches, 'no arrow field before the cell lands').toBe(false)

    // Now let the cell through. The deferred arm must re-derive the `| arrow` field from the
    // layer's own show.
    release()
    await page.waitForFunction(
      () =>
        (
          window as unknown as { __xgisMap?: { getCoverage(id: string): unknown } }
        ).__xgisMap?.getCoverage('currents') != null,
      { timeout: 30_000 },
    )
    await page.waitForTimeout(1500)

    const after = await page.evaluate(probe, { key: 'after', prev: 'during' })
    expect(after.ok).toBe(true)
    if (!after.ok) return
    console.log(
      `[deferred-coverage] during painted=${during.painted.toFixed(4)} batches=${during.batches}` +
        ` | after painted=${after.painted.toFixed(4)} batches=${after.batches}` +
        ` changed=${after.changed.toFixed(4)}`,
    )
    expect(after.coverage).toBe(true)
    expect(after.batches, 'the engine `| arrow` field armed on the LATE handle').toBe(true)
    expect(after.painted, 'the late-armed field rasterises').toBeGreaterThan(0.01)
    // And the frame MOVED. Directional, so it cannot saturate the way a painted-fraction does.
    // Honest about what it proves: pixels changed after the cell landed — paired with the
    // arrow batch appearing (above), which only the coverage `| arrow` fork can create. The
    // diff alone is not attributed purely to arrows; late basemap tiles also change pixels.
    expect(after.changed, 'the frame changed once the cell landed').toBeGreaterThan(0.002)
  })
})
