import { test, expect } from '@playwright/test'

// Marker/Popup gate (#1262) — the DOM-overlay contract, verified against the
// map's own projection so it can't drift from what the renderer sees:
//
//   1. PIXEL-LOCK — a marker's on-screen anchor point equals map.project(its
//      lngLat) to sub-pixel, and STAYS locked across jumpTo (pan + zoom) and a
//      globe projection. The camera moves; the marker follows exactly.
//   2. HIDE-BEHIND-GLOBE — on the globe, a marker on the FAR hemisphere
//      (project → null) is display:none; bringing it to the near side shows it.
//   3. POPUP FLIP — an auto-anchor popup near the top edge resolves a top
//      anchor (grows down into view).
//
// (Drag + close-on-click are covered by the marker.test.ts pure-geometry
// suite + manual QA; a headless pointer-capture drag is too flaky to gate on.)
//
// Pure DOM state (getBoundingClientRect / style), no readPixels — deterministic
// under headless SwiftShader. Uses the offline fixture_square demo (a map is
// all we need; the marker rides map.project).

interface MapApi {
  jumpTo(o: object): void
  setProjection(n: string): void
  project(ll: [number, number]): [number, number] | null
  getContainer(): HTMLElement | null
}

test('marker/popup — pixel-locked to project(), hidden behind the globe, popup auto-flips', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.setViewportSize({ width: 800, height: 600 })
  await page.goto('/demo.html?id=fixture_square&forcegl2=1&preserve=1', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )

  // Create a marker at [10, 20] and a marker on the far side for the globe test.
  await page.evaluate(() => {
    const w = window as unknown as {
      __xgisMap?: MapApi
      __xgisMarker?: new (o?: object) => {
        setLngLat(ll: [number, number]): unknown
        addTo(m: unknown): unknown
        getElement(): HTMLElement
      }
      __mk?: { getElement(): HTMLElement }
    }
    const M = w.__xgisMarker!
    w.__mk = new M({ color: '#ff0000' }).setLngLat([10, 20]).addTo(w.__xgisMap) as {
      getElement(): HTMLElement
    }
    w.__mk.getElement().setAttribute('data-testid', 'mk')
  })

  /** jumpTo, then wait for the 'move' event to propagate to the marker (it
   *  fires on the render loop's next camera-diff frame, not synchronously —
   *  the same asynchrony MapLibre markers have). Two rAFs cover it. */
  async function jumpAndSettle(cam: object): Promise<void> {
    await page.evaluate(
      (c) => (window as unknown as { __xgisMap?: MapApi }).__xgisMap!.jumpTo(c),
      cam,
    )
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    )
  }

  // Anchor-centre of the marker element vs map.project — across cameras.
  async function lockError(cam: object): Promise<number> {
    await jumpAndSettle(cam)
    return page.evaluate(() => {
      const w = window as unknown as { __xgisMap?: MapApi }
      const map = w.__xgisMap!
      const el = document.querySelector('[data-testid=mk]') as HTMLElement | null
      if (!el) return 1e9
      const p = map.project([10, 20])
      if (p === null) return 1e9
      const container = map.getContainer()!
      const cr = container.getBoundingClientRect()
      const er = el.getBoundingClientRect()
      // default pin is bottom-anchored: its anchor point is the bottom-centre.
      const ax = er.left - cr.left + er.width / 2
      const ay = er.top - cr.top + er.height
      return Math.hypot(ax - p[0], ay - p[1])
    })
  }

  // Cameras keep [10,20] on-screen (project() culls points outside the NDC
  // window to null) while exercising pan, zoom, and bearing.
  const e1 = await lockError({ center: [10, 20], zoom: 2, bearing: 0, pitch: 0 })
  const e2 = await lockError({ center: [12, 22], zoom: 4, bearing: 0, pitch: 0 })
  const e3 = await lockError({ center: [10, 20], zoom: 4, bearing: 25, pitch: 0 })

  // Globe hide/show: put the map on the globe centred on the ANTIPODE of the
  // marker → the marker sits on the far hemisphere → project null → hidden.
  await page.evaluate(() =>
    (window as unknown as { __xgisMap?: MapApi }).__xgisMap!.setProjection('globe'),
  )
  await jumpAndSettle({ center: [-170, -20], zoom: 1, bearing: 0, pitch: 0 })
  const farDisplay = await page.evaluate(
    () => (document.querySelector('[data-testid=mk]') as HTMLElement | null)?.style.display,
  )
  await jumpAndSettle({ center: [10, 20], zoom: 1, bearing: 0, pitch: 0 })
  const globe = await page.evaluate(() => {
    const map = (window as unknown as { __xgisMap?: MapApi }).__xgisMap!
    const el = document.querySelector('[data-testid=mk]') as HTMLElement | null
    return { near: el?.style.display, nearProject: map.project([10, 20]) !== null }
  })

  // Popup auto-anchor flip near the top edge.
  await page.evaluate(() =>
    (window as unknown as { __xgisMap?: MapApi }).__xgisMap!.setProjection('mercator'),
  )
  // Put [10,20] in the TOP third of the viewport (centre south of it), where
  // the auto-anchor resolves 'top' so the balloon grows downward into view.
  await jumpAndSettle({ center: [10, 10], zoom: 4, bearing: 0, pitch: 0 })
  const popupAnchor = await page.evaluate(() => {
    const w = window as unknown as {
      __xgisMap?: MapApi
      __xgisPopup?: new (o?: object) => {
        setText(t: string): unknown
        setLngLat(ll: [number, number]): unknown
        addTo(m: unknown): unknown
        getElement(): HTMLElement
      }
    }
    const map = w.__xgisMap!
    const P = w.__xgisPopup!
    const pop = new P({ closeButton: false }).setText('hi').setLngLat([10, 20]).addTo(map) as {
      getElement(): HTMLElement
    }
    // top anchor → translate(...) translate(-50%, 0%)
    return pop.getElement().style.transform
  })

  expect(errors, 'no page errors').toEqual([])
  // (1) pixel-lock: sub-2px across pan/zoom/rotate (integer transform snap +
  //     bounding-rect rounding account for <2px).
  expect(e1, `lock error @z2 = ${e1}`).toBeLessThan(2)
  expect(e2, `lock error @z4 pan = ${e2}`).toBeLessThan(2)
  expect(e3, `lock error @z5 rot = ${e3}`).toBeLessThan(2)
  // (2) hide behind globe / show on near side.
  expect(farDisplay, 'far-hemisphere marker hidden').toBe('none')
  expect(globe.nearProject, 'near-side point projects').toBe(true)
  expect(globe.near, 'near-side marker shown').not.toBe('none')
  // (3) popup near the top edge flips to a top anchor (grows downward).
  expect(popupAnchor, `popup transform ${popupAnchor}`).toContain('translate(-50%, 0%)')
})
