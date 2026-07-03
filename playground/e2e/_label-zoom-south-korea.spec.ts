// ═══════════════════════════════════════════════════════════════════
// Focused label-quality compare — "South Korea" at OFM Positron
// ═══════════════════════════════════════════════════════════════════
//
// User request 2026-05-19: render at OFM Positron
// #4.82/36.87885/128.90493 and inspect ONLY the "South Korea" label
// against MapLibre. The full-canvas survey at survey-labels showed
// gt128 improving across iters 113-119 but the user still reports
// "S 글자의 각 부분이 박스 형태로 더 얇아지는 문제" — full-canvas
// bucket counts dilute the label-specific signal with non-label
// pixels (ocean / land / coastline) which X-GIS may render
// pixel-identically.
//
// Approach: locate the SOUTH KOREA label's dark-pixel bounding box
// in the MapLibre screenshot (text-color is #000 with text-halo-
// color #fff, so dark pixels under a threshold are the label),
// expand by a 40-px halo margin, then crop BOTH screenshots to
// that box and pixel-diff JUST the label region.

import { test } from '@playwright/test'

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__label-zoom-south-korea__')
mkdirSync(OUT, { recursive: true })

const STYLE = 'openfreemap-positron'
const HASH = '#4.82/36.87885/128.90493'
// Background kept visible (style background-color = rgb(242,243,240)
// for Positron). Label text-color = #000 on text-halo-color = #fff.
// Find ink as pixels darker than the background; halo as pixels
// brighter than background. Either signature locates the label.
const INK_THRESHOLD = 100

interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

// Background visible → label ink is the only DARK pixel on canvas.
function isHaloedInk(png: PNG, _w: number, _h: number, x: number, y: number): boolean {
  // Critical: use png.width for the row stride, NOT the passed `w`.
  // ML canvas is 640 vs X-GIS 639 → caller normalises to w=639, but
  // raw png.data still uses ml.width=640 per row. Reading via the
  // passed `w` shifted every row by 1 px and the cluster finder
  // landed on garbage coordinates (right edge of canvas in earlier
  // diagnostic runs).
  const i = (y * png.width + x) * 4
  const r = png.data[i]!,
    g = png.data[i + 1]!,
    b = png.data[i + 2]!
  return r < INK_THRESHOLD && g < INK_THRESHOLD && b < INK_THRESHOLD
}

// Flood-fill connected components of haloed-ink with a max gap of
// 5 px (treat near-adjacent pixels as one cluster — letters of a
// word are typically 1-4 px apart at z=4.82 label size). Return all
// clusters as bboxes.
function findInkClusters(png: PNG, w: number, h: number): BBox[] {
  // Mask is built over the NORMALISED canvas region (w×h), which
  // intentionally clips one column when ML/X-GIS differ by 1 px.
  // Pixel lookup uses png.width inside isHaloedInk.
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isHaloedInk(png, w, h, x, y)) mask[y * w + x] = 1
    }
  }
  const visited = new Uint8Array(w * h)
  const clusters: BBox[] = []
  // GAP must exceed the inter-glyph + inter-line distance for the
  // "South Korea\n대한민국" 2-line stack to merge as one cluster.
  // At z=4.82 text-size 16.5 CSS-px → glyph height ~13 px,
  // line-height ~20 px → 12-px gap covers the 6-7-px white space
  // between baseline & ascender of the next line.
  const GAP = 12
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x] || visited[y * w + x]) continue
      // BFS with gap-tolerant neighborhood (radius GAP, Chebyshev).
      let minX = x,
        maxX = x,
        minY = y,
        maxY = y
      const stack: number[] = [x, y]
      visited[y * w + x] = 1
      let count = 0
      while (stack.length) {
        const cy = stack.pop()!
        const cx = stack.pop()!
        count++
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        for (let dy = -GAP; dy <= GAP; dy++) {
          const ny = cy + dy
          if (ny < 0 || ny >= h) continue
          for (let dx = -GAP; dx <= GAP; dx++) {
            const nx = cx + dx
            if (nx < 0 || nx >= w) continue
            const ni = ny * w + nx
            if (!mask[ni] || visited[ni]) continue
            visited[ni] = 1
            stack.push(nx, ny)
          }
        }
      }
      // Filter to plausible country-label clusters: >= 100 ink pixels,
      // bbox width 50-250 (single line ~70-160; with halo 50-200 OK),
      // height 20-90 (one or two lines stacked).
      const cw = maxX - minX,
        ch = maxY - minY
      if (count >= 100 && cw >= 50 && cw < 250 && ch >= 20 && ch < 90) {
        clusters.push({ minX, minY, maxX, maxY })
      }
    }
  }
  return clusters
}

