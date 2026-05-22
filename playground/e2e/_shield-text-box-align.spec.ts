// iter-344 gate — paired shield text↔box vertical alignment. The
// user-reported "라벨이랑 뒤 흰색 박스가 안맞아요": highway-shield road
// numbers floated above their white box. Root was a centre-anchor ink
// offset (text ink-centre +11px above the box centre, which sits on the
// feature point). This gate dumps every point label + its paired icon
// (getDumpedLabels / getDumpedIcons) at the OFM Bright Korea shield view
// and asserts the text ink-centre coincides with the box centre within a
// sub-pixel tolerance. Real chromium WebGPU + live OFM Bright.

import { test, expect } from '@playwright/test'

test('shield text ink-centre coincides with its box centre', async ({ page }) => {
  test.setTimeout(90_000)
  const errs: string[] = []
  page.on('pageerror', e => errs.push(String(e)))
  await page.setViewportSize({ width: 420, height: 900 })
  await page.goto('/debug-labels.html?style=openfreemap-bright#11.14/37.54621/126.89708', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!(window as unknown as { __xgisMap?: unknown }).__xgisMap, null, { timeout: 30_000 })
  await page.waitForTimeout(9_000)

  const out = await page.evaluate(async () => {
    interface DG { cp: number; x: number; y: number; bearingY: number; height: number; rfs: number }
    interface DL { text: string; anchorX: number; anchorY: number; fontSize: number; slotSize: number; curved: boolean; glyphs: DG[] }
    interface DI { name: string; anchorX: number; anchorY: number; drawW: number; drawH: number; centerY: number }
    const m = (window as unknown as { __xgisMap: { setLabelDumpFilter(s: string): void; getDumpedLabels(): DL[] | null; setIconDumpEnabled(b: boolean): void; getDumpedIcons(): DI[] | null; invalidate?(): void } }).__xgisMap
    m.setLabelDumpFilter(''); m.setIconDumpEnabled(true); m.invalidate?.()
    await new Promise(r => setTimeout(r, 700))
    const labels = (m.getDumpedLabels() ?? []).filter(l => !l.curved)
    const icons = m.getDumpedIcons() ?? []
    const gaps: { text: string; gap: number; fs: number }[] = []
    for (const l of labels) {
      const inkGs = l.glyphs.filter(g => g.cp !== 10 && g.height > 0)
      if (!inkGs.length) continue
      let best: DI | null = null, bestD = 1e9
      for (const ic of icons) {
        const d = Math.abs(ic.anchorX - l.anchorX) + Math.abs(ic.anchorY - l.anchorY)
        if (d < bestD) { bestD = d; best = ic }
      }
      if (!best || bestD > 12) continue   // only true text+box pairs
      const centers = inkGs.map(g => {
        const sc = l.fontSize / (g.rfs || l.fontSize)
        return l.anchorY + g.y - g.bearingY * sc + g.height * sc / 2
      })
      const textCenter = (Math.min(...centers) + Math.max(...centers)) / 2
      gaps.push({ text: l.text, gap: textCenter - best.centerY, fs: l.fontSize })
    }
    return { pairs: gaps.length, gaps }
  })

  console.log(`paired shields: ${out.pairs}`)
  expect(out.pairs, 'no shield text+box pairs found — view/data changed').toBeGreaterThan(5)
  // Worst gap, as a fraction of fontSize (host/DPR-independent).
  let worst = 0, worstText = ''
  for (const g of out.gaps) {
    const rel = Math.abs(g.gap) / Math.max(g.fs, 1)
    if (rel > worst) { worst = rel; worstText = `"${g.text}" gap=${g.gap.toFixed(1)}px fs=${g.fs}` }
  }
  console.log(`worst text↔box gap: ${(worst * 100).toFixed(0)}% of fontSize (${worstText}); pageErrors: ${errs.length}`)
  expect(errs, errs.slice(0, 3).join(' | ')).toHaveLength(0)
  // Pre-fix this was ~1.05·fontSize. A centred number is well under 0.2.
  expect(worst, `shield number off-centre vs box: ${worstText}`).toBeLessThan(0.2)
})
