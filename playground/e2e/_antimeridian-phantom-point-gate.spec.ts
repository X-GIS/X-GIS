// #2511 — a point feature must render ONCE. geojsonvt emits an antimeridian
// wrap copy of every feature into the root tile's buffer; the decoder's point
// arm clamped that beyond-±180 copy ONTO the seam, so a point at lon 127 (or
// 100 / 170 — anything within the tiler's buffer of the world edge) drew a
// second marker at exactly lon ±180: on Mercator (+106 px at z0, +150 px at
// z1), the orthographic disc and the globe (+63 px at z0). Fail-before on main
// @ c654d51: 2 blobs in every row below except the lon-60 control.
//
// Witness: one inline-geojson point, `size-8`, chrome-free capture after idle;
// the number of connected green components must be exactly 1.
import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { captureMapFrame, awaitMapIdle } from './helpers/visual'

function styleFor(lon: number, lat: number): string {
  return `xgis 1

source pt {
  type: geojson
  data: { "type": "FeatureCollection", "features": [
    { "type": "Feature", "properties": {}, "geometry": { "type": "Point", "coordinates": [${lon},${lat}] } }
  ] }
}
layer pt_dot { source: pt | fill-#00ff00 size-8 anchor-center }
`
}

/** Connected components (4-neighbour) of the marker colour. */
function greenBlobs(png: Buffer): Array<[number, number, number]> {
  const img = PNG.sync.read(png)
  const W = img.width,
    H = img.height
  const seen = new Uint8Array(W * H)
  const isG = (x: number, y: number): boolean => {
    const i = (y * W + x) * 4
    return img.data[i + 1]! > 150 && img.data[i]! < 80 && img.data[i + 2]! < 80
  }
  const blobs: Array<[number, number, number]> = []
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (seen[y * W + x] || !isG(x, y)) continue
      const stack: Array<[number, number]> = [[x, y]]
      seen[y * W + x] = 1
      let sx = 0,
        sy = 0,
        n = 0
      while (stack.length) {
        const [cx, cy] = stack.pop()!
        sx += cx
        sy += cy
        n++
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = cx + dx,
            ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ny * W + nx] || !isG(nx, ny)) continue
          seen[ny * W + nx] = 1
          stack.push([nx, ny])
        }
      }
      blobs.push([sx / n, sy / n, n])
    }
  return blobs
}

async function frameAt(
  page: Page,
  proj: 'mercator' | 'globe',
  zoom: number,
  lon: number,
  lat: number,
  forcegl2: boolean,
): Promise<Buffer> {
  await page.addInitScript(
    (src) => {
      sessionStorage.setItem('__xgisImportSource', src)
      sessionStorage.setItem('__xgisImportLabel', 'phantom-point-gate')
    },
    styleFor(lon, lat),
  )
  await page.goto(
    `/demo.html?id=__import&e2e=1&proj=${proj}&adaptive=0${forcegl2 ? '&forcegl2=1' : ''}#${zoom}/${lat}/${lon}/0/0`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 60_000 },
  )
  await awaitMapIdle(page, 60_000)
  const backend = await page.evaluate(
    () => (window as unknown as { __xgisActiveBackend?: string }).__xgisActiveBackend ?? 'unknown',
  )
  expect(backend).toBe(forcegl2 ? 'webgl2' : 'webgpu')
  return captureMapFrame(page, { readyTimeoutMs: 120_000, capture: 'clip' })
}

const CASES = [
  // proj, zoom, lon, lat, forcegl2 — the phantom rows, then the control
  ['mercator', 0, 127, 0, false],
  ['mercator', 0, 170, 0, false],
  ['mercator', 1, 127, 0, true],
  ['globe', 0, 127, 0, false],
  ['globe', 0, 100, 37, true],
  ['mercator', 0, 60, 0, false], // control: never had a phantom
] as const

for (const [proj, zoom, lon, lat, forcegl2] of CASES) {
  test(`a point renders once — ${proj} z${zoom} lon ${lon} lat ${lat} ${forcegl2 ? 'webgl2' : 'webgpu'}`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    const blobs = greenBlobs(await frameAt(page, proj, zoom, lon, lat, forcegl2))
    console.log(
      `[phantom-point ${proj} z${zoom} lon${lon}] ${blobs.length} blob(s): ${blobs.map((b) => `(${b[0].toFixed(1)},${b[1].toFixed(1)}) n=${b[2]}`).join(' | ')}`,
    )
    expect(blobs.length, 'exactly one marker — no phantom on the antimeridian').toBe(1)
    // …and it is the real one, at the camera centre.
    expect(Math.abs(blobs[0]![0] - 430)).toBeLessThan(3)
    expect(Math.abs(blobs[0]![1] - 360)).toBeLessThan(3)
  })
}
