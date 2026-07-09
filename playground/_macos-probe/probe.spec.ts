import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'

// Diagnostic-first: the page can HANG if headless Metal WebGPU never resolves
// requestAdapter (runWebGPU awaits it with no timeout → Promise.all never
// settles → the copy button never enables). So DON'T hard-depend on completion —
// wait with a soft timeout, then ALWAYS scrape partial state + an independent,
// time-boxed WebGPU/WebGL2 capability check, and write a digest either way.
test.setTimeout(300_000)
test('df64 probe on macOS Metal', async ({ page }) => {
  const errs: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text())
  })
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))

  await page.goto('/shader-dsl/fp64-probe', { waitUntil: 'domcontentloaded' })

  let completed = false
  try {
    await page.waitForFunction(
      () => {
        const b = document.querySelector('#probe-copy')
        const s = document.querySelector('#probe-summary')
        return (!!b && !b.classList.contains('pointer-events-none')) || (s && /ERROR/.test(s.textContent || ''))
      },
      { timeout: 200_000 },
    )
    completed = true
  } catch {
    completed = false
  }

  const data = await page.evaluate(async () => {
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | string> =>
      Promise.race([p, new Promise<string>((r) => setTimeout(() => r('TIMEOUT'), ms))])
    // independent capability check (time-boxed so it can't hang the scrape)
    let gpuCheck = ''
    try {
      const g: any = (navigator as any).gpu
      if (!g) gpuCheck = 'no navigator.gpu'
      else {
        const a: any = await withTimeout(g.requestAdapter(), 8000)
        gpuCheck =
          a === 'TIMEOUT'
            ? 'requestAdapter HUNG (>8s)'
            : a
              ? 'adapter: ' + JSON.stringify(a.info || {})
              : 'requestAdapter returned null'
      }
    } catch (e) {
      gpuCheck = 'requestAdapter threw: ' + String(e)
    }
    let glCheck = ''
    try {
      const c = document.createElement('canvas')
      glCheck = c.getContext('webgl2') ? 'webgl2 OK' : 'webgl2 null'
    } catch (e) {
      glCheck = 'webgl2 threw: ' + String(e)
    }
    const rows = [...document.querySelectorAll('[data-row]')].map((r) => {
      const name = r.getAttribute('data-row')!
      const gl = (r.querySelector(`[data-gl="${name}"]`) as HTMLElement)?.innerText.replace(/\s+/g, ' ').trim()
      const gpu = (r.querySelector(`[data-gpu="${name}"]`) as HTMLElement)?.innerText.replace(/\s+/g, ' ').trim()
      return { name, gl, gpu }
    })
    // a spinner cell still shows the pending SVG (class animate-spin); count resolved
    const glResolved = rows.filter((r) => r.gl && !/^$/.test(r.gl)).length
    const spinners = document.querySelectorAll('.animate-spin').length
    const summary = (document.querySelector('#probe-summary') as HTMLElement)?.innerText.replace(/\s+/g, ' ').trim()
    return { rows, summary, gpuCheck, glCheck, glResolved, spinners, ua: navigator.userAgent, total: rows.length }
  })

  const val = (n: string) => {
    const r = data.rows.find((x) => x.name === n)
    return r ? `gl=${r.gl} gpu=${r.gpu}` : 'MISSING'
  }
  const digest = [
    'df64 macOS Metal probe',
    `  completed: ${completed}   (page reached done-state?)`,
    `  gpuCheck: ${data.gpuCheck}`,
    `  glCheck:  ${data.glCheck}`,
    `  spinners-still-pending: ${data.spinners}   rows: ${data.total}`,
    `  UA: ${data.ua}`,
    `  summary: ${data.summary}`,
    `  consoleErrors: ${errs.length}`,
    '',
    `  base  : ${val('dg_mb_base')}`,
    `  imul  : ${val('dg_imul')}`,
    `  iboth : ${val('dg_iboth')}`,
    `  ieft  : ${val('dg_mb_ieft')}`,
    `  fma_fused: ${val('dg_fma_fused')}`,
    `  mul   : ${val('mul')}    div: ${val('div')}`,
    '',
    ...data.rows.map((r) => `  ${r.name.padEnd(12)} gl=${(r.gl ?? '').padEnd(18)} gpu=${r.gpu ?? ''}`),
    '',
    'errors:',
    ...errs.slice(0, 12).map((e) => '  ' + e),
  ].join('\n')

  writeFileSync('_macos-probe/df64-digest.txt', digest) // cwd = playground/
  console.log('\n' + digest + '\n')
  expect(data.rows.length).toBeGreaterThan(0)
})
