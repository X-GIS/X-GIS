// #1190 — measure BEFORE building: (dis)prove the per-frame draw-encode wall.
//
// The issue's cost model says draw submission is O(layers × tiles × copies),
// re-encoded every navigating frame, and infers "encode crosses 16 ms at 4-8×
// OFM complexity" — explicitly flagged UNMEASURED. This sweep measures the
// SCALING SHAPE: a synthetic style with N unfiltered fill layers (each a
// DISTINCT constant colour — merge-layers only merges filtered same-field
// groups, and an unfiltered member never merges, so N layers stay N shows)
// over the LOCAL countries.geojson fixture (offline — the network-tile styles
// fail to fetch in the sandboxed harness and measure an empty draw list),
// same camera, same 6 s rotate sweep, reading the `frame.encode` perf phase
// (render-loop.ts) at each N.
//
// Each multiplier boots via the `#src=` URL-hash import channel — it takes
// precedence over sessionStorage and is per-navigation, so styles cannot leak
// across boots (measured: stacked sessionStorage addInitScripts left every
// boot on the first style). All boots reuse the test's own page: a
// browser.newPage() page never pumped rAF here (one rendered frame in 6 s).
//
// Root cause (previous run): full-frame country-polygon fills stacked N
// layers deep at 1280x800 x 4xMSAA cost the SwiftShader GPU process tens of
// seconds per frame, starving compositor BeginFrames (and with them rAF)
// nearly to a stop while page.evaluate tasks kept running. frame.encode is
// CPU-side and viewport-independent, so shrinking the pixel cost leaves the
// measured quantity intact. No assertions — a measurement harness, like its
// sibling _perf-bright-high-pitch-cpu.spec.ts.
//
// Run: cd playground && XGIS_SOFTWARE_GPU=1 \
//      ./node_modules/.bin/playwright test _perf-encode-scaling-sweep.spec.ts

import { test, type Page } from '@playwright/test'
// Relative deep import (charter): Playwright transpiles specs in raw Node — the
// @xgis/* workspace alias does not resolve here (see _glsl-compile-gate.spec.ts).
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'

// World view over Europe/Africa — countries.geojson polygons cover the frame,
// so every visible tile carries fill geometry for EVERY layer. Applied via
// setters post-ready: the `#src=` channel occupies the hash, and the converter
// deliberately does not carry Mapbox top-level camera state.
const CAM = { lon: 10, lat: 30, zoom: 3 }

interface Phase {
  name: string
  meanMs: number
  perFrameMs: number
  maxFrameMs: number
  samples: number
}

/** Synthetic Mapbox style: N unfiltered fill layers over the local fixture,
 *  each with a distinct constant colour. Distinct colours + no filters keep
 *  merge-layers out (its rules require a `.field == literal` filter chain);
 *  constant colours keep the shader-variant set deduped, so N varies DRAW
 *  count, not pipeline count. */
function syntheticStyle(nLayers: number): string {
  const layers: unknown[] = [
    { id: 'bg', type: 'background', paint: { 'background-color': '#101018' } },
  ]
  for (let i = 0; i < nLayers; i++) {
    layers.push({
      id: `fill_${i}`,
      type: 'fill',
      source: 'c',
      paint: {
        'fill-color': `rgb(${(i * 37) % 256},${(i * 91) % 256},${(i * 53) % 256})`,
      },
    })
  }
  const style = {
    version: 8,
    sources: { c: { type: 'geojson', data: '/data/countries.geojson' } },
    layers,
  }
  return convertMapboxStyle(JSON.stringify(style))
}