// Pick the cluster whose centroid is closest to (anchorX, anchorY).
function findLabelBBox(png: PNG, w: number, h: number): BBox | null {
  const clusters = findInkClusters(png, w, h)
  if (clusters.length === 0) return null
  // South Korea label sits south + slightly west of the camera anchor
  // at zoom=4.82, hash 36.87/128.90 (country centroid for SK falls
  // around 36.5N, 127.8E vs camera 36.87N, 128.90E → label appears
  // a tad below + left of canvas centre).
  const ax = w * 0.45,
    ay = h * 0.5
  let best: BBox | null = null
  let bestDist = Infinity
  for (const c of clusters) {
    const cx = (c.minX + c.maxX) / 2
    const cy = (c.minY + c.maxY) / 2
    const d = (cx - ax) ** 2 + (cy - ay) ** 2
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}

function findInkBBox(png: PNG, w: number, h: number): BBox | null {
  // Build a mask of haloed-ink pixels.
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isHaloedInk(png, w, h, x, y)) mask[y * w + x] = 1
    }
  }
  // Density-based windowed search: scan WIN×WIN tiles and pick the
  // densest. Coastlines have sparse ink (long thin lines, <1 px/row);
  // labels are compact text blocks (many ink pixels per row).
  const WIN = 100
  const STRIDE = 10
  let bestDensity = 0,
    bestX = -1,
    bestY = -1
  for (let y0 = 0; y0 + WIN < h; y0 += STRIDE) {
    for (let x0 = 0; x0 + WIN < w; x0 += STRIDE) {
      let count = 0
      for (let yy = 0; yy < WIN; yy++) {
        const base = (y0 + yy) * w + x0
        for (let xx = 0; xx < WIN; xx++) {
          count += mask[base + xx]!
        }
      }
      if (count > bestDensity) {
        bestDensity = count
        bestX = x0
        bestY = y0
      }
    }
  }
  if (bestDensity === 0) return null
  // Tighten to the actual ink extent within the densest window.
  let minX = w,
    maxX = -1,
    minY = h,
    maxY = -1
  for (let yy = 0; yy < WIN; yy++) {
    const yi = bestY + yy
    for (let xx = 0; xx < WIN; xx++) {
      const xi = bestX + xx
      if (mask[yi * w + xi] === 1) {
        if (xi < minX) minX = xi
        if (xi > maxX) maxX = xi
        if (yi < minY) minY = yi
        if (yi > maxY) maxY = yi
      }
    }
  }
  return { minX, minY, maxX, maxY }
}

function cropToBox(src: PNG, box: BBox): PNG {
  const w = box.maxX - box.minX + 1
  const h = box.maxY - box.minY + 1
  const out = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = box.minX + x
      const sy = box.minY + y
      const si = (sy * src.width + sx) * 4
      const di = (y * w + x) * 4
      out.data[di] = src.data[si]!
      out.data[di + 1] = src.data[si + 1]!
      out.data[di + 2] = src.data[si + 2]!
      out.data[di + 3] = src.data[si + 3]!
    }
  }
  return out
}

function upscale(src: PNG, factor: number): PNG {
  const w = src.width * factor
  const h = src.height * factor
  const out = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.floor(x / factor)
      const sy = Math.floor(y / factor)
      const si = (sy * src.width + sx) * 4
      const di = (y * w + x) * 4
      out.data[di] = src.data[si]!
      out.data[di + 1] = src.data[si + 1]!
      out.data[di + 2] = src.data[si + 2]!
      out.data[di + 3] = src.data[si + 3]!
    }
  }
  return out
}

interface Buckets {
  eq0: number
  le8: number
  le16: number
  le32: number
  le64: number
  le128: number
  gt128: number
}

function diffBuckets(a: PNG, b: PNG): Buckets {
  const w = Math.min(a.width, b.width),
    h = Math.min(a.height, b.height)
  const buckets: Buckets = { eq0: 0, le8: 0, le16: 0, le32: 0, le64: 0, le128: 0, gt128: 0 }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ai = (y * a.width + x) * 4
      const bi = (y * b.width + x) * 4
      const dr = Math.abs(a.data[ai]! - b.data[bi]!)
      const dg = Math.abs(a.data[ai + 1]! - b.data[bi + 1]!)
      const db = Math.abs(a.data[ai + 2]! - b.data[bi + 2]!)
      const m = Math.max(dr, dg, db)
      if (m === 0) buckets.eq0++
      else if (m <= 8) buckets.le8++
      else if (m <= 16) buckets.le16++
      else if (m <= 32) buckets.le32++
      else if (m <= 64) buckets.le64++
      else if (m <= 128) buckets.le128++
      else buckets.gt128++
    }
  }
  return buckets
}

