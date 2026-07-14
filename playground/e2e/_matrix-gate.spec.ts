// Visual-regression MATRIX gate — runner (Increment 1).
//
// Reads the declarative manifest (render-verify/matrix.manifest.ts), drives
// each cell through the EXISTING harness (captureCanvas idle-wait + the
// render-verify oracles), captures a CANDIDATE screenshot per cell, runs the
// cell's oracles, and prints a per-cell report. It:
//
//   • NEVER blesses a baseline (only `bun run matrix:accept` writes baselines).
//   • NEVER fails on a missing baseline (screenshot_diff → candidate-missing).
//   • COERCES candidate/expected_red cells to soft (effectiveGate), so an
//     unreviewed baseline or a documented open bug can only REPORT.
//   • COLLECTS hard failures and asserts ONCE in afterAll, so one bad cell
//     doesn't mask the rest of the matrix.
//
// OPT-IN ONLY. Guarded by `test.skip(!XGIS_MATRIX)` so a plain `bun test:e2e`
// (full suite) and CI (no GPU) never run it. Invoke via:
//   XGIS_MATRIX=1 bun precheck:matrix      (real GPU, headed; NO XGIS_SOFTWARE_GPU)
//   XGIS_MATRIX=1 XGIS_MATRIX_FILTER=globe-* bun precheck:matrix   (only-changed)
//
// Real GPU, LOCAL/pre-push only (ADR-0004) — CI's SwiftShader cannot raster the
// pipeline. Candidate artifacts → e2e/__matrix__/ (gitignored).

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureCanvas } from './helpers/visual'
import { MATRIX } from '../render-verify/matrix.manifest'
import { runOracle, type OracleResult } from '../render-verify/matrix-oracles'
import { effectiveGate, type Dataset, type MatrixCell } from '../render-verify/matrix-types'

const MATRIX_ON = process.env.XGIS_MATRIX === '1'

// Candidate-artifact + report dir (gitignored: e2e/__*__).
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__matrix__')

// Optional id/projection glob filter so a dev touching only globe code can run
// `XGIS_MATRIX_FILTER=globe-*`. Matches against `${id} ${projection}`.
function cellMatchesFilter(cell: MatrixCell, filter: string | undefined): boolean {
  if (!filter) return true
  const re = new RegExp('^' + filter.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'))
  return re.test(cell.id) || re.test(cell.projection)
}

const CELLS = MATRIX.filter((c) => cellMatchesFilter(c, process.env.XGIS_MATRIX_FILTER))

/** dataset → playground demo id (verified to exist in playground/src/examples). */
const DEMO_ID: Record<Dataset, string> = {
  synthetic: 'fixture_render_verify',
  ofm_bright: 'openfreemap_bright',
  synthetic_disc: 'fixture_synth_bg_only',
  osm_style: 'osm_style',
}

interface MapH {
  setSourceData(id: string, fc: unknown): void
  setProjection(n: string): void
  jumpTo(o: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): void
  markCameraPositioned(): void
  setLabelDebugHook(
    hook: ((text: string, ax: number, ay: number, kind: 'point' | 'curve') => void) | undefined,
  ): void
  invalidate?(): void
}

/** Aggregated report rows + the hard-failure list (asserted in afterAll). */
interface ReportRow {
  cellId: string
  projection: string
  gate: string
  knownStatus: string
  oracle: string
  verdict: 'PASS' | 'SOFT' | 'FAIL' | 'SKIP' | 'CANDIDATE'
  measured: number | null
  threshold: number | null
  detail: string
}
const rows: ReportRow[] = []
const hardFailures: string[] = []
// Audit ③ E — an `expected_red` cell that gets fixed (or regresses past
// threshold) flips its oracles green with NO alert today, so a documented
// open bug silently disappears (or a "baseline taken while broken" silently
// passes). Collect every expected_red cell whose oracles ALL pass this run
// and surface it in the report so a human re-checks: promote to green, or
// strengthen the oracle that's failing to catch the documented bug.
const expectedRedAllGreen: string[] = []

test.describe.configure({ mode: 'serial' }) // GPU contention — mirror Oracle-B / pixel-match.

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true })
})

