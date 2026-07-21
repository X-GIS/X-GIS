// #1221 round-3 control matrix — seam-vertical STRUCTURE gate.
//
// The #1221 seam wall: mvt-decoder's clampLon pinned geojson-vt's beyond-±180
// buffer/wrap vertices to exactly ±180, collapsing them into a vertical wall
// of collinear segments on the antimeridian that the line renderer faithfully
// drew whenever the camera longitude put lon 180 on screen. Pre-fix column
// runs measured 117-210 px; a correct body-only frame measures ≤ ~10 px.
//
// This spec re-runs the round-3 control matrix as a STRUCTURE assertion (the
// §12 lesson from this very issue: a pixel-COUNT gate passed on the broken
// image — only the max contiguous vertical run of stroke pixels per column
// separates a wall from a line body). Six scenes, all flat Mercator z3,
// stroke-4 rose-500, headless SwiftShader (cloud/CI-runnable):
//
//   | scene                        | camera lon | pre-fix vertical |
//   |------------------------------|------------|------------------|
//   | crossing witness 165→195     | 180        | 210 px           |
//   | line ending exactly at 180   | 180        | 124 px           |
//   | crossing, seam off-centre    | 150        | none (body 7 px) |
//   | line ending at lon 0         | 0          | none             |
//   | endpoint at 179 (real cap)   | 180        | 117 px           |
//   | endpoint at 180, cam at 178  | 178        | 124 px           |
//
// Frames + seam crops are written to __1221-seam-matrix__/ (gitignored) for
// the mandatory §5 image read.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '__1221-seam-matrix__')

interface Scene {
  id: string
  /** inline LineString scene (ignored when demoId is set) */
  coords: [number, number][]
  /** load a real gallery demo instead of an injected inline scene */
  demoId?: string
  camLon: number
  camLat: number
  /** pre-fix max column run in px (documentation only) */
  preFixRun: number
}

const SCENES: Scene[] = [
  {
    id: 'crossing-cam180',
    coords: [
      [165, 60],
      [175, 66],
      [185, 68],
      [195, 64],
    ],
    camLon: 180,
    camLat: 64,
    preFixRun: 210,
  },
  {
    id: 'end-at-180-cam180',
    coords: [
      [165, 60],
      [175, 66],
      [180, 68],
    ],
    camLon: 180,
    camLat: 64,
    preFixRun: 124,
  },
  {
    id: 'crossing-cam150',
    coords: [
      [165, 60],
      [175, 66],
      [185, 68],
      [195, 64],
    ],
    camLon: 150,
    camLat: 64,
    preFixRun: 7,
  },
  {
    id: 'end-at-0-cam0',
    coords: [
      [-15, 60],
      [-5, 66],
      [0, 68],
    ],
    camLon: 0,
    camLat: 64,
    preFixRun: 0,
  },
  {
    id: 'end-at-179-cam180',
    coords: [
      [165, 60],
      [175, 66],
      [179, 68],
    ],
    camLon: 180,
    camLat: 64,
    preFixRun: 117,
  },
  {
    id: 'end-at-180-cam178',
    coords: [
      [165, 60],
      [175, 66],
      [180, 68],
    ],
    camLon: 178,
    camLat: 64,
    preFixRun: 124,
  },
  // The #1221 acceptance scene: the un-parked gallery demo itself (url-fetched
  // fixture, not an inline injection) must render as one connected crossing at
  // #3/64/180 with no seam vertical.
  {
    id: 'demo-line-antimeridian',
    demoId: 'line_antimeridian',
    coords: [],
    camLon: 180,
    camLat: 64,
    preFixRun: 210,
  },
]

function sceneSource(coords: [number, number][]): string {
  const line = JSON.stringify(coords)
  return `xgis 1

source seamline {
  type: geojson
  data: { "type": "FeatureCollection", "features": [
    { "type": "Feature", "geometry": { "type": "LineString", "coordinates": ${line} }, "properties": {} }
  ] }
}

layer crossing {
  source: seamline
  | stroke-rose-500 stroke-4
}
`
}

async function setViewAndSettle(
  page: import('@playwright/test').Page,
  lon: number,
  lat: number,
  zoom: number,
): Promise<void> {
  await page.evaluate(
    ({ lon, lat, zoom }) => {
      const m = (
        window as unknown as {
          __xgisMap: {
            getCamera(): {
              centerX: number
              centerY: number
              zoom: number
              bearing: number
              pitch: number
              maxZoom: number
            }
            markCameraPositioned(): void
            invalidate?(): void
          }
        }
      ).__xgisMap
      const R = 6378137
      const RAD = Math.PI / 180
      const c = m.getCamera()
      c.zoom = Math.max(0, Math.min(c.maxZoom, zoom))
      c.centerX = lon * RAD * R
      const cl = Math.max(-85.05, Math.min(85.05, lat))
      c.centerY = Math.log(Math.tan(Math.PI / 4 + (cl * RAD) / 2)) * R
      c.bearing = 0
      c.pitch = 0
      m.markCameraPositioned()
      m.invalidate?.()
    },
    { lon, lat, zoom },
  )
  await page
    .waitForFunction(
      () => {
        const m = (
          window as unknown as {
            __xgisMap?: {
              getTileLoadDiagnostic(): Record<
                string,
                { catalogLoading: number; uploadQueued: number }
              >
              invalidate?(): void
            }
          }
        ).__xgisMap
        if (!m) return false
        m.invalidate?.()
        const d = m.getTileLoadDiagnostic()
        let n = 0
        for (const k in d) n += d[k]!.catalogLoading + d[k]!.uploadQueued
        return n === 0
      },
      null,
      { timeout: 30_000 },
    )
    .catch(() => {})
  await page.waitForTimeout(1_500)
}

