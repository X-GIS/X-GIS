// Static-source regression gate: playground demo-runner must seed
// the pendingSpriteUrl / pendingGlyphsUrl module-scope vars BEFORE
// `await runSource()`. Iter 56 originally moved `currentMap?.set
// SpriteUrl(...)` ahead of runSource — but currentMap was null on
// first call so the setter was a no-op; the post-runSource re-apply
// hit after IconStage was already built with spriteUrl = null. Iter
// 105 corrected the approach: stash the URLs in module-scope vars
// and let the XGISMap constructor inside runSource pick them up via
// XGISMapOptions.spriteUrl / .glyphs.url.
//
// Static lint instead of e2e because the e2e path needs real GPU.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const DEMO_RUNNER_PATH = join(__dirname, '..', '..', '..', 'playground', 'src', 'demo-runner.ts')

describe('Mapbox import sprite/glyphs ordering regression gate', () => {
  it('demo-runner declares module-scope pendingSpriteUrl + pendingGlyphsUrl', () => {
    const src = readFileSync(DEMO_RUNNER_PATH, 'utf8')
    expect(src).toMatch(/let pendingSpriteUrl: string \| null = null/)
    expect(src).toMatch(/let pendingGlyphsUrl: string \| null = null/)
  })

  it('XGISMap constructor consumes pendingSpriteUrl / pendingGlyphsUrl in runSource', () => {
    const src = readFileSync(DEMO_RUNNER_PATH, 'utf8')
    // Find the runSource function body
    const runSourceIdx = src.indexOf('async function runSource(')
    expect(runSourceIdx, 'runSource function definition missing').toBeGreaterThan(0)
    // Bound the window at the NEXT top-level function, not a fixed char count: the body
    // grew past a hardcoded 5000-char slice (the `new XGISMap` call landed at ~5051),
    // silently failing this ordering gate on an unrelated demo-runner edit.
    const afterRunSource = src.slice(runSourceIdx + 1)
    const nextFn = afterRunSource.search(/\n(?:export )?(?:async )?function /)
    const runSourceWindow = src.slice(
      runSourceIdx,
      nextFn >= 0 ? runSourceIdx + 1 + nextFn : src.length,
    )
    expect(runSourceWindow).toMatch(/pendingSpriteUrl/)
    expect(runSourceWindow).toMatch(/pendingGlyphsUrl/)
    // The new XGISMap call must come AFTER the pending-var reads.
    const pendingSpriteIdx = runSourceWindow.indexOf('pendingSpriteUrl')
    const newXgisIdx = runSourceWindow.indexOf('new XGISMap(canvas')
    expect(pendingSpriteIdx).toBeGreaterThan(0)
    expect(newXgisIdx).toBeGreaterThan(0)
    expect(pendingSpriteIdx).toBeLessThan(newXgisIdx)
  })

  it('__xgisImportMapbox handler sets pendingSpriteUrl + pendingGlyphsUrl BEFORE awaiting runSource', () => {
    const src = readFileSync(DEMO_RUNNER_PATH, 'utf8')
    // Anchor on the handler ASSIGNMENT (`.__xgisImportMapbox = `),
    // not the first comment mention of the name.
    const idx = src.indexOf('__xgisImportMapbox = ')
    expect(idx, 'demo-runner should expose __xgisImportMapbox').toBeGreaterThan(0)
    const handlerWindow = src.slice(idx, idx + 5000)
    const setSpriteIdx = handlerWindow.indexOf('pendingSpriteUrl = ')
    const awaitRunSourceIdx = handlerWindow.indexOf('await runSource')
    expect(setSpriteIdx, 'pendingSpriteUrl assignment missing in import handler').toBeGreaterThan(0)
    expect(awaitRunSourceIdx, 'await runSource call missing in import handler').toBeGreaterThan(0)
    expect(setSpriteIdx).toBeLessThan(awaitRunSourceIdx)
  })

  it('__import branch reads sprite/glyphs URLs from sessionStorage / URL params', () => {
    const src = readFileSync(DEMO_RUNNER_PATH, 'utf8')
    // The __import branch (sessionStorage + hash channel) must pull
    // sprite/glyphs URLs so the convert-page hand-off flows through
    // the same constructor-seeding path as __xgisImportMapbox.
    const importBranchIdx = src.indexOf("params.get('id') === '__import'")
    expect(importBranchIdx, '__import branch missing').toBeGreaterThan(0)
    const importWindow = src.slice(importBranchIdx, importBranchIdx + 4000)
    expect(importWindow).toMatch(/__xgisImportSprite/)
    expect(importWindow).toMatch(/__xgisImportGlyphs/)
  })
})
