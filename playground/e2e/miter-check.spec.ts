import { test } from '@playwright/test'
import { captureCanvas } from './helpers/visual'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART_DIR = join(HERE, '__miter-check__')
mkdirSync(ART_DIR, { recursive: true })

const VIEW = { width: 1400, height: 1000 }

async function loadCapture(page: Parameters<Parameters<typeof test>[1]>[0]['page'], id: string) {
  await page.goto(`/demo.html?id=${id}&e2e=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 20_000 },
  )
  return await captureCanvas(page)
}

async function findApexInPng(
  page: Parameters<Parameters<typeof test>[1]>[0]['page'],
  png: Buffer,
): Promise<{ x: number; y: number } | null> {
  return await page.evaluate(async (b64) => {
    const blob = await fetch(`data:image/png;base64,${b64}`).then(r => r.blob())
    const bmp = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = bmp.width; c.height = bmp.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data
    const yStart = Math.round(bmp.height * 0.15), yEnd = Math.round(bmp.height * 0.75)
    const xStart = Math.round(bmp.width * 0.2), xEnd = Math.round(bmp.width * 0.8)
    for (let y = yStart; y < yEnd; y++) {
      let minX = -1, maxX = -1
      for (let x = xStart; x < xEnd; x++) {
        const i = (y * bmp.width + x) * 4
        if (Math.max(data[i], data[i + 1], data[i + 2]) > 150) {
          if (minX < 0) minX = x
          maxX = x
        }
      }
      if (minX >= 0) return { x: Math.round((minX + maxX) / 2), y }
    }
    return null
  }, png.toString('base64'))
}

async function dumpColumn(
  page: Parameters<Parameters<typeof test>[1]>[0]['page'],
  png: Buffer,
  ax: number,
  ay: number,
): Promise<string[]> {
  return await page.evaluate(async ({ b64, ax, ay }) => {
    const blob = await fetch(`data:image/png;base64,${b64}`).then(r => r.blob())
    const bmp = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = bmp.width; c.height = bmp.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const out: string[] = []
    for (let dy = -4; dy <= 20; dy++) {
      const d = ctx.getImageData(ax, ay + dy, 1, 1).data
      out.push(`dy=${dy} rgb(${d[0]},${d[1]},${d[2]})`)
    }
    return out
  }, { b64: png.toString('base64'), ax, ay })
}

async function cropTo(
  page: Parameters<Parameters<typeof test>[1]>[0]['page'],
  png: Buffer,
  cx: number,
  cy: number,
  w: number,
  h: number,
): Promise<Buffer> {
  const b64 = await page.evaluate(async ({ b64, cx, cy, w, h }) => {
    const blob = await fetch(`data:image/png;base64,${b64}`).then(r => r.blob())
    const bmp = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, cx - w / 2, cy - h / 2, w, h, 0, 0, w, h)
    const outBlob: Blob = await new Promise(r => c.toBlob(b => r(b!), 'image/png'))
    const ab = await outBlob.arrayBuffer()
    let s = ''
    const u8 = new Uint8Array(ab)
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
    return btoa(s)
  }, { b64: png.toString('base64'), cx, cy, w, h })
  return Buffer.from(b64, 'base64')
}

test.describe('miter apex fix verification', () => {
  for (const id of ['fixture_line_join', 'fixture_join_bevel', 'fixture_miterlimit', 'fixture_join_round', 'fixture_stroke_fill']) {
    test(`capture ${id}`, async ({ page }) => {
      test.setTimeout(30_000)
      await page.setViewportSize(VIEW)
      const png = await loadCapture(page, id)
      writeFileSync(join(ART_DIR, `${id}-full.png`), png)
      const apex = await findApexInPng(page, png)
      if (!apex) throw new Error(`no stroke pixel for ${id}`)
      const crop = await cropTo(page, png, apex.x, apex.y + 30, 200, 160)
      writeFileSync(join(ART_DIR, `${id}-apex.png`), crop)
      if (id === 'fixture_line_join') {
        const dump = await dumpColumn(page, png, apex.x, apex.y)
        writeFileSync(join(ART_DIR, `${id}-column.txt`), dump.join('\n'))
      }
    })
  }
})
