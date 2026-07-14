// Desktop repro of the high-pitch CPU burst in the opaque vector-tile pass.
//
// On-device (iPhone, OFM Bright + labels) the rotate+pitch sweep showed an
// ~8× event-driven spike: `encoder.pass.opaque[1]` worst-frame = 41ms vs ~5ms
// mean, while the tile drain was exonerated (2ms over 6s). The spike is pure
// main-thread CPU (eviction / ring-grow / mid-render upload), so a headless
// SwiftShader-WebGPU desktop reproduces it — and lets us drive
// measure→fix→re-measure directly instead of round-tripping through a phone.
//
// Run: cd playground && XGIS_SOFTWARE_GPU=1 \
//      ./node_modules/.bin/playwright test _perf-bright-high-pitch-cpu.spec.ts
//
// Reads the per-phase WORST-FRAME (maxFrameMs, added in #701) so the burst is
// visible — a rolling MEAN hides it. The B1 sub-marks (vtr.upload / vtr.evict /
// uniform-ring.grow) nest inside opaque[1] and name the cause.

import { test, type Page } from '@playwright/test'
// Relative deep import (charter): Playwright transpiles specs in raw Node — the @xgis/* workspace alias does not resolve here, so specs import package SOURCES relatively (see _glsl-compile-gate.spec.ts).
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(__dirname, '__convert-fixtures/bright.json'), 'utf8')

// z14 Tokyo — the on-device measurement target (#14/35.68/139.76).
const HASH = '#14/35.68/139.76/0/0'

interface Phase {
  name: string
  meanMs: number
  perFrameMs: number
  maxFrameMs: number
  samples: number
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

async function setupPage(page: Page): Promise<void> {
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      console.log(`[page:${m.type()}] ${m.text()}`)
  })
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
  const xgis = convertMapboxStyle(fixture)
  await page.addInitScript((src: string) => {
    sessionStorage.setItem('__xgisImportSource', src)
    sessionStorage.setItem('__xgisImportLabel', 'Bright (high-pitch CPU)')
    ;(window as unknown as { __xgisPerfMarks?: boolean }).__xgisPerfMarks = true
  }, xgis)
  await page.goto(`/demo.html?id=__import&perfmarks=1${HASH}`, { waitUntil: 'domcontentloaded' })
  // SwiftShader compiles the Bright style's ~93-layer pipelines very slowly,
  // so first-frame (which sets __xgisReady) can take a while headlessly.
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 180_000 },
  )
  // Settle the cold-start tile cascade so we measure the sweep, not first paint.
  await page.waitForTimeout(8_000)
}

/** Drive the rotate(360°)+pitch(0→40°→0) sweep for `ms`, return per-frame
 *  rAF deltas. Mirrors the on-device «GPU/CPU 판정» sweep exactly. */
async function runSweep(page: Page, ms: number): Promise<number[]> {
  return page.evaluate(async (durationMs) => {
    interface Cam {
      zoom: number
      centerX: number
      centerY: number
      pitch: number
      bearing: number
    }
    interface M {
      getCamera: () => Cam
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
    const br0 = cam.bearing,
      p0 = cam.pitch
    const frames: number[] = []
    return await new Promise<number[]>((resolve) => {
      const start = performance.now()
      let last = start
      const tick = (): void => {
        const now = performance.now()
        frames.push(now - last)
        last = now
        const elapsed = now - start
        if (elapsed >= durationMs) {
          resolve(frames)
          return
        }
        const t = elapsed / durationMs
        const ph = t < 0.5 ? t * 2 : (1 - t) * 2
        cam.bearing = br0 + t * 360
        cam.pitch = p0 + ph * 40
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

test('Bright high-pitch CPU burst — z14 Tokyo rotate+pitch', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await setupPage(page)

  const frames = await runSweep(page, 6000)
  const phases = await readPhases(page)

  const fr = frames.slice(2)
  const fP50 = pct(fr, 50),
    fP95 = pct(fr, 95)
  const fMax = fr.reduce((a, b) => Math.max(a, b), 0)

  const byMax = [...phases].sort((a, b) => b.maxFrameMs - a.maxFrameMs)
  const get = (n: string): Phase | undefined => phases.find((p) => p.name === n)
  const opaque = phases.filter((p) => /encoder\.pass\.opaque/.test(p.name))
  const opaqueMax = opaque.reduce((a, p) => Math.max(a, p.maxFrameMs), 0)

  console.log('\n=== Bright high-pitch CPU burst (z14 Tokyo, rotate+pitch 6s) ===')
  console.log(
    `frame  p50=${fP50.toFixed(1)} p95=${fP95.toFixed(1)} worst=${fMax.toFixed(0)}ms  (${(1000 / fP50).toFixed(0)}fps, ${fr.length}f)`,
  )
  console.log(`opaque pass worst-frame MAX = ${opaqueMax.toFixed(1)}ms`)
  console.log('\nphase  WORST-frame ms  (mean)   — sorted by worst frame:')
  for (const p of byMax.slice(0, 18)) {
    console.log(
      `  ${p.maxFrameMs.toFixed(1).padStart(7)}   ${p.perFrameMs.toFixed(2).padStart(6)}   ${p.name}`,
    )
  }
  const subMarks = ['vtr.upload', 'vtr.evict', 'uniform-ring.grow']
  console.log('\nopaque burst attribution (B1 sub-marks):')
  for (const n of subMarks) {
    const p = get(n)
    console.log(
      `  ${n.padEnd(20)} worst=${(p?.maxFrameMs ?? 0).toFixed(1).padStart(6)}ms  perFrame=${(p?.perFrameMs ?? 0).toFixed(2)}ms`,
    )
  }
})