async function bootAt(page: Page, nLayers: number): Promise<number> {
  const xgis = syntheticStyle(nLayers)
  const b64 = Buffer.from(xgis, 'utf8').toString('base64')
  await page.goto(`/demo.html?id=__import&perfmarks=1&msaa=1&label=sweep${nLayers}#src=${b64}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 240_000 },
  )
  await page.evaluate((cam) => {
    const m = (
      window as unknown as {
        __xgisMap: {
          setCenter: (lon: number, lat: number) => void
          setZoom: (z: number) => void
          markCameraPositioned: () => void
          invalidate: () => void
        }
      }
    ).__xgisMap
    m.setCenter(cam.lon, cam.lat)
    m.setZoom(cam.zoom)
    m.markCameraPositioned()
    m.invalidate()
  }, CAM)
  // Settle the cold-start tile cascade so the sweep measures steady-state
  // navigation encode, not first paint / uploads.
  await page.waitForTimeout(6_000)
  return page.evaluate(
    () =>
      (
        window as unknown as { __xgisMap?: { getLayers?: () => unknown[] } }
      ).__xgisMap?.getLayers?.()?.length ?? -1,
  )
}

/** 8 s rotate sweep (bearing 0→360) — navigating frames without changing the
 *  visible tile set, isolating encode from fetch/upload. */
async function runSweep(page: Page, ms: number): Promise<number[]> {
  return page.evaluate(async (durationMs) => {
    interface M {
      getCamera: () => { bearing: number }
      invalidate: () => void
    }
    const map = (window as unknown as { __xgisMap?: M }).__xgisMap
    if (!map) throw new Error('__xgisMap not exposed')
    const phases = (
      window as unknown as {
        __xgisPerfPhases?: { setEnabled: (b: boolean) => void; resetPhaseTimings: () => void }
      }
    ).__xgisPerfPhases
    phases?.setEnabled(true)
    phases?.resetPhaseTimings()
    const cam = map.getCamera()
    const br0 = cam.bearing
    const frames: number[] = []
    return await new Promise<number[]>((resolveP) => {
      const start = performance.now()
      let last = start
      const tick = (): void => {
        const now = performance.now()
        frames.push(now - last)
        last = now
        const elapsed = now - start
        if (elapsed >= durationMs) {
          resolveP(frames)
          return
        }
        cam.bearing = br0 + (elapsed / durationMs) * 360
        map.invalidate()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, ms)
}

async function readPhases(page: Page): Promise<Phase[]> {
  return page.evaluate(() => {
    const api = (window as unknown as { __xgisPerfPhases?: { getPhaseAverages: () => Phase[] } })
      .__xgisPerfPhases
    return api?.getPhaseAverages() ?? []
  }) as Promise<Phase[]>
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

test('encode scaling sweep — frame.encode vs layer count (#1190)', async ({ page }) => {
  test.setTimeout(1_500_000)
  await page.setViewportSize({ width: 320, height: 240 })
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
  await page.addInitScript(() => {
    ;(window as unknown as { __xgisPerfMarks?: boolean }).__xgisPerfMarks = true
  })

  const rows: Array<{
    n: number
    layers: number
    encodeMean: number
    encodeWorst: number
    frameP50: number
    frameP95: number
  }> = []

  for (const n of [8, 32, 128]) {
    const layers = await bootAt(page, n)
    const frames = (await runSweep(page, 8000)).slice(2)
    const phases = await readPhases(page)
    const enc = phases.find((p) => p.name === 'frame.encode')
    rows.push({
      n,
      layers,
      encodeMean: enc?.perFrameMs ?? -1,
      encodeWorst: enc?.maxFrameMs ?? -1,
      frameP50: pct(frames, 50),
      frameP95: pct(frames, 95),
    })
    console.log(
      `[encode-sweep] n=${n}: layers=${layers} frame.encode mean=${rows.at(-1)!.encodeMean.toFixed(2)}ms worst=${rows.at(-1)!.encodeWorst.toFixed(1)}ms  frame p50=${rows.at(-1)!.frameP50.toFixed(1)} p95=${rows.at(-1)!.frameP95.toFixed(1)}`,
    )
  }

  console.log('\n=== #1190 encode scaling sweep (countries.geojson, 8s rotate, SwiftShader) ===')
  console.log('n | layers(actual) | frame.encode mean ms | worst ms | frame p50 | p95')
  for (const r of rows) {
    console.log(
      `  ${r.n} | ${r.layers} | ${r.encodeMean.toFixed(2)} | ${r.encodeWorst.toFixed(1)} | ${r.frameP50.toFixed(1)} | ${r.frameP95.toFixed(1)}`,
    )
  }
})
