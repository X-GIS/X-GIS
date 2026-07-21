// #1245 — wrapped-continuation continuity CAMERA SWEEP.
//
// #1221 fixed the seam WALL; its structure gate checks the seam column at one
// pinned camera. #1245 is the follow-up: a hairline break INSIDE the wrapped
// continuation (east of +180) where two independently-MVT-quantised tile pieces
// abut at an internal tile boundary and their non-coincident butt ends leave a
// ~1 px gap. The bug hid exactly where the pinned camera was NOT looking, so
// this gate SWEEPS cameras over the wrap and asserts, for every frame, that the
// stroke over its on-screen x-range has:
//   • NO full-column gap  (a column with zero stroke between two struck columns)
//   • NO sub-40%-of-median thickness dip
// which is precisely the #1245 signature (`gaps:[[844,844]], dips:[[843,1],
// [845,1]]`, median 4 in the owner's container repro at z5/cam180).
//
// forcegl2 + SwiftShader (cloud/CI-runnable via XGIS_SOFTWARE_GPU=1). Chrome is
// hidden before the readback so only the map canvas contributes stroke pixels.
import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '__1245-wrap-sweep__')

interface Cam {
  id: string
  hash: string
  /** the z5/cam180 owner-container witness must be exercised */
  witness?: boolean
}

// The z5/cam180 witness (the container repro's gap column) plus the
// localization sweep's firing points (owner z7.15, z9) and a longitude
// micro-sweep around the seam so the break can't hide off-camera.
const CAMS: Cam[] = [
  { id: 'z5-cam180', hash: '#5/66.9/180', witness: true },
  { id: 'z5-cam178', hash: '#5/66.9/178' },
  { id: 'z5-cam182', hash: '#5/66.9/182' },
  { id: 'z6-cam180', hash: '#6/67.0/180' },
  { id: 'owner-z715', hash: '#7.15/66.69669/-179.33587' },
  { id: 'z9-cam17975', hash: '#9/67.06/-179.75' },
]

async function hideChrome(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('body > *').forEach((el) => {
      const h = el as HTMLElement
      if (!h.querySelector?.('#map') && h.id !== 'layout') h.style.visibility = 'hidden'
    })
    const keep = new Set(['map-pane', 'map', 'layout'])
    document.querySelectorAll('#map-pane > *').forEach((el) => {
      const h = el as HTMLElement
      if (!keep.has(h.id)) h.style.visibility = 'hidden'
    })
  })
}

/** Per-column stroke analysis of the rose-500 line over the GL readback. */
async function measure(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __xgisMap?: { ctx?: { rhi?: { gl?: WebGL2RenderingContext } } }
    }
    const gl = w.__xgisMap?.ctx?.rhi?.gl
    if (!gl) return null
    const W = gl.drawingBufferWidth
    const H = gl.drawingBufferHeight
    const buf = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    // rose-500-ish stroke predicate (AA-robust): high red, red≫green, red≫blue.
    const isStroke = (i: number): boolean =>
      buf[i]! > 150 && buf[i]! - buf[i + 1]! > 70 && buf[i]! - buf[i + 2]! > 40
    const cols: number[] = new Array(W).fill(0)
    for (let x = 0; x < W; x++) {
      let n = 0
      for (let y = 0; y < H; y++) if (isStroke((y * W + x) * 4)) n++
      cols[x] = n
    }
    let x0 = -1
    let x1 = -1
    for (let x = 0; x < W; x++)
      if (cols[x]! > 0) {
        if (x0 < 0) x0 = x
        x1 = x
      }
    if (x0 < 0) return { W, H, x0, x1, median: 0, gaps: [], dips: [], strokeCols: 0 }
    // median thickness over struck columns
    const ns = cols
      .slice(x0, x1 + 1)
      .filter((n) => n > 0)
      .sort((a, b) => a - b)
    const median = ns[Math.floor(ns.length / 2)] ?? 0
    // Skip a 2 px cuff at each visible end (frame-clip AA), then look for full
    // gaps (n==0 flanked by stroke) and sub-40%-median dips.
    const gaps: [number, number][] = []
    const dips: [number, number][] = []
    for (let x = x0 + 2; x <= x1 - 2; x++) {
      if (cols[x]! === 0 && cols[x - 1]! > 0 && cols[x + 1]! > 0) gaps.push([x, cols[x]!])
      if (cols[x]! > 0 && median > 0 && cols[x]! < median * 0.4) dips.push([x, cols[x]!])
    }
    let strokeCols = 0
    for (let x = x0; x <= x1; x++) if (cols[x]! > 0) strokeCols++
    return { W, H, x0, x1, median, gaps: gaps.slice(0, 20), dips: dips.slice(0, 20), strokeCols }
  })
}

test('#1245 wrap continuation is continuous across a camera sweep', async ({ page }) => {
  test.setTimeout(300_000)
  mkdirSync(OUT, { recursive: true })
  const failures: string[] = []

  for (const cam of CAMS) {
    await page.goto(`/demo.html?id=line_antimeridian&forcegl2=1&preserve=1${cam.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      { timeout: 30_000 },
    )
    await page.waitForTimeout(6000)
    await hideChrome(page)
    await page.waitForTimeout(300)

    const m = await measure(page)
    await page.screenshot({ path: join(OUT, `${cam.id}.png`) })
    if (!m) {
      failures.push(`${cam.id}: no GL context`)
      continue
    }
    // The witness frame MUST actually show the wrapped stroke — otherwise the
    // gate is vacuously green (the #1221 §12 lesson).
    if (cam.witness && m.strokeCols < 40) {
      failures.push(`${cam.id}: witness stroke missing (${m.strokeCols} cols)`)
    }
    if (m.strokeCols < 20) {
      // non-witness camera with the wrap off-screen: nothing to assert.

      console.log(`SWEEP ${cam.id}: stroke off-screen (${m.strokeCols} cols) — skipped`)
      continue
    }

    console.log(
      `SWEEP ${cam.id}: x=[${m.x0},${m.x1}] median=${m.median} strokeCols=${m.strokeCols} ` +
        `gaps=${JSON.stringify(m.gaps)} dips=${JSON.stringify(m.dips)}`,
    )
    if (m.gaps.length > 0) failures.push(`${cam.id}: full-column gap(s) ${JSON.stringify(m.gaps)}`)
    if (m.dips.length > 0)
      failures.push(`${cam.id}: <40%-median thickness dip(s) ${JSON.stringify(m.dips)}`)
  }

  expect(failures, failures.join('\n')).toEqual([])
})
