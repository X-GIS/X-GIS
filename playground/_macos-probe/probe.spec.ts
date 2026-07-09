import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'

// WebGL2-only Apple oracle. Rationale: on Apple the df64 collapse is a METAL
// shader-compiler property, and the device pastes show WebGL2 == WebGPU on
// every op (both funnel through Metal). WebGL2 is also the STRICTER gate (GLSL
// ES 3.00 has no fma) and the only backend headless macOS Chromium runs
// reliably — headless WebGPU can hang requestAdapter, which is why waiting on
// the page's copy button (enabled only after BOTH backends settle) timed out.
// So: wait for the WEBGL2 COLUMN to fully resolve (it fills independently of
// the WebGPU run), scrape it, and emit the digest. A time-boxed WebGPU
// capability check is kept purely as diagnostics.
test.setTimeout(180_000)
test('df64 probe on macOS Metal (WebGL2 gate)', async ({ page }) => {
  const errs: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text())
  })
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))

  await page.goto('/shader-dsl/fp64-probe', { waitUntil: 'domcontentloaded' })

  // ── diagnostics: is WebGPU even available headless? (time-boxed, can't hang) ──
  const cap = await page.evaluate(async () => {
    const race = <T>(p: Promise<T>, ms: number) =>
      Promise.race<T | 'TIMEOUT'>([p, new Promise<'TIMEOUT'>((r) => setTimeout(() => r('TIMEOUT'), ms))])
    let gpu = ''
    try {
      const g: any = (navigator as any).gpu
      if (!g) gpu = 'no navigator.gpu'
      else {
        const a: any = await race(g.requestAdapter(), 8000)
        gpu = a === 'TIMEOUT' ? 'requestAdapter HUNG >8s' : a ? 'adapter ' + JSON.stringify(a.info || {}) : 'adapter null'
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

  // ── the actual gate: WebGL2 column fully resolved (no [data-gl] spinner) ──
  let glDone = false
  try {
    await page.waitForFunction(
      () => {
        const cells = [...document.querySelectorAll('[data-gl]')]
        return cells.length > 0 && cells.every((c) => !c.querySelector('.animate-spin'))
      },
      { timeout: 120_000 },
    )
    glDone = true
  } catch {
    glDone = false
  }

  const scrape = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-row]')].map((r) => {
      const name = r.getAttribute('data-row')!
      const gl = (r.querySelector(`[data-gl="${name}"]`) as HTMLElement)?.innerText.replace(/\s+/g, ' ').trim()
      const gpu = (r.querySelector(`[data-gpu="${name}"]`) as HTMLElement)?.innerText.replace(/\s+/g, ' ').trim()
      return { name, gl, gpu }
    })
    const summary = (document.querySelector('#probe-summary') as HTMLElement)?.innerText.replace(/\s+/g, ' ').trim()
    return { rows, summary, total: rows.length }
  })

  const val = (n: string) => {
    const r = scrape.rows.find((x) => x.name === n)
    return r ? `gl=${r.gl}` : 'MISSING'
  }
  const digest = [
    'df64 macOS Metal probe (WebGL2 gate)',
    `  glColumnDone: ${glDone}`,
    `  gpuCheck (diag): ${cap.gpu}`,
    `  glCheck: ${cap.gl}`,
    `  UA: ${cap.ua}`,
    `  summary: ${scrape.summary}`,
    `  consoleErrors: ${errs.length}`,
    '',
    `  base : ${val('dg_mb_base')}     <- must COLLAPSE for a faithful Apple oracle`,
    `  imul : ${val('dg_imul')}`,
    `  iboth: ${val('dg_iboth')}`,
    `  ieft : ${val('dg_mb_ieft')}`,
    `  mul  : ${val('mul')}   div: ${val('div')}`,
    '',
    ...scrape.rows.map((r) => `  ${r.name.padEnd(12)} gl=${(r.gl ?? '').padEnd(18)} gpu=${r.gpu ?? ''}`),
    '',
    'errors:',
    ...errs.slice(0, 12).map((e) => '  ' + e),
  ].join('\n')

  writeFileSync('_macos-probe/df64-digest.txt', digest) // cwd = playground/
  console.log('\n' + digest + '\n')
  expect(glDone).toBe(true)
})
