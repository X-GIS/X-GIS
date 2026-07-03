// iter-334 — real-user interaction stress: pan / zoom-in / zoom-out /
// rotate / pitch / combined over Korea (dense bilingual labels), then
// after each phase dump ALL drawn labels and run the render-y analyzer
// (same math as /debug-labels.html). Asserts the iter-333 bilingual
// vertical-collapse fix holds under live camera motion + that no label
// develops [줄겹침] (rendered lines out of order), [렌더Y이탈] (intra-
// line render-y spread), or [x역순] (non-monotonic x). Real GPU
// (chromium WebGPU), live OFM Bright glyphs.

import { test, expect } from '@playwright/test'

test('label interaction stress — Korea bilingual, no collapse under motion', async ({ page }) => {
  test.setTimeout(180_000)
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.setViewportSize({ width: 414, height: 896 })
  await page.goto('/debug-labels.html?style=openfreemap-bright#7/37.0/127.5', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => !!(window as unknown as { __xgisMap?: unknown }).__xgisMap,
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(9_000) // initial tiles + glyph PBF

  const reports = await page.evaluate(async () => {
    interface DG {
      cp: number
      x: number
      y: number
      bearingY: number
      height: number
      rfs: number
    }
    interface DL {
      text: string
      fontSize: number
      curved: boolean
      glyphs: DG[]
    }
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
          setLabelDumpFilter(s: string): void
          getDumpedLabels(): DL[] | null
        }
      }
    ).__xgisMap
    const R = 6378137,
      RAD = Math.PI / 180
    const setView = (lon: number, lat: number, zoom: number, bearing: number, pitch: number) => {
      const c = m.getCamera()
      c.zoom = Math.max(0, Math.min(c.maxZoom, zoom))
      c.centerX = lon * RAD * R
      const cl = Math.max(-85.05, Math.min(85.05, lat))
      c.centerY = Math.log(Math.tan(Math.PI / 4 + (cl * RAD) / 2)) * R
      c.bearing = bearing
      c.pitch = pitch
      m.markCameraPositioned()
      m.invalidate?.()
    }
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    const renderY = (g: DG, fs: number) => {
      const scale = fs / (g.rfs || fs || 1)
      return g.y - g.bearingY * scale + (g.height * scale) / 2
    }
    const analyze = async (): Promise<{ total: number; bad: { text: string; why: string }[] }> => {
      m.setLabelDumpFilter('')
      m.invalidate?.()
      await sleep(450)
      const labels = m.getDumpedLabels() ?? []
      const bad: { text: string; why: string }[] = []
      for (const l of labels) {
        // Line-following labels (roads/rivers) place glyphs along a curve
        // — the stacked-line check doesn't apply. Point labels only.
        if (l.curved) continue
        const lines = new Map<number, DG[]>()
        for (const g of l.glyphs) {
          // Skip glyphs that render NOTHING (newline, space, any blank):
          // a zero-ink glyph has no quad on screen, so its bearingY (often
          // a junk negative for spaces) must not count toward render-y.
          if (g.cp === 10 || g.height <= 0) continue
          const k = Math.round(g.y)
          if (!lines.has(k)) lines.set(k, [])
          lines.get(k)!.push(g)
        }
        const ks = [...lines.keys()].sort((a, b) => a - b)
        const lineRY: number[] = []
        let why = ''
        for (const k of ks) {
          const gs = lines.get(k)!
          const rys = gs.map((g) => renderY(g, l.fontSize))
          lineRY.push((Math.min(...rys) + Math.max(...rys)) / 2)
          for (let i = 1; i < gs.length; i++) if (gs[i]!.x <= gs[i - 1]!.x) why = 'x역순'
          if (Math.max(...rys) - Math.min(...rys) > l.fontSize * 0.6)
            why = `렌더Y이탈 ${(Math.max(...rys) - Math.min(...rys)).toFixed(0)}`
        }
        for (let i = 1; i < lineRY.length; i++)
          if (lineRY[i]! <= lineRY[i - 1]! + 1)
            why = `줄겹침 ${lineRY[i]!.toFixed(0)}<=${lineRY[i - 1]!.toFixed(0)}`
        if (why) bad.push({ text: l.text.replace(/\n/g, '\\n'), why })
      }
      return { total: labels.length, bad }
    }
    type Phase = [
      string,
      [number, number, number, number, number],
      [number, number, number, number, number],
    ]
    const phases: Phase[] = [
      ['pan-Seoul→Busan', [127, 37.5, 7, 0, 0], [129, 35.2, 7, 0, 0]],
      ['zoom-in 6→13', [127, 37.5, 6, 0, 0], [127, 37.5, 13, 0, 0]],
      ['zoom-out 13→4', [127, 37.5, 13, 0, 0], [127, 37.5, 4, 0, 0]],
      ['rotate 0→90', [127, 37.5, 8, 0, 0], [127, 37.5, 8, 90, 0]],
      ['pitch 0→60', [127, 37.5, 12, 0, 0], [127, 37.5, 12, 0, 60]],
      ['combined tilt+rotate+zoom', [127, 37.5, 9, 0, 0], [129, 35, 11, 45, 55]],
    ]
    const out: { phase: string; total: number; bad: { text: string; why: string }[] }[] = []
    for (const [name, s, e] of phases) {
      const steps = 14
      for (let i = 0; i <= steps; i++) {
        const t = i / steps
        setView(
          s[0] + (e[0] - s[0]) * t,
          s[1] + (e[1] - s[1]) * t,
          s[2] + (e[2] - s[2]) * t,
          s[3] + (e[3] - s[3]) * t,
          s[4] + (e[4] - s[4]) * t,
        )
        await sleep(110)
      }
      const r = await analyze()
      out.push({ phase: name, ...r })
    }
    return out
  })

  let totalBad = 0
  for (const r of reports) {
    console.log(
      `[${r.phase}] ${r.total} labels, ${r.bad.length} bad` +
        (r.bad.length ? ': ' + r.bad.map((b) => `"${b.text}"(${b.why})`).join(', ') : ''),
    )
    totalBad += r.bad.length
  }
  console.log(`TOTAL BAD across all phases: ${totalBad}; pageErrors: ${pageErrors.length}`)
  expect(pageErrors, pageErrors.slice(0, 3).join(' | ')).toHaveLength(0)
  expect(totalBad, 'labels with collapse/scatter under interaction').toBe(0)
})
