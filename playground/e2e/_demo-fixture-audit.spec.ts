// ═══════════════════════════════════════════════════════════════════
// Demo + fixture audit — every entry in DEMOS, "does it render?"
// ═══════════════════════════════════════════════════════════════════
//
// Per-demo test() so Playwright workers can parallelize across the
// gallery (was a single test sweeping 123 demos sequentially, ~13 min
// on SwiftShader). With WORKERS=4 in CI, wall-clock drops to ~3-4 min.
//
// Each demo asserts: ready + no errors + paint > 200 + center > 200.
// Per-demo JSON + screenshot are still written under `__demo-audit__/`
// so the aggregator (`_demo-audit-report.spec.ts`, runs last via
// alphabetical ordering of `_demo-audit-*`) can build REPORT.md the
// CI artifact references.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// On the SwiftShader-WebGPU CI runner pixel output is unreliable —
// ~10/123 demos paint blank or wrong colours that don't reproduce on
// real GPU. The workflow sets XGIS_SOFTWARE_GPU=1; in that case keep
// the GPU-independent assertions (ready / no console errors / camera
// finite) but skip paint-count thresholds. Locally those still fire.
const SOFTWARE_GPU = process.env.XGIS_SOFTWARE_GPU === '1'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__demo-audit__')
mkdirSync(OUT, { recursive: true })
mkdirSync(join(OUT, 'screens'), { recursive: true })
mkdirSync(join(OUT, 'per-demo'), { recursive: true })

