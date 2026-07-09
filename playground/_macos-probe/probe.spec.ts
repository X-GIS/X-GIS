import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'

// Scrapes the live df64 probe (no clipboard — headless CI) into a text digest:
// adapter, per-backend pass counts, every per-op value, and the two decisive
// checks — does dg_mb_base COLLAPSE (runner is a faithful Apple oracle?) and do
// the integer-EFT isolation variants (dg_imul / dg_iboth) survive?
test('df64 probe on macOS Metal', async ({ page }) => {
  const errs: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text())
  })
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))

  await page.goto('/shader-dsl/fp64-probe', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => {
      const b = document.querySelector('#probe-copy')
      const s = document.querySelector('#probe-summary')
      return (
        (!!b && !b.classList.contains('pointer-events-none')) ||
        (s && /ERROR/.test(s.textContent || ''))
      )
    },
    { timeout: 220_000 },
  )

  const data = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll('[data-row]')].map((r) => {
      const name = r.getAttribute('data-row')!
      const gl = (r.querySelector(`[data-gl="${name}"]`) as HTMLElement)?.innerText
        .replace(/\s+/g, ' ')
        .trim()
      const gpu = (r.querySelector(`[data-gpu="${name}"]`) as HTMLElement)?.innerText
        .replace(/\s+/g, ' ')
        .trim()
      return { name, gl, gpu }
    })
    const summary = (document.querySelector('#probe-summary') as HTMLElement)?.innerText
      .replace(/\s+/g, ' ')
      .trim()
    let adapter = ''
    try {
      const g: any = (navigator as any).gpu
      const a = g && (await g.requestAdapter())
      const i = a?.info || {}
      adapter =
        `${i.vendor || ''} ${i.architecture || ''} ${i.device || ''}`.trim() ||
        (g ? 'adapter-no-info' : 'no-navigator.gpu')
    } catch (e) {
      adapter = 'adapter-query-failed: ' + String(e)
    }
    return { rows, summary, adapter, ua: navigator.userAgent }
  })

  const val = (n: string) => {
    const r = data.rows.find((x) => x.name === n)
    return r ? { gl: r.gl, gpu: r.gpu } : null
  }
  const lines = [
    'df64 macOS Metal probe',
    `  adapter: ${data.adapter}`,
    `  UA: ${data.ua}`,
    `  summary: ${data.summary}`,
    `  consoleErrors: ${errs.length}`,
    '',
    `  base   (must COLLAPSE if Apple): ${JSON.stringify(val('dg_mb_base'))}`,
    `  imul   (int product, no cancel): ${JSON.stringify(val('dg_imul'))}`,
    `  iboth  (both products int)     : ${JSON.stringify(val('dg_iboth'))}`,
    `  ieft   (cross int only)        : ${JSON.stringify(val('dg_mb_ieft'))}`,
    `  fma_fused (Apple fma fused?)   : ${JSON.stringify(val('dg_fma_fused'))}`,
    `  mul / div                      : ${JSON.stringify(val('mul'))} / ${JSON.stringify(val('div'))}`,
    '',
    ...data.rows.map(
      (r) => `  ${r.name.padEnd(12)} gl=${(r.gl ?? '').padEnd(18)} gpu=${r.gpu ?? ''}`,
    ),
    '',
    'errors:',
    ...errs.slice(0, 10).map((e) => '  ' + e),
  ]
  const digest = lines.join('\n')
  writeFileSync('_macos-probe/df64-digest.txt', digest) // cwd = playground/ (see workflow)
  console.log('\n' + digest + '\n')
  expect(data.rows.length).toBeGreaterThan(0)
})