test('#1221 seam control matrix — no vertical wall in any scene', async ({ page }) => {
  test.setTimeout(360_000)
  mkdirSync(OUT, { recursive: true })
  await page.setViewportSize({ width: 1280, height: 800 })
  const failures: string[] = []

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))

  for (const scene of SCENES) {
    errors.length = 0
    // `&scene=` forces a REAL navigation between scenes — a goto that only
    // changes the #fragment is a hashchange, not a reload, and every scene
    // after the first would silently keep the first scene's source.
    const url = scene.demoId
      ? `/demo.html?id=${scene.demoId}&e2e=1&scene=${scene.id}`
      : `/demo.html?id=__import&e2e=1&scene=${scene.id}#src=${Buffer.from(
          sceneSource(scene.coords),
          'utf8',
        ).toString('base64')}`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 30_000 },
    )
    await setViewAndSettle(page, scene.camLon, scene.camLat, 3)

    const png = await page.locator('#map').screenshot()
    writeFileSync(join(OUT, `${scene.id}.png`), png)

    // Column-run analysis in the page context (no node-side PNG decoder):
    // for every column, the longest contiguous run of stroke-classified
    // pixels; a seam wall is a >100 px run, a healthy line body ≤ ~10 px.
    const m = await page.evaluate(
      async ({ b64 }) => {
        const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
        const bmp = await createImageBitmap(blob)
        const c = document.createElement('canvas')
        c.width = bmp.width
        c.height = bmp.height
        const ctx = c.getContext('2d')!
        ctx.drawImage(bmp, 0, 0)
        const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
        let maxRun = 0
        let maxRunX = -1
        let strokePixels = 0
        for (let x = 0; x < bmp.width; x++) {
          let run = 0
          for (let y = 0; y < bmp.height; y++) {
            const i = (y * bmp.width + x) * 4
            const r = d[i]
            const g = d[i + 1]
            const b = d[i + 2]
            // Rose-500 (#f43f5e) stroke: a redness predicate (high R, low G,
            // R−G gap) keeps AA fringe out without missing the body.
            const isStroke = r > 170 && g < 130 && b < 170 && r - g > 70
            if (isStroke) {
              strokePixels++
              run++
              if (run > maxRun) {
                maxRun = run
                maxRunX = x
              }
            } else run = 0
          }
        }
        return { maxRun, maxRunX, strokePixels, w: bmp.width, h: bmp.height }
      },
      { b64: png.toString('base64') },
    )

    // ×4 crop of the hottest column strip for the §5 image read.
    if (m.maxRunX >= 0) {
      const cropB64 = await page.evaluate(
        async ({ b64, cx, w, h }) => {
          const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
          const bmp = await createImageBitmap(blob)
          const x0 = Math.max(0, Math.min(w - 80, cx - 40))
          const c = document.createElement('canvas')
          c.width = 80 * 4
          c.height = h * 2
          const ctx = c.getContext('2d')!
          ctx.imageSmoothingEnabled = false
          ctx.drawImage(bmp, x0, 0, 80, h, 0, 0, 80 * 4, h * 2)
          const outBlob: Blob = await new Promise((resolve) =>
            c.toBlob((b) => resolve(b!), 'image/png'),
          )
          const ab = await outBlob.arrayBuffer()
          let s = ''
          const u8 = new Uint8Array(ab)
          for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
          return btoa(s)
        },
        { b64: png.toString('base64'), cx: m.maxRunX, w: m.w, h: m.h },
      )
      writeFileSync(join(OUT, `${scene.id}-crop-x${m.maxRunX}.png`), Buffer.from(cropB64, 'base64'))
    }

    console.log(
      `SCENE ${scene.id}: maxRun=${m.maxRun}px @x=${m.maxRunX} stroke=${m.strokePixels}px ` +
        `(pre-fix: ${scene.preFixRun}px) errors=${errors.length}`,
    )
    if (m.strokePixels < 200) failures.push(`${scene.id}: line body missing (${m.strokePixels}px)`)
    if (m.maxRun >= 24)
      failures.push(`${scene.id}: vertical run ${m.maxRun}px @x=${m.maxRunX} (wall threshold 24)`)
    if (errors.length > 0) failures.push(`${scene.id}: page errors ${errors.join(' | ')}`)
  }

  expect(failures, failures.join('\n')).toEqual([])
})
