import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'

// Fast, hang-proof diagnostic. The page can HANG on headless Metal (runWebGPU
// awaits requestAdapter with no timeout → Promise.all never settles). So probe
// capabilities DIRECTLY with short timeouts and write a digest within ~60s,
// regardless of whether the page's own run completes.
test.setTimeout(90_000)
test('df64 probe on macOS Metal', async ({ page }) => {
  const errs: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text())
  })
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))

  await page.goto('/shader-dsl/fp64-probe', { waitUntil: 'domcontentloaded' })

  // ── capability check FIRST (time-boxed, cannot hang the test) ──
  const cap = await page.evaluate(async () => {
    const race = <T>(p: Promise<T>, ms: number) =>
      Promise.race<T | 'TIMEOUT'>([p, new Promise<'TIMEOUT'>((r) => setTimeout(() => r('TIMEOUT'), ms))])
    let gpu = ''
    try {
      const g: any = (navigator as any).gpu
      if (!g) gpu = 'no navigator.gpu'
      else {
        const a: any = await race(g.requestAdapter(), 10000)
        gpu = a === 'TIMEOUT' ? 'requestAdapter HUNG >10s' : a ? 'adapter ' + JSON.stringify(a.info || {}) : 'adapter null'
      }
    } catch (e) {
      gpu = 'gpu threw ' + String(e)
    }
    let gl = ''
    try {
      gl = document.createElement('canvas').getContext('webgl2') ? 'webgl2 OK' : 'webgl2 null'
    } catch (e) {
      gl = 'webgl2 threw ' + String(e)
    }
    return { gpu, gl, ua: navigator.userAgent }
  })

  // ── best-effort: give the page's own run a short window, then scrape ──
  let completed = false
  try {
    await page.waitForFunction(
      () => {
        const b = document.querySelector('#probe-copy')
        return !!b && !b.classList.contains('pointer-events-none')
      },
      { timeout: 45_000 },
    )
    completed = true
  } catch {
    completed = false
  }

  const scrape = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-row]')].map((r) => {
      const name = r.getAttribute('data-row')!
      const gl = (r.querySelector(`[data-gl="${name}"]`) as HTMLElement)?.innerText.replace(/\s+/g, ' ').trim()
      const gpu = (r.querySelector(`[data-gpu="${name}"]`) as HTMLElement)?.innerText.replace(/\s+/g, ' ').trim()
      return { name, gl, gpu }
    })
    const spinners = document.querySelectorAll('.animate-spin').length
    const summary = (document.querySelector('#probe-summary') as HTMLElement)?.innerText.replace(/\s+/g, ' ').trim()
    return { rows, spinners, summary, total: rows.length }
  })

  const val = (n: string) => {
    const r = scrape.rows.find((x) => x.name === n)
    return r ? `gl=${r.gl} gpu=${r.gpu}` : 'MISSING'
  }
  const digest = [
    'df64 macOS Metal probe',
    `  gpuCheck: ${cap.gpu}`,
    `  glCheck:  ${cap.gl}`,
    `  page completed: ${completed}   spinners-pending: ${scrape.spinners}   rows: ${scrape.total}`,
    `  UA: ${cap.ua}`,
    `  summary: ${scrape.summary}`,
    `  consoleErrors: ${errs.length}`,
    '',
    `  base : ${val('dg_mb_base')}`,
    `  imul : ${val('dg_imul')}`,
    `  iboth: ${val('dg_iboth')}`,
    `  ieft : ${val('dg_mb_ieft')}`,
    `  fma_fused: ${val('dg_fma_fused')}`,
    `  mul  : ${val('mul')}   div: ${val('div')}`,
    '',
    ...scrape.rows.map((r) => `  ${r.name.padEnd(12)} gl=${(r.gl ?? '').padEnd(18)} gpu=${r.gpu ?? ''}`),
    '',
    'errors:',
    ...errs.slice(0, 12).map((e) => '  ' + e),
  ].join('\n')

  writeFileSync('_macos-probe/df64-digest.txt', digest) // cwd = playground/
  console.log('\n' + digest + '\n')
  expect(scrape.total).toBeGreaterThan(0)
})
