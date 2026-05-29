import { test, expect, type Page, type ConsoleMessage } from '@playwright/test'

// ═══ Vertex-shader pipeline integrity gate ═══
//
// PROVES every polygon render pipeline — including the data-driven
// "variant" pipelines (categorical / per-feature fills) — actually
// CREATES on the GPU, i.e. the declared vertex-buffer layout matches
// the WGSL entry point's attribute base types.
//
// Why this gate exists (the bug it would have caught):
//   PR 2f switched the polygon position attribute to a quantized
//   uint16x4 + uint16x2 layout read by vs_main_ecef as vec4<u32>/
//   vec2<u32>. The BASE pipeline layout (initPipelines) was updated,
//   but the two VARIANT pipeline builders still declared the old
//   float32x3 layout while binding the SAME vs_main_ecef entry.
//   Pipeline creation then failed with "Attribute base type (Float
//   for Float32x3) does not match the shader's base type (Uint) in
//   location (0)" for every data-driven fill layer — they rendered
//   nothing.
//
//   That bug passed compiler tsc, the full vitest suite, AND the
//   fuzz gate: none of them create a real GPU pipeline. The existing
//   validation specs (reftest / interactions) missed it because the
//   fixtures they load use constant fills, which take the BASE
//   pipeline path and never force a variant. This gate closes that
//   hole by loading a match()-driven fill (forces variants).
//
// Why CONSOLE capture, not the ctx._validationErrors queue:
//   A variant layout mismatch first surfaces at shader PREWARM as a
//   rejected createRenderPipelineAsync — that rejection is caught and
//   logged ("shader prewarm failed ...") but does NOT go through the
//   uncapturederror handler, so it never reaches ctx._validationErrors.
//   The subsequent lazy-compile path DOES push a "[WebGPU validation]"
//   error, but its timing races clearValidationErrors. Capturing the
//   console for the whole session catches BOTH signals deterministically.
//   (Verified: with the fix reverted this gate goes red on the prewarm
//   message; with the fix in place it stays green.)
//
// Projection sweep: setProjection is a GPU-uniform change and does
// NOT rebuild pipelines (map.ts: "GPU uniform only, no re-tessellation"),
// so a layout mismatch trips on initial load regardless. We still sweep
// all 8 so a future projection-specific pipeline (or a per-pass
// validation error in a projection's render path) is caught too.

const TIMEOUT_MS = 30_000

// match()-driven fill — forces the data-driven VARIANT polygon
// pipelines (preamble / feature buffer) rather than the base path.
const DATA_DRIVEN_FIXTURE = 'fixture_categorical'

const PROJECTIONS = [
  'mercator',
  'equirectangular',
  'natural_earth',
  'orthographic',
  'azimuthal_equidistant',
  'stereographic',
  'oblique_mercator',
  'globe',
] as const

// Console substrings that mean a GPU pipeline/shader failed to build.
const PIPELINE_FAILURE_PATTERNS = [
  'WebGPU validation',          // uncapturederror handler (gpu.ts)
  'shader prewarm failed',      // rejected createRenderPipelineAsync (renderer prewarm)
  'does not match the shader',  // attribute base-type mismatch (the PR-2f bug)
  'WebGPU device lost',         // catastrophic
] as const

function isPipelineFailure(text: string): boolean {
  return PIPELINE_FAILURE_PATTERNS.some(p => text.includes(p))
}

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: TIMEOUT_MS },
  )
}

/** Two animation frames so pipeline creation + the first render pass
 *  (lazy compile path) have run before we read the captured console. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

test('vs pipeline integrity: data-driven polygon variants create cleanly across all projections', async ({ page }) => {
  const failures: string[] = []
  page.on('console', (m: ConsoleMessage) => {
    const text = m.text()
    if (isPipelineFailure(text)) failures.push(text)
  })
  page.on('pageerror', (e) => {
    if (isPipelineFailure(e.message)) failures.push(`[pageerror] ${e.message}`)
  })

  // Console listener is installed BEFORE navigation so prewarm failures
  // (which fire during initial scene compile) are captured.
  await page.goto(`/demo.html?id=${DATA_DRIVEN_FIXTURE}`, { waitUntil: 'domcontentloaded' })
  await waitReady(page)
  await settle(page)

  // Initial load (default projection) is where the PR-2f variant-layout
  // mismatch fired — at shader prewarm.
  expect(
    dedupe(failures),
    'GPU pipeline failures on initial load of data-driven fill',
  ).toEqual([])

  // Sweep every projection; none may introduce a pipeline failure.
  for (const proj of PROJECTIONS) {
    await page.evaluate((p) => {
      (window as unknown as { __xgisMap?: { setProjection(n: string): void } }).__xgisMap!.setProjection(p)
    }, proj)
    await settle(page)
    expect(
      dedupe(failures),
      `GPU pipeline failures through setProjection('${proj}')`,
    ).toEqual([])
  }
})

/** Collapse the many identical per-pipeline messages into the distinct
 *  set so assertion diffs are readable. */
function dedupe(arr: string[]): string[] {
  return [...new Set(arr)]
}