function diffHeatmap(a: PNG, b: PNG): PNG {
  const w = Math.min(a.width, b.width),
    h = Math.min(a.height, b.height)
  const out = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ai = (y * a.width + x) * 4
      const bi = (y * b.width + x) * 4
      const dr = Math.abs(a.data[ai]! - b.data[bi]!)
      const dg = Math.abs(a.data[ai + 1]! - b.data[bi + 1]!)
      const db = Math.abs(a.data[ai + 2]! - b.data[bi + 2]!)
      const m = Math.max(dr, dg, db)
      const oi = (y * w + x) * 4
      out.data[oi] = Math.min(255, m * 2)
      out.data[oi + 1] = 0
      out.data[oi + 2] = m > 128 ? 255 : 0
      out.data[oi + 3] = 255
    }
  }
  return out
}

test('label-zoom South Korea OFM Positron', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/compare.html?style=${STYLE}${HASH}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __xgisReady?: boolean; __mlReady?: boolean }
      return w.__xgisReady === true && w.__mlReady === true
    },
    null,
    { timeout: 90_000 },
  )
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        interface MlMap {
          loaded(): boolean
          once(ev: string, fn: () => void): void
        }
        const ml = (window as unknown as { __mlMap?: MlMap }).__mlMap
        if (!ml) {
          resolve()
          return
        }
        if (ml.loaded()) {
          resolve()
          return
        }
        ml.once('idle', () => resolve())
        setTimeout(resolve, 15_000)
      }),
  )
  await page.waitForTimeout(4_500)

  // Isolate country labels: hide every layer EXCEPT label_country_*
  // (keep `background` so both sides paint on identical canvas color
  // for clean visual compare of glyph quality). Land/water/coastline
  // / other symbol layers all hidden → only the country-label text
  // appears against the style's background colour.
  await page.evaluate(() => {
    interface MlMap {
      getStyle(): { layers: Array<{ id: string; type: string }> }
      setLayoutProperty(id: string, key: string, value: 'none' | 'visible'): void
    }
    const ml = (window as unknown as { __mlMap?: MlMap }).__mlMap
    if (!ml) return
    for (const layer of ml.getStyle().layers) {
      const keep = /^label_country_/.test(layer.id) || layer.id === 'background'
      ml.setLayoutProperty(layer.id, 'visibility', keep ? 'visible' : 'none')
    }
  })
  await page.evaluate(() => {
    interface XGISShow {
      label?: unknown
      visible?: boolean
      targetName?: string
      layerName?: string
    }
    interface XGISLayer {
      name?: string
      style?: { visible?: boolean }
    }
    interface XGISMap {
      vectorTileShows?: Array<{ show: XGISShow }>
      getLayers?(): readonly XGISLayer[]
      invalidate?(): void
    }
    const map = (window as unknown as { __xgisMap?: XGISMap }).__xgisMap
    if (!map) return
    for (const e of map.vectorTileShows ?? []) {
      const name = (e.show.layerName ?? e.show.targetName ?? '').toLowerCase()
      e.show.visible = name.startsWith('label_country_') || name === 'background'
    }
    for (const layer of map.getLayers?.() ?? []) {
      if (!layer.style) continue
      const name = (layer.name ?? '').toLowerCase()
      layer.style.visible = name.startsWith('label_country_') || name === 'background'
    }
    map.invalidate?.()
  })
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        interface MlMap {
          loaded(): boolean
          once(ev: string, fn: () => void): void
        }
        const ml = (window as unknown as { __mlMap?: MlMap }).__mlMap
        if (!ml) {
          resolve()
          return
        }
        if (ml.loaded()) {
          resolve()
          return
        }
        ml.once('idle', () => resolve())
        setTimeout(resolve, 8_000)
      }),
  )
  await page.waitForTimeout(3_500)
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )

  const mlPng = await page.locator('#ml-map canvas').first().screenshot()
  const xgPng = await page.locator('#xg-canv').screenshot()
  const ml = PNG.sync.read(mlPng)
  const xg = PNG.sync.read(xgPng)
  const w = Math.min(ml.width, xg.width)
  const h = Math.min(ml.height, xg.height)

  // Dump full ML / XG screenshots for visual reference + diff
  writeFileSync(join(OUT, 'full-maplibre.png'), PNG.sync.write(ml))
  writeFileSync(join(OUT, 'full-xgis.png'), PNG.sync.write(xg))
  // With all non-label_country layers hidden, the only dark ink on
  // canvas is the country-label text. Find SOUTH KOREA specifically
  // by picking the cluster south of viewport center (NORTH KOREA sits
  // above center; SOUTH KOREA below). Cluster discovery here uses a
  // 12-px gap tolerance so the "South Korea\n대한민국" two-line stack
  // groups as one bbox.
  const clusters = findInkClusters(ml, w, h)
  if (clusters.length === 0) {
    throw new Error('No country labels visible on MapLibre canvas')
  }
  // Pick the cluster whose centroid is BELOW canvas centre and
  // closest to it. NORTH KOREA cluster is above; SOUTH KOREA is below.
  const cyCanvas = h / 2
  let inkBox: BBox | null = null
  let bestDist = Infinity
  for (const c of clusters) {
    const cyC = (c.minY + c.maxY) / 2
    if (cyC <= cyCanvas) continue // skip clusters above centre (NORTH KOREA)
    const d = Math.abs(cyC - cyCanvas)
    if (d < bestDist) {
      bestDist = d
      inkBox = c
    }
  }
  // Fallback: if all clusters are above centre, take the closest.
  if (inkBox === null) {
    bestDist = Infinity
    for (const c of clusters) {
      const cyC = (c.minY + c.maxY) / 2
      const d = Math.abs(cyC - cyCanvas)
      if (d < bestDist) {
        bestDist = d
        inkBox = c
      }
    }
  }
  if (inkBox === null) throw new Error('SOUTH KOREA label not located')
  // Expand box by 16 px for halo + breathing room
  const PAD = 16
  const box: BBox = {
    minX: Math.max(0, inkBox.minX - PAD),
    minY: Math.max(0, inkBox.minY - PAD),
    maxX: Math.min(w - 1, inkBox.maxX + PAD),
    maxY: Math.min(h - 1, inkBox.maxY + PAD),
  }
  const labelW = box.maxX - box.minX + 1
  const labelH = box.maxY - box.minY + 1
  // eslint-disable-next-line no-console
  console.log(
    `[label-zoom] SOUTH KOREA bbox: ${box.minX},${box.minY}..${box.maxX},${box.maxY} (${labelW}×${labelH})`,
  )

  const mlCrop = cropToBox(ml, box)
  const xgCrop = cropToBox(xg, box)
  const buckets = diffBuckets(mlCrop, xgCrop)
  const totalPx = labelW * labelH

  // 4× upscaled output for visual inspection of stroke quality at
  // per-pixel resolution.
  const SCALE = 4
  writeFileSync(join(OUT, 'maplibre.png'), PNG.sync.write(mlCrop))
  writeFileSync(join(OUT, 'xgis.png'), PNG.sync.write(xgCrop))
  writeFileSync(join(OUT, 'maplibre-4x.png'), PNG.sync.write(upscale(mlCrop, SCALE)))
  writeFileSync(join(OUT, 'xgis-4x.png'), PNG.sync.write(upscale(xgCrop, SCALE)))
  writeFileSync(join(OUT, 'diff-heatmap.png'), PNG.sync.write(diffHeatmap(mlCrop, xgCrop)))
  writeFileSync(
    join(OUT, 'diff-heatmap-4x.png'),
    PNG.sync.write(upscale(diffHeatmap(mlCrop, xgCrop), SCALE)),
  )
  writeFileSync(
    join(OUT, 'buckets.json'),
    JSON.stringify(
      {
        bbox: box,
        labelW,
        labelH,
        totalPx,
        buckets,
        pct: {
          eq0: ((buckets.eq0 / totalPx) * 100).toFixed(2) + '%',
          le32_cumul:
            (((buckets.eq0 + buckets.le8 + buckets.le16 + buckets.le32) / totalPx) * 100).toFixed(
              2,
            ) + '%',
          le128_cumul: (((totalPx - buckets.gt128) / totalPx) * 100).toFixed(2) + '%',
          gt128_count: buckets.gt128,
        },
      },
      null,
      2,
    ),
  )
  // eslint-disable-next-line no-console
  console.log(
    `[label-zoom] eq=${((buckets.eq0 / totalPx) * 100).toFixed(2)}% ` +
      `gt128=${buckets.gt128}/${totalPx} (${((buckets.gt128 / totalPx) * 100).toFixed(2)}%)`,
  )
})
