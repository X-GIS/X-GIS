// Aggregates per-demo audit results into __demo-audit__/REPORT.md.
// Wired as Playwright `globalTeardown` so it runs after every test
// completes (success or fail). Skips silently if no per-demo JSONs
// exist (audit spec wasn't run).

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
}

export default function globalTeardown(): void {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const OUT = resolve(HERE, '__demo-audit__')
  const perDemoDir = join(OUT, 'per-demo')
  if (!existsSync(perDemoDir)) return

  const files = readdirSync(perDemoDir).filter(f => f.endsWith('.json'))
  if (files.length === 0) return

  const results: DemoResult[] = files
    .map(f => JSON.parse(readFileSync(join(perDemoDir, f), 'utf8')) as DemoResult)
    .sort((a, b) => a.id.localeCompare(b.id))

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

  lines.push('## Broken')
  lines.push('')
  if (broken.length === 0) {
    lines.push('_None_')
  } else {
    lines.push('| ID | Ready | Painted | Errors | First error |')
    lines.push('|---|---:|---:|---:|---|')
    for (const r of broken) {
      const firstErr = (r.errors[0] ?? '').replace(/\|/g, '\\|').slice(0, 140)
      lines.push(
        `| \`${r.id}\` | ${r.ready ? 'Y' : '**N**'} `
        + `| ${r.paintedPx} | ${r.errors.length} | ${firstErr} |`,
      )
    }
    lines.push('')

    lines.push('### Detail')
    for (const r of broken) {
      lines.push('')
      lines.push(`#### \`${r.id}\``)
      lines.push(`- Ready: ${r.ready ? '✓' : '✗'} (${r.readyMs} ms)`)
      lines.push(`- Painted pixels: ${r.paintedPx} (centre ${r.centerPx})`)
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

  lines.push('')
  lines.push('## All demos')
  lines.push('')
  lines.push('| ID | Ready | Painted | Errors | Warns |')
  lines.push('|---|---:|---:|---:|---:|')
  for (const r of results) {
    const ok = r.ready && r.errors.length === 0 && r.paintedPx >= 200
    lines.push(
      `| ${ok ? '' : '**'}\`${r.id}\`${ok ? '' : '**'} | `
      + `${r.ready ? 'Y' : '**N**'} | ${r.paintedPx} | ${r.errors.length} | ${r.warns.length} |`,
    )
  }

  writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n'))
  writeFileSync(join(OUT, 'full.json'), JSON.stringify(results, null, 2))

  // eslint-disable-next-line no-console
  console.log(
    `[demo-audit] REPORT: ${results.length} demos, ${broken.length} broken `
    + `(${join(OUT, 'REPORT.md')})`,
  )
}
