import { test, expect } from '@playwright/test'

// §5 parity gate for the DECLARATIVE `| arrow bearing-[.dir]` layer (#1302).
//
// The declarative arrow layer reuses the retained-arrow packer (packCompiledArrowFeat ≡
// packRetainedArrowFeat, unit-proven byte-identical), the SAME RetainedArrowDraper, and the
// SAME per-copy pointU uniform — so for matched per-feature inputs it MUST rasterise
// pixel-identically to the host `map.graphics.add({type:'arrow'})` primitive. This gate
// proves the end-to-end WIRING actually feeds those identical buffers to the draw:
//
//   A) render one arrow via the DECLARATIVE layer  (isArrow fork → addCompiledArrowLayer),
//      by pushing a single station into the layer's source with setSourceData;
//   B) render the SAME arrow via the RETAINED host API (the proven primitive), leaving the
//      source empty so the declarative layer draws nothing.
//
// Both run on WebGl2Device (?forcegl2=1, SwiftShader headless), same style, same hash camera,
// clear background — so the arrow-region diff isolates declarative-vs-retained parity. A
// wiring bug (wrong position/orientation, bad bind group, mis-evaluated bearing) is a
// non-empty diff; a dropped declarative arrow fails the "arrow present" red-probe. Runs
// GPU-less (HEADED=0 XGIS_SOFTWARE_GPU=1).

const LON = 0
const LAT = 20
const COLOR = '#ff0000' // fill-red → resolveColor('red') = #ff0000; retained getColor matches exactly

// One style for both captures (identical background → the diff is only the arrow). The
// declarative arrow appears only once its source has data; leaving it empty draws nothing.
const STYLE = `xgis 1
source stations { type: geojson }
layer arrows { source: stations | arrow bearing-[.dir] size-[.sz] fill-red }
`

const ONE_STATION = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [LON, LAT] },
      properties: { dir: 90, sz: 200 },
    },
  ],
}

// Read back a box around the arrow shaft (east of centre) as raw RGBA, plus a red-texel
// count so a blank frame (arrow dropped) is caught independently of the diff.
function readArrowBox() {
  const w = window as unknown as {
    __xgisMap?: { ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } } }
  }
  const gl = w.__xgisMap?.ctx?.rhi?.gl
  if (!gl) return { ok: false as const, reason: 'no gl' }
  const W = gl.drawingBufferWidth
  const H = gl.drawingBufferHeight
  // Box spanning the shaft: from just left of centre to well into the shaft (east), a band
  // around the centre row. Same box for both captures, so the GL bottom-up origin cancels.
  const x0 = Math.floor(W / 2 - 12)
  const y0 = Math.floor(H / 2 - 40)
  const bw = 150
  const bh = 80
  const buf = new Uint8Array(bw * bh * 4)
  gl.readPixels(x0, y0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  let red = 0
  for (let i = 0; i < bw * bh; i++) {
    if (buf[i * 4] > 170 && buf[i * 4 + 1] < 90 && buf[i * 4 + 2] < 90) red++
  }
  return {
    ok: true as const,
    backend: w.__xgisMap?.ctx?.rhi?.backend,
    glError: gl.getError(),
    red,
    box: bw * bh,
    bytes: Array.from(buf),
  }
}

test('declarative `| arrow` rasterises identically to the retained arrow (WebGl2)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 600 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text())
  })

  await page.goto('/demo.html?id=minimal&forcegl2=1&e2e=1#4/20/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 20000 },
  )
  await page.waitForTimeout(300)

  // ── A) DECLARATIVE arrow: run the style, push one station into the arrow layer's source. ──
  await page.evaluate(
    async ({ style, fc }) => {
      const w = window as unknown as {
        __xgisRunSource?: (s: string) => Promise<unknown>
        __xgisMap?: { setSourceData(id: string, fc: unknown): void; invalidate?: () => void }
      }
      await w.__xgisRunSource!(style)
      w.__xgisMap!.setSourceData('stations', fc)
      w.__xgisMap!.invalidate?.()
    },
    { style: STYLE, fc: ONE_STATION },
  )
  await page.waitForTimeout(900)
  const decl = await page.evaluate(readArrowBox)

  // ── B) RETAINED arrow: reset the SAME style (empty source → no declarative arrow), add the
  //       SAME arrow via the host API. ──
  await page.evaluate(
    async ({ style, lon, lat, color }) => {
      const w = window as unknown as {
        __xgisRunSource?: (s: string) => Promise<unknown>
        __xgisMap?: { graphics: { add(spec: unknown): unknown }; invalidate?: () => void }
      }
      await w.__xgisRunSource!(style)
      w.__xgisMap!.graphics.add({
        type: 'arrow',
        data: [0],
        getPosition: [lon, lat],
        getBearing: 90,
        getSize: 200,
        getColor: color,
      })
      w.__xgisMap!.invalidate?.()
    },
    { style: STYLE, lon: LON, lat: LAT, color: COLOR },
  )
  await page.waitForTimeout(900)
  const ret = await page.evaluate(readArrowBox)

  // Both frames provably originated on WebGl2Device with no gl error.
  expect(decl.ok && ret.ok, 'forced-WebGL2 context present in both captures').toBe(true)
  if (!decl.ok || !ret.ok) return
  expect(decl.backend, 'declarative backend').toBe('webgl2')
  expect(ret.backend, 'retained backend').toBe('webgl2')
  expect(decl.glError, 'no gl error (declarative)').toBe(0)
  expect(ret.glError, 'no gl error (retained)').toBe(0)
  expect(errors, 'no page/console errors').toEqual([])

  // The declarative arrow ACTUALLY rendered (a dropped layer / broken wiring reads ~0 red).
  // The retained arrow is the proven reference; require BOTH to paint a solid red shaft.
  expect(decl.red, `declarative red shaft texels ${decl.red}/${decl.box}`).toBeGreaterThan(
    decl.box * 0.08,
  )
  expect(ret.red, `retained red shaft texels ${ret.red}/${ret.box}`).toBeGreaterThan(ret.box * 0.08)

  // PARITY: the declarative and retained arrow boxes must match pixel-for-pixel (same packer,
  // draper, shader, uniform → same coverage). Allow a tiny tolerance for any SwiftShader
  // nondeterminism; a real positional/orientation/colour divergence is thousands of px.
  let dc = 0
  for (let i = 0; i < decl.bytes.length; i += 4) {
    const dr = Math.abs(decl.bytes[i] - ret.bytes[i])
    const dg = Math.abs(decl.bytes[i + 1] - ret.bytes[i + 1])
    const db = Math.abs(decl.bytes[i + 2] - ret.bytes[i + 2])
    if (dr > 12 || dg > 12 || db > 12) dc++
  }
  const px = decl.box
  console.log(
    `[PARITY-METRICS] declRed=${decl.red}/${decl.box} retRed=${ret.red}/${ret.box} dc=${dc}/${px} ratio=${(dc / px).toFixed(5)}`,
  )
  // Local SwiftShader measured dc=0 (pixel-identical); the small tolerance only guards CI
  // driver nondeterminism. A real positional/orientation/colour divergence is ~5640 px (the
  // whole arrow), so this still fails loudly on any genuine parity break.
  expect(dc, `arrow-box changed pixels ${dc}/${px} (declarative vs retained)`).toBeLessThan(
    px * 0.005,
  )
})
