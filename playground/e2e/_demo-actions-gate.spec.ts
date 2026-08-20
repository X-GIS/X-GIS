// ═══ Demo.actions interaction-infra gate (#1192) ═══
//
// The gallery's action buttons must drive the LIVE map through public APIs:
//  • color_switcher — "Change a layer's color with buttons" port: clicking
//    "Rose fill" recolours the mounted countries fill via setPaintProperty.
//  • fly_to — "Fly to a location" port: clicking "Seoul" moves the camera
//    via map.flyTo (hash + frame change).
//  • camera_around_point — "Animate map camera around a point" port: Start
//    advances map.setBearing() from a host rAF loop; Stop halts it.
//  • animate_point_route — "Animate a point along a route" port: Start
//    glides a Marker DOM overlay (#1262) along the arc via per-frame
//    marker.setLngLat() (a screen-space reposition, not a source re-tile).
// Demos WITHOUT actions must not show the bar.
//
// The three `waitForTimeout` calls left in this file are DURATION measurements, not
// convergence waits, and a #1895-style sweep must not replace them: 700ms of rotation
// is what makes the bearing delta exceed noise, 500ms of NOT rotating is what proves
// Stop took effect, and 1500ms of route animation is what moves the marker far enough
// to distinguish from jitter. Deleting them deletes the interval being measured. Waits
// for the map to finish drawing go through `settle()` below.

import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'

const DIR = '/tmp/claude-0/-home-user-X-GIS/8da4ef15-9f91-58b5-8776-d8104f8ea4eb/scratchpad'

type MapWin = {
  __xgisReady?: boolean
  __xgisMap?: {
    invalidate?: () => void
    getMissingTileCount?: () => number
    ctx?: { rhi?: { gl?: WebGL2RenderingContext } }
  }
}