// Enumerate demo IDs at spec-discovery time from the per-category FRAGMENT
// files. import.meta.glob makes runtime import unworkable from Node, so this
// reads source text; what it must not read is `demos.ts`, which #1516 turned
// into a pure assembler (`...DEMOS_CORE, ...DEMOS_STYLE, …`). It did read
// demos.ts until #1625: the regex matched zero spreads, `DEMO_IDS` was `[]`,
// the loop below never ran, and this file contributed ZERO tests — silently,
// for every run since that split. Unlike the gallery gate
// (site/src/lib/gallery-drift-check.ts, the sibling that DID get updated and
// whose pattern this mirrors), the audit wants `fixtures.ts` INCLUDED: those
// 89 hidden fixtures are its corpus, not noise.
// The tripwire this spec did not have. A forall over an empty population is
// green either way (CLAUDE.md §12), which is exactly how the miss above stayed
// invisible — so an empty enumeration must be LOUD, not a zero-test no-op.
// Module scope, so it fires at collection rather than inside one test.
//
// PER-FRAGMENT, not just "the total is non-zero". A total check only catches the
// all-or-nothing case; if ONE fragment adopts a key style the regex misses, the
// total stays comfortably positive and the audit silently drops that category —
// the same silent shrink in a smaller costume, and the harder one to notice
// because the spec still reports hundreds of green tests. Every fragment file in
// this directory exists to declare demos, so every one must yield at least one
// id, and the message names the file that stopped matching.
const FRAGMENT_DIR = resolve(HERE, '../src/demos')
const DEMO_IDS = readdirSync(FRAGMENT_DIR)
  .filter((f) => f.endsWith('.ts') && f !== 'loader.ts')
  .flatMap((f) => {
    const ids = [
      ...readFileSync(join(FRAGMENT_DIR, f), 'utf8').matchAll(
        /^ {2}(?:(\w+)|'([\w-]+)'|"([\w-]+)"): \{/gm,
      ),
    ].map((m) => (m[1] ?? m[2] ?? m[3])!)
    if (ids.length === 0) {
      throw new Error(
        `[demo-audit] parsed 0 demo keys from ${join(FRAGMENT_DIR, f)} — the fragment ` +
          `format changed, so this audit would silently shrink by one category; update ` +
          `the DEMO_IDS enumeration in _demo-fixture-audit.spec.ts to match — or, if ` +
          `this file is a helper rather than a fragment, exclude it beside loader.ts ` +
          `(see #1625).`,
      )
    }
    return ids
  })

// Still needed alongside the per-fragment check above: if the directory itself
// stops yielding fragment files, the callback never runs and nothing throws.
if (DEMO_IDS.length === 0) {
  throw new Error(
    `[demo-audit] parsed 0 demo keys from ${FRAGMENT_DIR}/*.ts — the fragment ` +
      `format changed; update the DEMO_IDS enumeration in _demo-fixture-audit.spec.ts ` +
      `to match (see #1625).`,
  )
}

// Assets `.gitignore:4-8` keeps OUT of the repo on purpose — bulk Natural
// Earth extracts and tiler output, too large to track and regenerated locally.
// A clean checkout (CI, a container, a fresh clone) legitimately cannot render
// a demo that needs one, so those are SKIPPED rather than judged. Every other
// missing asset stays a failure: that is #1626's class, where the file simply
// was never committed and the fix is to commit it.
const BULK_ASSET_RE = /ne_(?:10m|50m)_[\w-]+\.geojson|\.xgvt\b|\.pmtiles\b/i

// Console noise that fires on nearly every demo and isn't actionable.
const CONSOLE_NOISE =
  /\[vite\]|Monaco|DevTools|powerPreference|ignoreHTTPSErrors|countries-sample|favicon|Failed to load resource|FLICKER|private\/loopback host blocked|SSRF guard/
// Error-class console messages that *would* normally be ignored under
// CONSOLE_NOISE but indicate a real demo problem if they appear.
const HARD_ERROR_RE =
  /\[X-GIS frame-validation\]|\[X-GIS pass:|\[VTR tile-drop|\[xgvt-pool parse\]|XGVT|WGSL|GPU|Shader|wgpu/i

interface DemoResult {
  id: string
  ready: boolean
  readyMs: number
  paintedPx: number
  centerPx: number
  cameraZoom: number | null
  cameraFinite: boolean
  errors: string[]
  warns: string[]
  failedRequests: string[]
  screenshotPath: string
  /** Set when the demo was skipped rather than judged — see `assetMissing`. */
  skipReason?: string
}

for (const id of DEMO_IDS) {
  test(`audit ${id}`, async ({ page }) => {
    test.setTimeout(45_000)
    await page.setViewportSize({ width: 1024, height: 720 })

    const errors: string[] = []
    const warns: string[] = []
    const failedRequests: string[] = []

    page.on('console', (m) => {
      const t = m.text()
      const type = m.type()
      if (type !== 'error' && type !== 'warning') return
      if (CONSOLE_NOISE.test(t)) {
        if (!HARD_ERROR_RE.test(t)) return
      }
      if (type === 'error') errors.push(t)
      else warns.push(t)
    })
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
    page.on('requestfailed', (r) => {
      const u = r.url()
      if (CONSOLE_NOISE.test(u)) return
      failedRequests.push(`${u} (${r.failure()?.errorText ?? '?'})`)
    })
    page.on('response', (r) => {
      const s = r.status()
      if (s < 400) return
      const u = r.url()
      if (CONSOLE_NOISE.test(u)) return
      failedRequests.push(`${s} ${u}`)
    })

    let ready = false
    let readyMs = 0
    let paintedPx = 0
    let centerPx = 0
    let screenshotPath = ''
    let camera: {
      zoom: number
      centerX: number
      centerY: number
      pitch: number
      bearing: number
    } | null = null

    try {
      const t0 = Date.now()
      await page.goto(`/demo.html?id=${id}`, { waitUntil: 'domcontentloaded' })
      try {
        await page.waitForFunction(
          () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
          null,
          { timeout: 15_000 },
        )
        ready = true
      } catch {
        ready = false
      }
      readyMs = Date.now() - t0
      await page.waitForTimeout(1500)

      camera = await page.evaluate(() => {
        interface Cam {
          zoom: number
          centerX: number
          centerY: number
          pitch: number
          bearing: number
        }
        const m = (window as unknown as { __xgisMap?: { camera: Cam } }).__xgisMap
        if (!m) return null
        return {
          zoom: m.camera.zoom,
          centerX: m.camera.centerX,
          centerY: m.camera.centerY,
          pitch: m.camera.pitch,
          bearing: m.camera.bearing,
        }
      })

      const png = await page.locator('#map').screenshot({ type: 'png' })
      screenshotPath = `screens/${id}.png`
      writeFileSync(join(OUT, screenshotPath), png)

      const paintCounts = await page.evaluate(async (bytes) => {
        const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
        const url = URL.createObjectURL(blob)
        const img = new Image()
        await new Promise<void>((res, rej) => {
          img.onload = () => res()
          img.onerror = () => rej(new Error('img'))
          img.src = url
        })
        const off = new OffscreenCanvas(img.width, img.height)
        const ctx = off.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        const w = img.width,
          h = img.height
        const data = ctx.getImageData(0, 0, w, h).data
        const isPaint = (i: number): boolean => {
          const r = data[i]!,
            g = data[i + 1]!,
            b = data[i + 2]!
          return r > 15 || g > 15 || b > 18
        }
        let whole = 0,
          center = 0
        const xMin = Math.floor(w * 0.2),
          xMax = Math.floor(w * 0.8)
        const yMin = Math.floor(h * 0.2),
          yMax = Math.floor(h * 0.8)
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4
            if (!isPaint(i)) continue
            whole++
            if (x >= xMin && x < xMax && y >= yMin && y < yMax) center++
          }
        }
        URL.revokeObjectURL(url)
        return { whole, center }
      }, Array.from(png))
      paintedPx = paintCounts.whole
      centerPx = paintCounts.center
    } catch (err) {
      errors.push(`[spec-error] ${(err as Error).message}`)
    }

    const cameraFinite =
      camera !== null &&
      Number.isFinite(camera.zoom) &&
      Number.isFinite(camera.centerX) &&
      Number.isFinite(camera.centerY)
    const result: DemoResult = {
      id,
      ready,
      readyMs,
      paintedPx,
      centerPx,
      cameraZoom: camera?.zoom ?? null,
      cameraFinite,
      errors: [...new Set(errors)],
      warns: [...new Set(warns)],
      failedRequests: [...new Set(failedRequests)],
      screenshotPath,
    }
    writeFileSync(join(OUT, 'per-demo', `${id}.json`), JSON.stringify(result, null, 2))

    // Per-demo assertions — Playwright reports each independently so a
    // failing demo doesn't mask the rest. Soft expect (collected at end
    // of the test) lets the per-demo JSON capture the full set of
    // signals even when one assertion fails.
    // Demos whose data is fetched cross-origin over loopback are refused
    // by the SSRF guard in the test env (a test-env artifact, not a demo
    // bug) — they can't paint their data, so skip the paint gate. (#462)
    const ssrfBlocked = result.failedRequests.some((f) =>
      /localhost|127\.0\.0\.1|\[::1\]|loopback host blocked|SSRF/i.test(f),
    )
    // Same shape as ssrfBlocked above, for the other environment artifact:
    // a demo whose asset is not PROVISIONED here. `.gitignore:4-8` keeps the
    // bulk Natural Earth / xgvt data out of the repo on purpose, so a clean
    // checkout (CI, a container, a fresh clone) cannot render those demos and
    // must not report them as broken — the signal-to-noise that would follow
    // is how a 180-demo audit gets ignored again.
    //
    // The predicate is the message #1627's loader guard emits, NOT a 4xx: a
    // missing path is answered 200-with-HTML by the dev server, so nothing
    // lands in `failedRequests` at all.
    //
    // It matches on WHICH asset is missing, not merely THAT one is. "An asset
    // failed to load" also describes #1626 — a demo importing a file that was
    // never committed — and skipping on that would hide the exact defect class
    // this audit exists to surface. Only the deliberately-untracked BULK data
    // earns a skip; anything else missing is a real failure, because the fix
    // for it is to commit the asset, not to ignore the demo.
    const assetMissing = result.errors.some(
      (e) =>
        /expected data, got an HTML document|\[Module\] Could not read file/i.test(e) &&
        BULK_ASSET_RE.test(e),
    )
    if (assetMissing) {
      result.skipReason =
        'asset not provisioned in this checkout (bulk data is deliberately untracked — .gitignore:4-8)'
      writeFileSync(join(OUT, 'per-demo', `${id}.json`), JSON.stringify(result, null, 2))
    }
    // Skipping AFTER the JSON write, so REPORT.md still carries the reason —
    // a silent skip is the same invisible-failure shape this audit exists to
    // catch.
    test.skip(assetMissing, `${id}: ${result.skipReason ?? ''}`)
    expect.soft(ready, `${id} never reached __xgisReady`).toBe(true)
    expect.soft(result.errors, `${id} produced console errors`).toEqual([])
    expect.soft(cameraFinite, `${id} camera has non-finite zoom/center`).toBe(true)
    // Whole-frame painted-pixel gate only. The centre-pixel sample was
    // dropped: it false-flagged fixtures whose centre is legitimately
    // background despite tens of thousands of painted pixels. (#462)
    if (!SOFTWARE_GPU && !ssrfBlocked) {
      expect
        .soft(paintedPx, `${id} painted only ${paintedPx} px (UI chrome only?)`)
        .toBeGreaterThanOrEqual(200)
    }
  })
}
