import { test, expect } from '@playwright/test'

// Per-variant compile/link gate (#1715 Problem A): EVERY point of a variant family must
// emit GLSL ES 3.00 that compiles AND links on a real WebGL2 driver.
//
// A module being type-checked says nothing about the combination a host selects. The
// consumer that asked for this found two failures at the pixel-test stage that this catches
// in seconds — a missing sampler precision, and a vertex/fragment interface mismatch. The
// second is why LINK matters and not just compile: each stage compiles perfectly on its own.
//
// The survey runs in the browser because vite resolves the DSL there; a bare bun run cannot.
test('every variant of a family compiles and links on WebGL2', async ({ page }) => {
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  const survey = await page.evaluate(async () => {
    const mod = await import('/e2e/_variant-link-survey.ts')
    return mod.surveyVariantLink()
  })

  // The context must be real. Without this the whole spec passes on an empty row set — the
  // exact dark-gate shape #1715 Problem A exists to remove.
  expect(survey.renderer, 'no WebGL2 context in this browser').not.toBe('NO WEBGL2')
  expect(survey.rows.length, 'the family produced no variants').toBe(survey.keys.length)
  expect(survey.keys.length).toBe(4)

  // …and the four variants must be four different PROGRAMS. A matrix whose points all emit
  // the same bytes is one program checked four times, which would pass every arm below
  // while proving a quarter of what it claims.
  expect(survey.distinctFragments, 'variants collapsed to identical sources').toBe(4)

  const failed = survey.rows.filter((r) => !r.ok)
  expect(
    failed,
    failed.map((r) => `${r.key}: ${r.failedAt ?? '?'} — ${r.log ?? ''}`).join('\n'),
  ).toEqual([])
})