for (const cell of CELLS) {
  test(`matrix: ${cell.id}`, async ({ page }) => {
    test.skip(!MATRIX_ON, 'matrix gate is opt-in — set XGIS_MATRIX=1 (real GPU, local only)')
    test.setTimeout(4 * 60_000)
    await page.setViewportSize({ width: 1024, height: 768 })

    const gate = effectiveGate(cell)

    // Synthetic datasets MUST opt into VirtualPMTilesBackend BEFORE load, or
    // host-pushed inline GeoJSON is dropped as drop-empty-slice (drawCalls=0).
    if (cell.dataset === 'synthetic') {
      await page.addInitScript(() => {
        ;(
          window as unknown as { __XGIS_USE_VIRTUAL_INLINE_GEOJSON?: boolean }
        ).__XGIS_USE_VIRTUAL_INLINE_GEOJSON = true
      })
    }
    // For label cells, install a page-side anchor accumulator BEFORE the map
    // boots so setLabelDebugHook (wired below) feeds it.
    await page.addInitScript(() => {
      ;(
        window as unknown as { __xgisMatrixLabelAnchors?: { ax: number; ay: number }[] }
      ).__xgisMatrixLabelAnchors = []
    })

    // `?e2e=1` opts out of the demo-runner's auto-push so this spec controls
    // data + camera. `?proj=` is NOT used — we call setProjection in-page.
    await page.goto(`/demo.html?id=${DEMO_ID[cell.dataset]}&e2e=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 120_000 },
    )

    // Hide the DOM chrome painted OVER the #map canvas so the capture is pure
    // rendered geometry (centralized here so cells don't each re-do it).
    await page.addStyleTag({
      content: '#status, #snapshot-btn, #hash-badge, #log-overlay { display: none !important; }',
    })

    // ── Position: load sources (synthetic), set projection + camera, wire the
    //    label hook so anchors are captured during placement. ──
    await page.evaluate(
      async ({ dataset, projection, center, zoom, pitch, bearing }) => {
        const viteImport = (u: string): Promise<any> => import(/* @vite-ignore */ u)
        const m = (window as unknown as { __xgisMap: MapH }).__xgisMap
        // Feed placed-label anchors into the page-side accumulator.
        const sink = (
          window as unknown as { __xgisMatrixLabelAnchors: { ax: number; ay: number }[] }
        ).__xgisMatrixLabelAnchors
        m.setLabelDebugHook((_t, ax, ay) => {
          sink.push({ ax, ay })
        })

        if (dataset === 'synthetic') {
          const fx = await viteImport('/render-verify/fixtures.ts')
          for (const [id, fc] of Object.entries(fx.FIXTURE_SOURCES)) m.setSourceData(id, fc)
        }
        m.setProjection(projection)
        m.jumpTo({ center, zoom, pitch, bearing })
        m.markCameraPositioned()
        m.invalidate?.()
      },
      {
        dataset: cell.dataset,
        projection: cell.projection,
        center: cell.camera.center,
        zoom: cell.zoom,
        pitch: cell.pitch,
        bearing: cell.bearing,
      },
    )

    // Drain async source work (tile fetch → MVT slice → GPU upload) then paint.
    // captureCanvas waits on hasPendingSourceWork() clearing; for label cells
    // pump a few more frames so the text stage submits anchors before capture.
    const png = await captureCanvas(page)
    // Extra settle for label/ofm cells (basemap labels resolve a few frames in).
    if (cell.surfaces.includes('label')) {
      await page.evaluate(
        () =>
          new Promise<void>((r) => {
            let n = 0
            const loop = () => {
              if (++n >= 12) r()
              else requestAnimationFrame(loop)
            }
            requestAnimationFrame(loop)
          }),
      )
    }

    // Write the candidate artifact (review scratch; gitignored).
    writeFileSync(join(OUT, `${cell.id}.png`), png)

    // ── Run each oracle; record; collect hard failures. NEVER throw here. ──
    // Track this cell's verdicts for the Audit ③ E expected_red-flip alert.
    let sawPass = false
    let sawNonPass = false
    // SKIP / CANDIDATE = the oracle did not actually judge the cell. A
    // partially-skipped run must NOT count as an all-green flip — without
    // this, an environment-dependent skip falsely reports a documented bug
    // as fixed.
    let sawInconclusive = false
    for (const o of cell.oracles) {
      const result: OracleResult = await runOracle(page, png, cell, o)
      const verdict: ReportRow['verdict'] =
        result.status === 'skipped'
          ? 'SKIP'
          : result.status === 'candidate-missing'
            ? 'CANDIDATE'
            : result.pass
              ? 'PASS'
              : gate === 'hard'
                ? 'FAIL'
                : 'SOFT'
      if (verdict === 'PASS') sawPass = true
      else if (verdict === 'SOFT' || verdict === 'FAIL') sawNonPass = true
      else sawInconclusive = true // SKIP | CANDIDATE
      rows.push({
        cellId: cell.id,
        projection: cell.projection,
        gate,
        knownStatus: cell.knownStatus,
        oracle: result.kind,
        verdict,
        measured: result.measured,
        threshold: result.threshold,
        detail: result.detail,
      })
      if (verdict === 'FAIL') {
        hardFailures.push(`${cell.id} :: ${result.kind} — ${result.detail}`)
      }

      console.log(
        `[matrix] ${cell.id} (${cell.knownStatus}/${gate}) ${result.kind}: ${verdict} — ${result.detail}`,
      )
    }
    // Audit ③ E — a documented-open-bug cell whose oracles ALL pass (at
    // least one real PASS, no SOFT/FAIL, and NOTHING skipped/candidate —
    // every oracle must have actually judged) is a silent flip: either the
    // bug is fixed (→ promote to green) or no oracle actually catches it.
    if (cell.knownStatus === 'expected_red' && sawPass && !sawNonPass && !sawInconclusive) {
      expectedRedAllGreen.push(cell.id)
    }
  })
}

test.afterAll(() => {
  if (!MATRIX_ON) return
  // Per-cell report table + JSON artifact.
  const fmtNum = (n: number | null) =>
    n === null ? '—' : Math.abs(n) >= 1 || n === 0 ? String(n) : n.toExponential(2)
  const lines: string[] = []
  lines.push('')
  lines.push('═══ MATRIX GATE REPORT ═══')
  lines.push('id | proj | status/gate | oracle | verdict | measured | threshold')
  lines.push('───────────────────────────────────────────────────────────────')
  for (const r of rows) {
    lines.push(
      `${r.cellId} | ${r.projection} | ${r.knownStatus}/${r.gate} | ${r.oracle} | ${r.verdict} | ${fmtNum(r.measured)} | ${fmtNum(r.threshold)}`,
    )
  }
  const candidates = rows.filter((r) => r.verdict === 'CANDIDATE').length
  const soft = rows.filter((r) => r.verdict === 'SOFT').length
  const skip = rows.filter((r) => r.verdict === 'SKIP').length
  lines.push('───────────────────────────────────────────────────────────────')
  lines.push(
    `PASS=${rows.filter((r) => r.verdict === 'PASS').length}  FAIL=${hardFailures.length}  SOFT=${soft}  SKIP=${skip}  CANDIDATE=${candidates}`,
  )
  if (candidates > 0) {
    lines.push(
      `→ ${candidates} cell-oracle(s) need a reviewed baseline: inspect e2e/__matrix__/<id>.png, then \`bun run matrix:accept <id>\`.`,
    )
  }
  if (expectedRedAllGreen.length > 0) {
    lines.push('───────────────────────────────────────────────────────────────')
    lines.push(
      `⚠ EXPECTED_RED FLIP — ${expectedRedAllGreen.length} documented-bug cell(s) now pass ALL oracles:`,
    )
    for (const id of expectedRedAllGreen) lines.push(`    ${id}`)
    lines.push('  → either the bug is FIXED (promote knownStatus: expected_red → green in')
    lines.push('    matrix.manifest.ts) or NO oracle catches it (strengthen the oracle).')
  }

  console.log(lines.join('\n'))
  try {
    writeFileSync(
      join(OUT, 'report.json'),
      JSON.stringify({ rows, hardFailures, expectedRedAllGreen }, null, 2),
    )
  } catch {
    /* artifact write is best-effort */
  }

  // The ONLY hard assertion: hard-gated cells with a real failure.
  expect(hardFailures, `matrix hard failures:\n${hardFailures.join('\n')}`).toEqual([])
})