async function boot(page: Page, id: string): Promise<void> {
  await page.goto(`/demo.html?id=${id}&e2e=1&forcegl2=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, {
    timeout: 60_000,
  })
  // A settled frame is a precondition of every screenshot below, so a boot that
  // never converges must fail HERE and name itself, not surface as a diff count.
  const { nonBg } = await settle(page)
  expect(nonBg, `${id} never drew content before the screenshot`).toBeGreaterThan(0)
}

/** A content hash of the drawing buffer + a non-background pixel count, read straight
 *  from GL so only two numbers cross the CDP bridge. Mirrors `_scene-builder-twin`. */
const readFrame = (page: Page) =>
  page.evaluate(() => {
    const gl = (window as unknown as MapWin).__xgisMap?.ctx?.rhi?.gl
    if (!gl) return { ok: false as const }
    const W = gl.drawingBufferWidth
    const H = gl.drawingBufferHeight
    const buf = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    let h = 0x811c9dc5
    for (let i = 0; i < buf.length; i++) {
      h ^= buf[i]!
      h = Math.imul(h, 0x01000193)
    }
    let nonBg = 0
    for (let p = 0; p < W * H; p++) {
      const i = p * 4
      if (buf[i] !== 0 || buf[i + 1] !== 0 || buf[i + 2] !== 0) nonBg++
    }
    return { ok: true as const, hash: h >>> 0, nonBg }
  })

/** Pump until the scene converges — no tile still resolving AND three identical frame
 *  hashes — instead of pumping a fixed 20 times (#1895).
 *
 *  The count-based pump this replaces did not wait on the map at all. Measured on this
 *  page, the same `20 x (invalidate + 80ms)` loop took 3416ms, 3684ms, 3854ms, 4846ms and
 *  once 11896ms: the `waitForTimeout(80)` is a floor and the CDP round trip supplies the
 *  rest, so its length tracks bridge latency, not tile loading. It happened to be long
 *  enough here — five repeats of the slowest flow all reached the final frame before it
 *  ended — but nothing tied the two together, and a faster bridge shortens the wait
 *  without shortening the load.
 *
 *  BOTH halves of the predicate are load-bearing: `getMissingTileCount() === 0` alone
 *  goes true while the frame is still being composited, and hash equality alone accepts
 *  a plateau mid-load. Reachability is checked rather than assumed — an absent accessor
 *  would make `?? 0` read as "nothing in flight", the vacuous shape #1444 warns about,
 *  and cutting the accessor confirms the assertion below names exactly that half.
 *
 *  The `invalidate()` call is a driver of last resort, and measured NOT load-bearing on
 *  this page: cutting it leaves the gate green, because the demo's own rAF loop already
 *  advances frames. It stays for a runner whose background rAF is throttled — but do not
 *  read it as a mechanism this gate depends on. */
async function settle(page: Page, timeoutMs = 60_000): Promise<{ hash: number; nonBg: number }> {
  const hasCounter = await page.evaluate(
    () => typeof (window as unknown as MapWin).__xgisMap?.getMissingTileCount === 'function',
  )
  expect(hasCounter, 'getMissingTileCount() is unreachable — settle() would be vacuous').toBe(true)

  const deadline = Date.now() + timeoutMs
  let prev = await readFrame(page)
  let stable = 0
  while (Date.now() < deadline) {
    await page.evaluate(() => (window as unknown as MapWin).__xgisMap?.invalidate?.())
    await page.waitForTimeout(80)
    const cur = await readFrame(page)
    const inFlight = await page.evaluate(() =>
      (window as unknown as MapWin).__xgisMap!.getMissingTileCount!(),
    )
    if (inFlight === 0 && cur.ok && prev.ok && cur.hash === prev.hash) {
      if (++stable >= 2) return { hash: cur.hash, nonBg: cur.nonBg }
    } else {
      stable = 0
    }
    prev = cur
  }
  return prev.ok ? { hash: prev.hash, nonBg: prev.nonBg } : { hash: 0, nonBg: 0 }
}

const shoot = async (page: Page, path: string): Promise<PNG> => {
  const buf = await page.locator('#xg-canv, canvas').first().screenshot({ path })
  return PNG.sync.read(buf)
}

function diff(a: PNG, b: PNG): number {
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2]
    )
      n++
  }
  return n
}

/** Dominant land colour: the most frequent non-background pixel. */
function dominant(png: PNG): [number, number, number] {
  const counts = new Map<number, number>()
  const bg = (png.data[0]! << 16) | (png.data[1]! << 8) | png.data[2]!
  for (let i = 0; i < png.data.length; i += 4) {
    const key = (png.data[i]! << 16) | (png.data[i + 1]! << 8) | png.data[i + 2]!
    if (key === bg) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best = 0
  let bestKey = 0
  for (const [k, c] of counts) {
    if (c > best) {
      best = c
      bestKey = k
    }
  }
  return [(bestKey >> 16) & 255, (bestKey >> 8) & 255, bestKey & 255]
}

test('color_switcher: "Rose fill" recolours the live layer', async ({ page }) => {
  test.setTimeout(240_000)
  await boot(page, 'color_switcher')
  await expect(page.locator('#demo-actions')).toBeVisible()
  const before = await shoot(page, `${DIR}/actions-color-before.png`)
  const [, , bBlue] = dominant(before)

  await page.getByRole('button', { name: 'Rose fill' }).click()
  await settle(page)
  const after = await shoot(page, `${DIR}/actions-color-after.png`)
  const [aRed, , aBlue] = dominant(after)

  const d = diff(before, after)
  console.log(
    `[demo-actions] color diff=${d}/${before.width * before.height} dominant before(b=${bBlue}) after(r=${aRed},b=${aBlue})`,
  )
  // Sky (#0ea5e9, blue-dominant) → rose (#f43f5e, red-dominant): the land
  // mass recolours (≫ noise floor) and the dominant channel flips.
  expect(d).toBeGreaterThan(50_000)
  expect(aRed).toBeGreaterThan(aBlue)
  expect(bBlue).toBeGreaterThan(150)
})

test('fly_to: "Seoul" moves the camera; actionless demos hide the bar', async ({ page }) => {
  test.setTimeout(240_000)
  await boot(page, 'fly_to')
  await expect(page.locator('#demo-actions')).toBeVisible()
  const before = await shoot(page, `${DIR}/actions-fly-before.png`)

  await page.getByRole('button', { name: 'Seoul' }).click()
  await settle(page)
  const after = await shoot(page, `${DIR}/actions-fly-after.png`)

  const d = diff(before, after)
  console.log(`[demo-actions] fly diff=${d}/${before.width * before.height} hash=${page.url()}`)
  expect(d).toBeGreaterThan(100_000) // world view → z8 Seoul: most of the frame changes
  const hash = await page.evaluate(() => location.hash)
  expect(hash).toContain('8.00') // zoom 8 reached the camera hash sync

  await boot(page, 'minimal')
  await expect(page.locator('#demo-actions')).toBeHidden()
})

const getBearing = (page: Page): Promise<number> =>
  page.evaluate(() =>
    (window as unknown as { __xgisMap: { getBearing(): number } }).__xgisMap.getBearing(),
  )

test('camera_around_point: Start spins the bearing, Stop halts it', async ({ page }) => {
  test.setTimeout(240_000)
  await boot(page, 'camera_around_point')
  await expect(page.locator('#demo-actions')).toBeVisible()
  const before = await getBearing(page)
  const frameBefore = await shoot(page, `${DIR}/actions-rotate-before.png`)

  await page.getByRole('button', { name: 'Start rotation' }).click()
  await page.waitForTimeout(700)
  const during = await getBearing(page)
  // ~12°/s: 700ms of rotation moves the bearing well past noise.
  const spun = (during - before + 360) % 360
  expect(spun).toBeGreaterThan(2)

  await page.getByRole('button', { name: 'Stop rotation' }).click()
  const atStop = await getBearing(page)
  await page.waitForTimeout(500)
  const afterStop = await getBearing(page)
  expect(Math.abs(afterStop - atStop)).toBeLessThan(0.01)

  await settle(page)
  const frameAfter = await shoot(page, `${DIR}/actions-rotate-after.png`)
  const d = diff(frameBefore, frameAfter)
  console.log(`[demo-actions] rotate bearing ${before}→${afterStop} framediff=${d}`)
  expect(d).toBeGreaterThan(10_000) // the tilted world visibly rotated
})

test('animate_point_route: Start moves the marker along the route', async ({ page }) => {
  test.setTimeout(240_000)
  await boot(page, 'animate_point_route')
  await expect(page.locator('#demo-actions')).toBeVisible()

  // The moving point is a Marker DOM overlay (#1262), not a canvas pixel —
  // read its on-screen x from the element's bounding box (the map's own
  // project() drives the transform, so this can't drift from the render).
  const markerX = (): Promise<number | null> =>
    page.evaluate(() => {
      const el = document.querySelector('.route-marker') as HTMLElement | null
      return el ? el.getBoundingClientRect().left : null
    })

  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await page.waitForSelector('.route-marker', { timeout: 10_000 })
  const x0 = await markerX()
  // 10s loop: 1.5s ≈ 15% of the SF→DC arc — several hundred px of travel.
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  const x1 = await markerX()

  // The tick loop must not have crashed (a dead rAF / lost GPU context would
  // freeze the marker at SF or surface a TypeError).
  const errText = await page.locator('#error-msg').textContent()
  expect(errText ?? '').not.toMatch(/TypeError|undefined/)

  console.log(`[demo-actions] route marker x ${x0} → ${x1}`)
  expect(x0).not.toBeNull()
  expect(x1).not.toBeNull()
  // SF→DC runs west→east: the marker travels right by far more than jitter.
  expect(x1! - x0!).toBeGreaterThan(30)
})
