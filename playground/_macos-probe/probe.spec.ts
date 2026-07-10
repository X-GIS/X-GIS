import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'

// WebGL2-gate Apple oracle, HEADED (macOS runners have an Aqua session; headless
// GL wedged — run 6 showed the page main thread blocking inside a synchronous GL
// call, freezing even DOM-read evaluates). Diagnostics print EARLY and a raced
// progress poll snapshots the summary every 15s, so a wedge pinpoints the test
// it died in instead of a silent timeout.
test.setTimeout(240_000)
test('df64 probe on macOS Metal (WebGL2 gate)', async ({ page }) => {
  const errs: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text())
  })
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))

  // astro.config keys base='/X-GIS' off GITHUB_ACTIONS (run 7: 404 -> 0/0 rows).
  await page.goto('/X-GIS/shader-dsl/fp64-probe', { waitUntil: 'domcontentloaded' })

  // ── diagnostics FIRST, printed IMMEDIATELY (survive any later timeout) ──
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
  console.log(`[cap] gpu: ${cap.gpu}`)
  console.log(`[cap] gl:  ${cap.gl}`)
  console.log(`[cap] ua:  ${cap.ua}`)

  // ── raced progress poll: every 15s snapshot the summary + resolved-gl count.
  // If the page main thread wedges, the evaluate never resolves — the race just
  // logs 'WEDGED' and the dangling promise is abandoned (harmless). ──
  const raced = async <T>(f: () => Promise<T>, ms: number): Promise<T | 'WEDGED'> =>
    Promise.race<T | 'WEDGED'>([f(), new Promise<'WEDGED'>((r) => setTimeout(() => r('WEDGED'), ms))])
  const snapshot = () =>
    page.evaluate(() => {
      const cells = [...document.querySelectorAll('[data-gl]')]
      const done = cells.filter((c) => !c.querySelector('.animate-spin'))
      const lastDone = done.length ? done[done.length - 1].getAttribute('data-gl') : '(none)'
      const summary = (document.querySelector('#probe-summary') as HTMLElement)?.innerText.replace(/\s+/g, ' ').trim()
      return `gl ${done.length}/${cells.length} last=${lastDone} | ${summary}`
    })
  const poller = setInterval(async () => {
    console.log(`[progress] ${await raced(snapshot, 5000)}`)
  }, 15000)

  // ── the gate: WebGL2 column fully resolved ──
  let glDone = false
  try {
    await page.waitForFunction(
      () => {
        const cells = [...document.querySelectorAll('[data-gl]')]
        return cells.length > 0 && cells.every((c) => !c.querySelector('.animate-spin'))
      },
      { timeout: 150_000 },
    )
    glDone = true
  } catch {
    glDone = false
  }
  clearInterval(poller)
  console.log(`[gate] glColumnDone: ${glDone}`)

  const scrape = await raced(
    () =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-row]')].map((r) => {
          const name = r.getAttribute('data-row')!
          const gl = (r.querySelector(`[data-gl="${name}"]`) as HTMLElement)?.innerText.replace(/\s+/g, ' ').trim()
          const gpu = (r.querySelector(`[data-gpu="${name}"]`) as HTMLElement)?.innerText.replace(/\s+/g, ' ').trim()
          return { name, gl, gpu }
        })
        const summary = (document.querySelector('#probe-summary') as HTMLElement)?.innerText.replace(/\s+/g, ' ').trim()
        return { rows, summary, total: rows.length }
      }),
    20_000,
  )
  if (scrape === 'WEDGED') {
    writeFileSync('_macos-probe/df64-digest.txt', `WEDGED main thread; cap gpu=${cap.gpu} gl=${cap.gl}`)
    expect(scrape, 'page main thread wedged — see [progress] lines for the last resolved test').not.toBe('WEDGED')
    return
  }

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
