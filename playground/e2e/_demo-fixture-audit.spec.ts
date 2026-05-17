// ═══════════════════════════════════════════════════════════════════
// Demo + fixture audit — every entry in DEMOS, "does it render?"
// ═══════════════════════════════════════════════════════════════════
//
// _fixture-audit.spec.ts measures perf on tag==='fixture' only.
// smoke.spec.ts hard-codes 5 demos. _new-fixtures-smoke.spec.ts covers
// 5 new fixtures. None of them sweep the full DEMOS Record asking the
// single question the user actually has: "did this entry render at all,
// without errors, on a fresh page load?"
//
// This spec answers that for every entry, captures a screenshot, and
// produces __demo-audit__/REPORT.md listing the broken ones.

import { test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__demo-audit__')
mkdirSync(OUT, { recursive: true })
mkdirSync(join(OUT, 'screens'), { recursive: true })

// Console noise that fires on nearly every demo and isn't actionable.
const CONSOLE_NOISE = /\[vite\]|Monaco|DevTools|powerPreference|ignoreHTTPSErrors|countries-sample|favicon|Failed to load resource|FLICKER/

// Error-class console messages that *would* normally be ignored under
// CONSOLE_NOISE but indicate a real demo problem if they appear.
const HARD_ERROR_RE = /\[X-GIS frame-validation\]|\[X-GIS pass:|\[VTR tile-drop|\[xgvt-pool parse\]|XGVT|WGSL|GPU|Shader|wgpu/i

interface DemoMeta {
  id: string
  name: string
  tag: string
  description: string
}

interface DemoResult {
  id: string
  tag: string
  name: string
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
}

test('audit every DEMOS entry', async ({ page }) => {
  // Cap at 30 min — single worker, ~15-20 s per demo worst case.
  test.setTimeout(30 * 60_000)
  await page.setViewportSize({ width: 1024, height: 720 })

  // Pull the full demo list (id + tag + name) from the playground bundle
  // at runtime so this spec stays in sync with demos.ts without
  // re-hardcoding 65 ids.
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const demos = await page.evaluate(async () => {
    const mod = await import('/src/demos.ts')
    const DEMOS = (mod as unknown as {
      DEMOS: Record<string, { name: string; tag: string; description: string }>
    }).DEMOS
    return Object.entries(DEMOS).map(([id, d]) => ({
      id, name: d.name, tag: d.tag, description: d.description,
    }))
  })

  // eslint-disable-next-line no-console
  console.log(`[demo-audit] sweeping ${demos.length} demos…`)

  const results: DemoResult[] = []

  for (const meta of demos as DemoMeta[]) {
    const errors: string[] = []
    const warns: string[] = []
    const failedRequests: string[] = []

    const onConsole = (m: import('@playwright/test').ConsoleMessage): void => {
      const t = m.text()
      const type = m.type()
      // Only error/warning types count toward broken-status. Info / log
      // messages (e.g. "[X-GIS] Rebuilt layers (GPU projection: mercator)")
      // are normal status output even though they match HARD_ERROR_RE.
      if (type !== 'error' && type !== 'warning') return
      if (CONSOLE_NOISE.test(t)) {
        // HARD_ERROR_RE wins back through the noise filter.
        if (!HARD_ERROR_RE.test(t)) return
      }
      if (type === 'error') errors.push(t)
      else warns.push(t)
    }
    const onPageError = (e: Error): void => {
      errors.push(`[pageerror] ${e.message}`)
    }
    const onRequestFailed = (r: import('@playwright/test').Request): void => {
      const u = r.url()
      if (CONSOLE_NOISE.test(u)) return
      failedRequests.push(`${u} (${r.failure()?.errorText ?? '?'})`)
    }
    const onResponse = (r: import('@playwright/test').Response): void => {
      const s = r.status()
      if (s < 400) return
      const u = r.url()
      if (CONSOLE_NOISE.test(u)) return
      failedRequests.push(`${s} ${u}`)
    }

    page.on('console', onConsole)
    page.on('pageerror', onPageError)
    page.on('requestfailed', onRequestFailed)
    page.on('response', onResponse)

    let ready = false
    let readyMs = 0
    let paintedPx = 0
    let centerPx = 0
    let screenshotPath = ''
    let camera: { zoom: number; centerX: number; centerY: number; pitch: number; bearing: number } | null = null

    try {
      const t0 = Date.now()
      // No `&e2e=1`: that flag is ONLY used by demo-runner to skip
      // `applyFixtureAutoPush` (the inline_push / typed_array_points
      // demos rely on auto-pushed sample data to render anything at
      // all in the gallery). The audit's purpose is "does this demo
      // render when a user opens it from the gallery" — match that.
      await page.goto(`/demo.html?id=${meta.id}`, { waitUntil: 'domcontentloaded' })
      try {
        await page.waitForFunction(
          () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
          null, { timeout: 15_000 },
        )
        ready = true
      } catch {
        ready = false
      }
      readyMs = Date.now() - t0

      // Drop pre-ready noise: when the previous demo's in-flight
      // fetches (especially PMTiles range requests) get aborted by the
      // page-navigation here, their catch blocks fire in the new page's
      // console context AFTER navigation, so they look like THIS demo's
      // errors. Same for the previous demo's last-frame render-loop
      // glitches. Anything that fires after __xgisReady belongs to THIS
      // demo. (If __xgisReady never flipped, ready=false catches it via
      // a separate signal and we keep all errors as diagnosis.)
      if (ready) {
        errors.length = 0
        warns.length = 0
        failedRequests.length = 0
      }

      // Even if __xgisReady never flipped, give the page a moment to
      // surface late console errors and take a screenshot of whatever
      // it managed to draw — a blank screen + clean console is itself
      // a useful "broken silently" signal.
      await page.waitForTimeout(1500)

      // Camera-state sanity: a finite zoom is the bare minimum for the
      // projection matrix to be valid. The Infinity-zoom class
      // (lonSpan=0 in bounds-fit → Math.log2(360/0)) snuck past the
      // paintedPx heuristic because UI chrome painted ~16 k pixels even
      // when the map area was completely dark. Capture this directly.
      camera = await page.evaluate(() => {
        interface Cam { zoom: number; centerX: number; centerY: number; pitch: number; bearing: number }
        const m = (window as unknown as { __xgisMap?: { camera: Cam } }).__xgisMap
        if (!m) return null
        return {
          zoom: m.camera.zoom, centerX: m.camera.centerX, centerY: m.camera.centerY,
          pitch: m.camera.pitch, bearing: m.camera.bearing,
        }
      })

      const png = await page.locator('#map').screenshot({ type: 'png' })
      screenshotPath = `screens/${meta.id}.png`
      writeFileSync(join(OUT, screenshotPath), png)

      // Count non-background pixels. Demo background is dark
      // (~#06080c, see other specs); anything visibly bright counts.
      // Counts THREE regions independently so a "passing" status
      // requires more than UI chrome:
      //   - whole: any non-bg pixel anywhere
      //   - center: non-bg pixels in the central 60×60% region
      //     (excludes top-left zoom badge, top-right snapshot button,
      //     bottom status bar)
      //   - corners: combined count from each viewport corner — a sanity
      //     "did anything paint outside the centre" gauge for demos that
      //     legitimately paint near edges (world maps, etc)
      // The `picking_demo` + `raster_overlay` regression (commit 05f5888)
      // showed up because UI-chrome `whole > 200` passed while the map
      // area was completely dark; the `center` check below would have
      // caught it.
      const paintCounts = await page.evaluate(async (bytes) => {
        const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
        const url = URL.createObjectURL(blob)
        const img = new Image()
        await new Promise<void>((res, rej) => {
          img.onload = () => res(); img.onerror = () => rej(new Error('img'))
          img.src = url
        })
        const off = new OffscreenCanvas(img.width, img.height)
        const ctx = off.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        const w = img.width, h = img.height
        const data = ctx.getImageData(0, 0, w, h).data
        const isPaint = (i: number): boolean => {
          const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!
          return r > 15 || g > 15 || b > 18
        }
        let whole = 0, center = 0
        const xMin = Math.floor(w * 0.20), xMax = Math.floor(w * 0.80)
        const yMin = Math.floor(h * 0.20), yMax = Math.floor(h * 0.80)
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

    page.off('console', onConsole)
    page.off('pageerror', onPageError)
    page.off('requestfailed', onRequestFailed)
    page.off('response', onResponse)

    const cameraFinite = camera !== null
      && Number.isFinite(camera.zoom)
      && Number.isFinite(camera.centerX)
      && Number.isFinite(camera.centerY)
    const result: DemoResult = {
      id: meta.id,
      tag: meta.tag,
      name: meta.name,
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
    results.push(result)

    // Live progress so the user can watch the sweep. Central-region
    // < 200 catches "UI chrome only" demos that the legacy
    // `paintedPx < 200` whole-canvas check missed (picking_demo /
    // raster_overlay before commit 05f5888).
    const status = !ready ? '✗ NO-READY'
      : result.errors.length > 0 ? '✗ ERR'
      : !cameraFinite ? '✗ CAM-NONFINITE'
      : paintedPx < 200 ? '⚠ BLANK'
      : centerPx < 200 ? '⚠ UI-ONLY'
      : '✓'
    // eslint-disable-next-line no-console
    console.log(
      `[demo-audit] ${status} ${meta.id.padEnd(38)} `
      + `tag=${meta.tag.padEnd(14)} `
      + `paint=${paintedPx.toString().padStart(7)} `
      + `centre=${centerPx.toString().padStart(7)} `
      + `zoom=${(camera?.zoom ?? 'n/a').toString().padStart(6)} `
      + `err=${result.errors.length} `
      + `warn=${result.warns.length} `
      + `req4xx=${result.failedRequests.length}`,
    )
  }

  // ── REPORT.md ─────────────────────────────────────────────────────
  // `centerPx < 200` catches the "UI chrome alone" case that fooled
  // the prior `paintedPx < 200` check (picking_demo / raster_overlay
  // pre-05f5888 had paintedPx ~40k but centerPx near 0).
  const broken = results.filter(r =>
    !r.ready || r.errors.length > 0 || !r.cameraFinite
    || r.paintedPx < 200 || r.centerPx < 200,
  )
  const lines: string[] = []
  lines.push('# Demo + fixture audit')
  lines.push('')
  lines.push(`**Total**: ${results.length} | `
    + `**Broken**: ${broken.length} | `
    + `**Healthy**: ${results.length - broken.length}`)
  lines.push('')

  // Failures first.
  lines.push('## Broken')
  lines.push('')
  if (broken.length === 0) {
    lines.push('_None_')
  } else {
    lines.push('| ID | Tag | Ready | Painted | Errors | First error |')
    lines.push('|---|---|---:|---:|---:|---|')
    for (const r of broken) {
      const firstErr = (r.errors[0] ?? '').replace(/\|/g, '\\|').slice(0, 140)
      lines.push(
        `| \`${r.id}\` | ${r.tag} | ${r.ready ? 'Y' : '**N**'} `
        + `| ${r.paintedPx} | ${r.errors.length} | ${firstErr} |`,
      )
    }
    lines.push('')

    // Detail expansion per broken demo.
    lines.push('### Detail')
    for (const r of broken) {
      lines.push('')
      lines.push(`#### \`${r.id}\` (${r.tag})`)
      lines.push(`- Ready: ${r.ready ? '✓' : '✗'} (${r.readyMs} ms)`)
      lines.push(`- Painted pixels: ${r.paintedPx}`)
      lines.push(`- Screenshot: \`${r.screenshotPath}\``)
      if (r.errors.length > 0) {
        lines.push(`- Errors (${r.errors.length}):`)
        for (const e of r.errors.slice(0, 8)) lines.push(`  - \`${e.slice(0, 240)}\``)
      }
      if (r.failedRequests.length > 0) {
        lines.push(`- Failed requests (${r.failedRequests.length}):`)
        for (const f of r.failedRequests.slice(0, 6)) lines.push(`  - \`${f.slice(0, 240)}\``)
      }
    }
  }

  // Full table.
  lines.push('')
  lines.push('## All demos')
  lines.push('')
  lines.push('| ID | Tag | Ready | Painted | Errors | Warns |')
  lines.push('|---|---|---:|---:|---:|---:|')
  for (const r of [...results].sort((a, b) => a.id.localeCompare(b.id))) {
    const ok = r.ready && r.errors.length === 0 && r.paintedPx >= 200
    lines.push(
      `| ${ok ? '' : '**'}\`${r.id}\`${ok ? '' : '**'} | ${r.tag} | `
      + `${r.ready ? 'Y' : '**N**'} | ${r.paintedPx} | ${r.errors.length} | ${r.warns.length} |`,
    )
  }

  writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n'))
  writeFileSync(join(OUT, 'full.json'), JSON.stringify(results, null, 2))

  // eslint-disable-next-line no-console
  console.log(
    `\n[demo-audit] DONE: ${results.length} demos, ${broken.length} broken.`
    + `\n  Report: ${join(OUT, 'REPORT.md')}`,
  )

  // Actually fail the test when something is broken — otherwise CI
  // sees a green check even with 14 NO-READY demos. The report stays
  // informational AND the gate is real.
  if (broken.length > 0) {
    const summary = broken.slice(0, 10).map(r => {
      const reason = !r.ready ? 'NO-READY'
        : !r.cameraFinite ? 'CAM-NONFINITE'
        : r.errors.length > 0 ? `ERR(${r.errors[0]?.slice(0, 60) ?? '?'})`
        : `BLANK(paint=${r.paintedPx})`
      return `  ${r.id} [${r.tag}]: ${reason}`
    }).join('\n')
    throw new Error(
      `[demo-audit] ${broken.length} of ${results.length} demos broken:\n${summary}` +
      (broken.length > 10 ? `\n  …and ${broken.length - 10} more (see REPORT.md)` : ''),
    )
  }
})
